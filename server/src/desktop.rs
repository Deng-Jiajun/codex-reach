use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::ClientOptions,
    sync::{Mutex, mpsc, oneshot, watch},
    time::timeout,
};
use uuid::Uuid;

const FRAME_LIMIT: usize = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct AppTools {
    pub caller_thread_id: String,
    pub pipe_path: Option<String>,
}

impl AppTools {
    fn pipe(&self) -> Result<String> {
        if let Some(path) = &self.pipe_path {
            return Ok(path.clone());
        }
        let candidates = std::fs::read_dir(r"\\.\pipe\")?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("codex-app-tools-"))
            .collect::<Vec<_>>();
        ensure!(
            candidates.len() == 1,
            "需要一个正在运行的 Codex 桌面实例，当前发现 {} 个工具管道",
            candidates.len()
        );
        Ok(format!(r"\\.\pipe\{}", candidates[0]))
    }

    pub async fn call(&self, tool: &str, arguments: Value) -> Result<Value> {
        let path = self.pipe()?;
        let id = Uuid::new_v4().to_string();
        let request = json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{
            "arguments":arguments,"callerSource":"codex","hostId":"local",
            "callId":format!("codex-reach-{}", Uuid::new_v4()),"namespace":"codex_app",
            "threadId":self.caller_thread_id,"tool":tool,"turnId":"codex-reach-mobile"
        }});
        let response = timeout(Duration::from_secs(30), async {
            let mut pipe = ClientOptions::new()
                .open(path)
                .context("无法连接 Codex 桌面工具管道")?;
            write_frame(&mut pipe, &request).await?;
            let size = pipe.read_u32_le().await? as usize;
            ensure!(size <= FRAME_LIMIT, "Codex 响应超过 64 MiB");
            let mut body = vec![0; size];
            pipe.read_exact(&mut body).await?;
            Ok::<Value, anyhow::Error>(serde_json::from_slice(&body)?)
        })
        .await
        .context("Codex 桌面请求超时")??;
        ensure!(response["id"] == id, "Codex 响应标识不匹配");
        if response.get("error").is_some() {
            bail!("Codex 工具接口返回错误");
        }
        let result = &response["result"];
        let texts: Vec<&str> = result["contentItems"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| item["type"] == "inputText")
            .filter_map(|item| item["text"].as_str())
            .collect();
        ensure!(
            result["success"] == true,
            "{}",
            texts.first().copied().unwrap_or("Codex 桌面未确认操作成功")
        );
        ensure!(texts.len() == 1, "Codex 工具响应格式发生变化");
        Ok(serde_json::from_str(texts[0])?)
    }
}

async fn write_frame(
    pipe: &mut tokio::net::windows::named_pipe::NamedPipeClient,
    value: &Value,
) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    pipe.write_u32_le(body.len() as u32).await?;
    pipe.write_all(&body).await?;
    Ok(())
}

struct Subscription {
    owner: String,
    state: Option<Value>,
    revision: u64,
    touched: Instant,
}

pub struct Ipc {
    client_id: Mutex<String>,
    pub epoch: String,
    pub connected: AtomicBool,
    outbound: mpsc::Sender<Value>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value>>>>,
    subscriptions: Mutex<HashMap<String, Subscription>>,
    follow_gate: Mutex<()>,
    changed: watch::Sender<u64>,
}

impl Ipc {
    pub async fn connect() -> Result<Arc<Self>> {
        let pipe = ClientOptions::new()
            .open(r"\\.\pipe\codex-ipc")
            .context("Codex 实时管道未就绪")?;
        let (outbound, receiver) = mpsc::channel(64);
        let (changed, _) = watch::channel(0);
        let client = Arc::new(Self {
            client_id: Mutex::new("initializing-client".to_owned()),
            epoch: Uuid::new_v4().to_string(),
            connected: AtomicBool::new(true),
            outbound,
            pending: Mutex::new(HashMap::new()),
            subscriptions: Mutex::new(HashMap::new()),
            follow_gate: Mutex::new(()),
            changed,
        });
        let actor = Arc::clone(&client);
        let actor_task = tokio::spawn(async move {
            actor.run(pipe, receiver).await;
        });
        let initialize = async {
            let response = client
                .request("initialize", json!({"clientType":"codex-reach"}), None, 1)
                .await?;
            *client.client_id.lock().await = response["result"]["clientId"]
                .as_str()
                .context("缺少桌面客户端标识")?
                .to_owned();
            Ok::<(), anyhow::Error>(())
        }
        .await;
        if let Err(error) = initialize {
            actor_task.abort();
            return Err(error);
        }
        Ok(client)
    }

    async fn run(
        self: Arc<Self>,
        mut pipe: tokio::net::windows::named_pipe::NamedPipeClient,
        mut receiver: mpsc::Receiver<Value>,
    ) {
        let mut buffer = Vec::new();
        let mut cleanup = tokio::time::interval(Duration::from_secs(30));
        let result: Result<()> = async {
            loop {
                tokio::select! {
                    Some(frame) = receiver.recv() => write_frame(&mut pipe, &frame).await?,
                    count = pipe.read_buf(&mut buffer) => {
                        ensure!(count? != 0, "Codex 实时连接已关闭");
                        while buffer.len() >= 4 {
                            let size = u32::from_le_bytes(buffer[..4].try_into()?) as usize;
                            ensure!(size <= FRAME_LIMIT, "Codex 实时帧超过 64 MiB");
                            if buffer.len() < size + 4 { break; }
                            let frame: Value = serde_json::from_slice(&buffer[4..size + 4])?;
                            buffer.drain(..size + 4);
                            self.handle_frame(&mut pipe, frame).await?;
                        }
                    }
                    _ = cleanup.tick() => {
                        let expired = {
                            let mut subscriptions = self.subscriptions.lock().await;
                            let ids = subscriptions.iter().filter(|(_, item)| item.touched.elapsed() > Duration::from_secs(60))
                                .map(|(id, item)| (id.clone(), item.owner.clone())).collect::<Vec<_>>();
                            for (id, _) in &ids { subscriptions.remove(id); }
                            ids
                        };
                        for (id, owner) in expired {
                            let frame = self.follow_frame(&id, &owner, false).await;
                            write_frame(&mut pipe, &frame).await?;
                        }
                    }
                }
            }
        }.await;
        self.connected.store(false, Ordering::SeqCst);
        let reason = result
            .err()
            .map(|error| error.to_string())
            .unwrap_or_else(|| "连接关闭".to_owned());
        for (_, pending) in self.pending.lock().await.drain() {
            let _ = pending.send(Err(anyhow::anyhow!(reason.clone())));
        }
        self.changed.send_modify(|revision| *revision += 1);
    }

    async fn handle_frame(
        &self,
        pipe: &mut tokio::net::windows::named_pipe::NamedPipeClient,
        frame: Value,
    ) -> Result<()> {
        match frame["type"].as_str() {
            Some("client-discovery-request") => write_frame(pipe, &json!({"type":"client-discovery-response","requestId":frame["requestId"],"response":{"canHandle":false}})).await?,
            Some("request") => write_frame(pipe, &json!({"type":"response","requestId":frame["requestId"],"resultType":"error","error":"no-handler-for-request"})).await?,
            Some("response") => {
                if let Some(id) = frame["requestId"].as_str()
                    && let Some(pending) = self.pending.lock().await.remove(id)
                {
                    let result = if frame["resultType"] == "success" { Ok(frame) }
                        else { Err(anyhow::anyhow!(frame["error"].as_str().unwrap_or("Codex IPC 请求失败").to_owned())) };
                    let _ = pending.send(result);
                }
            }
            Some("broadcast") if frame["method"] == "thread-stream-state-changed" => {
                if let Some(id) = frame["params"]["conversationId"].as_str() {
                    let mut subscriptions = self.subscriptions.lock().await;
                    if let Some(subscription) = subscriptions.get_mut(id) {
                        let change = &frame["params"]["change"];
                        let owner = frame["sourceClientId"].as_str().unwrap_or_default();
                        if change["type"] == "snapshot" {
                            subscription.owner = owner.to_owned();
                        }
                        if owner != subscription.owner || apply_change(&mut subscription.state, &mut subscription.revision, change).is_err() {
                            subscription.state = None;
                        }
                        self.changed.send_modify(|revision| *revision += 1);
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn request(
        &self,
        method: &str,
        params: Value,
        owner: Option<&str>,
        version: u32,
    ) -> Result<Value> {
        ensure!(
            self.connected.load(Ordering::SeqCst),
            "Codex 实时连接已断开"
        );
        let id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), sender);
        let mut frame = json!({"type":"request","requestId":id,"method":method,"params":params,
            "sourceClientId":self.client_id.lock().await.clone(),"version":version});
        if let Some(owner) = owner {
            frame["targetClientId"] = json!(owner);
        }
        let result = async {
            self.outbound.send(frame).await.context("实时连接已关闭")?;
            timeout(Duration::from_secs(20), receiver)
                .await
                .context("Codex 实时请求超时")?
                .context("Codex 实时响应中断")?
        }
        .await;
        self.pending.lock().await.remove(&id);
        result
    }

    async fn follow_frame(&self, id: &str, owner: &str, following: bool) -> Value {
        json!({"type":"broadcast","method":"thread-stream-following-changed",
            "sourceClientId":self.client_id.lock().await.clone(),"targetClientId":owner,"version":1,
            "params":{"hostId":"local","conversationId":id,"following":following}})
    }

    pub async fn follow(&self, id: &str) -> Result<Option<String>> {
        let _gate = self.follow_gate.lock().await;
        {
            let mut subscriptions = self.subscriptions.lock().await;
            if let Some(subscription) = subscriptions.get_mut(id) {
                subscription.touched = Instant::now();
                if subscription.state.is_some() {
                    return Ok(Some(subscription.owner.clone()));
                }
            }
        }
        let response = match self
            .request(
                "thread-owner-discovery",
                json!({"hostId":"local","conversationId":id}),
                None,
                1,
            )
            .await
        {
            Ok(response) => response,
            Err(error) if error.to_string() == "no-client-found" => return Ok(None),
            Err(error) => return Err(error),
        };
        let owner = response["handledByClientId"]
            .as_str()
            .context("缺少会话执行端标识")?
            .to_owned();
        self.subscriptions.lock().await.insert(
            id.to_owned(),
            Subscription {
                owner: owner.clone(),
                state: None,
                revision: 0,
                touched: Instant::now(),
            },
        );
        self.outbound
            .send(self.follow_frame(id, &owner, true).await)
            .await?;
        Ok(Some(owner))
    }

    pub async fn live(&self, id: &str, after: Option<&str>) -> Result<Value> {
        let mut changed = self.changed.subscribe();
        if self.follow(id).await?.is_none() {
            return Ok(json!({"available":false}));
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            ensure!(
                self.connected.load(Ordering::SeqCst),
                "Codex 实时连接已断开"
            );
            let (current, needs_snapshot) = {
                let subscriptions = self.subscriptions.lock().await;
                let entry = subscriptions.get(id).context("实时订阅已过期")?;
                (
                    entry
                        .state
                        .as_ref()
                        .map(|state| (state.clone(), entry.owner.clone(), entry.revision)),
                    entry.state.is_none() && entry.revision > 0,
                )
            };
            if let Some((state, owner, revision)) = current {
                let cursor = format!("{}:{owner}:{revision}", self.epoch);
                if after != Some(cursor.as_str()) || tokio::time::Instant::now() >= deadline {
                    let mut view = crate::model::stream_view(&state);
                    view["available"] = json!(true);
                    view["revision"] = json!(cursor);
                    return Ok(view);
                }
            }
            if tokio::time::Instant::now() >= deadline {
                bail!("尚未收到完整会话快照，请重新连接");
            }
            if needs_snapshot && self.follow(id).await?.is_none() {
                return Ok(json!({"available":false}));
            }
            let _ = tokio::time::timeout_at(deadline, changed.changed()).await;
        }
    }

    pub async fn send(&self, id: &str, owner: &str, prompt: &str, request_id: &str) -> Result<()> {
        let active = self
            .subscriptions
            .lock()
            .await
            .get(id)
            .and_then(|entry| entry.state.as_ref())
            .map(|state| state["threadRuntimeStatus"]["type"] == "active")
            .unwrap_or(false);
        let input = json!([{"type":"text","text":prompt,"text_elements":[]}]);
        if active {
            self.request(
                "thread-follower-steer-turn",
                json!({"conversationId":id,"input":input,"clientUserMessageId":request_id}),
                Some(owner),
                1,
            )
            .await?;
        } else {
            self.request(
                "thread-follower-start-turn",
                json!({"conversationId":id,"turnStart":{
                    "request":{"threadId":id,"input":input,"clientUserMessageId":request_id},
                    "context":{"attachments":[],"inheritThreadSettings":true}
                }}),
                Some(owner),
                2,
            )
            .await?;
        }
        Ok(())
    }
}

fn apply_change(state: &mut Option<Value>, revision: &mut u64, change: &Value) -> Result<()> {
    let next_revision = change["revision"].as_u64().context("缺少流版本")?;
    if change["type"] == "snapshot" {
        *state = Some(change["conversationState"].clone());
    } else {
        ensure!(
            change["baseRevision"].as_u64() == Some(*revision),
            "流版本不连续"
        );
        let patches = change["patches"]
            .as_array()
            .context("缺少增量数据")?
            .iter()
            .map(|patch| {
                let segments = patch["path"].as_array().context("增量路径无效")?;
                let path = segments
                    .iter()
                    .map(|segment| {
                        segment
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| segment.to_string())
                    })
                    .map(|segment| format!("/{}", segment.replace('~', "~0").replace('/', "~1")))
                    .collect::<String>();
                let mut converted = patch.clone();
                converted["path"] = json!(path);
                Ok(converted)
            })
            .collect::<Result<Vec<_>>>()?;
        let patch: json_patch::Patch = serde_json::from_value(json!(patches))?;
        json_patch::patch(state.as_mut().context("增量之前缺少快照")?, &patch)?;
    }
    *revision = next_revision;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_array_edits_and_rejects_missing_revision() {
        let mut state = Some(json!({"turns":[{"id":"old"}]}));
        let mut revision = 4;
        apply_change(&mut state, &mut revision, &json!({"type":"patch","baseRevision":4,"revision":5,"patches":[
            {"op":"remove","path":["turns",0]}, {"op":"add","path":["turns",0],"value":{"id":"new"}}
        ]})).unwrap();
        assert_eq!(state.as_ref().unwrap()["turns"][0]["id"], "new");
        assert!(
            apply_change(
                &mut state,
                &mut revision,
                &json!({"baseRevision":3,"revision":6,"patches":[]})
            )
            .is_err()
        );
        assert_eq!(revision, 5);
    }
}
