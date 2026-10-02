//! 编排层的行为测试，移植自 agents-manager 的 internal/app/app_test.go。
use super::*;
use sophia_core::claude_models::settings::ClaudeGatewaySettings;
use sophia_core::codex_models::catalog::Model;
use std::sync::{Arc, Mutex};

const ORIGINAL: &str = "model = \"gpt-5.6-sol\"\nmodel_reasoning_effort = \"high\"\n\n[mcp_servers]\n\n[mcp_servers.node_repl]\ncommand = \"/x/node_repl\"\n";
const NATIVE_CACHE: &str = r#"{"client_version":"0.154.0","models":[{"slug":"gpt-5.6-sol","display_name":"GPT-5.6 Sol","priority":2,"visibility":"list","base_instructions":"You are Codex."}]}"#;

#[derive(Default)]
pub(super) struct World {
    pub(super) settings: GatewaySettings,
    pub(super) service_calls: Vec<String>,
    /// 每次 restart 传进来的 label，用来确认我们只重启自己那个服务
    restart_labels: Vec<String>,
    /// 非空时 restart 失败，内容就是 launchctl 的原话
    restart_error: Option<String>,
    pub(super) installed: Option<service::Spec>,
    old_service_installed: bool,
    pub(super) healthy: bool,
    /// 任何一家都能读到的密钥：原有的单网关用例靠它；也记着最近一次写入的值
    key: Option<String>,
    /// 按网关 id 分开存的密钥，优先于 `key`
    pub(super) keys: std::collections::HashMap<String, String>,
    /// 写密钥失败的网关 id
    key_write_fails_for: Option<String>,
    pub(super) deleted_keys: Vec<String>,
    old_key: Option<String>,
    /// 假进程表：结束进程的测试不真杀进程
    processes: Vec<process::ProcessInfo>,
    /// 实际被发过 SIGTERM 的 pid
    terminated: Vec<u32>,
    /// 非空时发信号失败，内容就是系统的原话
    terminate_error: Option<String>,
    /// 打开 Codex 桌面应用被调了几次：测试不真去打开
    launches: u32,
    /// 非空时打开失败，内容就是系统的原话
    launch_error: Option<String>,
    // ----- Codex 桌面应用（重启生效用；测试不真去退出或打开） -----
    /// 装着的显示名；空串＝没装
    codex_app_name: String,
    codex_app_running: bool,
    /// 查不了在不在运行（`lsappinfo` 不可用）
    codex_app_running_fails: bool,
    /// 退出请求发出后它一直不退（在等人确认）
    codex_app_stuck: bool,
    /// 非空时重新打开失败：`(错误种类, 原话)`
    codex_app_open_error: Option<(std::io::ErrorKind, String)>,
    /// 这些 pid 在收到 SIGTERM 之前已经自己退了：kill 报「No such process」，进程表里也没了
    vanished: Vec<u32>,
    /// Codex 桌面应用与结束进程的调用顺序：quit / term <pid> / open
    codex_events: Vec<String>,
    codex_started_at: Option<u64>,
    codex_version: String,
    now: u64,
    on_health: Option<Box<dyn Fn() + Send>>,
    binary_changed: bool,
    // ----- 家 claude（claude_tests.rs 用） -----
    pub(super) claude: ClaudeGatewaySettings,
    /// `/_health` 的 features；重启服务后换成 `features_after_restart`（给了的话）
    pub(super) features: Vec<String>,
    pub(super) features_after_restart: Option<Vec<String>>,
    /// 钥匙串里的令牌
    pub(super) token: Option<String>,
    /// 下一次生成的令牌
    pub(super) next_token: String,
    /// 桌面应用装着的版本；None＝没装
    pub(super) desktop_version: Option<String>,
    pub(super) desktop_installed: bool,
    pub(super) running: bool,
    /// 非空时退出请求失败；`TimedOut` 表示它没退
    pub(super) quit_error: Option<std::io::ErrorKind>,
    /// 非空时打开失败，内容就是 open 的原话
    pub(super) open_error: Option<String>,
    /// 调用顺序：quit / open / lock / unlock / save:<phase>
    pub(super) events: Vec<String>,
}

/// 见 `Fixture::codex_state`
pub(super) struct CodexState {
    pub(super) providers: Vec<ProviderView>,
    pub(super) enabled: bool,
    pub(super) needs_codex_restart: bool,
    pub(super) router: RouterView,
    pub(super) codex: CodexView,
    pub(super) conflict: String,
    pub(super) takeover: Option<TakeoverOffer>,
}

pub(super) struct Fixture {
    pub(super) app: App,
    pub(super) world: Arc<Mutex<World>>,
    /// 真实路径：macOS 上 /var 是指向 /private/var 的软链，而安全写入会拒绝父路径里的软链
    pub(super) root: PathBuf,
    _dir: tempfile::TempDir,
}

impl Fixture {
    pub(super) fn codex(&self) -> PathBuf {
        self.root.join("codex")
    }
    pub(super) fn config(&self) -> PathBuf {
        self.codex().join("config.toml")
    }
    pub(super) fn read_config(&self) -> String {
        std::fs::read_to_string(self.config()).unwrap()
    }
    pub(super) fn write_config(&self, text: &str) {
        std::fs::write(self.config(), text).unwrap();
    }
    /// 第一家网关的 id：多数用例只有一家
    fn first_provider(&self) -> Option<String> {
        self.app
            .load()
            .unwrap()
            .providers
            .first()
            .map(|p| p.id.clone())
    }
    /// 存网关地址：有网关就改第一家，没有就新建（原 `App::save_provider` 的写法，spec R39 删了它；用例照旧这样搭）
    pub(super) fn save_provider(&self, base_url: &str) -> Result<(), AppError> {
        let id = self.first_provider();
        self.app
            .upsert_provider_in(Agent::Codex, id.as_deref(), None, base_url, false)
            .map(|_| ())
    }
    /// 勾选第一家的模型
    pub(super) fn set_models(&self, selected: Vec<Model>) -> Result<(), AppError> {
        let id = self.first_provider().expect("还没有网关");
        self.app
            .set_models_in(Agent::Codex, &id, selected)
            .map(|_| ())
    }
    /// 把拉到的模型并入第一家
    pub(super) fn merge_fetched_models(
        &self,
        ids: Vec<Model>,
        api_base: &str,
    ) -> Result<(), AppError> {
        let id = self.first_provider().expect("还没有网关");
        self.app
            .merge_fetched_models_in(Agent::Codex, &id, ids, api_base)
    }
    /// 已校验过密钥：存第一家（没有就新建）的地址、密钥与模型
    pub(super) fn commit_verified_provider(
        &self,
        base_url: &str,
        key: &str,
        ids: Vec<Model>,
        api_base: &str,
    ) -> Result<(), AppError> {
        let id = self.first_provider();
        self.app
            .commit_verified_provider_in(
                Agent::Codex,
                id.as_deref(),
                None,
                base_url,
                key,
                ids,
                api_base,
                false,
            )
            .map(|_| ())
    }
    /// Codex 那一家的状态，拍平成按家拆开之前的样子：spec R39 删了 `GatewayState` 顶层的 Codex 字段，
    /// 这些用例只测 Codex，断言照旧读这几个名字
    pub(super) fn codex_state(&self) -> CodexState {
        let state = self.app.state();
        let view = state.agent(Agent::Codex).cloned().expect("Codex 总在");
        let codex = view.codex.unwrap_or_default();
        CodexState {
            providers: view.providers,
            enabled: view.enabled,
            needs_codex_restart: codex.needs_restart,
            router: state.router,
            codex: codex.app,
            conflict: view.conflict,
            takeover: codex.takeover,
        }
    }
    pub(super) fn configure(&self) {
        self.save_provider("https://gw.example/openai/").unwrap();
        self.set_models(vec![Model {
            id: "weibo/glm-5".into(),
            display_name: Some("Weibo GLM-5".into()),
            ..Default::default()
        }])
        .unwrap();
    }
    pub(super) fn routing(&self) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(self.codex().join("sophia-routing.json")).unwrap())
            .unwrap()
    }
    pub(super) fn args(&self) -> String {
        self.world
            .lock()
            .unwrap()
            .installed
            .as_ref()
            .map(|s| s.args.join(" "))
            .unwrap_or_default()
    }
}

pub(super) fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let codex = root.join("codex");
    std::fs::create_dir_all(&codex).unwrap();
    std::fs::write(codex.join("config.toml"), ORIGINAL).unwrap();
    std::fs::write(codex.join("auth.json"), r#"{"tokens":"official-secret"}"#).unwrap();
    std::fs::write(codex.join("models_cache.json"), NATIVE_CACHE).unwrap();
    let world = Arc::new(Mutex::new(World {
        healthy: true,
        key: Some("sk-test-key-123456".into()),
        codex_version: "0.154.0".into(),
        now: 2_000_000_000,
        features: vec!["claude".into()],
        next_token: format!("sophia-{}", "A".repeat(43)),
        desktop_installed: true,
        desktop_version: Some("2.9939.4".into()),
        ..Default::default()
    }));
    let w = world.clone();
    let deps = Deps {
        codex_home: codex,
        data_dir: root.join("data"),
        agents_manager_dir: root.join("agents-manager"),
        load_settings: Box::new({
            let w = w.clone();
            move || Ok(w.lock().unwrap().settings.clone())
        }),
        save_settings: Box::new({
            let w = w.clone();
            move |s| {
                w.lock().unwrap().settings = s.clone();
                Ok(())
            }
        }),
        service_install: Box::new({
            let w = w.clone();
            move |spec| {
                let mut w = w.lock().unwrap();
                w.service_calls.push("install".into());
                w.installed = Some(spec.clone());
                Ok(())
            }
        }),
        service_uninstall: Box::new({
            let w = w.clone();
            move |label| {
                let mut w = w.lock().unwrap();
                w.service_calls.push(format!("uninstall {label}"));
                if label == SERVICE_LABEL {
                    w.installed = None
                } else {
                    w.old_service_installed = false
                }
                Ok(())
            }
        }),
        service_status: Box::new({
            let w = w.clone();
            move |_| {
                let installed = w.lock().unwrap().installed.is_some();
                Ok(service::Status {
                    installed,
                    loaded: installed,
                    ..Default::default()
                })
            }
        }),
        service_restart: Box::new({
            let w = w.clone();
            move |label| {
                let mut w = w.lock().unwrap();
                w.service_calls.push("restart".into());
                w.restart_labels.push(label.to_owned());
                if let Some(features) = w.features_after_restart.clone() {
                    w.features = features;
                }
                match w.restart_error.clone() {
                    Some(message) => Err(std::io::Error::other(message)),
                    None => Ok(()),
                }
            }
        }),
        router_healthy: Box::new({
            let w = w.clone();
            move |_| {
                if let Some(hook) = &w.lock().unwrap().on_health {
                    hook();
                }
                if w.lock().unwrap().healthy {
                    Ok(())
                } else {
                    Err("connection refused".into())
                }
            }
        }),
        bundled: Box::new(|| Err(std::io::Error::other("not needed"))),
        // Codex 的账户按 id 存（原有用例的断言不变），Claude 的按 `claude:<id>` 存
        get_key: Box::new({
            let w = w.clone();
            move |agent, id| {
                let w = w.lock().unwrap();
                w.keys
                    .get(&key_slot(agent, id))
                    .cloned()
                    .or_else(|| w.key.clone())
                    .ok_or_else(|| "not set".to_owned())
            }
        }),
        set_key: Box::new({
            let w = w.clone();
            move |agent, id, k| {
                let mut w = w.lock().unwrap();
                if w.key_write_fails_for.as_deref() == Some(key_slot(agent, id).as_str()) {
                    return Err("keychain is locked".to_owned());
                }
                w.keys.insert(key_slot(agent, id), k.to_owned());
                if agent == Agent::Codex {
                    w.key = Some(k.to_owned());
                }
                Ok(())
            }
        }),
        delete_key: Box::new({
            let w = w.clone();
            move |agent, id| {
                let mut w = w.lock().unwrap();
                w.keys.remove(&key_slot(agent, id));
                w.deleted_keys.push(key_slot(agent, id));
                Ok(())
            }
        }),
        get_agents_manager_key: Box::new({
            let w = w.clone();
            move || {
                w.lock()
                    .unwrap()
                    .old_key
                    .clone()
                    .ok_or_else(|| "not set".to_owned())
            }
        }),
        install_binary: Box::new({
            let w = w.clone();
            move |_| Ok(w.lock().unwrap().binary_changed)
        }),
        list_processes: Box::new({
            let w = w.clone();
            move || Ok(w.lock().unwrap().processes.clone())
        }),
        terminate: Box::new({
            let w = w.clone();
            move |pid| {
                let mut w = w.lock().unwrap();
                w.codex_events.push(format!("term {pid}"));
                if w.vanished.contains(&pid) {
                    w.processes.retain(|p| p.pid != pid);
                    return Err(std::io::Error::other(format!(
                        "kill: {pid}: No such process"
                    )));
                }
                match w.terminate_error.clone() {
                    Some(message) => Err(std::io::Error::other(message)),
                    None => {
                        w.terminated.push(pid);
                        Ok(())
                    }
                }
            }
        }),
        launch_codex: Box::new({
            let w = w.clone();
            move || {
                let mut w = w.lock().unwrap();
                match w.launch_error.clone() {
                    Some(message) => Err(std::io::Error::other(message)),
                    None => {
                        w.launches += 1;
                        Ok(())
                    }
                }
            }
        }),
        codex_app_name: Box::new({
            let w = w.clone();
            move || w.lock().unwrap().codex_app_name.clone()
        }),
        codex_app_running: Box::new({
            let w = w.clone();
            move || {
                let w = w.lock().unwrap();
                if w.codex_app_running_fails {
                    return Err(std::io::Error::other("lsappinfo: not found"));
                }
                Ok(w.codex_app_running)
            }
        }),
        codex_app_quit: Box::new({
            let w = w.clone();
            move || {
                let mut w = w.lock().unwrap();
                w.codex_events.push("quit".into());
                if w.codex_app_stuck {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "still running",
                    ));
                }
                w.codex_app_running = false;
                // 桌面应用自己拉起的 app-server 跟着它退
                w.processes
                    .retain(|p| !p.command.starts_with("/Applications/ChatGPT.app/"));
                Ok(())
            }
        }),
        codex_app_open: Box::new({
            let w = w.clone();
            move || {
                let mut w = w.lock().unwrap();
                w.codex_events.push("open".into());
                match w.codex_app_open_error.clone() {
                    Some((kind, message)) => Err(std::io::Error::new(kind, message)),
                    None => {
                        w.codex_app_running = true;
                        Ok(())
                    }
                }
            }
        }),
        codex_started_at: Box::new({
            let w = w.clone();
            move || w.lock().unwrap().codex_started_at
        }),
        codex_version: Box::new({
            let w = w.clone();
            move || w.lock().unwrap().codex_version.clone()
        }),
        now: Box::new({
            let w = w.clone();
            move || w.lock().unwrap().now
        }),
        load_claude: Box::new({
            let w = w.clone();
            move || Ok(w.lock().unwrap().claude.clone())
        }),
        save_claude: Box::new({
            let w = w.clone();
            move |s| {
                let mut w = w.lock().unwrap();
                let phase = s.applied.as_ref().map_or("none".to_owned(), |a| {
                    format!("{:?}", a.phase).to_lowercase()
                });
                w.events.push(format!("save:{phase}"));
                w.claude = s.clone();
                Ok(())
            }
        }),
        router_features: Box::new({
            let w = w.clone();
            move |_| Ok(w.lock().unwrap().features.clone())
        }),
        get_router_token: Box::new({
            let w = w.clone();
            move || Ok(w.lock().unwrap().token.clone())
        }),
        set_router_token: Box::new({
            let w = w.clone();
            move |token| {
                w.lock().unwrap().token = Some(token.to_owned());
                Ok(())
            }
        }),
        new_router_token: Box::new({
            let w = w.clone();
            move || Ok(w.lock().unwrap().next_token.clone())
        }),
        desktop_dirs: sophia_core::claude_models::desktop::DesktopDirs::new(
            &root.join("appsupport"),
        ),
        managed_prefs: vec![
            root.join("managed").join("user.plist"),
            root.join("managed").join("machine.plist"),
        ],
        desktop_info: Box::new({
            let w = w.clone();
            move || {
                let w = w.lock().unwrap();
                w.desktop_installed.then(|| DesktopInfo {
                    app_path: PathBuf::from("/Applications/Claude.app"),
                    version: w.desktop_version.clone(),
                })
            }
        }),
        desktop_running: Box::new({
            let w = w.clone();
            move || Ok(w.lock().unwrap().running)
        }),
        desktop_quit: Box::new({
            let w = w.clone();
            move || {
                let mut w = w.lock().unwrap();
                w.events.push("quit".into());
                match w.quit_error {
                    Some(kind) => Err(std::io::Error::new(kind, "still running")),
                    None => {
                        w.running = false;
                        Ok(())
                    }
                }
            }
        }),
        desktop_open: Box::new({
            let w = w.clone();
            move || {
                let mut w = w.lock().unwrap();
                w.events.push("open".into());
                match w.open_error.clone() {
                    Some(message) => Err(std::io::Error::other(message)),
                    None => {
                        w.running = true;
                        Ok(())
                    }
                }
            }
        }),
    };
    Fixture {
        app: App::new(deps),
        world,
        root,
        _dir: dir,
    }
}

/// 假钥匙串里的位置：Codex 的就是网关 id，Claude 的带 `claude:` 前缀
pub(super) fn key_slot(agent: Agent, id: &str) -> String {
    match agent {
        Agent::Codex => id.to_owned(),
        Agent::Claude => format!("claude:{id}"),
    }
}

pub(super) fn code(result: Result<impl Sized, AppError>) -> String {
    result.err().map(|e| e.code.to_owned()).unwrap_or_default()
}

fn our_lines(f: &Fixture) -> String {
    format!(
        "model_catalog_json = \"{}\"\nopenai_base_url = \"http://127.0.0.1:47328/v1\"\n",
        f.codex().join("sophia-models.json").display()
    )
}

/// AC18：启用只给 Codex 设置多写两行，登录凭据文件不被触碰，并留下备份
#[test]
fn ac18_enable_writes_two_lines_and_never_touches_auth() {
    let f = fixture();
    f.configure();
    let auth = f.codex().join("auth.json");
    let before = std::fs::metadata(&auth).unwrap().modified().unwrap();
    f.app.enable().unwrap();
    assert_eq!(f.read_config().replacen(&our_lines(&f), "", 1), ORIGINAL);
    assert_eq!(
        std::fs::metadata(&auth).unwrap().modified().unwrap(),
        before
    );
    assert_eq!(
        std::fs::read_to_string(&auth).unwrap(),
        r#"{"tokens":"official-secret"}"#
    );
    assert_eq!(
        std::fs::read_to_string(f.codex().join("config.models.bak")).unwrap(),
        ORIGINAL,
        "备份与 MCP 的 config.mcp.bak 不撞名"
    );
    let combined: serde_json::Value =
        serde_json::from_slice(&std::fs::read(f.codex().join("sophia-models.json")).unwrap())
            .unwrap();
    let slugs: Vec<_> = combined["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["slug"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(slugs, ["gpt-5.6-sol", "gw.example-weibo-glm-5"]);
    let routing = std::fs::read_to_string(f.codex().join("sophia-routing.json")).unwrap();
    assert!(
        routing.contains("\"upstream_model\": \"weibo/glm-5\"")
            || routing.contains("\"upstream_model\":\"weibo/glm-5\""),
        "{routing}"
    );
    assert!(f.codex_state().enabled);
}

/// R6：先确认路由健康，再写 Codex 设置；服务参数指向稳定路径和正确的上游
#[test]
fn enable_starts_router_before_writing_config() {
    let f = fixture();
    f.configure();
    let seen = Arc::new(Mutex::new(String::new()));
    let (seen2, config) = (seen.clone(), f.config());
    f.world.lock().unwrap().on_health = Some(Box::new(move || {
        *seen2.lock().unwrap() = std::fs::read_to_string(&config).unwrap()
    }));
    f.app.enable().unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        ORIGINAL,
        "路由确认健康之前就写了设置"
    );
    let world = f.world.lock().unwrap();
    let spec = world.installed.as_ref().unwrap();
    assert_eq!(spec.label, SERVICE_LABEL);
    // 后台活动通知与登录项里显示应用名 Sophia，而不是后台程序副本的文件名
    assert_eq!(spec.associated_bundle.as_deref(), Some(APP_BUNDLE_ID));
    assert_eq!(
        spec.program,
        f.root.join("data/bin/Sophia").to_string_lossy()
    );
    let args = spec.args.join(" ");
    for want in ["gateway run", "--port 47328"] {
        assert!(args.contains(want), "{args} 缺少 {want}");
    }
    // 上游地址和协议不在启动参数里，而在路由清单里：增删网关、改地址都不用重装后台服务
    for gone in ["--third-party-url", "--protocol"] {
        assert!(!args.contains(gone), "{args} 不该再带 {gone}");
    }
    assert_eq!(
        f.routing()["providers"],
        serde_json::json!([{
            "id": "gw.example",
            "base_url": "https://gw.example/openai",
            "protocol": "chat"
        }])
    );
    assert!(args.contains(&format!(
        "--routing-catalog {}",
        f.codex().join("sophia-routing.json").display()
    )));
}

/// AC26 前半：路由起不来时不写 Codex 设置
#[test]
fn enable_with_unhealthy_router_leaves_config_alone() {
    let f = fixture();
    f.configure();
    f.world.lock().unwrap().healthy = false;
    assert_eq!(code(f.app.enable()), "router_down");
    assert_eq!(f.read_config(), ORIGINAL);
    assert!(!f.codex_state().enabled);
}

/// AC19：冲突时拒绝且无任何副作用
#[test]
fn ac19_conflict_refused_without_side_effects() {
    let f = fixture();
    f.configure();
    let foreign = format!("openai_base_url = \"http://127.0.0.1:11434/api/codex/v1\"\n{ORIGINAL}");
    f.write_config(&foreign);
    let err = f.app.enable().unwrap_err();
    assert_eq!(err.code, "conflict");
    assert!(err.message.contains("openai_base_url"));
    assert_eq!(f.read_config(), foreign);
    assert!(f.world.lock().unwrap().service_calls.is_empty());
    assert!(!f.codex().join("sophia-models.json").exists());
    assert!(f.codex_state().conflict.contains("openai_base_url"));
}

#[test]
fn enable_requires_provider_key_and_models() {
    let f = fixture();
    assert_eq!(code(f.app.enable()), "invalid");
    f.configure();
    f.world.lock().unwrap().key = None;
    assert_eq!(code(f.app.enable()), "invalid");
    f.world.lock().unwrap().key = Some("sk-test-key-123456".into());
    f.set_models(vec![]).unwrap();
    assert_eq!(code(f.app.enable()), "invalid");
}

/// 密钥会随请求发给网关：只允许 https（本机回环除外），地址里不能带用户名密码
#[test]
fn gateway_url_must_be_https_without_credentials() {
    let f = fixture();
    for bad in [
        "",
        "gw.example/openai",
        "ftp://gw.example",
        "http://gw.example/openai",
        "https://user:pass@gw.example/openai",
    ] {
        assert_eq!(code(f.save_provider(bad)), "invalid", "{bad}");
    }
    for ok in [
        "https://gw.example/openai",
        "http://127.0.0.1:9000/openai",
        "http://localhost:9000",
    ] {
        f.save_provider(ok).unwrap_or_else(|e| panic!("{ok}: {e}"));
    }
}

/// AC24：密钥校验通过才保存；AC25：密钥不进设置
#[test]
fn ac24_provider_is_committed_only_after_verification() {
    let f = fixture();
    f.world.lock().unwrap().key = Some("good-key-12345678".into());
    // 校验失败的路径由调用方决定不调用 commit；这里验证 commit 的结果
    f.commit_verified_provider(
        "https://gw.example/openai/",
        "  new-key-12345678 \n",
        vec!["weibo/glm-5".into(), "kimi-k3".into()],
        "https://gw.example/openai/v1",
    )
    .unwrap();
    assert_eq!(
        f.world.lock().unwrap().key.as_deref(),
        Some("new-key-12345678")
    );
    let state = f.codex_state();
    assert_eq!(state.providers[0].base_url, "https://gw.example/openai");
    assert_eq!(state.providers[0].models.len(), 2);
    assert!(!serde_json::to_string(&f.world.lock().unwrap().settings)
        .unwrap()
        .contains("new-key"));
}

/// 拉取到的接口基址用于路由的上游地址；已有的勾选和显示名保留；换地址后旧基址作废
#[test]
fn fetched_api_base_is_used_and_selection_survives() {
    let f = fixture();
    f.configure();
    f.merge_fetched_models(
        vec!["weibo/glm-5".into(), "kimi-k3".into()],
        "https://gw.example/openai/v1",
    )
    .unwrap();
    let models = f.codex_state().providers.remove(0).models;
    assert_eq!(models.len(), 2);
    let glm = models.iter().find(|m| m.id == "weibo/glm-5").unwrap();
    assert!(glm.selected && glm.display_name == "Weibo GLM-5");
    f.app.enable().unwrap();
    assert_eq!(
        f.routing()["providers"][0]["base_url"],
        "https://gw.example/openai/v1"
    );
    // 换地址：旧基址作废，清单立刻跟上；启动参数里没有地址，后台服务的参数不变
    f.save_provider("https://other.example/api").unwrap();
    assert_eq!(
        f.routing()["providers"][0]["base_url"],
        "https://other.example/api"
    );
    assert!(!f.args().contains("other.example"), "{}", f.args());
}

/// AC20：恢复后逐字节相同，本功能文件与服务清除；路由不通时照样可用
#[test]
fn ac20_restore_returns_original_bytes_and_cleans_up() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    f.world.lock().unwrap().healthy = false;
    let warnings = f.app.restore().unwrap();
    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(f.read_config(), ORIGINAL);
    let leftovers: Vec<_> = std::fs::read_dir(f.codex())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("sophia-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    assert!(f.world.lock().unwrap().installed.is_none());
    let state = f.codex_state();
    assert!(
        !state.enabled
            && state.providers[0].models.len() == 1
            && state.providers[0].models[0].selected
    );
}

#[test]
fn restore_keeps_foreign_value_and_warns() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    f.write_config(&f.read_config().replacen(
        "http://127.0.0.1:47328/v1",
        "http://127.0.0.1:11434/api/codex/v1",
        1,
    ));
    let warnings = f.app.restore().unwrap();
    assert_eq!(warnings.len(), 1);
    assert!(f.read_config().contains("11434"));
}

#[test]
fn enable_twice_is_idempotent_and_does_not_ask_for_restart() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    let first = f.read_config();
    f.world.lock().unwrap().codex_started_at = Some(2_000_000_060); // Codex 在启用之后重启过
    f.world.lock().unwrap().now = 2_000_003_600;
    f.app.enable().unwrap();
    assert_eq!(f.read_config(), first);
    assert!(
        !f.codex_state().needs_codex_restart,
        "内容没变，不该再提示重启"
    );
    f.set_models(vec![Model {
        id: "kimi-k3".into(),
        ..Default::default()
    }])
    .unwrap();
    assert!(f.codex_state().needs_codex_restart, "改了模型才需要重启");
    f.app.restore().unwrap();
    assert_eq!(f.read_config(), ORIGINAL);
}

/// AC9 的编排部分：已启用时取消勾选的模型进入停用名单；重新勾选后移出
#[test]
fn deselected_model_becomes_retired_in_routing_catalog() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    f.set_models(vec![Model {
        id: "kimi-k3".into(),
        ..Default::default()
    }])
    .unwrap();
    let routing = || -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(f.codex().join("sophia-routing.json")).unwrap())
            .unwrap()
    };
    assert_eq!(
        routing()["retired"],
        serde_json::json!(["gw.example-weibo-glm-5"])
    );
    assert_eq!(routing()["models"].as_array().unwrap().len(), 1);
    f.set_models(vec![
        Model {
            id: "kimi-k3".into(),
            ..Default::default()
        },
        Model {
            id: "weibo/glm-5".into(),
            ..Default::default()
        },
    ])
    .unwrap();
    assert_eq!(routing()["retired"], serde_json::json!([]));
}

/// AC27：Codex 在改动之前就已启动则需要重启；之后才启动或没在运行则不需要
#[test]
fn ac27_needs_restart_depends_on_codex_start_time() {
    let f = fixture();
    f.configure();
    f.world.lock().unwrap().codex_started_at = Some(2_000_000_000 - 3600);
    f.app.enable().unwrap();
    assert!(f.codex_state().needs_codex_restart);
    f.world.lock().unwrap().codex_started_at = Some(2_000_000_060);
    assert!(!f.codex_state().needs_codex_restart);
    f.world.lock().unwrap().codex_started_at = None;
    assert!(!f.codex_state().needs_codex_restart);
}

#[test]
fn state_reports_router_down_and_drift_without_false_positive() {
    let f = fixture();
    f.configure();
    f.world.lock().unwrap().codex_version = "0.155.0-alpha.9.2".into(); // 缓存里记的是 0.154.0
    f.app.enable().unwrap();
    assert!(!f.codex_state().codex.drift, "刚启用就误报版本漂移");
    f.world.lock().unwrap().healthy = false;
    let state = f.codex_state();
    assert!(!state.router.running && !state.router.error.is_empty());
    f.world.lock().unwrap().healthy = true;
    f.world.lock().unwrap().codex_version = "0.156.0".into();
    assert!(f.codex_state().codex.drift);
}

/// 启用过程中别人对 Codex 设置的修改不能被覆盖
#[test]
fn enable_does_not_overwrite_concurrent_edits() {
    let f = fixture();
    f.configure();
    let edited = ORIGINAL.replacen(
        "model_reasoning_effort = \"high\"",
        "model_reasoning_effort = \"low\"",
        1,
    );
    let (config, text) = (f.config(), edited.clone());
    f.world.lock().unwrap().on_health =
        Some(Box::new(move || std::fs::write(&config, &text).unwrap()));
    f.app.enable().unwrap();
    let got = f.read_config();
    assert!(
        got.contains("model_reasoning_effort = \"low\"") && got.contains("openai_base_url"),
        "{got}"
    );
}

/// 移除没成功时不能拆掉路由，否则 Codex 指向一个不存在的路由
#[test]
fn ac21_restore_keeps_router_when_config_still_points_at_it() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    f.write_config(&f.read_config().replacen(
        "openai_base_url = \"http://127.0.0.1:47328/v1\"",
        "openai_base_url = \"\"\"\nhttp://127.0.0.1:47328/v1\"\"\"",
        1,
    ));
    assert!(f.app.restore().is_err());
    assert!(f.world.lock().unwrap().installed.is_some());
    assert!(f.codex().join("sophia-routing.json").exists());
}

/// Codex 会把选中的第三方模型写成默认模型：恢复或取消勾选时改回启用前的值；用户自己选的官方模型不动
#[test]
fn default_model_is_reset_only_when_it_is_ours() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    f.write_config(&f.read_config().replacen(
        "model = \"gpt-5.6-sol\"",
        "model = \"gw.example-weibo-glm-5\"",
        1,
    ));
    f.set_models(vec![Model {
        id: "kimi-k3".into(),
        ..Default::default()
    }])
    .unwrap();
    assert!(
        f.read_config().contains("model = \"gpt-5.6-sol\"")
            && f.read_config().contains("openai_base_url")
    );
    f.write_config(&f.read_config().replacen(
        "model = \"gpt-5.6-sol\"",
        "model = \"gw.example-kimi-k3\"",
        1,
    ));
    f.app.restore().unwrap();
    assert_eq!(f.read_config(), ORIGINAL);

    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    f.write_config(
        &f.read_config()
            .replacen("model = \"gpt-5.6-sol\"", "model = \"gpt-5.5\"", 1),
    );
    f.app.restore().unwrap();
    assert!(f.read_config().contains("model = \"gpt-5.5\""));
}

/// AC28：后台程序副本更新后要重启后台服务
#[test]
fn ac28_changed_binary_restarts_the_service() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    assert!(!f
        .world
        .lock()
        .unwrap()
        .service_calls
        .contains(&"restart".to_owned()));
    f.world.lock().unwrap().binary_changed = true;
    f.app.enable().unwrap();
    assert!(f
        .world
        .lock()
        .unwrap()
        .service_calls
        .contains(&"restart".to_owned()));
}

/// R6：`重启路由` 只 kickstart 我们自己装的那个 launchd 服务，不碰 Codex 设置；
/// 失败时把 launchctl 的原话原样带出去（代码 router_down），不改写成「操作没成功」这类空话
#[test]
fn restart_router_kickstarts_our_service_and_relays_launchctl_errors() {
    let f = fixture();
    f.app.restart_router().unwrap();
    assert_eq!(f.world.lock().unwrap().restart_labels, [SERVICE_LABEL]);
    assert_eq!(f.read_config(), ORIGINAL, "重启不写 Codex 设置");

    let raw = "launchctl kickstart -k gui/501/com.zhengjiaqiao.sophia.gateway failed with exit code 3: Could not find service";
    f.world.lock().unwrap().restart_error = Some(raw.to_owned());
    let err = f.app.restart_router().unwrap_err();
    assert_eq!(err.code, "router_down");
    assert_eq!(err.message, raw);
}

fn fake_processes() -> Vec<process::ProcessInfo> {
    [
        (7503u32, "codex app-server"),
        // 桌面应用拉起的那个：子命令前面还有选项
        (
            8225,
            "/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled",
        ),
        (
            8224,
            "/Users/me/.codex/packages/standalone/releases/0.154.0-aarch64-apple-darwin/bin/codex-code-mode-host",
        ),
        // Claude 插件的壳进程：命令行里有 codex 字样，可执行名是 node
        (
            9001,
            "node /Users/me/.claude/plugins/codex/app-server-broker.mjs",
        ),
        // 用户自己在终端里的交互式会话
        (9002, "codex"),
    ]
    .into_iter()
    .map(|(pid, command)| process::ProcessInfo {
        pid,
        command: command.to_owned(),
    })
    .collect()
}

/// AC7：`重启 Codex` 只结束两种后台形态，不碰交互式会话和 node 壳进程；不写 Codex 设置
#[test]
fn restart_codex_terminates_only_the_background_forms() {
    let f = fixture();
    f.world.lock().unwrap().processes = fake_processes();
    let report = f.app.restart_codex().unwrap();
    assert_eq!(report.terminated, 3);
    assert_eq!(report.pids, [7503, 8225, 8224]);
    assert!(!report.reopened, "桌面应用没开着就不打开");
    let w = f.world.lock().unwrap();
    assert_eq!(w.terminated, [7503, 8225, 8224]);
    assert!(!w.codex_events.iter().any(|e| e == "quit" || e == "open"));
    drop(w);
    assert_eq!(f.read_config(), ORIGINAL, "结束进程不写 Codex 设置");
}

/// AC7′：Codex 没在跑不算失败，报 0 个，界面据此说「下次启动就是新配置」
#[test]
fn restart_codex_with_nothing_running_is_not_a_failure() {
    let f = fixture();
    let report = f.app.restart_codex().unwrap();
    assert_eq!(report.terminated, 0);
    assert!(report.pids.is_empty());
    assert!(!report.reopened);
    let w = f.world.lock().unwrap();
    assert!(w.terminated.is_empty());
    assert!(w.codex_events.is_empty(), "不退出、不打开");
}

/// 发信号失败时原样转述系统的话，不编
#[test]
fn restart_codex_relays_the_signal_error_verbatim() {
    let f = fixture();
    {
        let mut w = f.world.lock().unwrap();
        w.processes = fake_processes();
        w.terminate_error = Some("kill: 7503: Operation not permitted".to_owned());
    }
    let err = f.app.restart_codex().unwrap_err();
    assert_eq!(err.code, "internal");
    assert_eq!(
        err.message,
        "结束进程 7503 失败: kill: 7503: Operation not permitted"
    );
}

/// 桌面应用开着：先让它退出，再结束剩下的后台进程（它自己的 app-server 已跟着退），最后重新打开。
/// 交互式会话和 node 壳进程照旧不碰
#[test]
fn restart_codex_quits_the_desktop_app_then_ends_background_then_reopens() {
    let f = fixture();
    {
        let mut w = f.world.lock().unwrap();
        w.processes = fake_processes();
        w.codex_app_name = "ChatGPT".into();
        w.codex_app_running = true;
    }
    let report = f.app.restart_codex().unwrap();
    assert_eq!(
        report.pids,
        [7503, 8224],
        "桌面应用的 app-server 已随它退出"
    );
    assert_eq!(report.terminated, 2);
    assert!(report.reopened);
    let w = f.world.lock().unwrap();
    assert_eq!(w.codex_events, ["quit", "term 7503", "term 8224", "open"]);
    assert!(w.codex_app_running);
    assert!(!w.terminated.contains(&9001) && !w.terminated.contains(&9002));
    drop(w);
    assert_eq!(f.read_config(), ORIGINAL, "重启不写 Codex 设置");
}

/// 查不了桌面应用在不在运行（lsappinfo 不可用）：不因此失败，退回只结束后台进程、不退出也不打开
#[test]
fn restart_codex_falls_back_to_background_only_when_running_check_fails() {
    let f = fixture();
    {
        let mut w = f.world.lock().unwrap();
        w.processes = fake_processes();
        w.codex_app_running = true;
        w.codex_app_running_fails = true;
    }
    let report = f.app.restart_codex().unwrap();
    assert!(!report.reopened);
    assert!(report.terminated > 0);
    let w = f.world.lock().unwrap();
    assert!(!w.codex_events.iter().any(|e| e == "quit" || e == "open"));
}

/// 退不掉（可能在等用户确认）→ desktop_busy，用装着的显示名；不结束后台进程、不重新打开
#[test]
fn restart_codex_reports_busy_when_the_desktop_app_does_not_quit() {
    let f = fixture();
    {
        let mut w = f.world.lock().unwrap();
        w.processes = fake_processes();
        w.codex_app_name = "ChatGPT".into();
        w.codex_app_running = true;
        w.codex_app_stuck = true;
    }
    let err = f.app.restart_codex().unwrap_err();
    assert_eq!(err.code, "desktop_busy");
    assert_eq!(err.message, "ChatGPT 没有退出，可能正在等你确认");
    let w = f.world.lock().unwrap();
    assert_eq!(w.codex_events, ["quit"]);
    assert!(w.terminated.is_empty());
}

/// 重新打开失败：原样转述 `open` 的话；超时说「20 秒内没看到…」；读不到显示名时叫它 Codex
#[test]
fn restart_codex_relays_the_reopen_failure() {
    let said = "Unable to find application with bundle identifier com.openai.codex.";
    let cases = [
        ("ChatGPT", std::io::ErrorKind::Other, said.to_owned()),
        (
            "ChatGPT",
            std::io::ErrorKind::TimedOut,
            "20 秒内没看到 ChatGPT 在运行".to_owned(),
        ),
        (
            "",
            std::io::ErrorKind::TimedOut,
            "20 秒内没看到 Codex 在运行".to_owned(),
        ),
    ];
    for (name, kind, want) in cases {
        let f = fixture();
        {
            let mut w = f.world.lock().unwrap();
            w.processes = fake_processes();
            w.codex_app_name = name.into();
            w.codex_app_running = true;
            w.codex_app_open_error = Some((kind, said.into()));
        }
        let err = f.app.restart_codex().unwrap_err();
        assert_eq!(err.code, "internal");
        assert_eq!(err.message, want);
        let w = f.world.lock().unwrap();
        assert_eq!(w.terminated, [7503, 8224], "后台进程照样结束了");
        assert_eq!(w.codex_events.last().map(String::as_str), Some("open"));
    }
}

/// 结束后台进程失败也照样重新打开桌面应用：是我们让它退出的，不能把它关着
#[test]
fn restart_codex_reopens_even_when_ending_background_fails() {
    let f = fixture();
    {
        let mut w = f.world.lock().unwrap();
        w.processes = fake_processes();
        w.codex_app_running = true;
        w.terminate_error = Some("kill: 7503: Operation not permitted".to_owned());
    }
    let err = f.app.restart_codex().unwrap_err();
    assert_eq!(
        err.message,
        "结束进程 7503 失败: kill: 7503: Operation not permitted"
    );
    let w = f.world.lock().unwrap();
    assert_eq!(w.codex_events, ["quit", "term 7503", "open"]);
    assert!(w.codex_app_running);
}

/// 列出之后、发信号之前它自己退了（多半是跟着桌面应用退的）：不算失败，也不计入
#[test]
fn restart_codex_skips_a_process_that_exited_before_the_signal() {
    let f = fixture();
    {
        let mut w = f.world.lock().unwrap();
        w.processes = fake_processes();
        w.vanished = vec![7503];
    }
    let report = f.app.restart_codex().unwrap();
    assert_eq!(report.pids, [8225, 8224]);
    assert_eq!(report.terminated, 2);
}

/// 状态里带着装着的 Codex 桌面应用的显示名；没装为空串
#[test]
fn state_reports_the_codex_app_name() {
    let f = fixture();
    assert_eq!(f.codex_state().codex.app_name, "");
    f.world.lock().unwrap().codex_app_name = "ChatGPT".into();
    assert_eq!(f.codex_state().codex.app_name, "ChatGPT");
    let json = serde_json::to_value(f.app.state()).unwrap();
    assert_eq!(json["agents"][0]["codex"]["app"]["appName"], "ChatGPT");
}

/// `启动 Codex`：只调一次注入的打开动作，不写 Codex 设置、不结束任何进程
#[test]
fn launch_codex_opens_the_app_once_and_touches_nothing_else() {
    let f = fixture();
    f.world.lock().unwrap().processes = fake_processes();
    f.app.launch_codex().unwrap();
    let w = f.world.lock().unwrap();
    assert_eq!(w.launches, 1);
    assert!(w.terminated.is_empty(), "启动不结束任何进程");
    drop(w);
    assert_eq!(f.read_config(), ORIGINAL, "启动不写 Codex 设置");
}

/// 打不开时原样转述系统的话，不编
#[test]
fn launch_codex_relays_the_open_error_verbatim() {
    let f = fixture();
    f.world.lock().unwrap().launch_error =
        Some("Unable to find application with bundle identifier com.openai.codex.".to_owned());
    let err = f.app.launch_codex().unwrap_err();
    assert_eq!(err.code, "internal");
    assert_eq!(
        err.message,
        "Unable to find application with bundle identifier com.openai.codex."
    );
    assert_eq!(f.world.lock().unwrap().launches, 0);
}

pub(super) fn agents_manager_setup(f: &Fixture) -> String {
    let old_catalog = f.codex().join("agents-manager-models.json");
    std::fs::write(&old_catalog, "{}").unwrap();
    std::fs::write(f.codex().join("agents-manager-routing.json"), "{}").unwrap();
    let config = format!("model = \"gpt-5.6-sol\"\nmodel_catalog_json = \"{}\"\nopenai_base_url = \"http://127.0.0.1:47318/v1\"\n\n[mcp_servers]\n", old_catalog.display());
    f.write_config(&config);
    let am = f.root.join("agents-manager");
    std::fs::create_dir_all(&am).unwrap();
    std::fs::write(am.join("state.json"), r#"{"base_url":"https://gw.example/openai","api_base":"https://gw.example/openai/v1","protocol":"chat","port":47318,
      "models":[{"id":"thudm/glm-5.2","display_name":"GLM-5.2","selected":true},{"id":"azure/gpt-5","selected":false}],
      "prev_model":"gpt-5.6-sol","had_prev_model":true,"published_slugs":["thudm-glm-5.2"]}"#).unwrap();
    f.world.lock().unwrap().key = None;
    f.world.lock().unwrap().old_key = Some("sk-old-tool-key-123456".into());
    f.world.lock().unwrap().old_service_installed = true;
    config
}

/// AC23：由 agents-manager 启用且未接管时，识别出来、启用不可用、对方文件不动
#[test]
fn ac23_detects_agents_manager_and_blocks_enable() {
    let f = fixture();
    let config = agents_manager_setup(&f);
    let state = f.codex_state();
    let offer = state.takeover.expect("应当识别出 agents-manager");
    assert_eq!(
        (offer.base_url.as_str(), offer.selected_count),
        ("https://gw.example/openai", 1)
    );
    f.save_provider("https://gw.example/openai").unwrap();
    assert_ne!(code(f.app.enable()), "");
    assert_eq!(f.read_config(), config);
    assert!(f.codex().join("agents-manager-models.json").exists());
}

/// AC22：接管把地址、模型、显示名、密钥、启用前默认模型原样带过来，撤下对方的服务和文件，设置改指向本功能
#[test]
fn ac22_takeover_migrates_everything_without_reentering_the_key() {
    let f = fixture();
    agents_manager_setup(&f);
    f.app.takeover().unwrap();
    let world = f.world.lock().unwrap();
    assert_eq!(world.key.as_deref(), Some("sk-old-tool-key-123456"));
    assert_eq!(
        world.settings.providers[0].base_url,
        "https://gw.example/openai"
    );
    assert_eq!(world.settings.prev_model.as_deref(), Some("gpt-5.6-sol"));
    assert!(world.service_calls.contains(&format!(
        "uninstall {}",
        crate::takeover::LAUNCH_AGENT_LABEL
    )));
    assert!(!world.old_service_installed);
    drop(world);
    let config = f.read_config();
    assert!(
        config.contains("http://127.0.0.1:47328/v1") && config.contains("sophia-models.json"),
        "{config}"
    );
    assert!(
        !config.contains("47318") && !config.contains("agents-manager-"),
        "{config}"
    );
    assert!(config.contains("[mcp_servers]"));
    assert!(
        !f.codex().join("agents-manager-models.json").exists()
            && !f.codex().join("agents-manager-routing.json").exists()
    );
    let state = f.codex_state();
    assert!(state.enabled && state.takeover.is_none());
    let glm = state.providers[0]
        .models
        .iter()
        .find(|m| m.id == "thudm/glm-5.2")
        .unwrap();
    assert!(glm.selected && glm.display_name == "GLM-5.2");
    assert!(
        f.root.join("agents-manager/state.json").exists(),
        "对方的数据保留"
    );
    // 接管后恢复：回到完全没有任何一方的状态
    f.app.restore().unwrap();
    assert_eq!(
        f.read_config(),
        "model = \"gpt-5.6-sol\"\n\n[mcp_servers]\n"
    );
}

/// 接管途中路由起不来：设置保持指向对方，对方的服务和文件都还在
#[test]
fn takeover_failure_leaves_the_old_tool_in_charge() {
    let f = fixture();
    let config = agents_manager_setup(&f);
    f.world.lock().unwrap().healthy = false;
    assert_eq!(code(f.app.takeover()), "router_down");
    assert_eq!(f.read_config(), config);
    assert!(f.world.lock().unwrap().old_service_installed);
    assert!(f.codex().join("agents-manager-models.json").exists());
}

/// 独立验证发现：恢复会清掉“曾经发布过的模型”，再启用时停用名单就空了；
/// 而一直没重启的 Codex 选择器里旧模型还在，它的请求会被当成官方模型放行。
#[test]
fn retired_models_survive_restore_and_reenable() {
    let f = fixture();
    f.save_provider("https://gw.example/openai").unwrap();
    f.set_models(vec![
        Model {
            id: "weibo/glm-5".into(),
            ..Default::default()
        },
        Model {
            id: "kimi-k3".into(),
            ..Default::default()
        },
    ])
    .unwrap();
    f.app.enable().unwrap();
    f.app.restore().unwrap();
    f.set_models(vec![Model {
        id: "kimi-k3".into(),
        ..Default::default()
    }])
    .unwrap();
    f.app.enable().unwrap();
    let routing: serde_json::Value =
        serde_json::from_slice(&std::fs::read(f.codex().join("sophia-routing.json")).unwrap())
            .unwrap();
    assert_eq!(
        routing["retired"],
        serde_json::json!(["gw.example-weibo-glm-5"])
    );
    // 恢复仍然逐字节还原
    f.app.restore().unwrap();
    assert_eq!(f.read_config(), ORIGINAL);
}

/// 接管途中路由起不来：不能覆盖本功能原有的密钥，也不能留下自己的后台服务和文件
#[test]
fn failed_takeover_leaves_no_residue_of_ours() {
    let f = fixture();
    agents_manager_setup(&f);
    f.world.lock().unwrap().key = Some("sk-existing-sophia-key".into());
    f.world.lock().unwrap().healthy = false;
    assert_eq!(code(f.app.takeover()), "router_down");
    let world = f.world.lock().unwrap();
    assert_eq!(
        world.key.as_deref(),
        Some("sk-existing-sophia-key"),
        "路由没确认健康之前不该动密钥"
    );
    assert!(world.installed.is_none(), "失败后不该留下本功能的后台服务");
    drop(world);
    let ours: Vec<_> = std::fs::read_dir(f.codex())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("sophia-"))
        .collect();
    assert!(ours.is_empty(), "{ours:?}");
}

/// 接管时把对方记录的“末行补过换行”和模型的上下文长度、图片能力一起带过来
#[test]
fn takeover_carries_added_newline_and_model_capabilities() {
    let f = fixture();
    agents_manager_setup(&f);
    let am = f.root.join("agents-manager");
    std::fs::write(am.join("state.json"), r#"{"base_url":"https://gw.example/openai","protocol":"chat","added_newline":true,
      "models":[{"id":"thudm/glm-5.2","display_name":"GLM-5.2","selected":true,"context_window":200000,"vision":true}],
      "prev_model":"gpt-5.6-sol","had_prev_model":true,"published_slugs":["thudm-glm-5.2"]}"#).unwrap();
    f.app.takeover().unwrap();
    let settings = f.world.lock().unwrap().settings.clone();
    assert!(settings.added_newline);
    assert_eq!(
        settings.providers[0].models[0].model.context_window,
        Some(200000)
    );
    assert!(settings.providers[0].models[0].model.vision);
}

/// 终审发现：接管在写设置之前失败（例如设置被别人改了），此时密钥已经覆盖、
/// 本功能的服务已在跑、目录文件已落盘，却没有清理。
#[test]
fn takeover_failing_after_the_key_was_written_still_cleans_up() {
    let f = fixture();
    agents_manager_setup(&f);
    f.world.lock().unwrap().key = Some("sk-existing-sophia-key".into());
    // 路由确认健康之后、写设置之前，别人把设置换掉
    let config = f.config();
    f.world.lock().unwrap().on_health = Some(Box::new(move || {
        std::fs::write(&config, "model = \"gpt-5.6-sol\"\n").unwrap();
    }));
    assert!(f.app.takeover().is_err());
    let world = f.world.lock().unwrap();
    assert!(world.installed.is_none(), "失败后不该留下本功能的后台服务");
    drop(world);
    let ours: Vec<_> = std::fs::read_dir(f.codex())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("sophia-"))
        .collect();
    assert!(ours.is_empty(), "失败后不该留下本功能的文件: {ours:?}");
}

// ----- 「要不要重启 Codex」比的是状态，不是时间 -----
// Codex 只在启动时读一次设置。要不要重启，取决于它启动那一刻加载到的状态和现在是不是一回事；
// 只比「启动时间早于最近一次变更」会误报。

/// 真机上遇到的误报：Codex 很早就开着，之后启用又停用，中间没重启过。
/// 它从头到尾没加载过注入的配置，停用之后和现状完全一致，不需要重启。
#[test]
fn enabling_then_disabling_without_a_codex_restart_in_between_needs_no_restart() {
    let f = fixture();
    f.configure();
    f.world.lock().unwrap().codex_started_at = Some(2_000_000_000 - 86_400);
    f.app.enable().unwrap();
    assert!(
        f.codex_state().needs_codex_restart,
        "启用之后它还开着旧配置"
    );
    f.world.lock().unwrap().now = 2_000_000_600;
    f.app.restore().unwrap();
    assert!(
        !f.codex_state().needs_codex_restart,
        "它从没加载过注入的配置，停用之后不需要重启"
    );
}

/// 反过来这种必须提示：Codex 已经在用注入的配置，这时停用，路由随之卸载，
/// 那个 Codex 连官方模型都无法连接，得重启。
#[test]
fn disabling_while_codex_runs_with_the_injected_config_needs_a_restart() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    f.world.lock().unwrap().codex_started_at = Some(2_000_000_060); // 启用之后才启动：加载的是注入的配置
    assert!(!f.codex_state().needs_codex_restart);
    f.world.lock().unwrap().now = 2_000_000_600;
    f.app.restore().unwrap();
    assert!(f.codex_state().needs_codex_restart);
}

/// 停用再原样启用回来：Codex 加载的目录和现在的一模一样，不需要重启
#[test]
fn toggling_off_and_back_on_with_the_same_models_needs_no_restart() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    f.world.lock().unwrap().codex_started_at = Some(2_000_000_060);
    f.world.lock().unwrap().now = 2_000_000_600;
    f.app.restore().unwrap();
    f.world.lock().unwrap().now = 2_000_001_200;
    f.app.enable().unwrap();
    assert!(!f.codex_state().needs_codex_restart);
}

/// 同样开着，但模型改过：选择器里的列表要重启才会变
#[test]
fn changing_the_models_while_codex_runs_with_the_injection_needs_a_restart() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    f.world.lock().unwrap().codex_started_at = Some(2_000_000_060);
    f.world.lock().unwrap().now = 2_000_000_600;
    f.set_models(vec![Model {
        id: "kimi-k3".into(),
        ..Default::default()
    }])
    .unwrap();
    assert!(f.codex_state().needs_codex_restart);
    // 重启之后就不再提示
    f.world.lock().unwrap().codex_started_at = Some(2_000_000_700);
    assert!(!f.codex_state().needs_codex_restart);
}

/// 旧版本留下的设置没有变更记录。这时说不清 Codex 加载过什么，只在当前确实开着时才提示：
/// 没开着还提示重启，就是真机上那次误报。
#[test]
fn settings_without_history_only_ask_for_a_restart_while_enabled() {
    let f = fixture();
    f.configure();
    f.world.lock().unwrap().codex_started_at = Some(2_000_000_000 - 86_400);
    f.app.enable().unwrap();
    f.world.lock().unwrap().settings.history.clear(); // 模拟旧版本写下的设置
    assert!(
        f.codex_state().needs_codex_restart,
        "开着、Codex 更早启动：照旧提示"
    );
    f.app.restore().unwrap();
    f.world.lock().unwrap().settings.history.clear();
    assert!(!f.codex_state().needs_codex_restart, "没开着就不提示");
}

// ----- 预热：把「复制程序、让后台服务用上新版本」从启用路径上挪走 -----
// 真机实测：新程序文件第一次运行要过系统校验，放在启用里会让它卡上好几秒，甚至撞上就绪等待的上限而失败。

/// 应用更新后启动：程序文件变了、后台服务正开着 → 预热时就让它换上新版本
#[test]
fn prewarm_restarts_a_running_service_when_the_binary_changed() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    {
        let mut world = f.world.lock().unwrap();
        world.binary_changed = true;
        world.restart_labels.clear();
    }
    assert!(f.app.prewarm().unwrap(), "报告程序文件被更新过");
    assert_eq!(f.world.lock().unwrap().restart_labels, [SERVICE_LABEL]);
}

/// 后台服务没开着：只复制，不去启动什么
#[test]
fn prewarm_only_copies_when_the_service_is_not_loaded() {
    let f = fixture();
    f.world.lock().unwrap().binary_changed = true;
    assert!(f.app.prewarm().unwrap());
    let world = f.world.lock().unwrap();
    assert!(world.restart_labels.is_empty());
    assert!(world.installed.is_none(), "预热不安装后台服务");
}

/// 程序文件没变：什么都不做，也不动 Codex 的设置
#[test]
fn prewarm_is_a_no_op_when_nothing_changed() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    let before = f.read_config();
    {
        let mut world = f.world.lock().unwrap();
        world.binary_changed = false;
        world.restart_labels.clear();
    }
    assert!(!f.app.prewarm().unwrap());
    assert!(f.world.lock().unwrap().restart_labels.is_empty());
    assert_eq!(f.read_config(), before);
}

// ---------------------------------------------------------------------------
// 多家第三方网关
// ---------------------------------------------------------------------------

fn pick(id: &str) -> Model {
    Model {
        id: id.into(),
        ..Default::default()
    }
}

/// 两家网关，各有自己的密钥，各勾一个同名模型
fn two_providers(f: &Fixture) -> (String, String) {
    f.world.lock().unwrap().key = None;
    let a = f
        .app
        .commit_verified_provider_in(
            Agent::Codex,
            None,
            Some("WeCode"),
            "https://wecode.example/openai",
            "sk-wecode-key-123456",
            vec!["deepseek/v4".into(), "glm-5".into()],
            "https://wecode.example/openai/v1",
            false,
        )
        .map(|saved| saved.provider_id)
        .unwrap();
    let b = f
        .app
        .commit_verified_provider_in(
            Agent::Codex,
            None,
            Some("Other Gateway"),
            "https://other.example/api",
            "sk-other-key-1234567",
            vec!["deepseek/v4".into()],
            "",
            false,
        )
        .map(|saved| saved.provider_id)
        .unwrap();
    f.app
        .set_models_in(Agent::Codex, &a, vec![pick("deepseek/v4")])
        .unwrap();
    f.app
        .set_models_in(Agent::Codex, &b, vec![pick("deepseek/v4")])
        .unwrap();
    (a, b)
}

fn catalog_slugs(f: &Fixture) -> Vec<String> {
    let doc: serde_json::Value =
        serde_json::from_slice(&std::fs::read(f.codex().join("sophia-models.json")).unwrap())
            .unwrap();
    doc["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["slug"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn two_providers_coexist_with_their_own_ids_keys_and_prefixed_slugs() {
    let f = fixture();
    let (a, b) = two_providers(&f);
    assert_eq!((a.as_str(), b.as_str()), ("wecode", "other-gateway"));
    {
        let world = f.world.lock().unwrap();
        assert_eq!(world.keys["wecode"], "sk-wecode-key-123456");
        assert_eq!(world.keys["other-gateway"], "sk-other-key-1234567");
    }
    f.app.enable().unwrap();
    // 同名模型在两家各有一个标识，和官方模型并排
    assert_eq!(
        catalog_slugs(&f),
        [
            "gpt-5.6-sol",
            "wecode-deepseek-v4",
            "other-gateway-deepseek-v4"
        ]
    );
    let routing = f.routing();
    assert_eq!(
        routing["providers"],
        serde_json::json!([
            {"id": "wecode", "base_url": "https://wecode.example/openai/v1", "protocol": "chat"},
            {"id": "other-gateway", "base_url": "https://other.example/api", "protocol": "chat"}
        ])
    );
    assert_eq!(routing["models"][0]["provider"], "wecode");
    assert_eq!(routing["models"][1]["provider"], "other-gateway");
    assert_eq!(routing["models"][1]["upstream_model"], "deepseek/v4");
    // 密钥不进设置，也不进 Codex 目录下的任何文件
    for entry in std::fs::read_dir(f.codex()).unwrap().flatten() {
        let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
        assert!(
            !text.contains("sk-wecode") && !text.contains("sk-other"),
            "{:?}",
            entry.path()
        );
    }
    let saved = serde_json::to_string(&f.world.lock().unwrap().settings).unwrap();
    assert!(!saved.contains("sk-wecode") && !saved.contains("sk-other"));
}

/// 撞名模型在 Codex 目录里的后缀与状态里的 `short_name` 是同一个名字（界面网关行、模型片后缀都读它）：
/// 新建时没填名字的那家，显示名是完整主机名，两边都写短名 `other`，不是 `other.example`
#[test]
fn the_catalog_suffix_for_clashing_models_is_the_short_name_the_ui_shows() {
    let f = fixture();
    f.world.lock().unwrap().key = None;
    let a = f
        .app
        .commit_verified_provider_in(
            Agent::Codex,
            None,
            Some("WeCode"),
            "https://wecode.example/openai",
            "sk-wecode-key-123456",
            vec!["deepseek/v4".into()],
            "https://wecode.example/openai/v1",
            false,
        )
        .map(|saved| saved.provider_id)
        .unwrap();
    let b = f
        .app
        .commit_verified_provider_in(
            Agent::Codex,
            None,
            None,
            "https://api.other.example/v1",
            "sk-other-key-1234567",
            vec!["deepseek/v4".into()],
            "",
            false,
        )
        .map(|saved| saved.provider_id)
        .unwrap();
    f.app
        .set_models_in(Agent::Codex, &a, vec![pick("deepseek/v4")])
        .unwrap();
    f.app
        .set_models_in(Agent::Codex, &b, vec![pick("deepseek/v4")])
        .unwrap();
    f.app.enable().unwrap();

    let state = f.codex_state();
    assert_eq!(state.providers[1].name, "api.other.example", "显示名原样");
    let short: Vec<&str> = state
        .providers
        .iter()
        .map(|p| p.short_name.as_str())
        .collect();
    assert_eq!(short, ["WeCode", "other"]);

    let doc: serde_json::Value =
        serde_json::from_slice(&std::fs::read(f.codex().join("sophia-models.json")).unwrap())
            .unwrap();
    let names: Vec<&str> = doc["models"]
        .as_array()
        .unwrap()
        .iter()
        .skip(1) // 官方模型
        .map(|m| m["display_name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            format!("deepseek/v4 · {}", short[0]),
            format!("deepseek/v4 · {}", short[1])
        ]
    );
}

#[test]
fn state_lists_every_provider() {
    let f = fixture();
    let (a, b) = two_providers(&f);
    {
        // 兜底密钥也清掉，这样这一家才是真的没有密钥
        let mut world = f.world.lock().unwrap();
        world.keys.remove(&b);
        world.key = None;
    }
    let state = f.codex_state();
    assert_eq!(state.providers.len(), 2);
    assert_eq!(state.providers[0].id, a);
    assert_eq!(state.providers[0].name, "WeCode");
    assert!(state.providers[0].has_key);
    assert_eq!(state.providers[1].name, "Other Gateway");
    assert!(!state.providers[1].has_key, "每家的密钥状态各自独立");
    let model = &state.providers[1].models[0];
    assert_eq!(
        (model.slug.as_str(), model.selected),
        ("other-gateway-deepseek-v4", true)
    );

    let empty = fixture().codex_state();
    assert!(empty.providers.is_empty());
}

/// 启用前逐家检查：有模型要发布的网关必须有密钥；没勾选模型的那家不挡路
#[test]
fn enable_checks_the_key_of_every_publishing_provider() {
    let f = fixture();
    let (_a, b) = two_providers(&f);
    {
        // 兜底密钥也清掉，这样这一家才是真的没有密钥
        let mut world = f.world.lock().unwrap();
        world.keys.remove(&b);
        world.key = None;
    }
    let error = f.app.enable().unwrap_err();
    assert_eq!(error.code, "invalid");
    assert!(error.message.contains("Other Gateway"), "{}", error.message);
    assert_eq!(f.read_config(), ORIGINAL, "没启用成就不该动 Codex 设置");

    f.app.set_models_in(Agent::Codex, &b, vec![]).unwrap();
    f.app.enable().unwrap();
    assert_eq!(catalog_slugs(&f), ["gpt-5.6-sol", "wecode-deepseek-v4"]);
    // 没有模型在用的那一家，地址不写进 Codex 目录
    assert_eq!(f.routing()["providers"].as_array().unwrap().len(), 1);
}

/// 改名只改显示名：id、标识、钥匙串账户都不变，Codex 里已选的模型不受影响
#[test]
fn renaming_a_provider_keeps_its_id_and_slugs() {
    let f = fixture();
    let (a, _b) = two_providers(&f);
    f.app.enable().unwrap();
    let before = catalog_slugs(&f);
    let id = f
        .app
        .upsert_provider_in(
            Agent::Codex,
            Some(&a),
            Some("微博内网"),
            "https://wecode.example/openai",
            false,
        )
        .map(|saved| saved.provider_id)
        .unwrap();
    assert_eq!(id, a);
    assert_eq!(f.codex_state().providers[0].name, "微博内网");
    assert_eq!(catalog_slugs(&f), before);
    assert_eq!(
        f.world.lock().unwrap().keys["wecode"],
        "sk-wecode-key-123456"
    );
}

/// 同一家里同一地址只能有一个网关（2026-09-30）：新建、改地址撞上别的网关都拒绝，什么都不写（密钥也不写）；
/// 改自己（地址不变或只差末尾斜杠）照常
#[test]
fn a_second_gateway_at_the_same_address_is_rejected() {
    let f = fixture();
    let (a, b) = two_providers(&f);
    let keys_before = f.world.lock().unwrap().keys.clone();
    let err = f
        .app
        .commit_verified_provider_in(
            Agent::Codex,
            None,
            None,
            "https://WECODE.example/openai/",
            "sk-another-key-1234567",
            vec!["m".into()],
            "",
            false,
        )
        .unwrap_err();
    assert_eq!(err.code, "conflict");
    assert!(
        err.message.contains("这个地址已经加过了"),
        "{}",
        err.message
    );
    assert_eq!(
        code(f.app.upsert_provider_in(
            Agent::Codex,
            None,
            None,
            "https://wecode.example/openai",
            false
        )),
        "conflict"
    );
    // 把 b 的地址改成 a 的：拒绝，b 的地址与密钥都不动
    assert_eq!(
        code(f.app.commit_verified_provider_in(
            Agent::Codex,
            Some(&b),
            None,
            "https://wecode.example/openai",
            "sk-changed-key-1234567",
            vec![],
            "",
            false,
        )),
        "conflict"
    );
    let providers = f.codex_state().providers;
    assert_eq!(providers.len(), 2);
    assert_eq!(providers[1].base_url, "https://other.example/api");
    assert_eq!(f.world.lock().unwrap().keys, keys_before);
    // 改自己：同一地址照常
    f.app
        .upsert_provider_in(
            Agent::Codex,
            Some(&a),
            None,
            "https://wecode.example/openai/",
            false,
        )
        .unwrap();
    // 规则出台前就重复了的两家：地址不改（改名、换密钥）照常能编辑
    let mut settings = f.app.load().unwrap();
    settings.providers[1].base_url = "https://wecode.example/openai".into();
    f.app.save(&settings).unwrap();
    f.app
        .commit_verified_provider_in(
            Agent::Codex,
            Some(&b),
            Some("旧的重复"),
            "https://wecode.example/openai",
            "sk-renamed-key-1234567",
            vec![],
            "",
            false,
        )
        .unwrap();
}

#[test]
fn provider_ids_stay_unique_and_unknown_ids_are_rejected() {
    let f = fixture();
    let first = f
        .app
        .upsert_provider_in(Agent::Codex, None, Some("Same"), "https://a.example", false)
        .map(|saved| saved.provider_id)
        .unwrap();
    let second = f
        .app
        .upsert_provider_in(Agent::Codex, None, Some("Same"), "https://b.example", false)
        .map(|saved| saved.provider_id)
        .unwrap();
    let chinese = f
        .app
        .upsert_provider_in(
            Agent::Codex,
            None,
            Some("微博网关"),
            "https://c.example",
            false,
        )
        .map(|saved| saved.provider_id)
        .unwrap();
    assert_eq!(
        (first.as_str(), second.as_str(), chinese.as_str()),
        ("same", "same-2", "provider")
    );
    assert_eq!(
        code(
            f.app
                .upsert_provider_in(
                    Agent::Codex,
                    Some("ghost"),
                    None,
                    "https://x.example",
                    false
                )
                .map(|saved| saved.provider_id)
        ),
        "invalid"
    );
    assert_eq!(
        code(f.app.set_models_in(Agent::Codex, "ghost", vec![pick("m")])),
        "invalid"
    );
    assert_eq!(
        code(
            f.app
                .merge_fetched_models_in(Agent::Codex, "ghost", vec![], "")
        ),
        "invalid"
    );
    assert_eq!(
        code(f.app.provider_for_fetch_in(Agent::Codex, "ghost")),
        "invalid"
    );
    assert_eq!(
        code(f.app.remove_provider_in(Agent::Codex, "ghost", false)),
        "invalid"
    );
    assert_eq!(f.codex_state().providers.len(), 3);
}

/// 删除一家：它的模型进停用名单、密钥删掉；另一家不受影响
#[test]
fn removing_a_provider_retires_its_models_and_deletes_only_its_key() {
    let f = fixture();
    let (a, b) = two_providers(&f);
    f.app.enable().unwrap();
    f.app.remove_provider_in(Agent::Codex, &b, false).unwrap();
    assert_eq!(catalog_slugs(&f), ["gpt-5.6-sol", "wecode-deepseek-v4"]);
    let routing = f.routing();
    assert_eq!(
        routing["retired"],
        serde_json::json!(["other-gateway-deepseek-v4"])
    );
    assert_eq!(routing["providers"].as_array().unwrap().len(), 1);
    let world = f.world.lock().unwrap();
    assert_eq!(world.deleted_keys, std::slice::from_ref(&b));
    assert!(world.keys.contains_key(&a));
    assert_eq!(world.settings.providers.len(), 1);
}

/// 已启用时不能删掉最后一家还在发布模型的网关：什么都不动，密钥也不删
#[test]
fn removing_the_last_publishing_provider_while_enabled_is_refused() {
    let f = fixture();
    let (a, b) = two_providers(&f);
    f.app.set_models_in(Agent::Codex, &b, vec![]).unwrap();
    f.app.enable().unwrap();
    let before = f.read_config();
    assert_eq!(
        code(f.app.remove_provider_in(Agent::Codex, &a, false)),
        "invalid"
    );
    assert_eq!(f.read_config(), before);
    assert_eq!(catalog_slugs(&f), ["gpt-5.6-sol", "wecode-deepseek-v4"]);
    let world = f.world.lock().unwrap();
    assert!(world.deleted_keys.is_empty());
    assert_eq!(world.settings.providers.len(), 2);
}

/// 删掉的那家的模型若正是 Codex 的默认模型，改回启用前的值
#[test]
fn removing_a_provider_resets_the_default_model_if_it_was_theirs() {
    let f = fixture();
    let (_a, b) = two_providers(&f);
    f.app.enable().unwrap();
    f.write_config(&f.read_config().replacen(
        "model = \"gpt-5.6-sol\"",
        "model = \"other-gateway-deepseek-v4\"",
        1,
    ));
    f.app.remove_provider_in(Agent::Codex, &b, false).unwrap();
    assert!(
        f.read_config().contains("model = \"gpt-5.6-sol\""),
        "{}",
        f.read_config()
    );
}

/// 新建网关时密钥没存成：不留下一张没法用的卡片
#[test]
fn a_new_provider_is_not_left_behind_when_its_key_cannot_be_stored() {
    let f = fixture();
    f.world.lock().unwrap().key = None;
    f.world.lock().unwrap().key_write_fails_for = Some("wecode".into());
    let result = f
        .app
        .commit_verified_provider_in(
            Agent::Codex,
            None,
            Some("WeCode"),
            "https://wecode.example/openai",
            "sk-wecode-key-123456",
            vec!["m".into()],
            "",
            false,
        )
        .map(|saved| saved.provider_id);
    assert_eq!(code(result), "invalid");
    assert!(f.codex_state().providers.is_empty());
}

/// 已启用时改动发布内容，要先确保后台路由是当前版本再写清单：
/// 旧版路由不认清单里的归属，会把第二家的请求发给第一家。路由起不来就什么都不写。
#[test]
fn republishing_refuses_to_write_catalogs_when_the_router_cannot_be_brought_up() {
    let f = fixture();
    let (_a, b) = two_providers(&f);
    f.app.set_models_in(Agent::Codex, &b, vec![]).unwrap();
    f.app.enable().unwrap();
    let routing_before = f.routing();
    f.world.lock().unwrap().healthy = false;
    assert_eq!(
        code(
            f.app
                .set_models_in(Agent::Codex, &b, vec![pick("deepseek/v4")])
        ),
        "router_down"
    );
    assert_eq!(f.routing(), routing_before, "路由没就绪，清单不该变");
    assert!(
        f.codex_state().providers[1]
            .models
            .iter()
            .all(|m| !m.selected),
        "没发布成的勾选不该存下来"
    );
}

/// 旧的单网关设置在已启用状态下升级：磁盘上还是旧清单，下一次改勾选时整体换成新格式，
/// 旧标识进停用名单，指向旧标识的默认模型改回启用前的值
#[test]
fn legacy_settings_are_republished_in_the_new_format_on_the_next_change() {
    let f = fixture();
    let legacy: GatewaySettings = serde_json::from_value(serde_json::json!({
        "baseUrl": "https://gw.example/openai",
        "apiBase": "https://gw.example/openai/v1",
        "models": [{"id": "weibo/glm-5", "selected": true}, {"id": "kimi-k3"}],
        "publishedSlugs": ["weibo-glm-5"],
        "prevModel": "gpt-5.6-sol",
        "hadPrevModel": true
    }))
    .unwrap();
    f.world.lock().unwrap().settings = legacy;
    f.write_config(&format!(
        "model = \"weibo-glm-5\"\n{}{}",
        our_lines(&f),
        ORIGINAL.split_once('\n').unwrap().1
    ));
    let state = f.codex_state();
    assert!(state.enabled);
    assert_eq!(state.providers[0].id, "default");
    assert_eq!(state.providers[0].name, "gw.example");

    f.set_models(vec![pick("weibo/glm-5"), pick("kimi-k3")])
        .unwrap();
    assert_eq!(
        catalog_slugs(&f),
        ["gpt-5.6-sol", "default-weibo-glm-5", "default-kimi-k3"]
    );
    assert_eq!(f.routing()["retired"], serde_json::json!(["weibo-glm-5"]));
    assert!(
        f.read_config().starts_with("model = \"gpt-5.6-sol\"\n"),
        "{}",
        f.read_config()
    );
}

/// 接管生成固定 id 的一家，不动用户自己加的网关；对方不带前缀的旧标识进停用名单
#[test]
fn takeover_adds_a_wecode_provider_next_to_existing_ones() {
    let f = fixture();
    let mine = f
        .app
        .upsert_provider_in(
            Agent::Codex,
            None,
            Some("Mine"),
            "https://mine.example",
            false,
        )
        .map(|saved| saved.provider_id)
        .unwrap();
    let config = agents_manager_setup(&f);
    f.write_config(&config.replacen("model = \"gpt-5.6-sol\"", "model = \"thudm-glm-5.2\"", 1));
    f.app.takeover().unwrap();
    let world = f.world.lock().unwrap();
    let ids: Vec<&str> = world
        .settings
        .providers
        .iter()
        .map(|p| p.id.as_str())
        .collect();
    assert_eq!(ids, [mine.as_str(), "wecode"]);
    assert_eq!(world.keys["wecode"], "sk-old-tool-key-123456");
    drop(world);
    assert_eq!(catalog_slugs(&f), ["gpt-5.6-sol", "wecode-thudm-glm-5.2"]);
    assert_eq!(f.routing()["retired"], serde_json::json!(["thudm-glm-5.2"]));
    // Codex 的默认模型原来指向对方不带前缀的标识，接管后它已不在目录里：改回启用前的值
    assert!(
        f.read_config().contains("model = \"gpt-5.6-sol\""),
        "{}",
        f.read_config()
    );
    assert!(!f.read_config().contains("thudm-glm-5.2"));
}

/// 给已有的网关换密钥时密钥没存成：地址不该已经被改掉
#[test]
fn an_existing_provider_keeps_its_address_when_the_new_key_cannot_be_stored() {
    let f = fixture();
    let (a, _b) = two_providers(&f);
    f.world.lock().unwrap().key_write_fails_for = Some(a.clone());
    let result = f
        .app
        .commit_verified_provider_in(
            Agent::Codex,
            Some(&a),
            None,
            "https://moved.example/openai",
            "sk-another-key-123456",
            vec!["m".into()],
            "",
            false,
        )
        .map(|saved| saved.provider_id);
    assert_eq!(code(result), "invalid");
    assert_eq!(
        f.codex_state().providers[0].base_url,
        "https://wecode.example/openai"
    );
}

/// 评审发现：用户自己建的网关 id 恰好是 wecode（名字叫 WeCode 就会这样）但地址不同时，
/// 接管不能覆盖它——它的地址、模型、密钥都得原样留着，接管来的另起一家
#[test]
fn takeover_never_overwrites_a_users_own_provider_that_happens_to_share_the_id() {
    let f = fixture();
    f.world.lock().unwrap().key = None;
    let mine = f
        .app
        .commit_verified_provider_in(
            Agent::Codex,
            None,
            Some("WeCode"),
            "https://my-own.example/v1",
            "sk-my-own-key-123456",
            vec!["my/model".into()],
            "",
            false,
        )
        .map(|saved| saved.provider_id)
        .unwrap();
    assert_eq!(mine, "wecode");
    f.app
        .set_models_in(Agent::Codex, &mine, vec![pick("my/model")])
        .unwrap();
    agents_manager_setup(&f);
    f.world
        .lock()
        .unwrap()
        .keys
        .insert("wecode".into(), "sk-my-own-key-123456".into());

    f.app.takeover().unwrap();
    let world = f.world.lock().unwrap();
    let pairs: Vec<(&str, &str)> = world
        .settings
        .providers
        .iter()
        .map(|p| (p.id.as_str(), p.base_url.as_str()))
        .collect();
    assert_eq!(
        pairs,
        [
            ("wecode", "https://my-own.example/v1"),
            ("wecode-2", "https://gw.example/openai")
        ]
    );
    assert_eq!(
        world.keys["wecode"], "sk-my-own-key-123456",
        "用户自己的密钥不能被覆盖"
    );
    assert_eq!(world.keys["wecode-2"], "sk-old-tool-key-123456");
    drop(world);
    assert_eq!(
        catalog_slugs(&f),
        ["gpt-5.6-sol", "wecode-my-model", "wecode-2-thudm-glm-5.2"]
    );
}

/// 同一家网关重复接管：地址相同，覆盖原来那一家，不越攒越多
#[test]
fn taking_over_the_same_gateway_twice_reuses_the_provider() {
    let f = fixture();
    agents_manager_setup(&f);
    f.app.takeover().unwrap();
    f.app.restore().unwrap();
    agents_manager_setup(&f);
    f.app.takeover().unwrap();
    let world = f.world.lock().unwrap();
    let ids: Vec<&str> = world
        .settings
        .providers
        .iter()
        .map(|p| p.id.as_str())
        .collect();
    assert_eq!(ids, ["wecode"]);
}

/// 评审发现：启用时也必须先确保后台路由是当前版本、再写清单。
/// 升级后第一次点启用时旧版路由还在跑，它不认清单里的归属，会把第二家的请求发给第一家。
#[test]
fn enable_brings_the_router_up_before_writing_the_routing_catalog() {
    let f = fixture();
    two_providers(&f);
    let routing = f.codex().join("sophia-routing.json");
    let seen = Arc::new(Mutex::new(None::<bool>));
    let record = seen.clone();
    let path = routing.clone();
    f.world.lock().unwrap().on_health = Some(Box::new(move || {
        // 路由确认健康的那一刻，清单应当还没写
        record.lock().unwrap().get_or_insert(path.exists());
    }));
    f.app.enable().unwrap();
    assert_eq!(*seen.lock().unwrap(), Some(false), "清单先于路由写出了");
    assert!(routing.exists());

    // 路由起不来：清单不写，Codex 设置不动
    let f = fixture();
    two_providers(&f);
    f.world.lock().unwrap().healthy = false;
    assert_eq!(code(f.app.enable()), "router_down");
    assert!(!f.codex().join("sophia-routing.json").exists());
    assert_eq!(f.read_config(), ORIGINAL);
}

/// 拉取失败：原因记在那一家上并落盘，模型和勾选不动；再拉成功就清掉
#[test]
fn a_failed_fetch_marks_the_provider_unreachable_until_the_next_success() {
    let f = fixture();
    let (a, _) = two_providers(&f);
    f.app
        .record_unreachable_in(Agent::Codex, &a, UnreachableReason::Network)
        .unwrap();

    // 落盘：设置里有，重新读出的状态里也有
    {
        let world = f.world.lock().unwrap();
        let saved = world.settings.provider(&a).unwrap();
        assert_eq!(saved.unreachable, Some(UnreachableReason::Network));
        let json = serde_json::to_value(&world.settings).unwrap();
        assert_eq!(
            json["providers"][0]["unreachable"],
            serde_json::json!("network"),
            "落盘写种类代码，不存句子"
        );
    }
    let view = &f.codex_state().providers[0];
    assert_eq!(view.unreachable.as_deref(), Some("地址无法访问"));
    assert_eq!(view.models.len(), 2, "失败不丢模型列表");
    assert!(view.models.iter().any(|m| m.selected), "失败不丢勾选");
    let json = serde_json::to_value(view).unwrap();
    assert_eq!(
        json["unreachable"], "地址无法访问",
        "界面字段名是 unreachable"
    );

    // 再试一次，这回拉到了：清空
    f.app
        .merge_fetched_models_in(Agent::Codex, &a, vec!["deepseek/v4".into()], "")
        .unwrap();
    assert_eq!(f.codex_state().providers[0].unreachable, None);
    let world = f.world.lock().unwrap();
    assert_eq!(world.settings.provider(&a).unwrap().unreachable, None);
    let json = serde_json::to_value(&world.settings).unwrap();
    assert!(
        json["providers"][0].get("unreachable").is_none(),
        "清空后不写这个键"
    );
}

/// 按 id 再试一次只改那一家
#[test]
fn retrying_one_provider_leaves_the_others_alone() {
    let f = fixture();
    let (a, b) = two_providers(&f);
    f.app
        .record_unreachable_in(Agent::Codex, &a, UnreachableReason::Network)
        .unwrap();
    f.app
        .record_unreachable_in(Agent::Codex, &b, UnreachableReason::Auth)
        .unwrap();

    f.app
        .merge_fetched_models_in(Agent::Codex, &b, vec!["deepseek/v4".into()], "")
        .unwrap();
    let state = f.codex_state();
    assert_eq!(
        state.providers[0].unreachable.as_deref(),
        Some("地址无法访问")
    );
    assert_eq!(state.providers[1].unreachable, None);

    assert_eq!(
        code(
            f.app
                .record_unreachable_in(Agent::Codex, "nope", UnreachableReason::Unexpected)
        ),
        "invalid"
    );
}

/// 界面拿到的是当前语言的句子：种类现取句；旧文件里认不出的旧句原样给出
#[test]
fn the_view_shows_the_current_sentence_for_each_reason_kind() {
    let f = fixture();
    let (a, b) = two_providers(&f);
    f.app
        .record_unreachable_in(Agent::Codex, &a, UnreachableReason::Auth)
        .unwrap();
    f.world
        .lock()
        .unwrap()
        .settings
        .provider_mut(&b)
        .unwrap()
        .unreachable = Some(UnreachableReason::Legacy("某句旧话".into()));
    let state = f.codex_state();
    assert_eq!(
        state.providers[0].unreachable.as_deref(),
        Some("密钥无效，请换一个密钥")
    );
    assert_eq!(state.providers[1].unreachable.as_deref(), Some("某句旧话"));
}

/// 换了地址，「无法连接」是对旧地址的结论，一并清掉；只改名不清
#[test]
fn changing_the_address_forgets_the_old_unreachable_verdict() {
    let f = fixture();
    let (a, _) = two_providers(&f);
    f.app
        .record_unreachable_in(Agent::Codex, &a, UnreachableReason::Network)
        .unwrap();
    f.app
        .upsert_provider_in(
            Agent::Codex,
            Some(&a),
            Some("WeCode 2"),
            "https://wecode.example/openai",
            false,
        )
        .map(|saved| saved.provider_id)
        .unwrap();
    assert_eq!(
        f.codex_state().providers[0].unreachable.as_deref(),
        Some("地址无法访问")
    );
    f.app
        .upsert_provider_in(
            Agent::Codex,
            Some(&a),
            None,
            "https://wecode2.example/openai",
            false,
        )
        .map(|saved| saved.provider_id)
        .unwrap();
    assert_eq!(f.codex_state().providers[0].unreachable, None);
}

fn fetched(id: &str, context_window: Option<u32>) -> Model {
    Model {
        id: id.into(),
        context_window,
        ..Default::default()
    }
}

fn catalog_context_windows(f: &Fixture) -> std::collections::HashMap<String, u64> {
    let doc: serde_json::Value =
        serde_json::from_slice(&std::fs::read(f.codex().join("sophia-models.json")).unwrap())
            .unwrap();
    doc["models"]
        .as_array()
        .unwrap()
        .iter()
        // 官方条目原样写回，这里只看带 `context_window` 的（第三方条目一定带）
        .filter_map(|m| {
            Some((
                m["slug"].as_str()?.to_owned(),
                m["context_window"].as_u64()?,
            ))
        })
        .collect()
}

/// 拉取时网关给的上下文长度：存下、出现在状态里（`agents[].providers[].models[].contextWindow`）、
/// 勾选（界面只传 id 与显示名）不抹掉它和看图能力、再拉取时新值覆盖而没给值时沿用旧值、
/// 已选却没返回的原样保留，最后写进 Codex 目录的 `context_window`
#[test]
fn fetched_context_window_survives_select_and_refetch_and_reaches_the_catalog() {
    let f = fixture();
    f.configure();
    f.merge_fetched_models(
        vec![
            fetched("weibo/glm-5", Some(200_000)),
            fetched("kimi-k3", Some(131_072)),
            fetched("no-context", None),
        ],
        "",
    )
    .unwrap();
    let state = serde_json::to_value(f.app.state()).unwrap();
    let models = &state["agents"][0]["providers"][0]["models"];
    assert_eq!(models[0]["id"], "weibo/glm-5");
    assert_eq!(models[0]["contextWindow"], 200_000);
    assert_eq!(models[1]["contextWindow"], 131_072);
    assert!(models[2]["contextWindow"].is_null());

    // 接管来的模型可能带着看图能力：勾选同样不能抹掉
    f.world.lock().unwrap().settings.providers[0].models[1]
        .model
        .vision = true;
    // 界面的勾选：只有 id 与显示名
    f.set_models(vec![
        Model {
            id: "weibo/glm-5".into(),
            display_name: Some("Weibo GLM-5".into()),
            ..Default::default()
        },
        pick("kimi-k3"),
    ])
    .unwrap();
    let saved = f.app.load().unwrap().providers[0].models.clone();
    assert_eq!(saved[0].model.context_window, Some(200_000));
    assert_eq!(saved[0].model.display_name.as_deref(), Some("Weibo GLM-5"));
    assert_eq!(saved[1].model.context_window, Some(131_072));
    assert!(saved[1].model.vision && saved[1].selected);

    // 再拉取：kimi 给了新值；glm 这次没给值，沿用旧的
    f.merge_fetched_models(
        vec![
            fetched("weibo/glm-5", None),
            fetched("kimi-k3", Some(262_144)),
        ],
        "",
    )
    .unwrap();
    // 再拉取：已选的 kimi 这次没返回，原样保留
    f.merge_fetched_models(vec![fetched("weibo/glm-5", None)], "")
        .unwrap();
    let saved = f.app.load().unwrap().providers[0].models.clone();
    let window = |id: &str| {
        saved
            .iter()
            .find(|m| m.model.id == id)
            .and_then(|m| m.model.context_window)
    };
    assert_eq!(window("weibo/glm-5"), Some(200_000));
    assert_eq!(window("kimi-k3"), Some(262_144));
    assert!(saved.iter().all(|m| m.model.id != "no-context"));

    f.app.enable().unwrap();
    let slugs: std::collections::HashMap<String, String> = f
        .codex_state()
        .providers
        .remove(0)
        .models
        .into_iter()
        .map(|m| (m.id, m.slug))
        .collect();
    let catalog = catalog_context_windows(&f);
    assert_eq!(catalog[&slugs["weibo/glm-5"]], 200_000);
    assert_eq!(catalog[&slugs["kimi-k3"]], 262_144);
}

/// 试调用的地址与协议就是路由清单里的那一份（探明的接口基址优先），密钥取这一家的
#[test]
fn probe_target_uses_the_routing_base_protocol_and_key() {
    let f = fixture();
    f.configure();
    let id = f.first_provider().unwrap();
    let target = f
        .app
        .provider_for_probe_in(Agent::Codex, &id, " weibo/glm-5 ")
        .unwrap();
    assert_eq!(target.api_base, "https://gw.example/openai");
    assert_eq!(target.protocol, crate::router::Protocol::Chat);
    assert_eq!(target.model, "weibo/glm-5");
    assert_eq!(target.key, "sk-test-key-123456");
    // Debug 不带密钥
    assert!(!format!("{target:?}").contains("sk-test"));

    f.merge_fetched_models(vec!["weibo/glm-5".into()], "https://gw.example/openai/v1")
        .unwrap();
    f.world.lock().unwrap().settings.providers[0].protocol = "responses".into();
    let target = f
        .app
        .provider_for_probe_in(Agent::Codex, &id, "weibo/glm-5")
        .unwrap();
    assert_eq!(target.api_base, "https://gw.example/openai/v1");
    assert_eq!(target.protocol, crate::router::Protocol::Responses);
}

/// 试调前缺密钥、没有这个网关、没指明模型：报 `invalid`，不联网
#[test]
fn probe_target_needs_a_key_a_known_provider_and_a_model() {
    let f = fixture();
    f.configure();
    let id = f.first_provider().unwrap();
    assert_eq!(
        code(f.app.provider_for_probe_in(Agent::Codex, &id, "  ")),
        "invalid"
    );
    assert_eq!(
        code(f.app.provider_for_probe_in(Agent::Codex, "ghost", "m")),
        "invalid"
    );
    f.world.lock().unwrap().key = None;
    let err = f
        .app
        .provider_for_probe_in(Agent::Codex, &id, "weibo/glm-5")
        .unwrap_err();
    assert_eq!(err.to_string(), "[invalid] 还没有保存密钥");
}
