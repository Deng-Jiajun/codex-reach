mod app_server;
mod desktop;
mod files;
mod model;
mod outbox;

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
    send_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    upload_directory: PathBuf,
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
        let result = self
            .app_server
            .call("skills/list", json!({"cwds":[cwd],"forceReload":false}))
            .await?;
        let entries = result["data"].as_array().context("Skill 列表格式无效")?;
        let skills = entries
            .iter()
            .flat_map(|entry| entry["skills"].as_array().into_iter().flatten())
            .filter(|skill| skill["enabled"] == true)
            .cloned()
            .collect::<Vec<_>>();
        let errors = entries
            .iter()
            .flat_map(|entry| entry["errors"].as_array().into_iter().flatten())
            .cloned()
            .collect::<Vec<_>>();
        Ok(json!({"skills":skills,"errors":errors}))
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
    ) -> Result<Value> {
        let gate = self
            .send_locks
            .lock()
            .await
            .entry(chat_id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _guard = gate.lock().await;
        if !options.skills.is_empty() {
            let catalog = self.skill_catalog(chat_id).await?;
            for selected in &options.skills {
                ensure!(
                    catalog["skills"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|skill| skill["name"] == selected.name
                            && skill["path"] == selected.path),
                    "所选 Skill 已不可用，请刷新 Skill 列表"
                );
            }
        }
        if let Ok(client) = self.ipc().await
            && let Ok(view) = client.live(chat_id, None).await
            && view["available"] == true
            && let Some(owner) = client.follow(chat_id).await?
        {
            client
                .send(
                    chat_id,
                    &owner,
                    prompt,
                    request_id,
                    &serde_json::to_value(options)?,
                )
                .await?;
            return Ok(Value::Null);
        }
        ensure!(
            options.skills.is_empty() && options.attachments.is_empty(),
            "会话尚未载入桌面，所选 Skill 或附件未投递。请先在电脑端打开此对话后再发送"
        );
        let mut arguments = serde_json::to_value(options)?;
        arguments["threadId"] = json!(chat_id);
        arguments["hostId"] = json!("local");
        arguments["prompt"] = json!(prompt);
        self.tools.call("send_message_to_thread", arguments).await?;
        Ok(Value::Null)
    }
}

struct ApiError(StatusCode, String);

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
    Ok(Json(
        json!({"serverId":state.config.server_id,"version":env!("CARGO_PKG_VERSION"),"desktopConnected":true}),
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
    if input.prompt.trim().is_empty() || Uuid::parse_str(&input.request_id).is_err() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "首条消息和有效的请求标识为必填项".to_owned(),
        ));
    }
    if !input.options.skills.is_empty() || !input.options.attachments.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "请先创建对话，再为后续消息选择 Skill 和附件".to_owned(),
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
                let target = if let Some(project_id) = input.project_id {
                    let projects = state.tools.call("list_projects", json!({})).await?;
                    ensure!(
                        projects["projects"].as_array().into_iter().flatten().any(
                            |project| project["projectId"] == project_id
                                && project["projectKind"] == "local"
                                && project["hostId"] == "local"
                        ),
                        "所选本机项目已不可用，请刷新项目列表"
                    );
                    json!({"type":"project","projectId":project_id,"environment":{"type":"local"}})
                } else {
                    json!({"type":"projectless"})
                };
                let mut arguments = serde_json::to_value(&input.options)?;
                arguments["prompt"] = json!(input.prompt);
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
    let mut arguments =
        json!({"mode":"history","source":"codex","hostId":"local","limit":50,"archived":false});
    if let Some(cursor) = &query.cursor {
        arguments["cursor"] = json!(cursor);
    }
    let result = state.tools.call("list_threads", arguments).await?;
    let pinned = if query.cursor.is_none() {
        pinned_threads(&state).await?
    } else {
        Vec::new()
    };
    let pinned_ids = pinned
        .iter()
        .filter_map(|thread| thread["id"].as_str())
        .collect::<Vec<_>>();
    let threads = pinned.iter().chain(result["threads"].as_array().into_iter().flatten()
        .filter(|thread| !pinned_ids.contains(&thread["id"].as_str().unwrap_or_default())))
        .filter(|thread| thread["kind"] == "codex" && thread["hostId"] == "local")
        .map(|thread| json!({"id":thread["id"],"title":model::text(thread, "title"),"projectId":thread["projectId"],
            "cwd":thread["cwd"],"status":model::status(&thread["status"]),"updatedAt":model::timestamp_seconds(&thread["updatedAt"]),
            "pinned":pinned_ids.contains(&thread["id"].as_str().unwrap_or_default())})).collect::<Vec<_>>();
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
    if (input.prompt.trim().is_empty() && input.options.attachments.is_empty())
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
                .dispatch(&id, &input.prompt, &input.request_id, &input.options)
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
        send_locks: Mutex::new(HashMap::new()),
        upload_directory: std::path::absolute(directory.join("uploads"))?,
        config,
    });
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
        .route("/files", get(browse_files))
        .route("/files/resolve", post(resolve_files))
        .route("/files/preview", post(preview_file))
        .route(
            "/files/upload",
            post(upload_file).layer(DefaultBodyLimit::max(28_010_000)),
        )
        .route("/threads", get(threads).post(create_thread))
        .route("/threads/{id}/history", get(history))
        .route("/threads/{id}/settings", get(thread_settings))
        .route("/threads/{id}/skills", get(skills))
        .route("/threads/{id}/open", post(open_thread))
        .route("/threads/{id}/pin", get(pin_state).post(pin_thread))
        .route("/threads/{id}/stop", post(stop_thread))
        .route("/threads/{id}/respond", post(respond))
        .route("/threads/{id}/edit", post(edit))
        .route("/threads/{id}/live", get(live))
        .route("/threads/{id}/messages", post(send))
        .route("/requests/{id}", get(receipt))
        .route_layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            authorize,
        ))
        .layer(cors);
    let router = Router::new()
        .nest("/api", api)
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
    Ok(())
}
