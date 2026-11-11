use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;

pub const MAX_FILE_BYTES: usize = 20 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct FileAttachment {
    pub path: String,
    pub name: String,
    pub directory: bool,
    pub image: bool,
}

#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub directory: bool,
    pub size: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct DirectoryListing {
    pub path: Option<String>,
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
}

pub struct Preview {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetLogicalDrives() -> u32;
}

pub fn browse(path: Option<&str>) -> Result<DirectoryListing> {
    let Some(path) = path.filter(|path| !path.is_empty()) else {
        // The mask includes assigned drives even when removable media is absent.
        let drives = unsafe { GetLogicalDrives() };
        ensure!(drives != 0, "无法读取本机磁盘列表");
        let entries = (0..26)
            .filter(|index| drives & (1 << index) != 0)
            .map(|index| {
                let path = format!("{}:/", char::from(b'A' + index));
                FileEntry {
                    name: path.clone(),
                    path,
                    directory: true,
                    size: None,
                }
            })
            .collect();
        return Ok(DirectoryListing {
            path: None,
            parent: None,
            entries,
        });
    };
    let path = absolute_path(path)?;
    ensure!(path.is_dir(), "所选路径不是目录");
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path).context("无法读取目录")? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: display_path(&entry.path())?,
            directory: metadata.is_dir(),
            size: metadata.is_file().then_some(metadata.len()),
        });
    }
    entries.sort_by(|left, right| {
        right
            .directory
            .cmp(&left.directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(DirectoryListing {
        path: Some(display_path(&path)?),
        parent: path.parent().map(display_path).transpose()?,
        entries,
    })
}

pub fn resolve(paths: &[String]) -> Result<Vec<FileAttachment>> {
    paths
        .iter()
        .map(|path| {
            let path = absolute_path(path)?;
            let metadata = fs::metadata(&path).context("所选文件或目录已不可用")?;
            ensure!(metadata.is_dir() || metadata.is_file(), "仅支持文件或目录");
            let display = display_path(&path)?;
            Ok(FileAttachment {
                name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(&display)
                    .to_owned(),
                image: metadata.is_file() && is_image_path(&path),
                path: display,
                directory: metadata.is_dir(),
            })
        })
        .collect()
}

pub fn upload(root: &Path, name: &str, bytes: &[u8]) -> Result<FileAttachment> {
    let name_path = Path::new(name);
    ensure!(
        !name.is_empty()
            && !name.contains(['/', '\\', ':', '\r', '\n'])
            && matches!(name_path.components().next(), Some(Component::Normal(_)))
            && name_path.components().count() == 1,
        "上传文件名无效"
    );
    ensure!(bytes.len() <= MAX_FILE_BYTES, "上传文件不能超过 20 MiB");
    ensure!(root.is_absolute(), "上传目录必须使用绝对路径");
    fs::create_dir_all(root).context("无法创建上传目录")?;
    let directory = root.join(Uuid::new_v4().to_string());
    fs::create_dir(&directory)?;
    let path = directory.join(name);
    let result = (|| -> Result<FileAttachment> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(FileAttachment {
            path: display_path(&path)?,
            name: name.to_owned(),
            directory: false,
            image: is_image_path(&path),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(&directory);
    }
    result
}

pub fn preview(path: &str) -> Result<Preview> {
    let path = absolute_path(path)?;
    let file = File::open(path).context("图片文件不可用")?;
    let metadata = file.metadata()?;
    ensure!(metadata.is_file(), "预览路径必须是文件");
    ensure!(
        metadata.len() <= MAX_FILE_BYTES as u64,
        "预览图片不能超过 20 MiB"
    );
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= MAX_FILE_BYTES, "预览图片不能超过 20 MiB");
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        bail!("仅支持 PNG、JPEG、GIF、WebP 图片预览");
    };
    Ok(Preview { mime, bytes })
}

pub fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp"
            )
        })
}

fn absolute_path(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    ensure!(path.is_absolute(), "文件路径必须是绝对路径");
    Ok(std::path::absolute(path)?)
}

fn display_path(path: &Path) -> Result<String> {
    let path = path.to_str().context("文件路径无法转换为 UTF-8")?;
    if let Some(path) = path.strip_prefix(r"\\?\UNC\") {
        return Ok(format!("//{}", path.replace('\\', "/")));
    }
    Ok(path
        .strip_prefix(r"\\?\")
        .unwrap_or(path)
        .replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_keeps_filename_isolates_duplicates_and_browses_directory() {
        let root = std::env::temp_dir().join(format!("codex-reach-files-{}", Uuid::new_v4()));
        let first = upload(&root, "资料.txt", b"first").unwrap();
        let second = upload(&root, "资料.txt", b"second").unwrap();
        assert_eq!(first.name, "资料.txt");
        assert_ne!(first.path, second.path);
        assert_eq!(fs::read(&first.path).unwrap(), b"first");
        let listing = browse(Some(root.to_str().unwrap())).unwrap();
        assert_eq!(listing.entries.len(), 2);
        assert!(listing.entries.iter().all(|entry| entry.directory));
        assert!(upload(&root, "../outside.txt", b"data").is_err());
        assert!(resolve(&["relative.txt".to_owned()]).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preview_checks_bitmap_bytes_and_enforces_limit() {
        let root = std::env::temp_dir().join(format!("codex-reach-preview-{}", Uuid::new_v4()));
        let image = upload(&root, "sample.png", b"\x89PNG\r\n\x1a\n").unwrap();
        assert_eq!(preview(&image.path).unwrap().mime, "image/png");
        let fake = upload(&root, "fake.png", b"<svg></svg>").unwrap();
        assert!(preview(&fake.path).is_err());
        File::create(&fake.path)
            .unwrap()
            .set_len(MAX_FILE_BYTES as u64 + 1)
            .unwrap();
        assert!(preview(&fake.path).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
