//! Sophia 起的子进程（「连接 Claude 用量」的安装脚本与 `claude auth login`、后台用量探测）用什么代理
//! （spec #195「修订（2026-10-07）：代理」）。
//!
//! 命令行程序（Claude Code、安装脚本里的 curl）不读 macOS 网络设置，只认环境变量；从 Dock 打开的 Sophia
//! 自己没有这些变量（#218 实测），于是浏览器能上外网、子进程却连不上。按顺序找：
//! 1. 本进程环境里已经有代理变量（从终端启动）：探测的环境白名单本来就带上它们，这里什么都不加；
//! 2. 用户登录 shell 里的代理变量（给开发者，沿用 `login_env` 问登录 shell 的那一次）；
//! 3. macOS 系统代理（`scutil --proxy`：HTTP / HTTPS / SOCKS + 例外列表 → `NO_PROXY`）——机场客户端
//!    默认打开的「系统代理」开关就写在这里，给小白；
//! 4. 都没有就直连（增强模式 / TUN、商业 VPN 本来就通）。
//!
//! 自动代理（PAC）本版不支持，按没有代理处理；网络失败的「!」详情里有一句换增强模式 / TUN 的出路。
//!
//! SOCKS：Claude Code 不支持 SOCKS 代理，只认 `HTTPS_PROXY` / `HTTP_PROXY`（官方文档
//! https://code.claude.com/docs/en/network-config）；安装脚本里的 curl 认 `ALL_PROXY` 的 socks。所以登录 shell
//! 只给了 `ALL_PROXY` 时，再用系统代理里的 HTTP / HTTPS 补上；系统代理也只开了 SOCKS 时照传——安装能成，
//! 登录与后台探测仍连不上（按网络失败提示）。
use crate::login_env::{LoginEnv, PROXY_VARS};
use crate::sysproxy::Settings;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 本机地址永远直连：`claude auth login` 的回调、Sophia 自己的本机路由
const ALWAYS_DIRECT: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

/// 父环境里有没有设代理（只看三种代理地址，大小写都算；只有 `NO_PROXY` 不算）
pub fn has_proxy<'a>(mut keys: impl Iterator<Item = (&'a str, &'a str)>) -> bool {
    keys.any(|(key, value)| {
        !value.trim().is_empty()
            && ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"]
                .iter()
                .any(|k| key.eq_ignore_ascii_case(k))
    })
}

/// 有没有 Claude Code 认的代理（`HTTPS_PROXY` / `HTTP_PROXY`，大小写都算）
fn has_http_proxy<'a>(mut keys: impl Iterator<Item = (&'a str, &'a str)>) -> bool {
    keys.any(|(key, value)| {
        !value.trim().is_empty()
            && ["HTTPS_PROXY", "HTTP_PROXY"]
                .iter()
                .any(|k| key.eq_ignore_ascii_case(k))
    })
}

/// 登录 shell 里设了的代理变量（空值不算）
fn login_proxy(login: Option<&LoginEnv>) -> Vec<(String, String)> {
    login
        .map(|login| {
            login
                .proxy
                .iter()
                .filter(|(key, value)| {
                    PROXY_VARS.contains(&key.as_str()) && !value.trim().is_empty()
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// 还要不要去读系统代理：登录 shell 没给 Claude Code 认的 HTTP(S) 代理（什么都没给，或只给了 SOCKS）
fn needs_system(login: Option<&LoginEnv>) -> bool {
    let set = login_proxy(login);
    !has_http_proxy(set.iter().map(|(k, v)| (k.as_str(), v.as_str())))
}

/// 按上面的顺序算出要额外带给子进程的代理变量（大小写各一份，curl 认小写、Node 两种都认）。
/// `parent_has_proxy` 为真时返回空（白名单已带上）；`system` 是读到的系统代理（读不到为 None）。
/// 登录 shell 只给了 SOCKS 时，登录 shell 的照带，再从系统代理补 HTTP / HTTPS（与它们的 NO_PROXY，
/// 登录 shell 自己设了 NO_PROXY 就不补）
pub fn resolve(
    parent_has_proxy: bool,
    login: Option<&LoginEnv>,
    system: Option<&Settings>,
) -> Vec<(String, String)> {
    if parent_has_proxy {
        return Vec::new();
    }
    let set = login_proxy(login);
    let pairs = || set.iter().map(|(k, v)| (k.as_str(), v.as_str()));
    if has_http_proxy(pairs()) {
        return set;
    }
    if !has_proxy(pairs()) {
        // 登录 shell 什么代理都没给（只设 NO_PROXY 也算没给）：用系统代理
        return system.map(from_system).unwrap_or_default();
    }
    // 只有 SOCKS：系统代理里的 HTTP / HTTPS 补上（系统那边的 SOCKS 不要，登录 shell 的优先）
    let login_has_no_proxy = set.iter().any(|(k, _)| k.eq_ignore_ascii_case("NO_PROXY"));
    let mut out = set.clone();
    if let Some(system) = system {
        let http_only = Settings {
            socks_enabled: false,
            ..system.clone()
        };
        out.extend(
            from_system(&http_only)
                .into_iter()
                .filter(|(k, _)| !(login_has_no_proxy && k.eq_ignore_ascii_case("NO_PROXY"))),
        );
    }
    out
}

/// 系统代理 → 环境变量。HTTPS 代理给 `HTTPS_PROXY`、HTTP 代理给 `HTTP_PROXY`、SOCKS 给 `ALL_PROXY`
/// （`socks5h`：域名也交给代理解析，curl 认）；例外列表 + 本机地址给 `NO_PROXY`。一个都没开就是空
fn from_system(settings: &Settings) -> Vec<(String, String)> {
    let endpoint = |enabled: bool, host: &str, port: u16| {
        (enabled && !host.trim().is_empty() && port != 0).then(|| format!("{}:{port}", host.trim()))
    };
    let mut pairs: Vec<(&str, String)> = Vec::new();
    if let Some(at) = endpoint(
        settings.https_enabled,
        &settings.https_host,
        settings.https_port,
    ) {
        pairs.push(("HTTPS_PROXY", format!("http://{at}")));
    }
    if let Some(at) = endpoint(
        settings.http_enabled,
        &settings.http_host,
        settings.http_port,
    ) {
        pairs.push(("HTTP_PROXY", format!("http://{at}")));
    }
    if let Some(at) = endpoint(
        settings.socks_enabled,
        &settings.socks_host,
        settings.socks_port,
    ) {
        pairs.push(("ALL_PROXY", format!("socks5h://{at}")));
    }
    if pairs.is_empty() {
        return Vec::new();
    }
    pairs.push(("NO_PROXY", no_proxy(&settings.exceptions)));
    pairs
        .into_iter()
        .flat_map(|(key, value)| {
            [
                (key.to_owned(), value.clone()),
                (key.to_ascii_lowercase(), value),
            ]
        })
        .collect()
}

/// 例外列表 → `NO_PROXY`：`*.example.com` 写成 `.example.com`（curl 与 Node 都按后缀认），
/// `<local>`（不带点的主机名）没有对应写法、略过，其余（主机名、IP、网段）原样；本机地址在最前，去重
fn no_proxy(exceptions: &[String]) -> String {
    let mut out: Vec<String> = ALWAYS_DIRECT.iter().map(|s| s.to_string()).collect();
    for raw in exceptions {
        let entry = raw.trim();
        if entry.is_empty() || entry.eq_ignore_ascii_case("<local>") {
            continue;
        }
        let entry = match entry.strip_prefix("*.") {
            Some(suffix) => format!(".{suffix}"),
            None => entry.trim_start_matches('*').to_owned(),
        };
        if !entry.is_empty() && !out.contains(&entry) {
            out.push(entry);
        }
    }
    out.join(",")
}

/// 系统代理读一次能用多久：同一次连接里先后几个子进程（下载脚本、安装、登录）不重复起 `scutil`
const SYSTEM_TTL: Duration = Duration::from_secs(30);

static SYSTEM_CACHE: Mutex<Option<(Instant, Option<Settings>)>> = Mutex::new(None);

/// 此刻的系统代理（macOS，`scutil --proxy`，3 秒上限；30 秒内用缓存）。读不到为 None。阻塞，异步代码里经
/// `spawn_blocking` 调
fn system_settings() -> Option<Settings> {
    let mut cache = SYSTEM_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((at, settings)) = cache.as_ref() {
        if at.elapsed() < SYSTEM_TTL {
            return settings.clone();
        }
    }
    let settings = crate::sysproxy::load_scutil()
        .ok()
        .map(|out| crate::sysproxy::parse(&out));
    if settings.as_ref().is_some_and(|s| s.pac_enabled) {
        log::info!("系统开着自动代理（PAC）：本版不支持，子进程按没有系统代理处理");
    }
    *cache = Some((Instant::now(), settings.clone()));
    settings
}

/// 给一个子进程的父环境（`None`＝本进程的环境）算出要额外带的代理变量。阻塞（可能起一次 `scutil`）
pub fn for_child(parent_env: Option<&[(String, String)]>) -> Vec<(String, String)> {
    let parent_has_proxy = match parent_env {
        Some(env) => has_proxy(env.iter().map(|(k, v)| (k.as_str(), v.as_str()))),
        None => {
            let env: Vec<(String, String)> = std::env::vars().collect();
            has_proxy(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        }
    };
    if parent_has_proxy {
        return Vec::new();
    }
    let login = crate::login_env::current();
    if !needs_system(login.as_ref()) {
        return resolve(false, login.as_ref(), None);
    }
    resolve(false, login.as_ref(), system_settings().as_ref())
}

/// [`for_child`] 的异步版（放到阻塞线程上跑）；线程出错按没有代理
pub async fn for_child_async(parent_env: Option<Vec<(String, String)>>) -> Vec<(String, String)> {
    tokio::task::spawn_blocking(move || for_child(parent_env.as_deref()))
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn clash() -> Settings {
        Settings {
            http_enabled: true,
            http_host: "127.0.0.1".into(),
            http_port: 7897,
            https_enabled: true,
            https_host: "127.0.0.1".into(),
            https_port: 7897,
            socks_enabled: true,
            socks_host: "127.0.0.1".into(),
            socks_port: 7898,
            pac_enabled: false,
            exceptions: vec![
                "127.0.0.1".into(),
                "192.168.0.0/16".into(),
                "*.local".into(),
                "<local>".into(),
                "localhost".into(),
                "*.weibo.com".into(),
            ],
        }
    }

    /// 机场客户端打开「系统代理」：HTTP / HTTPS / SOCKS 都给，例外列表转成 NO_PROXY，本机地址总在
    #[test]
    fn 系统代理_转成环境变量_大小写各一份() {
        assert_eq!(
            resolve(false, None, Some(&clash())),
            pairs(&[
                ("HTTPS_PROXY", "http://127.0.0.1:7897"),
                ("https_proxy", "http://127.0.0.1:7897"),
                ("HTTP_PROXY", "http://127.0.0.1:7897"),
                ("http_proxy", "http://127.0.0.1:7897"),
                ("ALL_PROXY", "socks5h://127.0.0.1:7898"),
                ("all_proxy", "socks5h://127.0.0.1:7898"),
                (
                    "NO_PROXY",
                    "localhost,127.0.0.1,::1,192.168.0.0/16,.local,.weibo.com"
                ),
                (
                    "no_proxy",
                    "localhost,127.0.0.1,::1,192.168.0.0/16,.local,.weibo.com"
                ),
            ])
        );
    }

    /// 只开了 SOCKS：只给 ALL_PROXY 与 NO_PROXY；开关开着但没填地址或端口的不算
    #[test]
    fn 系统代理_只开socks_或者没填全() {
        let socks_only = Settings {
            socks_enabled: true,
            socks_host: "10.0.0.2".into(),
            socks_port: 1080,
            https_enabled: true, // 开着但没填地址：不算
            ..Default::default()
        };
        assert_eq!(
            resolve(false, None, Some(&socks_only)),
            pairs(&[
                ("ALL_PROXY", "socks5h://10.0.0.2:1080"),
                ("all_proxy", "socks5h://10.0.0.2:1080"),
                ("NO_PROXY", "localhost,127.0.0.1,::1"),
                ("no_proxy", "localhost,127.0.0.1,::1"),
            ])
        );
    }

    /// 什么都没开（含只开 PAC）：直连，什么都不加
    #[test]
    fn 系统代理_都没开就直连() {
        assert!(resolve(false, None, Some(&Settings::default())).is_empty());
        let pac = Settings {
            pac_enabled: true,
            ..Default::default()
        };
        assert!(
            resolve(false, None, Some(&pac)).is_empty(),
            "PAC 本版不支持"
        );
        assert!(resolve(false, None, None).is_empty(), "读不到系统代理");
    }

    /// 顺序：本进程环境里有代理 → 不加（白名单已带）；否则登录 shell 的优先于系统代理
    #[test]
    fn 顺序_本进程_登录shell_系统() {
        let login = LoginEnv {
            proxy: pairs(&[
                ("https_proxy", "http://10.1.1.1:3128"),
                ("no_proxy", ".corp"),
            ]),
            ..Default::default()
        };
        assert!(resolve(true, Some(&login), Some(&clash())).is_empty());
        assert_eq!(
            resolve(false, Some(&login), Some(&clash())),
            pairs(&[
                ("https_proxy", "http://10.1.1.1:3128"),
                ("no_proxy", ".corp")
            ]),
            "登录 shell 的原样带上"
        );
        // 登录 shell 只设了 NO_PROXY：不算有代理，落到系统代理
        let only_no_proxy = LoginEnv {
            proxy: pairs(&[("NO_PROXY", ".corp")]),
            ..Default::default()
        };
        assert_eq!(
            resolve(false, Some(&only_no_proxy), Some(&clash()))[0],
            (
                "HTTPS_PROXY".to_string(),
                "http://127.0.0.1:7897".to_string()
            )
        );
    }

    /// 登录 shell 只给了 SOCKS（`ALL_PROXY`）：Claude Code 不认 SOCKS、也不读 `ALL_PROXY`，
    /// 继续用系统代理的 HTTP / HTTPS 补上 `HTTPS_PROXY` / `HTTP_PROXY`（登录 shell 的照带，NO_PROXY 没设就补系统的）
    #[test]
    fn 登录shell只有socks_用系统代理补http() {
        let socks = LoginEnv {
            proxy: pairs(&[("ALL_PROXY", "socks5://127.0.0.1:7898")]),
            ..Default::default()
        };
        assert_eq!(
            resolve(false, Some(&socks), Some(&clash())),
            pairs(&[
                ("ALL_PROXY", "socks5://127.0.0.1:7898"),
                ("HTTPS_PROXY", "http://127.0.0.1:7897"),
                ("https_proxy", "http://127.0.0.1:7897"),
                ("HTTP_PROXY", "http://127.0.0.1:7897"),
                ("http_proxy", "http://127.0.0.1:7897"),
                (
                    "NO_PROXY",
                    "localhost,127.0.0.1,::1,192.168.0.0/16,.local,.weibo.com"
                ),
                (
                    "no_proxy",
                    "localhost,127.0.0.1,::1,192.168.0.0/16,.local,.weibo.com"
                ),
            ])
        );
        // 登录 shell 自己设了 NO_PROXY：用它的，不补系统的
        let socks_no_proxy = LoginEnv {
            proxy: pairs(&[
                ("all_proxy", "socks5://127.0.0.1:7898"),
                ("no_proxy", ".corp"),
            ]),
            ..Default::default()
        };
        let got = resolve(false, Some(&socks_no_proxy), Some(&clash()));
        assert!(got.contains(&("HTTPS_PROXY".into(), "http://127.0.0.1:7897".into())));
        assert_eq!(
            got.iter()
                .filter(|(k, _)| k.eq_ignore_ascii_case("NO_PROXY"))
                .collect::<Vec<_>>(),
            vec![&("no_proxy".to_string(), ".corp".to_string())]
        );
        // 系统代理也只有 SOCKS（或者读不到）：登录 shell 的照传
        let sys_socks = Settings {
            socks_enabled: true,
            socks_host: "10.0.0.2".into(),
            socks_port: 1080,
            ..Default::default()
        };
        assert_eq!(
            resolve(false, Some(&socks), Some(&sys_socks)),
            pairs(&[("ALL_PROXY", "socks5://127.0.0.1:7898")])
        );
        assert_eq!(
            resolve(false, Some(&socks), None),
            pairs(&[("ALL_PROXY", "socks5://127.0.0.1:7898")])
        );
    }

    /// 登录 shell 只有 SOCKS 时才要去问系统代理；给了 HTTP(S) 就不用（省一次 `scutil`）
    #[test]
    fn 登录shell有http就不用系统代理() {
        let https = LoginEnv {
            proxy: pairs(&[("https_proxy", "http://10.1.1.1:3128")]),
            ..Default::default()
        };
        assert!(!needs_system(Some(&https)));
        let socks = LoginEnv {
            proxy: pairs(&[("ALL_PROXY", "socks5://127.0.0.1:7898")]),
            ..Default::default()
        };
        assert!(needs_system(Some(&socks)));
        assert!(needs_system(None));
    }

    #[test]
    fn 父环境有没有代理_只看三种地址() {
        assert!(has_proxy([("all_proxy", "socks5://x:1")].into_iter()));
        assert!(has_proxy([("Https_Proxy", "http://x:1")].into_iter()));
        assert!(!has_proxy([("NO_PROXY", "localhost")].into_iter()));
        assert!(!has_proxy([("HTTPS_PROXY", "  ")].into_iter()), "空值不算");
        assert!(!has_proxy([("PATH", "/bin")].into_iter()));
    }
}
