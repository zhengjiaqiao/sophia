//! 结束 Codex 的后台进程。Codex 启动时读一次 `~/.codex/config.toml`，之后不重读，
//! 所以改完模型配置要把常驻的后台进程结束掉，下次任何工具拉起它时才带着新配置起来。
//!
//! 纯逻辑（进程表解析、匹配规则）与真实副作用（`ps` / `kill`）都在这个文件里，
//! 编排层只拿注入进来的两个函数，测试用假进程表，不真杀进程。
use std::io;
use std::path::Path;
use std::process::Command;

/// 进程表里的一行
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    pub pid: u32,
    /// 完整命令行，第一个 token 是可执行文件路径
    pub command: String,
}

/// 重启生效做了什么。`terminated` / `pids` 是退出桌面应用之后另行结束的后台进程（编辑器插件拉起的
/// app-server 等；桌面应用自己的会跟着它退，不在这里）。`reopened` 为 true 表示桌面应用原本开着、
/// 已退出并重新打开。`terminated == 0 && !reopened` 表示 Codex 当时没在跑——这不是失败
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartReport {
    pub terminated: u32,
    pub pids: Vec<u32>,
    pub reopened: bool,
}

/// 取值放在下一个 token 里的选项：判定子命令时要连它的值一起跳过。
/// 漏列一个的后果是把它的值当成子命令、进而认不出 `app-server`——是「没在跑」，不是误杀
const VALUE_FLAGS: [&str; 14] = [
    "-c",
    "--config",
    "-m",
    "--model",
    "-p",
    "--profile",
    "-C",
    "--cd",
    "-s",
    "--sandbox",
    "-a",
    "--ask-for-approval",
    "-i",
    "--image",
];

/// 是不是 Codex 的后台形态。**只按可执行名 + 子命令判断**，不看命令行里有没有 `codex` 这种字样：
/// - 第一个 token 的文件名是 `codex`，且子命令是 `app-server`
/// - 第一个 token 的文件名是 `codex-code-mode-host`
///
/// 子命令是选项之后的第一个非选项 token，不是固定的第二个 token：桌面应用拉起的形态是
/// `/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server …`
/// （本机实查），只认第二个 token 会漏掉它——而它恰恰是揣着旧配置的那个。
///
/// 不匹配用户自己在终端里跑的交互式 `codex`（结束它就吃掉了用户正在打的字）：
/// 它要么没有子命令，要么子命令是 `exec` 之类。提示词里写了 `app-server` 也不会误判，
/// 因为那是子命令位之后的东西。也不匹配 `node …app-server-broker.mjs` 这类壳进程
/// （可执行名是 node，不是我们的东西）。
/// Codex 升级后进程名可能变，那时的表现是「没在跑」而不是误杀，方向是安全的。
pub fn is_codex_background(command: &str) -> bool {
    let mut tokens = command.split_whitespace();
    let Some(first) = tokens.next() else {
        return false;
    };
    let Some(exe) = Path::new(first).file_name().map(|n| n.to_string_lossy()) else {
        return false;
    };
    match exe.as_ref() {
        "codex" => subcommand(tokens) == Some("app-server"),
        "codex-code-mode-host" => true,
        _ => false,
    }
}

/// 不是交互式会话的子命令（`codex exec` 跑完就退、`codex mcp-server` 是别人拉起的服务…）。
/// 不在这里的都算交互式：没有子命令、`resume`、或者直接带提示词（`codex "修个 bug"`，提示词会占到子命令位）
const NON_INTERACTIVE: [&str; 18] = [
    "app-server",
    "exec",
    "e",
    "mcp-server",
    "mcp",
    "login",
    "logout",
    "apply",
    "a",
    "completion",
    "debug",
    "sandbox",
    "proto",
    "cloud",
    "features",
    "help",
    "responses-api-proxy",
    "stdio-to-uds",
];

/// 是不是用户在终端里跑的交互式 `codex`（与 [`is_codex_background`] 相反的那一类）：退出 Sophia 时重启 Codex
/// 不碰它，确认框要提醒用户自己重启（spec 2026-10-03-gateway-in-app R6）。
/// 可执行名是 `codex`、不在应用包里（桌面应用自带的那份只会是后台形态）、子命令不是一次性或服务类的
pub fn is_codex_interactive(command: &str) -> bool {
    let mut tokens = command.split_whitespace();
    let Some(first) = tokens.next() else {
        return false;
    };
    if first.contains(".app/Contents/") {
        return false;
    }
    if Path::new(first).file_name().is_none_or(|n| n != "codex") {
        return false;
    }
    !subcommand(tokens).is_some_and(|sub| NON_INTERACTIVE.contains(&sub))
}

/// 选项之后的第一个非选项 token；全是选项就没有子命令
fn subcommand<'a>(tokens: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    let mut tokens = tokens;
    while let Some(token) = tokens.next() {
        if !token.starts_with('-') {
            return Some(token);
        }
        // `-c key=value` 的值是独立 token，`-ckey=value` / `--config=…` 不是
        if VALUE_FLAGS.contains(&token) {
            tokens.next();
        }
    }
    None
}

/// `ps -axo pid=,command=` 的输出：每行一个 pid，后面是完整命令行
pub fn parse_ps(text: &str) -> Vec<ProcessInfo> {
    text.lines()
        .filter_map(|line| {
            let (pid, command) = line.trim_start().split_once(char::is_whitespace)?;
            Some(ProcessInfo {
                pid: pid.parse().ok()?,
                command: command.trim().to_owned(),
            })
        })
        .collect()
}

/// 真实进程表
pub fn list_processes() -> io::Result<Vec<ProcessInfo>> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,command="])
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    Ok(parse_ps(&String::from_utf8_lossy(&output.stdout)))
}

/// 让这个 pid 的图形应用正常退出：`NSRunningApplication.terminate`，与 ⌘Q 同一条路
/// （应用自己走退出流程，Electron 的辅助进程跟着退）。返回请求是否发出去了：
/// 系统里没有这个 pid 的应用、或系统说没发成 → false，由调用方退回 SIGTERM。
/// 不等它退出；不用 `osascript`（会弹「Sophia 想控制 …」的自动化授权框）。
/// 为什么不直接 SIGTERM：Electron 收到 SIGTERM 不带走辅助进程，每次都留下一组孤儿（issue #143）
#[cfg(target_os = "macos")]
pub fn quit_app(pid: u32) -> bool {
    use objc2_app_kit::NSRunningApplication;
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // 在后台线程上调用：自建自动释放池，免得返回的对象攒在线程的隐式池里
    objc2::rc::autoreleasepool(|_| {
        NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
            .is_some_and(|app| app.terminate())
    })
}

/// 非 macOS 没有 `NSRunningApplication`：总是 false，调用方照旧发 SIGTERM
#[cfg(not(target_os = "macos"))]
pub fn quit_app(_pid: u32) -> bool {
    false
}

/// 发 SIGTERM。用 `/bin/kill` 而不是 libc：不为一个信号引一个新依赖。
/// 失败时把系统的原话带出去，不编
pub fn terminate(pid: u32) -> io::Result<()> {
    let output = Command::new("/bin/kill")
        .args(["-TERM", &pid.to_string()])
        .output()?;
    if output.status.success() {
        return Ok(());
    }
    let mut message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if message.is_empty() {
        message = sophia_core::t!("models.process.killExit", pid = pid, status = output.status);
    }
    Err(io::Error::other(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 终端里的交互式会话：没有子命令、带选项、resume、直接带提示词；一次性、服务类与桌面应用自带的不算
    #[test]
    fn interactive_sessions_are_told_from_the_rest() {
        for yes in [
            "codex",
            "/opt/homebrew/bin/codex",
            "/opt/homebrew/bin/codex --model gpt-5.6-sol",
            "/Users/me/.local/bin/codex -c a=b resume",
            "codex fix the flaky test",
        ] {
            assert!(is_codex_interactive(yes), "{yes}");
        }
        for no in [
            "codex app-server",
            "/opt/homebrew/bin/codex exec fix it",
            "codex mcp-server",
            "codex login",
            "/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server",
            "/Applications/ChatGPT.app/Contents/Resources/codex",
            "/usr/local/bin/codex-code-mode-host",
            "node /x/codex-app-server-broker.mjs",
            "",
        ] {
            assert!(!is_codex_interactive(no), "{no}");
        }
    }

    /// 只认两种后台形态；交互式会话和 node 壳进程都不碰
    #[test]
    fn matches_only_codex_background_forms() {
        let cases = [
            ("codex app-server", true),
            ("/opt/homebrew/bin/codex app-server --flag", true),
            // 桌面应用拉起的形态：子命令前面还有 `-c key=value`（本机实查 2026-09-21）
            (
                "/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled",
                true,
            ),
            (
                "/Users/me/.codex/packages/standalone/releases/0.154.0-aarch64-apple-darwin/bin/codex-code-mode-host",
                true,
            ),
            // 交互式会话
            ("codex", false),
            ("/usr/local/bin/codex --cd /x", false),
            ("codex exec 'hi'", false),
            // 提示词里正好写了 app-server：它在子命令位之后，不算
            ("codex 重启 app-server", false),
            ("codex -c foo=bar 修一下 app-server", false),
            // Claude 插件的 node 壳：命令行里有 codex 字样，可执行名不是
            (
                "node /Users/me/.claude/plugins/codex/app-server-broker.mjs",
                false,
            ),
            // 名字只是前缀相同，不是我们要的
            ("codex-app-server", false),
            ("", false),
        ];
        for (command, want) in cases {
            assert_eq!(is_codex_background(command), want, "{command}");
        }
    }

    #[test]
    fn parse_ps_takes_pid_then_the_whole_command_line() {
        let got = parse_ps(" 7503 codex app-server\n8224 /x/bin/codex-code-mode-host\n坏行\n");
        assert_eq!(
            got,
            vec![
                ProcessInfo {
                    pid: 7503,
                    command: "codex app-server".into()
                },
                ProcessInfo {
                    pid: 8224,
                    command: "/x/bin/codex-code-mode-host".into()
                },
            ]
        );
    }
}
