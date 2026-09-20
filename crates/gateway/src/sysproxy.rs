//! 读取 macOS 系统 HTTP/HTTPS 代理设置（`scutil --proxy`）并应用到出站请求。
//!
//! launchd 拉起的后台进程不继承用户 shell 的环境变量，即使用户的终端里配置了
//! `HTTP_PROXY`/`HTTPS_PROXY`，后台进程也看不到；而系统级代理（系统设置 > 网络 > 代理，
//! 通过 `scutil --proxy` 读取）对所有进程生效。这里的规则：环境变量存在就完全按环境变量
//! 的规则（含 `NO_PROXY`）来；否则退到系统代理设置，按 TTL 缓存，加载失败则直连。
//!
//! 移植自 agents-manager 的 `internal/sysproxy`（同一作者的 Go 项目，已在真实环境验证）。
use std::sync::Mutex;
use std::time::{Duration, Instant};

use url::Url;

/// `scutil --proxy` 输出中与转发相关的子集：各代理是否启用、host/port，以及例外列表。
/// SOCKS 与 PAC 不在范围内，忽略。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Settings {
    pub http_enabled: bool,
    pub http_host: String,
    pub http_port: u16,

    pub https_enabled: bool,
    pub https_host: String,
    pub https_port: u16,

    /// 原样保留 scutil 打印的 ExceptionsList 条目顺序，例如
    /// "*.weibo.com"、"192.168.0.0/16"、"<local>"。
    pub exceptions: Vec<String>,
}

/// 解析 `/usr/sbin/scutil --proxy` 打印的文本。
pub fn parse(scutil_output: &str) -> Settings {
    let mut settings = Settings::default();
    let mut in_exceptions = false;

    for line in scutil_output.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if in_exceptions {
            if trimmed == "}" {
                in_exceptions = false;
                continue;
            }
            if let Some((_, value)) = split_key_value(trimmed) {
                settings.exceptions.push(value.to_string());
            }
            continue;
        }

        if trimmed.starts_with("ExceptionsList") {
            in_exceptions = true;
            continue;
        }

        let Some((key, value)) = split_key_value(trimmed) else {
            continue;
        };
        match key {
            "HTTPEnable" => settings.http_enabled = value == "1",
            "HTTPPort" => settings.http_port = value.parse().unwrap_or(0),
            "HTTPProxy" => settings.http_host = value.to_string(),
            "HTTPSEnable" => settings.https_enabled = value == "1",
            "HTTPSPort" => settings.https_port = value.parse().unwrap_or(0),
            "HTTPSProxy" => settings.https_host = value.to_string(),
            _ => {}
        }
    }

    settings
}

/// 切分 scutil 的 "Key : value" 或 "N : value" 行。
fn split_key_value(line: &str) -> Option<(&str, &str)> {
    let idx = line.find(" : ")?;
    Some((line[..idx].trim(), line[idx + 3..].trim()))
}

/// host（不含端口）是否指向本机回环接口；回环地址无论代理设置或例外列表如何，一律直连。
fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

/// host 是否被 exceptions 中的某一条覆盖。大小写不敏感，支持：
/// - 精确主机名
/// - `*.suffix` 通配（同时匹配裸的 suffix 本身）
/// - CIDR 网段（仅对 IP 字面量生效）
/// - `<local>`：主机名中不含点号
fn matches_exception(host: &str, exceptions: &[String]) -> bool {
    let host_lower = host.to_ascii_lowercase();
    let ip = host.parse::<std::net::IpAddr>().ok();

    for raw in exceptions {
        let exc = raw.trim().to_ascii_lowercase();
        if exc.is_empty() {
            continue;
        }

        if exc == "<local>" {
            if ip.is_none() && !host_lower.contains('.') {
                return true;
            }
            continue;
        }

        if let Some(suffix) = exc.strip_prefix("*.") {
            if host_lower == suffix || host_lower.ends_with(&format!(".{suffix}")) {
                return true;
            }
            continue;
        }

        if exc.contains('/') {
            let Some(ip) = ip else { continue };
            if cidr_contains(&exc, ip) {
                return true;
            }
            continue;
        }

        if host_lower == exc {
            return true;
        }
    }

    false
}

/// 极简 CIDR 判断，只支持 IPv4/IPv6 字面量前缀。
fn cidr_contains(cidr: &str, ip: std::net::IpAddr) -> bool {
    let Some((base, bits)) = cidr.split_once('/') else {
        return false;
    };
    let Ok(bits) = bits.parse::<u32>() else {
        return false;
    };
    match (base.parse::<std::net::IpAddr>(), ip) {
        (Ok(std::net::IpAddr::V4(base)), std::net::IpAddr::V4(ip)) => {
            if bits > 32 {
                return false;
            }
            let mask = if bits == 0 {
                0
            } else {
                u32::MAX << (32 - bits)
            };
            (u32::from(base) & mask) == (u32::from(ip) & mask)
        }
        (Ok(std::net::IpAddr::V6(base)), std::net::IpAddr::V6(ip)) => {
            if bits > 128 {
                return false;
            }
            let mask = if bits == 0 {
                0u128
            } else {
                u128::MAX << (128 - bits)
            };
            (u128::from(base) & mask) == (u128::from(ip) & mask)
        }
        _ => false,
    }
}

impl Settings {
    /// `u` 应当经过的代理地址；`None` 表示直连。
    pub fn proxy_for(&self, u: &Url) -> Option<Url> {
        let host = u.host_str()?;
        if host.is_empty() {
            return None;
        }
        if is_loopback_host(host) {
            return None;
        }
        if matches_exception(host, &self.exceptions) {
            return None;
        }

        if u.scheme().eq_ignore_ascii_case("https") {
            proxy_url(self.https_enabled, &self.https_host, self.https_port)
        } else {
            proxy_url(self.http_enabled, &self.http_host, self.http_port)
        }
    }
}

fn proxy_url(enabled: bool, host: &str, port: u16) -> Option<Url> {
    if !enabled || host.is_empty() || port == 0 {
        return None;
    }
    Url::parse(&format!("http://{host}:{port}")).ok()
}

/// 环境变量里配置的代理：`HTTP_PROXY`/`HTTPS_PROXY`（大小写形式皆可）及 `NO_PROXY`。
#[derive(Debug, Clone, Default)]
struct EnvProxy {
    http: Option<Url>,
    https: Option<Url>,
    no_proxy: Vec<String>,
}

fn env_var(names: &[&str]) -> Option<String> {
    for name in names {
        if let Ok(value) = std::env::var(name) {
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

/// 是否设置了 HTTP(S)_PROXY（大小写形式皆可）。设置了就完全交给环境变量规则处理，
/// 不再看系统代理设置。
fn has_env_proxy() -> bool {
    env_var(&["HTTP_PROXY", "http_proxy"]).is_some()
        || env_var(&["HTTPS_PROXY", "https_proxy"]).is_some()
}

impl EnvProxy {
    fn from_env() -> Option<Self> {
        if !has_env_proxy() {
            return None;
        }
        let http = env_var(&["HTTP_PROXY", "http_proxy"]).and_then(|v| Url::parse(&v).ok());
        let https = env_var(&["HTTPS_PROXY", "https_proxy"]).and_then(|v| Url::parse(&v).ok());
        let no_proxy = env_var(&["NO_PROXY", "no_proxy"])
            .map(|v| {
                v.split(',')
                    .map(|s| s.trim().to_ascii_lowercase())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        Some(EnvProxy {
            http,
            https,
            no_proxy,
        })
    }

    fn resolve(&self, url: &Url) -> Option<Url> {
        let host = url.host_str()?;
        if no_proxy_matches(host, &self.no_proxy) {
            return None;
        }
        if url.scheme().eq_ignore_ascii_case("https") {
            self.https.clone()
        } else {
            self.http.clone()
        }
    }
}

/// `NO_PROXY` 的匹配规则：`*` 匹配一切；`.suffix` 或裸 `suffix` 都按后缀匹配
/// （同时匹配裸域名本身）；其余按精确主机名匹配。大小写不敏感。
fn no_proxy_matches(host: &str, no_proxy: &[String]) -> bool {
    let host_lower = host.to_ascii_lowercase();
    for entry in no_proxy {
        if entry == "*" {
            return true;
        }
        let suffix = entry.strip_prefix('.').unwrap_or(entry);
        if host_lower == suffix || host_lower.ends_with(&format!(".{suffix}")) {
            return true;
        }
    }
    false
}

struct Cache {
    settings: Settings,
    loaded_at: Instant,
}

/// 出站请求的代理选择：有环境变量代理设置就完全按环境变量的规则来（含 `NO_PROXY`），
/// 否则读取系统代理设置并按 TTL 缓存；加载失败则本次直连，且不缓存失败（下次重试）。
pub struct ProxyResolver {
    load: Box<dyn Fn() -> Result<String, String> + Send + Sync>,
    ttl: Duration,
    now: Box<dyn Fn() -> Instant + Send + Sync>,
    cache: Mutex<Option<Cache>>,
}

impl ProxyResolver {
    pub fn new(
        load: impl Fn() -> Result<String, String> + Send + Sync + 'static,
        ttl: Duration,
        now: impl Fn() -> Instant + Send + Sync + 'static,
    ) -> Self {
        ProxyResolver {
            load: Box::new(load),
            ttl,
            now: Box::new(now),
            cache: Mutex::new(None),
        }
    }

    /// 供路由接入 `reqwest::Proxy::custom(move |url| resolver.resolve(url))`。
    pub fn resolve(&self, url: &Url) -> Option<Url> {
        if let Some(env) = EnvProxy::from_env() {
            return env.resolve(url);
        }

        let now = (self.now)();
        // 先看缓存，取完就放锁：取系统代理设置要起子进程，最长 3 秒，
        // 不能占着锁让并发的请求排队（路由跑在 tokio 工作线程上）。
        let cached = {
            let guard = self.cache.lock().unwrap();
            match guard.as_ref() {
                Some(cache) if now.duration_since(cache.loaded_at) < self.ttl => {
                    Some(cache.settings.clone())
                }
                _ => None,
            }
        };
        if let Some(settings) = cached {
            return settings.proxy_for(url);
        }

        let settings = match (self.load)() {
            Ok(output) => parse(&output),
            // 加载失败：本次直连，不缓存失败，下次重试。
            Err(_) => return None,
        };
        let mut guard = self.cache.lock().unwrap();
        // 期间别人可能已经填过缓存，用更新的那份
        let fresher = guard
            .as_ref()
            .is_some_and(|cache| now.duration_since(cache.loaded_at) < self.ttl);
        if !fresher {
            *guard = Some(Cache {
                settings: settings.clone(),
                loaded_at: now,
            });
        }
        settings.proxy_for(url)
    }
}

/// 起一个子进程，最多等 `timeout`，超时就杀掉它。
///
/// 关键：`Child` 留在本线程，只把 `stdout` 交给读线程。曾经的写法把 `Child` 放进
/// `Mutex` 共享，读线程持锁调 `wait()` 等子进程退出，子进程一旦不退出，超时分支就
/// 永远拿不到锁——超时形同虚设，整个进程挂死。
#[cfg(target_os = "macos")]
fn run_with_timeout(program: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;

    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动 {program} 失败：{e}"))?;
    let mut stdout = child.stdout.take();

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(out) = stdout.as_mut() {
            let _ = out.read_to_string(&mut buf);
        }
        // 管道读到头就发结果；即使接收端已经超时离开也无妨
        let _ = tx.send(buf);
    });

    match rx.recv_timeout(timeout) {
        // stdout 已经关闭，子进程必然即将退出，这里的 wait 不会久等
        Ok(buf) => match child.wait() {
            Ok(status) if status.success() => Ok(buf),
            Ok(status) => Err(format!("{program} 退出码 {:?}", status.code())),
            Err(e) => Err(e.to_string()),
        },
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!("{program} 超时"))
        }
    }
}

/// 运行 `/usr/sbin/scutil --proxy`，3 秒超时。
#[cfg(target_os = "macos")]
pub fn load_scutil() -> Result<String, String> {
    run_with_timeout("/usr/sbin/scutil", &["--proxy"], Duration::from_secs(3))
}

/// 非 macOS 平台上不支持读取系统代理设置。
#[cfg(not(target_os = "macos"))]
pub fn load_scutil() -> Result<String, String> {
    Err("scutil 仅支持 macOS".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    const SCUTIL_FIXTURE: &str = "<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : 10.0.0.0/8
    3 : 172.16.0.0/12
    4 : localhost
    5 : *.local
    6 : *.crashlytics.com
    7 : <local>
    8 : *.sina.com.cn
    9 : *.weibo.com
  }
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}
";

    const SCUTIL_FIXTURE_DISABLED: &str = "<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
  }
  HTTPEnable : 0
  HTTPPort : 0
  HTTPProxy :
  HTTPSEnable : 0
  HTTPSPort : 0
  HTTPSProxy :
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
  SOCKSPort : 0
  SOCKSProxy : 0
}
";

    fn u(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }

    #[test]
    fn parse_fixture() {
        let s = parse(SCUTIL_FIXTURE);
        assert!(s.http_enabled);
        assert_eq!(s.http_host, "127.0.0.1");
        assert_eq!(s.http_port, 7897);
        assert!(s.https_enabled);
        assert_eq!(s.https_host, "127.0.0.1");
        assert_eq!(s.https_port, 7897);

        let want = [
            "127.0.0.1",
            "192.168.0.0/16",
            "10.0.0.0/8",
            "172.16.0.0/12",
            "localhost",
            "*.local",
            "*.crashlytics.com",
            "<local>",
            "*.sina.com.cn",
            "*.weibo.com",
        ];
        assert_eq!(s.exceptions, want);
    }

    #[test]
    fn parse_disabled() {
        let s = parse(SCUTIL_FIXTURE_DISABLED);
        assert!(!s.http_enabled);
        assert!(!s.https_enabled);
        assert_eq!(s.proxy_for(&u("https://chatgpt.com/")), None);
    }

    #[test]
    fn proxy_for_exception_rules() {
        let s = Settings {
            http_enabled: true,
            http_host: "127.0.0.1".into(),
            http_port: 7897,
            https_enabled: true,
            https_host: "127.0.0.1".into(),
            https_port: 7897,
            exceptions: vec![
                "example.com".into(),
                "*.weibo.com".into(),
                "192.168.0.0/16".into(),
                "<local>".into(),
            ],
        };

        let cases: &[(&str, &str, bool)] = &[
            ("exact match", "https://example.com/", false),
            (
                "exact match different subdomain not covered",
                "https://www.example.com/",
                true,
            ),
            ("wildcard bare domain", "https://weibo.com/", false),
            ("wildcard subdomain", "https://api.weibo.com/", false),
            ("wildcard case-insensitive", "https://API.WEIBO.COM/", false),
            (
                "wildcard must not match unrelated suffix",
                "https://notweibo.com/",
                true,
            ),
            ("cidr match", "http://192.168.1.5/", false),
            ("cidr no match outside range", "http://10.0.0.5/", true),
            ("local bare hostname", "http://myhost/", false),
            (
                "local does not match dotted host",
                "http://myhost.example/",
                true,
            ),
            (
                "loopback always direct even though not excepted",
                "http://127.0.0.1:9999/",
                false,
            ),
            (
                "loopback name always direct",
                "http://localhost:9999/",
                false,
            ),
            (
                "port on host is ignored for exceptions",
                "https://example.com:8443/",
                false,
            ),
            ("unrelated host is proxied", "https://chatgpt.com/", true),
        ];

        for (name, raw, want_proxy) in cases {
            let got = s.proxy_for(&u(raw));
            assert_eq!(got.is_some(), *want_proxy, "{name}: {raw}");
        }
    }

    #[test]
    fn proxy_for_http_vs_https_selection() {
        let s = Settings {
            http_enabled: true,
            http_host: "1.2.3.4".into(),
            http_port: 111,
            https_enabled: true,
            https_host: "5.6.7.8".into(),
            https_port: 222,
            exceptions: vec![],
        };
        let http_proxy = s.proxy_for(&u("http://chatgpt.com/")).unwrap();
        assert_eq!(http_proxy.host_str(), Some("1.2.3.4"));
        assert_eq!(http_proxy.port(), Some(111));

        let https_proxy = s.proxy_for(&u("https://chatgpt.com/")).unwrap();
        assert_eq!(https_proxy.host_str(), Some("5.6.7.8"));
        assert_eq!(https_proxy.port(), Some(222));
    }

    #[test]
    fn proxy_for_disabled_scheme_is_direct() {
        let s = Settings {
            http_enabled: false,
            https_enabled: true,
            https_host: "127.0.0.1".into(),
            https_port: 7897,
            ..Default::default()
        };
        assert_eq!(s.proxy_for(&u("http://chatgpt.com/")), None);
        assert!(s.proxy_for(&u("https://chatgpt.com/")).is_some());
    }

    /// 环境变量相关的测试会修改进程级环境变量，必须串行执行，否则彼此冲突。
    static ENV_GUARD: StdMutex<()> = StdMutex::new(());

    fn clear_proxy_env() {
        for name in [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "NO_PROXY",
            "no_proxy",
        ] {
            unsafe { std::env::remove_var(name) };
        }
    }

    #[test]
    fn proxy_func_env_precedence() {
        let _guard = ENV_GUARD.lock().unwrap();
        clear_proxy_env();
        unsafe { std::env::set_var("HTTP_PROXY", "http://envproxy.invalid:9999") };

        let load = || -> Result<String, String> {
            panic!("load should not be called when env proxy vars are set")
        };
        let resolver = ProxyResolver::new(load, Duration::from_secs(60), Instant::now);

        let got = resolver.resolve(&u("http://chatgpt.com/"));
        assert_eq!(got.unwrap().as_str(), "http://envproxy.invalid:9999/");

        // https 请求没有配置 HTTPS_PROXY，应当直连。
        let got_https = resolver.resolve(&u("https://chatgpt.com/"));
        assert_eq!(got_https, None);

        clear_proxy_env();
    }

    #[test]
    fn proxy_func_env_no_proxy_excludes_host() {
        let _guard = ENV_GUARD.lock().unwrap();
        clear_proxy_env();
        unsafe { std::env::set_var("HTTP_PROXY", "http://envproxy.invalid:9999") };
        unsafe { std::env::set_var("NO_PROXY", "weibo.com,.example.com") };

        let load = || -> Result<String, String> { panic!("load should not be called") };
        let resolver = ProxyResolver::new(load, Duration::from_secs(60), Instant::now);

        assert_eq!(resolver.resolve(&u("http://weibo.com/")), None);
        assert_eq!(resolver.resolve(&u("http://api.weibo.com/")), None);
        assert_eq!(resolver.resolve(&u("http://foo.example.com/")), None);
        assert!(resolver.resolve(&u("http://chatgpt.com/")).is_some());

        clear_proxy_env();
    }

    #[test]
    fn proxy_func_uses_system_settings_and_caches_with_ttl() {
        let _guard = ENV_GUARD.lock().unwrap();
        clear_proxy_env();

        let load_calls = Arc::new(StdMutex::new(0));
        let load_calls_clone = Arc::clone(&load_calls);
        let load = move || -> Result<String, String> {
            *load_calls_clone.lock().unwrap() += 1;
            Ok(SCUTIL_FIXTURE.to_string())
        };

        let base = Instant::now();
        let cur = Arc::new(StdMutex::new(base));
        let cur_clone = Arc::clone(&cur);
        let now = move || *cur_clone.lock().unwrap();

        let resolver = ProxyResolver::new(load, Duration::from_secs(60), now);

        let got = resolver.resolve(&u("https://chatgpt.com/")).unwrap();
        assert_eq!(got.host_str(), Some("127.0.0.1"));
        assert_eq!(got.port(), Some(7897));
        assert_eq!(*load_calls.lock().unwrap(), 1);

        // TTL 内：不重新加载。
        *cur.lock().unwrap() = base + Duration::from_secs(30);
        resolver.resolve(&u("https://chatgpt.com/"));
        assert_eq!(*load_calls.lock().unwrap(), 1);

        // 过了 TTL：重新加载。
        *cur.lock().unwrap() = base + Duration::from_secs(61);
        resolver.resolve(&u("https://chatgpt.com/"));
        assert_eq!(*load_calls.lock().unwrap(), 2);
    }

    #[test]
    fn proxy_func_load_error_falls_back_to_direct() {
        let _guard = ENV_GUARD.lock().unwrap();
        clear_proxy_env();

        let load = || -> Result<String, String> { Err("fake load failure".to_string()) };
        let resolver = ProxyResolver::new(load, Duration::from_secs(60), Instant::now);

        let got = resolver.resolve(&u("https://chatgpt.com/"));
        assert_eq!(got, None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn load_scutil_real_output_has_expected_shape() {
        let out = load_scutil().expect("scutil --proxy 应当成功");
        assert!(out.contains("HTTPEnable"));
    }
}

#[cfg(test)]
mod hardening_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// 终审发现：子进程不退出时，读线程持锁等它，超时分支拿不到锁，于是永久挂起。
    /// 挂在常驻进程里，官方和第三方模型会同时不可用。
    #[cfg(target_os = "macos")]
    #[test]
    fn a_hanging_child_process_still_times_out() {
        let started = Instant::now();
        // 一个永不退出、也不关闭 stdout 的子进程
        let result = run_with_timeout("/bin/sh", &["-c", "sleep 60"], Duration::from_millis(300));
        assert!(result.is_err(), "应当超时返回错误");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "超时没有生效，耗时 {:?}",
            started.elapsed()
        );
    }

    /// 取系统代理设置不能长时间占着锁：否则并发的请求都被串在一起等
    #[test]
    fn slow_loads_do_not_serialize_callers() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&calls);
        let resolver = Arc::new(ProxyResolver::new(
            move || {
                counter.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(300));
                Ok("<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 7897\n}".to_owned())
            },
            Duration::from_secs(60),
            Instant::now,
        ));
        let started = Instant::now();
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let resolver = Arc::clone(&resolver);
                std::thread::spawn(move || {
                    let url = Url::parse("https://chatgpt.com/").unwrap();
                    resolver.resolve(&url)
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(results.iter().all(|r| r.is_some()), "都应当拿到代理");
        assert!(
            started.elapsed() < Duration::from_millis(900),
            "四个调用被串行化了，耗时 {:?}",
            started.elapsed()
        );
    }
}
