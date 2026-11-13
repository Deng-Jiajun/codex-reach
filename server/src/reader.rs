use crate::files;
use anyhow::{Context, Result, ensure};
use axum::{
    extract::Request,
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use flate2::{Compression, write::GzEncoder};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Write},
    path::{Component, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tower_http::services::ServeFile;
use uuid::Uuid;

#[derive(Deserialize)]
pub struct Open {
    pub path: String,
    pub root: Option<String>,
}

#[derive(Serialize)]
pub struct Document {
    pub name: String,
    pub size: u64,
    pub kind: &'static str,
    pub prefix: String,
    pub relative: String,
}

struct Grant {
    root: PathBuf,
    expires: Instant,
}
#[derive(Default)]
pub struct Reader(Mutex<HashMap<String, Grant>>);
#[derive(Clone)]
pub struct Compressible(pub bool);

impl Reader {
    pub fn open(&self, input: Open) -> Result<Document> {
        let path = files::absolute_path(&input.path)?
            .canonicalize()
            .context("文件不存在或无法读取")?;
        let metadata = path.metadata()?;
        ensure!(metadata.is_file(), "请选择文件进行阅读");
        let mut root = path.parent().context("文件缺少上层目录")?.to_owned();
        if let Some(candidate) = input
            .root
            .and_then(|value| PathBuf::from(value).canonicalize().ok())
            && candidate.is_dir()
            && path.starts_with(&candidate)
        {
            root = candidate;
        }
        let relative = path
            .strip_prefix(&root)?
            .to_string_lossy()
            .replace('\\', "/");
        let extension = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase();
        let kind = match extension.as_str() {
            "html" | "htm" => "html",
            "md" | "markdown" => "markdown",
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" => "image",
            "pdf" => "pdf",
            "txt" | "log" | "json" | "jsonl" | "yaml" | "yml" | "toml" | "ini" | "conf" | "cfg"
            | "c" | "h" | "cpp" | "hpp" | "cc" | "cs" | "rs" | "py" | "js" | "mjs" | "ts"
            | "tsx" | "jsx" | "java" | "kt" | "xml" | "css" | "scss" | "sh" | "ps1" | "bat"
            | "sql" | "csv" | "" => "text",
            _ => "download",
        };
        let id = Uuid::new_v4().to_string();
        let mut grants = self.0.lock().unwrap();
        grants.retain(|_, grant| grant.expires > Instant::now());
        grants.insert(
            id.clone(),
            Grant {
                root,
                expires: Instant::now() + Duration::from_secs(2 * 60 * 60),
            },
        );
        Ok(Document {
            name: path.file_name().unwrap().to_string_lossy().into_owned(),
            size: metadata.len(),
            kind,
            prefix: format!("/reader/{id}/"),
            relative,
        })
    }

    pub fn resolve(&self, id: &str, resource: &str) -> Result<PathBuf> {
        let grants = self.0.lock().unwrap();
        let grant = grants
            .get(id)
            .filter(|grant| grant.expires > Instant::now())
            .context("阅读授权已过期，请重新打开文件")?;
        let relative = PathBuf::from(resource);
        ensure!(
            !relative.is_absolute()
                && !resource.contains(['\\', ':'])
                && relative
                    .components()
                    .all(|part| matches!(part, Component::Normal(_) | Component::CurDir)),
            "资源路径无效"
        );
        let path = grant
            .root
            .join(relative)
            .canonicalize()
            .context("文件资源不存在")?;
        ensure!(
            path.starts_with(&grant.root) && path.is_file(),
            "资源超出本次阅读目录"
        );
        Ok(path)
    }
}

pub async fn serve(path: PathBuf, request: Request) -> Result<Response> {
    let download = request
        .uri()
        .query()
        .is_some_and(|query| query.split('&').any(|part| part == "download=1"));
    let filename = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .bytes()
        .map(|byte| format!("%{byte:02X}"))
        .collect::<String>();
    let sample_path = path.clone();
    let compressible = tokio::task::spawn_blocking(move || -> Result<bool> {
        let mut sample = Vec::new();
        File::open(sample_path)?
            .take(64 * 1024)
            .read_to_end(&mut sample)?;
        let mut gzip = GzEncoder::new(Vec::new(), Compression::fast());
        gzip.write_all(&sample)?;
        Ok(gzip.finish()?.len() + 32 < sample.len())
    })
    .await??;
    let mut response = ServeFile::new(path)
        .try_call(request)
        .await?
        .into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "sandbox allow-scripts allow-forms allow-downloads; frame-ancestors *",
        ),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    if download {
        headers.insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_str(&format!("attachment; filename*=UTF-8''{filename}"))?,
        );
    }
    response.extensions_mut().insert(Compressible(compressible));
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_serves_relative_assets_and_rejects_escape() {
        let root = std::env::temp_dir().join(format!("reach-reader-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("pages")).unwrap();
        std::fs::write(root.join("pages/index.html"), b"<img src='../image.png'>").unwrap();
        std::fs::write(root.join("image.png"), b"image").unwrap();
        let reader = Reader::default();
        let document = reader
            .open(Open {
                path: root.join("pages/index.html").to_string_lossy().into_owned(),
                root: Some(root.to_string_lossy().into_owned()),
            })
            .unwrap();
        let id = document
            .prefix
            .trim_matches('/')
            .strip_prefix("reader/")
            .unwrap();
        assert_eq!(document.relative, "pages/index.html");
        assert!(reader.resolve(id, "image.png").is_ok());
        assert!(reader.resolve(id, "../outside").is_err());
        assert!(reader.resolve(id, "C:/Windows/win.ini").is_err());
        assert!(reader.resolve("unknown", "image.png").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
