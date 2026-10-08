//! 第三方服务商密钥与 Claude 网关令牌：存在 `<数据目录>/secrets.json`，只有本人能读写。
//!
//! 格式（spec 2026-10-03-keys-in-file）：
//! `{"version":1,"providers":{"codex":{"<网关 id>":"<密钥>"},"claude":{…},"global":{…}},"claudeRouterToken":"<令牌>"}`
//!
//! `global` 是全局模型提供商（ADR 0003，#252）的密钥，按提供商 id 存一份；`codex` / `claude` 是旧版按 agent 存的网关。
//!
//! - 写入只走 `atomicfile` 的原子替换与写前写后核对，**不调 `backup()`**：备份目录里不能出现密钥（R7）。
//! - 新建即 0600（临时文件本来就是 0600，原子改名后不变）；已有文件权限比 0600 宽时先收紧再写，
//!   不留「新密钥落在 0644 文件里」的空窗（R2、R3）。
//! - 读失败分三种：读不出（权限等，附原因）、格式损坏、版本比本程序新（R4）。「没有」是 `Ok(None)`，不是错误。
//! - 损坏的文件只由界面进程另存为 `secrets.json.broken-<时间>`（[`KeyStore::repair_if_corrupt`]），
//!   后台路由只读、只报 [`KeyStoreError::Corrupt`]（R5）。
//!
//! 纯文件读写，无异步、无网络。
use crate::atomicfile::{self, FileState, ReadError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

/// 数据目录下的文件名
pub const FILE_NAME: &str = "secrets.json";
/// 本程序写的格式版本；读到更高的版本时只读不写
pub const VERSION: u64 = 1;
/// 两家的名字，也是 `providers` 下的键
pub const CODEX: &str = "codex";
pub const CLAUDE: &str = "claude";
/// 全局模型提供商那一份（`model_providers`）：`providers` 下的键，与两家并列
pub const GLOBAL: &str = "global";

/// 读写密钥文件的错误。`Display` 给当前语言的一句话，不含密钥
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyStoreError {
    /// 文件在，但读不出（没有读取权限、是软链、I/O 出错）；附原因
    Unreadable(String),
    /// 内容不是本程序认得的格式（截断、手改坏了）
    Corrupt,
    /// 更新版本的 Sophia 写的：只读不写
    TooNew(u64),
    /// 值的形状明显不是密钥（含空白字符或太短）
    InvalidShape,
    /// 写入失败；附说得出的原因（磁盘满、没权限、只读、被改过），分不出的为 None（原文只进日志，不进这句话）
    WriteFailed(Option<String>),
}

impl fmt::Display for KeyStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::Unreadable(reason) => crate::t!("models.secrets.unreadable", reason = reason),
            Self::Corrupt => crate::t!("models.secrets.corrupt"),
            Self::TooNew(_) => crate::t!("models.secrets.tooNew"),
            Self::InvalidShape => crate::t!("models.secrets.invalidShape"),
            Self::WriteFailed(Some(reason)) => {
                crate::t!("models.secrets.writeFailed", error = reason)
            }
            Self::WriteFailed(None) => crate::t!("models.secrets.writeFailedPlain"),
        };
        f.write_str(&text)
    }
}

impl std::error::Error for KeyStoreError {}

/// 密钥里不会有空白字符，也不会只有几位。常见的误操作是剪贴板里其实是一条命令
pub fn validate_shape(value: &str) -> Result<(), KeyStoreError> {
    let trimmed = value.trim();
    if trimmed.chars().any(char::is_whitespace) || trimmed.chars().count() < 8 {
        return Err(KeyStoreError::InvalidShape);
    }
    Ok(())
}

/// 文件内容。不认得的字段原样带着：同一版本里将来多出来的东西不会被本程序写丢
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Doc {
    version: u64,
    #[serde(default)]
    providers: BTreeMap<String, BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    claude_router_token: Option<String>,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

/// 读到的文件：快照（写入时核对没被别人改过）与内容
struct Loaded {
    state: FileState,
    doc: Doc,
}

/// `<数据目录>/secrets.json` 的读写
#[derive(Debug, Clone)]
pub struct KeyStore {
    path: PathBuf,
}

impl KeyStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(FILE_NAME),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 某一家（`CODEX` / `CLAUDE`）某个网关的密钥；没有为 `Ok(None)`
    pub fn get(&self, agent: &str, id: &str) -> Result<Option<String>, KeyStoreError> {
        Ok(self
            .load()?
            .doc
            .providers
            .get(agent)
            .and_then(|keys| keys.get(id))
            .map(|key| key.trim().to_owned())
            .filter(|key| !key.is_empty()))
    }

    /// 存某一家某个网关的密钥（去掉首尾空白、校验形状之后）
    pub fn set(&self, agent: &str, id: &str, value: &str) -> Result<(), KeyStoreError> {
        validate_shape(value)?;
        let value = value.trim();
        self.update(|doc| {
            doc.providers
                .entry(agent.to_owned())
                .or_default()
                .insert(id.to_owned(), value.to_owned());
            true
        })
    }

    /// 删某一家某个网关的密钥；本来就没有不算错，也不写文件
    pub fn delete(&self, agent: &str, id: &str) -> Result<(), KeyStoreError> {
        self.update(|doc| {
            doc.providers
                .get_mut(agent)
                .is_some_and(|keys| keys.remove(id).is_some())
        })
    }

    /// Claude 网关令牌；没有为 `Ok(None)`
    pub fn router_token(&self) -> Result<Option<String>, KeyStoreError> {
        Ok(self
            .load()?
            .doc
            .claude_router_token
            .map(|token| token.trim().to_owned())
            .filter(|token| !token.is_empty()))
    }

    pub fn set_router_token(&self, token: &str) -> Result<(), KeyStoreError> {
        validate_shape(token)?;
        let token = token.trim();
        self.update(|doc| {
            doc.claude_router_token = Some(token.to_owned());
            true
        })
    }

    /// 格式损坏时把文件另存为 `secrets.json.broken-<now>`（同名已有就再加序号），之后当作没有文件。
    /// 只由界面进程调用（启动时、写之前）；返回另存到的路径，没坏返回 None。
    /// 读不出（权限）与版本更新都不算损坏，不动
    pub fn repair_if_corrupt(&self, now: u64) -> Result<Option<PathBuf>, KeyStoreError> {
        match self.load() {
            Err(KeyStoreError::Corrupt) => {}
            Ok(_) | Err(KeyStoreError::TooNew(_)) => return Ok(None),
            Err(other) => return Err(other),
        }
        let base = format!("{FILE_NAME}.broken-{now}");
        let parent = self.path.parent().unwrap_or(Path::new("."));
        let mut target = parent.join(&base);
        let mut n = 1;
        while std::fs::symlink_metadata(&target).is_ok() {
            target = parent.join(format!("{base}-{n}"));
            n += 1;
        }
        std::fs::rename(&self.path, &target).map_err(|e| write_failed(&self.path, &e))?;
        Ok(Some(target))
    }

    fn load(&self) -> Result<Loaded, KeyStoreError> {
        let state = atomicfile::read_state(&self.path).map_err(unreadable)?;
        let doc = match &state {
            FileState::Missing => Doc::default(),
            FileState::Present(snapshot) => {
                serde_json::from_slice(&snapshot.bytes).map_err(|_| KeyStoreError::Corrupt)?
            }
        };
        Ok(Loaded { state, doc })
    }

    /// 读 → 改 → 原子写。`change` 返回 false 表示没改，不写。
    /// 别的进程（命令行）恰好在两次核对之间写过：重读再来，最多三次
    fn update(&self, change: impl Fn(&mut Doc) -> bool) -> Result<(), KeyStoreError> {
        let mut last = None;
        for _ in 0..3 {
            let mut loaded = self.load()?;
            if loaded.doc.version > VERSION {
                return Err(KeyStoreError::TooNew(loaded.doc.version));
            }
            if !change(&mut loaded.doc) {
                return Ok(());
            }
            loaded.doc.version = VERSION;
            for agent in [CODEX, CLAUDE] {
                loaded.doc.providers.entry(agent.to_owned()).or_default();
            }
            let state = self.tighten(loaded.state)?;
            let mut bytes = serde_json::to_vec_pretty(&loaded.doc).map_err(|e| {
                log::warn!("serialize {} failed: {e}", self.path.display());
                KeyStoreError::WriteFailed(None)
            })?;
            bytes.push(b'\n');
            // 只做原子替换与核对，不调 `atomicfile::backup`：备份目录里不能有密钥（R7）
            match atomicfile::atomic_write(&self.path, &bytes, &state) {
                Ok(()) => return Ok(()),
                Err(e) if e.to_string() == "changed" => last = Some(e),
                Err(e) => return Err(write_failed(&self.path, &e)),
            }
        }
        Err(match last {
            Some(e) => write_failed(&self.path, &e),
            None => KeyStoreError::WriteFailed(None),
        })
    }

    /// 已有文件的权限比 0600 宽（别人能读）：先收紧，再按收紧后的样子重新取快照。
    /// 原子替换沿用旧文件的权限，先收紧才不会把新密钥写进一个别人能读的文件
    #[cfg(unix)]
    fn tighten(&self, state: FileState) -> Result<FileState, KeyStoreError> {
        use std::os::unix::fs::PermissionsExt;
        if matches!(state, FileState::Missing) {
            return Ok(state);
        }
        let mode = std::fs::symlink_metadata(&self.path)
            .map_err(|e| unreadable(ReadError::Io(e)))?
            .permissions()
            .mode();
        if mode & 0o077 == 0 {
            return Ok(state);
        }
        std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| write_failed(&self.path, &e))?;
        atomicfile::read_state(&self.path).map_err(unreadable)
    }

    /// Windows：放在用户自己的数据目录里，用系统默认权限（R2）
    #[cfg(not(unix))]
    fn tighten(&self, state: FileState) -> Result<FileState, KeyStoreError> {
        Ok(state)
    }
}

/// 读不出的原因：没有权限单独说成一句人话（AC2），其余照系统的原话
/// 写密钥文件没写成：说得出原因的带原因，分不出的只说失败（原文进日志）
fn write_failed(path: &Path, e: &io::Error) -> KeyStoreError {
    KeyStoreError::WriteFailed(atomicfile::write_failure_reason(path, e))
}

fn unreadable(error: ReadError) -> KeyStoreError {
    KeyStoreError::Unreadable(match error {
        ReadError::Io(e) if e.kind() == io::ErrorKind::PermissionDenied => {
            crate::t!("models.secrets.noPermission")
        }
        other => other.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    fn chmod(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// R1：两家各自的网关与令牌存取；没有是 `Ok(None)`；格式与 spec 一致
    #[test]
    fn keys_and_token_round_trip_in_the_spec_format() {
        let tree = TempTree::new();
        let data = tree.dir("AppData/Sophia");
        let store = KeyStore::new(&data);
        assert_eq!(store.get(CODEX, "wecode").unwrap(), None);
        assert_eq!(store.router_token().unwrap(), None);

        store.set(CODEX, "wecode", "  sk-codex-123456 \n").unwrap();
        store.set(CLAUDE, "wecode", "sk-claude-123456").unwrap();
        let token = format!("sophia-{}", "A".repeat(43));
        store.set_router_token(&token).unwrap();
        assert_eq!(
            store.get(CODEX, "wecode").unwrap().as_deref(),
            Some("sk-codex-123456")
        );
        assert_eq!(
            store.get(CLAUDE, "wecode").unwrap().as_deref(),
            Some("sk-claude-123456")
        );
        assert_eq!(store.get(CLAUDE, "other").unwrap(), None);
        assert_eq!(
            store.router_token().unwrap().as_deref(),
            Some(token.as_str())
        );

        let doc: serde_json::Value =
            serde_json::from_slice(&std::fs::read(data.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(
            doc,
            serde_json::json!({
                "version": 1,
                "providers": {
                    "codex": {"wecode": "sk-codex-123456"},
                    "claude": {"wecode": "sk-claude-123456"}
                },
                "claudeRouterToken": token
            })
        );

        store.delete(CODEX, "wecode").unwrap();
        store.delete(CODEX, "never-there").unwrap();
        assert_eq!(store.get(CODEX, "wecode").unwrap(), None);
        assert_eq!(
            store.get(CLAUDE, "wecode").unwrap().as_deref(),
            Some("sk-claude-123456")
        );
    }

    /// AC1 / R2 / R3：新建即 0600；数据目录不存在时一并建好
    #[cfg(unix)]
    #[test]
    fn a_new_file_is_private_from_the_start() {
        let tree = TempTree::new();
        let data = tree.root().join("not-yet").join("Sophia");
        let store = KeyStore::new(&data);
        store.set(CODEX, "a", "sk-new-12345678").unwrap();
        assert_eq!(mode(&data.join(FILE_NAME)), 0o600);
    }

    /// R2：别人能读的旧文件，写过之后只有本人能读
    #[cfg(unix)]
    #[test]
    fn a_wider_file_is_tightened_on_write() {
        let tree = TempTree::new();
        let data = tree.dir("data");
        let path = data.join(FILE_NAME);
        std::fs::write(
            &path,
            r#"{"version":1,"providers":{"codex":{},"claude":{}}}"#,
        )
        .unwrap();
        chmod(&path, 0o644);
        KeyStore::new(&data)
            .set(CODEX, "a", "sk-new-12345678")
            .unwrap();
        assert_eq!(mode(&path), 0o600);
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("sk-new-12345678"));
    }

    /// R7 / AC6：写密钥不往备份目录里放任何东西，数据目录里也只有这一个文件
    /// spec 2026-10-04-local-diagnostics R12：数据目录不让写时说「没有写入权限」，不把
    /// `Permission denied (os error 13)` 原文给用户（以 root 运行时权限不拦，跳过）
    #[cfg(unix)]
    #[test]
    fn a_read_only_folder_says_no_permission() {
        let tree = TempTree::new();
        let data = tree.dir("data");
        chmod(&data, 0o555);
        if std::fs::write(data.join("probe"), b"x").is_ok() {
            chmod(&data, 0o755);
            return;
        }
        let error = KeyStore::new(&data)
            .set(CODEX, "a", "sk-new-12345678")
            .unwrap_err();
        chmod(&data, 0o755);
        let text = error.to_string();
        assert!(text.contains("没有写入权限，未改动"), "{text}");
        assert!(!text.contains("os error"), "{text}");
    }

    #[test]
    fn writing_never_makes_a_backup() {
        let tree = TempTree::new();
        let data = tree.dir("data");
        let store = KeyStore::new(&data);
        store.set(CODEX, "a", "sk-first-1234567").unwrap();
        store.set(CODEX, "a", "sk-second-123456").unwrap();
        store.delete(CODEX, "a").unwrap();
        assert_eq!(names(&data), [FILE_NAME]);
    }

    /// R4 / AC2：读不出（没有读取权限）与「没有」分得开，原因说清楚
    #[cfg(unix)]
    #[test]
    fn unreadable_is_not_missing() {
        let tree = TempTree::new();
        let data = tree.dir("data");
        let store = KeyStore::new(&data);
        store.set(CODEX, "a", "sk-first-1234567").unwrap();
        chmod(store.path(), 0o000);
        if std::fs::read(store.path()).is_ok() {
            // 以 root 跑测试时权限拦不住，这条没法验证
            chmod(store.path(), 0o600);
            return;
        }
        let error = store.get(CODEX, "a").unwrap_err();
        assert_eq!(
            error,
            KeyStoreError::Unreadable(crate::t!("models.secrets.noPermission"))
        );
        assert!(error
            .to_string()
            .contains(&crate::t!("models.secrets.noPermission")));
        assert!(store.router_token().is_err());
        // 读不出时也不写：不能拿一份空的盖掉读不出的内容
        assert!(store.set(CODEX, "b", "sk-other-1234567").is_err());
        assert_eq!(store.repair_if_corrupt(1).unwrap_err(), error);
        chmod(store.path(), 0o600);
        assert_eq!(
            store.get(CODEX, "a").unwrap().as_deref(),
            Some("sk-first-1234567")
        );
        assert_eq!(store.get(CODEX, "b").unwrap(), None);
    }

    /// R5 / AC3：截断的文件读出来是「损坏」；写入拒绝（不静默覆盖）；界面进程另存后当空文件继续，原内容一字不差
    #[test]
    fn a_corrupt_file_is_set_aside_not_overwritten() {
        let tree = TempTree::new();
        let data = tree.dir("data");
        let store = KeyStore::new(&data);
        let truncated = br#"{"version":1,"providers":{"codex":{"a":"sk-tru"#;
        std::fs::write(store.path(), truncated).unwrap();

        assert_eq!(store.get(CODEX, "a").unwrap_err(), KeyStoreError::Corrupt);
        assert_eq!(
            store.set(CODEX, "a", "sk-new-12345678").unwrap_err(),
            KeyStoreError::Corrupt
        );
        assert_eq!(std::fs::read(store.path()).unwrap(), truncated);

        let moved = store.repair_if_corrupt(1_790_000_000).unwrap().unwrap();
        assert_eq!(
            moved.file_name().unwrap().to_string_lossy(),
            "secrets.json.broken-1790000000"
        );
        assert_eq!(std::fs::read(&moved).unwrap(), truncated);
        assert_eq!(store.get(CODEX, "a").unwrap(), None);
        store.set(CODEX, "a", "sk-new-12345678").unwrap();
        assert_eq!(
            store.get(CODEX, "a").unwrap().as_deref(),
            Some("sk-new-12345678")
        );
        // 好的文件不动；同一秒再坏一次不盖掉上一份
        assert_eq!(store.repair_if_corrupt(1_790_000_000).unwrap(), None);
        std::fs::write(store.path(), b"").unwrap();
        let again = store.repair_if_corrupt(1_790_000_000).unwrap().unwrap();
        assert_ne!(again, moved);
        assert_eq!(std::fs::read(&moved).unwrap(), truncated);
    }

    /// spec「读到 version 比自己新：不写」；读还照读
    #[test]
    fn a_newer_version_is_read_but_never_written() {
        let tree = TempTree::new();
        let data = tree.dir("data");
        let store = KeyStore::new(&data);
        let newer =
            br#"{"version":2,"providers":{"codex":{"a":"sk-from-future-1"}},"vault":{"x":1}}"#;
        std::fs::write(store.path(), newer).unwrap();
        assert_eq!(
            store.get(CODEX, "a").unwrap().as_deref(),
            Some("sk-from-future-1")
        );
        assert_eq!(
            store.set(CODEX, "b", "sk-new-12345678").unwrap_err(),
            KeyStoreError::TooNew(2)
        );
        assert_eq!(
            store.delete(CODEX, "a").unwrap_err(),
            KeyStoreError::TooNew(2)
        );
        assert_eq!(store.repair_if_corrupt(1).unwrap(), None);
        assert_eq!(std::fs::read(store.path()).unwrap(), newer);
    }

    /// 同版本里不认得的字段原样留着
    #[test]
    fn unknown_fields_survive_a_write() {
        let tree = TempTree::new();
        let data = tree.dir("data");
        let store = KeyStore::new(&data);
        std::fs::write(
            store.path(),
            br#"{"version":1,"providers":{"codex":{},"claude":{},"cursor":{"x":"sk-cursor-1234"}},"note":"keep"}"#,
        )
        .unwrap();
        store.set(CODEX, "a", "sk-new-12345678").unwrap();
        let doc: serde_json::Value =
            serde_json::from_slice(&std::fs::read(store.path()).unwrap()).unwrap();
        assert_eq!(doc["note"], "keep");
        assert_eq!(doc["providers"]["cursor"]["x"], "sk-cursor-1234");
        assert_eq!(doc["providers"]["codex"]["a"], "sk-new-12345678");
    }

    /// 真实发生过：剪贴板里的密钥被命令文本顶掉。含空白、太短的一律拒绝，且不覆盖已有的密钥
    #[test]
    fn values_that_cannot_be_a_key_are_rejected() {
        let tree = TempTree::new();
        let store = KeyStore::new(&tree.dir("data"));
        store.set(CODEX, "a", "sk-good-123456").unwrap();
        for bad in [
            "cd /Users/x && pbpaste | ./bin/agents-manager set-key",
            "sk-abc def",
            "line1\nline2",
            "short",
            "   ",
        ] {
            assert_eq!(
                store.set(CODEX, "a", bad).unwrap_err(),
                KeyStoreError::InvalidShape,
                "{bad:?}"
            );
        }
        assert_eq!(
            store.get(CODEX, "a").unwrap().as_deref(),
            Some("sk-good-123456")
        );
    }

    /// 错误文字不带密钥（会进界面横幅与路由日志），也不是空的
    #[test]
    fn errors_say_something_without_the_key() {
        let secret = "sk-super-secret-value-123456";
        for error in [
            KeyStoreError::Unreadable("Permission denied".into()),
            KeyStoreError::Corrupt,
            KeyStoreError::TooNew(2),
            KeyStoreError::InvalidShape,
            KeyStoreError::WriteFailed(Some("disk full".into())),
            KeyStoreError::WriteFailed(None),
        ] {
            let text = error.to_string();
            assert!(!text.contains(secret));
            assert!(!text.is_empty(), "{error:?}");
        }
    }
}
