mod app_server;
mod context;
mod desktop;
mod events;
mod files;
mod model;
mod organization;
mod outbox;
mod queue;
mod reader;
mod uploads;

use anyhow::{Context, Result, bail, ensure};
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use desktop::{AppTools, Ipc};
use outbox::{Outbox, Receipt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, atomic::Ordering},
};
use tokio::sync::Mutex;
use tower_http::{cors::CorsLayer, services::ServeDir};
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    server_id: String,
    api_key: String,
    caller_thread_id: String,
    listen: Vec<SocketAddr>,
    app_tools_pipe: Option<String>,
}

struct AppState {
    config: Config,
    tools: AppTools,
    app_server: app_server::AppServerClient,
    ipc: Mutex<Option<Arc<Ipc>>>,
    outbox: Outbox,
    queue: queue::Queue,
    events: events::Events,
    send_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    upload_directory: PathBuf,
    context_directory: PathBuf,
    uploads: Arc<uploads::Uploads>,
    reader: Arc<reader::Reader>,
}

impl AppState {
    async fn skill_catalog(&self, chat_id: &str) -> Result<Value> {
        let metadata = self
            .app_server
            .call(
                "thread/read",
                json!({"threadId":chat_id,"includeTurns":false}),
            )
            .await?;
        let cwd = metadata["thread"]["cwd"]
            .as_str()
            .context("会话缺少工作目录")?;
        context::catalog(self, Some(cwd)).await
    }

    async fn ipc(&self) -> Result<Arc<Ipc>> {
        let mut connection = self.ipc.lock().await;
        if let Some(client) = connection
            .as_ref()
            .filter(|client| client.connected.load(Ordering::SeqCst))
        {
            return Ok(Arc::clone(client));
        }
        let client = Ipc::connect().await?;
        *connection = Some(Arc::clone(&client));
        Ok(client)
    }

    async fn dispatch(
        &self,
        chat_id: &str,
        prompt: &str,
        request_id: &str,
        options: &model::TurnOptions,
        next_turn_only: bool,
    ) -> Result<Value> {
        let gate = self
            .send_locks
            .lock()
            .await
            .entry(chat_id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _guard = gate.lock().await;
        if next_turn_only && !self.queue.can_dispatch(request_id)? {
            return Err(NotDispatched("队列项已取消".to_owned()).into());
        }
        if !options.skills.is_empty() {
            let catalog = self
                .skill_catalog(chat_id)
                .await
                .map_err(|error| NotDispatched(error.to_string()))?;
            for selected in &options.skills {
                if !catalog["skills"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|skill| skill["name"] == selected.name && skill["path"] == selected.path)
                {
                    return Err(
                        NotDispatched("所选 Skill 已不可用，请刷新 Skill 列表".to_owned()).into(),
                    );
                }
            }
        }
        let options = context::resolve(self, request_id, options)
            .await
            .map_err(|error| NotDispatched(error.to_string()))?;
        if let Ok(client) = self.ipc().await {
            for attempt in 0..2 {
                if client.follow(chat_id).await?.is_none() {
                    self.tools
                        .call("navigate_to_codex_page", json!({"threadId":chat_id}))
                        .await?;
                    for _ in 0..20 {
                        if client.follow(chat_id).await?.is_some() {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    }
                }
                if let Some(owner) = client.follow(chat_id).await? {
                    client.live(chat_id, None).await?;
                    let result = client
                        .send(
                            chat_id,
                            &owner,
                            prompt,
                            request_id,
                            &serde_json::to_value(&options)?,
                            next_turn_only,
                        )
                        .await;
                    if result
                        .as_ref()
                        .is_err_and(|error| error.to_string() == "no-client-found")
                        && attempt == 0
                    {
                        continue;
                    }
                    result?;
                    return Ok(Value::Null);
                }
                break;
            }
        }
        ensure!(
            !next_turn_only && options.skills.is_empty() && options.attachments.is_empty(),
            "桌面尚未载入此对话，请稍后查询投递结果"
        );
        let mut arguments = json!({"threadId":chat_id,"hostId":"local","prompt":prompt});
        if let Some(model) = options.model {
            arguments["model"] = json!(model);
        }
        if let Some(thinking) = options.thinking {
            arguments["thinking"] = json!(thinking);
        }
        self.tools.call("send_message_to_thread", arguments).await?;
        Ok(Value::Null)
    }
}

struct ApiError(StatusCode, String);

#[derive(Debug)]
struct NotDispatched(String);
impl std::fmt::Display for NotDispatched {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for NotDispatched {}

fn validate_message(prompt: &str, options: &model::TurnOptions) -> Result<()> {
    ensure!(
        !prompt.trim().is_empty()
            || !options.attachments.is_empty()
            || !options.skills.is_empty()
            || !options.thread_refs.is_empty(),
        "请填写消息或选择引用"
    );
    Ok(())
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self(StatusCode::BAD_GATEWAY, error.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}

async fn authorize(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    let authorized = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| value == state.config.api_key);
    if !authorized {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"访问密钥无效"})),
        )
            .into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn status(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    state
        .tools
        .call(
            "list_threads",
            json!({"mode":"history","source":"codex","hostId":"local","limit":1}),
        )
        .await?;
    let configuration = state
        .app_server
        .call("config/read", json!({"includeLayers":false}))
        .await?;
    Ok(Json(
        json!({"serverId":state.config.server_id,"version":env!("CARGO_PKG_VERSION"),"desktopConnected":true,"desktopLocale":configuration["config"]["desktop"]["localeOverride"]}),
    ))
}

async fn projects(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let result = state.tools.call("list_projects", json!({})).await?;
    let projects = result["projects"].as_array().into_iter().flatten()
        .filter(|project| project["projectKind"] == "local" && project["hostId"] == "local")
        .map(|project| json!({"id":project["projectId"],"name":project["label"],"path":project["path"]})).collect::<Vec<_>>();
    Ok(Json(json!({"projects":projects})))
}

async fn models(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let mut models = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let page = state
            .app_server
            .call(
                "model/list",
                json!({
                    "limit":100,"includeHidden":false,"cursor":cursor
                }),
            )
            .await?;
        models.extend(page["data"].as_array().into_iter().flatten().cloned());
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    Ok(Json(json!({"models":models})))
}

async fn thread_settings(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if let Ok(client) = state.ipc().await
        && let Some(settings) = client.read_settings(&id).await?
    {
        return Ok(Json(
            json!({"model":settings["model"],"thinking":settings["reasoningEffort"]}),
        ));
    }
    let metadata = state
        .app_server
        .call("thread/read", json!({"threadId":id,"includeTurns":false}))
        .await?;
    Ok(Json(
        json!({"model":metadata["thread"]["model"],"thinking":metadata["thread"]["reasoningEffort"]}),
    ))
}

async fn skills(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let mut catalog = state.skill_catalog(&id).await?;
    let supported = match state.ipc().await {
        Ok(client) => client.follow(&id).await?.is_some(),
        Err(_) => false,
    };
    catalog["sendingSupported"] = json!(supported);
    Ok(Json(catalog))
}

async fn approval_settings(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let view = state.ipc().await?.live(&id, None).await?;
    let requirements = state
        .app_server
        .call("configRequirements/read", json!({}))
        .await?;
    Ok(Json(
        json!({"available":view["available"] == true && !view["approvalPolicy"].is_null(),
        "approvalPolicy":view["approvalPolicy"],"allowed":requirements["requirements"]["allowedApprovalPolicies"]}),
    ))
}

#[derive(Deserialize)]
struct ApprovalPolicyRequest {
    policy: String,
}

async fn set_approval(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<ApprovalPolicyRequest>,
) -> Result<Json<Value>, ApiError> {
    if !matches!(input.policy.as_str(), "untrusted" | "on-request" | "never") {
        return Err(ApiError(StatusCode::BAD_REQUEST, "审批策略无效".to_owned()));
    }
    let requirements = state
        .app_server
        .call("configRequirements/read", json!({}))
        .await?;
    if let Some(allowed) = requirements["requirements"]["allowedApprovalPolicies"].as_array() {
        if !allowed.iter().any(|value| value == &input.policy) {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "当前配置不允许选择该审批策略".to_owned(),
            ));
        }
    }
    Ok(Json(
        state
            .ipc()
            .await?
            .update_approval(&id, &input.policy)
            .await?,
    ))
}

async fn open_thread(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    state
        .tools
        .call("navigate_to_codex_page", json!({"threadId":id}))
        .await?;
    Ok(Json(json!({"opened":true})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRequest {
    request_id: String,
    prompt: String,
    project_id: Option<String>,
    #[serde(flatten)]
    options: model::TurnOptions,
}

async fn create_thread(
    State(state): State<Arc<AppState>>,
    Json(input): Json<CreateRequest>,
) -> Result<(StatusCode, Json<Receipt>), ApiError> {
    if (input.prompt.trim().is_empty()
        && input.options.attachments.is_empty()
        && input.options.thread_refs.is_empty()
        && input.options.skills.is_empty())
        || Uuid::parse_str(&input.request_id).is_err()
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "首条消息和有效的请求标识为必填项".to_owned(),
        ));
    }
    let mut options = serde_json::to_value(&input.options).map_err(anyhow::Error::from)?;
    options["projectId"] = json!(input.project_id);
    let (receipt, fresh) = state
        .outbox
        .reserve(&input.request_id, "create", "", &input.prompt, &options)
        .map_err(|error| ApiError(StatusCode::CONFLICT, error.to_string()))?;
    if fresh {
        tokio::spawn(async move {
            let result = async {
                let cwd = match &input.project_id {
                    Some(id) => Some(context::project_path(&state, id).await?),
                    None => None,
                };
                context::validate_skills(&state, cwd.as_deref(), &input.options).await?;
                let resolved = context::resolve(&state, &input.request_id, &input.options).await?;
                let target = if let Some(project_id) = input.project_id {
                    json!({"type":"project","projectId":project_id,"environment":{"type":"local"}})
                } else {
                    json!({"type":"projectless"})
                };
                let mut arguments = json!({});
                if let Some(model) = &input.options.model {
                    arguments["model"] = json!(model);
                }
                if let Some(thinking) = &input.options.thinking {
                    arguments["thinking"] = json!(thinking);
                }
                arguments["prompt"] = json!(context::first_prompt(
                    &input.prompt,
                    &input.request_id,
                    &resolved
                ));
                arguments["target"] = target;
                let result = state.tools.call("create_thread", arguments).await?;
                ensure!(
                    result["threadId"].as_str().is_some_and(|id| !id.is_empty()),
                    "桌面尚未返回新会话标识，请先核对会话列表"
                );
                Ok(result)
            }
            .await;
            if state.outbox.finish(&input.request_id, result).is_err() {
                eprintln!("无法保存新建会话的结果，请检查本地操作数据库");
            }
        });
    }
    Ok((StatusCode::ACCEPTED, Json(receipt)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopRequest {
    request_id: String,
    expected_turn_id: String,
}

async fn stop_thread(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<StopRequest>,
) -> Result<(StatusCode, Json<Receipt>), ApiError> {
    if Uuid::parse_str(&input.request_id).is_err() || input.expected_turn_id.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "停止请求需要有效标识和当前轮次".to_owned(),
        ));
    }
    let options = json!({"expectedTurnId":input.expected_turn_id});
    let (receipt, fresh) = state
        .outbox
        .reserve(&input.request_id, "stop", &id, "", &options)
        .map_err(|error| ApiError(StatusCode::CONFLICT, error.to_string()))?;
    if fresh {
        tokio::spawn(async move {
            let result = async {
                state
                    .ipc()
                    .await?
                    .interrupt(&id, &input.expected_turn_id)
                    .await
            }
            .await;
            if state.outbox.finish(&input.request_id, result).is_err() {
                eprintln!("无法保存停止请求的结果，请检查本地操作数据库");
            }
        });
    }
    Ok((StatusCode::ACCEPTED, Json(receipt)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RespondRequest {
    request_id: String,
    approval_request_id: Value,
    response: Value,
}

async fn respond(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<RespondRequest>,
) -> Result<(StatusCode, Json<Receipt>), ApiError> {
    if Uuid::parse_str(&input.request_id).is_err()
        || !(input.approval_request_id.is_string() || input.approval_request_id.as_i64().is_some())
        || !input.response.is_object()
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "回复请求需要有效操作标识、原始请求 ID 和响应内容".to_owned(),
        ));
    }
    let options = json!({"approvalRequestId":input.approval_request_id,"response":input.response});
    let (receipt, fresh) = state
        .outbox
        .reserve(&input.request_id, "respond", &id, "", &options)
        .map_err(|error| ApiError(StatusCode::CONFLICT, error.to_string()))?;
    if fresh {
        tokio::spawn(async move {
            let result = async {
                state
                    .ipc()
                    .await?
                    .respond(&id, &input.approval_request_id, &input.response)
                    .await
            }
            .await;
            if state.outbox.finish(&input.request_id, result).is_err() {
                eprintln!("无法保存确认回复的结果，请检查本地操作数据库");
            }
        });
    }
    Ok((StatusCode::ACCEPTED, Json(receipt)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditRequest {
    request_id: String,
    turn_id: String,
    prompt: String,
}

async fn edit(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<EditRequest>,
) -> Result<(StatusCode, Json<Receipt>), ApiError> {
    if Uuid::parse_str(&input.request_id).is_err()
        || input.turn_id.is_empty()
        || input.prompt.trim().is_empty()
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "编辑请求需要有效操作标识、轮次和消息正文".to_owned(),
        ));
    }
    let options = json!({"turnId":input.turn_id});
    let (receipt, fresh) = state
        .outbox
        .reserve(&input.request_id, "edit", &id, &input.prompt, &options)
        .map_err(|error| ApiError(StatusCode::CONFLICT, error.to_string()))?;
    if fresh {
        tokio::spawn(async move {
            let result = async {
                let gate = state
                    .send_locks
                    .lock()
                    .await
                    .entry(id.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(())))
                    .clone();
                let _guard = gate.lock().await;
                state
                    .ipc()
                    .await?
                    .edit(&id, &input.turn_id, &input.prompt)
                    .await
            }
            .await;
            if state.outbox.finish(&input.request_id, result).is_err() {
                eprintln!("无法保存编辑操作的结果，请检查本地操作数据库");
            }
        });
    }
    Ok((StatusCode::ACCEPTED, Json(receipt)))
}

#[derive(Deserialize)]
struct PageQuery {
    cursor: Option<String>,
    #[serde(default)]
    archived: bool,
}

#[derive(Deserialize)]
struct TitleRequest {
    title: String,
}

async fn rename_thread(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<TitleRequest>,
) -> Result<Json<Value>, ApiError> {
    if input.title.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "对话名称不能为空".to_owned(),
        ));
    }
    Ok(Json(
        state
            .tools
            .call(
                "set_thread_title",
                json!({"source":"codex","threadId":id,"title":input.title.trim()}),
            )
            .await?,
    ))
}

#[derive(Deserialize)]
struct ArchiveRequest {
    archived: bool,
}

async fn archive_thread(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<ArchiveRequest>,
) -> Result<Json<Value>, ApiError> {
    let result = state
        .tools
        .call(
            "set_thread_archived",
            json!({"source":"codex","hostId":"local","threadId":id,"archived":input.archived}),
        )
        .await?;
    if let Ok(client) = state.ipc().await {
        client.forget(&id).await;
    }
    Ok(Json(result))
}

#[derive(Deserialize)]
struct ReadRequest {
    read: bool,
}

async fn mark_thread_read(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<ReadRequest>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        state
            .tools
            .call(
                "set_thread_read_state",
                json!({"source":"codex","hostId":"local","threadId":id,"read":input.read}),
            )
            .await?,
    ))
}

async fn pinned_threads(state: &AppState) -> Result<Vec<Value>> {
    let result = state
        .tools
        .call("list_threads", json!({"mode":"recent","limit":1}))
        .await?;
    Ok(result["pinnedThreads"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|thread| thread["kind"] == "codex" && thread["hostId"] == "local")
        .cloned()
        .collect())
}

async fn pin_state(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        json!({"pinned":pinned_threads(&state).await?.iter().any(|thread| thread["id"] == id)}),
    ))
}

#[derive(Deserialize)]
struct PinRequest {
    pinned: bool,
}

async fn pin_thread(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<PinRequest>,
) -> Result<Json<Value>, ApiError> {
    let result = state.tools.call("move_thread_to_sidebar_section", json!({
        "threadId":id,"source":"codex","hostId":"local","sectionId":if input.pinned { Some("pinned") } else { None }
    })).await?;
    Ok(Json(json!({"pinned":result["sectionId"] == "pinned"})))
}

#[derive(Deserialize)]
struct FileQuery {
    path: Option<String>,
}

async fn browse_files(
    Query(query): Query<FileQuery>,
) -> Result<Json<files::DirectoryListing>, ApiError> {
    let result = tokio::task::spawn_blocking(move || files::browse(query.path.as_deref()))
        .await
        .map_err(anyhow::Error::from)??;
    Ok(Json(result))
}

#[derive(Deserialize)]
struct FilePaths {
    paths: Vec<String>,
}

async fn resolve_files(Json(input): Json<FilePaths>) -> Result<Json<Value>, ApiError> {
    let attachments = tokio::task::spawn_blocking(move || files::resolve(&input.paths))
        .await
        .map_err(anyhow::Error::from)??;
    Ok(Json(json!({"attachments":attachments})))
}

#[derive(Deserialize)]
struct UploadRequest {
    name: String,
    data: String,
}

async fn start_upload(
    State(state): State<Arc<AppState>>,
    Json(input): Json<uploads::Start>,
) -> Result<Json<uploads::Receipt>, ApiError> {
    let uploads = Arc::clone(&state.uploads);
    Ok(Json(
        tokio::task::spawn_blocking(move || uploads.start(input))
            .await
            .map_err(anyhow::Error::from)??,
    ))
}

async fn open_document(
    State(state): State<Arc<AppState>>,
    Json(input): Json<reader::Open>,
) -> Result<Json<reader::Document>, ApiError> {
    let reader = Arc::clone(&state.reader);
    Ok(Json(
        tokio::task::spawn_blocking(move || reader.open(input))
            .await
            .map_err(anyhow::Error::from)??,
    ))
}

async fn read_document(
    State(state): State<Arc<AppState>>,
    Path((id, resource)): Path<(String, String)>,
    request: Request,
) -> Result<Response, ApiError> {
    let reader = Arc::clone(&state.reader);
    let path = tokio::task::spawn_blocking(move || reader.resolve(&id, &resource))
        .await
        .map_err(anyhow::Error::from)??;
    Ok(reader::serve(path, request).await?)
}

async fn upload_status(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<uploads::Receipt>, ApiError> {
    let uploads = Arc::clone(&state.uploads);
    Ok(Json(
        tokio::task::spawn_blocking(move || uploads.status(&id))
            .await
            .map_err(anyhow::Error::from)??,
    ))
}

async fn upload_chunk(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<uploads::Chunk>,
) -> Result<Json<uploads::Receipt>, ApiError> {
    let uploads = Arc::clone(&state.uploads);
    Ok(Json(
        tokio::task::spawn_blocking(move || uploads.write(&id, input))
            .await
            .map_err(anyhow::Error::from)??,
    ))
}

async fn finish_upload(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<uploads::Receipt>, ApiError> {
    let uploads = Arc::clone(&state.uploads);
    Ok(Json(
        tokio::task::spawn_blocking(move || uploads.finish(&id))
            .await
            .map_err(anyhow::Error::from)??,
    ))
}

async fn upload_file(
    State(state): State<Arc<AppState>>,
    Json(input): Json<UploadRequest>,
) -> Result<Json<files::FileAttachment>, ApiError> {
    let directory = state.upload_directory.clone();
    let attachment = tokio::task::spawn_blocking(move || -> Result<_> {
        ensure!(
            input.data.len() <= 28_000_000,
            "单个上传文件不能超过 20 MiB"
        );
        let bytes = STANDARD.decode(input.data).context("文件编码无效")?;
        ensure!(
            bytes.len() <= 20 * 1024 * 1024,
            "单个上传文件不能超过 20 MiB"
        );
        files::upload(&directory, &input.name, &bytes)
    })
    .await
    .map_err(anyhow::Error::from)??;
    Ok(Json(attachment))
}

#[derive(Deserialize)]
struct PreviewRequest {
    path: String,
}

async fn preview_file(Json(input): Json<PreviewRequest>) -> Result<Json<Value>, ApiError> {
    let preview = tokio::task::spawn_blocking(move || files::preview(&input.path))
        .await
        .map_err(anyhow::Error::from)??;
    Ok(Json(
        json!({"mime":preview.mime,"data":STANDARD.encode(preview.bytes)}),
    ))
}

async fn threads(
    State(state): State<Arc<AppState>>,
    Query(query): Query<PageQuery>,
) -> Result<Json<Value>, ApiError> {
    let mut arguments = json!({"mode":"history","source":"codex","hostId":"local","limit":50,"archived":query.archived});
    if let Some(cursor) = &query.cursor {
        arguments["cursor"] = json!(cursor);
    }
    let result = state.tools.call("list_threads", arguments).await?;
    let recent = if query.cursor.is_none() && !query.archived {
        state
            .tools
            .call("list_threads", json!({"mode":"recent","limit":50}))
            .await?
    } else {
        json!({})
    };
    let pinned = recent["pinnedThreads"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let pinned_ids = pinned
        .iter()
        .filter_map(|thread| thread["id"].as_str())
        .collect::<Vec<_>>();
    let threads = pinned.iter().chain(result["threads"].as_array().into_iter().flatten()
        .filter(|thread| !pinned_ids.contains(&thread["id"].as_str().unwrap_or_default())))
        .filter(|thread| thread["kind"] == "codex" && thread["hostId"] == "local")
        .map(|thread| {
            let current = recent["threads"].as_array().into_iter().flatten().chain(pinned.iter()).find(|item| item["id"] == thread["id"]);
            json!({"id":thread["id"],"title":model::text(thread, "title"),"projectId":thread["projectId"],
                "cwd":thread["cwd"],"status":model::status(&current.unwrap_or(thread)["status"]),"updatedAt":model::timestamp_seconds(&thread["updatedAt"]),
                "isUnread":current.and_then(|item| item["isUnread"].as_bool()).or_else(|| thread["isUnread"].as_bool()),
                "pinned":pinned_ids.contains(&thread["id"].as_str().unwrap_or_default())})
        }).collect::<Vec<_>>();
    Ok(Json(
        json!({"threads":threads,"nextCursor":result["nextCursor"]}),
    ))
}

async fn history(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<PageQuery>,
) -> Result<Json<Value>, ApiError> {
    state
        .app_server
        .history(&id, query.cursor)
        .await
        .map(Json)
        .map_err(|error| ApiError(StatusCode::UNPROCESSABLE_ENTITY, error.to_string()))
}

#[derive(Deserialize)]
struct LiveQuery {
    after: Option<String>,
}

async fn live(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<LiveQuery>,
) -> Result<Json<Value>, ApiError> {
    let result = state.ipc().await?.live(&id, query.after.as_deref()).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendRequest {
    request_id: String,
    prompt: String,
    #[serde(flatten)]
    options: model::TurnOptions,
}

async fn send(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<SendRequest>,
) -> Result<(StatusCode, Json<Receipt>), ApiError> {
    if (input.prompt.trim().is_empty()
        && input.options.attachments.is_empty()
        && input.options.skills.is_empty()
        && input.options.thread_refs.is_empty())
        || Uuid::parse_str(&input.request_id).is_err()
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "请填写消息或选择附件，并提供有效的发送标识".to_owned(),
        ));
    }
    let (receipt, fresh) = state
        .outbox
        .reserve(
            &input.request_id,
            "send",
            &id,
            &input.prompt,
            &serde_json::to_value(&input.options).map_err(anyhow::Error::from)?,
        )
        .map_err(|error| ApiError(StatusCode::CONFLICT, error.to_string()))?;
    if fresh {
        tokio::spawn(async move {
            let result = state
                .dispatch(&id, &input.prompt, &input.request_id, &input.options, false)
                .await;
            if state.outbox.finish(&input.request_id, result).is_err() {
                eprintln!("无法保存投递结果，请检查本地发送数据库");
            }
        });
    }
    Ok((StatusCode::ACCEPTED, Json(receipt)))
}

async fn receipt(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Receipt>, ApiError> {
    state
        .outbox
        .get(&id)?
        .map(Json)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "未找到发送记录".to_owned()))
}

async fn setup(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let local_host = state.config.listen.iter().any(|address| {
        host == format!("127.0.0.1:{}", address.port())
            || host == format!("localhost:{}", address.port())
    });
    if !peer.ip().is_loopback() || !local_host {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "连接配置页面仅在本机开放".to_owned(),
        ));
    }
    let address = state
        .config
        .listen
        .iter()
        .find(|address| !address.ip().is_loopback())
        .unwrap_or(&state.config.listen[0]);
    let page = include_str!("setup.html")
        .replace("{{address}}", &address.to_string())
        .replace("{{apiKey}}", &state.config.api_key);
    Ok(([(header::CACHE_CONTROL, "no-store")], Html(page)))
}

#[tokio::main]
async fn main() -> Result<()> {
    let directory = std::env::var_os("CODEX_REACH_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("LOCALAPPDATA").expect("LOCALAPPDATA is required"))
                .join("CodexReach")
        });
    let config_path = directory.join("server.json");
    let mut web_directory = std::env::current_exe()?
        .parent()
        .context("缺少程序目录")?
        .join("web");
    let mut listen = Vec::new();
    let mut initialize = None;
    for argument in std::env::args().skip(1) {
        if let Some(value) = argument.strip_prefix("--init=") {
            initialize = Some(value.to_owned());
        } else if let Some(value) = argument.strip_prefix("--web-dir=") {
            web_directory = PathBuf::from(value);
        } else if let Some(value) = argument.strip_prefix("--listen=") {
            listen.push(value.parse::<SocketAddr>()?);
        } else {
            bail!("未知参数 {argument}");
        }
    }
    if let Some(caller) = initialize {
        Uuid::parse_str(&caller).context("来源聊天 ID 无效")?;
        ensure!(!config_path.exists(), "配置已存在，请在原配置文件中修改");
        std::fs::create_dir_all(&directory)?;
        let config = Config {
            server_id: Uuid::new_v4().to_string(),
            api_key: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
            caller_thread_id: caller,
            listen: vec!["127.0.0.1:4317".parse()?],
            app_tools_pipe: None,
        };
        std::fs::write(&config_path, serde_json::to_vec_pretty(&config)?)?;
        println!("配置已创建 {}", config_path.display());
        return Ok(());
    }
    let mut config: Config = serde_json::from_slice(
        &std::fs::read(&config_path).context("请先使用 --init=来源聊天ID 创建连接配置")?,
    )?;
    if !listen.is_empty() {
        config.listen = listen;
    }
    ensure!(!config.listen.is_empty(), "至少需要一个监听地址");
    ensure!(!config.api_key.is_empty(), "访问密钥不能为空");
    let listeners = {
        let mut listeners = Vec::new();
        for address in &config.listen {
            listeners.push(tokio::net::TcpListener::bind(address).await?);
        }
        listeners
    };
    let state = Arc::new(AppState {
        tools: AppTools {
            caller_thread_id: config.caller_thread_id.clone(),
            pipe_path: config.app_tools_pipe.clone(),
        },
        ipc: Mutex::new(None),
        app_server: app_server::AppServerClient::default(),
        outbox: Outbox::open(&directory.join("outbox.db"))?,
        queue: queue::Queue::open(&directory.join("queue.db"))?,
        events: events::Events::open(&directory.join("events.db"))?,
        send_locks: Mutex::new(HashMap::new()),
        upload_directory: std::path::absolute(directory.join("uploads"))?,
        context_directory: std::path::absolute(directory.join("contexts"))?,
        uploads: Arc::new(uploads::Uploads::open(&std::path::absolute(
            directory.join("uploads"),
        )?)?),
        reader: Arc::new(reader::Reader::default()),
        config,
    });
    let queue_worker = tokio::spawn(queue::run(Arc::clone(&state)));
    let event_worker = tokio::spawn(events::run(Arc::clone(&state)));
    let cors = CorsLayer::new()
        .allow_origin(
            [
                "http://localhost",
                "https://localhost",
                "http://127.0.0.1:5173",
            ]
            .map(|origin| origin.parse::<HeaderValue>().unwrap()),
        )
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);
    let api = Router::new()
        .route("/status", get(status))
        .route("/projects", get(projects))
        .route("/models", get(models))
        .route("/events", get(events::list))
        .route("/context", get(context::choices))
        .route("/files", get(browse_files))
        .route("/files/resolve", post(resolve_files))
        .route("/files/preview", post(preview_file))
        .route("/files/read", post(open_document))
        .route("/uploads", post(start_upload))
        .route("/uploads/{id}", get(upload_status))
        .route("/uploads/{id}/chunk", post(upload_chunk))
        .route("/uploads/{id}/finish", post(finish_upload))
        .route(
            "/files/upload",
            post(upload_file).layer(DefaultBodyLimit::max(28_010_000)),
        )
        .route("/threads", get(threads).post(create_thread))
        .route("/threads/{id}/history", get(history))
        .route("/threads/{id}/settings", get(thread_settings))
        .route(
            "/threads/{id}/approval",
            get(approval_settings).post(set_approval),
        )
        .route("/threads/{id}/skills", get(skills))
        .route("/threads/{id}/open", post(open_thread))
        .route("/threads/{id}/pin", get(pin_state).post(pin_thread))
        .route("/threads/{id}/title", post(rename_thread))
        .route("/threads/{id}/archive", post(archive_thread))
        .route("/threads/{id}/read", post(mark_thread_read))
        .route("/threads/{id}/state", get(organization::summary))
        .route("/threads/{id}/changes", get(organization::changes))
        .route(
            "/threads/{id}/delete-preview",
            get(organization::deletion_preview),
        )
        .route("/threads/{id}/delete", post(organization::delete))
        .route("/threads/{id}/stop", post(stop_thread))
        .route("/threads/{id}/respond", post(respond))
        .route("/threads/{id}/edit", post(edit))
        .route("/threads/{id}/live", get(live))
        .route("/threads/{id}/messages", post(send))
        .route("/threads/{id}/queue", get(queue::list).post(queue::add))
        .route("/threads/{id}/queue/{request_id}", post(queue::change))
        .route("/requests/{id}", get(receipt))
        .route_layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            authorize,
        ))
        .layer(cors);
    let router = Router::new()
        .nest("/api", api)
        .route(
            "/reader/{id}/{*resource}",
            get(read_document).layer(
                tower_http::compression::CompressionLayer::new()
                    .gzip(true)
                    .compress_when(
                        |_: StatusCode,
                         _: axum::http::Version,
                         _: &HeaderMap,
                         extensions: &axum::http::Extensions| {
                            extensions
                                .get::<reader::Compressible>()
                                .is_some_and(|value| value.0)
                        },
                    ),
            ),
        )
        .route("/setup", get(setup))
        .fallback_service(ServeDir::new(web_directory))
        .with_state(state);
    let mut servers = tokio::task::JoinSet::new();
    for listener in listeners {
        println!("Codex Reach listening on http://{}", listener.local_addr()?);
        let service = router
            .clone()
            .into_make_service_with_connect_info::<SocketAddr>();
        servers.spawn(async move { axum::serve(listener, service).await });
    }
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        result = servers.join_next() => { result.context("HTTP 服务已退出")??.context("HTTP 服务异常")?; }
    }
    queue_worker.abort();
    event_worker.abort();
    Ok(())
}
