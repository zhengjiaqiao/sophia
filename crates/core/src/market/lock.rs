//! 只读 `~/.agents/.skill-lock.json`（R13，T2 负责）：`npx skills` 装的 skill 也能查更新。
//! 只认版本 3、`sourceType` 为 `github` 的条目；读不懂（版本不对、字段不对、文件坏了）就当没有，不报错。
//! Sophia 从不写这个文件。
//! 条目的 `ref`（装时指定的分支或 tag，`npx skills` 按它做「认 ref 的更新」）决定查更新对着哪一处比，见 `UpdateRef`。
use serde_json::Value;
use std::path::{Path, PathBuf};

/// lock 里一个可查更新的 skill
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockEntry {
    /// skill 名（lock 的 key），也是 `~/.agents/skills/<name>` 的文件夹名
    pub name: String,
    /// `source`：`owner/repo`
    pub repo: String,
    /// 由 `skillPath`（指向 `SKILL.md`）取出的文件夹路径，不带首尾 `/`；仓库根为空串
    pub path: String,
    /// `skillFolderHash`：git tree SHA
    pub folder_hash: String,
    /// `ref`：装时指定的分支、tag 或 commit（去掉首尾空白；没写或空串为 None）
    pub git_ref: Option<String>,
}

/// 一条 lock 查更新时对着哪一处比
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateRef {
    /// 没写 `ref`（或写的是 `HEAD`）：仓库的默认分支
    DefaultBranch,
    /// 分支或 tag：对着这个 ref 自己的 tree 比（GitHub trees 接口两样都认）。
    /// 本地不联网分不清分支和 tag，也不必分：tag 的 tree 不动，自然算不出更新；
    /// 分支往前走了才算。与 `npx skills update` 按 `ref` 取 tree 的做法一致
    Ref(String),
    /// 不查更新：40 位十六进制（commit SHA，`npx skills` 也按这个形状认），
    /// 或带了拼进网址会出岔子的字符——宁可不查，也不拿默认分支去比
    Pinned,
}

impl LockEntry {
    pub fn update_ref(&self) -> UpdateRef {
        match self.git_ref.as_deref() {
            None | Some("HEAD") => UpdateRef::DefaultBranch,
            Some(r) if r.len() == 40 && r.bytes().all(|b| b.is_ascii_hexdigit()) => {
                UpdateRef::Pinned
            }
            Some(r) if is_plain_ref(r) => UpdateRef::Ref(r.to_string()),
            Some(_) => UpdateRef::Pinned,
        }
    }
}

/// 能原样拼进 GitHub 网址的 ref：只含字母数字与 `._-/`，各段非空、不是 `.` / `..`
fn is_plain_ref(r: &str) -> bool {
    r.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'))
        && r.split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

/// lock 文件的位置，同 `npx skills` 的 `getSkillLockPath`：设了 `$XDG_STATE_HOME`（非空）时是
/// `$XDG_STATE_HOME/skills/.skill-lock.json`，否则 `<home>/.agents/.skill-lock.json`。
/// `xdg_state_home` 由调用方从环境变量取（`Env::vars`），这里不读进程环境
pub fn lock_path(home: &Path, xdg_state_home: Option<&str>) -> PathBuf {
    match xdg_state_home.filter(|dir| !dir.is_empty()) {
        Some(dir) => Path::new(dir).join("skills").join(".skill-lock.json"),
        None => home.join(".agents").join(".skill-lock.json"),
    }
}

/// `npx skills` 现行的 lock 版本；它升版本时会整体清空旧记录，我们也只认这一版
const SUPPORTED_VERSION: u64 = 3;

/// 读 lock；文件不存在或读不懂都返回空。按 skill 名排序。
/// 单条不合格（不是 github、缺字段、`skillFolderHash` 不是 40 位十六进制、名字不能当文件夹名）
/// 只跳过那一条：`skillFolderHash` 在 `npx skills` 的克隆兜底路径里会是别的哈希，比不了
pub fn read(path: &Path) -> Vec<LockEntry> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(root) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    if root.get("version").and_then(Value::as_u64) != Some(SUPPORTED_VERSION) {
        return Vec::new();
    }
    let Some(skills) = root.get("skills").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut entries: Vec<LockEntry> = skills
        .iter()
        .filter_map(|(name, entry)| parse_entry(name, entry))
        .collect();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}

fn parse_entry(name: &str, entry: &Value) -> Option<LockEntry> {
    let field = |key: &str| entry.get(key).and_then(Value::as_str);
    if field("sourceType")? != "github" || !is_folder_name(name) {
        return None;
    }
    let repo = field("source")?.trim();
    let (owner, repo_name) = repo.split_once('/')?;
    if !is_folder_name(owner) || !is_folder_name(repo_name) {
        return None;
    }
    let folder_hash = field("skillFolderHash")?;
    if folder_hash.len() != 40 || !folder_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(LockEntry {
        name: name.to_string(),
        repo: repo.to_string(),
        path: folder_of(field("skillPath")?)?,
        folder_hash: folder_hash.to_ascii_lowercase(),
        git_ref: field("ref")
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .map(str::to_string),
    })
}

/// `skillPath` 指向 `SKILL.md`（也可能直接是文件夹）→ 文件夹路径，不带首尾 `/`；仓库根为空串。
/// 带 `..` / `.` 段的不认
fn folder_of(skill_path: &str) -> Option<String> {
    let trimmed = skill_path.trim().trim_matches('/');
    let folder = if trimmed == "SKILL.md" {
        ""
    } else {
        trimmed.strip_suffix("/SKILL.md").unwrap_or(trimmed)
    };
    let folder = folder.trim_end_matches('/');
    if folder.split('/').any(|seg| seg == ".." || seg == ".") || folder.contains("//") {
        return None;
    }
    Some(folder.to_string())
}

/// 能当一段文件夹名：非空、不是 `.` / `..`、不含路径分隔符
fn is_folder_name(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && !s.contains(['/', '\\'])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;

    /// 照本机真实 lock 的形状造的（版本 3，字段取自 vercel-labs/skills 的 `SkillLockEntry`）
    const V3: &str = r#"{
  "version": 3,
  "skills": {
    "darwin-skill": {
      "source": "alchaincyf/darwin-skill",
      "sourceType": "github",
      "sourceUrl": "https://github.com/alchaincyf/darwin-skill.git",
      "skillPath": "SKILL.md",
      "skillFolderHash": "5539516444cff4eed7865daf61a707590acda485",
      "installedAt": "2026-04-14T16:17:13.922Z",
      "updatedAt": "2026-08-31T05:53:56.710Z"
    },
    "xlsx": {
      "source": "anthropics/skills",
      "sourceType": "github",
      "sourceUrl": "https://github.com/anthropics/skills.git",
      "skillPath": "skills/xlsx/SKILL.md",
      "skillFolderHash": "FE6471CC9B5B97AAE0B576CCB92FFD9B0207589D",
      "installedAt": "2026-04-15T13:23:03.265Z",
      "updatedAt": "2026-07-17T08:37:29.665Z"
    },
    "find-skills": {
      "source": "vercel-labs/skills",
      "sourceType": "github",
      "sourceUrl": "https://github.com/vercel-labs/skills.git",
      "ref": "main",
      "skillPath": "skills/find-skills/",
      "skillFolderHash": "76a98a285cb0434f3d39e1a873823556330e398b",
      "installedAt": "2026-04-14T16:17:28.497Z",
      "updatedAt": "2026-07-17T08:37:18.162Z"
    },
    "pinned-tag": {
      "source": "someone/pinned",
      "sourceType": "github",
      "sourceUrl": "https://github.com/someone/pinned.git",
      "ref": " v1.0 ",
      "skillPath": "SKILL.md",
      "skillFolderHash": "5539516444cff4eed7865daf61a707590acda485"
    },
    "empty-ref": {
      "source": "someone/empty-ref",
      "sourceType": "github",
      "ref": "",
      "skillPath": "SKILL.md",
      "skillFolderHash": "5539516444cff4eed7865daf61a707590acda485"
    },
    "bun": {
      "source": "mintlify/bun.com",
      "sourceType": "mintlify",
      "sourceUrl": "https://bun.com/docs/skill.md",
      "skillFolderHash": "5539516444cff4eed7865daf61a707590acda485",
      "installedAt": "2026-04-14T16:17:13.922Z",
      "updatedAt": "2026-04-14T16:17:13.922Z"
    },
    "cloned": {
      "source": "someone/cloned",
      "sourceType": "github",
      "sourceUrl": "https://github.com/someone/cloned.git",
      "skillPath": "SKILL.md",
      "skillFolderHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "installedAt": "2026-04-14T16:17:13.922Z",
      "updatedAt": "2026-04-14T16:17:13.922Z"
    },
    "no-path": {
      "source": "someone/no-path",
      "sourceType": "github",
      "skillFolderHash": "5539516444cff4eed7865daf61a707590acda485"
    },
    "../escape": {
      "source": "someone/escape",
      "sourceType": "github",
      "skillPath": "SKILL.md",
      "skillFolderHash": "5539516444cff4eed7865daf61a707590acda485"
    },
    "dotdot": {
      "source": "someone/dotdot",
      "sourceType": "github",
      "skillPath": "../SKILL.md",
      "skillFolderHash": "5539516444cff4eed7865daf61a707590acda485"
    },
    "bad-source": {
      "source": "not-a-repo",
      "sourceType": "github",
      "skillPath": "SKILL.md",
      "skillFolderHash": "5539516444cff4eed7865daf61a707590acda485"
    }
  },
  "dismissed": { "findSkillsPrompt": true },
  "lastSelectedAgents": ["claude-code", "codex"]
}"#;

    fn write(t: &TempTree, text: &str) -> std::path::PathBuf {
        let home = t.root();
        let path = lock_path(&home, None);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        path
    }

    #[test]
    fn reads_github_entries_of_v3() {
        let t = TempTree::new();
        let entries = read(&write(&t, V3));
        let entry = |name: &str, repo: &str, path: &str, hash: &str| LockEntry {
            name: name.into(),
            repo: repo.into(),
            path: path.into(),
            folder_hash: hash.into(),
            git_ref: None,
        };
        let with_ref = |e: LockEntry, r: &str| LockEntry {
            git_ref: Some(r.into()),
            ..e
        };
        assert_eq!(
            entries,
            vec![
                entry(
                    "darwin-skill",
                    "alchaincyf/darwin-skill",
                    "",
                    "5539516444cff4eed7865daf61a707590acda485"
                ),
                entry(
                    "empty-ref",
                    "someone/empty-ref",
                    "",
                    "5539516444cff4eed7865daf61a707590acda485"
                ),
                with_ref(
                    entry(
                        "find-skills",
                        "vercel-labs/skills",
                        "skills/find-skills",
                        "76a98a285cb0434f3d39e1a873823556330e398b"
                    ),
                    "main"
                ),
                with_ref(
                    entry(
                        "pinned-tag",
                        "someone/pinned",
                        "",
                        "5539516444cff4eed7865daf61a707590acda485"
                    ),
                    "v1.0"
                ),
                entry(
                    "xlsx",
                    "anthropics/skills",
                    "skills/xlsx",
                    "fe6471cc9b5b97aae0b576ccb92ffd9b0207589d"
                ),
            ]
        );
    }

    /// `ref` 怎么用于查更新：没写、空、`HEAD` 跟默认分支；40 位十六进制是 commit，钉死；
    /// 其余（分支或 tag）对着那个 ref 自己的 tree 比；带 URL 里有特殊含义的字符、`..` 的不认，当钉死
    #[test]
    fn update_ref_follows_lock_ref() {
        let with = |r: Option<&str>| LockEntry {
            name: "x".into(),
            repo: "o/r".into(),
            path: String::new(),
            folder_hash: "5539516444cff4eed7865daf61a707590acda485".into(),
            git_ref: r.map(Into::into),
        };
        assert_eq!(with(None).update_ref(), UpdateRef::DefaultBranch);
        assert_eq!(with(Some("HEAD")).update_ref(), UpdateRef::DefaultBranch);
        assert_eq!(with(Some("dev")).update_ref(), UpdateRef::Ref("dev".into()));
        assert_eq!(
            with(Some("v1.0")).update_ref(),
            UpdateRef::Ref("v1.0".into())
        );
        assert_eq!(
            with(Some("release/2.x")).update_ref(),
            UpdateRef::Ref("release/2.x".into())
        );
        for pinned in [
            "5539516444cff4eed7865daf61a707590acda485",
            "5539516444CFF4EED7865DAF61A707590ACDA485",
            "../main",
            "a b",
            "main?x=1",
            "main#frag",
            "/main",
            "main/",
            "a//b",
        ] {
            assert_eq!(
                with(Some(pinned)).update_ref(),
                UpdateRef::Pinned,
                "{pinned}"
            );
        }
    }

    #[test]
    fn other_versions_are_empty() {
        let t = TempTree::new();
        let v2 = V3.replacen("\"version\": 3", "\"version\": 2", 1);
        assert!(read(&write(&t, &v2)).is_empty());
        let v4 = V3.replacen("\"version\": 3", "\"version\": 4", 1);
        assert!(read(&write(&t, &v4)).is_empty());
        let text = V3.replacen("\"version\": 3", "\"version\": \"3\"", 1);
        assert!(read(&write(&t, &text)).is_empty());
        let missing = V3.replacen("\"version\": 3,", "", 1);
        assert!(read(&write(&t, &missing)).is_empty());
    }

    #[test]
    fn unreadable_files_are_empty() {
        let t = TempTree::new();
        // 文件不存在
        assert!(read(&lock_path(&t.root(), None)).is_empty());
        for garbage in [
            "",
            "not json {",
            "[]",
            "null",
            r#"{"version": 3}"#,
            r#"{"version": 3, "skills": []}"#,
            r#"{"version": 3, "skills": {"x": "string"}}"#,
        ] {
            assert!(read(&write(&t, garbage)).is_empty(), "{garbage}");
        }
        // 不是 UTF-8
        let path = lock_path(&t.root(), None);
        std::fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        assert!(read(&path).is_empty());
        // 路径是个目录
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(read(&path).is_empty());
    }

    #[test]
    fn lock_path_is_under_agents() {
        assert_eq!(
            lock_path(Path::new("/h"), None),
            Path::new("/h/.agents/.skill-lock.json")
        );
        // 空的 XDG_STATE_HOME 当没设（`npx skills` 同样按假值处理）
        assert_eq!(
            lock_path(Path::new("/h"), Some("")),
            Path::new("/h/.agents/.skill-lock.json")
        );
    }

    #[test]
    fn lock_path_honours_xdg_state_home() {
        assert_eq!(
            lock_path(Path::new("/h"), Some("/state")),
            Path::new("/state/skills/.skill-lock.json")
        );
    }
}
