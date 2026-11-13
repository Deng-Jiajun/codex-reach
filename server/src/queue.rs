use anyhow::{Context, Result, ensure};
use axum::{
    Json,
    extract::{Path, State},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::Path as FilePath,
    sync::{Arc, Mutex},
    time::Duration,
};

use crate::{ApiError, AppState, model::TurnOptions};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub request_id: String,
    pub chat_id: String,
    pub prompt: String,
    pub options: TurnOptions,
    pub status: String,
    pub error: Option<String>,
    pub version: i64,
}

pub struct Queue(Mutex<Connection>);

impl Queue {
    pub fn open(path: &FilePath) -> Result<Self> {
        let db = Connection::open(path)?;
        db.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS queue (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE NOT NULL,
                chat_id TEXT NOT NULL, prompt TEXT NOT NULL, options TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued', error TEXT, version INTEGER NOT NULL DEFAULT 0
            );
            UPDATE queue SET status='unknown',error='服务在取得投递结果前退出，请查询原操作结果' WHERE status='sending';")?;
        Ok(Self(Mutex::new(db)))
    }

    fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Item> {
        let options: String = row.get(3)?;
        Ok(Item {
            request_id: row.get(0)?,
            chat_id: row.get(1)?,
            prompt: row.get(2)?,
            options: serde_json::from_str(&options).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?,
            status: row.get(4)?,
            error: row.get(5)?,
            version: row.get(6)?,
        })
    }

    pub fn list(&self, chat: Option<&str>) -> Result<Vec<Item>> {
        let db = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("队列数据库锁不可用"))?;
        let mut statement = db.prepare("SELECT request_id,chat_id,prompt,options,status,error,version FROM queue WHERE (?1 IS NULL OR chat_id=?1) ORDER BY sequence")?;
        Ok(statement
            .query_map([chat], Self::row)?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn add(&self, chat: &str, input: &crate::SendRequest) -> Result<()> {
        let db = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("队列数据库锁不可用"))?;
        let options = serde_json::to_string(&input.options)?;
        let existing = db
            .query_row(
                "SELECT chat_id,prompt,options FROM queue WHERE request_id=?1",
                [&input.request_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        if let Some(existing) = existing {
            ensure!(
                existing == (chat.to_owned(), input.prompt.clone(), options),
                "同一队列操作标识对应了不同内容"
            );
            return Ok(());
        }
        db.execute(
            "INSERT INTO queue(request_id,chat_id,prompt,options) VALUES(?1,?2,?3,?4)",
            params![input.request_id, chat, input.prompt, options],
        )?;
        Ok(())
    }

    pub fn claim(&self, item: &Item) -> Result<bool> {
        let db = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("队列数据库锁不可用"))?;
        Ok(db.execute("UPDATE queue SET status='sending',error=NULL WHERE request_id=?1 AND status='queued' AND version=?2", params![item.request_id,item.version])? == 1)
    }

    pub fn can_dispatch(&self, id: &str) -> Result<bool> {
        let db = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("队列数据库锁不可用"))?;
        Ok(db.query_row(
            "SELECT EXISTS(SELECT 1 FROM queue WHERE request_id=?1 AND status='sending')",
            [id],
            |row| row.get(0),
        )?)
    }

    pub fn cancel_deleted(&self, ids: &[String]) -> Result<()> {
        let mut db = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("队列数据库锁不可用"))?;
        let transaction = db.transaction()?;
        for id in ids {
            transaction.execute("UPDATE queue SET status='cancelled',error='对话已删除',version=version+1 WHERE chat_id=?1 AND status NOT IN ('accepted','cancelled')", [id])?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn finish(&self, id: &str, status: &str, error: Option<&str>) -> Result<()> {
        let db = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("队列数据库锁不可用"))?;
        db.execute("UPDATE queue SET status=?2,error=?3,version=version+1 WHERE request_id=?1 AND status IN ('sending','unknown')", params![id,status,error])?;
        Ok(())
    }

    pub fn edit(&self, chat: &str, id: &str, input: &Change) -> Result<()> {
        let db = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("队列数据库锁不可用"))?;
        let changed = match input.action.as_str() {
            "cancel" => db.execute("UPDATE queue SET status='cancelled',version=version+1 WHERE chat_id=?1 AND request_id=?2 AND status IN ('queued','failed') AND version=?3", params![chat,id,input.version])?,
            "edit" => {
                let prompt = input.prompt.as_ref().context("编辑队列缺少正文")?;
                let options = input.options.as_ref().context("编辑队列缺少完整参数")?;
                crate::validate_message(prompt, options)?;
                db.execute("UPDATE queue SET prompt=?4,options=?5,status='queued',error=NULL,version=version+1 WHERE chat_id=?1 AND request_id=?2 AND status IN ('queued','failed') AND version=?3", params![chat,id,input.version,prompt,serde_json::to_string(options)?])?
            }
            "confirmAccepted" => db.execute("UPDATE queue SET status='accepted',error=NULL,version=version+1 WHERE chat_id=?1 AND request_id=?2 AND status='unknown' AND version=?3", params![chat,id,input.version])?,
            _ => anyhow::bail!("队列操作无效"),
        };
        ensure!(changed == 1, "队列项已变化或已开始投递，请刷新后重试");
        Ok(())
    }
}

#[derive(Deserialize)]
pub struct Change {
    action: String,
    version: i64,
    prompt: Option<String>,
    options: Option<TurnOptions>,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({"items":state.queue.list(Some(&id))?})))
}

pub async fn add(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<crate::SendRequest>,
) -> Result<Json<Value>, ApiError> {
    uuid::Uuid::parse_str(&input.request_id).context("队列操作标识无效")?;
    crate::validate_message(&input.prompt, &input.options)?;
    state.queue.add(&id, &input)?;
    Ok(Json(json!({"requestId":input.request_id,"queued":true})))
}

pub async fn change(
    State(state): State<Arc<AppState>>,
    Path((chat, id)): Path<(String, String)>,
    Json(input): Json<Change>,
) -> Result<Json<Value>, ApiError> {
    if input.action == "check" {
        let item = state
            .queue
            .list(Some(&chat))?
            .into_iter()
            .find(|item| item.request_id == id)
            .context("队列项已不存在")?;
        if item.status == "unknown" {
            let page = state
                .app_server
                .call(
                    "thread/items/list",
                    json!({"threadId":chat,"limit":100,"sortDirection":"desc"}),
                )
                .await?;
            if page["data"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|entry| &entry["item"])
                .any(|message| message["type"] == "userMessage" && message["clientId"] == id)
            {
                state.queue.finish(&id, "accepted", None)?;
            }
        }
    } else {
        state.queue.edit(&chat, &id, &input)?;
    }
    Ok(Json(json!({"items":state.queue.list(Some(&chat))?})))
}

pub async fn run(state: Arc<AppState>) {
    loop {
        if let Ok(items) = state.queue.list(None) {
            let mut visited = HashSet::new();
            for item in items
                .into_iter()
                .filter(|item| !matches!(item.status.as_str(), "accepted" | "cancelled"))
            {
                if !visited.insert(item.chat_id.clone()) || item.status != "queued" {
                    continue;
                }
                let ready = async {
                    let client = state.ipc().await?;
                    let view = client.live(&item.chat_id, None).await?;
                    if view["available"] != true {
                        state
                            .tools
                            .call("navigate_to_codex_page", json!({"threadId":item.chat_id}))
                            .await?;
                        return Ok::<bool, anyhow::Error>(false);
                    }
                    Ok(view["status"] == "idle" && view["waiting"] != true)
                }
                .await;
                if !matches!(ready, Ok(true)) {
                    continue;
                }
                if state.queue.claim(&item).ok() != Some(true) {
                    continue;
                }
                let result = state
                    .dispatch(
                        &item.chat_id,
                        &item.prompt,
                        &item.request_id,
                        &item.options,
                        true,
                    )
                    .await;
                let (status, error) = match result {
                    Ok(_) => ("accepted", None),
                    Err(error) if error.is::<crate::desktop::TurnActive>() => ("queued", None),
                    Err(error) if error.is::<crate::NotDispatched>() => {
                        ("failed", Some(error.to_string()))
                    }
                    Err(error) => ("unknown", Some(format!("投递结果待确认。{error}"))),
                };
                if state
                    .queue
                    .finish(&item.request_id, status, error.as_deref())
                    .is_err()
                {
                    eprintln!("无法保存队列投递结果");
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queue_retries_edits_and_claims_keep_one_delivery() {
        let queue = Queue::open(FilePath::new(":memory:")).unwrap();
        let input = crate::SendRequest {
            request_id: "id".into(),
            prompt: "hello".into(),
            options: TurnOptions::default(),
        };
        queue.add("chat", &input).unwrap();
        queue.add("chat", &input).unwrap();
        let stale = queue.list(Some("chat")).unwrap().remove(0);
        queue
            .edit(
                "chat",
                "id",
                &Change {
                    action: "edit".into(),
                    version: 0,
                    prompt: Some("edited".into()),
                    options: Some(TurnOptions::default()),
                },
            )
            .unwrap();
        assert!(!queue.claim(&stale).unwrap());
        let current = queue.list(Some("chat")).unwrap().remove(0);
        assert!(queue.claim(&current).unwrap());
        assert!(!queue.claim(&current).unwrap());
        assert!(
            queue
                .edit(
                    "chat",
                    "id",
                    &Change {
                        action: "cancel".into(),
                        version: 1,
                        prompt: None,
                        options: None
                    }
                )
                .is_err()
        );
        queue.finish("id", "accepted", None).unwrap();
        assert_eq!(queue.list(None).unwrap().len(), 1);
    }

    #[test]
    fn restart_preserves_pending_and_marks_interrupted_send_unknown() {
        let path = std::env::temp_dir().join(format!("reach-queue-{}.db", uuid::Uuid::new_v4()));
        {
            let queue = Queue::open(&path).unwrap();
            for id in ["pending", "sending"] {
                queue
                    .add(
                        "chat",
                        &crate::SendRequest {
                            request_id: id.into(),
                            prompt: id.into(),
                            options: TurnOptions::default(),
                        },
                    )
                    .unwrap();
            }
            queue.claim(&queue.list(None).unwrap()[1]).unwrap();
        }
        let queue = Queue::open(&path).unwrap();
        let items = queue.list(None).unwrap();
        assert_eq!(items[0].status, "queued");
        assert_eq!(items[1].status, "unknown");
        assert!(!queue.claim(&items[1]).unwrap());
        drop(queue);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn deletion_prevents_a_claimed_message_from_dispatching_after_the_send_lock() {
        let queue = Queue::open(FilePath::new(":memory:")).unwrap();
        queue
            .add(
                "chat",
                &crate::SendRequest {
                    request_id: "id".into(),
                    prompt: "message".into(),
                    options: TurnOptions::default(),
                },
            )
            .unwrap();
        let item = queue.list(None).unwrap().remove(0);
        assert!(queue.claim(&item).unwrap());
        assert!(queue.can_dispatch("id").unwrap());
        queue.cancel_deleted(&["chat".into()]).unwrap();
        assert!(!queue.can_dispatch("id").unwrap());
        queue.finish("id", "accepted", None).unwrap();
        assert_eq!(queue.list(None).unwrap()[0].status, "cancelled");
    }
}
