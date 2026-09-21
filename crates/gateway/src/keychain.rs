//! 经 `/usr/bin/security` 读写 macOS 钥匙串里的 generic password 条目，使得 launchd
//! 后台进程和每次重新编译的二进制都能无弹窗读取。
//!
//! 用系统接口直接创建的条目会绑定创建它的那个程序，后台副本和重新编译的程序会被拒绝
//! 或弹授权框；经 `security` 创建的条目任何进程都能读。写入必须走 `security -i` 的
//! 交互模式并把命令经标准输入传入，密钥绝不出现在命令行参数（argv）里。
//!
//! 存储形式沿用 agents-manager 用的 Go 库 `github.com/zalando/go-keyring` 的写法：
//! `go-keyring-base64:` 前缀 + base64(value)，以兼容它已经写入的条目；读取同时接受
//! 这种形式和纯文本。
//!
//! 移植自 agents-manager 的 `internal/provider`（同一作者的 Go 项目，已在真实环境验证）。
use std::fmt;
use std::io;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

const BASE64_PREFIX: &str = "go-keyring-base64:";

/// `/usr/bin/security` 的一次调用：传给它的参数（argv，密钥绝不出现在这里），以及
/// 可选的标准输入内容（写入时用来传递含密钥的命令）。返回合并后的 stdout+stderr 与退出码。
pub type Runner = Box<dyn Fn(&[&str], Option<&str>) -> io::Result<(String, i32)> + Send + Sync>;

/// 读写钥匙串时可能发生的错误。
#[derive(Debug)]
pub enum KeyError {
    /// 钥匙串里没有这个条目。
    NotSet,
    /// 值的形状明显不是密钥（含空白字符或太短）。
    InvalidShape(String),
    /// 启动/运行 `security` 本身失败（找不到可执行文件、超时等）。
    Io(io::Error),
    /// `security` 以非预期的方式失败（非零退出码，且不是“未找到”）。
    Command(String),
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeyError::NotSet => write!(f, "API key is not set"),
            KeyError::InvalidShape(msg) => write!(f, "{msg}"),
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

/// 密钥里不会有空白字符，也不会只有几位。常见的误操作是剪贴板里其实是一条命令。
fn validate_shape(trimmed: &str) -> Result<(), KeyError> {
    if trimmed.is_empty() {
        return Err(KeyError::InvalidShape("API key is empty".to_string()));
    }
    if trimmed.chars().any(char::is_whitespace) || trimmed.chars().count() < 8 {
        return Err(KeyError::InvalidShape(
            "这看起来不是密钥（含空白字符或太短）。请确认复制的是密钥本身，而不是命令".to_string(),
        ));
    }
    Ok(())
}

/// 与 `github.com/zalando/go-keyring` 内部 shellescape.Quote 等价的最小 shell 转义：
/// 只包含 `[0-9A-Za-z_@%+=:,./-]` 时原样返回，否则用单引号包起来，
/// 内部单引号替换成 `'"'"'`。
fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    let safe = value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c));
    if safe {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn encode_value(value: &str) -> String {
    format!("{BASE64_PREFIX}{}", BASE64.encode(value.as_bytes()))
}

fn decode_value(stored: &str) -> Result<String, KeyError> {
    let trimmed = stored.trim();
    if let Some(rest) = trimmed.strip_prefix(BASE64_PREFIX) {
        let bytes = BASE64
            .decode(rest)
            .map_err(|e| KeyError::Command(format!("解码钥匙串里的值失败：{e}")))?;
        return Ok(String::from_utf8_lossy(&bytes).trim().to_string());
    }
    Ok(trimmed.to_string())
}

fn looks_not_found(stdout: &str) -> bool {
    stdout.to_ascii_lowercase().contains("could not be found")
}

/// 写入一个 generic password 条目；已存在时覆盖（`-U`）。密钥经标准输入传给
/// `security -i`，不出现在命令行参数里。
pub fn set_key(run: &Runner, service: &str, account: &str, value: &str) -> Result<(), KeyError> {
    let trimmed = value.trim();
    validate_shape(trimmed)?;

    let encoded = encode_value(trimmed);
    let command = format!(
        "add-generic-password -U -s {} -a {} -w {}\n",
        shell_quote(service),
        shell_quote(account),
        shell_quote(&encoded)
    );

    let (_stdout, code) = run(&["-i"], Some(&command))?;
    if code != 0 {
        // 不回传它的输出：我们喂给它的标准输入里含 base64(密钥)，它常把出错的那行原样吐回来，
        // 而这条消息会进界面横幅和后台服务日志。
        return Err(KeyError::Command(format!(
            "写入钥匙串失败（security 退出码 {code}）"
        )));
    }
    Ok(())
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

/// 删除一个 generic password 条目；本来就不存在不算错误。
pub fn delete_key(run: &Runner, service: &str, account: &str) -> Result<(), KeyError> {
    let (stdout, code) = run(
        &["delete-generic-password", "-s", service, "-a", account],
        None,
    )?;
    if code != 0 && !looks_not_found(&stdout) {
        return Err(KeyError::Command(format!(
            "security delete-generic-password failed with exit code {code}: {stdout}"
        )));
    }
    Ok(())
}

// ----- 按网关区分的密钥 -----

/// 旧的单网关设置迁移成的那一家；它的密钥还在不带后缀的旧账户里
const LEGACY_PROVIDER_ID: &str = symsync_core::codex_models::settings::LEGACY_PROVIDER_ID;
const MAX_PROVIDER_ID_LEN: usize = 64;

/// 某一家网关的密钥可能在的账户，按优先顺序。id 既来自设置也来自磁盘上的路由清单，
/// 只接受生成规则允许的字符（小写字母、数字、点、下划线、连字符，且不以连字符开头），其余一律拒绝。
fn provider_accounts(base_account: &str, provider_id: &str) -> Result<Vec<String>, KeyError> {
    let allowed = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c);
    if provider_id.is_empty()
        || provider_id.len() > MAX_PROVIDER_ID_LEN
        || provider_id.starts_with('-')
        || !provider_id.chars().all(allowed)
    {
        return Err(KeyError::Command("网关 id 不合法".to_owned()));
    }
    let mut accounts = vec![format!("{base_account}.{provider_id}")];
    if provider_id == LEGACY_PROVIDER_ID {
        accounts.push(base_account.to_owned());
    }
    Ok(accounts)
}

pub fn get_provider_key(
    run: &Runner,
    service: &str,
    base_account: &str,
    provider_id: &str,
) -> Result<String, KeyError> {
    for account in provider_accounts(base_account, provider_id)? {
        match get_key(run, service, &account) {
            Err(KeyError::NotSet) => continue,
            other => return other,
        }
    }
    Err(KeyError::NotSet)
}

/// 总是写进这一家自己的账户；迁移来的那一家从此不再依赖旧账户
pub fn set_provider_key(
    run: &Runner,
    service: &str,
    base_account: &str,
    provider_id: &str,
    value: &str,
) -> Result<(), KeyError> {
    let accounts = provider_accounts(base_account, provider_id)?;
    set_key(run, service, &accounts[0], value)
}

pub fn delete_provider_key(
    run: &Runner,
    service: &str,
    base_account: &str,
    provider_id: &str,
) -> Result<(), KeyError> {
    for account in provider_accounts(base_account, provider_id)? {
        delete_key(run, service, &account)?;
    }
    Ok(())
}

type FetchById = Box<dyn Fn(&str) -> Result<String, KeyError> + Send + Sync>;

/// `CachedKey` 的多网关版本：每家各自缓存，错误从不缓存
pub struct CachedKeys {
    fetch: FetchById,
    ttl: Duration,
    now: Box<dyn Fn() -> Instant + Send + Sync>,
    state: Mutex<std::collections::HashMap<String, (String, Instant)>>,
}

impl CachedKeys {
    pub fn new(
        fetch: impl Fn(&str) -> Result<String, KeyError> + Send + Sync + 'static,
        ttl: Duration,
        now: impl Fn() -> Instant + Send + Sync + 'static,
    ) -> Self {
        CachedKeys {
            fetch: Box::new(fetch),
            ttl,
            now: Box::new(now),
            state: Mutex::new(Default::default()),
        }
    }

    pub fn get(&self, provider_id: &str) -> Result<String, KeyError> {
        let now = (self.now)();
        if let Some((value, expires_at)) = self.state.lock().unwrap().get(provider_id) {
            if now < *expires_at {
                return Ok(value.clone());
            }
        }
        // 取密钥要起子进程，不占着锁：一家慢不拖住别家
        let fetched = (self.fetch)(provider_id);
        let mut state = self.state.lock().unwrap();
        match &fetched {
            Ok(value) => {
                state.insert(provider_id.to_owned(), (value.clone(), now + self.ttl));
            }
            Err(_) => {
                state.remove(provider_id);
            }
        }
        fetched
    }
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
            "钥匙串仅支持 macOS",
        ))
    })
}

/// 对某个取值函数的结果按 TTL 做短时缓存；缓存过期或从未取过时重新调用 `fetch`。
/// 错误从不缓存，下次调用总会重试。
pub struct CachedKey {
    fetch: Box<dyn Fn() -> Result<String, KeyError> + Send + Sync>,
    ttl: Duration,
    now: Box<dyn Fn() -> Instant + Send + Sync>,
    state: Mutex<Option<(String, Instant)>>,
}

impl CachedKey {
    pub fn new(
        fetch: impl Fn() -> Result<String, KeyError> + Send + Sync + 'static,
        ttl: Duration,
        now: impl Fn() -> Instant + Send + Sync + 'static,
    ) -> Self {
        CachedKey {
            fetch: Box::new(fetch),
            ttl,
            now: Box::new(now),
            state: Mutex::new(None),
        }
    }

    pub fn get(&self) -> Result<String, KeyError> {
        let now = (self.now)();
        let mut state = self.state.lock().unwrap();
        if let Some((value, expires_at)) = state.as_ref() {
            if now < *expires_at {
                return Ok(value.clone());
            }
        }
        match (self.fetch)() {
            Ok(value) => {
                *state = Some((value.clone(), now + self.ttl));
                Ok(value)
            }
            Err(e) => {
                *state = None;
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;

    #[derive(Debug, Clone)]
    struct RecordedCall {
        args: Vec<String>,
        stdin: Option<String>,
    }

    /// 记录每次调用的 argv 与 stdin 的假 runner；从不触碰真实钥匙串。
    struct FakeSecurity {
        calls: StdMutex<Vec<RecordedCall>>,
        // service -> account -> stored raw value（模拟钥匙串条目的存储原文）
        entries: StdMutex<std::collections::HashMap<(String, String), String>>,
    }

    impl FakeSecurity {
        fn new() -> Arc<Self> {
            Arc::new(FakeSecurity {
                calls: StdMutex::new(Vec::new()),
                entries: StdMutex::new(std::collections::HashMap::new()),
            })
        }

        fn runner(self: &Arc<Self>) -> Runner {
            let this = Arc::clone(self);
            Box::new(move |args, stdin| this.run(args, stdin))
        }

        fn run(&self, args: &[&str], stdin: Option<&str>) -> io::Result<(String, i32)> {
            self.calls.lock().unwrap().push(RecordedCall {
                args: args.iter().map(|s| s.to_string()).collect(),
                stdin: stdin.map(|s| s.to_string()),
            });

            match args.first().copied() {
                Some("-i") => {
                    let command = stdin.expect("write 必须带 stdin");
                    // add-generic-password -U -s <service> -a <account> -w <value>
                    let (service, account, value) = parse_add_command(command);
                    self.entries
                        .lock()
                        .unwrap()
                        .insert((service, account), value);
                    Ok((String::new(), 0))
                }
                Some("find-generic-password") => {
                    let service = args[2].to_string();
                    let account = args[4].to_string();
                    match self
                        .entries
                        .lock()
                        .unwrap()
                        .get(&(service, account))
                        .cloned()
                    {
                        Some(value) => Ok((format!("{value}\n"), 0)),
                        None => Ok((
                            "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n".to_string(),
                            44,
                        )),
                    }
                }
                Some("delete-generic-password") => {
                    let service = args[2].to_string();
                    let account = args[4].to_string();
                    match self.entries.lock().unwrap().remove(&(service, account)) {
                        Some(_) => Ok((String::new(), 0)),
                        None => Ok((
                            "security: SecKeychainItemDelete: The specified item could not be found in the keychain.\n".to_string(),
                            44,
                        )),
                    }
                }
                _ => Ok((String::new(), 0)),
            }
        }

        fn calls(&self) -> Vec<RecordedCall> {
            self.calls.lock().unwrap().clone()
        }
    }

    /// 从假 runner 记录的 stdin 命令里抠出 service/account/value（去掉 shell 引号）。
    fn parse_add_command(command: &str) -> (String, String, String) {
        let tokens = shell_split(command.trim());
        let mut service = String::new();
        let mut account = String::new();
        let mut value = String::new();
        let mut i = 0;
        while i < tokens.len() {
            match tokens[i].as_str() {
                "-s" => {
                    service = tokens[i + 1].clone();
                    i += 2;
                }
                "-a" => {
                    account = tokens[i + 1].clone();
                    i += 2;
                }
                "-w" => {
                    value = tokens[i + 1].clone();
                    i += 2;
                }
                _ => i += 1,
            }
        }
        (service, account, value)
    }

    /// 极简 shell 分词，够用来解析我们自己生成的 add-generic-password 命令即可：
    /// 支持空格分隔和单引号包裹（含 `'"'"'` 转义单引号的还原）。
    fn shell_split(input: &str) -> Vec<String> {
        let mut tokens = Vec::new();
        let mut chars = input.chars().peekable();
        let mut current = String::new();
        let mut in_token = false;
        while let Some(c) = chars.next() {
            if c == '\'' {
                in_token = true;
                loop {
                    match chars.next() {
                        Some('\'') => {
                            // 可能是 '"'"' 转义序列：紧跟 "'"
                            if chars.peek() == Some(&'"') {
                                chars.next();
                                if chars.peek() == Some(&'\'') {
                                    chars.next();
                                }
                                if chars.peek() == Some(&'"') {
                                    chars.next();
                                }
                                if chars.peek() == Some(&'\'') {
                                    chars.next();
                                    current.push('\'');
                                    continue;
                                }
                            }
                            break;
                        }
                        Some(c) => current.push(c),
                        None => break,
                    }
                }
            } else if c.is_whitespace() {
                if in_token || !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                    in_token = false;
                }
            } else {
                current.push(c);
                in_token = true;
            }
        }
        if in_token || !current.is_empty() {
            tokens.push(current);
        }
        tokens
    }

    #[test]
    fn set_and_get_key_round_trip() {
        let fake = FakeSecurity::new();
        let run = fake.runner();

        match get_key(&run, "symsync", "wecode") {
            Err(KeyError::NotSet) => {}
            other => panic!("expected NotSet, got {other:?}"),
        }

        set_key(&run, "symsync", "wecode", "  sk-abc-123456  \n").unwrap();
        let got = get_key(&run, "symsync", "wecode").unwrap();
        assert_eq!(got, "sk-abc-123456");

        assert!(set_key(&run, "symsync", "wecode", "   ").is_err());

        delete_key(&run, "symsync", "wecode").unwrap();
        match get_key(&run, "symsync", "wecode") {
            Err(KeyError::NotSet) => {}
            other => panic!("expected NotSet after delete, got {other:?}"),
        }
        // 删除一个已经不存在的条目不是错误。
        delete_key(&run, "symsync", "wecode").unwrap();
    }

    /// 真实发生过：复制命令时剪贴板里的密钥被命令文本顶掉，结果把整条命令当成密钥存了进去。
    /// 密钥里不会有空白字符，含空白的内容一律拒绝，并且不能覆盖已有的密钥。
    #[test]
    fn set_key_rejects_values_that_cannot_be_a_key() {
        let fake = FakeSecurity::new();
        let run = fake.runner();

        set_key(&run, "symsync", "wecode", "sk-good-123456").unwrap();
        for bad in [
            "cd /Users/x && pbpaste | ./bin/agents-manager set-key",
            "sk-abc def",
            "line1\nline2",
            "short",
        ] {
            assert!(set_key(&run, "symsync", "wecode", bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            get_key(&run, "symsync", "wecode").unwrap(),
            "sk-good-123456"
        );
    }

    #[test]
    fn secret_never_appears_in_argv() {
        let fake = FakeSecurity::new();
        let run = fake.runner();
        let secret = "sk-super-secret-value";
        set_key(&run, "svc", "acct", secret).unwrap();

        let mut saw_stdin_with_secret_material = false;
        for call in fake.calls() {
            for arg in &call.args {
                assert!(!arg.contains(secret), "secret leaked into argv: {arg:?}");
            }
            // 密钥本身也不该以明文出现在 stdin 里：它先经 base64 编码。
            if let Some(stdin) = &call.stdin {
                assert!(
                    !stdin.contains(secret),
                    "secret leaked into stdin verbatim: {stdin:?}"
                );
                saw_stdin_with_secret_material = true;
            }
        }
        assert!(saw_stdin_with_secret_material, "写入应当经过 stdin");
    }

    #[test]
    fn reading_accepts_plain_value_for_compat() {
        let fake = FakeSecurity::new();
        fake.entries.lock().unwrap().insert(
            ("svc".to_string(), "acct".to_string()),
            "plain-not-encoded".to_string(),
        );
        let run = fake.runner();
        assert_eq!(get_key(&run, "svc", "acct").unwrap(), "plain-not-encoded");
    }

    #[test]
    fn cached_key_ttl_and_never_caches_errors() {
        let now = Arc::new(StdMutex::new(Instant::now()));
        let now_clone = Arc::clone(&now);
        let calls = Arc::new(StdMutex::new(0));
        let calls_clone = Arc::clone(&calls);
        let value = Arc::new(StdMutex::new("k1".to_string()));
        let value_clone = Arc::clone(&value);
        let fail = Arc::new(StdMutex::new(false));
        let fail_clone = Arc::clone(&fail);

        let cached = CachedKey::new(
            move || {
                *calls_clone.lock().unwrap() += 1;
                if *fail_clone.lock().unwrap() {
                    return Err(KeyError::Command("boom".to_string()));
                }
                Ok(value_clone.lock().unwrap().clone())
            },
            Duration::from_secs(30),
            move || *now_clone.lock().unwrap(),
        );

        for _ in 0..3 {
            assert_eq!(cached.get().unwrap(), "k1");
        }
        assert_eq!(*calls.lock().unwrap(), 1, "TTL 内只应取一次");

        *value.lock().unwrap() = "k2".to_string();
        *now.lock().unwrap() += Duration::from_secs(31);
        assert_eq!(cached.get().unwrap(), "k2");
        assert_eq!(*calls.lock().unwrap(), 2);

        *fail.lock().unwrap() = true;
        *now.lock().unwrap() += Duration::from_secs(31);
        assert!(cached.get().is_err());

        *fail.lock().unwrap() = false;
        // 错误不缓存：下一次立刻重试并成功，不必等 TTL。
        assert_eq!(cached.get().unwrap(), "k2");
    }
}

#[cfg(test)]
mod hardening_tests {
    use super::*;

    /// 终审发现：`security -i` 失败时把它的 stdout 回传进错误信息，而我们喂给它的
    /// 标准输入里含 base64(密钥)。这条消息会进界面横幅和后台服务日志。
    #[test]
    fn a_failing_write_never_echoes_the_secret() {
        let secret = "sk-super-secret-value-123456";
        let encoded = encode_value(secret);
        let leaked = format!("security: error at line 1: add-generic-password -w {encoded}");
        let runner: Runner = Box::new(move |_args, _stdin| Ok((leaked.clone(), 1)));
        let error = set_key(&runner, "svc", "acct", secret)
            .unwrap_err()
            .to_string();
        assert!(
            !error.contains(secret) && !error.contains(&encode_value(secret)),
            "错误信息泄漏了密钥: {error}"
        );
        assert!(error.contains('1'), "仍要说明失败原因: {error}");
    }
}

#[cfg(test)]
mod provider_key_tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;

    const NOT_FOUND: &str =
        "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.";

    /// 假钥匙串：账户名 -> 明文；记录每次被问到的账户
    fn fake(entries: &[(&str, &str)]) -> (Runner, Arc<StdMutex<Vec<String>>>) {
        let entries: Vec<(String, String)> = entries
            .iter()
            .map(|(a, v)| (a.to_string(), v.to_string()))
            .collect();
        let asked = Arc::new(StdMutex::new(Vec::new()));
        let log = asked.clone();
        let runner: Runner = Box::new(move |args, _stdin| {
            let account = args.last().copied().unwrap_or_default().to_owned();
            log.lock().unwrap().push(format!("{} {account}", args[0]));
            Ok(match entries.iter().find(|(a, _)| *a == account) {
                Some((_, value)) => (format!("{value}\n"), 0),
                None => (NOT_FOUND.to_owned(), 44),
            })
        });
        (runner, asked)
    }

    #[test]
    fn each_provider_has_its_own_account() {
        let (runner, _) = fake(&[
            ("codex-gateway.wecode", "sk-wecode-key"),
            ("codex-gateway.other", "sk-other-key"),
        ]);
        let get = |id: &str| get_provider_key(&runner, "symsync", "codex-gateway", id);
        assert_eq!(get("wecode").unwrap(), "sk-wecode-key");
        assert_eq!(get("other").unwrap(), "sk-other-key");
        assert!(matches!(get("third"), Err(KeyError::NotSet)));
    }

    /// 旧的单网关设置迁移成 id 为 default 的一家，它的密钥还在旧账户里：读得到，且新账户优先
    #[test]
    fn the_migrated_provider_falls_back_to_the_old_account() {
        let (runner, asked) = fake(&[("codex-gateway", "sk-old-key")]);
        assert_eq!(
            get_provider_key(&runner, "symsync", "codex-gateway", "default").unwrap(),
            "sk-old-key"
        );
        assert_eq!(
            *asked.lock().unwrap(),
            [
                "find-generic-password codex-gateway.default",
                "find-generic-password codex-gateway"
            ]
        );
        let (runner, _) = fake(&[
            ("codex-gateway", "sk-old-key"),
            ("codex-gateway.default", "sk-new-key"),
        ]);
        assert_eq!(
            get_provider_key(&runner, "symsync", "codex-gateway", "default").unwrap(),
            "sk-new-key"
        );
        // 别的网关绝不回退到旧账户：那是另一家的密钥
        let (runner, _) = fake(&[("codex-gateway", "sk-old-key")]);
        assert!(matches!(
            get_provider_key(&runner, "symsync", "codex-gateway", "wecode"),
            Err(KeyError::NotSet)
        ));
    }

    /// 路由里的网关 id 来自磁盘上的清单：只接受生成规则允许的字符，别的一律不去碰钥匙串
    #[test]
    fn ids_outside_the_allowed_alphabet_never_reach_the_keychain() {
        let (runner, asked) = fake(&[("codex-gateway", "sk-old-key")]);
        for id in [
            "",
            "a b",
            "A",
            "../x",
            "a/b",
            "-s",
            "wecode\n",
            &"x".repeat(65),
        ] {
            assert!(
                get_provider_key(&runner, "symsync", "codex-gateway", id).is_err(),
                "{id:?}"
            );
            assert!(delete_provider_key(&runner, "symsync", "codex-gateway", id).is_err());
            assert!(
                set_provider_key(&runner, "symsync", "codex-gateway", id, "sk-12345678").is_err()
            );
        }
        assert!(asked.lock().unwrap().is_empty());
    }

    /// 删掉迁移来的那一家时，旧账户里的密钥也要删，否则它永远留在钥匙串里
    #[test]
    fn deleting_the_migrated_provider_also_clears_the_old_account() {
        let (runner, asked) = fake(&[]);
        delete_provider_key(&runner, "symsync", "codex-gateway", "default").unwrap();
        delete_provider_key(&runner, "symsync", "codex-gateway", "wecode").unwrap();
        assert_eq!(
            *asked.lock().unwrap(),
            [
                "delete-generic-password codex-gateway.default",
                "delete-generic-password codex-gateway",
                "delete-generic-password codex-gateway.wecode"
            ]
        );
    }

    #[test]
    fn cached_keys_are_kept_per_provider_and_errors_are_not_cached() {
        let calls = Arc::new(StdMutex::new(Vec::<String>::new()));
        let log = calls.clone();
        let cache = CachedKeys::new(
            move |id: &str| {
                log.lock().unwrap().push(id.to_owned());
                match id {
                    "bad" => Err(KeyError::NotSet),
                    other => Ok(format!("key-of-{other}")),
                }
            },
            Duration::from_secs(30),
            Instant::now,
        );
        assert_eq!(cache.get("a").unwrap(), "key-of-a");
        assert_eq!(cache.get("b").unwrap(), "key-of-b");
        assert_eq!(cache.get("a").unwrap(), "key-of-a");
        assert!(cache.get("bad").is_err());
        assert!(cache.get("bad").is_err());
        assert_eq!(*calls.lock().unwrap(), ["a", "b", "bad", "bad"]);
    }
}
