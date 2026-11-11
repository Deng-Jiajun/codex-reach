mod desktop;
mod model;
mod outbox;

use anyhow::{Context, Result, bail, ensure};
use axum::{
    Json, Router,
    extract::{ConnectInfo, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
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
    ipc: Mutex<Option<Arc<Ipc>>>,
    outbox: Outbox,
    send_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl AppState {
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

    async fn dispatch(&self, chat_id: &str, prompt: &str, request_id: &str) -> Result<()> {
        let gate = self
            .send_locks
            .lock()
            .await
            .entry(chat_id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _guard = gate.lock().await;
        if let Ok(client) = self.ipc().await
            && let Ok(view) = client.live(chat_id, None).await
            && view["available"] == true
            && let Some(owner) = client.follow(chat_id).await?
        {
            return client.send(chat_id, &owner, prompt, request_id).await;
        }
        self.tools
            .call(
                "send_message_to_thread",
                json!({"threadId":chat_id,"hostId":"local","prompt":prompt}),
            )
            .await?;
        Ok(())
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

#[derive(Deserialize)]
struct PageQuery {
    cursor: Option<String>,
}

async fn threads(
    State(state): State<Arc<AppState>>,
    Query(query): Query<PageQuery>,
) -> Result<Json<Value>, ApiError> {
    let mut arguments =
        json!({"mode":"history","source":"codex","hostId":"local","limit":50,"archived":false});
    if let Some(cursor) = query.cursor {
        arguments["cursor"] = json!(cursor);
    }
    let result = state.tools.call("list_threads", arguments).await?;
    let threads = result["threads"].as_array().into_iter().flatten()
        .filter(|thread| thread["kind"] == "codex" && thread["hostId"] == "local")
        .map(|thread| json!({"id":thread["id"],"title":thread["title"],"projectId":thread["projectId"],
            "cwd":thread["cwd"],"status":model::status(&thread["status"]),"updatedAt":thread["updatedAt"]})).collect::<Vec<_>>();
    Ok(Json(
        json!({"threads":threads,"nextCursor":result["nextCursor"]}),
    ))
}

async fn history(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<PageQuery>,
) -> Result<Json<Value>, ApiError> {
    let mut arguments = json!({"threadId":id,"hostId":"local","turnLimit":10,"includeOutputs":true,"maxOutputCharsPerItem":20000});
    if let Some(cursor) = query.cursor {
        arguments["cursor"] = json!(cursor);
    }
    let result = state.tools.call("read_thread", arguments).await?;
    let turns = result["turns"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .map(model::turn)
        .collect::<Vec<_>>();
    Ok(Json(
        json!({"id":id,"title":result["thread"]["title"],"cwd":result["thread"]["cwd"],
        "status":model::status(&result["thread"]["status"]),"turns":turns,
        "nextCursor":result["page"]["nextCursor"],"hasMore":result["page"]["hasMore"]}),
    ))
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
}

async fn send(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<SendRequest>,
) -> Result<(StatusCode, Json<Receipt>), ApiError> {
    if input.prompt.trim().is_empty() || Uuid::parse_str(&input.request_id).is_err() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "消息正文和有效的发送标识为必填项".to_owned(),
        ));
    }
    let (receipt, fresh) = state
        .outbox
        .reserve(&input.request_id, &id, &input.prompt)
        .map_err(|error| ApiError(StatusCode::CONFLICT, error.to_string()))?;
    if fresh {
        tokio::spawn(async move {
            let result = state.dispatch(&id, &input.prompt, &input.request_id).await;
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
        outbox: Outbox::open(&directory.join("outbox.db"))?,
        send_locks: Mutex::new(HashMap::new()),
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
        .route("/threads", get(threads))
        .route("/threads/{id}/history", get(history))
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
