//! 读不了一份文件的原因（spec 2026-10-04-local-diagnostics R11）：分成没权限、格式有误、别的三种，
//! 界面据此给出往前走的路（修复权限 / 打开文件 / 再试一次）。原因写给人看，原文（已去隐私）进 `详情`。
use serde::Serialize;
use std::io;
use std::path::{Path, PathBuf};

/// 读不了的种类
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileIssueKind {
    /// 没有读取权限（多半是文件不归当前账户所有：用 sudo 运行过 Codex / Sophia）
    Permission,
    /// 内容不是合法的 JSON / TOML
    Format,
    /// 别的（IO 错误……）
    Other,
}

/// 一份读不了的文件
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIssue {
    pub kind: FileIssueKind,
    /// 完整路径：`修复权限`、`打开文件` 按它做（后端再核对一遍是不是 Sophia 管的文件）
    pub path: PathBuf,
    /// 格式有误时出错的那一行（从 1 数）；不知道为 None
    pub line: Option<usize>,
    /// 给人看的一句（当前语言）：`~/.codex/config.toml 不归你的账户所有，读不了（多半是用 sudo 运行过 Codex）`
    pub reason: String,
    /// 技术原文（已去隐私）
    pub detail: String,
}

/// 文件在界面上的写法：主目录写成 `~`（与日志同一套去隐私）
fn shown(path: &Path) -> String {
    crate::redact::redact(&path.display().to_string())
}

impl FileIssue {
    /// 读文件（或读成 JSON）失败。`my_uid`：当前账户（据它说「不归你的账户所有」）；
    /// `codex`：这是 Codex 的设置文件（没权限时多半是用 sudo 运行过 Codex，句子里说出来）
    pub fn from_io(path: &Path, error: &io::Error, my_uid: Option<u32>, codex: bool) -> Self {
        let file = shown(path);
        let detail = crate::redact::redact(&format!("open {}\n{error}", path.display()));
        if error.kind() == io::ErrorKind::PermissionDenied {
            let reason = if owned_by_someone_else(path, my_uid) {
                if codex {
                    crate::t!("models.unreadable.notOwnedCodex", file = file)
                } else {
                    crate::t!("models.unreadable.notOwned", file = file)
                }
            } else {
                crate::t!("models.unreadable.noRead", file = file)
            };
            return Self {
                kind: FileIssueKind::Permission,
                path: path.to_path_buf(),
                line: None,
                reason,
                detail,
            };
        }
        let json_line = error
            .get_ref()
            .and_then(|inner| inner.downcast_ref::<serde_json::Error>())
            .map(serde_json::Error::line);
        if error.kind() == io::ErrorKind::InvalidData && json_line.is_some() {
            return Self::format(path, json_line, &error.to_string());
        }
        Self {
            kind: FileIssueKind::Other,
            path: path.to_path_buf(),
            line: None,
            reason: crate::t!("models.unreadable.other", file = file),
            detail,
        }
    }

    /// 内容格式有误（JSON / TOML）；`line` 从 1 数
    pub fn format(path: &Path, line: Option<usize>, error: &str) -> Self {
        let file = shown(path);
        let reason = match line {
            Some(line) => crate::t!("models.unreadable.format", file = file, line = line),
            None => crate::t!("models.unreadable.formatNoLine", file = file),
        };
        Self {
            kind: FileIssueKind::Format,
            path: path.to_path_buf(),
            line,
            reason,
            detail: crate::redact::redact(&format!("{}\n{error}", path.display())),
        }
    }
}

/// 文件的属主不是当前账户。读不到属主（父目录也进不去）时按「不是」算——说「没有读取权限」不会错
fn owned_by_someone_else(path: &Path, my_uid: Option<u32>) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (std::fs::metadata(path), my_uid) {
            (Ok(meta), Some(me)) => meta.uid() != me,
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (path, my_uid);
        false
    }
}

/// 当前账户：主目录的属主（core 不依赖 libc；同 `Sophia gateway` 装服务时的取法）
pub fn current_uid() -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        dirs::home_dir()
            .and_then(|home| std::fs::metadata(home).ok())
            .map(|meta| meta.uid())
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// `修复权限`、`打开文件` 能动的文件（spec 2026-10-04-local-diagnostics R11）：**逐字**等于 `files` 里的某一个，
/// 或是直接放在 `json_dir`（逐字）里的 `*.json`。白名单本身不解析（不 canonicalize）——解析就会跟随它上面的软链。
/// 另要求：绝对路径、不带 `.` / `..`；**从根到文件的每一级都不是软链**（`entry_kind`，lstat，不跟随）；是普通文件。
/// 交回的就是这个字面路径；管理员授权的命令里还会再核对一遍（`cd -P` 后比对真实文件夹、`chown -h`）
pub fn managed_path(path: &Path, files: &[&Path], json_dir: &Path) -> Option<PathBuf> {
    use crate::fs::{entry_kind, EntryKind};
    use std::path::Component;
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return None;
    }
    let listed = files.contains(&path);
    let in_dir =
        path.parent() == Some(json_dir) && path.extension().is_some_and(|ext| ext == "json");
    if !(listed || in_dir) {
        return None;
    }
    let mut current = PathBuf::new();
    for part in path.components() {
        current.push(part);
        if matches!(entry_kind(&current), EntryKind::Symlink(_)) {
            return None;
        }
    }
    (entry_kind(path) == EntryKind::File).then(|| path.to_path_buf())
}

/// 字节偏移 → 第几行（从 1 数）
pub fn line_at(text: &str, offset: usize) -> usize {
    let end = offset.min(text.len());
    text.as_bytes()[..end]
        .iter()
        .filter(|b| **b == b'\n')
        .count()
        + 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;

    /// 修复权限（管理员授权）与打开文件只认白名单里那几个**字面**路径（Codex 复审第 2 轮 1）：
    /// 请求必须逐字等于白名单里的某一个，且从根到文件的每一级都不是软链；白名单本身不解析（不 canonicalize）——
    /// 否则把 `~/.codex/config.toml` 链到外面，再直接请求外面那个文件就能过
    #[cfg(unix)]
    #[test]
    fn managed_path_is_a_literal_allowlist_without_links() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let codex = tree.dir("home/.codex");
        let config = tree.file(&codex, "config.toml");
        let data = tree.dir("data");
        let settings = tree.file(&data, "settings.json");
        let outside = tree.file(&tree.dir("etc"), "sudoers");
        let allowed = |p: &Path, cfg: &Path| managed_path(p, &[cfg], &data);

        assert_eq!(allowed(&config, &config), Some(config.clone()));
        assert_eq!(allowed(&settings, &config), Some(settings.clone()));
        // 不在白名单里的一律不认（白名单不解析：不论它链到哪）
        assert_eq!(allowed(&outside, &config), None);
        // 数据目录里的软链（指到外面、指回里面）都不认
        tree.link(&data.join("x.json"), &outside);
        assert_eq!(allowed(&data.join("x.json"), &config), None);
        tree.link(&data.join("y.json"), &settings);
        assert_eq!(allowed(&data.join("y.json"), &config), None);
        // 父目录是软链
        let alias = tree.root().join("alias");
        tree.link(&alias, &data);
        assert_eq!(allowed(&alias.join("settings.json"), &config), None);
        // `..`、相对路径、不是 json、子目录里的 json、不存在、目录、大小写不同
        assert_eq!(
            allowed(&data.join("..").join("data").join("settings.json"), &config),
            None
        );
        assert_eq!(allowed(Path::new("data/settings.json"), &config), None);
        assert_eq!(allowed(&tree.file(&data, "notes.txt"), &config), None);
        assert_eq!(
            allowed(&tree.file(&tree.dir("data/backups"), "a.json"), &config),
            None
        );
        assert_eq!(allowed(&data.join("missing.json"), &config), None);
        assert_eq!(allowed(&tree.dir("data/dir.json"), &config), None);
        // 数据目录里大小写不同的 json：不分大小写的卷上就是同一份 Sophia 文件（认了也只动它），分的卷上不存在
        if let Some(p) = allowed(&data.join("SETTINGS.json"), &config) {
            assert_eq!(crate::fs::real_path(&p), crate::fs::real_path(&settings));
        }
        assert_eq!(allowed(&codex.join("CONFIG.toml"), &config), None);

        // `~/.codex/config.toml` 本身被链到外面：请求外面那个、请求它本身都不认
        let linked_home = tree.dir("home2/.codex");
        let linked_cfg = linked_home.join("config.toml");
        tree.link(&linked_cfg, &outside);
        assert_eq!(allowed(&outside, &linked_cfg), None);
        assert_eq!(allowed(&linked_cfg, &linked_cfg), None);
        // `~/.codex` 是软链
        let home3 = tree.dir("home3");
        tree.link(&home3.join(".codex"), &codex);
        let via = home3.join(".codex").join("config.toml");
        assert_eq!(allowed(&via, &via), None);
        let _ = home;
    }

    #[cfg(unix)]
    fn chmod(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /// 没权限：属主是别人时说「不归你的账户所有」（Codex 的设置文件多说一句 sudo），是自己的说「没有读取权限」
    #[cfg(unix)]
    #[test]
    fn permission_denied_names_the_file_and_who_owns_it() {
        use std::os::unix::fs::MetadataExt;
        let tree = TempTree::new();
        let dir = tree.dir("codex");
        let path = tree.file(&dir, "config.toml");
        chmod(&path, 0o000);
        let error = match std::fs::read(&path) {
            Ok(_) => {
                // 以 root 运行时权限不拦：造一个同样的错误
                io::Error::from(io::ErrorKind::PermissionDenied)
            }
            Err(error) => error,
        };
        let mine = std::fs::metadata(&path).unwrap().uid();
        let own = FileIssue::from_io(&path, &error, Some(mine), true);
        assert_eq!(own.kind, FileIssueKind::Permission);
        let file = path.display().to_string();
        assert_eq!(own.reason, format!("{file} 没有读取权限，读不了"));
        let other = FileIssue::from_io(&path, &error, Some(mine + 1), true);
        assert_eq!(
            other.reason,
            format!("{file} 不归你的账户所有，读不了（多半是用 sudo 运行过 Codex）")
        );
        let sophia = FileIssue::from_io(&path, &error, Some(mine + 1), false);
        assert_eq!(sophia.reason, format!("{file} 不归你的账户所有，读不了"));
        assert!(own.detail.starts_with("open "), "{}", own.detail);
        chmod(&path, 0o644);
    }

    /// JSON 读坏了：格式有误，带行号
    #[test]
    fn broken_json_is_a_format_issue_with_the_line() {
        let text = "{\n  \"a\": 1,\n  oops\n}";
        let parse = serde_json::from_str::<serde_json::Value>(text).unwrap_err();
        let error = io::Error::new(io::ErrorKind::InvalidData, parse);
        let path = Path::new("/tmp/settings.json");
        let issue = FileIssue::from_io(path, &error, None, false);
        assert_eq!(issue.kind, FileIssueKind::Format);
        assert_eq!(issue.line, Some(3));
        assert_eq!(issue.reason, "/tmp/settings.json 第 3 行格式有误");
        let json = serde_json::to_value(&issue).unwrap();
        assert_eq!(json["kind"], "format");
        assert_eq!(json["line"], 3);
    }

    #[test]
    fn other_errors_and_lines() {
        let error = io::Error::other("disk on fire");
        let issue = FileIssue::from_io(Path::new("/tmp/a.json"), &error, None, false);
        assert_eq!(issue.kind, FileIssueKind::Other);
        assert_eq!(issue.reason, "/tmp/a.json 读不了");
        assert!(issue.detail.contains("disk on fire"));
        assert_eq!(line_at("a\nb\nc", 0), 1);
        assert_eq!(line_at("a\nb\nc", 2), 2);
        assert_eq!(line_at("a\nb\nc", 99), 3);
        assert_eq!(
            FileIssue::format(Path::new("/tmp/c.toml"), None, "x").reason,
            "/tmp/c.toml 格式有误"
        );
    }
}
