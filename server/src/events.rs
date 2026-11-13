use crate::{ApiError, AppState, model};
use anyhow::{Context, Result};
use axum::{
    Json,
    extract::{Query, State},
};
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Notify;

pub struct Events {
    db: Mutex<Connection>,
    changed: Notify,
    error: Mutex<Option<String>>,
}

struct Watch {
    id: String,
    title: String,
    turn: Option<String>,
    active: bool,
    created_at: i64,
    status: String,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

impl Events {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path)?;
        db.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS notification_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, content TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS notification_watch(thread_id TEXT PRIMARY KEY,title TEXT NOT NULL,updated_at REAL NOT NULL,status TEXT NOT NULL,turn_id TEXT,active INTEGER NOT NULL DEFAULT 0,dirty INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS notification_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);")?;
        db.execute(
            "INSERT OR IGNORE INTO notification_meta VALUES('started_at',?1)",
            [now()],
        )?;
        db.execute("UPDATE notification_watch SET dirty=1", [])?;
        Ok(Self {
            db: Mutex::new(db),
            changed: Notify::new(),
            error: Mutex::new(None),
        })
    }

    fn discover(&self, thread: &Value) -> Result<()> {
        let id = thread["id"].as_str().context("通知对话缺少标识")?;
        let db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("提醒数据库锁不可用"))?;
        db.execute("INSERT INTO notification_watch(thread_id,title,updated_at,status,created_at) VALUES(?1,?2,?3,?4,?5)
            ON CONFLICT(thread_id) DO UPDATE SET title=excluded.title,
            dirty=CASE WHEN notification_watch.updated_at!=excluded.updated_at OR notification_watch.status!=excluded.status THEN 1 ELSE notification_watch.dirty END,
            updated_at=excluded.updated_at,status=excluded.status", params![id,model::text(thread,"title"),model::timestamp_seconds(&thread["updatedAt"]).as_f64().unwrap_or(0.0),model::status(&thread["status"]),model::timestamp_seconds(&thread["createdAt"]).as_i64().unwrap_or(0)])?;
        Ok(())
    }

    fn watches(&self) -> Result<Vec<Watch>> {
        let db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("提醒数据库锁不可用"))?;
        let mut query = db.prepare("SELECT thread_id,title,turn_id,active,created_at,status FROM notification_watch WHERE dirty=1 OR active=1 ORDER BY active DESC,updated_at DESC")?;
        Ok(query
            .query_map([], |row| {
                Ok(Watch {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    turn: row.get(2)?,
                    active: row.get(3)?,
                    created_at: row.get(4)?,
                    status: row.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    fn emit(
        &self,
        id: String,
        chat: &Watch,
        turn: &str,
        kind: &str,
        body: &str,
        request: Option<&Value>,
    ) -> Result<()> {
        let db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("提醒数据库锁不可用"))?;
        let content = json!({"id":id,"threadId":chat.id,"turnId":turn,"kind":kind,"title":chat.title,"body":body,"requestId":request,"createdAt":now()});
        let inserted = db.execute(
            "INSERT OR IGNORE INTO notification_events(event_id,content) VALUES(?1,?2)",
            params![id, serde_json::to_string(&content)?],
        )?;
        if inserted != 0 {
            self.changed.notify_waiters();
        }
        Ok(())
    }

    fn saved(&self, watch: &Watch, turn: Option<&str>, active: bool) -> Result<()> {
        let db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("提醒数据库锁不可用"))?;
        db.execute(
            "UPDATE notification_watch SET turn_id=?2,active=?3,dirty=0 WHERE thread_id=?1",
            params![watch.id, turn, active],
        )?;
        Ok(())
    }

    fn page(&self, after: i64) -> Result<Value> {
        let db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("提醒数据库锁不可用"))?;
        let latest: i64 = db.query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM notification_events",
            [],
            |row| row.get(0),
        )?;
        let mut cursor = if after < 0 || after > latest {
            latest
        } else {
            after
        };
        let mut query = db.prepare("SELECT sequence,content FROM notification_events WHERE sequence>?1 ORDER BY sequence LIMIT 100")?;
        let rows = query.query_map([cursor], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut events = Vec::new();
        for row in rows {
            let (sequence, content) = row?;
            cursor = sequence;
            events.push(serde_json::from_str::<Value>(&content)?);
        }
        Ok(
            json!({"events":events,"cursor":cursor,"monitorError":self.error.lock().ok().and_then(|value| value.clone())}),
        )
    }
}

#[derive(Deserialize)]
pub struct EventQuery {
    after: Option<i64>,
    #[serde(default)]
    wait: bool,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(query): Query<EventQuery>,
) -> Result<Json<Value>, ApiError> {
    let notified = state.events.changed.notified();
    tokio::pin!(notified);
    notified.as_mut().enable();
    let after = query.after.unwrap_or(-1);
    let page = state.events.page(after)?;
    if query.wait && after >= 0 && page["events"].as_array().is_some_and(Vec::is_empty) {
        let _ = tokio::time::timeout(Duration::from_secs(18), notified).await;
        return Ok(Json(state.events.page(after)?));
    }
    Ok(Json(page))
}

async fn inspect(state: &AppState, watch: &Watch) -> Result<()> {
    let started: i64 = state
        .events
        .db
        .lock()
        .map_err(|_| anyhow::anyhow!("提醒数据库锁不可用"))?
        .query_row(
            "SELECT value FROM notification_meta WHERE key='started_at'",
            [],
            |row| row.get(0),
        )?;
    let mut cursor = Value::Null;
    let mut latest = None;
    let mut active = false;
    let mut recent_turn = false;
    loop {
        let page = state.app_server.call("thread/turns/list", json!({"threadId":watch.id,"limit":20,"sortDirection":"desc","itemsView":"notLoaded","cursor":cursor})).await?;
        let mut found = false;
        for turn in page["data"].as_array().into_iter().flatten() {
            let id = turn["id"].as_str().context("轮次缺少标识")?;
            if latest.is_none() {
                latest = Some(id.to_owned());
            }
            recent_turn |= turn["startedAt"]
                .as_i64()
                .is_some_and(|time| time >= started);
            let known = watch.turn.as_deref() == Some(id);
            let recent = turn["completedAt"]
                .as_i64()
                .is_some_and(|time| time >= started)
                || (watch.turn.is_some() && (!known || watch.active))
                || watch.created_at >= started;
            let kind = match turn["status"].as_str() {
                Some("completed") => Some("completed"),
                Some("failed") => Some("failed"),
                _ => None,
            };
            if recent && let Some(kind) = kind {
                state.events.emit(
                    format!("{}:{id}:{kind}", watch.id),
                    watch,
                    id,
                    kind,
                    if kind == "completed" {
                        "任务已完成"
                    } else {
                        "任务执行失败"
                    },
                    None,
                )?;
            }
            if turn["status"] == "inProgress" {
                active = true;
            }
            if known {
                found = true;
                break;
            }
        }
        cursor = page["nextCursor"].clone();
        if found || cursor.is_null() || watch.turn.is_none() {
            break;
        }
    }
    let inspect_live = watch.active
        || watch.status == "active"
        || recent_turn
        || (watch.turn.is_some() && latest != watch.turn);
    let live = if inspect_live {
        state.ipc().await?.live(&watch.id, None).await?
    } else {
        json!({"available":false})
    };
    if live["available"] == true {
        active = live["status"] == "active";
        let turn_id = live["activeTurnId"]
            .as_str()
            .or(latest.as_deref())
            .unwrap_or("");
        for request in live["requests"].as_array().into_iter().flatten() {
            let kind = if request["method"] == "item/tool/requestUserInput" {
                "question"
            } else {
                "approval"
            };
            state.events.emit(
                format!("{}:{turn_id}:{}:{kind}", watch.id, request["id"]),
                watch,
                turn_id,
                kind,
                if kind == "question" {
                    "任务等待回答"
                } else {
                    "任务等待审批"
                },
                Some(&request["id"]),
            )?;
            active = true;
        }
        let mut answered = HashSet::new();
        for message in live["turns"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|turn| turn["messages"].as_array().into_iter().flatten())
        {
            for reply in message["questionReplies"].as_array().into_iter().flatten() {
                if let Some(id) = reply["questionItemId"].as_str() {
                    answered.insert(id.to_owned());
                }
            }
        }
        for turn in live["turns"].as_array().into_iter().flatten() {
            for message in turn["messages"].as_array().into_iter().flatten() {
                for (index, question) in message["questions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    let id = serde_json::to_string(&json!([
                        "request_user_input_async",
                        message["id"],
                        index
                    ]))?;
                    if answered.contains(&id) {
                        continue;
                    }
                    state.events.emit(
                        format!("{}:{id}:question", watch.id),
                        watch,
                        turn["id"].as_str().unwrap_or(""),
                        "question",
                        question["title"].as_str().unwrap_or("任务等待回答"),
                        Some(&json!(id)),
                    )?;
                    active = true;
                }
            }
        }
    }
    state.events.saved(watch, latest.as_deref(), active)
}

pub async fn run(state: Arc<AppState>) {
    let mut scan_at = tokio::time::Instant::now();
    loop {
        let result = async {
            if tokio::time::Instant::now() >= scan_at {
                let mut seen = HashSet::new();
                for archived in [false, true] {
                    let mut cursor = Value::Null;
                    loop {
                        let mut arguments = json!({"mode":"history","source":"codex","hostId":"local","archived":archived,"limit":50});
                        if cursor.is_string() { arguments["cursor"] = cursor.clone(); }
                        let page = state.tools.call("list_threads", arguments).await?;
                        for thread in page["threads"].as_array().into_iter().flatten().filter(|thread| thread["kind"] == "codex" && thread["hostId"] == "local") {
                            state.events.discover(thread)?;
                            if let Some(id) = thread["id"].as_str() { seen.insert(id.to_owned()); }
                        }
                        cursor = page["nextCursor"].clone();
                        if cursor.is_null() { break; }
                    }
                }
                {
                    let db = state.events.db.lock().map_err(|_| anyhow::anyhow!("提醒数据库锁不可用"))?;
                    let mut statement = db.prepare("SELECT thread_id FROM notification_watch")?;
                    let ids = statement.query_map([], |row| row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                    for id in ids.into_iter().filter(|id| !seen.contains(id)) { db.execute("DELETE FROM notification_watch WHERE thread_id=?1", [id])?; }
                }
                scan_at = tokio::time::Instant::now() + Duration::from_secs(10);
            }
            let watches = state.events.watches()?;
            let mut failure = None;
            for watch in watches { if let Err(error) = inspect(&state, &watch).await { failure = Some(error); } }
            if let Some(error) = failure { return Err(error); }
            Ok::<(), anyhow::Error>(())
        }.await;
        if let Ok(mut error) = state.events.error.lock() {
            *error = result.err().map(|error| error.to_string());
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notification_identity_is_durable_and_cursor_replays_offline_events() {
        let events = Events::open(Path::new(":memory:")).unwrap();
        let watch = Watch {
            id: "chat".into(),
            title: "Title".into(),
            turn: None,
            active: false,
            created_at: 0,
            status: "idle".into(),
        };
        events
            .emit("event".into(), &watch, "turn", "completed", "Done", None)
            .unwrap();
        events
            .emit("event".into(), &watch, "turn", "completed", "Done", None)
            .unwrap();
        assert_eq!(
            events.page(0).unwrap()["events"].as_array().unwrap().len(),
            1
        );
        assert!(
            events.page(1).unwrap()["events"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(events.page(-1).unwrap()["cursor"], 1);
    }
}
