//! 把编排层接到真实世界：钥匙串、launchd、系统代理、Codex 可执行文件、后台程序副本。
//! 以及无界面入口 `symsync gateway run|status|doctor|restore`。
use crate::app::{App, AppError, Deps};
use crate::router::{Config, Protocol, ProxyFn, Router, HEALTH_SERVICE_NAME};
use crate::{keychain, process, provider, service, sysproxy};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use symsync_core::store::Store;

/// 钥匙串条目：服务名与账户名
pub const KEYCHAIN_SERVICE: &str = "symsync";
pub const KEYCHAIN_ACCOUNT: &str = "codex-gateway";

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn codex_home() -> PathBuf {
    match std::env::var_os("CODEX_HOME") {
        Some(custom) if !custom.is_empty() => PathBuf::from(custom),
        _ => home().join(".codex"),
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 没有代理环境变量时（例如由 launchd 拉起）改用 macOS 系统代理设置及其例外列表
pub fn system_proxy() -> ProxyFn {
    let resolver =
        sysproxy::ProxyResolver::new(sysproxy::load_scutil, Duration::from_secs(30), Instant::now);
    Arc::new(move |url| resolver.resolve(url))
}

fn service_manager() -> service::Manager {
    #[cfg(unix)]
    let uid = {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(home()).map(|m| m.uid()).unwrap_or(0)
    };
    #[cfg(not(unix))]
    let uid = 0;
    service::Manager {
        launch_agents_dir: home().join("Library").join("LaunchAgents"),
        uid,
        run: Box::new(|program, args| {
            let output = Command::new(program).args(args).output()?;
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            Ok((text, output.status.code().unwrap_or(-1)))
        }),
    }
}

/// 在端口上确认响应的是本功能的路由；最多等 5 秒
pub fn router_healthy(port: u16) -> Result<(), String> {
    // 上限 10 秒：系统对新程序文件的首次校验实测就可能占去好几秒，5 秒会把「只是慢」误判成「没起来」
    router_healthy_within(port, Duration::from_secs(10))
}

fn router_healthy_within(port: u16, patience: Duration) -> Result<(), String> {
    let deadline = Instant::now() + patience;
    loop {
        let attempt = (|| -> Result<(), String> {
            let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
            let mut stream =
                std::net::TcpStream::connect_timeout(&address, Duration::from_millis(500))
                    .map_err(|e| e.to_string())?;
            stream.set_read_timeout(Some(Duration::from_secs(1))).ok();
            write!(
                stream,
                "GET /_health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n"
            )
            .map_err(|e| e.to_string())?;
            let mut response = String::new();
            let _ = stream.take(4096).read_to_string(&mut response);
            if response.contains(HEALTH_SERVICE_NAME) {
                Ok(())
            } else {
                Err("端口上响应的不是本功能的路由".to_owned())
            }
        })();
        match attempt {
            Ok(()) => return Ok(()),
            Err(e) if Instant::now() >= deadline => return Err(e),
            // 路由通常在一两百毫秒内就绪，轮询密一点，启用就少等一截
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn codex_executables() -> Vec<PathBuf> {
    // 优先桌面应用自带的 Codex：本期的目标环境是桌面应用
    let mut candidates = vec![
        PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex"),
        PathBuf::from("/Applications/Codex.app/Contents/Resources/codex"),
    ];
    if let Some(paths) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&paths).map(|dir| dir.join("codex")));
    }
    candidates.push(home().join(".local").join("bin").join("codex"));
    candidates.into_iter().filter(|p| p.is_file()).collect()
}

fn run_codex(args: &[&str]) -> io::Result<Vec<u8>> {
    let mut last = io::Error::new(io::ErrorKind::NotFound, "没有找到 codex 可执行文件");
    for executable in codex_executables() {
        let output = Command::new(&executable)
            .args(args)
            .current_dir(std::env::temp_dir())
            .env_remove("CODEX_HOME")
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_API_KEY")
            .output();
        match output {
            Ok(output) if output.status.success() => return Ok(output.stdout),
            Ok(output) => {
                last = io::Error::other(String::from_utf8_lossy(&output.stderr).trim().to_owned())
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

fn codex_version_cached() -> impl Fn() -> String + Send + Sync {
    let cache: Mutex<Option<(String, Instant)>> = Mutex::new(None);
    move || {
        let mut cache = cache.lock().unwrap();
        if let Some((value, at)) = cache.as_ref() {
            if at.elapsed() < Duration::from_secs(60) {
                return value.clone();
            }
        }
        let value = run_codex(&["--version"])
            .ok()
            .and_then(|out| {
                String::from_utf8_lossy(&out)
                    .split_whitespace()
                    .last()
                    .map(str::to_owned)
            })
            .unwrap_or_default();
        *cache = Some((value.clone(), Instant::now()));
        value
    }
}

/// `ps` 的 etime 形如 `[[dd-]hh:]mm:ss`
pub fn parse_etime(text: &str) -> Option<u64> {
    let (days, clock) = match text.trim().split_once('-') {
        Some((days, clock)) => (days.parse::<u64>().ok()?, clock),
        None => (0, text.trim()),
    };
    let parts: Vec<u64> = clock
        .split(':')
        .map(|p| p.parse().ok())
        .collect::<Option<_>>()?;
    let seconds = match parts.as_slice() {
        [h, m, s] => h * 3600 + m * 60 + s,
        [m, s] => m * 60 + s,
        _ => return None,
    };
    Some(days * 86400 + seconds)
}

/// Codex 桌面应用主进程的启动时间；没在运行为 None
fn codex_started_at() -> Option<u64> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "etime=,comm="])
        .output()
        .ok()?;
    let now = unix_now();
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let (etime, command) = line.split_once(char::is_whitespace)?;
            let command = command.trim();
            let is_codex = command.ends_with("/ChatGPT.app/Contents/MacOS/ChatGPT")
                || command.ends_with("/Codex.app/Contents/MacOS/Codex");
            if !is_codex {
                return None;
            }
            Some(now.saturating_sub(parse_etime(etime)?))
        })
        .min()
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// 把 `source` 复制到 `dest`（后台服务用的稳定路径）。返回副本是否被更新。
/// 判据：先比源文件的长度和修改时间（记在旁边的 `.meta` 里），不一致再比 SHA-256，不每次读全文件。
pub fn install_binary_from(source: &Path, dest: &Path) -> io::Result<bool> {
    let metadata = std::fs::metadata(source)?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    let stamp = format!("{}:{}", metadata.len(), modified);
    let meta_path = dest.with_extension("meta");
    let recorded = std::fs::read_to_string(&meta_path).unwrap_or_default();
    let (recorded_stamp, recorded_hash) = recorded.trim().split_once(' ').unwrap_or(("", ""));
    // 副本必须是普通文件且长度与源一致，记录才可信；副本被截断或被换成别的东西时要重新复制
    let dest_intact = std::fs::symlink_metadata(dest)
        .is_ok_and(|m| m.file_type().is_file() && m.len() == metadata.len());
    if dest_intact && recorded_stamp == stamp {
        return Ok(false);
    }
    let hash = sha256_file(source)?;
    if dest_intact && recorded_hash == hash && sha256_file(dest)? == hash {
        std::fs::write(&meta_path, format!("{stamp} {hash}\n"))?;
        return Ok(false);
    }
    let parent = dest
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "dest has no parent"))?;
    std::fs::create_dir_all(parent)?;
    // 临时文件名不固定，且用 create_new：不会顺着别人预先放好的软链写出去，界面和命令行同时运行也不会互相踩
    let temp = parent.join(format!(
        ".symsync-{}-{:x}.tmp",
        std::process::id(),
        unix_now_nanos()
    ));
    let result = (|| -> io::Result<()> {
        let mut input = std::fs::File::open(source)?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o755);
        }
        let mut output = options.open(&temp)?;
        io::copy(&mut input, &mut output)?;
        output.sync_all()?;
        // 原子替换：正在运行的旧路由继续用旧文件，直到被重启。rename 会替换掉目标位置上的软链本身
        std::fs::rename(&temp, dest)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result?;
    std::fs::write(&meta_path, format!("{stamp} {hash}\n"))?;
    Ok(true)
}

fn unix_now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn key_error(e: keychain::KeyError) -> String {
    e.to_string()
}

/// 用真实依赖装配编排层。`store_dir` 是 SymSync 的数据目录
pub fn build_app(store_dir: PathBuf) -> App {
    let manager = Arc::new(service_manager());
    let store_dir_for_load = store_dir.clone();
    let store_dir_for_save = store_dir.clone();
    let (m1, m2, m3, m4) = (
        manager.clone(),
        manager.clone(),
        manager.clone(),
        manager.clone(),
    );
    App::new(Deps {
        codex_home: codex_home(),
        data_dir: store_dir,
        agents_manager_dir: home().join(".agents-manager"),
        load_settings: Box::new(move || {
            Ok(Store::new(store_dir_for_load.clone())
                .load_settings()?
                .codex_gateway)
        }),
        save_settings: Box::new(move |gateway| {
            let store = Store::new(store_dir_for_save.clone());
            let mut settings = store.load_settings()?;
            settings.codex_gateway = gateway.clone();
            store.save_settings(&settings)
        }),
        service_install: Box::new(move |spec| m1.install(spec)),
        service_uninstall: Box::new(move |label| m2.uninstall(label)),
        service_status: Box::new(move |label| m3.status(label)),
        service_restart: Box::new(move |label| m4.restart(label)),
        router_healthy: Box::new(router_healthy),
        bundled: Box::new(|| run_codex(&["debug", "models", "--bundled"])),
        get_key: Box::new(|provider| {
            keychain::get_provider_key(
                &keychain::security_runner(),
                KEYCHAIN_SERVICE,
                KEYCHAIN_ACCOUNT,
                provider,
            )
            .map_err(key_error)
        }),
        set_key: Box::new(|provider, key| {
            keychain::set_provider_key(
                &keychain::security_runner(),
                KEYCHAIN_SERVICE,
                KEYCHAIN_ACCOUNT,
                provider,
                key,
            )
            .map_err(key_error)
        }),
        delete_key: Box::new(|provider| {
            keychain::delete_provider_key(
                &keychain::security_runner(),
                KEYCHAIN_SERVICE,
                KEYCHAIN_ACCOUNT,
                provider,
            )
            .map_err(key_error)
        }),
        get_agents_manager_key: Box::new(|| {
            keychain::get_key(
                &keychain::security_runner(),
                crate::takeover::KEYCHAIN_SERVICE,
                crate::takeover::KEYCHAIN_ACCOUNT,
            )
            .map_err(key_error)
        }),
        install_binary: Box::new(|dest| {
            let source = std::env::current_exe().and_then(|p| p.canonicalize())?;
            install_binary_from(&source, dest)
        }),
        list_processes: Box::new(process::list_processes),
        terminate: Box::new(process::terminate),
        codex_started_at: Box::new(codex_started_at),
        codex_version: Box::new(codex_version_cached()),
        now: Box::new(unix_now),
    })
}

/// 向网关拉取模型列表，并把网关客户端的错误翻译成带错误码的错误
/// 应用启动后在后台线程里调用：更新程序副本，并空跑它一次，让系统把首次校验提前做掉。
/// 失败不影响应用——启用时还会照常再做一遍。
pub fn prewarm(app: &App) {
    match app.prewarm() {
        Ok(_) => {
            let _ = std::process::Command::new(app.router_binary())
                .args(["gateway", "warm"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        Err(error) => eprintln!("预热后台程序失败：{error}"),
    }
}

pub async fn fetch_models(base_url: &str, key: &str) -> Result<(Vec<String>, String), AppError> {
    fetch_models_detailed(base_url, key)
        .await
        .map_err(|failure| failure.error)
}

/// 一次拉取失败：给用户看的错误，以及要记在那一家网关上的短原因（没联网就失败时为 None）
#[derive(Debug)]
pub struct FetchFailure {
    pub error: AppError,
    pub unreachable: Option<&'static str>,
}

/// 同 [`fetch_models`]，失败时多带一个按错误种类归纳的短原因，供调用方记到那一家网关上
pub async fn fetch_models_detailed(
    base_url: &str,
    key: &str,
) -> Result<(Vec<String>, String), FetchFailure> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let resolve = system_proxy();
    let client = provider::client_builder_defaults()
        .no_proxy()
        .proxy(reqwest::Proxy::custom(move |url| resolve(url)))
        .build()
        .map_err(|e| FetchFailure {
            error: AppError::new("internal", e.to_string()),
            unreachable: None,
        })?;
    match provider::fetch_models(&client, base_url, key, Duration::from_secs(10)).await {
        Ok(result) => Ok((result.ids, result.api_base)),
        Err(e) => {
            let code = if matches!(e.kind, provider::FetchErrorKind::Auth) {
                "auth"
            } else {
                "network"
            };
            Err(FetchFailure {
                error: AppError::new(code, e.message),
                unreachable: Some(e.kind.unreachable_reason()),
            })
        }
    }
}

// ----- 无界面入口 -----

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

const USAGE: &str = "用法: symsync gateway <run|status|doctor|restore|enable|adopt-key>\n  run        运行本机路由（由登录后台服务调用）\n  status     当前状态（JSON）\n  doctor     诊断：设置、后台服务、端口、版本、最近日志\n  restore    移除本功能写入 Codex 的一切并卸载路由（界面不可用时应急）\n  enable     按已保存的网关和模型启用（界面不可用时应急）\n  adopt-key  把 agents-manager 钥匙串里的密钥复制到本功能的条目（密钥不显示）";

/// `symsync gateway …`；返回进程退出码
pub fn cli(args: Vec<String>, store_dir: PathBuf) -> i32 {
    let outcome = match args.first().map(String::as_str) {
        Some("run") => run_router(&args[1..]),
        Some("status") => serde_json::to_string_pretty(&build_app(store_dir).state())
            .map(|json| println!("{json}"))
            .map_err(|e| e.to_string()),
        Some("doctor") => {
            doctor(&build_app(store_dir.clone()), &store_dir);
            Ok(())
        }
        Some("restore") => build_app(store_dir)
            .restore()
            .map_err(|e| e.to_string())
            .map(|warnings| {
                for warning in warnings {
                    eprintln!("注意: {warning}");
                }
                eprintln!("已恢复。重启 Codex 后，模型选择器回到只有官方模型。");
            }),
        Some("enable") => build_app(store_dir)
            .enable()
            .map_err(|e| e.to_string())
            .map(|()| {
                eprintln!(
                    "已启用。重启 Codex 后，模型选择器里会同时出现官方模型和所选的第三方模型。"
                );
            }),
        // 预热用：什么都不做就退出，只为让系统对这份程序文件做完首次校验
        Some("warm") => Ok(()),
        Some("adopt-key") => build_app(store_dir)
            .adopt_agents_manager_key()
            .map_err(|e| e.to_string())
            .map(|id| eprintln!("已把 agents-manager 的密钥复制到网关 {id} 的钥匙串条目。")),
        _ => Err(USAGE.to_owned()),
    };
    match outcome {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("{message}");
            1
        }
    }
}

fn run_router(args: &[String]) -> Result<(), String> {
    let port: u16 = flag(args, "--port")
        .unwrap_or("47328")
        .parse()
        .map_err(|_| "端口不合法".to_owned())?;
    // 旧版本装的后台服务启动参数里带着唯一的上游；新清单里上游写在清单里，这两个参数可以没有
    let third_party_url = flag(args, "--third-party-url")
        .unwrap_or_default()
        .to_owned();
    let routing_catalog_path =
        PathBuf::from(flag(args, "--routing-catalog").ok_or("需要 --routing-catalog")?);
    let protocol = if flag(args, "--protocol") == Some("responses") {
        Protocol::Responses
    } else {
        Protocol::Chat
    };
    // 密钥按请求取并短时缓存：改密钥不用重启路由，错误不缓存
    let cached = keychain::CachedKeys::new(
        |provider: &str| {
            keychain::get_provider_key(
                &keychain::security_runner(),
                KEYCHAIN_SERVICE,
                KEYCHAIN_ACCOUNT,
                provider,
            )
        },
        Duration::from_secs(30),
        Instant::now,
    );
    let router = Router::new(Config {
        third_party_url,
        third_party_protocol: protocol,
        chatgpt_url: String::new(),
        openai_url: String::new(),
        routing_catalog_path,
        activity_log_path: flag(args, "--log").map(PathBuf::from),
        third_party_key: Arc::new(move |provider| cached.get(provider).map_err(key_error)),
        max_body_bytes: 0,
        proxy: Some(system_proxy()),
    })?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(async move {
        // 只监听回环地址；路由内部还会再按来源地址和 Host 拒绝一次
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| format!("监听 127.0.0.1:{port} 失败: {e}"))?;
        eprintln!("路由已启动: http://127.0.0.1:{port}/v1");
        router.serve(listener).await.map_err(|e| e.to_string())
    })
}

fn doctor(app: &App, store_dir: &Path) {
    let state = app.state();
    let yes_no = |v: bool| if v { "是" } else { "否" };
    println!("Codex 设置已指向本功能: {}", yes_no(state.enabled));
    if !state.conflict.is_empty() {
        println!("冲突: {}", state.conflict);
    }
    if let Some(offer) = &state.takeover {
        println!(
            "本机当前由 agents-manager 启用（网关 {}，已选 {} 个模型），可在界面里接管",
            offer.base_url, offer.selected_count
        );
    }
    println!(
        "路由后台服务已安装: {}；端口 {} 上运行中: {}",
        yes_no(state.router.installed),
        state.router.port,
        yes_no(state.router.running)
    );
    if !state.router.error.is_empty() {
        println!("路由问题: {}", state.router.error);
    }
    println!(
        "Codex 版本: {}；合并目录生成于版本: {}；版本漂移: {}",
        state.codex.version,
        state.codex.catalog_version,
        yes_no(state.codex.drift)
    );
    println!(
        "Codex 桌面应用运行中: {}；需要重启才生效: {}",
        yes_no(state.codex.running),
        yes_no(state.needs_codex_restart)
    );
    if state.providers.is_empty() {
        println!("网关: 还没有添加");
    }
    for provider in &state.providers {
        let selected: Vec<&str> = provider
            .models
            .iter()
            .filter(|m| m.selected)
            .map(|m| m.id.as_str())
            .collect();
        println!(
            "网关 {}（{}）: {}；协议: {}；密钥已保存: {}；已选模型: {}",
            provider.name,
            provider.id,
            provider.base_url,
            provider.protocol,
            yes_no(provider.has_key),
            selected.join(", ")
        );
    }
    let log = store_dir.join("gateway-logs").join("router.log");
    if let Ok(text) = std::fs::read_to_string(&log) {
        let lines: Vec<&str> = text.lines().rev().take(5).collect();
        println!("最近的路由日志（{}）:", log.display());
        for line in lines.into_iter().rev() {
            println!("  {line}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ps_etime() {
        assert_eq!(parse_etime("05:07"), Some(307));
        assert_eq!(parse_etime("01:02:03"), Some(3723));
        assert_eq!(parse_etime("2-01:02:03"), Some(2 * 86400 + 3723));
        assert_eq!(parse_etime("garbage"), None);
    }

    /// AC28 的判据：内容没变不复制；内容变了才复制并报告已更新；只是修改时间变了不算更新
    #[test]
    fn install_binary_copies_only_when_content_changes() {
        let dir = tempfile::tempdir().unwrap();
        let (source, dest) = (
            dir.path().join("source"),
            dir.path().join("bin").join("symsync"),
        );
        std::fs::write(&source, b"v1").unwrap();
        assert!(install_binary_from(&source, &dest).unwrap());
        assert_eq!(std::fs::read(&dest).unwrap(), b"v1");
        assert!(!install_binary_from(&source, &dest).unwrap());
        // 重写同样的内容（修改时间变了，内容没变）
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&source, b"v1").unwrap();
        assert!(!install_binary_from(&source, &dest).unwrap());
        std::fs::write(&source, b"v2!").unwrap();
        assert!(install_binary_from(&source, &dest).unwrap());
        assert_eq!(std::fs::read(&dest).unwrap(), b"v2!");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
    }

    /// 独立验证发现：记录的指纹对得上时完全信任副本，副本被截断也不会修；固定的临时文件名还可能被人预先放一个软链
    #[test]
    fn install_binary_repairs_a_damaged_copy_and_ignores_planted_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let (source, dest) = (
            dir.path().join("source"),
            dir.path().join("bin").join("symsync"),
        );
        std::fs::write(&source, b"version-1").unwrap();
        assert!(install_binary_from(&source, &dest).unwrap());
        std::fs::write(&dest, b"").unwrap(); // 副本被截断
        assert!(
            install_binary_from(&source, &dest).unwrap(),
            "损坏的副本应当被修复"
        );
        assert_eq!(std::fs::read(&dest).unwrap(), b"version-1");

        #[cfg(unix)]
        {
            let victim = dir.path().join("victim");
            std::fs::write(&victim, b"do not touch").unwrap();
            std::os::unix::fs::symlink(&victim, dest.with_extension("tmp")).unwrap();
            std::fs::write(&source, b"version-2").unwrap();
            assert!(install_binary_from(&source, &dest).unwrap());
            assert_eq!(
                std::fs::read(&victim).unwrap(),
                b"do not touch",
                "不能顺着别人放的软链写出去"
            );
            assert!(!std::fs::symlink_metadata(&dest)
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(std::fs::read(&dest).unwrap(), b"version-2");
        }
    }

    /// 健康检查必须认身份：端口上是别的程序时不算健康
    #[test]
    fn router_health_requires_our_service_name() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten().take(40) {
                let mut stream = stream;
                let mut buf = [0u8; 512];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(b"HTTP/1.0 200 OK\r\n\r\n{\"ok\":true}");
            }
        });
        assert!(router_healthy_within(port, Duration::from_millis(600)).is_err());
    }
}
