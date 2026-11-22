use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

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

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetLogicalDrives() -> u32;
    fn GetLocalTime(time: *mut [u16; 8]);
}

pub fn date_directory(root: &Path) -> PathBuf {
    let mut time = [0_u16; 8];
    unsafe { GetLocalTime(&mut time) };
    root.join(format!("{:04}-{:02}-{:02}", time[0], time[1], time[3]))
}

pub fn validate_name(name: &str) -> Result<()> {
    let path = Path::new(name);
    ensure!(
        !name.is_empty()
            && !name.contains(['/', '\\', ':', '\r', '\n'])
            && matches!(path.components().next(), Some(Component::Normal(_)))
            && path.components().count() == 1,
        "上传文件名无效"
    );
    Ok(())
}

pub fn numbered_path(directory: &Path, name: &str, index: usize) -> PathBuf {
    if index == 0 {
        return directory.join(name);
    }
    let path = Path::new(name);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let extension = path
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    directory.join(format!("{stem} ({index}){extension}"))
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

pub fn absolute_path(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    ensure!(path.is_absolute(), "文件路径必须是绝对路径");
    Ok(std::path::absolute(path)?)
}

pub fn display_path(path: &Path) -> Result<String> {
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
    use uuid::Uuid;

    #[test]
    fn browses_directory_and_resolves_existing_files() {
        let root = std::env::temp_dir().join(format!("codex-reach-files-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("资料.txt");
        fs::write(&path, b"first").unwrap();
        let listing = browse(Some(root.to_str().unwrap())).unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].name, "资料.txt");
        assert_eq!(
            resolve(&[display_path(&path).unwrap()]).unwrap()[0].name,
            "资料.txt"
        );
        assert!(resolve(&["relative.txt".to_owned()]).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
