use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::{path::Path, sync::Mutex};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub request_id: String,
    pub chat_id: String,
    pub status: String,
    pub error: Option<String>,
}

pub struct Outbox(Mutex<Connection>);

impl Outbox {
    pub fn open(path: &Path) -> Result<Self> {
        let database = Connection::open(path)?;
        database.execute_batch(
            "PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS sends (
                request_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, prompt TEXT NOT NULL,
                status TEXT NOT NULL, error TEXT
            );
            UPDATE sends SET status='unknown', error='服务在取得投递结果前退出，请先核对聊天记录'
            WHERE status='sending';",
        )?;
        Ok(Self(Mutex::new(database)))
    }

    pub fn reserve(
        &self,
        request_id: &str,
        chat_id: &str,
        prompt: &str,
    ) -> Result<(Receipt, bool)> {
        let database = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("发送数据库锁不可用"))?;
        let existing = database
            .query_row(
                "SELECT chat_id, prompt, status, error FROM sends WHERE request_id=?1",
                [request_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()?;
        if let Some((chat, message, status, error)) = existing {
            ensure!(
                chat == chat_id && message == prompt,
                "同一发送标识对应了不同内容"
            );
            return Ok((
                Receipt {
                    request_id: request_id.to_owned(),
                    chat_id: chat,
                    status,
                    error,
                },
                false,
            ));
        }
        database.execute("INSERT INTO sends (request_id, chat_id, prompt, status) VALUES (?1, ?2, ?3, 'sending')", params![request_id, chat_id, prompt])?;
        Ok((
            Receipt {
                request_id: request_id.to_owned(),
                chat_id: chat_id.to_owned(),
                status: "sending".to_owned(),
                error: None,
            },
            true,
        ))
    }

    pub fn finish(&self, request_id: &str, result: Result<()>) -> Result<()> {
        let database = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("发送数据库锁不可用"))?;
        let (status, error) = match result {
            Ok(()) => ("accepted", None),
            Err(error) => ("unknown", Some(format!("投递结果待确认。{}", error))),
        };
        database.execute(
            "UPDATE sends SET status=?2, error=?3 WHERE request_id=?1",
            params![request_id, status, error],
        )?;
        Ok(())
    }

    pub fn get(&self, request_id: &str) -> Result<Option<Receipt>> {
        let database = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("发送数据库锁不可用"))?;
        Ok(database
            .query_row(
                "SELECT chat_id, status, error FROM sends WHERE request_id=?1",
                [request_id],
                |row| {
                    Ok(Receipt {
                        request_id: request_id.to_owned(),
                        chat_id: row.get(0)?,
                        status: row.get(1)?,
                        error: row.get(2)?,
                    })
                },
            )
            .optional()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_requests_are_not_dispatched_twice() {
        let outbox = Outbox::open(Path::new(":memory:")).unwrap();
        assert!(outbox.reserve("id", "chat", "hello").unwrap().1);
        assert!(!outbox.reserve("id", "chat", "hello").unwrap().1);
        assert!(outbox.reserve("id", "chat", "changed").is_err());
        outbox.finish("id", Ok(())).unwrap();
        assert_eq!(outbox.get("id").unwrap().unwrap().status, "accepted");
    }

    #[test]
    fn restart_preserves_uncertain_delivery() {
        let path = std::env::temp_dir().join(format!("codex-reach-{}.db", uuid::Uuid::new_v4()));
        {
            let outbox = Outbox::open(&path).unwrap();
            outbox.reserve("id", "chat", "hello").unwrap();
        }
        {
            let outbox = Outbox::open(&path).unwrap();
            assert_eq!(outbox.get("id").unwrap().unwrap().status, "unknown");
            assert!(!outbox.reserve("id", "chat", "hello").unwrap().1);
        }
        std::fs::remove_file(path).unwrap();
    }
}
