use crate::{
    ApiError, AppState, SendRequest, context, model::TurnOptions, outbox::Receipt, permissions,
};
use anyhow::Result;
use axum::{Json, extract::State, http::StatusCode};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

async fn load_on_desktop(state: &AppState, id: &str, mode: &permissions::Mode) -> Result<()> {
    state
        .tools
        .call("navigate_to_codex_page", json!({"threadId":id}))
        .await?;
    let ipc = state.ipc().await?;
    for _ in 0..40 {
        if ipc.follow(id).await?.is_some() {
            ipc.live(id, None).await?;
            ipc.update_permissions(id, mode.settings()).await?;
            for _ in 0..20 {
                let view = ipc.live(id, None).await?;
                if permissions::current(&view["permissionSettings"]) == mode.id {
                    return Ok(());
                }
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            }
            anyhow::bail!("桌面首轮权限与所选模式不一致");
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    anyhow::bail!("桌面尚未加载对话")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    request_id: String,
    project_id: Option<String>,
    permission_mode: String,
    prompt: Option<String>,
    #[serde(flatten)]
    options: TurnOptions,
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(mut input): Json<CreateRequest>,
) -> Result<(StatusCode, Json<Receipt>), ApiError> {
    let uuid = Uuid::parse_str(&input.request_id)
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "无效的请求标识".into()))?;
    let mode = permissions::MODES
        .iter()
        .find(|mode| mode.id == input.permission_mode)
        .ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, "请选择有效的权限模式".into()))?;
    if let Some(prompt) = &input.prompt {
        crate::validate_message(prompt, &input.options)
            .map_err(|err| ApiError(StatusCode::BAD_REQUEST, err.to_string()))?;
    }
    input.options.expected_permission = Some(mode.id.to_owned());
    let options = json!({"projectId":input.project_id,"options":input.options});
    let cwd = match &input.project_id {
        Some(id) => context::project_path(&state, id).await?.into(),
        None => state.workspace_directory.join(uuid.to_string()),
    };
    let requirements = state
        .app_server
        .call("configRequirements/read", json!({}))
        .await?;
    let config = state
        .app_server
        .call("config/read", json!({"cwd":cwd,"includeLayers":false}))
        .await?;
    if let Some(reason) = mode.unavailable_reason(&requirements["requirements"], &config["config"])
    {
        return Err(ApiError(StatusCode::BAD_REQUEST, reason.into()));
    }
    if input.prompt.is_some() {
        context::validate_skills(
            &state,
            input.project_id.as_ref().and(cwd.to_str()),
            &input.options,
        )
        .await?;
    }
    let (receipt, fresh) = state
        .outbox
        .reserve(
            &input.request_id,
            if input.prompt.is_some() {
                "create"
            } else {
                "create-empty"
            },
            "",
            input.prompt.as_deref().unwrap_or_default(),
            &options,
        )
        .map_err(|err| ApiError(StatusCode::CONFLICT, err.to_string()))?;
    if fresh {
        tokio::spawn(async move {
            let result = async {
                if input.project_id.is_none() {
                    std::fs::create_dir_all(&state.workspace_directory)?;
                    std::fs::create_dir(&cwd)?;
                }
                let mut params = mode.settings();
                params["cwd"] = json!(cwd);
                params["historyMode"] = json!("paginated");
                params["threadSource"] = json!("user");
                params["ephemeral"] = json!(false);
                params["model"] = json!(input.options.model);
                if let Some(effort) = &input.options.thinking {
                    params["config"] = json!({"model_reasoning_effort":effort});
                }
                let title = input
                    .prompt
                    .as_deref()
                    .unwrap_or_default()
                    .trim()
                    .lines()
                    .next()
                    .unwrap_or("新对话")
                    .chars()
                    .take(60)
                    .collect::<String>();
                let id = state.app_server.start_empty(params, &title).await?;
                let mut result = json!({"threadId":id,"cwd":cwd});
                if let Err(err) = load_on_desktop(&state, &id, mode).await {
                    result["permissionConfirmed"] = json!(false);
                    result["warning"] = json!(format!(
                        "对话已创建，首轮权限未确认。消息保留在草稿中。{err}"
                    ));
                    return Ok(result);
                }
                if let Some(project) = input.project_id
                    && state
                        .tools
                        .call(
                            "move_thread_to_project",
                            json!({"threadId":id,"hostId":"local","projectId":project}),
                        )
                        .await
                        .is_err()
                {
                    result["warning"] = json!("对话已在所选目录创建，桌面项目归属未确认。");
                }
                if let Some(prompt) = input.prompt {
                    let message = SendRequest {
                        request_id: Uuid::new_v4().to_string(),
                        prompt,
                        options: input.options,
                    };
                    match crate::submit_message(state.clone(), id, message) {
                        Ok(receipt) => result["firstMessageRequestId"] = json!(receipt.request_id),
                        Err(err) => {
                            result["warning"] =
                                json!(format!("对话已创建，首条消息未提交。{}", err.1))
                        }
                    }
                }
                Ok(result)
            }
            .await;
            if state.outbox.finish(&input.request_id, result).is_err() {
                eprintln!("无法保存新对话的创建结果");
            }
        });
    }
    Ok((StatusCode::ACCEPTED, Json(receipt)))
}
