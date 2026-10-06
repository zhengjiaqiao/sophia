//! Claude Code 的取数客户端（T6，R1、R2、R8）：`claude -p` 程序化模式，发一次 `initialize`
//! 控制请求，再发一次 `get_usage`，拿到匹配的回复就收工。协议细节（参数、请求行、停止条件）
//! 是设计第 2 节「已实测」的那份契约；隔离起进程、超时、清环境变量由 `probe::run_probe` 负责，
//! 这里只管拼协议、判断可用性、把回复交给 `sophia_core::usage::parse::parse_get_usage`。

use super::{claude_executables, claude_probe_dir, claude_signed_in, ensure_empty_probe_dir};
use super::{Account, FetchError};
use crate::usage::probe::{run_probe, ProbeSpec};
use serde_json::Value;
use sophia_core::usage::parse::parse_get_usage;
use sophia_core::usage::{ParseFailure, Reading};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// R8：`get_usage` 探测的超时（已实测 1.0–1.5 秒返回，20 秒是足够宽的上限）
const TIMEOUT: Duration = Duration::from_secs(20);

/// 我们自己选的请求号，跟真实回复样本里的 `usage-1` 无关——那是另一台机器录的，
/// 这两个号只用来在这一次探测里认出哪一行是答哪个请求的
const INIT_REQUEST_ID: &str = "sophia-init";
const USAGE_REQUEST_ID: &str = "sophia-usage";

/// 取一次 Claude Code 的用量（R1）。`base_dir` 是 Sophia 应用支持目录，探测目录固定为
/// `claude_probe_dir(base_dir)`；`now` 是取到回复的时刻（观测时刻，见 `Reading::observed_at`）。
///
/// 找不到 `claude` → [`FetchError::NotInstalled`]；没登录 → [`FetchError::NotSignedIn`]，
/// 且**不会**起任何进程（R5、AC10）。
pub async fn fetch_get_usage(
    base_dir: &Path,
    account: &Account,
    now: i64,
) -> Result<Reading, FetchError> {
    fetch_get_usage_with(
        base_dir,
        now,
        &claude_executables(),
        &account.home,
        account.claude_config_dir.as_deref(),
        account.probe_parent_env(),
        TIMEOUT,
    )
    .await
}

/// [`fetch_get_usage`] 的可注入版本：测试传假的可执行文件列表、假 `HOME`、假的
/// `parent_env`（喂给 `run_probe`，不用碰真实进程环境）、更短的超时。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn fetch_get_usage_with(
    base_dir: &Path,
    now: i64,
    executables: &[PathBuf],
    home: &Path,
    config_dir: Option<&Path>,
    parent_env: Option<Vec<(String, String)>>,
    timeout: Duration,
) -> Result<Reading, FetchError> {
    let program = executables
        .first()
        .cloned()
        .ok_or(FetchError::NotInstalled)?;

    // 没登录就不启动任何进程（R5、AC10、AC4）：这一步永远在 spawn 之前
    if !claude_signed_in(home, config_dir) {
        return Err(FetchError::NotSignedIn);
    }

    let working_dir = claude_probe_dir(base_dir);
    ensure_empty_probe_dir(&working_dir, &["probe", "claude"])
        .map_err(|e| FetchError::Spawn(format!("准备探测目录失败: {e}")))?; // i18n-exempt: 诊断信息，界面只显示 reason()

    let spec = ProbeSpec {
        program,
        args: probe_args(),
        working_dir,
        stdin_lines: vec![init_request_line(), usage_request_line()],
        // 用户设过 CLAUDE_CONFIG_DIR：登录判断按它，探测也要带上它，否则读的是默认的 ~/.claude
        extra_env: config_dir
            .map(|d| {
                vec![(
                    "CLAUDE_CONFIG_DIR".to_string(),
                    d.to_string_lossy().into_owned(),
                )]
            })
            .unwrap_or_default(),
        parent_env,
        timeout,
        until: Box::new(is_usage_response),
    };

    let output = run_probe(spec).await?;
    let matched = output.matched.ok_or_else(|| {
        FetchError::Failed(ParseFailure::Malformed(
            "claude 提前退出，没有等到 get_usage 的回复".to_string(), // i18n-exempt: 诊断信息，界面只显示 reason()
        ))
    })?;
    parse_get_usage(&matched, now).map_err(FetchError::Failed)
}

/// 设计第 2 节「已实测」的启动参数：程序化模式 + stream-json，不加载用户设置和 hooks、
/// 不启 MCP、不留会话（R8）
fn probe_args() -> Vec<String> {
    [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--setting-sources",
        "project",
        "--settings",
        r#"{"disableAllHooks":true}"#,
        "--strict-mcp-config",
        "--no-session-persistence",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

fn init_request_line() -> String {
    serde_json::json!({
        "type": "control_request",
        "request_id": INIT_REQUEST_ID,
        "request": {"subtype": "initialize"},
    })
    .to_string()
}

fn usage_request_line() -> String {
    serde_json::json!({
        "type": "control_request",
        "request_id": USAGE_REQUEST_ID,
        "request": {"subtype": "get_usage", "skip_behaviors": true},
    })
    .to_string()
}

/// 停止条件：`type == "control_response"` 且 `response.request_id == "sophia-usage"`。
/// `initialize` 的回复（`request_id == "sophia-init"`）会先到，但不满足这个条件，
/// `run_probe` 会继续往下读
fn is_usage_response(v: &Value) -> bool {
    v.get("type").and_then(Value::as_str) == Some("control_response")
        && v.get("response")
            .and_then(|r| r.get("request_id"))
            .and_then(Value::as_str)
            == Some(USAGE_REQUEST_ID)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::probe::ProbeError;
    use crate::usage::test_support::write_executable;
    use sophia_core::usage::{AgentId, Severity, Source};

    /// 真实（脱敏）样本 `get_usage_max_with_limits.json`，把 `request_id` 换成
    /// 我们自己协议里用的 `sophia-usage`，压成单行——`run_probe` 按行读 stdout，
    /// 假程序必须一次 `echo` 吐出完整的一行 JSON
    fn success_reply_line() -> String {
        let raw = include_str!("../../../core/src/usage/testdata/get_usage_max_with_limits.json");
        let mut value: Value = serde_json::from_str(raw).unwrap();
        value["response"]["request_id"] = Value::String(USAGE_REQUEST_ID.to_string());
        value.to_string()
    }

    fn no_plan_limits_reply_line() -> String {
        serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": USAGE_REQUEST_ID,
                "response": {
                    "subscription_type": null,
                    "rate_limits_available": false,
                    "rate_limits": null
                }
            }
        })
        .to_string()
    }

    fn error_reply_line() -> String {
        serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "error",
                "request_id": USAGE_REQUEST_ID,
                "error": "boom"
            }
        })
        .to_string()
    }

    /// 探测子进程的环境按白名单清空（`probe::ENV_ALLOWLIST`），测试里给的 `parent_env`
    /// 又是空表：PATH 里没有 `/bin`、`/usr/bin`，`touch`、`cat` 这类外部命令会
    /// "command not found"。假程序只能用 shell 内建命令（`read`、`printf`、重定向），
    /// 不能依赖 PATH 上的外部工具——这里把字符串安全地包成单引号字面量喂给 `printf`
    fn shell_single_quoted(s: &str) -> String {
        format!("'{}'", s.replace('\'', "'\\''"))
    }

    /// 生成一个假的 `claude`：读到第二行 stdin（`get_usage` 请求）时，`printf` 原样吐出
    /// `reply_line`；此外先在自己的工作目录里留一个 marker 文件，用来断言「真的被执行过」
    /// （用重定向而不是 `touch`：前者是 shell 内建，后者要靠 PATH 找外部程序）
    fn write_fake_claude(dir: &Path, reply_line: &str) -> PathBuf {
        let body = format!(
            ": > spawned.marker\nn=0\nwhile IFS= read -r line; do\n  n=$((n+1))\n  if [ \"$n\" -eq 2 ]; then\n    printf '%s\\n' {}\n  fi\ndone\n",
            shell_single_quoted(reply_line)
        );
        write_script(dir, "claude.sh", &body)
    }

    fn write_silent_claude(dir: &Path) -> PathBuf {
        write_script(
            dir,
            "silent.sh",
            ": > spawned.marker\nwhile IFS= read -r line; do :; done\n",
        )
    }

    fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let mut full = String::from("#!/bin/sh\n");
        full.push_str(body);
        let path = dir.join(name);
        write_executable(&path, &full);
        path
    }

    fn signed_in_home(root: &Path) -> PathBuf {
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"x"}}"#,
        )
        .unwrap();
        home
    }

    fn run<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Runtime::new().unwrap().block_on(fut)
    }

    // ---------------- AC1：成功 ----------------

    #[test]
    fn success_parses_into_reading() {
        run(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let base_dir = root.join("support");
            let home = signed_in_home(&root);
            let program = write_fake_claude(&root, &success_reply_line());

            let reading = fetch_get_usage_with(
                &base_dir,
                1_000,
                &[program],
                &home,
                None,
                Some(Vec::new()),
                crate::test_timing::CHILD_OK,
            )
            .await
            .unwrap();

            assert_eq!(reading.agent, AgentId::ClaudeCode);
            assert_eq!(reading.source, Source::GetUsage);
            assert_eq!(reading.observed_at, 1_000);
            assert_eq!(reading.windows.len(), 3, "{:?}", reading.windows);
            let weekly = reading.windows.iter().find(|w| w.key == "weekly").unwrap();
            assert_eq!(weekly.used_percent, 87.0);
            assert_eq!(weekly.severity, Severity::Warning);
        });
    }

    /// 用户设过 `CLAUDE_CONFIG_DIR`：可用性按它判断，探测子进程也要带上它（否则会读默认的 ~/.claude，
    /// 用错账号）；没设就不带（2026-09-29 独立验证指出）
    #[test]
    fn passes_claude_config_dir_when_set() {
        run(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let base_dir = root.join("support");
            let config_dir = signed_in_home(&root);
            let empty_home = root.join("empty-home");
            std::fs::create_dir_all(&empty_home).unwrap();
            let body = format!(
                "printf '%s' \"$CLAUDE_CONFIG_DIR\" > config-dir.marker\nn=0\nwhile IFS= read -r line; do\n  n=$((n+1))\n  if [ \"$n\" -eq 2 ]; then\n    printf '%s\\n' {}\n  fi\ndone\n",
                shell_single_quoted(&success_reply_line())
            );
            let program = write_script(&root, "claude-env.sh", &body);
            fetch_get_usage_with(
                &base_dir,
                1_000,
                &[program],
                &empty_home,
                Some(&config_dir),
                Some(Vec::new()),
                crate::test_timing::CHILD_OK,
            )
            .await
            .unwrap();
            let marker = claude_probe_dir(&base_dir).join("config-dir.marker");
            assert_eq!(
                std::fs::read_to_string(marker).unwrap(),
                config_dir.to_string_lossy()
            );
        });
    }

    /// 测试主目录：探测子进程的 HOME 换成它，`claude` 读的是测试主目录里的登录，不是真实账号
    #[test]
    fn test_home_account_runs_probe_with_that_home() {
        run(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let base_dir = root.join("support");
            let home = signed_in_home(&root);
            let account = crate::usage::Account::in_home(&home);
            let body = format!(
                "printf '%s' \"$HOME\" > home.marker\nn=0\nwhile IFS= read -r line; do\n  n=$((n+1))\n  if [ \"$n\" -eq 2 ]; then\n    printf '%s\\n' {}\n  fi\ndone\n",
                shell_single_quoted(&success_reply_line())
            );
            let program = write_script(&root, "claude-home.sh", &body);
            fetch_get_usage_with(
                &base_dir,
                1_000,
                &[program],
                &account.home,
                account.claude_config_dir.as_deref(),
                account.probe_parent_env(),
                crate::test_timing::CHILD_OK,
            )
            .await
            .unwrap();
            let marker = claude_probe_dir(&base_dir).join("home.marker");
            assert_eq!(
                std::fs::read_to_string(marker).unwrap(),
                home.to_string_lossy()
            );
        });
    }

    /// 探测目录里有上一次没清干净的文件：应该被清空重建，取数照常成功
    #[test]
    fn cleans_leftover_probe_dir_before_spawning() {
        run(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let base_dir = root.join("support");
            let home = signed_in_home(&root);
            let program = write_fake_claude(&root, &success_reply_line());

            let working_dir = claude_probe_dir(&base_dir);
            std::fs::create_dir_all(&working_dir).unwrap();
            std::fs::write(working_dir.join("上次的痕迹.json"), "leftover").unwrap();
            // 探测目录之外的兄弟文件：不该被这次清理波及
            let sibling = base_dir.join("settings.json");
            std::fs::write(&sibling, "别碰我").unwrap();

            fetch_get_usage_with(
                &base_dir,
                1_000,
                &[program],
                &home,
                None,
                Some(Vec::new()),
                crate::test_timing::CHILD_OK,
            )
            .await
            .unwrap();

            assert!(
                !working_dir.join("上次的痕迹.json").exists(),
                "上一次的痕迹应该被清掉"
            );
            assert_eq!(std::fs::read_to_string(&sibling).unwrap(), "别碰我");
        });
    }

    // ---------------- AC3：control_response 报了 error ----------------

    #[test]
    fn subtype_error_is_failed_malformed() {
        run(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let base_dir = root.join("support");
            let home = signed_in_home(&root);
            let program = write_fake_claude(&root, &error_reply_line());

            let err = fetch_get_usage_with(
                &base_dir,
                1_000,
                &[program],
                &home,
                None,
                Some(Vec::new()),
                crate::test_timing::CHILD_OK,
            )
            .await
            .unwrap_err();

            assert!(matches!(
                err,
                FetchError::Failed(ParseFailure::Malformed(_))
            ));
        });
    }

    // ---------------- AC3：超时 ----------------

    #[test]
    fn never_replies_times_out() {
        run(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let base_dir = root.join("support");
            let home = signed_in_home(&root);
            let program = write_silent_claude(&root);

            let err = fetch_get_usage_with(
                &base_dir,
                1_000,
                &[program],
                &home,
                None,
                Some(Vec::new()),
                Duration::from_millis(200),
            )
            .await
            .unwrap_err();

            assert!(matches!(err, FetchError::Timeout));
            assert_eq!(err.reason("Claude Code"), "Claude Code 没有回应");
        });
    }

    // ---------------- AC11：没有订阅额度 ----------------

    #[test]
    fn rate_limits_available_false_is_no_plan_limits() {
        run(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let base_dir = root.join("support");
            let home = signed_in_home(&root);
            let program = write_fake_claude(&root, &no_plan_limits_reply_line());

            let err = fetch_get_usage_with(
                &base_dir,
                1_000,
                &[program],
                &home,
                None,
                Some(Vec::new()),
                crate::test_timing::CHILD_OK,
            )
            .await
            .unwrap_err();

            assert!(matches!(
                err,
                FetchError::Failed(ParseFailure::NoPlanLimits)
            ));
            assert_eq!(err.reason("Claude Code"), "这个账号没有订阅额度");
        });
    }

    // ---------------- AC10、AC4：没登录不起进程 ----------------

    #[test]
    fn not_signed_in_never_spawns() {
        run(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let base_dir = root.join("support");
            let home = root.join("home"); // 没有 .claude.json
            std::fs::create_dir_all(&home).unwrap();
            let program = write_fake_claude(&root, &success_reply_line());

            let err = fetch_get_usage_with(
                &base_dir,
                1_000,
                &[program],
                &home,
                None,
                Some(Vec::new()),
                crate::test_timing::CHILD_OK,
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

    // ---------------- AC10：找不到程序 ----------------

    #[test]
    fn no_executables_is_not_installed() {
        run(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let base_dir = root.join("support");
            let home = signed_in_home(&root);

            let err = fetch_get_usage_with(
                &base_dir,
                1_000,
                &[],
                &home,
                None,
                Some(Vec::new()),
                crate::test_timing::CHILD_OK,
            )
            .await
            .unwrap_err();

            assert!(matches!(err, FetchError::NotInstalled));
            assert_eq!(err.reason("Claude Code"), "没找到 Claude Code");
        });
    }

    // ---------------- ProbeError → FetchError 的映射 ----------------

    #[test]
    fn probe_error_conversions_are_sensible() {
        assert!(matches!(
            FetchError::from(ProbeError::Timeout {
                elapsed: Duration::from_secs(1),
                stderr_tail: String::new(),
            }),
            FetchError::Timeout
        ));
        assert!(matches!(
            FetchError::from(ProbeError::Spawn(std::io::Error::other("x"))),
            FetchError::Spawn(_)
        ));
    }
}

/// **真实验证**（AC1、R1、R8）：用产品负责人机器上真实登录的 Claude Code 跑一次 `get_usage`。
/// 默认不跑（`#[ignore]`）；手动执行时必须用干净环境，不然会带着这次 Claude Code 会话自己的
/// `CLAUDE_CODE_*`/`ANTHROPIC_*` 变量，行为跟从 Dock 启动时不一样（spec 风险「测试环境会
/// 污染结论」）：
///
/// ```sh
/// env -i HOME="$HOME" USER="$USER" LANG=en_US.UTF-8 PATH="/usr/bin:/bin:$HOME/.local/bin:$HOME/.cargo/bin" \
///   cargo test -p sophia-gateway real_claude_get_usage -- --ignored --nocapture
/// ```
///
/// 只读：不写 `~/.claude.json`、不写 `~/.claude/settings.json`，探测目录用临时目录。
#[cfg(test)]
mod real_verification {
    use super::*;

    #[test]
    #[ignore]
    fn real_claude_get_usage() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let base_dir = std::env::temp_dir()
                .join(format!("sophia-usage-verify-claude-{}", std::process::id()));
            let start = std::time::Instant::now();
            let result = fetch_get_usage(&base_dir, &crate::usage::Account::real(), 0).await;
            let elapsed = start.elapsed();
            eprintln!("elapsed={elapsed:?}");
            match result {
                Ok(reading) => {
                    eprintln!("plan={:?}", reading.plan);
                    for w in &reading.windows {
                        eprintln!(
                            "window key={} label={:?} used%={} severity={:?} active={} resets_at={:?}",
                            w.key, w.label(), w.used_percent, w.severity, w.active, w.resets_at
                        );
                    }
                }
                Err(e) => eprintln!("err={e:?} reason={}", e.reason("Claude Code")),
            }
            let _ = std::fs::remove_dir_all(&base_dir);
        });
    }
}
