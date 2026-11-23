use crate::{AppState, NotDispatched, desktop, model::TurnOptions, permissions};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use uuid::Uuid;
use windows_sys::Win32::UI::Shell::ShellExecuteW;

pub fn wake(id: &str) -> Result<()> {
    let uri = format!("codex://threads/wake/{}", Uuid::parse_str(id)?);
    let url: Vec<u16> = uri.encode_utf16().chain(Some(0)).collect();
    // Invoke the registered URI handler with a validated thread ID.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            std::ptr::null(),
            url.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    ensure!(
        result as isize > 32,
        "Windows 未能唤醒 Codex 桌面（{}）",
        result as isize
    );
    Ok(())
}

impl AppState {
    pub async fn native_send(
        &self,
        chat: &str,
        id: &str,
        prompt: &str,
        options: &TurnOptions,
    ) -> Result<Value> {
        Uuid::parse_str(chat).context("对话标识无效")?;
        let metadata = self
            .app_server
            .call("thread/read", json!({"threadId":chat}))
            .await?;
        let thread = &metadata["thread"];
        let recorded = if options.expected_permission.is_some()
            || options.model.is_some()
            || options.thinking.is_some()
        {
            permissions::applied(thread).await?
        } else {
            Value::Null
        };
        if let Some(expected) = &options.expected_permission {
            if recorded["mode"] != expected.as_str() {
                return Err(NotDispatched(
                    "首轮权限与最近已应用记录不一致，请核对发送参数后再发送".into(),
                )
                .into());
            }
        }
        if options
            .model
            .as_deref()
            .is_some_and(|m| recorded["model"].as_str().or(thread["model"].as_str()) != Some(m))
            || options.thinking.as_deref().is_some_and(|e| {
                recorded["thinking"]
                    .as_str()
                    .or(thread["reasoningEffort"].as_str())
                    != Some(e)
            })
        {
            return Err(NotDispatched(
                "桌面队列沿用对话的模型和思考深度，请在发送参数中选择沿用会话设置".into(),
            )
            .into());
        }
        let message =
            desktop::prepare_message(prompt, id, &options.attachments, &json!(options.skills));
        let before = self
            .app_server
            .call(
                "thread/items/list",
                json!({"threadId":chat,"limit":1,"sortDirection":"desc"}),
            )
            .await?;
        let mut result = json!({"desktopQueued":true,"afterItem":before["data"][0]["item"]["id"]});
        self.outbox.record_native(id, &result)?;
        let ack = self
            .app_server
            .call(
                "thread/queue/add",
                json!({
                    "threadId":chat, "clientUserMessageId":id, "input":message["input"]
                }),
            )
            .await?;
        ensure!(
            ack["queuedSubmission"]["clientUserMessageId"] == id,
            "桌面队列回执标识不匹配"
        );
        if let Err(error) = wake(chat) {
            result["warning"] = json!(error.to_string());
        }
        Ok(result)
    }

    pub async fn is_native_queued(&self, chat: &str, id: &str) -> Result<bool> {
        let mut cursor = Value::Null;
        loop {
            let page = self
                .app_server
                .call(
                    "thread/queue/list",
                    json!({"threadId":chat,"cursor":cursor,"limit":25}),
                )
                .await?;
            if page["data"]
                .as_array()
                .context("队列缺少数据")?
                .iter()
                .any(|row| row["clientUserMessageId"] == id)
            {
                return Ok(true);
            }
            let next = &page["nextCursor"];
            if next.is_null() {
                return Ok(false);
            }
            ensure!(next != &cursor, "队列分页游标没有前进");
            cursor = next.clone();
        }
    }

    pub async fn delivered(&self, chat: &str, id: &str, after_item: Option<&str>) -> Result<bool> {
        let mut cursor = Value::Null;
        loop {
            let page = self
                .app_server
                .call(
                    "thread/items/list",
                    json!({
                        "threadId":chat,"limit":50,"sortDirection":"desc","cursor":cursor
                    }),
                )
                .await?;
            for entry in page["data"].as_array().context("消息分页缺少数据")? {
                let item = &entry["item"];
                if item["type"] == "userMessage" && item["clientId"] == id {
                    return Ok(true);
                }
                if after_item.is_some() && item["id"].as_str() == after_item {
                    return Ok(false);
                }
            }
            let next = &page["nextCursor"];
            if next.is_null() {
                return Ok(false);
            }
            ensure!(next != &cursor, "消息分页游标没有前进");
            cursor = next.clone();
        }
    }
}
