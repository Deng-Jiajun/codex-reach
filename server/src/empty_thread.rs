use crate::{ApiError, AppState, context, outbox::Receipt, permissions};
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmptyRequest {
    request_id: String,
    project_id: Option<String>,
    permission_mode: String,
    model: Option<String>,
    thinking: Option<String>,
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(input): Json<EmptyRequest>,
) -> Result<(StatusCode, Json<Receipt>), ApiError> {
    let uuid = Uuid::parse_str(&input.request_id)
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "无效的请求标识".into()))?;
    let mode = permissions::MODES
        .iter()
        .find(|mode| mode.id == input.permission_mode)
        .ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, "请选择有效的权限模式".into()))?;
    let options = json!({"projectId":input.project_id,"permissionMode":mode.id,"model":input.model,"thinking":input.thinking});
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
    let (receipt, fresh) = state
        .outbox
        .reserve(&input.request_id, "create-empty", "", "", &options)
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
                params["model"] = json!(input.model);
                if let Some(effort) = input.thinking {
                    params["config"] = json!({"model_reasoning_effort":effort});
                }
                let id = state.app_server.start_empty(params).await?;
                load_on_desktop(&state, &id, mode)
                    .await
                    .map_err(|err| anyhow::anyhow!("已创建对话 {id}，首轮权限未确认。{err}"))?;
                let mut warning = None;
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
                    warning = Some("对话已在所选目录创建，桌面项目归属未确认。");
                }
                Ok(json!({"threadId":id,"cwd":cwd,"warning":warning}))
            }
            .await;
            if state.outbox.finish(&input.request_id, result).is_err() {
                eprintln!("无法保存空对话的创建结果");
            }
        });
    }
    Ok((StatusCode::ACCEPTED, Json(receipt)))
}
