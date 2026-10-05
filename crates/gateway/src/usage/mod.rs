//! 用量探测的基础设施（T5）：找 `claude` / `codex` 可执行文件、不读令牌地判断是否已登录、
//! 在 Sophia 自己的空目录里隔离起一次进程做问答式探测。本模块只管「干净地跑一次」，
//! 不解析响应、不知道 R4 的窗口归一——那是 `usage::claude` / `usage::codex`（T6）的事。
//!
//! 规格见 `docs/specs/2026-09-26-menubar-usage.md` R5、R8，设计第 1、2 节。
pub mod claude;
pub mod codex;
pub mod probe;
pub mod scheduler;

pub use claude::fetch_get_usage;
pub use codex::{fetch_app_server, read_rollout};
pub use probe::{ProbeError, ProbeOutput, ProbeSpec};

use sophia_core::usage::{FailReason, ParseFailure};
use std::collections::HashSet;
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};

/// 取数失败的种类（T6）：调用方（T7 调度）据此决定 `UsageStatus`；[`FetchError::fail_reason`] 给出原因种类，
/// [`FetchError::reason`] 把它翻成给人看的一句话（R7「写成人话，不写错误码」）。
#[derive(Debug)]
pub enum FetchError {
    /// 没找到可执行文件（R5）
    NotInstalled,
    /// 没有登录（R5）：这一步在起进程之前就会拦住，调用方不会看到真的 spawn 发生
    NotSignedIn,
    /// 到超时都没等到匹配的那一行（R8：`get_usage` 20 秒、`app-server` 15 秒）
    Timeout,
    /// 起进程本身失败、准备探测目录失败、或读写管道出的错（不是超时）
    Spawn(String),
    /// 拿到了回复但解析不出来：控制请求报错、限流、鉴权失败、字段对不上（R2、R7）
    Failed(ParseFailure),
}

impl FetchError {
    /// 失败原因的种类：状态里只存它，界面上的句子在显示时按当前语言取（`FailReason::text`）
    pub fn fail_reason(&self) -> FailReason {
        match self {
            FetchError::NotInstalled => FailReason::NotInstalled,
            FetchError::NotSignedIn => FailReason::NotSignedIn,
            FetchError::Timeout => FailReason::Timeout,
            FetchError::Spawn(_) => FailReason::SpawnFailed,
            FetchError::Failed(ParseFailure::NoPlanLimits) => FailReason::NoPlanLimits,
            FetchError::Failed(ParseFailure::AuthRequired) => FailReason::AuthRequired,
            FetchError::Failed(ParseFailure::RateLimited { .. }) => FailReason::RateLimited,
            FetchError::Failed(ParseFailure::Unsupported) => FailReason::Unsupported,
            FetchError::Failed(ParseFailure::Malformed(_)) => FailReason::Malformed,
        }
    }

    /// 给人看的一句话原因（当前语言），不含错误码、不含账号信息（R8）。
    /// `agent_label` 是「Claude Code」或「Codex」，由调用方（各自的 `fetch_*`）传入。
    pub fn reason(&self, agent_label: &str) -> String {
        self.fail_reason().text(agent_label)
    }
}

impl From<ProbeError> for FetchError {
    fn from(err: ProbeError) -> Self {
        match err {
            ProbeError::Timeout { .. } => FetchError::Timeout,
            ProbeError::WorkingDirNotEmpty(dir) => {
                let why = format!("探测目录不是空的: {}", dir.display()); // i18n-exempt: 诊断信息，界面只显示 reason()
                FetchError::Spawn(why)
            }
            ProbeError::Spawn(e) => FetchError::Spawn(e.to_string()),
            ProbeError::Io(e) => FetchError::Spawn(e.to_string()),
        }
    }
}

/// 确保探测目录是空的：这个目录整个归 Sophia 自己管（`claude_probe_dir` / `codex_probe_dir`
/// 底下的那一份），跟 `probe::run_probe`（不知道谁拥有目录、拒绝清空非空目录）不一样——
/// 这里允许清空，但要先确认路径末尾确实是 `owned_tail`（如 `["probe", "claude"]`），
/// 绝不清空传错的路径。目录不存在时什么都不做，交给 `run_probe` 自己创建。
pub(crate) fn ensure_empty_probe_dir(dir: &Path, owned_tail: &[&str]) -> io::Result<()> {
    if !path_ends_with_components(dir, owned_tail) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("拒绝清空不属于探测目录的路径: {}", dir.display()), // i18n-exempt: 诊断信息，界面只显示 reason()
        ));
    }
    match std::fs::read_dir(dir) {
        Ok(mut entries) => {
            if entries.next().is_some() {
                std::fs::remove_dir_all(dir)?;
                std::fs::create_dir_all(dir)?;
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    Ok(())
}

/// `path` 的路径分量末尾是否恰好是 `tail`（按分量比较，不是字符串 `ends_with`——
/// 参见 CLAUDE.md「`Path::starts_with` 按路径分量比较」，这里是它的镜像）
fn path_ends_with_components(path: &Path, tail: &[&str]) -> bool {
    let components: Vec<_> = path.components().collect();
    if components.len() < tail.len() {
        return false;
    }
    let start = components.len() - tail.len();
    components[start..]
        .iter()
        .zip(tail.iter())
        .all(|(c, t)| c.as_os_str() == OsStr::new(t))
}

/// PATH（进程看到的）与几个常见安装位置里找 `claude`，顺序：PATH → `~/.local/bin/claude` →
/// `~/.claude/local/claude` → `/opt/homebrew/bin/claude` → `/usr/local/bin/claude`。
/// 只留存在且可执行的，按上面的顺序去重。
///
/// 之所以要这些兜底位置：从 Dock 启动的 App 拿到的是登录时的最小 PATH，不是终端登录 shell 的
/// PATH（spec 风险「从 Dock 启动时找不到程序」）。
pub fn claude_executables() -> Vec<PathBuf> {
    claude_executables_from(std::env::var_os("PATH").as_deref(), &crate::runtime::home())
}

/// `claude_executables` 的可注入版本，供测试用假 PATH 和假 HOME
fn claude_executables_from(path_env: Option<&OsStr>, home: &Path) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(paths) = path_env {
        candidates.extend(std::env::split_paths(paths).map(|dir| dir.join("claude")));
    }
    candidates.push(home.join(".local").join("bin").join("claude"));
    candidates.push(home.join(".claude").join("local").join("claude"));
    candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    candidates.push(PathBuf::from("/usr/local/bin/claude"));

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|p| seen.insert(p.clone())) // 按首次出现的顺序去重
        .filter(|p| is_executable_file(p))
        .collect()
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false; // 不存在，或坏软链——metadata 跟随软链，符合「找得到能跑的程序」的意图
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// 找 `codex`：直接复用 `runtime::codex_executables()` 的顺序（桌面应用包内 → PATH → `~/.local/bin`），
/// 不另写一份（spec 设计第 1 节明确要求）
pub fn codex_executables() -> Vec<PathBuf> {
    crate::runtime::codex_executables()
}

/// Claude 是否已登录（R5）：只看 `~/.claude.json`（或 `CLAUDE_CONFIG_DIR` 指向目录下的同名文件）
/// 顶层有没有 `oauthAccount` 键、且它是个非空对象。只判断这一个键在不在，不读值、不存、不打日志（R8）。
///
/// `config_dir` 对应环境变量 `CLAUDE_CONFIG_DIR`：调用方按自己看到的环境解析好再传进来，
/// 这里不直接读 `std::env`，测试才能用临时目录，不用碰真实进程环境。
pub fn claude_signed_in(home: &Path, config_dir: Option<&Path>) -> bool {
    let path = config_dir.unwrap_or(home).join(".claude.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    matches!(value.get("oauthAccount"), Some(v) if v.is_object())
}

/// Codex 是否已登录（R5）：`$CODEX_HOME/auth.json` 指向一个存在的普通文件；不读内容（R8）。
///
/// 这里要的正是「目标在不在」，所以用跟随软链的 `Path::is_file()`（CLAUDE.md「Claude 常犯的错」里的
/// 那条例外）：auth.json 链到别处的真实文件算登录了，坏链不算（2026-09-29 独立验证指出原来用 lstat
/// 会把软链判成没登录）。
pub fn codex_signed_in(codex_home: &Path) -> bool {
    // 跟随软链（auth.json 链到别处的真实文件也算登录了）；坏链、目录不算
    codex_home.join("auth.json").is_file()
}

/// 探测用的空目录：`<base>/probe/claude`。`base` 是 Sophia 的应用支持目录，由调用方传入；
/// 这里只算路径，不创建、不校验是否为空——那是 `probe::run_probe` 的事
pub fn claude_probe_dir(base: &Path) -> PathBuf {
    base.join("probe").join("claude")
}

/// 探测用的空目录：`<base>/probe/codex`，同 [`claude_probe_dir`]
pub fn codex_probe_dir(base: &Path) -> PathBuf {
    base.join("probe").join("codex")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn make_executable(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// PATH 里的两个目录，第一个没有 claude、第二个有；home 的兜底位置也有一个；
    /// 顺序应该是 PATH 命中的那个在前，兜底在后；不可执行、不存在的候选被跳过；
    /// 重复出现的路径（PATH 里有两个相同目录）只算一次
    #[test]
    fn claude_executables_follows_order_and_dedupes() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let path_dir_empty = root.join("bin-empty");
        let path_dir_hit = root.join("bin-hit");
        std::fs::create_dir_all(&path_dir_empty).unwrap();
        make_executable(&path_dir_hit.join("claude"));
        let home = root.join("home");
        make_executable(&home.join(".local").join("bin").join("claude"));
        // 不可执行的候选（.claude/local）：应当被跳过
        std::fs::create_dir_all(home.join(".claude").join("local")).unwrap();
        std::fs::write(home.join(".claude").join("local").join("claude"), "no-exec").unwrap();

        let path_env =
            std::env::join_paths([&path_dir_empty, &path_dir_hit, &path_dir_hit]).unwrap();
        let found = claude_executables_from(Some(path_env.as_os_str()), &home);

        assert_eq!(
            found,
            vec![
                path_dir_hit.join("claude"),
                home.join(".local").join("bin").join("claude")
            ]
        );
    }

    #[test]
    fn claude_executables_empty_when_nothing_found() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        assert!(claude_executables_from(None, &home).is_empty());
    }

    #[test]
    fn claude_signed_in_true_with_oauth_account_object() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().canonicalize().unwrap();
        std::fs::write(
            home.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"x"}}"#,
        )
        .unwrap();
        assert!(claude_signed_in(&home, None));
    }

    #[test]
    fn claude_signed_in_false_when_oauth_account_is_null() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().canonicalize().unwrap();
        std::fs::write(home.join(".claude.json"), r#"{"oauthAccount":null}"#).unwrap();
        assert!(!claude_signed_in(&home, None));
    }

    #[test]
    fn claude_signed_in_false_when_key_missing() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().canonicalize().unwrap();
        std::fs::write(home.join(".claude.json"), r#"{"other":1}"#).unwrap();
        assert!(!claude_signed_in(&home, None));
    }

    #[test]
    fn claude_signed_in_false_when_json_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().canonicalize().unwrap();
        std::fs::write(home.join(".claude.json"), "not json").unwrap();
        assert!(!claude_signed_in(&home, None));
    }

    #[test]
    fn claude_signed_in_false_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().canonicalize().unwrap();
        assert!(!claude_signed_in(&home, None));
    }

    /// `CLAUDE_CONFIG_DIR` 设置时，认它目录下的 `.claude.json`，不认 HOME 下的那份
    #[test]
    fn claude_signed_in_respects_config_dir_override() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let home = root.join("home");
        let config_dir = root.join("xdg-config").join("claude");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        // HOME 下放一份「已登录」的，config_dir 下放一份「未登录」的：结果应以 config_dir 为准
        std::fs::write(
            home.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"x"}}"#,
        )
        .unwrap();
        std::fs::write(config_dir.join(".claude.json"), r#"{"oauthAccount":null}"#).unwrap();
        assert!(!claude_signed_in(&home, Some(&config_dir)));
    }

    #[test]
    fn codex_signed_in_true_when_auth_json_is_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let codex_home = dir.path().canonicalize().unwrap();
        std::fs::write(codex_home.join("auth.json"), "{}").unwrap();
        assert!(codex_signed_in(&codex_home));
    }

    /// auth.json 是软链（指向别处的真实文件）也算登录了；坏链不算
    #[test]
    fn codex_signed_in_follows_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let codex_home = dir.path().canonicalize().unwrap();
        std::fs::write(codex_home.join("real-auth.json"), "{}").unwrap();
        std::os::unix::fs::symlink(
            codex_home.join("real-auth.json"),
            codex_home.join("auth.json"),
        )
        .unwrap();
        assert!(codex_signed_in(&codex_home));
        std::fs::remove_file(codex_home.join("real-auth.json")).unwrap();
        assert!(!codex_signed_in(&codex_home), "坏链");
    }

    #[test]
    fn codex_signed_in_false_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let codex_home = dir.path().canonicalize().unwrap();
        assert!(!codex_signed_in(&codex_home));
    }

    #[test]
    fn codex_signed_in_false_when_auth_json_is_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let codex_home = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(codex_home.join("auth.json")).unwrap();
        assert!(!codex_signed_in(&codex_home));
    }

    #[test]
    fn probe_dirs_are_under_base_probe() {
        let base = Path::new("/tmp/sophia-support");
        assert_eq!(claude_probe_dir(base), base.join("probe").join("claude"));
        assert_eq!(codex_probe_dir(base), base.join("probe").join("codex"));
    }

    // ---------------- ensure_empty_probe_dir ----------------

    /// 非空探测目录被清空重建；探测目录之外的兄弟文件（同一个 `probe/` 目录下、
    /// 也在 base 目录里）原封不动——绝不波及自己拥有范围之外的东西
    #[test]
    fn ensure_empty_probe_dir_cleans_leftovers_but_leaves_siblings_alone() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let claude_dir = claude_probe_dir(&base);
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(claude_dir.join("leftover.jsonl"), "上一次没清干净的痕迹").unwrap();

        // 同一个 probe/ 目录下的兄弟：codex_probe_dir，以及 base 目录本身的一个文件
        let codex_dir = codex_probe_dir(&base);
        std::fs::create_dir_all(&codex_dir).unwrap();
        std::fs::write(codex_dir.join("codex-leftover.jsonl"), "别碰我").unwrap();
        std::fs::write(base.join("settings.json"), "别碰我").unwrap();

        ensure_empty_probe_dir(&claude_dir, &["probe", "claude"]).unwrap();

        assert!(claude_dir.is_dir(), "目录本身应该还在，只是空的");
        assert_eq!(std::fs::read_dir(&claude_dir).unwrap().count(), 0);
        assert_eq!(
            std::fs::read_to_string(codex_dir.join("codex-leftover.jsonl")).unwrap(),
            "别碰我"
        );
        assert_eq!(
            std::fs::read_to_string(base.join("settings.json")).unwrap(),
            "别碰我"
        );
    }

    /// 目录不存在时什么都不做（不报错、不创建）：交给 `run_probe` 自己创建
    #[test]
    fn ensure_empty_probe_dir_does_nothing_when_missing() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let claude_dir = claude_probe_dir(&base);
        assert!(!claude_dir.exists());

        ensure_empty_probe_dir(&claude_dir, &["probe", "claude"]).unwrap();
        assert!(!claude_dir.exists());
    }

    /// 已经是空目录：什么都不用做，目录还在
    #[test]
    fn ensure_empty_probe_dir_noop_when_already_empty() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let claude_dir = claude_probe_dir(&base);
        std::fs::create_dir_all(&claude_dir).unwrap();

        ensure_empty_probe_dir(&claude_dir, &["probe", "claude"]).unwrap();
        assert!(claude_dir.is_dir());
    }

    /// 路径末尾不是 `owned_tail`：拒绝，绝不清空传错的路径
    #[test]
    fn ensure_empty_probe_dir_refuses_path_not_owned() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let not_a_probe_dir = base.join("Documents");
        std::fs::create_dir_all(&not_a_probe_dir).unwrap();
        std::fs::write(not_a_probe_dir.join("important.txt"), "别碰我").unwrap();

        let err = ensure_empty_probe_dir(&not_a_probe_dir, &["probe", "claude"]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(
            std::fs::read_to_string(not_a_probe_dir.join("important.txt")).unwrap(),
            "别碰我"
        );
    }

    // ---------------- FetchError::reason ----------------

    #[test]
    fn fetch_error_reason_is_human_readable_chinese() {
        assert_eq!(FetchError::NotInstalled.reason("Codex"), "没找到 Codex");
        assert_eq!(
            FetchError::Timeout.reason("Claude Code"),
            "Claude Code 没有回应"
        );
        assert_eq!(
            FetchError::Failed(ParseFailure::AuthRequired).reason("Codex"),
            "需要重新登录 Codex"
        );
        assert_eq!(
            FetchError::Failed(ParseFailure::NoPlanLimits).reason("Claude Code"),
            "这个账号没有订阅额度"
        );
    }

    /// 状态里存的是原因种类，不带句子；每种 FetchError 对到哪一种、出句与 `reason` 一致
    #[test]
    fn fetch_error_maps_to_reason_kind_and_text_matches() {
        let cases = [
            (FetchError::NotInstalled, FailReason::NotInstalled),
            (FetchError::NotSignedIn, FailReason::NotSignedIn),
            (FetchError::Timeout, FailReason::Timeout),
            (FetchError::Spawn("x".into()), FailReason::SpawnFailed),
            (
                FetchError::Failed(ParseFailure::NoPlanLimits),
                FailReason::NoPlanLimits,
            ),
            (
                FetchError::Failed(ParseFailure::AuthRequired),
                FailReason::AuthRequired,
            ),
            (
                FetchError::Failed(ParseFailure::RateLimited { until: None }),
                FailReason::RateLimited,
            ),
            (
                FetchError::Failed(ParseFailure::Malformed("y".into())),
                FailReason::Malformed,
            ),
            (
                FetchError::Failed(ParseFailure::Unsupported),
                FailReason::Unsupported,
            ),
        ];
        for (err, kind) in cases {
            assert_eq!(err.fail_reason(), kind);
            assert_eq!(kind.text("Codex"), err.reason("Codex"));
        }
        assert_eq!(FailReason::Timeout.text("Codex"), "Codex 没有回应");
        assert_eq!(FailReason::SpawnFailed.text("Codex"), "没能启动 Codex");
    }

    /// R8：原因文字里不含错误码、不含账号信息——`Malformed` 携带的诊断文字不直接透出给界面
    #[test]
    fn fetch_error_reason_never_leaks_raw_malformed_text() {
        let reason = FetchError::Failed(ParseFailure::Malformed(
            "accountId=leaked-secret 才是真正的错误细节".to_string(),
        ))
        .reason("Codex");
        assert!(!reason.contains("leaked-secret"));
        assert!(!reason.contains("accountId"));
    }
}
