use anyhow::{Context, Result, ensure};
use axum::{
    Json,
    extract::{Query, State},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{io::Write, sync::Arc};

use crate::{ApiError, AppState, files, model};

pub async fn catalog(state: &AppState, cwd: Option<&str>) -> Result<Value> {
    let result = state
        .app_server
        .call(
            "skills/list",
            json!({
                "cwds":cwd.into_iter().collect::<Vec<_>>(),"forceReload":false
            }),
        )
        .await?;
    let entries = result["data"].as_array().context("Skill 列表格式无效")?;
    let skills = entries
        .iter()
        .flat_map(|entry| entry["skills"].as_array().into_iter().flatten())
        .filter(|skill| skill["enabled"] == true && (cwd.is_some() || skill["scope"] != "repo"))
        .cloned()
        .collect::<Vec<_>>();
    let errors = entries
        .iter()
        .flat_map(|entry| entry["errors"].as_array().into_iter().flatten())
        .cloned()
        .collect::<Vec<_>>();
    Ok(json!({"skills":skills,"errors":errors}))
}

pub async fn validate_skills(
    state: &AppState,
    cwd: Option<&str>,
    options: &model::TurnOptions,
) -> Result<()> {
    if options.skills.is_empty() {
        return Ok(());
    }
    let catalog = catalog(state, cwd).await?;
    for selected in &options.skills {
        ensure!(
            catalog["skills"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|skill| skill["name"] == selected.name && skill["path"] == selected.path),
            "所选 Skill 在当前项目已不可用，请重新选择"
        );
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextQuery {
    chat_id: Option<String>,
    project_id: Option<String>,
    #[serde(default)]
    query: String,
    kind: String,
}

pub async fn choices(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ContextQuery>,
) -> Result<Json<Value>, ApiError> {
    let cwd = if let Some(id) = &query.chat_id {
        let result = state
            .app_server
            .call("thread/read", json!({"threadId":id,"includeTurns":false}))
            .await?;
        Some(
            result["thread"]["cwd"]
                .as_str()
                .context("对话缺少工作目录")?
                .to_owned(),
        )
    } else if let Some(id) = &query.project_id {
        Some(project_path(&state, id).await?)
    } else {
        None
    };
    match query.kind.as_str() {
        "skills" => Ok(Json(catalog(&state, cwd.as_deref()).await?)),
        "files" => {
            let Some(cwd) = cwd else {
                return Ok(Json(json!({"files":[],"needsProject":true})));
            };
            Ok(Json(
                state
                    .app_server
                    .call(
                        "fuzzyFileSearch",
                        json!({
                            "query":query.query,"roots":[cwd],"cancellationToken":null
                        }),
                    )
                    .await?,
            ))
        }
        _ => Err(ApiError(
            axum::http::StatusCode::BAD_REQUEST,
            "引用类型无效".to_owned(),
        )),
    }
}

pub async fn project_path(state: &AppState, id: &str) -> Result<String> {
    let result = state.tools.call("list_projects", json!({})).await?;
    result["projects"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|project| {
            project["projectId"] == id
                && project["projectKind"] == "local"
                && project["hostId"] == "local"
        })
        .and_then(|project| project["path"].as_str())
        .map(str::to_owned)
        .context("所选本机项目已不可用，请刷新项目列表")
}

pub async fn resolve(
    state: &AppState,
    request_id: &str,
    options: &model::TurnOptions,
) -> Result<model::TurnOptions> {
    let mut resolved = options.clone();
    resolved.attachments = files::resolve(
        &options
            .attachments
            .iter()
            .map(|file| file.path.clone())
            .collect::<Vec<_>>(),
    )?;
    for reference in &options.thread_refs {
        let id = uuid::Uuid::parse_str(&reference.id).context("引用对话标识无效")?;
        let directory = state.context_directory.join(request_id);
        std::fs::create_dir_all(&directory)?;
        let path = directory.join(format!("{id}.jsonl"));
        if !path.exists() {
            let metadata = state
                .app_server
                .call(
                    "thread/read",
                    json!({"threadId":reference.id,"includeTurns":false}),
                )
                .await?;
            let temporary = directory.join(format!("{id}.tmp"));
            let mut file = std::fs::File::create(&temporary)?;
            serde_json::to_writer(
                &mut file,
                &json!({"threadId":reference.id,"title":metadata["thread"]["name"],
                "cwd":metadata["thread"]["cwd"],"scope":"User and assistant messages available when this request was prepared"}),
            )?;
            writeln!(file)?;
            let mut cursor = Value::Null;
            loop {
                let page = state.app_server.call("thread/items/list", json!({
                    "threadId":reference.id,"cursor":cursor,"limit":100,"sortDirection":"asc"
                })).await?;
                for entry in page["data"].as_array().into_iter().flatten() {
                    if let Some(message) = model::message(&entry["item"])
                        && matches!(message.kind.as_str(), "user" | "assistant")
                    {
                        serde_json::to_writer(
                            &mut file,
                            &json!({"turnId":entry["turnId"],"message":message}),
                        )?;
                        writeln!(file)?;
                    }
                }
                cursor = page["nextCursor"].clone();
                if cursor.is_null() {
                    break;
                }
            }
            file.sync_all()?;
            drop(file);
            std::fs::rename(temporary, &path)?;
        }
        resolved.attachments.push(files::FileAttachment {
            name: format!("对话 {} ({id})", reference.title),
            path: path.to_string_lossy().into_owned(),
            directory: false,
            image: false,
        });
    }
    Ok(resolved)
}

pub fn first_prompt(prompt: &str, request_id: &str, options: &model::TurnOptions) -> String {
    let prepared =
        crate::desktop::prepare_message(prompt, request_id, &options.attachments, &json!([]));
    let mut text = prepared["input"][0]["text"]
        .as_str()
        .unwrap_or(prompt)
        .to_owned();
    if !options.skills.is_empty() {
        text.push_str("\n\nUse the following selected Skills for this request. Read their SKILL.md instructions.\n");
        for skill in &options.skills {
            text.push_str(&format!("- ${}: {}\n", skill.name, skill.path));
        }
    }
    text
}
