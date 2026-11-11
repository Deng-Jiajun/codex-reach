use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
    time::timeout,
};

use crate::model;

#[derive(Default)]
pub struct HistoryReader {
    session: Mutex<Option<AppServer>>,
}

impl HistoryReader {
    pub async fn page(&self, thread_id: &str, cursor: Option<String>) -> Result<Value> {
        let mut session = self.session.lock().await;
        let result = timeout(Duration::from_secs(20), async {
            if session.is_none() {
                *session = Some(AppServer::start().await?);
            }
            let server = session.as_mut().unwrap();
            let metadata = server
                .call(
                    "thread/read",
                    json!({"threadId":thread_id,"includeTurns":false}),
                )
                .await?;
            let page = server
                .call(
                    "thread/items/list",
                    json!({
                        "threadId":thread_id,"cursor":cursor,"limit":100,"sortDirection":"desc"
                    }),
                )
                .await?;
            let thread = &metadata["thread"];
            Ok(json!({
                "id":thread_id,"title":model::text(thread,"name"),"cwd":thread["cwd"],
                "status":model::status(&thread["status"]),"turns":model::history_turns(&page),
                "nextCursor":page["nextCursor"],"hasMore":page["nextCursor"].is_string()
            }))
        })
        .await
        .context("读取 Codex 历史超时")
        .and_then(|result| result);
        if result.is_err() {
            *session = None;
        }
        result
    }
}

struct AppServer {
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    sequence: u64,
}

impl AppServer {
    async fn start() -> Result<Self> {
        let mut child = Command::new("codex")
            .args([
                "-c",
                "features.local_thread_store_compression=false",
                "-c",
                "features.background_paginated_rollout_migration=false",
                "app-server",
                "--stdio",
            ])
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("无法启动 Codex 历史读取进程，请确认 codex 命令可用")?;
        let mut server = Self {
            input: child.stdin.take().context("缺少历史读取输入管道")?,
            output: BufReader::new(child.stdout.take().context("缺少历史读取输出管道")?),
            _child: child,
            sequence: 0,
        };
        server
            .call(
                "initialize",
                json!({
                    "clientInfo":{"name":"codex_reach_history","version":env!("CARGO_PKG_VERSION")},
                    "capabilities":{"experimentalApi":true}
                }),
            )
            .await?;
        server.write(json!({"method":"initialized"})).await?;
        Ok(server)
    }

    async fn write(&mut self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value)?;
        bytes.push(b'\n');
        self.input.write_all(&bytes).await?;
        self.input.flush().await?;
        Ok(())
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.sequence += 1;
        let id = self.sequence;
        self.write(json!({"id":id,"method":method,"params":params}))
            .await?;
        loop {
            let mut line = String::new();
            ensure!(
                self.output.read_line(&mut line).await? > 0,
                "Codex 历史读取进程已退出"
            );
            let response: Value = serde_json::from_str(&line)?;
            if response.get("method").is_some() {
                if response.get("id").is_some() {
                    self.write(json!({"id":response["id"],"error":{
                        "code":-32601,"message":"This client only reads history"
                    }}))
                    .await?;
                }
                continue;
            }
            if response["id"] != id {
                continue;
            }
            if let Some(error) = response.get("error") {
                bail!(
                    "Codex 历史读取失败（RPC {}），请重新加载对话",
                    error["code"]
                );
            }
            return response
                .get("result")
                .cloned()
                .context("Codex 历史响应缺少结果");
        }
    }
}
