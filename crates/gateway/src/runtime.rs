//! 把编排层接到真实世界：钥匙串、launchd、系统代理、Codex 可执行文件、后台程序副本。
//! 以及无界面入口 `Sophia gateway run|status|doctor|restore|enable|provider-add|select|probe|restart|launch|…`。
use crate::app::{App, AppError, Deps, ProviderView};
use crate::router::{Agent, Config, Protocol, ProxyFn, Router, HEALTH_SERVICE_NAME};
use crate::{claude_desktop, codex_desktop, keychain, process, provider, service, sysproxy};
use sha2::{Digest, Sha256};
use sophia_core::claude_models::desktop::DesktopDirs;
use sophia_core::codex_models::catalog::Model;
use sophia_core::store::Store;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 钥匙串条目：服务名与账户名
pub const KEYCHAIN_SERVICE: &str = "Sophia";
/// Codex 各家网关的服务商密钥账户基名：`codex-gateway.<id>`（不变）
pub const KEYCHAIN_ACCOUNT: &str = "codex-gateway";
/// Claude 各家网关的服务商密钥账户基名：`claude-gateway.<id>`（R4）
pub const CLAUDE_KEYCHAIN_ACCOUNT: &str = "claude-gateway";

/// 这一家的服务商密钥账户基名
pub fn key_account(agent: Agent) -> &'static str {
    match agent {
        Agent::Codex => KEYCHAIN_ACCOUNT,
        Agent::Claude => CLAUDE_KEYCHAIN_ACCOUNT,
    }
}

/// crate 内公开：`usage` 模块（T5）也要用同一份 HOME/CODEX_HOME 判定，不另写一份
pub(crate) fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

pub(crate) fn codex_home() -> PathBuf {
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

/// `/_health` 响应里的 `features`（R9）。旧版路由没有这个字段，返回空列表
pub fn router_features(port: u16) -> Result<Vec<String>, String> {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = std::net::TcpStream::connect_timeout(&address, Duration::from_millis(500))
        .map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(1))).ok();
    write!(
        stream,
        "GET /_health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n"
    )
    .map_err(|e| e.to_string())?;
    let mut response = String::new();
    let _ = stream.take(16384).read_to_string(&mut response);
    health_features(&response)
}

/// 从 `/_health` 的原始 HTTP 响应里取 `features`；不是本功能的路由 → Err
fn health_features(response: &str) -> Result<Vec<String>, String> {
    let body = response.split_once("\r\n\r\n").map_or("", |(_, body)| body);
    let doc: serde_json::Value = serde_json::from_str(body.trim())
        .map_err(|_| sophia_core::t!("models.runtime.notOurRouter"))?;
    if doc.get("service").and_then(|v| v.as_str()) != Some(HEALTH_SERVICE_NAME) {
        return Err(sophia_core::t!("models.runtime.notOurRouter"));
    }
    Ok(doc
        .get("features")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|f| f.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default())
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
                Err(sophia_core::t!("models.runtime.notOurRouter"))
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

/// crate 内公开：`usage::codex_executables()`（T5）直接复用这份顺序，不另写一份
pub(crate) fn codex_executables() -> Vec<PathBuf> {
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
    let mut last = io::Error::new(
        io::ErrorKind::NotFound,
        sophia_core::t!("models.runtime.codexNotFound"),
    );
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

/// `open -b com.openai.codex`：让系统按应用标识打开 Codex 桌面应用（已开着就只是带到前面）。
/// 本机实测应用包是 `ChatGPT.app`，按标识打开就不必写死路径。打不开时把 `open` 的原话带回去
fn launch_codex() -> io::Result<()> {
    claude_desktop::open_bundle(codex_desktop::BUNDLE_ID)
}

/// Codex 加载配置的那批进程里最早的启动时间；一个都没在跑为 None。
///
/// 认的是 `restart_codex` 会结束的同一批后台进程（`process::is_codex_background`：
/// 桌面应用与编辑器插件拉起的 `codex app-server`），**不是桌面应用主进程**：
/// 配置是 app-server 启动时读的。重启生效会连桌面应用一起重开，但编辑器插件拉起的 app-server
/// 与桌面应用无关，只看主进程会漏掉它们。
/// 终端里交互式的 `codex` 不认（重启也不碰它），界面上写明「Codex 桌面应用」。
fn codex_started_at() -> Option<u64> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "etime=,command="])
        .output()
        .ok()?;
    earliest_codex_start(&String::from_utf8_lossy(&output.stdout), unix_now())
}

/// `ps -axo etime=,command=` 的输出里，Codex 后台进程最早的启动时刻
fn earliest_codex_start(ps: &str, now: u64) -> Option<u64> {
    ps.lines()
        .filter_map(|line| {
            let (etime, command) = line.trim().split_once(char::is_whitespace)?;
            if !process::is_codex_background(command.trim()) {
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
        ".sophia-{}-{:x}.tmp",
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

/// 界面进程里的钥匙串读取缓存（spec 非功能需求「状态查询开销」）：同一账户的结果（含「没有」）缓存 30 秒，
/// 本进程写 / 删这个账户时立即失效。`state()` 每次都要问每家网关有没有密钥，每问一次就是一个 `security` 子进程
struct KeyCache {
    ttl: Duration,
    entries: Mutex<std::collections::HashMap<String, (Option<String>, Instant)>>,
}

impl KeyCache {
    fn new() -> Self {
        Self {
            ttl: Duration::from_secs(30),
            entries: Mutex::default(),
        }
    }

    /// `fetch` 的结果按 `account` 缓存：有值与「没有这个条目」（`None`）都缓存，其他错误不缓存
    fn get(
        &self,
        account: &str,
        fetch: impl FnOnce() -> Result<String, keychain::KeyError>,
    ) -> Result<Option<String>, String> {
        let now = Instant::now();
        if let Some((value, at)) = self.entries.lock().unwrap().get(account) {
            if now.saturating_duration_since(*at) < self.ttl {
                return Ok(value.clone());
            }
        }
        let value = match fetch() {
            Ok(value) => Some(value),
            Err(keychain::KeyError::NotSet) => None,
            Err(e) => return Err(key_error(e)),
        };
        self.entries
            .lock()
            .unwrap()
            .insert(account.to_owned(), (value.clone(), now));
        Ok(value)
    }

    fn forget(&self, account: &str) {
        self.entries.lock().unwrap().remove(account);
    }
}

fn provider_cache_key(agent: Agent, provider: &str) -> String {
    format!("{}.{provider}", key_account(agent))
}

/// 用真实依赖装配编排层。`store_dir` 是 Sophia 的数据目录
pub fn build_app(store_dir: PathBuf) -> App {
    let manager = Arc::new(service_manager());
    let keys = Arc::new(KeyCache::new());
    let (k1, k2, k3, k4, k5) = (
        keys.clone(),
        keys.clone(),
        keys.clone(),
        keys.clone(),
        keys.clone(),
    );
    let store_dir_for_load = store_dir.clone();
    let store_dir_for_save = store_dir.clone();
    let store_dir_for_claude_load = store_dir.clone();
    let store_dir_for_claude_save = store_dir.clone();
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
        get_key: Box::new(move |agent, provider| {
            k1.get(&provider_cache_key(agent, provider), || {
                keychain::get_provider_key(
                    &keychain::security_runner(),
                    KEYCHAIN_SERVICE,
                    key_account(agent),
                    provider,
                )
            })?
            .ok_or_else(|| keychain::KeyError::NotSet.to_string())
        }),
        set_key: Box::new(move |agent, provider, key| {
            k2.forget(&provider_cache_key(agent, provider));
            keychain::set_provider_key(
                &keychain::security_runner(),
                KEYCHAIN_SERVICE,
                key_account(agent),
                provider,
                key,
            )
            .map_err(key_error)
        }),
        delete_key: Box::new(move |agent, provider| {
            k3.forget(&provider_cache_key(agent, provider));
            keychain::delete_provider_key(
                &keychain::security_runner(),
                KEYCHAIN_SERVICE,
                key_account(agent),
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
        launch_codex: Box::new(launch_codex),
        codex_app_name: Box::new(codex_desktop::app_name),
        codex_app_running: Box::new(codex_desktop::running),
        codex_app_quit: Box::new(codex_desktop::quit),
        codex_app_open: Box::new(codex_desktop::open),
        codex_started_at: Box::new(codex_started_at),
        codex_version: Box::new(codex_version_cached()),
        now: Box::new(unix_now),
        load_claude: Box::new(move || {
            Ok(Store::new(store_dir_for_claude_load.clone())
                .load_settings()?
                .claude_gateway)
        }),
        save_claude: Box::new(move |gateway| {
            let store = Store::new(store_dir_for_claude_save.clone());
            let mut settings = store.load_settings()?;
            settings.claude_gateway = gateway.clone();
            store.save_settings(&settings)
        }),
        router_features: Box::new(router_features),
        get_router_token: Box::new(move || {
            k4.get(keychain::ROUTER_TOKEN_ACCOUNT, || {
                keychain::get_key(
                    &keychain::security_runner(),
                    KEYCHAIN_SERVICE,
                    keychain::ROUTER_TOKEN_ACCOUNT,
                )
            })
        }),
        set_router_token: Box::new(move |token| {
            k5.forget(keychain::ROUTER_TOKEN_ACCOUNT);
            keychain::set_key(
                &keychain::security_runner(),
                KEYCHAIN_SERVICE,
                keychain::ROUTER_TOKEN_ACCOUNT,
                token,
            )
            .map_err(key_error)
        }),
        new_router_token: Box::new(keychain::new_router_token),
        desktop_dirs: DesktopDirs::new(&home().join("Library").join("Application Support")),
        managed_prefs: claude_desktop::managed_pref_paths(),
        desktop_info: Box::new(claude_desktop::info),
        desktop_running: Box::new(claude_desktop::running),
        desktop_quit: Box::new(claude_desktop::quit),
        desktop_open: Box::new(claude_desktop::open),
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

/// 拉取模型列表：返回网关的模型（`id` 与网关给了的上下文长度）和探明的接口基址
pub async fn fetch_models(base_url: &str, key: &str) -> Result<(Vec<Model>, String), AppError> {
    fetch_models_detailed(base_url, key)
        .await
        .map_err(|failure| failure.error)
}

/// 向第三方网关发请求用的客户端：不跟随重定向（带着密钥），代理按 macOS 系统设置
fn gateway_client() -> Result<reqwest::Client, AppError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let resolve = system_proxy();
    provider::client_builder_defaults()
        .no_proxy()
        .proxy(reqwest::Proxy::custom(move |url| resolve(url)))
        .build()
        .map_err(|e| AppError::new("internal", e.to_string()))
}

/// 勾选前试调一个模型（[`provider::probe_model`]，等 [`provider::PROBE_TIMEOUT`]）。`target` 由
/// `App::provider_for_probe_in` 取（地址、协议同路由；缺密钥、没有这个网关报 `invalid`，不联网）。
/// 不写任何文件，调用方不必持 `config_lock`。界面命令 `gateway_probe_model` 与 `Sophia gateway probe` 都是
/// 「`provider_for_probe_in` → 这里」。错误代码：`invalid`、`auth`（401/403）、`network`（连不上、超时）、
/// `upstream`（别的非 2xx）
pub async fn probe_target(target: &crate::app::ProbeTarget) -> Result<(), AppError> {
    let client = gateway_client()?;
    provider::probe_model(
        &client,
        &target.api_base,
        target.protocol,
        &target.model,
        &target.key,
        provider::PROBE_TIMEOUT,
    )
    .await
    .map_err(|e| {
        let code = match e.kind {
            provider::ProbeErrorKind::Invalid => "invalid",
            provider::ProbeErrorKind::Auth => "auth",
            provider::ProbeErrorKind::Network => "network",
            provider::ProbeErrorKind::Upstream => "upstream",
        };
        AppError::new(code, e.message)
    })
}

/// 一次拉取失败：给用户看的错误，以及要记在那一家网关上的短原因（没联网就失败时为 None）
#[derive(Debug)]
pub struct FetchFailure {
    pub error: AppError,
    pub unreachable: Option<sophia_core::codex_models::settings::UnreachableReason>,
}

/// 同 [`fetch_models`]，失败时多带一个按错误种类归纳的短原因，供调用方记到那一家网关上
pub async fn fetch_models_detailed(
    base_url: &str,
    key: &str,
) -> Result<(Vec<Model>, String), FetchFailure> {
    let client = gateway_client().map_err(|error| FetchFailure {
        error,
        unreachable: None,
    })?;
    match provider::fetch_models(&client, base_url, key, Duration::from_secs(10)).await {
        Ok(result) => Ok((result.models, result.api_base)),
        Err(e) => {
            let code = if matches!(e.kind, provider::FetchErrorKind::Auth) {
                "auth"
            } else {
                "network"
            };
            Err(FetchFailure {
                error: AppError::new(code, e.message),
                unreachable: Some(e.kind.unreachable()),
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

const USAGE: &str = "用法: Sophia gateway <命令> [--agent codex|claude]\n  run           运行本机路由（由登录后台服务调用）\n  status        当前状态（JSON；带 --agent 时只打印那一家；Claude 那一份带 profile 里写着的模型 profileModels）\n  doctor        诊断：设置、后台服务、端口、版本、最近日志\n  restore       移除本功能写入这一家的一切（界面不可用时应急）；两家都关了才卸载路由\n  enable        按已保存的网关和模型启用（界面不可用时应急）\n  provider-add  --url <地址> --key-env <环境变量名> [--sync]：新建一个网关，密钥从环境变量读，校验并拉取模型\n  select        --provider <网关 id> --models <m1,m2,…>：设这个网关的已选（覆盖）\n  probe         --provider <网关 id> --model <模型 id>：同界面勾选前的试调，通了打印 ok，不通打印原因并以 1 退出\n  restart       --agent claude：同界面的「重启生效」（在跑则退出→写→打开）\n  launch        --agent claude：同界面的「打开 Claude」（有待生效先写再打开）\n  adopt-key     把 agents-manager 钥匙串里的密钥复制到本功能的条目（密钥不显示）\n  --agent       作用于哪一家：codex（缺省）或 claude（Claude 桌面应用）"; // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面

/// `--agent codex|claude`，缺省 codex（保持文档里已写的含义）
fn agent_flag(args: &[String]) -> Result<Option<Agent>, String> {
    match flag(args, "--agent") {
        None if args.iter().any(|a| a == "--agent") => {
            Err("--agent 后面要写 codex 或 claude".to_owned()) // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
        }
        None => Ok(None),
        Some(value) => Agent::parse(value)
            .map(Some)
            .ok_or_else(|| format!("不认识的 --agent {value}：只能是 codex 或 claude")), // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
    }
}

/// `provider-add` 的参数
#[derive(Debug, PartialEq, Eq)]
struct ProviderAdd {
    url: String,
    key: String,
    sync: bool,
}

/// `provider-add --url <地址> --key-env <环境变量名> [--sync]`。密钥只从环境变量读：写在参数里会进 shell 历史，
/// 也会被 `ps` 看到。`env` 是读环境变量的函数（测试注入）
fn provider_add_args(
    args: &[String],
    env: impl Fn(&str) -> Option<String>,
) -> Result<ProviderAdd, String> {
    if args.iter().any(|a| a == "--key") {
        return Err(
            "密钥不从参数读（会进 shell 历史）：先把它放进环境变量，再用 --key-env <环境变量名>" // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
                .to_owned(),
        );
    }
    let url = flag(args, "--url")
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .ok_or("需要 --url <网关地址>")?; // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
    let name = flag(args, "--key-env")
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .ok_or("需要 --key-env <存放密钥的环境变量名>")?; // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
    let key = env(name)
        .map(|k| k.trim().to_owned())
        .filter(|k| !k.is_empty())
        .ok_or_else(|| format!("环境变量 {name} 没有设置或为空"))?; // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
    Ok(ProviderAdd {
        url: url.to_owned(),
        key,
        sync: args.iter().any(|a| a == "--sync"),
    })
}

/// `select --provider <网关 id> --models <m1,m2,…>`：网关 id 与按顺序的模型 id
fn select_args(args: &[String]) -> Result<(String, Vec<String>), String> {
    let provider = flag(args, "--provider")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or("需要 --provider <网关 id>（见 status 里 providers[].id）")?; // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
    let models: Vec<String> = flag(args, "--models")
        .ok_or("需要 --models <模型 id，逗号分隔>")? // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
        .split(',')
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_owned)
        .collect();
    if models.is_empty() {
        let empty = "--models 里没有模型 id；要全部取消请在界面里操作"; // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
        return Err(empty.to_owned());
    }
    Ok((provider.to_owned(), models))
}

/// 把模型 id 换成界面传给 `set_models_in` 的样子：带上网关模型列表里的显示名（空的不带）。不在列表里 → 报错
fn selection(provider: &ProviderView, ids: &[String]) -> Result<Vec<Model>, String> {
    ids.iter()
        .map(|id| {
            let found = provider
                .models
                .iter()
                .find(|m| &m.id == id)
                .ok_or_else(|| {
                    format!(
                        "网关 {} 的模型列表里没有 {id}（先拉取模型，或看 status 里的 models[].id）", // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
                        provider.id
                    )
                })?;
            Ok(Model {
                id: found.id.clone(),
                display_name: Some(found.display_name.clone()).filter(|n| !n.trim().is_empty()),
                ..Default::default()
            })
        })
        .collect()
}

/// `probe --provider <网关 id> --model <模型 id>`
fn probe_args(args: &[String]) -> Result<(String, String), String> {
    let provider = flag(args, "--provider")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or("需要 --provider <网关 id>（见 status 里 providers[].id）")?; // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
    let model = flag(args, "--model")
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .ok_or("需要 --model <模型 id>（见 status 里 providers[].models[].id）")?; // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
    Ok((provider.to_owned(), model.to_owned()))
}

/// `probe`：同界面勾选前的试调（`provider_for_probe_in` → `probe_target`，同一条路），不写任何文件
fn probe(app: &App, agent: Agent, args: &[String]) -> Result<(), String> {
    let (provider_id, model_id) = probe_args(args)?;
    let target = app
        .provider_for_probe_in(agent, &provider_id, &model_id)
        .map_err(|e| e.to_string())?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime
        .block_on(probe_target(&target))
        .map_err(|e| e.to_string())?;
    println!("ok");
    Ok(())
}

fn print_warnings(warnings: Vec<String>) {
    for warning in warnings {
        eprintln!("注意: {warning}");
    }
}

/// `provider-add`：同界面「+ 网关」带密钥保存——先向网关校验并拉模型（不持锁），成功再存（`commit_verified_provider_in`）
fn provider_add(app: &App, agent: Agent, args: &[String]) -> Result<(), String> {
    let add = provider_add_args(args, |name| std::env::var(name).ok())?;
    let cleaned = crate::app::clean_base_url(&add.url).map_err(|e| e.to_string())?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let (ids, api_base) = runtime
        .block_on(fetch_models(&cleaned, &add.key))
        .map_err(|e| e.to_string())?;
    let count = ids.len();
    let saved = app
        .commit_verified_provider_in(
            agent, None, None, &add.url, &add.key, ids, &api_base, add.sync,
        )
        .map_err(|e| e.to_string())?;
    let out = serde_json::json!({
        "providerId": saved.provider_id,
        "otherProviderId": saved.other_provider_id,
        "models": count,
    });
    println!("{out}");
    Ok(())
}

/// `select`：同界面在网关抽屉里勾选（`set_models_in`，覆盖这个网关的已选）；开着时的重写与待生效同界面
fn select(app: &App, agent: Agent, args: &[String]) -> Result<(), String> {
    let (provider_id, ids) = select_args(args)?;
    let state = app.state();
    let provider = state
        .agents
        .iter()
        .find(|view| view.agent == agent)
        .and_then(|view| view.providers.iter().find(|p| p.id == provider_id))
        .ok_or_else(|| format!("{} 没有 id 为 {provider_id} 的网关", agent.as_str()))?; // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
    let models = selection(provider, &ids)?;
    print_warnings(
        app.set_models_in(agent, &provider_id, models)
            .map_err(|e| e.to_string())?,
    );
    eprintln!("已选 {} 个：{}", ids.len(), ids.join(", "));
    Ok(())
}

/// `Sophia gateway …`；返回进程退出码
pub fn cli(args: Vec<String>, store_dir: PathBuf) -> i32 {
    let agent = match args.first().map(String::as_str) {
        Some("run") => Ok(None),
        _ => agent_flag(&args),
    };
    let agent = match agent {
        Ok(agent) => agent,
        Err(message) => {
            eprintln!("{message}");
            return 1;
        }
    };
    let outcome = match (args.first().map(String::as_str), agent) {
        (Some("run"), _) => run_router(&args[1..]),
        (Some("status"), None) => serde_json::to_string_pretty(&build_app(store_dir).state())
            .map(|json| println!("{json}"))
            .map_err(|e| e.to_string()),
        (Some("status"), Some(agent)) => {
            let state = build_app(store_dir).state();
            let view = state.agents.iter().find(|view| view.agent == agent);
            serde_json::to_string_pretty(&serde_json::json!({
                "supported": state.supported,
                "router": state.router,
                "agent": view,
            }))
            .map(|json| println!("{json}"))
            .map_err(|e| e.to_string())
        }
        (Some("doctor"), Some(Agent::Claude)) => {
            doctor_claude(&build_app(store_dir.clone()), &store_dir);
            Ok(())
        }
        (Some("doctor"), _) => {
            doctor(&build_app(store_dir.clone()), &store_dir);
            Ok(())
        }
        (Some("restore"), Some(Agent::Claude)) => build_app(store_dir)
            .restore_claude()
            .map_err(|e| e.to_string())
            .map(|warnings| {
                for warning in warnings {
                    eprintln!("注意: {warning}");
                }
                eprintln!("已切回。Claude 桌面应用在运行时，要在 Sophia 里「重启生效」（或退出后重新打开 Claude 前再执行一次本命令）才会回到账号模式。");
            }),
        (Some("restore"), _) => build_app(store_dir)
            .restore()
            .map_err(|e| e.to_string())
            .map(|warnings| {
                for warning in warnings {
                    eprintln!("注意: {warning}");
                }
                eprintln!("已恢复。重启 Codex 后，模型选择器回到只有官方模型。");
            }),
        (Some("enable"), Some(Agent::Claude)) => build_app(store_dir)
            .enable_claude()
            .map_err(|e| e.to_string())
            .map(|warnings| {
                for warning in warnings {
                    eprintln!("注意: {warning}");
                }
                eprintln!("已打开。Claude 桌面应用在运行时只记下了，要在 Sophia 里「重启生效」；没在运行时已写好，打开 Claude 即进入第三方模型。");
            }),
        (Some("enable"), _) => build_app(store_dir)
            .enable()
            .map_err(|e| e.to_string())
            .map(|()| {
                eprintln!(
                    "已启用。重启 Codex 后，模型选择器里会同时出现官方模型和所选的第三方模型。"
                );
            }),
        // 预热用：什么都不做就退出，只为让系统对这份程序文件做完首次校验
        (Some("warm"), _) => Ok(()),
        (Some("provider-add"), agent) => {
            provider_add(&build_app(store_dir), agent.unwrap_or(Agent::Codex), &args)
        }
        (Some("select"), agent) => select(&build_app(store_dir), agent.unwrap_or(Agent::Codex), &args),
        (Some("probe"), agent) => probe(&build_app(store_dir), agent.unwrap_or(Agent::Codex), &args),
        // 同界面的「重启生效」「打开 Claude」：命令行是另一个进程，没有界面的 `config_lock` 可取，
        // `acquire` 传空；App 自己的写锁（`guard`）照旧在写文件那一段取
        (Some("restart"), Some(Agent::Claude)) => build_app(store_dir)
            .restart_claude(|| ())
            .map_err(|e| e.to_string())
            .map(|warnings| {
                print_warnings(warnings);
                eprintln!("已重启 Claude。");
            }),
        (Some("launch"), Some(Agent::Claude)) => build_app(store_dir)
            .launch_claude(|| ())
            .map_err(|e| e.to_string())
            .map(|warnings| {
                print_warnings(warnings);
                eprintln!("已打开 Claude。");
            }),
        (Some("restart" | "launch"), _) => {
            Err("restart / launch 目前只用于 Claude 桌面应用：加 --agent claude".to_owned()) // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
        }
        (Some("adopt-key"), _) => build_app(store_dir)
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
        .map_err(|_| "端口不合法".to_owned())?; // i18n-exempt: 网关命令行的参数错误，只在终端出现，不进界面
                                                // 旧版本装的后台服务启动参数里带着唯一的上游；新清单里上游写在清单里，这两个参数可以没有
    let third_party_url = flag(args, "--third-party-url")
        .unwrap_or_default()
        .to_owned();
    let routing_catalog_path =
        PathBuf::from(flag(args, "--routing-catalog").ok_or("需要 --routing-catalog")?); // i18n-exempt: 网关命令行的参数错误，只在终端出现，不进界面
    let protocol = if flag(args, "--protocol") == Some("responses") {
        Protocol::Responses
    } else {
        Protocol::Chat
    };
    // 密钥按请求取并短时缓存：改密钥不用重启路由，错误不缓存。两家各一份缓存、各用各的账户（R4）
    let cached_for = |agent: Agent| {
        keychain::CachedKeys::new(
            move |provider: &str| {
                keychain::get_provider_key(
                    &keychain::security_runner(),
                    KEYCHAIN_SERVICE,
                    key_account(agent),
                    provider,
                )
            },
            Duration::from_secs(30),
            Instant::now,
        )
    };
    let (codex_keys, claude_keys) = (cached_for(Agent::Codex), cached_for(Agent::Claude));
    // 旧版本装的后台服务没有这个参数：Claude 命名空间的请求一律 404（R10）
    let claude_routing_path = flag(args, "--claude-routing").map(PathBuf::from);
    let router = Router::new(Config {
        third_party_url,
        third_party_protocol: protocol,
        chatgpt_url: String::new(),
        openai_url: String::new(),
        routing_catalog_path,
        activity_log_path: flag(args, "--log").map(PathBuf::from),
        third_party_key: Arc::new(move |agent, provider| {
            match agent {
                Agent::Codex => codex_keys.get(provider),
                Agent::Claude => claude_keys.get(provider),
            }
            .map_err(key_error)
        }),
        max_body_bytes: 0,
        proxy: Some(system_proxy()),
        claude_routing_path,
        // 令牌的缓存与「比对不上时重读」由路由自己做
        router_token: Arc::new(|| {
            keychain::get_key(
                &keychain::security_runner(),
                KEYCHAIN_SERVICE,
                keychain::ROUTER_TOKEN_ACCOUNT,
            )
            .map_err(key_error)
        }),
        keepalive: Duration::ZERO,
    })?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(async move {
        // 只监听回环地址；路由内部还会再按来源地址和 Host 拒绝一次
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| format!("监听 127.0.0.1:{port} 失败: {e}"))?; // i18n-exempt: 网关命令行（launchd 拉起）的启动错误，输出进日志，不进界面
        eprintln!("路由已启动: http://127.0.0.1:{port}/v1");
        router.serve(listener).await.map_err(|e| e.to_string())
    })
}

/// `doctor --agent claude`：桌面应用这一侧的诊断（令牌不显示）
fn doctor_claude(app: &App, store_dir: &Path) {
    let state = app.state();
    let yes_no = |v: bool| if v { "是" } else { "否" }; // i18n-exempt: doctor 是网关命令行的诊断输出，只在终端出现，不进界面
    let Some(view) = state.agents.iter().find(|v| v.agent == Agent::Claude) else {
        return;
    };
    println!("Claude 的第三方模型开关: {}", yes_no(view.enabled));
    if let Some(claude) = &view.claude {
        let desktop = &claude.desktop;
        println!(
            "Claude 桌面应用已安装: {}；版本: {}；版本太旧: {}；由组织统一配置: {}；运行中: {}",
            yes_no(view.installed),
            desktop.version.as_deref().unwrap_or("-"),
            yes_no(desktop.too_old),
            yes_no(desktop.managed),
            yes_no(desktop.running)
        );
        println!(
            "配置里写着 Sophia 的: {}；待生效: {}；需要重启 Claude: {}；被改掉了: {}；切回没做完: {}",
            yes_no(desktop.applied),
            yes_no(desktop.pending),
            yes_no(desktop.needs_restart),
            yes_no(desktop.drift),
            yes_no(desktop.restore_unfinished)
        );
        if let Some(foreign) = &desktop.foreign {
            println!("Claude 正在用别的第三方配置: {}", foreign.id);
        }
        let listed: Vec<String> = claude
            .profile_models
            .iter()
            .map(|m| format!("{} = {}", m.id, m.label_override))
            .collect();
        println!(
            "Claude 菜单里的模型（profile 的 inferenceModels）: {}",
            if listed.is_empty() {
                "-".to_owned()
            } else {
                listed.join("；")
            }
        );
    }
    if !view.conflict.is_empty() {
        println!("问题: {}", view.conflict);
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
    for provider in &view.providers {
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
    print_router_log(store_dir);
}

fn print_router_log(store_dir: &Path) {
    let log = store_dir.join("gateway-logs").join("router.log");
    if let Ok(text) = std::fs::read_to_string(&log) {
        let lines: Vec<&str> = text.lines().rev().take(5).collect();
        println!("最近的路由日志（{}）:", log.display());
        for line in lines.into_iter().rev() {
            println!("  {line}");
        }
    }
}

fn doctor(app: &App, store_dir: &Path) {
    let state = app.state();
    let yes_no = |v: bool| if v { "是" } else { "否" }; // i18n-exempt: doctor 是网关命令行的诊断输出，只在终端出现，不进界面
    let Some(view) = state.agent(Agent::Codex) else {
        return;
    };
    let codex = view.codex.clone().unwrap_or_default();
    println!("Codex 设置已指向本功能: {}", yes_no(view.enabled));
    if !view.conflict.is_empty() {
        println!("冲突: {}", view.conflict);
    }
    if let Some(offer) = &codex.takeover {
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
        codex.app.version,
        codex.app.catalog_version,
        yes_no(codex.app.drift)
    );
    println!(
        "Codex 桌面应用运行中: {}；需要重启才生效: {}",
        yes_no(codex.app.running),
        yes_no(codex.needs_restart)
    );
    if view.providers.is_empty() {
        println!("网关: 还没有添加");
    }
    for provider in &view.providers {
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
    print_router_log(store_dir);
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

    /// 比的是揣着配置的 app-server，不是桌面应用主进程；终端里的交互式 codex 不算
    #[test]
    fn codex_start_follows_background_processes() {
        let ps = "01-16:41:15 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n\
                  00:10 /Applications/ChatGPT.app/Contents/Resources/codex -c a=b app-server --x\n\
                  05:00 /opt/homebrew/bin/codex\n";
        assert_eq!(earliest_codex_start(ps, 1000), Some(990));
        assert_eq!(
            earliest_codex_start("05:00 /opt/homebrew/bin/codex\n", 1000),
            None
        );
    }

    /// AC28 的判据：内容没变不复制；内容变了才复制并报告已更新；只是修改时间变了不算更新
    #[test]
    fn install_binary_copies_only_when_content_changes() {
        let dir = tempfile::tempdir().unwrap();
        let (source, dest) = (
            dir.path().join("source"),
            dir.path().join("bin").join("Sophia"),
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
            dir.path().join("bin").join("Sophia"),
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

    /// R9：从 `/_health` 读出 features；旧版路由没有这个字段 → 空；不是本功能的路由 → Err
    #[test]
    fn health_features_are_read_from_the_body() {
        let new = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true,\"service\":\"sophia-gateway\",\"features\":[\"claude\"]}";
        assert_eq!(health_features(new).unwrap(), ["claude"]);
        let old = "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"service\":\"sophia-gateway\"}";
        assert!(health_features(old).unwrap().is_empty());
        assert!(health_features("HTTP/1.0 200 OK\r\n\r\n{\"ok\":true}").is_err());
        assert!(health_features("garbage").is_err());
    }

    /// `--agent` 缺省 codex；写错的报出来
    #[test]
    fn agent_flag_defaults_to_codex() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(agent_flag(&args(&["restore"])).unwrap(), None);
        assert_eq!(
            agent_flag(&args(&["restore", "--agent", "claude"])).unwrap(),
            Some(Agent::Claude)
        );
        assert_eq!(
            agent_flag(&args(&["status", "--agent", "codex"])).unwrap(),
            Some(Agent::Codex)
        );
        assert!(agent_flag(&args(&["restore", "--agent", "cursor"])).is_err());
        assert!(agent_flag(&args(&["restore", "--agent"])).is_err());
    }

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// `provider-add`：密钥只从 `--key-env` 指的环境变量读；`--key` 直接给密钥被拒（会进 shell 历史）
    #[test]
    fn provider_add_reads_the_key_from_the_named_environment_variable() {
        let env = |name: &str| match name {
            "AP_KEY" => Some("  sk-ap-123  ".to_owned()),
            "EMPTY" => Some("   ".to_owned()),
            _ => None,
        };
        let parsed = provider_add_args(
            &argv(&[
                "provider-add",
                "--agent",
                "claude",
                "--url",
                "https://ap.example/v1",
                "--key-env",
                "AP_KEY",
            ]),
            env,
        )
        .unwrap();
        assert_eq!(
            parsed,
            ProviderAdd {
                url: "https://ap.example/v1".into(),
                key: "sk-ap-123".into(),
                sync: false
            }
        );
        let parsed = provider_add_args(
            &argv(&[
                "provider-add",
                "--url",
                "https://ap.example",
                "--key-env",
                "AP_KEY",
                "--sync",
            ]),
            env,
        )
        .unwrap();
        assert!(parsed.sync);

        let err = |list: &[&str]| provider_add_args(&argv(list), env).unwrap_err();
        assert!(err(&["provider-add", "--key-env", "AP_KEY"]).contains("--url"));
        assert!(err(&["provider-add", "--url", "https://ap.example"]).contains("--key-env"));
        let missing = err(&[
            "provider-add",
            "--url",
            "https://ap.example",
            "--key-env",
            "NOPE",
        ]);
        assert!(missing.contains("NOPE"), "{missing}");
        assert!(err(&[
            "provider-add",
            "--url",
            "https://ap.example",
            "--key-env",
            "EMPTY"
        ])
        .contains("EMPTY"));
        let direct = err(&[
            "provider-add",
            "--url",
            "https://ap.example",
            "--key",
            "sk-ap-123",
        ]);
        assert!(
            direct.contains("--key-env") && !direct.contains("sk-ap-123"),
            "{direct}"
        );
    }

    /// `select`：`--provider` 与逗号分隔的 `--models`（去空白、去空项、保持顺序）
    #[test]
    fn select_parses_provider_and_models() {
        assert_eq!(
            select_args(&argv(&[
                "select",
                "--agent",
                "claude",
                "--provider",
                "ap",
                "--models",
                " kimi-k3, glm-5 ,,qwen "
            ]))
            .unwrap(),
            (
                "ap".to_owned(),
                vec!["kimi-k3".to_owned(), "glm-5".to_owned(), "qwen".to_owned()]
            )
        );
        assert!(select_args(&argv(&["select", "--models", "a"]))
            .unwrap_err()
            .contains("--provider"));
        assert!(select_args(&argv(&["select", "--provider", "ap"]))
            .unwrap_err()
            .contains("--models"));
        assert!(select_args(&argv(&["select", "--provider", "ap", "--models", " , "])).is_err());
    }

    #[test]
    fn probe_parses_provider_and_model() {
        assert_eq!(
            probe_args(&argv(&[
                "probe",
                "--agent",
                "claude",
                "--provider",
                "ap",
                "--model",
                " weibo/glm-5 "
            ]))
            .unwrap(),
            ("ap".to_owned(), "weibo/glm-5".to_owned())
        );
        assert!(probe_args(&argv(&["probe", "--model", "m"]))
            .unwrap_err()
            .contains("--provider"));
        assert!(
            probe_args(&argv(&["probe", "--provider", "ap", "--model", " "]))
                .unwrap_err()
                .contains("--model")
        );
    }

    /// `select` 的勾选：按给的顺序、带上网关里已有的显示名（同界面传的 `{id, displayName}`）；不在列表里的报出来
    #[test]
    fn selection_uses_the_saved_display_names() {
        let provider = crate::app::ProviderView {
            id: "ap".into(),
            models: vec![
                crate::app::ModelView {
                    id: "kimi-k3".into(),
                    slug: "ap-kimi-k3".into(),
                    display_name: "Kimi K3".into(),
                    selected: false,
                    ..Default::default()
                },
                crate::app::ModelView {
                    id: "glm-5".into(),
                    slug: "ap-glm-5".into(),
                    display_name: String::new(),
                    selected: true,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let picked = selection(&provider, &["glm-5".to_owned(), "kimi-k3".to_owned()]).unwrap();
        let shown: Vec<(&str, Option<&str>)> = picked
            .iter()
            .map(|m| (m.id.as_str(), m.display_name.as_deref()))
            .collect();
        assert_eq!(shown, [("glm-5", None), ("kimi-k3", Some("Kimi K3"))]);
        let err = selection(&provider, &["gpt-9".to_owned()]).unwrap_err();
        assert!(err.contains("gpt-9") && err.contains("ap"), "{err}");
    }

    /// 界面进程的钥匙串缓存：有值与「没有」都缓存 30 秒，写 / 删时失效；其他错误不缓存
    #[test]
    fn key_cache_remembers_presence_and_forgets_on_write() {
        let cache = KeyCache::new();
        let calls = std::cell::Cell::new(0);
        let fetch = |value: Result<&str, keychain::KeyError>| {
            calls.set(calls.get() + 1);
            value.map(str::to_owned)
        };
        assert_eq!(
            cache.get("a", || fetch(Ok("k"))).unwrap().as_deref(),
            Some("k")
        );
        assert_eq!(
            cache.get("a", || fetch(Ok("other"))).unwrap().as_deref(),
            Some("k")
        );
        assert_eq!(
            cache
                .get("b", || fetch(Err(keychain::KeyError::NotSet)))
                .unwrap(),
            None
        );
        assert_eq!(cache.get("b", || fetch(Ok("late"))).unwrap(), None);
        assert_eq!(calls.get(), 2);
        cache.forget("b");
        assert_eq!(
            cache.get("b", || fetch(Ok("late"))).unwrap().as_deref(),
            Some("late")
        );
        assert!(cache
            .get("c", || fetch(Err(keychain::KeyError::Command(
                "locked".into()
            ))))
            .is_err());
        assert_eq!(
            cache.get("c", || fetch(Ok("now"))).unwrap().as_deref(),
            Some("now")
        );
        assert_eq!(calls.get(), 5);
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
