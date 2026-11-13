use crate::files::{self, FileAttachment};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use flate2::read::GzDecoder;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

pub const CHUNK_BYTES: usize = 512 * 1024;

#[derive(Deserialize)]
pub struct Start {
    pub id: String,
    pub name: String,
    pub size: u64,
}

#[derive(Deserialize)]
pub struct Chunk {
    pub offset: u64,
    pub data: String,
    pub gzip: bool,
    pub sha256: String,
}

#[derive(Serialize)]
pub struct Receipt {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub offset: u64,
    pub attachment: Option<FileAttachment>,
}

struct Upload {
    name: String,
    size: u64,
    directory: PathBuf,
    target: Option<PathBuf>,
    complete: bool,
}

pub struct Uploads {
    database: Mutex<Connection>,
    root: PathBuf,
}

impl Uploads {
    pub fn open(root: &Path) -> Result<Self> {
        fs::create_dir_all(root.join(".partial"))?;
        let database = Connection::open(root.join(".uploads.db"))?;
        database.execute_batch(
            "PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS uploads (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL,
                directory TEXT NOT NULL, target TEXT, complete INTEGER NOT NULL DEFAULT 0
            );",
        )?;
        Ok(Self {
            database: Mutex::new(database),
            root: root.to_owned(),
        })
    }

    fn read(database: &Connection, id: &str) -> Result<Option<Upload>> {
        Uuid::parse_str(id).context("上传标识无效")?;
        Ok(database
            .query_row(
                "SELECT name,size,directory,target,complete FROM uploads WHERE id=?",
                [id],
                |row| {
                    Ok(Upload {
                        name: row.get(0)?,
                        size: row.get::<_, i64>(1)? as u64,
                        directory: PathBuf::from(row.get::<_, String>(2)?),
                        target: row.get::<_, Option<String>>(3)?.map(PathBuf::from),
                        complete: row.get(4)?,
                    })
                },
            )
            .optional()?)
    }

    fn partial(&self, id: &str) -> PathBuf {
        self.root.join(".partial").join(id)
    }

    fn receipt(&self, id: &str, upload: &Upload) -> Result<Receipt> {
        let attachment = if upload.complete {
            let target = upload.target.as_ref().context("上传结果缺少路径")?;
            Some(FileAttachment {
                path: files::display_path(target)?,
                name: target.file_name().unwrap().to_string_lossy().into_owned(),
                directory: false,
                image: files::is_image_path(target),
            })
        } else {
            None
        };
        let offset = if upload.complete {
            upload.size
        } else {
            fs::metadata(self.partial(id)).map(|m| m.len()).unwrap_or(0)
        };
        Ok(Receipt {
            id: id.to_owned(),
            name: upload.name.clone(),
            size: upload.size,
            offset,
            attachment,
        })
    }

    pub fn status(&self, id: &str) -> Result<Receipt> {
        let database = self.database.lock().unwrap();
        let upload = Self::read(&database, id)?.context("上传记录不存在")?;
        self.receipt(id, &upload)
    }

    pub fn start(&self, input: Start) -> Result<Receipt> {
        files::validate_name(&input.name)?;
        Uuid::parse_str(&input.id).context("上传标识无效")?;
        ensure!(input.size <= i64::MAX as u64, "文件大小无效");
        let database = self.database.lock().unwrap();
        if let Some(upload) = Self::read(&database, &input.id)? {
            ensure!(
                upload.name == input.name && upload.size == input.size,
                "上传标识已用于其他文件"
            );
            if !upload.complete && !self.partial(&input.id).exists() {
                File::create(self.partial(&input.id))?.sync_all()?;
            }
            return self.receipt(&input.id, &upload);
        }
        let directory = files::date_directory(&self.root);
        fs::create_dir_all(&directory)?;
        database.execute(
            "INSERT INTO uploads(id,name,size,directory) VALUES(?,?,?,?)",
            params![
                input.id,
                input.name,
                input.size as i64,
                files::display_path(&directory)?
            ],
        )?;
        File::create(self.partial(&input.id))?.sync_all()?;
        self.receipt(
            &input.id,
            &Upload {
                name: input.name,
                size: input.size,
                directory,
                target: None,
                complete: false,
            },
        )
    }

    pub fn write(&self, id: &str, input: Chunk) -> Result<Receipt> {
        ensure!(
            input.data.len() <= (CHUNK_BYTES + 1024) * 4 / 3 + 4,
            "传输分块过大"
        );
        let encoded = STANDARD.decode(&input.data).context("分块编码无效")?;
        let bytes = if input.gzip {
            let mut bytes = Vec::new();
            GzDecoder::new(encoded.as_slice())
                .take(CHUNK_BYTES as u64 + 1)
                .read_to_end(&mut bytes)?;
            bytes
        } else {
            encoded
        };
        ensure!(
            !bytes.is_empty() && bytes.len() <= CHUNK_BYTES,
            "传输分块大小无效"
        );
        ensure!(
            format!("{:x}", Sha256::digest(&bytes)) == input.sha256,
            "分块校验失败，请重试"
        );
        let database = self.database.lock().unwrap();
        let upload = Self::read(&database, id)?.context("上传记录不存在")?;
        ensure!(!upload.complete, "文件已上传完成，请查询回执");
        let end = input
            .offset
            .checked_add(bytes.len() as u64)
            .context("分块位置无效")?;
        ensure!(end <= upload.size, "分块超出文件范围");
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.partial(id))?;
        let length = file.metadata()?.len();
        ensure!(input.offset <= length, "分块前序内容尚未到达");
        file.seek(SeekFrom::Start(input.offset))?;
        let overlap = bytes.len().min((length - input.offset) as usize);
        let mut existing = vec![0; overlap];
        file.read_exact(&mut existing)?;
        ensure!(
            existing == bytes[..overlap],
            "重试文件内容与已接收内容不一致，请重新选择"
        );
        file.write_all(&bytes[overlap..])?;
        file.sync_all()?;
        self.receipt(id, &upload)
    }

    pub fn finish(&self, id: &str) -> Result<Receipt> {
        let database = self.database.lock().unwrap();
        let mut upload = Self::read(&database, id)?.context("上传记录不存在")?;
        if upload.complete {
            return self.receipt(id, &upload);
        }
        let partial = self.partial(id);
        ensure!(
            fs::metadata(&partial)?.len() == upload.size,
            "文件尚未传输完整"
        );
        if let Some(target) = upload.target.as_ref().filter(|path| !path.exists()) {
            match fs::hard_link(&partial, target) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        // Recover publication when the service exited between hard-link creation and receipt commit.
        if let Some(target) = upload.target.as_ref().filter(|path| path.exists()) {
            let mut original = File::open(&partial)?;
            let mut published = File::open(target)?;
            let mut left = [0_u8; 64 * 1024];
            let mut right = [0_u8; 64 * 1024];
            let mut equal = published.metadata()?.len() == upload.size;
            while equal {
                let count = original.read(&mut left)?;
                if count == 0 {
                    break;
                }
                published.read_exact(&mut right[..count])?;
                equal = left[..count] == right[..count];
            }
            if equal {
                database.execute("UPDATE uploads SET complete=1 WHERE id=?", [id])?;
                upload.complete = true;
                let _ = fs::remove_file(partial);
                return self.receipt(id, &upload);
            }
        }
        let mut index = 0;
        loop {
            let target = files::numbered_path(&upload.directory, &upload.name, index);
            let reserved: bool = database.query_row(
                "SELECT EXISTS(SELECT 1 FROM uploads WHERE target=?)",
                [files::display_path(&target)?],
                |row| row.get(0),
            )?;
            if !target.exists() && !reserved {
                database.execute(
                    "UPDATE uploads SET target=? WHERE id=?",
                    params![files::display_path(&target)?, id],
                )?;
                // Hard-link publication is atomic and refuses to replace a concurrently created file.
                match fs::hard_link(&partial, &target) {
                    Ok(()) => {
                        upload.target = Some(target);
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error.into()),
                }
            }
            index += 1;
        }
        database.execute("UPDATE uploads SET complete=1 WHERE id=?", [id])?;
        upload.complete = true;
        let _ = fs::remove_file(partial);
        self.receipt(id, &upload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};

    fn chunk(bytes: &[u8], offset: u64, compress: bool) -> Chunk {
        let encoded = if compress {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
            encoder.write_all(bytes).unwrap();
            encoder.finish().unwrap()
        } else {
            bytes.to_vec()
        };
        Chunk {
            offset,
            data: STANDARD.encode(encoded),
            gzip: compress,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }

    #[test]
    fn chunks_retry_by_identity_and_publish_once_in_date_directory() {
        let root = std::env::temp_dir().join(format!("reach-upload-test-{}", Uuid::new_v4()));
        let uploads = Uploads::open(&root).unwrap();
        let id = Uuid::new_v4().to_string();
        uploads
            .start(Start {
                id: id.clone(),
                name: "资料.txt".into(),
                size: 6,
            })
            .unwrap();
        assert!(uploads.write(&id, chunk(b"def", 3, true)).is_err());
        uploads.write(&id, chunk(b"abc", 0, true)).unwrap();
        uploads.write(&id, chunk(b"abc", 0, false)).unwrap();
        assert!(uploads.write(&id, chunk(b"xyz", 0, false)).is_err());
        assert!(uploads.finish(&id).is_err());
        uploads.write(&id, chunk(b"def", 3, true)).unwrap();
        let file = uploads.finish(&id).unwrap().attachment.unwrap();
        assert_eq!(fs::read(&file.path).unwrap(), b"abcdef");
        assert_eq!(
            uploads.finish(&id).unwrap().attachment.unwrap().path,
            file.path
        );
        assert_eq!(
            Path::new(&file.path).parent().unwrap(),
            files::date_directory(&root)
        );
        let second = Uuid::new_v4().to_string();
        uploads
            .start(Start {
                id: second.clone(),
                name: "资料.txt".into(),
                size: 0,
            })
            .unwrap();
        assert_eq!(
            uploads.finish(&second).unwrap().attachment.unwrap().name,
            "资料 (1).txt"
        );
        drop(uploads);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publication_before_receipt_commit_recovers_same_file() {
        let root = std::env::temp_dir().join(format!("reach-upload-recovery-{}", Uuid::new_v4()));
        let uploads = Uploads::open(&root).unwrap();
        let id = Uuid::new_v4().to_string();
        uploads
            .start(Start {
                id: id.clone(),
                name: "same.bin".into(),
                size: 4,
            })
            .unwrap();
        uploads.write(&id, chunk(b"data", 0, true)).unwrap();
        let target = files::date_directory(&root).join("same.bin");
        uploads
            .database
            .lock()
            .unwrap()
            .execute(
                "UPDATE uploads SET target=? WHERE id=?",
                params![files::display_path(&target).unwrap(), id],
            )
            .unwrap();
        fs::hard_link(uploads.partial(&id), &target).unwrap();
        drop(uploads);
        let uploads = Uploads::open(&root).unwrap();
        assert_eq!(
            uploads.finish(&id).unwrap().attachment.unwrap().name,
            "same.bin"
        );
        assert_eq!(
            fs::read_dir(files::date_directory(&root)).unwrap().count(),
            1
        );
        drop(uploads);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bounds_apply_to_chunks_and_checksum_protects_original_bytes() {
        let root = std::env::temp_dir().join(format!("reach-upload-bounds-{}", Uuid::new_v4()));
        let uploads = Uploads::open(&root).unwrap();
        let id = Uuid::new_v4().to_string();
        let size = 21 * 1024 * 1024;
        uploads
            .start(Start {
                id: id.clone(),
                name: "large.bin".into(),
                size,
            })
            .unwrap();
        let bytes = vec![0x71; CHUNK_BYTES];
        let mut wrong = chunk(&bytes, 0, true);
        wrong.sha256 = "wrong".into();
        assert!(uploads.write(&id, wrong).is_err());
        assert!(
            uploads
                .write(&id, chunk(&vec![0; CHUNK_BYTES + 1], 0, true))
                .is_err()
        );
        for offset in (0..size).step_by(CHUNK_BYTES) {
            uploads.write(&id, chunk(&bytes, offset, true)).unwrap();
        }
        let file = uploads.finish(&id).unwrap().attachment.unwrap();
        assert_eq!(fs::metadata(file.path).unwrap().len(), size);
        drop(uploads);
        fs::remove_dir_all(root).unwrap();
    }
}
