//! Codex 的取数客户端（T6，R3、R8）：两级——① 只读本机会话记录末尾（不起进程）；
//! ② `codex app-server` 的 `account/rateLimits/read`（JSON-RPC）。协议细节是设计第 2 节
//! 「已实测」的那份契约；隔离起进程、超时、清环境变量由 `probe::run_probe` 负责，这里只管
//! 拼协议、判断可用性、把回复交给 `sophia_core::usage::parse`。
//!
//! **管道化已用真实只读调用验证**：`run_probe` 把三行 stdin 一次性写完但**不提前关 stdin**
//! （关闭发生在拿到匹配回复之后），这跟「等 `initialize` 回复再发 `initialized`」效果一致——
//! 起决定作用的是 stdin 不能过早收到 EOF，不是发送节奏。本机用 `codex-cli 0.156.1` 验证：
//! 用文件重定向（读完即 EOF）会在 `app-server` 处理完 `initialize` 后就退出、等不到
//! `rateLimits/read` 的回复；stdin 保持打开（管道不关）时，三行一次性写入照常在约 1–3 秒内
//! 拿到 `id:2` 的结果，跟「一条条等着发」没有区别。`run_probe` 本来就不提前关 stdin，
//! 不需要改它。

use super::probe::{run_probe, ProbeSpec};
use super::{codex_executables, codex_probe_dir, codex_signed_in, ensure_empty_probe_dir};
use super::{Account, FetchError};
use serde_json::Value;
use sophia_core::usage::parse::{parse_app_server, parse_rollout_line};
use sophia_core::usage::rollout::{latest_rollout, read_last_rate_limits_line};
use sophia_core::usage::{ParseFailure, Reading};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// R8：`app-server` 探测的超时（已实测 1.4 秒左右返回，15 秒是足够宽的上限）
const TIMEOUT: Duration = Duration::from_secs(15);

/// 我们自己发出的请求号：`initialize` 用 1，`account/rateLimits/read` 用 2（设计第 2 节）
const RATE_LIMITS_REQUEST_ID: i64 = 2;

/// 只读本机会话记录末尾（R3①、R13）：不起任何进程，也不判断是否登录——调用方（T7）
/// 决定要不要先走这一步，走不动（没有会话、没有额度记录）就返回 `None`，不当错误。
///
/// `codex_home` 是调用方按 `$CODEX_HOME`（默认 `~/.codex`）解析好的目录。
pub fn read_rollout(codex_home: &Path) -> Option<Reading> {
    let path = latest_rollout(codex_home)?;
    let tail = read_last_rate_limits_line(&path).ok()?;
    let line = tail.line?;
    parse_rollout_line(&line)
}

/// 取一次 `codex app-server` 的用量（R3②）。`base_dir` 是 Sophia 应用支持目录，探测目录固定为
/// `codex_probe_dir(base_dir)`；`codex_home` 是这次要探测的账号所在目录；`now` 是取到回复的时刻。
///
/// 找不到 `codex` → [`FetchError::NotInstalled`]；没登录（`auth.json` 不在）→
/// [`FetchError::NotSignedIn`]，且**不会**起任何进程（R5、AC10）。
pub async fn fetch_app_server(
    base_dir: &Path,
    account: &Account,
    now: i64,
) -> Result<Reading, FetchError> {
    // 带给子进程的 CODEX_HOME 由账号决定（设计第 2 节：「启动时去掉 CODEX_HOME 以外会改变身份的
    // 环境变量」——CODEX_HOME 本身要保留，否则 app-server 会去读默认的 ~/.codex，跟这里解析出的
    // `codex_home` 可能不是同一个目录）；测试主目录时连 HOME 一起换掉
    fetch_app_server_with(
        base_dir,
        &account.codex_home,
        now,
        &codex_executables(),
        account.codex_home_env.clone(),
        account.probe_parent_env(),
        TIMEOUT,
    )
    .await
}

/// [`fetch_app_server`] 的可注入版本：测试传假的可执行文件列表、假的 `CODEX_HOME` 环境状态、
/// 假的 `parent_env`（喂给 `run_probe`）、更短的超时。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn fetch_app_server_with(
    base_dir: &Path,
    codex_home: &Path,
    now: i64,
    executables: &[PathBuf],
    codex_home_env: Option<String>,
    parent_env: Option<Vec<(String, String)>>,
    timeout: Duration,
) -> Result<Reading, FetchError> {
    let program = executables
        .first()
        .cloned()
        .ok_or(FetchError::NotInstalled)?;

    // 没登录就不启动任何进程（R5、AC10）：这一步永远在 spawn 之前
    if !codex_signed_in(codex_home) {
        return Err(FetchError::NotSignedIn);
    }

    let working_dir = codex_probe_dir(base_dir);
    ensure_empty_probe_dir(&working_dir, &["probe", "codex"])
        .map_err(|e| FetchError::Spawn(format!("准备探测目录失败: {e}")))?; // i18n-exempt: 诊断信息，界面只显示 reason()

    let extra_env = match codex_home_env {
        Some(_) => vec![(
            "CODEX_HOME".to_string(),
            codex_home.to_string_lossy().into_owned(),
        )],
        None => Vec::new(),
    };

    let spec = ProbeSpec {
        program,
        args: probe_args(),
        working_dir,
        stdin_lines: vec![
            initialize_line(),
            initialized_notification_line(),
            rate_limits_request_line(),
        ],
        extra_env,
        parent_env,
        timeout,
        until: Box::new(is_rate_limits_response),
    };

    let output = run_probe(spec).await?;
    let matched = output.matched.ok_or_else(|| {
        FetchError::Failed(ParseFailure::Malformed(
            "app-server 提前退出，没有等到 rateLimits 的回复".to_string(), // i18n-exempt: 诊断信息，界面只显示 reason()
        ))
    })?;
    parse_app_server(&matched, now).map_err(FetchError::Failed)
}

/// 设计第 2 节「已实测」的启动参数：只读沙箱、永不请求批准
fn probe_args() -> Vec<String> {
    ["-s", "read-only", "-a", "never", "app-server"]
        .into_iter()
        .map(str::to_owned)
        .collect()
}

fn initialize_line() -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "clientInfo": {"name": "sophia", "version": env!("CARGO_PKG_VERSION")}
        },
    })
    .to_string()
}

fn initialized_notification_line() -> String {
    serde_json::json!({"jsonrpc": "2.0", "method": "initialized"}).to_string()
}

fn rate_limits_request_line() -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": RATE_LIMITS_REQUEST_ID,
        "method": "account/rateLimits/read",
    })
    .to_string()
}

/// 停止条件：`id == 2`。`initialize` 的回复（`id == 1`）、期间夹杂的通知
/// （`remoteControl/status/changed` 之类，没有 `id` 字段）都不满足，`run_probe` 会继续往下读
fn is_rate_limits_response(v: &Value) -> bool {
    v.get("id").and_then(Value::as_i64) == Some(RATE_LIMITS_REQUEST_ID)
}

#[cfg(test)]
mod tests {
    use super::test_support_usage::TempTree;
    use super::*;
    use sophia_core::usage::{AgentId, Source};
    use std::os::unix::fs::PermissionsExt;

    /// 真实（脱敏）样本 `app_server_prolite.json`：`id` 已经是 2，不用改，压成单行
    fn success_reply_line() -> String {
        let raw = include_str!("../../../core/src/usage/testdata/app_server_prolite.json");
        let value: Value = serde_json::from_str(raw).unwrap();
        value.to_string()
    }

    fn auth_error_reply_line() -> String {
        serde_json::json!({
            "id": RATE_LIMITS_REQUEST_ID,
            "error": {"code": -32000, "message": "Unauthorized: please log in again"}
        })
        .to_string()
    }

    /// 探测子进程的环境按白名单清空、测试给的 `parent_env` 又是空表：PATH 里没有
    /// `/bin`、`/usr/bin`，`touch`、`cat` 这类外部命令会 "command not found"。假程序
    /// 只能用 shell 内建命令（`read`、`printf`、重定向）——这里把字符串安全包成单引号
    /// 字面量喂给 `printf`（真实样本里带 `'`，如 "You've been granted"，要转义）
    fn shell_single_quoted(s: &str) -> String {
        format!("'{}'", s.replace('\'', "'\\''"))
    }

    fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let mut full = String::from("#!/bin/sh\n");
        full.push_str(body);
        let path = dir.join(name);
        std::fs::write(&path, full).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    /// 假的 `codex app-server`：读到第三行 stdin（`account/rateLimits/read` 请求）时，
    /// `printf` 原样吐出 `reply_line`；先留一个 marker 文件，断言「真的被执行过」
    fn write_fake_app_server(dir: &Path, reply_line: &str) -> PathBuf {
        let body = format!(
            ": > spawned.marker\nn=0\nwhile IFS= read -r line; do\n  n=$((n+1))\n  if [ \"$n\" -eq 3 ]; then\n    printf '%s\\n' {}\n  fi\ndone\n",
            shell_single_quoted(reply_line)
        );
        write_script(dir, "codex.sh", &body)
    }

    fn write_silent_app_server(dir: &Path) -> PathBuf {
        write_script(
            dir,
            "silent.sh",
            ": > spawned.marker\nwhile IFS= read -r line; do :; done\n",
        )
    }

    fn signed_in_codex_home(root: &Path) -> PathBuf {
        let codex_home = root.join("codex-home");
        std::fs::create_dir_all(&codex_home).unwrap();
        std::fs::write(codex_home.join("auth.json"), "{}").unwrap();
        codex_home
    }

    fn run<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Runtime::new().unwrap().block_on(fut)
    }

    // ---------------- read_rollout（不起进程） ----------------

    #[test]
    fn read_rollout_parses_latest_fixture_line() {
        let tree = TempTree::new();
        let day = tree.dir("sessions/2026/09/25");
        let sample = include_str!("../../../core/src/usage/testdata/rollout_token_count.jsonl");
        std::fs::write(day.join("rollout-x.jsonl"), sample).unwrap();

        let reading = read_rollout(&tree.root()).expect("应该读到一条读数");
        assert_eq!(reading.agent, AgentId::Codex);
        assert_eq!(reading.source, Source::Rollout);
        assert_eq!(reading.plan, Some("prolite".to_string()));
        assert_eq!(reading.windows.len(), 1);
        assert_eq!(reading.windows[0].used_percent, 57.0);
    }

    #[test]
    fn read_rollout_none_when_no_sessions() {
        let tree = TempTree::new();
        assert_eq!(read_rollout(&tree.root()), None);
    }

    // ---------------- AC6：app-server 成功 ----------------

    #[test]
    fn app_server_success_parses_into_reading() {
        run(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let base_dir = root.join("support");
            let codex_home = signed_in_codex_home(&root);
            let program = write_fake_app_server(&root, &success_reply_line());

            let reading = fetch_app_server_with(
                &base_dir,
                &codex_home,
                2_000,
                &[program],
                None,
                Some(Vec::new()),
                Duration::from_secs(5),
            )
            .await
            .unwrap();

            assert_eq!(reading.agent, AgentId::Codex);
            assert_eq!(reading.source, Source::AppServer);
            assert_eq!(reading.plan, Some("prolite".to_string()));
            assert_eq!(reading.windows.len(), 1);
            assert_eq!(reading.windows[0].key, "weekly");
            assert_eq!(reading.windows[0].used_percent, 57.0);
        });
    }

    /// `CODEX_HOME` 在用户环境里设过：探测子进程应该带上它，指向调用方解析出的目录
    #[test]
    fn passes_codex_home_when_env_was_set() {
        run(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let base_dir = root.join("support");
            let codex_home = signed_in_codex_home(&root);
            let program = write_fake_app_server(&root, &success_reply_line());

            let reading = fetch_app_server_with(
                &base_dir,
                &codex_home,
                2_000,
                &[program],
                Some(codex_home.to_string_lossy().into_owned()),
                Some(Vec::new()),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
            assert_eq!(reading.agent, AgentId::Codex);
        });
    }

    // ---------------- AC7：鉴权失败 ----------------

    #[test]
    fn auth_error_maps_to_auth_required() {
        run(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let base_dir = root.join("support");
            let codex_home = signed_in_codex_home(&root);
            let program = write_fake_app_server(&root, &auth_error_reply_line());

            let err = fetch_app_server_with(
                &base_dir,
                &codex_home,
                2_000,
                &[program],
                None,
                Some(Vec::new()),
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();

            assert!(matches!(
                err,
                FetchError::Failed(ParseFailure::AuthRequired)
            ));
            assert_eq!(err.reason("Codex"), "需要重新登录 Codex");
        });
    }

    // ---------------- 超时 ----------------

    #[test]
    fn never_replies_times_out() {
        run(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let base_dir = root.join("support");
            let codex_home = signed_in_codex_home(&root);
            let program = write_silent_app_server(&root);

            let err = fetch_app_server_with(
                &base_dir,
                &codex_home,
                2_000,
                &[program],
                None,
                Some(Vec::new()),
                Duration::from_millis(200),
            )
            .await
            .unwrap_err();

            assert!(matches!(err, FetchError::Timeout));
        });
    }

    // ---------------- AC10：没登录不起进程 ----------------

    #[test]
    fn not_signed_in_never_spawns() {
        run(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let base_dir = root.join("support");
            let codex_home = root.join("codex-home"); // 没有 auth.json
            std::fs::create_dir_all(&codex_home).unwrap();
            let program = write_fake_app_server(&root, &success_reply_line());

            let err = fetch_app_server_with(
                &base_dir,
                &codex_home,
                2_000,
                &[program],
                None,
                Some(Vec::new()),
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();

            assert!(matches!(err, FetchError::NotSignedIn));
            assert!(
                !root.join("spawned.marker").exists(),
                "没登录就不该起任何进程"
            );
        });
    }

    #[test]
    fn no_executables_is_not_installed() {
        run(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let base_dir = root.join("support");
            let codex_home = signed_in_codex_home(&root);

            let err = fetch_app_server_with(
                &base_dir,
                &codex_home,
                2_000,
                &[],
                None,
                Some(Vec::new()),
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();

            assert!(matches!(err, FetchError::NotInstalled));
            assert_eq!(err.reason("Codex"), "没找到 Codex");
        });
    }
}

/// **真实验证**（AC5、AC6、R3、R8）：用产品负责人机器上真实登录的 Codex 依次跑一次会话记录
/// 末尾读取（不起进程）和一次 `app-server`。默认不跑（`#[ignore]`）；手动执行时用干净环境：
///
/// ```sh
/// env -i HOME="$HOME" USER="$USER" LANG=en_US.UTF-8 PATH="/usr/bin:/bin:$HOME/.local/bin:$HOME/.cargo/bin" \
///   cargo test -p sophia-gateway real_codex -- --ignored --nocapture
/// ```
///
/// 只读：不写 `~/.codex/config.toml`、不新增会话记录，探测目录用临时目录。
#[cfg(test)]
mod real_verification {
    use super::*;

    #[test]
    #[ignore]
    fn real_codex_read_rollout() {
        let codex_home = crate::runtime::codex_home();
        let start = std::time::Instant::now();
        let reading = read_rollout(&codex_home);
        eprintln!("elapsed={:?}", start.elapsed());
        match reading {
            Some(reading) => {
                eprintln!(
                    "plan={:?} observed_at={}",
                    reading.plan, reading.observed_at
                );
                for w in &reading.windows {
                    eprintln!(
                        "window key={} label={:?} used%={} resets_at={:?}",
                        w.key,
                        w.label(),
                        w.used_percent,
                        w.resets_at
                    );
                }
            }
            None => eprintln!("没有读到会话记录里的额度"),
        }
    }

    #[test]
    #[ignore]
    fn real_codex_app_server() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let base_dir = std::env::temp_dir()
                .join(format!("sophia-usage-verify-codex-{}", std::process::id()));
            let start = std::time::Instant::now();
            let result = fetch_app_server(&base_dir, &crate::usage::Account::real(), 0).await;
            let elapsed = start.elapsed();
            eprintln!("elapsed={elapsed:?}");
            match result {
                Ok(reading) => {
                    eprintln!("plan={:?}", reading.plan);
                    for w in &reading.windows {
                        eprintln!(
                            "window key={} label={:?} used%={} resets_at={:?}",
                            w.key,
                            w.label(),
                            w.used_percent,
                            w.resets_at
                        );
                    }
                }
                Err(e) => eprintln!("err={e:?} reason={}", e.reason("Codex")),
            }
            let _ = std::fs::remove_dir_all(&base_dir);
        });
    }
}

/// `crates/core` 的 `test_support::TempTree` 是 core 内部测试用的，不对外公开；这里现场搭一个
/// 够用的最小替身（建目录、返回根路径，`canonicalize` 过——同 CLAUDE.md「测试里的临时目录先
/// canonicalize」），避免为了一个测试工具去改 core 的可见性（core 不在本任务的 Files 列表里）
#[cfg(test)]
mod test_support_usage {
    use std::path::PathBuf;

    pub struct TempTree {
        _dir: tempfile::TempDir,
        root: PathBuf,
    }

    impl TempTree {
        pub fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().canonicalize().unwrap();
            Self { _dir: dir, root }
        }

        pub fn root(&self) -> PathBuf {
            self.root.clone()
        }

        pub fn dir(&self, rel: &str) -> PathBuf {
            let path = self.root.join(rel);
            std::fs::create_dir_all(&path).unwrap();
            path
        }
    }
}
