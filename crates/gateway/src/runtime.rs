//! 把编排层接到真实世界：密钥文件、本进程里的路由、系统代理、Codex 可执行文件，以及升级时卸旧版 launchd 服务。
//! 以及无界面入口 `Sophia gateway run|status|doctor|restore|enable|provider-add|select|probe|restart|launch|…`。
use crate::app::{App, AppError, Deps, StartError};
use crate::router::{
    Agent, Config, KeySource, KeyVerdict, KeyVerdictSink, LocaleSource, Protocol, ProxyFn, Router,
    TokenSource,
};
use crate::router_host::{self, RouterHost};
use crate::{claude_desktop, codex_desktop, keychain, process, provider, service, sysproxy};
use sophia_core::claude_models::desktop::DesktopDirs;
use sophia_core::codex_models::catalog::Model;
use sophia_core::i18n;
use sophia_core::keystore::{KeyStore, KeyStoreError, GLOBAL};
use sophia_core::model_providers::book::Book;
use sophia_core::model_providers::{ModelProviders, ModelRef};
use sophia_core::store::Store;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// crate 内公开：`usage` 模块（T5）也要用同一份 HOME/CODEX_HOME 判定，不另写一份。
///
/// debug 版设了 `SOPHIA_TEST_HOME`（与界面进程 `runtime_env` 同一个测试主目录）时就用它，不改 HOME 也能把
/// `~/.codex`、Claude 的数据目录换成测试目录。不要靠改 HOME 来隔离：Sophia 重启 Codex、Claude 时用 `open -b`
/// 拉起它们，子进程会继承 HOME，真实的桌面应用就跑在空的测试目录里，看着像登录掉了、会话没了（2026-10-03 真机）
pub(crate) fn home() -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("SOPHIA_TEST_HOME").map(PathBuf::from) {
        if root.is_absolute() {
            return root;
        }
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// debug 版设了测试主目录：登录 shell 问到的 `CLAUDE_CONFIG_DIR`、`CODEX_HOME` 一概不用（spec S16）
pub(crate) fn test_home_active() -> bool {
    #[cfg(debug_assertions)]
    {
        std::env::var_os("SOPHIA_TEST_HOME").is_some()
    }
    #[cfg(not(debug_assertions))]
    {
        false
    }
}

/// `CODEX_HOME`：先看本进程的环境，没有再看登录 shell 问到的（从 Dock 启动时 `.zshrc` 里设的那份，spec S16）；
/// 测试主目录时只看本进程
pub(crate) fn codex_home_env() -> Option<String> {
    if let Some(custom) = std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
        return Some(custom.to_string_lossy().into_owned());
    }
    if test_home_active() {
        return None;
    }
    crate::login_env::current().and_then(|env| env.codex_home)
}

pub(crate) fn codex_home() -> PathBuf {
    match codex_home_env() {
        Some(custom) => PathBuf::from(custom),
        None => home().join(".codex"),
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Sophia 所有出站请求共用的代理解析（issue #254）：本进程环境变量 → 登录 shell 里设的（从 Dock 启动时
/// `.zshrc` 里那份，`login_env` 问完之前不看）→ macOS 系统代理及其例外列表（不支持 PAC），都没有就直连。
/// 进程内一份，系统代理的缓存大家共用
pub fn system_proxy() -> ProxyFn {
    static SHARED: OnceLock<ProxyFn> = OnceLock::new();
    SHARED
        .get_or_init(|| {
            let resolver = sysproxy::ProxyResolver::new(
                sysproxy::load_scutil,
                Duration::from_secs(30),
                Instant::now,
            )
            .with_login(|| {
                crate::login_env::current()
                    .map(|env| env.proxy)
                    .unwrap_or_default()
            });
            Arc::new(move |url| resolver.resolve(url))
        })
        .clone()
}

/// 让一个客户端按 `resolve` 选代理（每个请求现算，不用 reqwest 建客户端时读一次的那份）
pub fn with_proxy(builder: reqwest::ClientBuilder, resolve: ProxyFn) -> reqwest::ClientBuilder {
    builder
        .no_proxy()
        .proxy(reqwest::Proxy::custom(move |url| resolve(url)))
}

/// 让一个客户端跟随 [`system_proxy`]：市场、更新、反馈、上报的客户端都经这里
pub fn follow_system_proxy(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    with_proxy(builder, system_proxy())
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

/// crate 内公开：`usage::codex_executables()`（T5）直接复用这份顺序，不另写一份
pub(crate) fn codex_executables() -> Vec<PathBuf> {
    // 优先桌面应用自带的 Codex：本期的目标环境是桌面应用
    let mut candidates = vec![
        PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex"),
        PathBuf::from("/Applications/Codex.app/Contents/Resources/codex"),
    ];
    // 解析后的 PATH（登录 shell 的 + 本进程的 + 兜底目录，spec S16）：和 Claude 一侧同一份找法
    candidates.extend(
        crate::login_env::resolved_path(&home())
            .into_iter()
            .map(|dir| dir.join("codex")),
    );
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
/// Codex 命令行 0.156 起，终端里的交互式 `codex` 跑在常驻后台服务（`codex app-server --managed-daemon`）里，
/// 它也是 app-server，算在这批里，重启时一起结束，所以确认框写明终端里的对话也会中断（2026-10-06 真机）。
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

/// 编排层眼里的密钥文件（`<数据目录>/secrets.json`）。读一次是几百字节的本地文件，不再缓存。
///
/// 「没有」之外还有说不出密钥的情况（R4）：文件读不出（权限、格式）。
/// 界面进程（`ui`）在写之前把损坏的文件另存（R5），另存过之后「没有」的那几家说明原因
struct KeyFile {
    keys: KeyStore,
    ui: bool,
    repaired: AtomicBool,
}

impl KeyFile {
    fn new(store_dir: &Path, ui: bool) -> Self {
        Self {
            keys: KeyStore::new(store_dir),
            ui,
            repaired: AtomicBool::new(false),
        }
    }

    /// 只在界面进程里：损坏的文件另存为 `secrets.json.broken-<时间>`，当作空文件继续
    fn repair(&self) {
        if self.ui && matches!(self.keys.repair_if_corrupt(unix_now()), Ok(Some(_))) {
            self.repaired.store(true, Ordering::Relaxed);
        }
    }

    /// 文件里没有这一项时，说不出密钥的原因；真的就是没有为 None
    fn missing_reason(&self) -> Option<String> {
        self.repaired
            .load(Ordering::Relaxed)
            .then(|| sophia_core::t!("models.secrets.repaired"))
    }

    fn present(
        &self,
        read: Result<Option<String>, KeyStoreError>,
    ) -> Result<Option<String>, String> {
        match read {
            Ok(Some(value)) => Ok(Some(value)),
            Ok(None) => self.missing_reason().map_or(Ok(None), Err),
            Err(e) => Err(e.to_string()),
        }
    }

    /// 一家模型提供商的密钥（全局名单，所有 agent 共用：`providers.global.<id>`）
    fn get(&self, id: &str) -> Result<Option<String>, String> {
        self.present(self.keys.get(GLOBAL, id))
    }

    fn set(&self, id: &str, key: &str) -> Result<(), String> {
        self.repair();
        self.keys.set(GLOBAL, id, key).map_err(|e| e.to_string())
    }

    fn token(&self) -> Result<Option<String>, String> {
        self.present(self.keys.router_token())
    }

    fn set_token(&self, token: &str) -> Result<(), String> {
        self.repair();
        self.keys.set_router_token(token).map_err(|e| e.to_string())
    }
}

/// 路由的文件位置：Codex 的路由清单、Claude 的路由清单、WorkBuddy 的路由清单、活动日志。编排层写清单，路由每个请求重读
fn router_paths(store_dir: &Path) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    (
        codex_home().join(crate::app::ROUTING_FILE),
        crate::app::claude_routing_file(store_dir),
        crate::app::workbuddy_routing_file(store_dir),
        store_dir.join("gateway-logs").join("router.log"),
    )
}

/// 路由取密钥与 Claude 网关令牌：按请求从密钥文件取并短时缓存，改密钥不用重起路由。模型提供商是全局一份
/// （ADR 0003）：哪一家的请求都按提供商 id 取同一份密钥（`providers.global`）。
/// 路由只读：文件损坏时报错、不另存（那是编排层的事，R5）
fn router_secrets(store_dir: &Path) -> (KeySource, TokenSource) {
    let keys = KeyStore::new(store_dir);
    let cached = {
        let keys = keys.clone();
        CachedKeys::new(
            move |provider: &str| keys.get(GLOBAL, provider),
            Duration::from_secs(30),
            Instant::now,
        )
    };
    (
        Arc::new(move |_agent, provider| cached.get(provider)),
        // 令牌的缓存与「比对不上时重读」由路由自己做
        Arc::new(move || {
            keys.router_token()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| sophia_core::t!("models.app.routerTokenMissing"))
        }),
    )
}

/// 路由报来的密钥结论（#144）落盘的地方：路由在请求路径上只把结论放进通道就返回，这条线程按到达顺序经编排层
/// 记到那一家模型提供商上（`App::record_key_verdict`：与界面改「已选」同一把锁、同一条存设置的路，状态没变不写）。
/// 编排层已经不在（`Weak` 升不上）就停；线程起不来时结论直接丢掉，请求照常
pub(crate) fn key_verdict_recorder(app: Weak<App>) -> KeyVerdictSink {
    let (sender, verdicts) = std::sync::mpsc::channel::<(Agent, String, KeyVerdict)>();
    let spawned = std::thread::Builder::new()
        .name("sophia-key-verdicts".into())
        .spawn(move || {
            for (agent, provider, verdict) in verdicts {
                let Some(app) = app.upgrade() else { break };
                if let Err(e) = app.record_key_verdict(&provider, verdict) {
                    log::warn!(
                        "记下网关 {}（{}）的密钥结论失败：{e}",
                        crate::router::log_safe(&provider),
                        agent.as_str()
                    );
                }
            }
        });
    if let Err(e) = spawned {
        log::warn!("起记录密钥结论的线程失败，路由的密钥结论不落盘：{e}");
    }
    let sender = Mutex::new(sender);
    Arc::new(move |agent, provider: &str, verdict| {
        // 只是放进通道：不等落盘。线程没了（发不出去）就算了
        let _ = sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .send((agent, provider.to_owned(), verdict));
    })
}

/// 界面进程里的路由：路由与界面同一进程，说话的语言就是界面当前的语言（`locale: None`，不按请求改语言）
fn ui_router(store_dir: &Path, key_verdicts: KeyVerdictSink) -> Result<Arc<Router>, String> {
    let (routing_catalog_path, claude_routing_path, workbuddy_routing_path, log) =
        router_paths(store_dir);
    let (third_party_key, router_token) = router_secrets(store_dir);
    Router::new(Config {
        third_party_url: String::new(),
        third_party_protocol: Protocol::Chat,
        chatgpt_url: String::new(),
        openai_url: String::new(),
        routing_catalog_path,
        activity_log_path: Some(log),
        third_party_key,
        max_body_bytes: 0,
        proxy: Some(system_proxy()),
        claude_routing_path: Some(claude_routing_path),
        workbuddy_routing_path: Some(workbuddy_routing_path),
        router_token,
        keepalive: Duration::ZERO,
        locale: None,
        key_verdicts: Some(key_verdicts),
    })
}

/// 界面进程用的编排层：先把损坏的密钥文件另存（R5），再交给界面。路由在本进程里、跑在 `handle` 所属的
/// tokio 运行时上（界面是 Tauri 的运行时）；路由报来的密钥结论经这个编排层落盘（#144）
pub fn build_ui_app(store_dir: PathBuf, handle: tokio::runtime::Handle) -> Arc<App> {
    let keys = Arc::new(KeyFile::new(&store_dir, true));
    keys.repair();
    Arc::new_cyclic(|app| {
        let key_verdicts = key_verdict_recorder(app.clone());
        let router_dir = store_dir.clone();
        let host = Arc::new(RouterHost::new(
            handle,
            Box::new(move || ui_router(&router_dir, key_verdicts.clone())),
        ));
        let (h1, h2, h3) = (host.clone(), host.clone(), host);
        build_app_with(
            store_dir,
            keys,
            RouterDeps {
                start: Box::new(move |port| h1.start(port)),
                stop: Box::new(move || h2.stop()),
                running: Box::new(move || h3.running()),
            },
        )
    })
}

/// 命令行进程看到的路由：路由在界面进程（Sophia）里，命令行起不了也停不了它，只能探一下它在不在
fn cli_router(store_dir: &Path) -> RouterDeps {
    let patience = Duration::from_millis(800);
    let store = Store::new(store_dir.to_path_buf());
    RouterDeps {
        start: Box::new(move |port| {
            if router_host::sophia_answers(port, patience) {
                Ok(())
            } else {
                Err(StartError::Failed(sophia_core::t!(
                    "models.app.sophiaNotRunning"
                )))
            }
        }),
        stop: Box::new(|| {}),
        running: Box::new(move || {
            let port = store.load_settings().ok()?.codex_gateway.port;
            router_host::sophia_answers(port, patience).then_some(port)
        }),
    }
}

/// 用真实依赖装配编排层（命令行用；界面用 [`build_ui_app`]）。`store_dir` 是 Sophia 的数据目录
pub fn build_app(store_dir: PathBuf) -> App {
    let keys = Arc::new(KeyFile::new(&store_dir, false));
    let router = cli_router(&store_dir);
    build_app_with(store_dir, keys, router)
}

type RouterStart = Box<dyn Fn(u16) -> Result<(), StartError> + Send + Sync>;

/// 编排层起、停、查路由的三个依赖
struct RouterDeps {
    start: RouterStart,
    stop: Box<dyn Fn() + Send + Sync>,
    running: Box<dyn Fn() -> Option<u16> + Send + Sync>,
}

fn build_app_with(store_dir: PathBuf, keys: Arc<KeyFile>, router: RouterDeps) -> App {
    let manager = service_manager();
    let (k1, k2, k4, k5) = (keys.clone(), keys.clone(), keys.clone(), keys.clone());
    let models_dir = store_dir.clone();
    let models_change_dir = store_dir.clone();
    let store_dir_for_load = store_dir.clone();
    let store_dir_for_save = store_dir.clone();
    let store_dir_for_claude_load = store_dir.clone();
    let store_dir_for_claude_save = store_dir.clone();
    let store_dir_for_workbuddy_load = store_dir.clone();
    let store_dir_for_workbuddy_save = store_dir.clone();
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
            let _guard = store.lock_settings();
            let mut settings = store.load_settings()?;
            settings.codex_gateway = gateway.clone();
            store.save_settings(&settings)
        }),
        launch_agents_dir: manager.launch_agents_dir.clone(),
        service_uninstall: Box::new(move |label| manager.uninstall(label)),
        router_start: router.start,
        router_stop: router.stop,
        router_running: router.running,
        bundled: Box::new(|| run_codex(&["debug", "models", "--bundled"])),
        get_key: Box::new(move |provider| k1.get(provider)),
        set_key: Box::new(move |provider, key| k2.set(provider, key)),
        load_models: Box::new(move || {
            Ok(Store::new(models_dir.clone())
                .load_settings()?
                .model_providers)
        }),
        change_models: Box::new(move |change| {
            let store = Store::new(models_change_dir.clone());
            let _guard = store.lock_settings();
            let mut settings = store.load_settings()?;
            if change(&mut settings.model_providers) {
                store.save_settings(&settings)?;
            }
            Ok(())
        }),
        // 接管 agents-manager 时仍从它的钥匙串条目读一次（R8），之后写进密钥文件
        get_agents_manager_key: Box::new(|| {
            keychain::get_key(
                &keychain::security_runner(),
                crate::takeover::KEYCHAIN_SERVICE,
                crate::takeover::KEYCHAIN_ACCOUNT,
            )
            .map_err(|e| e.to_string())
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
            let _guard = store.lock_settings();
            let mut settings = store.load_settings()?;
            settings.claude_gateway = gateway.clone();
            store.save_settings(&settings)
        }),
        get_router_token: Box::new(move || k4.token()),
        set_router_token: Box::new(move |token| k5.set_token(token)),
        new_router_token: Box::new(keychain::new_router_token),
        desktop_dirs: DesktopDirs::new(&home().join("Library").join("Application Support")),
        managed_prefs: claude_desktop::managed_pref_paths(),
        desktop_info: Box::new(claude_desktop::info),
        desktop_running: Box::new(claude_desktop::running),
        desktop_quit: Box::new(claude_desktop::quit),
        desktop_open: Box::new(claude_desktop::open),
        workbuddy_dir: workbuddy_dir(),
        // 同 skill 页的认法（macOS 上只认应用包，卸载后留下的 ~/.workbuddy 不算，#247）
        workbuddy_installed: Box::new(|| {
            sophia_core::discovery::installed_products(&sophia_core::discovery::Env::from_system())
                .iter()
                .any(|h| h.id == "workbuddy")
        }),
        load_workbuddy: Box::new(move || {
            Ok(Store::new(store_dir_for_workbuddy_load.clone())
                .load_settings()?
                .workbuddy_gateway)
        }),
        save_workbuddy: Box::new(move |gateway| {
            let store = Store::new(store_dir_for_workbuddy_save.clone());
            let _guard = store.lock_settings();
            let mut settings = store.load_settings()?;
            settings.workbuddy_gateway = gateway.clone();
            store.save_settings(&settings)
        }),
    })
}

/// WorkBuddy 的数据目录：`WORKBUDDY_CONFIG_DIR`（同 WorkBuddy 自己的认法），没有用 `~/.workbuddy`
fn workbuddy_dir() -> PathBuf {
    std::env::var_os("WORKBUDDY_CONFIG_DIR")
        .map(PathBuf::from)
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| home().join(".workbuddy"))
}

/// 这个地址按系统设置走不走代理（连不上时据此说是代理的事，见 `provider::classify_send_error`）
fn proxied(resolve: &ProxyFn, address: &str) -> bool {
    url::Url::parse(address.trim()).is_ok_and(|url| resolve(&url).is_some())
}

/// 拉取模型列表：返回网关的模型（`id` 与网关给了的上下文长度）和探明的接口基址
pub async fn fetch_models(base_url: &str, key: &str) -> Result<(Vec<Model>, String), AppError> {
    fetch_models_detailed(base_url, key)
        .await
        .map_err(|failure| failure.error)
}

/// 向第三方网关发请求用的客户端：不跟随重定向（带着密钥），代理按 macOS 系统设置
/// 同时交回解析代理用的那一份（判断某个地址走不走代理）
fn gateway_client() -> Result<(reqwest::Client, ProxyFn), AppError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let resolve = system_proxy();
    let client = with_proxy(provider::client_builder_defaults(), resolve.clone())
        .build()
        .map_err(|e| AppError::new("internal", e.to_string()))?;
    Ok((client, resolve))
}

/// 启用前试调一个模型（[`provider::probe_model`]，等 [`provider::PROBE_TIMEOUT`]）。`target` 由
/// `App::probe_target` 取（地址、协议同路由；缺密钥、没有这一家报 `invalid`，不联网）。
/// 这里不写任何文件，调用方不必持 `config_lock`（结果说明了密钥时由调用方经 [`probe_verdict`] 记到网关上）。
/// 界面命令 `providers_set_enabled` / `providers_add_typed` 与 `Sophia gateway probe` 都经这里。错误代码：`invalid`、`auth`（401/403）、`network`（连不上、超时）、
/// `upstream`（别的非 2xx）
pub async fn probe_target(target: &crate::app::ProbeTarget) -> Result<(), AppError> {
    let (client, resolve) = gateway_client()?;
    provider::probe_model(
        &client,
        &target.api_base,
        target.protocol,
        &target.model,
        &target.key,
        provider::PROBE_TIMEOUT,
        proxied(&resolve, &target.api_base),
    )
    .await
    .map_err(|e| {
        let code = match e.kind {
            provider::ProbeErrorKind::Invalid => "invalid",
            provider::ProbeErrorKind::Auth => "auth",
            provider::ProbeErrorKind::Network => "network",
            provider::ProbeErrorKind::Upstream => "upstream",
        };
        AppError::new(code, e.message).with_detail(e.detail)
    })
}

/// 试调的结果对密钥说明了什么（#144）：通了＝密钥被接受，`auth`（401/403）＝被拒（带技术原文），
/// 别的失败（连不上、别的非 2xx、没联网就失败）说明不了密钥。调用方拿它调 `App::record_key_verdict`
pub fn probe_verdict(result: &Result<(), AppError>) -> Option<KeyVerdict> {
    match result {
        Ok(()) => Some(KeyVerdict::Accepted),
        Err(e) if e.code == "auth" => Some(KeyVerdict::Rejected {
            detail: e.detail.clone().unwrap_or_default(),
        }),
        Err(_) => None,
    }
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
    let (client, resolve) = gateway_client().map_err(|error| FetchFailure {
        error,
        unreachable: None,
    })?;
    let proxied = proxied(&resolve, base_url);
    match provider::fetch_models(&client, base_url, key, Duration::from_secs(10), proxied).await {
        Ok(result) => Ok((result.models, result.api_base)),
        Err(e) => {
            // 代码约定不变（docs/gateway-commands.md）：鉴权失败是 auth，其余都是 network；原因的细分在句子与
            // 记在那一行上的种类里，技术原文跟在 `[detail]` 后面
            let code = if matches!(e.kind, provider::FetchErrorKind::Auth) {
                "auth"
            } else {
                "network"
            };
            Err(FetchFailure {
                error: AppError::new(code, e.message).with_detail(e.detail),
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

const USAGE: &str = "用法: Sophia gateway <命令> [--agent codex|claude|workbuddy]\n  run           在前台运行本机路由（调试用；平时路由在 Sophia 进程里）\n  status        当前状态（JSON；带 --agent 时只打印那一家；Claude 那一份带 profile 里写着的模型 profileModels）\n  doctor        诊断：设置、路由、端口、版本、最近日志\n  restore       移除本功能写入这一家的一切（界面不可用时应急）\n  enable        按已保存的网关和模型启用（界面不可用时应急）\n  provider-add  --url <地址> --key-env <环境变量名> [--name <名称>]：加一家模型提供商（所有 agent 共用），密钥从环境变量读，拉取模型、按默认规则启用（不选进任何 agent，要用的再 select）\n  select        --models <提供商 id/模型,…>：按顺序设这一家的已选（覆盖；官方模型写 @official/<slug>）\n  probe         --provider <提供商 id> --model <模型 id>：同界面启用前的试调，通了打印 ok，不通打印原因并以 1 退出\n  restart       --agent claude：同界面的「重启生效」（在跑则退出→写→打开）\n  launch        --agent claude：同界面的「打开 Claude」（有待生效先写再打开）\n  adopt-key     把 agents-manager 钥匙串里的密钥复制进 Sophia 的密钥文件（密钥不显示）\n  --agent       作用于哪一家：codex（缺省）、claude（Claude 桌面应用）或 workbuddy（只认 status、enable、restore、select）"; // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面

/// `--agent codex|claude|workbuddy`，缺省 codex（保持文档里已写的含义）
fn agent_flag(args: &[String]) -> Result<Option<Agent>, String> {
    match flag(args, "--agent") {
        None if args.iter().any(|a| a == "--agent") => {
            Err("--agent 后面要写 codex、claude 或 workbuddy".to_owned()) // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
        }
        None => Ok(None),
        Some(value) => Agent::parse(value)
            .map(Some)
            .ok_or_else(|| format!("不认识的 --agent {value}：只能是 codex、claude 或 workbuddy")), // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
    }
}

/// `provider-add` 的参数
#[derive(Debug, PartialEq, Eq)]
struct ProviderAdd {
    url: String,
    key: String,
    name: String,
}

/// `provider-add --url <地址> --key-env <环境变量名> [--name <名称>]`。密钥只从环境变量读：写在参数里会进 shell 历史，
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
        name: flag(args, "--name").unwrap_or_default().trim().to_owned(),
    })
}

/// `select --models <提供商 id/模型,…>`：按顺序的「已选」（官方模型写 `@official/<slug>`）。模型 id 里可以有 `/`，
/// 只按第一个 `/` 切
fn select_args(args: &[String]) -> Result<Vec<ModelRef>, String> {
    let picks: Vec<ModelRef> = flag(args, "--models")
        .ok_or("需要 --models <提供商 id/模型，逗号分隔>")? // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
        .split(',')
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(|item| {
            item.split_once('/')
                .filter(|(p, m)| !p.trim().is_empty() && !m.trim().is_empty())
                .map(|(p, m)| ModelRef::new(p.trim(), m.trim()))
                .ok_or_else(|| format!("{item} 不是「提供商 id/模型」的写法")) // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
        })
        .collect::<Result<_, _>>()?;
    if picks.is_empty() {
        let empty = "--models 里没有模型；要全部取消请在界面里操作"; // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
        return Err(empty.to_owned());
    }
    Ok(picks)
}

/// `probe --provider <提供商 id> --model <模型 id>`
fn probe_args(args: &[String]) -> Result<(String, String), String> {
    let provider = flag(args, "--provider")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or("需要 --provider <提供商 id>（见 status 里 models.groups[].provider）")?; // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
    let model = flag(args, "--model")
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .ok_or("需要 --model <模型 id>（见 status 里 models.groups[].models[].ref.model）")?; // i18n-exempt: 网关命令行（Sophia gateway …）的终端输出，不进界面
    Ok((provider.to_owned(), model.to_owned()))
}

/// `probe`：同界面启用前的试调（`App::probe_target` → `probe_target`，同一条路）。结果说明了密钥时
/// 记到那一家提供商上（`probe_verdict`，#144），别的文件不写
fn probe(app: &App, args: &[String]) -> Result<(), String> {
    let (provider_id, model_id) = probe_args(args)?;
    let target = app
        .probe_target(&provider_id, &model_id)
        .map_err(|e| e.to_string())?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let result = runtime.block_on(probe_target(&target));
    if let Some(verdict) = probe_verdict(&result) {
        if let Err(e) = app.record_key_verdict(&provider_id, verdict) {
            eprintln!("{e}");
        }
    }
    result.map_err(|e| e.to_string())?;
    println!("ok");
    Ok(())
}

fn print_warnings(warnings: Vec<String>) {
    for warning in warnings {
        eprintln!("注意: {warning}");
    }
}

/// `provider-add`：同界面「添加模型提供商」——先拉模型（不持锁），成功再存名单与密钥、按默认规则启用。
/// 启用与选是两步（2026-10-08）：不选进任何 agent，要用的再 `select`
fn provider_add(store_dir: &Path, args: &[String]) -> Result<(), String> {
    let add = provider_add_args(args, |name| std::env::var(name).ok())?;
    let cleaned = crate::app::clean_base_url(&add.url).map_err(|e| e.to_string())?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let (fetched, api_base) = runtime
        .block_on(fetch_models(&cleaned, &add.key))
        .map_err(|e| e.to_string())?;
    let book = Book::new(store_dir);
    let added = book
        .add(
            sophia_core::model_providers::NewProvider {
                name: add.name,
                base_url: cleaned,
                api_base,
                protocol: "chat".into(),
                fetched,
                ..Default::default()
            },
            &add.key,
        )
        .map_err(|e| e.to_string())?;
    let out = serde_json::json!({
        "providerId": added.id,
        "enabled": added.enabled,
        "models": added.total,
    });
    println!("{out}");
    Ok(())
}

/// `select`：按顺序设这一家的已选（`App::set_picks`，覆盖）；开着时的重写与待生效同界面
fn select(app: &App, agent: Agent, args: &[String]) -> Result<(), String> {
    let picks = select_args(args)?;
    let shown: Vec<String> = picks
        .iter()
        .map(|r| format!("{}/{}", r.provider, r.model))
        .collect();
    print_warnings(app.set_picks(agent, picks).map_err(|e| e.to_string())?);
    eprintln!("已选 {} 个：{}", shown.len(), shown.join(", "));
    Ok(())
}

/// `Sophia gateway …`；返回进程退出码。`system_tags` 是系统首选语言列表（壳里读 `NSLocale`），
/// 界面语言设成「跟随系统」时路由用它解析
pub fn cli(args: Vec<String>, store_dir: PathBuf, system_tags: fn() -> Vec<String>) -> i32 {
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
        (Some("run"), _) => run_router(
            &args[1..],
            &store_dir,
            saved_locale(store_dir.clone(), system_tags),
        ),
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
        (Some("restore"), Some(Agent::WorkBuddy)) => build_app(store_dir)
            .restore_workbuddy()
            .map_err(|e| e.to_string())
            .map(|warnings| {
                for warning in warnings {
                    eprintln!("注意: {warning}");
                }
                eprintln!("已关掉。WorkBuddy 会自动重读，Sophia 加的模型从它的列表里消失。");
            }),
        (Some("enable"), Some(Agent::WorkBuddy)) => build_app(store_dir)
            .enable_workbuddy()
            .map_err(|e| e.to_string())
            .map(|()| {
                eprintln!("已打开。WorkBuddy 会自动重读，所选的模型出现在它的「自定义模型」里（Sophia 要开着）。");
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
        (Some("provider-add"), _) => provider_add(&store_dir, &args),
        (Some("select"), agent) => select(&build_app(store_dir), agent.unwrap_or(Agent::Codex), &args),
        (Some("probe"), _) => probe(&build_app(store_dir), &args),
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
            .map(|id| eprintln!("已把 agents-manager 的密钥复制到模型提供商 {id}（存进 Sophia 的密钥文件）。")),
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

/// 路由的当前语言：每次调用重读 `settings.json` 里的界面语言。
///
/// 为什么每个请求重读，而不是只在启动时读一次：换语言只写这份文件（`Store::set_language`），
/// 路由是 launchd 拉起的另一个进程，收不到界面的通知；为换语言重启后台服务会掐断进行中的请求。
/// 这份文件几 KB、写入是原子替换，读一次比一次上游往返小几个数量级，也不必另起监视文件的线程。
/// 读不到（文件坏了）返回 None，路由沿用上一次的语言。
/// 「跟随系统」的系统语言只在第一次用到时读一次：界面自己也只在启动时读
pub fn saved_locale(store_dir: PathBuf, system_tags: fn() -> Vec<String>) -> LocaleSource {
    let store = Store::new(store_dir);
    let system = OnceLock::new();
    Arc::new(move || {
        let setting = store.load_settings().ok()?.language;
        Some(i18n::resolve(setting, || {
            system.get_or_init(system_tags).clone()
        }))
    })
}

type FetchKey = Box<dyn Fn(&str) -> Result<Option<String>, KeyStoreError> + Send + Sync>;

/// 路由按家缓存的服务商密钥（spec 非功能需求）：每家网关各自缓存 `ttl`。
/// 文件里确认没有（`Ok(None)`）才清掉缓存；读不出、格式损坏时照用已缓存的值（过期了也用），
/// 免得文件一时读不出就让正在用的模型全部失败（AC7）
struct CachedKeys {
    fetch: FetchKey,
    ttl: Duration,
    now: Box<dyn Fn() -> Instant + Send + Sync>,
    state: Mutex<std::collections::HashMap<String, (String, Instant)>>,
}

impl CachedKeys {
    fn new(
        fetch: impl Fn(&str) -> Result<Option<String>, KeyStoreError> + Send + Sync + 'static,
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

    fn get(&self, provider_id: &str) -> Result<String, String> {
        let now = (self.now)();
        if let Some((value, expires_at)) = self.state.lock().unwrap().get(provider_id) {
            if now < *expires_at {
                return Ok(value.clone());
            }
        }
        // 读文件时不占着锁：一家慢不拖住别家
        let fetched = (self.fetch)(provider_id);
        let mut state = self.state.lock().unwrap();
        match fetched {
            Ok(Some(value)) => {
                state.insert(provider_id.to_owned(), (value.clone(), now + self.ttl));
                Ok(value)
            }
            Ok(None) => {
                state.remove(provider_id);
                Err(sophia_core::t!("models.app.noKey"))
            }
            Err(error) => match state.get(provider_id) {
                Some((value, _)) => Ok(value.clone()),
                None => Err(error.to_string()),
            },
        }
    }
}

/// `gateway run`：在前台运行路由（调试用；平时路由在 Sophia 进程里）。清单、日志的位置缺省同界面进程，
/// 参数里给了就用参数的（旧版本 launchd 服务的启动参数仍能跑）
fn run_router(args: &[String], store_dir: &Path, locale: LocaleSource) -> Result<(), String> {
    let port: u16 = flag(args, "--port")
        .map_or(
            Ok(sophia_core::codex_models::settings::DEFAULT_PORT),
            str::parse,
        )
        .map_err(|_| "端口不合法".to_owned())?; // i18n-exempt: 网关命令行的参数错误，只在终端出现，不进界面
    let (routing, claude_routing, workbuddy_routing, log) = router_paths(store_dir);
    let protocol = if flag(args, "--protocol") == Some("responses") {
        Protocol::Responses
    } else {
        Protocol::Chat
    };
    let (third_party_key, router_token) = router_secrets(store_dir);
    // 前台路由也把密钥结论记到网关上（#144）：经命令行形态的编排层，同命令行的其他写设置命令
    let app = Arc::new(build_app(store_dir.to_path_buf()));
    let key_verdicts = key_verdict_recorder(Arc::downgrade(&app));
    let router = Router::new(Config {
        // 旧版本装的后台服务启动参数里带着唯一的上游；新清单里上游写在清单里，这个参数可以没有
        third_party_url: flag(args, "--third-party-url")
            .unwrap_or_default()
            .to_owned(),
        third_party_protocol: protocol,
        chatgpt_url: String::new(),
        openai_url: String::new(),
        routing_catalog_path: flag(args, "--routing-catalog").map_or(routing, PathBuf::from),
        activity_log_path: Some(flag(args, "--log").map_or(log, PathBuf::from)),
        third_party_key,
        max_body_bytes: 0,
        proxy: Some(system_proxy()),
        claude_routing_path: Some(
            flag(args, "--claude-routing").map_or(claude_routing, PathBuf::from),
        ),
        workbuddy_routing_path: Some(workbuddy_routing),
        router_token,
        keepalive: Duration::ZERO,
        locale: Some(locale),
        key_verdicts: Some(key_verdicts),
    })?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(async move {
        // 只监听回环地址；路由内部还会再按来源地址和 Host 拒绝一次
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| format!("监听 127.0.0.1:{port} 失败: {e}"))?; // i18n-exempt: 网关命令行的启动错误，只在终端出现，不进界面
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
        "路由（在 Sophia 进程里）端口 {} 上运行中: {}",
        state.router.port,
        yes_no(state.router.running)
    );
    if !state.router.error.is_empty() {
        println!("路由问题: {}", state.router.error);
    }
    print_models(view, store_dir);
    print_router_log(store_dir);
}

/// doctor 里这一家的「已选」与用到的模型提供商（地址、协议、密钥有没有）
fn print_models(view: &crate::app::AgentGatewayView, store_dir: &Path) {
    let picked: Vec<String> = view
        .models
        .picked
        .iter()
        .map(|p| {
            if p.provider_name.is_empty() {
                p.display_name.clone()
            } else {
                format!("{} ({})", p.display_name, p.provider_name)
            }
        })
        .collect();
    println!(
        "已选模型: {}",
        if picked.is_empty() {
            "-".to_owned()
        } else {
            picked.join(", ")
        }
    );
    let book = Book::new(store_dir);
    let list: ModelProviders = book.load().unwrap_or_default();
    if list.providers.is_empty() {
        println!("模型提供商: 还没有添加"); // i18n-exempt: doctor 是网关命令行的诊断输出，只在终端出现，不进界面
    }
    for provider in &list.providers {
        let key = match book.key(&provider.id) {
            Ok(Some(_)) => "是".to_owned(), // i18n-exempt: doctor 是网关命令行的诊断输出，只在终端出现，不进界面
            Ok(None) => "否".to_owned(),    // i18n-exempt: 同上
            Err(e) => format!("读不出（{e}）"), // i18n-exempt: 同上
        };
        println!(
            "模型提供商 {}（{}）: {}；协议: {}；密钥已保存: {}；已启用 {} 个",
            provider.name,
            provider.id,
            provider.base_url,
            provider.protocol(),
            key,
            provider.enabled_count()
        );
    }
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
        "路由（在 Sophia 进程里）端口 {} 上运行中: {}",
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
    print_models(view, store_dir);
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
                name: String::new(),
            }
        );
        let parsed = provider_add_args(
            &argv(&[
                "provider-add",
                "--url",
                "https://ap.example",
                "--key-env",
                "AP_KEY",
                "--name",
                " 我的中转 ",
            ]),
            env,
        )
        .unwrap();
        assert_eq!(parsed.name, "我的中转");

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

    /// `select`：逗号分隔的「提供商 id/模型」（去空白、去空项、保持顺序；模型 id 里的 `/` 留着）
    #[test]
    fn select_parses_provider_model_pairs_in_order() {
        assert_eq!(
            select_args(&argv(&[
                "select",
                "--agent",
                "claude",
                "--models",
                " kimi/kimi-k3, ap/weibo/glm-5 ,,@official/gpt-6 "
            ]))
            .unwrap(),
            [
                ModelRef::new("kimi", "kimi-k3"),
                ModelRef::new("ap", "weibo/glm-5"),
                ModelRef::official("gpt-6"),
            ]
        );
        assert!(select_args(&argv(&["select"]))
            .unwrap_err()
            .contains("--models"));
        assert!(select_args(&argv(&["select", "--models", "glm-5"])).is_err());
        assert!(select_args(&argv(&["select", "--models", " , "])).is_err());
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

    #[test]
    fn cached_keys_survive_an_unreadable_file_but_not_a_removed_key() {
        type Answer = Result<Option<String>, KeyStoreError>;
        let answer: Arc<Mutex<Answer>> = Arc::new(Mutex::new(Ok(Some("sk-a-1234567".into()))));
        let calls = Arc::new(Mutex::new(Vec::<String>::new()));
        let now = Arc::new(Mutex::new(Instant::now()));
        let cache = CachedKeys::new(
            {
                let (answer, calls) = (answer.clone(), calls.clone());
                move |id: &str| {
                    calls.lock().unwrap().push(id.to_owned());
                    answer.lock().unwrap().clone()
                }
            },
            Duration::from_secs(30),
            {
                let now = now.clone();
                move || *now.lock().unwrap()
            },
        );
        assert_eq!(cache.get("a").unwrap(), "sk-a-1234567");
        assert_eq!(cache.get("a").unwrap(), "sk-a-1234567");
        assert_eq!(*calls.lock().unwrap(), ["a"], "30 秒内只读一次");

        // 文件读不出、格式损坏：缓存过期了也照用
        *now.lock().unwrap() += Duration::from_secs(31);
        *answer.lock().unwrap() = Err(KeyStoreError::Unreadable("Permission denied".into()));
        assert_eq!(cache.get("a").unwrap(), "sk-a-1234567");
        *answer.lock().unwrap() = Err(KeyStoreError::Corrupt);
        assert_eq!(cache.get("a").unwrap(), "sk-a-1234567");
        // 从没读到过的那一家：报读不出的原因
        assert_eq!(
            cache.get("b").unwrap_err(),
            KeyStoreError::Corrupt.to_string()
        );

        // 确认没有了（用户删了密钥）：清掉缓存，之后不再用旧值
        *answer.lock().unwrap() = Ok(None);
        assert!(cache.get("a").is_err());
        *answer.lock().unwrap() = Err(KeyStoreError::Corrupt);
        assert!(cache.get("a").is_err());
    }

    /// 编排层眼里的两种说不出密钥：没有（Ok(None)）、文件读不出
    #[test]
    fn key_file_explains_why_a_key_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let file = KeyFile::new(&root, false);
        assert_eq!(file.get("a").unwrap(), None);
        assert_eq!(file.token().unwrap(), None);
        file.set("a", "sk-again-1234567").unwrap();
        assert_eq!(file.get("a").unwrap().as_deref(), Some("sk-again-1234567"));

        std::fs::write(file.keys.path(), b"{\"version\":1,").unwrap();
        assert_eq!(
            file.get("a").unwrap_err(),
            KeyStoreError::Corrupt.to_string()
        );
        // 命令行进程不另存损坏的文件，写也写不进去
        assert!(file.set("b", "sk-new-12345678").is_err());
        assert!(file.keys.path().exists());
    }

    /// R5 / AC3：界面进程把损坏的文件另存，之后「没有」的几家说明原因；填了的那家就是有
    #[test]
    fn the_ui_sets_a_corrupt_file_aside_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("secrets.json"), b"{\"version\":1,\"provi").unwrap();
        let file = KeyFile::new(&root, true);
        file.repair();
        let broken: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("secrets.json.broken-"))
            .collect();
        assert_eq!(broken.len(), 1);
        assert_eq!(
            std::fs::read(root.join(&broken[0])).unwrap(),
            b"{\"version\":1,\"provi"
        );
        let repaired = sophia_core::t!("models.secrets.repaired");
        assert_eq!(file.get("a").unwrap_err(), repaired);
        file.set("a", "sk-again-1234567").unwrap();
        assert!(file.get("a").unwrap().is_some());
        assert_eq!(file.get("b").unwrap_err(), repaired);
    }
}
