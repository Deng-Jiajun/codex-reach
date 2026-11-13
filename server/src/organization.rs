use crate::{ApiError, AppState, PageQuery, outbox::Receipt};
use anyhow::{Context, Result};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
};

async fn impact(state: &AppState, id: &str) -> Result<Value> {
    let root = state
        .app_server
        .call("thread/read", json!({"threadId":id,"includeTurns":false}))
        .await?;
    let mut threads = BTreeMap::new();
    threads.insert(
        id.to_owned(),
        json!({"id":id,"title":root["thread"]["name"],"cwd":root["thread"]["cwd"]}),
    );
    let mut pending = vec![id.to_owned()];
    let sources = json!([
        "cli",
        "vscode",
        "exec",
        "appServer",
        "subAgent",
        "subAgentReview",
        "subAgentCompact",
        "subAgentThreadSpawn",
        "subAgentOther",
        "unknown"
    ]);
    while let Some(parent) = pending.pop() {
        for relation in ["parentThreadId", "attachedToThreadId"] {
            for archived in [false, true] {
                let mut cursor = Value::Null;
                loop {
                    let mut params = json!({"archived":archived,"sourceKinds":sources,"limit":100,"cursor":cursor,"useStateDbOnly":true});
                    params[relation] = json!(parent);
                    let page = state.app_server.call("thread/list", params).await?;
                    for child in page["data"].as_array().into_iter().flatten() {
                        let child_id = child["id"].as_str().context("附属对话缺少标识")?;
                        if !threads.contains_key(child_id) {
                            threads.insert(
                                child_id.to_owned(),
                                json!({"id":child_id,"title":child["name"],"cwd":child["cwd"]}),
                            );
                            pending.push(child_id.to_owned());
                        }
                    }
                    cursor = page["nextCursor"].clone();
                    if cursor.is_null() {
                        break;
                    }
                }
            }
        }
    }
    let threads = threads.into_values().collect::<Vec<_>>();
    let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&threads)?));
    Ok(json!({"threads":threads,"fingerprint":fingerprint}))
}

pub async fn deletion_preview(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(impact(&state, &id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRequest {
    request_id: String,
    fingerprint: String,
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<DeleteRequest>,
) -> Result<(StatusCode, Json<Receipt>), ApiError> {
    uuid::Uuid::parse_str(&input.request_id).context("删除操作标识无效")?;
    let options = json!({"fingerprint":input.fingerprint});
    if state.outbox.get(&input.request_id)?.is_some() {
        let (receipt, _) = state
            .outbox
            .reserve(&input.request_id, "delete", &id, "", &options)?;
        return Ok((StatusCode::ACCEPTED, Json(receipt)));
    }
    let current = impact(&state, &id).await?;
    if current["fingerprint"] != input.fingerprint {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "删除影响范围已变化，请重新查看并确认".into(),
        ));
    }
    let (receipt, fresh) = state
        .outbox
        .reserve(&input.request_id, "delete", &id, "", &options)?;
    if fresh {
        tokio::spawn(async move {
            let result = state
                .tools
                .call(
                    "delete_thread",
                    json!({"source":"codex","hostId":"local","threadId":id}),
                )
                .await;
            if state.outbox.finish(&input.request_id, result).is_err() {
                eprintln!("无法保存删除结果");
            }
        });
    }
    Ok((StatusCode::ACCEPTED, Json(receipt)))
}

pub async fn changes(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<PageQuery>,
) -> Result<Json<Value>, ApiError> {
    let page = state
        .app_server
        .call(
            "thread/items/list",
            json!({"threadId":id,"cursor":query.cursor,"limit":100,"sortDirection":"desc"}),
        )
        .await?;
    let changes = page["data"].as_array().into_iter().flatten()
        .filter(|entry| entry["item"]["type"] == "fileChange")
        .map(|entry| json!({"turnId":entry["turnId"],"itemId":entry["item"]["id"],"status":entry["item"]["status"],"changes":entry["item"]["changes"]})).collect::<Vec<_>>();
    Ok(Json(
        json!({"changes":changes,"nextCursor":page["nextCursor"],"readCount":page["data"].as_array().map_or(0, Vec::len),"scope":"threadFileChanges"}),
    ))
}

pub async fn summary(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let view = state.ipc().await?.live(&id, None).await?;
    let mut targets = Vec::new();
    let mut seen = HashSet::new();
    for id in view["waitingTargets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !seen.insert(id) {
            continue;
        }
        let metadata = state
            .app_server
            .call("thread/read", json!({"threadId":id,"includeTurns":false}))
            .await?;
        targets.push(json!({"id":id,"title":metadata["thread"]["name"]}));
    }
    Ok(Json(
        json!({"available":view["available"],"status":view["status"],"waitingForUser":view["waitingForUser"],
        "waitingForThread":!targets.is_empty(),"waitingTargets":targets}),
    ))
}
