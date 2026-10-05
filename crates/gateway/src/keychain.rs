//! 经 `/usr/bin/security` 读 macOS 钥匙串里的 generic password 条目。
//!
//! 密钥存在数据目录里的 `secrets.json`（`sophia_core::keystore`，spec 2026-10-03-keys-in-file），
//! 钥匙串只剩一处用到：接管 agents-manager（R8）时从它的服务 `agents-manager` 读一次密钥。
//!
//! 存储形式沿用 agents-manager 用的 Go 库 `github.com/zalando/go-keyring` 的写法：
//! `go-keyring-base64:` 前缀 + base64(value)；读取同时接受这种形式和纯文本。
use std::fmt;
use std::io;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

const BASE64_PREFIX: &str = "go-keyring-base64:";

/// `/usr/bin/security` 的一次调用：传给它的参数（argv），以及可选的标准输入内容。
/// 返回合并后的 stdout+stderr 与退出码
pub type Runner = Box<dyn Fn(&[&str], Option<&str>) -> io::Result<(String, i32)> + Send + Sync>;

/// 读钥匙串时可能发生的错误。
#[derive(Debug)]
pub enum KeyError {
    /// 钥匙串里没有这个条目。
    NotSet,
    /// 启动/运行 `security` 本身失败（找不到可执行文件、超时等）。
    Io(io::Error),
    /// `security` 以非预期的方式失败（非零退出码，且不是“未找到”；钥匙串锁着就是这种）。
    Command(String),
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeyError::NotSet => write!(f, "API key is not set"),
            KeyError::Io(e) => write!(f, "{e}"),
            KeyError::Command(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for KeyError {}

impl From<io::Error> for KeyError {
    fn from(e: io::Error) -> Self {
        KeyError::Io(e)
    }
}

fn decode_value(stored: &str) -> Result<String, KeyError> {
    let trimmed = stored.trim();
    if let Some(rest) = trimmed.strip_prefix(BASE64_PREFIX) {
        let bytes = BASE64
            .decode(rest)
            .map_err(|e| KeyError::Command(format!("base64: {e}")))?;
        return Ok(String::from_utf8_lossy(&bytes).trim().to_string());
    }
    Ok(trimmed.to_string())
}

fn looks_not_found(stdout: &str) -> bool {
    stdout.to_ascii_lowercase().contains("could not be found")
}

/// 读取一个 generic password 条目；不存在返回 `KeyError::NotSet`。
pub fn get_key(run: &Runner, service: &str, account: &str) -> Result<String, KeyError> {
    let (stdout, code) = run(
        &["find-generic-password", "-s", service, "-wa", account],
        None,
    )?;
    if code != 0 {
        if looks_not_found(&stdout) {
            return Err(KeyError::NotSet);
        }
        return Err(KeyError::Command(format!(
            "security find-generic-password failed with exit code {code}: {stdout}"
        )));
    }
    decode_value(&stdout)
}

// ----- 家 claude 的网关令牌 -----

/// 令牌的前缀；后接 43 位 base64url（256 位随机数）
pub const ROUTER_TOKEN_PREFIX: &str = "sophia-";

/// 生成一个新令牌：256 位系统随机数（`/dev/urandom`，不新增依赖），写成 `sophia-` + 43 位 base64url
pub fn new_router_token() -> io::Result<String> {
    use std::io::Read;
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(router_token_from(&bytes))
}

/// 令牌的写法（纯函数，测试用固定字节）
pub fn router_token_from(bytes: &[u8; 32]) -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    format!("{ROUTER_TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes))
}

/// 生产环境下真正调用 `/usr/bin/security` 的 runner。测试永远不用它——统一走假 runner。
#[cfg(target_os = "macos")]
pub fn security_runner() -> Runner {
    Box::new(|args, stdin| {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let mut cmd = Command::new("/usr/bin/security");
        cmd.args(args);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });

        let mut child = cmd.spawn()?;
        if let Some(input) = stdin {
            child
                .stdin
                .take()
                .expect("stdin 已配置为 piped")
                .write_all(input.as_bytes())?;
        }
        let output = child.wait_with_output()?;
        let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
        combined.push_str(&String::from_utf8_lossy(&output.stderr));
        Ok((combined, output.status.code().unwrap_or(-1)))
    })
}

/// 非 macOS 平台没有 `/usr/bin/security`。
#[cfg(not(target_os = "macos"))]
pub fn security_runner() -> Runner {
    Box::new(|_args, _stdin| {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "/usr/bin/security is only available on macOS",
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_accepts_plain_and_go_keyring_values() {
        let runner: Runner = Box::new(|args, _| {
            Ok(match args.last().copied() {
                Some("plain") => ("plain-not-encoded\n".to_owned(), 0),
                // base64("sk-encoded-123")
                Some("encoded") => ("go-keyring-base64:c2stZW5jb2RlZC0xMjM=\n".to_owned(), 0),
                _ => ("could not be found".to_owned(), 44),
            })
        });
        assert_eq!(
            get_key(&runner, "svc", "plain").unwrap(),
            "plain-not-encoded"
        );
        assert_eq!(
            get_key(&runner, "svc", "encoded").unwrap(),
            "sk-encoded-123"
        );
        assert!(matches!(
            get_key(&runner, "svc", "other"),
            Err(KeyError::NotSet)
        ));
    }
}

#[cfg(test)]
mod router_token_tests {
    use super::*;

    /// AC4 的形状：`sophia-` + 43 位 base64url（256 位），共 50 字符；两次生成不同
    #[test]
    fn router_token_shape() {
        let token = router_token_from(&[0xff; 32]);
        assert!(token.starts_with(ROUTER_TOKEN_PREFIX));
        assert_eq!(token.len(), 50);
        assert!(token[ROUTER_TOKEN_PREFIX.len()..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        #[cfg(unix)]
        {
            let (a, b) = (new_router_token().unwrap(), new_router_token().unwrap());
            assert_eq!(a.len(), 50);
            assert_ne!(a, b);
        }
    }
}
