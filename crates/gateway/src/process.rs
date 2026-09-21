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

/// 结束了哪几个进程。`terminated == 0` 表示 Codex 当时没在跑——这不是失败
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartReport {
    pub terminated: u32,
    pub pids: Vec<u32>,
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
        message = format!("kill -TERM {pid} 退出码 {}", output.status);
    }
    Err(io::Error::other(message))
}

#[cfg(test)]
mod tests {
    use super::*;

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
