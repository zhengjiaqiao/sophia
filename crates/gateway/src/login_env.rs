//! 登录 shell 的环境（spec S16，sophia-dev#94）：从 Dock 或登录项启动的 Sophia 拿到的是系统最小 PATH，
//! 用 nvm、volta、fnm、bun、asdf 装的 `claude` / `codex` 找不到，写在 `.zshrc` 里的 `CLAUDE_CONFIG_DIR`、
//! `CODEX_HOME` 也读不到。启动后在后台起一次**交互式登录 shell**（`$SHELL -ilc`，nvm、volta 多写在 `.zshrc`，
//! 只有交互式才会读它），最多等 [`TIMEOUT`]，只取三个变量与代理变量（[`PROXY_VARS`]，spec #195「修订：代理」：
//! 开发者写在 shell 里的代理，Sophia 起的子进程也要用上），只问一次并缓存。
//!
//! 超时、起不来、输出里没有标记都当「没拿到」，一切退回现状；不卡界面、不弹错。
//! 不 `source` 别的文件，不取白名单以外的变量。测试主目录（`SOPHIA_TEST_HOME`）优先于这里的一切
//! （由调用方判断，见 `runtime::test_home_active`）。
use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, Once};
use std::time::Duration;

/// 等登录 shell 的上限（CodexBar 同样用 6 秒）：`.zshrc` 很重时也不能拖住菜单栏用量
pub const TIMEOUT: Duration = Duration::from_secs(6);
/// 输出里的标记行：`.zshrc` 可能先打印别的东西，只认标记之后的几行
const MARK: &str = "SOPHIA_LOGIN_ENV";
/// 让 shell 打印三个变量与代理变量的命令（`$SHELL -ilc <这一串>`）
const PRINT: &str = r#"printf 'SOPHIA_LOGIN_ENV\nPATH=%s\nCLAUDE_CONFIG_DIR=%s\nCODEX_HOME=%s\nHTTPS_PROXY=%s\nhttps_proxy=%s\nHTTP_PROXY=%s\nhttp_proxy=%s\nALL_PROXY=%s\nall_proxy=%s\nNO_PROXY=%s\nno_proxy=%s\n' "$PATH" "$CLAUDE_CONFIG_DIR" "$CODEX_HOME" "$HTTPS_PROXY" "$https_proxy" "$HTTP_PROXY" "$http_proxy" "$ALL_PROXY" "$all_proxy" "$NO_PROXY" "$no_proxy""#;

/// 代理变量（大小写两种都认）：只影响怎么连网、不改变身份
pub const PROXY_VARS: [&str; 8] = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
];

/// 登录 shell 里的三个变量与设了的代理变量；空串算没有
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LoginEnv {
    pub path: Option<String>,
    pub claude_config_dir: Option<String>,
    pub codex_home: Option<String>,
    /// 设了的代理变量，按 [`PROXY_VARS`] 的顺序
    pub proxy: Vec<(String, String)>,
}

/// 把 shell 的输出解析成 [`LoginEnv`]：标记行之后的 `名=值` 行；没有标记为 None
pub fn parse(output: &str) -> Option<LoginEnv> {
    let mut lines = output.lines();
    lines.find(|line| line.trim() == MARK)?;
    let mut env = LoginEnv::default();
    for line in lines {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = (!value.trim().is_empty()).then(|| value.to_owned());
        match key {
            "PATH" => env.path = value,
            "CLAUDE_CONFIG_DIR" => env.claude_config_dir = value,
            "CODEX_HOME" => env.codex_home = value,
            key if PROXY_VARS.contains(&key) => {
                if let Some(value) = value {
                    env.proxy.push((key.to_owned(), value));
                }
            }
            _ => {}
        }
    }
    env.proxy
        .sort_by_key(|(key, _)| PROXY_VARS.iter().position(|k| k == key));
    Some(env)
}

/// 用户的登录 shell：`$SHELL` 是绝对路径且存在才用，否则 `/bin/zsh`
pub fn shell() -> PathBuf {
    std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_file())
        .unwrap_or_else(|| PathBuf::from("/bin/zsh"))
}

/// 起一次 `shell -ilc`，最多等 `timeout`；超时就杀掉。拿不到为 None
pub fn query_with(shell: &Path, timeout: Duration) -> Option<LoginEnv> {
    let mut command = Command::new(shell);
    command.args(["-ilc", PRINT]);
    run_with_timeout(command, timeout)
}

/// 跑 `command`，最多等 `timeout`，解析它的输出；超时就杀掉。测试从这里注入冒充的 shell。
/// `Child` 留在本线程、只把 stdout 交给读线程（同 `sysproxy::run_with_timeout`：子进程不退出时超时分支才拿得到手）
fn run_with_timeout(mut command: Command, timeout: Duration) -> Option<LoginEnv> {
    use std::io::Read;
    use std::process::Stdio;
    use std::sync::mpsc;

    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(out) = stdout.as_mut() {
            let _ = out.read_to_string(&mut buf);
        }
        let _ = tx.send(buf);
    });
    match rx.recv_timeout(timeout) {
        Ok(buf) => {
            let _ = child.wait();
            parse(&buf)
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

/// 问一次的结果：`None`＝还没问完或没拿到
static RESULT: Mutex<Option<LoginEnv>> = Mutex::new(None);
static STARTED: Once = Once::new();

/// 启动时在后台问一次（只问一次，再调不重复）。不阻塞；问完之前 [`current`] 是 None，之后的调用才用上
pub fn start() {
    STARTED.call_once(|| {
        std::thread::Builder::new()
            .name("login-env".into())
            .spawn(|| {
                let env = query_with(&shell(), TIMEOUT);
                match &env {
                    Some(env) => log::info!(
                        "登录 shell 的环境已读到（PATH {} 项，CLAUDE_CONFIG_DIR {}，CODEX_HOME {}）",
                        env.path.as_deref().map_or(0, |p| std::env::split_paths(p).count()),
                        env.claude_config_dir.is_some(),
                        env.codex_home.is_some()
                    ),
                    None => log::warn!("登录 shell 的环境没读到（超时或起不来），按现状找程序"),
                }
                if let Some(env) = &env {
                    log::info!("登录 shell 里设了 {} 个代理变量", env.proxy.len());
                }
                *RESULT.lock().unwrap_or_else(|p| p.into_inner()) = env;
            })
            .ok();
    });
}

/// 此刻的结果；还没问完、没拿到都是 None
pub fn current() -> Option<LoginEnv> {
    RESULT.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// 测试里塞一份结果（不起 shell）
#[cfg(test)]
pub(crate) fn set_for_test(env: Option<LoginEnv>) {
    *RESULT.lock().unwrap_or_else(|p| p.into_inner()) = env;
}

/// 找程序用的四个兜底目录（Claude Code 官方安装脚本、Homebrew 两处）：登录 shell 问不到时靠它们
pub fn fallback_dirs(home: &Path) -> [PathBuf; 4] {
    [
        home.join(".local").join("bin"),
        home.join(".claude").join("local"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]
}

/// 解析后的 PATH（spec S16 Q18）：登录 shell 的 PATH ∪ 本进程的 PATH ∪ 四个兜底目录，去重保序。
/// 两家找可执行文件、探测子进程都用它
pub fn resolved_path_from(login: Option<&str>, process: Option<&str>, home: &Path) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut dirs = Vec::new();
    let mut push = |dir: PathBuf| {
        if seen.insert(dir.clone()) {
            dirs.push(dir);
        }
    };
    for list in [login, process].into_iter().flatten() {
        for dir in std::env::split_paths(list) {
            push(dir);
        }
    }
    for dir in fallback_dirs(home) {
        push(dir);
    }
    dirs
}

/// [`resolved_path_from`] 按当前进程与已问到的登录 shell 算；`home` 由调用方给（测试主目录也走它）
pub fn resolved_path(home: &Path) -> Vec<PathBuf> {
    let login = current().and_then(|env| env.path);
    let process = std::env::var_os("PATH").map(|p| p.to_string_lossy().into_owned());
    resolved_path_from(login.as_deref(), process.as_deref(), home)
}

/// 解析后的 PATH 拼成一个环境变量值
pub fn resolved_path_os(home: &Path) -> OsString {
    std::env::join_paths(resolved_path(home)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 冒充 shell：脚本交给 `/bin/sh` 读（`$1`＝`-ilc`，`$2`＝要执行的命令），不直接执行刚写好的文件。
    /// Linux 上别的测试线程起子进程时会继承这个文件的写句柄，紧接着 exec 它偶发 ETXTBSY（Text file busy），
    /// 起不来就成了「没拿到」：CI 上 `问登录shell_拿到三个变量` 因此时红时绿
    fn fake_shell(dir: &Path, name: &str, body: &str) -> Command {
        let script = dir.join(name);
        std::fs::write(&script, body).unwrap();
        let mut command = Command::new("/bin/sh");
        command.arg(script).args(["-ilc", PRINT]);
        command
    }

    #[test]
    fn 解析_标记之后的三个变量_空值算没有_标记前的噪音不管() {
        let out = "Welcome!\nnvm loaded\nSOPHIA_LOGIN_ENV\nPATH=/a:/b\nCLAUDE_CONFIG_DIR=\nCODEX_HOME=/c\nOTHER=x\n";
        assert_eq!(
            parse(out),
            Some(LoginEnv {
                path: Some("/a:/b".into()),
                claude_config_dir: None,
                codex_home: Some("/c".into()),
                proxy: Vec::new(),
            })
        );
        assert_eq!(parse("junk\n"), None, "没有标记就是没拿到");
        assert_eq!(parse("SOPHIA_LOGIN_ENV\n"), Some(LoginEnv::default()));
    }

    /// 代理变量（spec #195「修订：代理」）：设了的都留下、按固定顺序，空的不算，别的变量不收
    #[test]
    fn 解析_代理变量_设了的留下_空的不算() {
        let out = "SOPHIA_LOGIN_ENV\nPATH=/a\nno_proxy=localhost,.corp\nHTTPS_PROXY=http://127.0.0.1:7890\nhttps_proxy=\nALL_PROXY=socks5://127.0.0.1:7891\nFTP_PROXY=http://x\n";
        assert_eq!(
            parse(out).unwrap().proxy,
            vec![
                (
                    "HTTPS_PROXY".to_string(),
                    "http://127.0.0.1:7890".to_string()
                ),
                (
                    "ALL_PROXY".to_string(),
                    "socks5://127.0.0.1:7891".to_string()
                ),
                ("no_proxy".to_string(), "localhost,.corp".to_string()),
            ]
        );
    }

    /// 冒充 shell：收到 `-ilc <命令>` 后在自己设好的环境里执行那条命令
    #[test]
    fn 问登录shell_拿到三个变量() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(
            dir.path(),
            "zsh",
            "echo 'banner from zshrc'\nunset https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy NO_PROXY no_proxy\nPATH=/fake/nvm/bin:/usr/bin CLAUDE_CONFIG_DIR=/fake/cc CODEX_HOME= HTTPS_PROXY=http://127.0.0.1:7890 exec /bin/sh -c \"$2\"",
        );
        let env = run_with_timeout(shell, crate::test_timing::CHILD_OK).expect("应该拿到");
        assert_eq!(env.path.as_deref(), Some("/fake/nvm/bin:/usr/bin"));
        assert_eq!(env.claude_config_dir.as_deref(), Some("/fake/cc"));
        assert_eq!(env.codex_home, None);
        assert_eq!(
            env.proxy,
            vec![(
                "HTTPS_PROXY".to_string(),
                "http://127.0.0.1:7890".to_string()
            )]
        );
    }

    #[test]
    fn 问登录shell_挂住就超时_不超过上限() {
        let dir = tempfile::tempdir().unwrap();
        // `exec`：超时只杀得到 shell 本身，不 exec 的话 `sleep` 成了孤儿再活 30 秒。macOS 上 std 开管道不是原子地
        // 设 CLOEXEC，别的线程恰在此时 fork 出的 `sleep` 会带着别个测试的 stdout 写端，拖得「拿到三个变量」
        // 迟迟读不到 EOF、等满 30 秒超时（整套并发时偶发，约 1/25）
        let shell = fake_shell(dir.path(), "slow", "exec sleep 30");
        let start = std::time::Instant::now();
        assert_eq!(run_with_timeout(shell, Duration::from_millis(300)), None);
        assert!(
            start.elapsed() < Duration::from_millis(300) + crate::test_timing::KILL_SLACK,
            "{:?}",
            start.elapsed()
        );
    }

    #[test]
    fn 问登录shell_输出乱码或起不来都是没拿到() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(dir.path(), "junk", "echo 'not what we asked'");
        assert_eq!(run_with_timeout(shell, crate::test_timing::CHILD_OK), None);
        assert_eq!(
            query_with(&dir.path().join("missing"), crate::test_timing::CHILD_OK),
            None
        );
    }

    /// 本机真实的登录 shell（`$SHELL` 和它的 rc 文件）：结果随机器而定，CI 上不跑。
    /// 本机手动跑：`cargo test -p sophia-gateway -- --ignored 真实登录shell`
    #[test]
    #[ignore = "依赖本机的登录 shell 与 rc 文件，只在本机手动跑"]
    fn 真实登录shell_在上限内答上_拿到path() {
        let start = std::time::Instant::now();
        let env = query_with(&shell(), TIMEOUT).expect("本机的登录 shell 应该在上限内答上");
        assert!(start.elapsed() < TIMEOUT, "{:?}", start.elapsed());
        assert!(env.path.is_some(), "{env:?}");
    }

    #[test]
    fn 解析后的path_登录shell在前_本进程其次_兜底目录最后_去重保序() {
        let home = Path::new("/Users/u");
        let dirs = resolved_path_from(
            Some("/Users/u/.nvm/v1/bin:/usr/bin:/opt/homebrew/bin"),
            Some("/usr/bin:/bin"),
            home,
        );
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/Users/u/.nvm/v1/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/bin"),
                PathBuf::from("/Users/u/.local/bin"),
                PathBuf::from("/Users/u/.claude/local"),
                PathBuf::from("/usr/local/bin"),
            ]
        );
        assert_eq!(
            resolved_path_from(None, None, home),
            fallback_dirs(home).to_vec(),
            "什么都没有也有兜底"
        );
    }
}
