use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;
use std::{path::Path, sync::Mutex};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub request_id: String,
    pub chat_id: String,
    pub status: String,
    pub error: Option<String>,
    pub result: Option<Value>,
}

struct StoredRequest {
    chat_id: String,
    prompt: String,
    kind: String,
    options: String,
    status: String,
    error: Option<String>,
    result: Option<String>,
}

impl StoredRequest {
    fn receipt(self, request_id: &str) -> Result<Receipt> {
        Ok(Receipt {
            request_id: request_id.to_owned(),
            chat_id: self.chat_id,
            status: self.status,
            error: self.error,
            result: self
                .result
                .map(|value| serde_json::from_str(&value))
                .transpose()?,
        })
    }
}

pub struct Outbox(Mutex<Connection>);

impl Outbox {
    pub fn open(path: &Path) -> Result<Self> {
        let mut database = Connection::open(path)?;
        database.execute_batch(
            "PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS sends (
                request_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, prompt TEXT NOT NULL,
                status TEXT NOT NULL, error TEXT
            );",
        )?;
        let transaction = database.transaction()?;
        for (column, definition) in [
            ("kind", "TEXT NOT NULL DEFAULT 'send'"),
            ("options", "TEXT NOT NULL DEFAULT '{}'"),
            ("result", "TEXT"),
        ] {
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sends') WHERE name=?1)",
                [column],
                |row| row.get(0),
            )?;
            if !exists {
                transaction.execute_batch(&format!(
                    "ALTER TABLE sends ADD COLUMN {column} {definition}"
                ))?;
            }
        }
        transaction.execute(
            "UPDATE sends SET status='unknown', error='服务在取得操作结果前退出，请先核对当前状态' WHERE status='sending'", [],
        )?;
        transaction.commit()?;
        Ok(Self(Mutex::new(database)))
    }

    fn read(database: &Connection, request_id: &str) -> Result<Option<StoredRequest>> {
        Ok(database.query_row(
            "SELECT chat_id, prompt, kind, options, status, error, result FROM sends WHERE request_id=?1",
            [request_id], |row| Ok(StoredRequest {
                chat_id: row.get(0)?, prompt: row.get(1)?, kind: row.get(2)?, options: row.get(3)?,
                status: row.get(4)?, error: row.get(5)?, result: row.get(6)?,
            }),
        ).optional()?)
    }

    pub fn reserve(
        &self,
        request_id: &str,
        kind: &str,
        chat_id: &str,
        prompt: &str,
        options: &Value,
    ) -> Result<(Receipt, bool)> {
        let database = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("操作数据库锁不可用"))?;
        let options = serde_json::to_string(options)?;
        if let Some(existing) = Self::read(&database, request_id)? {
            ensure!(
                existing.chat_id == chat_id
                    && existing.prompt == prompt
                    && existing.kind == kind
                    && existing.options == options,
                "同一操作标识对应了不同内容"
            );
            return Ok((existing.receipt(request_id)?, false));
        }
        database.execute(
            "INSERT INTO sends (request_id, chat_id, prompt, kind, options, status) VALUES (?1, ?2, ?3, ?4, ?5, 'sending')",
            params![request_id, chat_id, prompt, kind, options],
        )?;
        Ok((
            Receipt {
                request_id: request_id.to_owned(),
                chat_id: chat_id.to_owned(),
                status: "sending".to_owned(),
                error: None,
                result: None,
            },
            true,
        ))
    }

    pub fn finish(&self, request_id: &str, result: Result<Value>) -> Result<()> {
        let database = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("操作数据库锁不可用"))?;
        let (status, error, value) = match result {
            Ok(value) => ("accepted", None, Some(serde_json::to_string(&value)?)),
            Err(error) => ("unknown", Some(format!("操作结果待确认。{error}")), None),
        };
        database.execute(
            "UPDATE sends SET status=?2, error=?3, result=?4 WHERE request_id=?1",
            params![request_id, status, error, value],
        )?;
        Ok(())
    }

    pub fn get(&self, request_id: &str) -> Result<Option<Receipt>> {
        let database = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("操作数据库锁不可用"))?;
        Self::read(&database, request_id)?
            .map(|stored| stored.receipt(request_id))
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn repeated_requests_are_not_dispatched_twice() {
        let outbox = Outbox::open(Path::new(":memory:")).unwrap();
        assert!(
            outbox
                .reserve("id", "send", "chat", "hello", &json!({}))
                .unwrap()
                .1
        );
        assert!(
            !outbox
                .reserve("id", "send", "chat", "hello", &json!({}))
                .unwrap()
                .1
        );
        assert!(
            outbox
                .reserve("id", "send", "chat", "changed", &json!({}))
                .is_err()
        );
        assert!(
            outbox
                .reserve("id", "send", "chat", "hello", &json!({"model":"different"}))
                .is_err()
        );
        outbox.finish("id", Ok(Value::Null)).unwrap();
        assert_eq!(outbox.get("id").unwrap().unwrap().status, "accepted");
    }

    #[test]
    fn restart_preserves_uncertain_delivery() {
        let path = std::env::temp_dir().join(format!("codex-reach-{}.db", uuid::Uuid::new_v4()));
        {
            let outbox = Outbox::open(&path).unwrap();
            outbox
                .reserve("id", "create", "", "hello", &json!({}))
                .unwrap();
        }
        {
            let outbox = Outbox::open(&path).unwrap();
            assert_eq!(outbox.get("id").unwrap().unwrap().status, "unknown");
            assert!(
                !outbox
                    .reserve("id", "create", "", "hello", &json!({}))
                    .unwrap()
                    .1
            );
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn old_delivery_records_and_creation_results_remain_readable() {
        let path = std::env::temp_dir().join(format!("codex-reach-{}.db", uuid::Uuid::new_v4()));
        {
            let database = Connection::open(&path).unwrap();
            database.execute_batch("CREATE TABLE sends(request_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,error TEXT);
                INSERT INTO sends VALUES('old','chat','hello','accepted',NULL);").unwrap();
        }
        {
            let outbox = Outbox::open(&path).unwrap();
            let (old, fresh) = outbox
                .reserve("old", "send", "chat", "hello", &json!({}))
                .unwrap();
            assert!(!fresh);
            assert_eq!(old.status, "accepted");
            assert!(old.result.is_none());
            outbox
                .reserve("new", "create", "", "first message", &json!({}))
                .unwrap();
            outbox
                .finish("new", Ok(json!({"threadId":"created"})))
                .unwrap();
            assert_eq!(
                outbox.get("new").unwrap().unwrap().result.unwrap()["threadId"],
                "created"
            );
        }
        std::fs::remove_file(path).unwrap();
    }
}
