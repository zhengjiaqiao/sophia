//! 编排层的行为测试，移植自 agents-manager 的 internal/app/app_test.go。
use super::*;
use sophia_core::claude_models::settings::ClaudeGatewaySettings;
use sophia_core::codex_models::catalog::Model;
use sophia_core::model_providers::{
    Enabled, EnabledBy, ModelProviders, ModelRef, Provider, ProviderModel,
};
use std::sync::{Arc, Mutex};

pub(super) const ORIGINAL: &str = "model = \"gpt-5.6-sol\"\nmodel_reasoning_effort = \"high\"\n\n[mcp_servers]\n\n[mcp_servers.node_repl]\ncommand = \"/x/node_repl\"\n";
/// 测试夹具里的 Codex 登录凭据：ChatGPT 登录
pub(super) const AUTH_JSON: &str =
    r#"{"auth_mode":"chatgpt","tokens":{"access_token":"official-secret"}}"#;
const NATIVE_CACHE: &str = r#"{"client_version":"0.154.0","models":[{"slug":"gpt-5.6-sol","display_name":"GPT-5.6 Sol","priority":2,"visibility":"list","base_instructions":"You are Codex."}]}"#;

#[derive(Default)]
pub(super) struct World {
    pub(super) settings: GatewaySettings,
    /// true：网关设置读不出（settings.json 坏了，spec S7）
    pub(super) settings_unreadable: bool,
    /// 卸 launchd 服务的调用（`uninstall <label>`）：旧版 Sophia 的路由服务（R14）与 agents-manager 的
    pub(super) service_calls: Vec<String>,
    old_service_installed: bool,
    /// 本进程里的路由在哪个端口上跑着；None＝没在跑
    pub(super) router: Option<u16>,
    /// 起 / 停路由的记录：`start <端口>` / `stop`
    pub(super) router_events: Vec<String>,
    /// 被别人占着的端口：另一个 Sophia，或别的程序
    pub(super) occupied: std::collections::HashMap<u16, Occupant>,
    /// false：起路由失败（不是端口被占，比如没有权限）
    pub(super) healthy: bool,
    /// 任何一家都能读到的密钥：原有的单网关用例靠它；也记着最近一次写入的值
    pub(super) key: Option<String>,
    /// 按提供商 id 分开存的密钥（全局名单，所有 agent 共用），优先于 `key`
    pub(super) keys: std::collections::HashMap<String, String>,
    /// 写密钥失败的提供商 id
    pub(super) key_write_fails_for: Option<String>,
    /// 密钥读不出的提供商 → 原因：模拟密钥文件没有读取权限
    pub(super) key_errors: std::collections::HashMap<String, String>,
    /// 全局模型提供商名单与各 agent 的「已选」（settings.json 的 `modelProviders`）
    pub(super) models: ModelProviders,
    /// 名单被存了几次
    pub(super) models_saves: u32,
    old_key: Option<String>,
    /// 假进程表：结束进程的测试不真杀进程
    pub(super) processes: Vec<process::ProcessInfo>,
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
    pub(super) codex_app_running: bool,
    /// 查不了在不在运行（`lsappinfo` 不可用）
    codex_app_running_fails: bool,
    /// 退出请求发出后它一直不退（在等人确认）
    pub(super) codex_app_stuck: bool,
    /// 非空时重新打开失败：`(错误种类, 原话)`
    codex_app_open_error: Option<(std::io::ErrorKind, String)>,
    /// 这些 pid 在收到 SIGTERM 之前已经自己退了：kill 报「No such process」，进程表里也没了
    vanished: Vec<u32>,
    /// Codex 桌面应用与结束进程的调用顺序：quit / term <pid> / open
    pub(super) codex_events: Vec<String>,
    pub(super) codex_started_at: Option<u64>,
    codex_version: String,
    pub(super) now: u64,
    /// 起路由时先调它（在端口上 bind 之前）
    on_start: Option<Box<dyn Fn() + Send>>,
    // ----- 家 claude（claude_tests.rs 用） -----
    pub(super) claude: ClaudeGatewaySettings,
    /// 钥匙串里的令牌
    pub(super) token: Option<String>,
    /// 下一次生成的令牌
    pub(super) next_token: String,
    /// 读令牌失败时的原话；None＝读得出
    pub(super) token_error: Option<String>,
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
    /// Codex 那一家的网关设置被存了几次
    pub(super) settings_saves: u32,

    // ----- 家 workbuddy（workbuddy_tests.rs 用） -----
    pub(super) workbuddy: sophia_core::workbuddy_models::WorkBuddyGatewaySettings,
    pub(super) workbuddy_installed: bool,
}

/// 见 `Fixture::codex_state`
pub(super) struct CodexState {
    pub(super) models: sophia_core::model_providers::picks::AgentModels,
    pub(super) enabled: bool,
    pub(super) needs_codex_restart: bool,
    pub(super) router: RouterView,
    pub(super) codex: CodexView,
    pub(super) conflict: String,
    pub(super) takeover: Option<TakeoverOffer>,
}

pub(super) struct Fixture {
    /// `save_provider` 建的那一家（Codex 用例的「第一家」）；没建过就用名单里的第一家
    main: Mutex<Option<String>>,
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
    /// 第一家提供商的 id：多数用例只有一家
    pub(super) fn first_provider(&self) -> Option<String> {
        if let Some(main) = self.main.lock().unwrap().clone() {
            return Some(main);
        }
        self.world
            .lock()
            .unwrap()
            .models
            .providers
            .first()
            .map(|p| p.id.clone())
    }
    /// 加一家提供商（全局名单，提供商页做的事；这里直接写进名单）：id 由名称生成（同提供商页），
    /// 带密钥就存进这一家的位置；`fetched` 是拉到的模型（都不启用）。返回 id
    pub(super) fn add_provider(
        &self,
        name: &str,
        base_url: &str,
        key: Option<&str>,
        fetched: &[&str],
        api_base: &str,
    ) -> String {
        let base_url = clean_base_url(base_url).unwrap();
        let mut w = self.world.lock().unwrap();
        let taken: Vec<String> = w.models.providers.iter().map(|p| p.id.clone()).collect();
        let taken: Vec<&str> = taken.iter().map(String::as_str).collect();
        let id = sophia_core::codex_models::settings::new_provider_id(name, &taken);
        w.models.providers.push(Provider {
            id: id.clone(),
            name: name.to_owned(),
            base_url,
            api_base: Some(api_base.to_owned()).filter(|b| !b.is_empty()),
            models: fetched
                .iter()
                .map(|m| ProviderModel {
                    model: Model::from(*m),
                    enabled: None,
                })
                .collect(),
            ..Provider::default()
        });
        if let Some(key) = key {
            w.keys.insert(id.clone(), key.to_owned());
        }
        id
    }
    /// 存提供商地址：建过就改那一家，没建过就新建（名称取主机名，同旧网关），之后让开着的配置跟上
    pub(super) fn save_provider(&self, base_url: &str) -> Result<(), AppError> {
        let cleaned = clean_base_url(base_url)?;
        let main = self.main.lock().unwrap().clone();
        match main {
            Some(id) => {
                self.world
                    .lock()
                    .unwrap()
                    .models
                    .edit(&id, None, &cleaned)
                    .unwrap();
                self.app.models_changed();
            }
            None => {
                let host = url::Url::parse(&cleaned)
                    .unwrap()
                    .host_str()
                    .unwrap()
                    .to_owned();
                let id = self.add_provider(&host, &cleaned, None, &[], "");
                *self.main.lock().unwrap() = Some(id);
            }
        }
        Ok(())
    }
    /// 在 `id` 这一家启用这些模型（不在列表里的加进去），其余的取消启用；返回它们的引用
    pub(super) fn enable_models(&self, id: &str, selected: &[Model]) -> Vec<ModelRef> {
        let mut w = self.world.lock().unwrap();
        let mut seq = w.models.enable_seq;
        let provider = w.models.providers.iter_mut().find(|p| p.id == id).unwrap();
        for pick in selected {
            match provider.models.iter_mut().find(|m| m.model.id == pick.id) {
                Some(found) => {
                    if pick.display_name.is_some() {
                        found.model.display_name = pick.display_name.clone();
                    }
                }
                None => provider.models.push(ProviderModel {
                    model: pick.clone(),
                    enabled: None,
                }),
            }
        }
        for m in provider.models.iter_mut() {
            let on = selected.iter().any(|p| p.id == m.model.id);
            m.enabled = match (on, m.enabled) {
                (true, None) => {
                    seq += 1;
                    Some(Enabled {
                        by: EnabledBy::User,
                        seq,
                    })
                }
                (true, kept) => kept,
                (false, _) => None,
            };
        }
        w.models.enable_seq = seq;
        selected.iter().map(|m| ModelRef::new(id, &m.id)).collect()
    }
    /// 「这一家的完整勾选」（旧网关的说法）：启用这些、Codex 的已选里这一家的换成它们（别家与官方模型不动），
    /// 经 `App::set_picks` 让开着的配置跟上
    pub(super) fn pick_models(&self, id: &str, selected: Vec<Model>) -> Result<(), AppError> {
        let refs = self.enable_models(id, &selected);
        let mut picks: Vec<ModelRef> = self
            .world
            .lock()
            .unwrap()
            .models
            .picked("codex")
            .iter()
            .filter(|r| r.provider != id)
            .cloned()
            .collect();
        picks.extend(refs);
        self.app.set_picks(Agent::Codex, picks).map(|_| ())
    }
    /// 勾选第一家的模型
    pub(super) fn set_models(&self, selected: Vec<Model>) -> Result<(), AppError> {
        let id = self.first_provider().expect("还没有提供商");
        self.pick_models(&id, selected)
    }
    /// 把拉到的模型并入第一家（提供商页的「重拉」），之后让开着的配置跟上
    pub(super) fn merge_fetched_models(
        &self,
        ids: Vec<Model>,
        api_base: &str,
    ) -> Result<(), AppError> {
        let id = self.first_provider().expect("还没有提供商");
        self.world
            .lock()
            .unwrap()
            .models
            .merge_fetched(&id, ids, api_base)
            .unwrap();
        self.app.models_changed();
        Ok(())
    }
    /// Codex 那一家的状态，拍平成按家拆开之前的样子：spec R39 删了 `GatewayState` 顶层的 Codex 字段，
    /// 这些用例只测 Codex，断言照旧读这几个名字
    pub(super) fn codex_state(&self) -> CodexState {
        let state = self.app.state();
        let view = state.agent(Agent::Codex).cloned().expect("Codex 总在");
        let codex = view.codex.unwrap_or_default();
        CodexState {
            models: view.models,
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
    /// 路由正在哪个端口上跑
    pub(super) fn router(&self) -> Option<u16> {
        self.world.lock().unwrap().router
    }
    pub(super) fn router_events(&self) -> Vec<String> {
        self.world.lock().unwrap().router_events.clone()
    }
    /// 旧版 Sophia 装的 launchd 服务的 plist
    pub(super) fn legacy_plist(&self) -> PathBuf {
        self.root
            .join("LaunchAgents")
            .join(format!("{SERVICE_LABEL}.plist"))
    }
}

pub(super) fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let codex = root.join("codex");
    std::fs::create_dir_all(&codex).unwrap();
    std::fs::write(codex.join("config.toml"), ORIGINAL).unwrap();
    // ChatGPT 登录的形状（只看字段有没有值）：现有用例都按借用内置服务商写（spec 2026-10-03-codex-hookup-auto R2）
    std::fs::write(codex.join("auth.json"), AUTH_JSON).unwrap();
    std::fs::write(codex.join("models_cache.json"), NATIVE_CACHE).unwrap();
    let world = Arc::new(Mutex::new(World {
        healthy: true,
        key: Some("sk-test-key-123456".into()),
        codex_version: "0.154.0".into(),
        now: 2_000_000_000,
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
            move || {
                let w = w.lock().unwrap();
                if w.settings_unreadable {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "settings.json 坏了",
                    ));
                }
                Ok(w.settings.clone())
            }
        }),
        save_settings: Box::new({
            let w = w.clone();
            move |s| {
                let mut w = w.lock().unwrap();
                w.settings = s.clone();
                w.settings_saves += 1;
                Ok(())
            }
        }),
        launch_agents_dir: root.join("LaunchAgents"),
        service_uninstall: Box::new({
            let w = w.clone();
            let plist_dir = root.join("LaunchAgents");
            move |label| {
                let mut w = w.lock().unwrap();
                w.service_calls.push(format!("uninstall {label}"));
                if label != SERVICE_LABEL {
                    w.old_service_installed = false
                }
                let _ = std::fs::remove_file(plist_dir.join(format!("{label}.plist")));
                Ok(())
            }
        }),
        router_start: Box::new({
            let w = w.clone();
            move |port| {
                if let Some(hook) = &w.lock().unwrap().on_start {
                    hook();
                }
                let mut w = w.lock().unwrap();
                if w.router == Some(port) {
                    return Ok(());
                }
                if let Some(occupant) = w.occupied.get(&port) {
                    return Err(StartError::Busy(*occupant));
                }
                if !w.healthy {
                    return Err(StartError::Failed("Permission denied (os error 13)".into()));
                }
                if w.router.take().is_some() {
                    w.router_events.push("stop".into());
                }
                w.router = Some(port);
                w.router_events.push(format!("start {port}"));
                Ok(())
            }
        }),
        router_stop: Box::new({
            let w = w.clone();
            move || {
                let mut w = w.lock().unwrap();
                if w.router.take().is_some() {
                    w.router_events.push("stop".into());
                }
            }
        }),
        router_running: Box::new({
            let w = w.clone();
            move || w.lock().unwrap().router
        }),
        bundled: Box::new(|| Err(std::io::Error::other("not needed"))),
        // 密钥按提供商 id 存（全局名单，所有 agent 共用）
        get_key: Box::new({
            let w = w.clone();
            move |id| {
                let w = w.lock().unwrap();
                if let Some(reason) = w.key_errors.get(id) {
                    return Err(reason.clone());
                }
                Ok(w.keys.get(id).cloned().or_else(|| w.key.clone()))
            }
        }),
        set_key: Box::new({
            let w = w.clone();
            move |id, k| {
                let mut w = w.lock().unwrap();
                if w.key_write_fails_for.as_deref() == Some(id) {
                    return Err("keychain is locked".to_owned());
                }
                w.keys.insert(id.to_owned(), k.to_owned());
                w.key = Some(k.to_owned());
                Ok(())
            }
        }),
        load_models: Box::new({
            let w = w.clone();
            move || Ok(w.lock().unwrap().models.clone())
        }),
        change_models: Box::new({
            let w = w.clone();
            move |change| {
                let mut w = w.lock().unwrap();
                let mut next = w.models.clone();
                if change(&mut next) {
                    w.models = next;
                    w.models_saves += 1;
                }
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
        get_router_token: Box::new({
            let w = w.clone();
            move || {
                let w = w.lock().unwrap();
                match &w.token_error {
                    Some(error) => Err(error.clone()),
                    None => Ok(w.token.clone()),
                }
            }
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
        workbuddy_dir: root.join("workbuddy"),
        workbuddy_installed: Box::new({
            let w = w.clone();
            move || w.lock().unwrap().workbuddy_installed
        }),
        load_workbuddy: Box::new({
            let w = w.clone();
            move || Ok(w.lock().unwrap().workbuddy.clone())
        }),
        save_workbuddy: Box::new({
            let w = w.clone();
            move |s| {
                w.lock().unwrap().workbuddy = s.clone();
                Ok(())
            }
        }),
    };
    Fixture {
        main: Mutex::new(None),
        app: App::new(deps),
        world,
        root,
        _dir: dir,
    }
}

pub(super) fn code(result: Result<impl Sized, AppError>) -> String {
    result.err().map(|e| e.code.to_owned()).unwrap_or_default()
}

/// 借用内置服务商接法写进 Codex 设置的三行：注释加两个根键（spec 2026-10-05-exit-fallback R2）
pub(super) fn our_lines(f: &Fixture) -> String {
    format!(
        "{}\n{}",
        sophia_core::codex_models::config::COMMENT_BUILTIN,
        our_keys(f)
    )
}

/// 两个根键本身
pub(super) fn our_keys(f: &Fixture) -> String {
    format!(
        "model_catalog_json = \"{}\"\nopenai_base_url = \"http://127.0.0.1:47328/v1\"\n",
        f.codex().join("sophia-models.json").display()
    )
}

/// AC18（2026-10-05 起三行：注释加两个根键）：启用只给 Codex 设置多写这几行，登录凭据文件不被触碰，并留下备份
#[test]
fn ac18_enable_writes_three_lines_and_never_touches_auth() {
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
    assert_eq!(std::fs::read_to_string(&auth).unwrap(), AUTH_JSON);
    // 备份进 Sophia 数据目录下的 backups/，后缀 models 与 MCP 的 mcp 分得清；codex 目录里不留备份
    let backups = atomicfile::backup_dir(&f.root.join("data/backups"), &f.config());
    let baks: Vec<_> = std::fs::read_dir(&backups)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.to_string_lossy().ends_with("-models.bak"))
        .collect();
    assert_eq!(baks.len(), 1, "{baks:?}");
    assert_eq!(std::fs::read_to_string(&baks[0]).unwrap(), ORIGINAL);
    assert!(!std::fs::read_dir(f.codex()).unwrap().any(|entry| entry
        .unwrap()
        .path()
        .extension()
        .is_some_and(|ext| ext == "bak")));
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

/// R6：先在本进程里起好路由，再写 Codex 设置；不装 launchd 服务、不复制程序（AC1）
#[test]
fn enable_starts_router_before_writing_config() {
    let f = fixture();
    f.configure();
    let seen = Arc::new(Mutex::new(String::new()));
    let (seen2, config) = (seen.clone(), f.config());
    f.world.lock().unwrap().on_start = Some(Box::new(move || {
        *seen2.lock().unwrap() = std::fs::read_to_string(&config).unwrap()
    }));
    f.app.enable().unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        ORIGINAL,
        "路由确认健康之前就写了设置"
    );
    assert_eq!(f.router(), Some(47328));
    assert_eq!(f.router_events(), ["start 47328"]);
    assert!(f.world.lock().unwrap().service_calls.is_empty());
    assert!(!f.root.join("data/bin").exists(), "不再复制程序副本");
    assert_eq!(
        f.routing()["providers"],
        serde_json::json!([{
            "id": "gw.example",
            "base_url": "https://gw.example/openai",
            "protocol": "chat"
        }])
    );
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
    assert!(f.router_events().is_empty());
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

/// 密钥会随请求发给提供商：只允许 https（本机回环除外），地址里不能带用户名密码（提供商页加、改时都过这一关）
#[test]
fn gateway_url_must_be_https_without_credentials() {
    for bad in [
        "",
        "gw.example/openai",
        "ftp://gw.example",
        "http://gw.example/openai",
        "https://user:pass@gw.example/openai",
    ] {
        assert_eq!(code(clean_base_url(bad)), "invalid", "{bad}");
    }
    for ok in [
        "https://gw.example/openai",
        "http://127.0.0.1:9000/openai",
        "http://localhost:9000",
    ] {
        clean_base_url(ok).unwrap_or_else(|e| panic!("{ok}: {e}"));
    }
}

/// 拉取到的接口基址用于路由的上游地址；已选和显示名保留；换地址后旧基址作废，开着的清单当场跟上
#[test]
fn fetched_api_base_is_used_and_selection_survives() {
    let f = fixture();
    f.configure();
    f.merge_fetched_models(
        vec!["weibo/glm-5".into(), "kimi-k3".into()],
        "https://gw.example/openai/v1",
    )
    .unwrap();
    let models = f.codex_state().models;
    let glm = models
        .picked
        .iter()
        .find(|m| m.model_ref.model == "weibo/glm-5")
        .unwrap();
    assert_eq!(glm.display_name, "Weibo GLM-5");
    f.app.enable().unwrap();
    assert_eq!(
        f.routing()["providers"][0]["base_url"],
        "https://gw.example/openai/v1"
    );
    // 换地址：旧基址作废，清单立刻跟上；路由每个请求重读清单，不用重起
    f.save_provider("https://other.example/api").unwrap();
    assert_eq!(
        f.routing()["providers"][0]["base_url"],
        "https://other.example/api"
    );
    assert_eq!(f.router_events(), ["start 47328"]);
}

/// AC20：恢复后逐字节相同，本功能文件清除、路由停下；「已选」留着，再打开时就有
#[test]
fn ac20_restore_returns_original_bytes_and_cleans_up() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
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
    assert_eq!(f.router(), None, "两家都关了：路由停下");
    let state = f.codex_state();
    assert!(!state.enabled);
    assert!(state
        .models
        .picked
        .iter()
        .any(|m| m.model_ref.model == "weibo/glm-5"));
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
    assert!(f.codex_state().router.running);
    // 路由不在了（比如打开时没接上）：状态直接看本进程的路由，不再探 HTTP
    f.world.lock().unwrap().router = None;
    let state = f.codex_state();
    assert!(!state.router.running && !state.router.error.is_empty());
    f.world.lock().unwrap().router = Some(47328);
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
    f.world.lock().unwrap().on_start =
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
    assert_eq!(f.router(), Some(47328));
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

/// AC22：接管把地址、模型、显示名、密钥、启用前默认模型原样带过来（进全局名单，勾着的选进 Codex），
/// 撤下对方的服务和文件，设置改指向本功能
#[test]
fn ac22_takeover_migrates_everything_without_reentering_the_key() {
    let f = fixture();
    agents_manager_setup(&f);
    f.app.takeover().unwrap();
    let world = f.world.lock().unwrap();
    assert_eq!(world.key.as_deref(), Some("sk-old-tool-key-123456"));
    assert_eq!(
        world.models.providers[0].base_url,
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
    let glm = state
        .models
        .picked
        .iter()
        .find(|m| m.model_ref.model == "thudm/glm-5.2")
        .unwrap();
    assert_eq!(glm.display_name, "GLM-5.2");
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
    assert_eq!(world.router, None, "失败后不该留下本功能的路由");
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
    let world = f.world.lock().unwrap();
    assert!(world.settings.added_newline);
    let model = &world.models.providers[0].models[0].model;
    assert_eq!(model.context_window, Some(200000));
    assert!(model.vision);
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
    f.world.lock().unwrap().on_start = Some(Box::new(move || {
        std::fs::write(&config, "model = \"gpt-5.6-sol\"\n").unwrap();
    }));
    assert!(f.app.takeover().is_err());
    let world = f.world.lock().unwrap();
    assert_eq!(world.router, None, "失败后不该留下本功能的路由");
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

// ---------------------------------------------------------------------------
// 多家第三方网关
// ---------------------------------------------------------------------------

fn pick(id: &str) -> Model {
    Model {
        id: id.into(),
        ..Default::default()
    }
}

/// 两家提供商，各有自己的密钥，Codex 各选一个同名模型
fn two_providers(f: &Fixture) -> (String, String) {
    f.world.lock().unwrap().key = None;
    let a = f.add_provider(
        "WeCode",
        "https://wecode.example/openai",
        Some("sk-wecode-key-123456"),
        &["deepseek/v4", "glm-5"],
        "https://wecode.example/openai/v1",
    );
    let b = f.add_provider(
        "Other Gateway",
        "https://other.example/api",
        Some("sk-other-key-1234567"),
        &["deepseek/v4"],
        "",
    );
    f.pick_models(&a, vec![pick("deepseek/v4")]).unwrap();
    f.pick_models(&b, vec![pick("deepseek/v4")]).unwrap();
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

/// 撞名模型在 Codex 目录里的后缀就是提供商名称，与界面「已选」里写的是同一个名字
#[test]
fn the_catalog_suffix_for_clashing_models_is_the_provider_name_the_ui_shows() {
    let f = fixture();
    two_providers(&f);
    f.app.enable().unwrap();
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
        ["deepseek/v4 · WeCode", "deepseek/v4 · Other Gateway"]
    );
    let picked: Vec<(String, String)> = f
        .codex_state()
        .models
        .picked
        .iter()
        .skip(1)
        .map(|m| (m.display_name.clone(), m.provider_name.clone()))
        .collect();
    assert_eq!(
        picked,
        [
            ("deepseek/v4".to_owned(), "WeCode".to_owned()),
            ("deepseek/v4".to_owned(), "Other Gateway".to_owned())
        ]
    );
}

/// 启用前逐家检查：选了模型的提供商必须有密钥；没被选的那家不挡路
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

    f.pick_models(&b, vec![]).unwrap();
    f.app.enable().unwrap();
    assert_eq!(catalog_slugs(&f), ["gpt-5.6-sol", "wecode-deepseek-v4"]);
    // 没有模型在用的那一家，地址不写进 Codex 目录
    assert_eq!(f.routing()["providers"].as_array().unwrap().len(), 1);
}

/// R4 / AC2：读不出密钥不当成「没有」——启用、试调都说「不可用：原因」而不是「还没有密钥」
#[test]
fn an_unreadable_key_is_not_reported_as_missing() {
    let f = fixture();
    let (a, b) = two_providers(&f);
    let reason = sophia_core::t!(
        "models.secrets.unreadable",
        reason = sophia_core::t!("models.secrets.noPermission")
    );
    f.world
        .lock()
        .unwrap()
        .key_errors
        .insert(b.clone(), reason.clone());

    let missing = sophia_core::t!("models.app.providerNoKey", name = "Other Gateway");
    let error = f.app.enable().unwrap_err();
    assert_eq!(error.code, "invalid");
    assert!(error.message.contains(&reason), "{}", error.message);
    assert_ne!(error.message, missing);
    let error = f.app.probe_target(&b, "deepseek/v4").unwrap_err();
    assert!(error.message.contains(&reason), "{}", error.message);
    assert_ne!(error.message, sophia_core::t!("models.app.noKey"));
    assert!(f.app.probe_target(&a, "deepseek/v4").is_ok());
    assert_eq!(f.read_config(), ORIGINAL);
}

/// 删掉一家（提供商页）：它从各家「已选」里拿掉，开着的 Codex 当场跟上，它的模型进停用名单
#[test]
fn removing_a_provider_retires_its_models() {
    let f = fixture();
    let (_a, b) = two_providers(&f);
    f.app.enable().unwrap();
    f.world.lock().unwrap().models.remove(&b).unwrap();
    assert!(f.app.models_changed().is_empty());
    assert_eq!(catalog_slugs(&f), ["gpt-5.6-sol", "wecode-deepseek-v4"]);
    let routing = f.routing();
    assert_eq!(
        routing["retired"],
        serde_json::json!(["other-gateway-deepseek-v4"])
    );
    assert_eq!(routing["providers"].as_array().unwrap().len(), 1);
}

/// 开着时删掉了最后一家被选的提供商：第三方模型一个不剩，Codex 悄悄改回官方、记成没开着
#[test]
fn removing_the_last_picked_provider_switches_codex_back() {
    let f = fixture();
    let (a, b) = two_providers(&f);
    f.pick_models(&b, vec![]).unwrap();
    f.app.enable().unwrap();
    f.world.lock().unwrap().models.remove(&a).unwrap();
    f.app.models_changed();
    assert_eq!(f.read_config(), ORIGINAL);
    assert!(!f.codex_state().enabled);
    assert_eq!(f.world.lock().unwrap().settings.enabled, Some(false));
}

/// 在浮层里取消最后一个第三方模型：同样关掉 Codex（「× 掉最后一个＝关掉这一家」）
#[test]
fn unpicking_the_last_third_party_model_switches_codex_back() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    let id = f.first_provider().unwrap();
    f.app
        .pick(Agent::Codex, &ModelRef::new(&id, "weibo/glm-5"), false)
        .unwrap();
    assert_eq!(f.read_config(), ORIGINAL);
    assert!(!f.codex_state().enabled);
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
    f.world.lock().unwrap().models.remove(&b).unwrap();
    f.app.models_changed();
    assert!(
        f.read_config().contains("model = \"gpt-5.6-sol\""),
        "{}",
        f.read_config()
    );
}

/// 已启用时改动发布内容，要先确保路由在跑再写清单。路由起不来就什么都不写，这一下勾选也不留下
#[test]
fn republishing_refuses_to_write_catalogs_when_the_router_cannot_be_brought_up() {
    let f = fixture();
    let (_a, b) = two_providers(&f);
    f.pick_models(&b, vec![]).unwrap();
    f.app.enable().unwrap();
    let routing_before = f.routing();
    // 打开 Sophia 时没接上（路由不在），这次也起不来
    {
        let mut w = f.world.lock().unwrap();
        w.router = None;
        w.healthy = false;
    }
    let other = ModelRef::new(&b, "deepseek/v4");
    f.enable_models(&b, &[pick("deepseek/v4")]);
    assert_eq!(code(f.app.pick(Agent::Codex, &other, true)), "router_down");
    assert_eq!(f.routing(), routing_before, "路由没就绪，清单不该变");
    assert!(
        !f.world
            .lock()
            .unwrap()
            .models
            .picked("codex")
            .contains(&other),
        "没发布成的勾选不该存下来"
    );
}

/// 接管生成固定 id 的一家，不动用户自己加的提供商；对方不带前缀的旧标识进停用名单
#[test]
fn takeover_adds_a_wecode_provider_next_to_existing_ones() {
    let f = fixture();
    let mine = f.add_provider("Mine", "https://mine.example", None, &[], "");
    let config = agents_manager_setup(&f);
    f.write_config(&config.replacen("model = \"gpt-5.6-sol\"", "model = \"thudm-glm-5.2\"", 1));
    f.app.takeover().unwrap();
    let world = f.world.lock().unwrap();
    let ids: Vec<&str> = world
        .models
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

/// 用户自己加的提供商 id 恰好是 wecode 但地址不同时，接管不能覆盖它——它的地址、模型、密钥都得原样留着，
/// 接管来的另起一家（名称撞了加序号）
#[test]
fn takeover_never_overwrites_a_users_own_provider_that_happens_to_share_the_id() {
    let f = fixture();
    f.world.lock().unwrap().key = None;
    let mine = f.add_provider(
        "WeCode",
        "https://my-own.example/v1",
        Some("sk-my-own-key-123456"),
        &["my/model"],
        "",
    );
    assert_eq!(mine, "wecode");
    f.pick_models(&mine, vec![pick("my/model")]).unwrap();
    agents_manager_setup(&f);

    f.app.takeover().unwrap();
    let world = f.world.lock().unwrap();
    let pairs: Vec<(&str, &str, &str)> = world
        .models
        .providers
        .iter()
        .map(|p| (p.id.as_str(), p.name.as_str(), p.base_url.as_str()))
        .collect();
    assert_eq!(
        pairs,
        [
            ("wecode", "WeCode", "https://my-own.example/v1"),
            ("wecode-2", "wecode 2", "https://gw.example/openai")
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
        .models
        .providers
        .iter()
        .map(|p| p.id.as_str())
        .collect();
    assert_eq!(ids, ["wecode"]);
}

/// 启用时也必须先起好路由、再写清单。
#[test]
fn enable_brings_the_router_up_before_writing_the_routing_catalog() {
    let f = fixture();
    two_providers(&f);
    let routing = f.codex().join("sophia-routing.json");
    let seen = Arc::new(Mutex::new(None::<bool>));
    let record = seen.clone();
    let path = routing.clone();
    f.world.lock().unwrap().on_start = Some(Box::new(move || {
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

/// 拉取时给的上下文长度：存下、出现在浮层里；再拉取时新值覆盖而没给值时沿用旧值、已启用却没返回的原样保留；
/// 接管带来的看图能力不被抹掉；最后写进 Codex 目录的 `context_window`
#[test]
fn fetched_context_window_survives_refetch_and_reaches_the_catalog() {
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
    f.set_models(vec![
        Model {
            id: "weibo/glm-5".into(),
            display_name: Some("Weibo GLM-5".into()),
            ..Default::default()
        },
        pick("kimi-k3"),
    ])
    .unwrap();
    let state = serde_json::to_value(f.app.state()).unwrap();
    let group = &state["agents"][0]["models"]["groups"][1];
    assert_eq!(group["models"][0]["ref"]["model"], "weibo/glm-5");
    assert_eq!(group["models"][0]["contextWindow"], 200_000);
    assert_eq!(group["models"][1]["contextWindow"], 131_072);
    f.world.lock().unwrap().models.providers[0].models[1]
        .model
        .vision = true;

    // 再拉取：kimi 给了新值；glm 这次没给值，沿用旧的
    f.merge_fetched_models(
        vec![
            fetched("weibo/glm-5", None),
            fetched("kimi-k3", Some(262_144)),
        ],
        "",
    )
    .unwrap();
    // 再拉取：已启用的 kimi 这次没返回，原样保留
    f.merge_fetched_models(vec![fetched("weibo/glm-5", None)], "")
        .unwrap();
    let saved = f.world.lock().unwrap().models.providers[0].models.clone();
    let window = |id: &str| {
        saved
            .iter()
            .find(|m| m.model.id == id)
            .and_then(|m| m.model.context_window)
    };
    assert_eq!(window("weibo/glm-5"), Some(200_000));
    assert_eq!(window("kimi-k3"), Some(262_144));
    assert!(saved
        .iter()
        .any(|m| m.model.id == "kimi-k3" && m.model.vision));
    assert!(saved.iter().all(|m| m.model.id != "no-context"));

    f.app.enable().unwrap();
    let catalog = catalog_context_windows(&f);
    assert_eq!(catalog["gw.example-weibo-glm-5"], 200_000);
    assert_eq!(catalog["gw.example-kimi-k3"], 262_144);
}

/// 试调用的地址与协议就是路由清单里的那一份（探明的接口基址优先），密钥取这一家的
#[test]
fn probe_target_uses_the_routing_base_protocol_and_key() {
    let f = fixture();
    f.configure();
    let id = f.first_provider().unwrap();
    let target = f.app.probe_target(&id, " weibo/glm-5 ").unwrap();
    assert_eq!(target.api_base, "https://gw.example/openai");
    assert_eq!(target.protocol, crate::router::Protocol::Chat);
    assert_eq!(target.model, "weibo/glm-5");
    assert_eq!(target.key, "sk-test-key-123456");
    // Debug 不带密钥
    assert!(!format!("{target:?}").contains("sk-test"));

    f.merge_fetched_models(vec!["weibo/glm-5".into()], "https://gw.example/openai/v1")
        .unwrap();
    f.world.lock().unwrap().models.providers[0].protocol = "responses".into();
    let target = f.app.probe_target(&id, "weibo/glm-5").unwrap();
    assert_eq!(target.api_base, "https://gw.example/openai/v1");
    assert_eq!(target.protocol, crate::router::Protocol::Responses);
}

/// 试调前缺密钥、没有这一家、没指明模型：报 `invalid`，不联网
#[test]
fn probe_target_needs_a_key_a_known_provider_and_a_model() {
    let f = fixture();
    f.configure();
    let id = f.first_provider().unwrap();
    assert_eq!(code(f.app.probe_target(&id, "  ")), "invalid");
    assert_eq!(code(f.app.probe_target("ghost", "m")), "invalid");
    f.world.lock().unwrap().key = None;
    let err = f.app.probe_target(&id, "weibo/glm-5").unwrap_err();
    assert_eq!(err.to_string(), "[invalid] 还没有保存密钥");
}

/// spec 2026-10-04-local-diagnostics R11：读不到状态时说是哪个文件、哪一种（没权限 / 格式有误），
/// 页面据此给修复权限、打开文件；其余照常读（入口不消失）
#[test]
fn unreadable_config_is_reported_by_kind() {
    use sophia_core::file_issue::FileIssueKind;
    let f = fixture();
    assert_eq!(f.app.state().unreadable, None);

    std::fs::write(f.config(), "model = \"gpt\"\n[broken\n").unwrap();
    let state = f.app.state();
    let issue = state.unreadable.clone().expect("格式有误");
    assert_eq!(issue.kind, FileIssueKind::Format);
    assert_eq!(issue.line, Some(2));
    assert_eq!(issue.path, f.config());
    assert!(
        issue.reason.ends_with("第 2 行格式有误"),
        "{}",
        issue.reason
    );
    assert!(state.supported);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(f.config(), std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(f.config()).is_err() {
            let issue = f.app.state().unreadable.expect("没权限");
            assert_eq!(issue.kind, FileIssueKind::Permission);
            assert!(issue.reason.contains("读不了"), "{}", issue.reason);
        }
        std::fs::set_permissions(f.config(), std::fs::Permissions::from_mode(0o644)).unwrap();
    }
}

/// 修复权限、打开文件只认 Sophia 管的文件：Codex 的设置文件与 Sophia 数据目录里的 JSON；
/// 逐字比对白名单，软链（文件或父目录）、`..` 一律不认（管理员授权的 chown 会跟随软链）
#[test]
fn only_managed_files_can_be_fixed_or_opened() {
    let f = fixture();
    let data = f.root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("settings.json"), "{}").unwrap();
    assert_eq!(f.app.managed_file(&f.config()), Some(f.config()));
    assert_eq!(
        f.app.managed_file(&data.join("settings.json")),
        Some(data.join("settings.json"))
    );
    assert_eq!(f.app.managed_file(&data.join("..").join("x.json")), None);
    assert_eq!(f.app.managed_file(&f.codex().join("auth.json")), None);
    assert_eq!(
        f.app.managed_file(std::path::Path::new("/etc/sudoers")),
        None
    );
    #[cfg(unix)]
    {
        let outside = f.root.join("outside.json");
        std::fs::write(&outside, "{}").unwrap();
        std::os::unix::fs::symlink(&outside, data.join("x.json")).unwrap();
        assert_eq!(f.app.managed_file(&data.join("x.json")), None);
        std::os::unix::fs::symlink(&data, f.root.join("alias")).unwrap();
        assert_eq!(
            f.app
                .managed_file(&f.root.join("alias").join("settings.json")),
            None
        );
    }
}
// ---------- 真实调用的密钥结论（#144） ----------

fn rejected(detail: &str) -> crate::router::KeyVerdict {
    crate::router::KeyVerdict::Rejected {
        detail: detail.into(),
    }
}

/// 路由转发的请求被拒了密钥：那一家（全局名单）记成「密钥无效」（带原文）并落盘；同一结论再报不写。
/// 之后一次调用成功才清，清过再报「成功」也不写；已经删掉的提供商不算错
#[test]
fn a_rejected_call_marks_the_provider_until_a_call_succeeds() {
    use sophia_core::codex_models::settings::UnreachableReason;
    let f = fixture();
    let (a, b) = two_providers(&f);
    let saves = || f.world.lock().unwrap().models_saves;
    let provider = |id: &str| {
        f.world
            .lock()
            .unwrap()
            .models
            .provider(id)
            .cloned()
            .unwrap()
    };
    let before = saves();
    let detail = "POST https://wecode.example/openai/v1/chat/completions → 401 Unauthorized";
    assert!(f.app.record_key_verdict(&a, rejected(detail)).unwrap());
    assert_eq!(saves(), before + 1);
    let marked = provider(&a);
    assert_eq!(marked.unreachable, Some(UnreachableReason::Auth));
    assert_eq!(marked.unreachable_detail.as_deref(), Some(detail));
    assert!(marked.key_rejected_on_call);
    assert_eq!(provider(&b).unreachable, None, "别家不动");

    // 同一结论：不写
    assert!(!f
        .app
        .record_key_verdict(&a, rejected("另一次的原文"))
        .unwrap());
    assert_eq!(saves(), before + 1);

    // 之后一次调用成功：清掉
    assert!(f
        .app
        .record_key_verdict(&a, crate::router::KeyVerdict::Accepted)
        .unwrap());
    assert_eq!(saves(), before + 2);
    let cleared = provider(&a);
    assert_eq!(cleared.unreachable, None);
    assert!(!cleared.key_rejected_on_call);
    // 已经是好的：成功不写
    assert!(!f
        .app
        .record_key_verdict(&b, crate::router::KeyVerdict::Accepted)
        .unwrap());
    // 已经删掉的提供商：不算错，也不写
    assert!(!f.app.record_key_verdict("gone", rejected(detail)).unwrap());
    assert_eq!(saves(), before + 2);
}

/// 启用前的试调：401/403（`auth`）记成被拒，通了清掉，别的失败不动（`runtime::probe_verdict` 接到同一个入口）
#[test]
fn probe_results_feed_the_same_key_verdict() {
    let f = fixture();
    let (a, _) = two_providers(&f);
    let rejected_probe: Result<(), AppError> = Err(AppError::new("auth", "密钥被拒")
        .with_detail("POST https://wecode.example/openai/v1/chat/completions → 403 Forbidden"));
    let verdict = crate::runtime::probe_verdict(&rejected_probe).unwrap();
    f.app.record_key_verdict(&a, verdict).unwrap();
    let marked = f
        .world
        .lock()
        .unwrap()
        .models
        .provider(&a)
        .cloned()
        .unwrap();
    assert!(marked.key_rejected_on_call);
    assert!(marked
        .unreachable_detail
        .as_deref()
        .is_some_and(|d| d.contains("403")));

    for other in ["network", "upstream", "invalid"] {
        assert_eq!(
            crate::runtime::probe_verdict(&Err(AppError::new(other, "x"))),
            None,
            "{other}"
        );
    }
    let verdict = crate::runtime::probe_verdict(&Ok(())).unwrap();
    assert_eq!(verdict, crate::router::KeyVerdict::Accepted);
    f.app.record_key_verdict(&a, verdict).unwrap();
    assert_eq!(
        f.world
            .lock()
            .unwrap()
            .models
            .provider(&a)
            .unwrap()
            .unreachable,
        None
    );
}

/// 真实装配里路由拿到的那个出口（`runtime::key_verdict_recorder`）：交出去立刻返回，由另一条线程经编排层落盘
#[test]
fn the_router_sink_records_verdicts_off_the_request_path() {
    let f = fixture();
    let (a, _) = two_providers(&f);
    let Fixture {
        app, world, _dir, ..
    } = f;
    let app = Arc::new(app);
    let sink = crate::runtime::key_verdict_recorder(Arc::downgrade(&app));
    let marked = |want: bool| {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            let on_call = world
                .lock()
                .unwrap()
                .models
                .provider(&a)
                .unwrap()
                .key_rejected_on_call;
            if on_call == want {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        false
    };
    sink(Agent::Codex, &a, rejected("401"));
    assert!(marked(true), "被拒应当落盘");
    sink(Agent::Claude, &a, crate::router::KeyVerdict::Accepted);
    assert!(
        marked(false),
        "成功应当清掉（哪一家报的都记在同一个提供商上）"
    );
}

// ---------- 「已选」接到全局名单（#259） ----------

fn catalog_entries(f: &Fixture) -> Vec<(String, i64)> {
    let doc: serde_json::Value =
        serde_json::from_slice(&std::fs::read(f.codex().join("sophia-models.json")).unwrap())
            .unwrap();
    doc["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["slug"].as_str().unwrap().to_owned(),
                m["priority"].as_i64().unwrap(),
            )
        })
        .collect()
}

/// Codex 的目录按「已选」顺序排：官方与第三方穿插，排序值依次 1、2、3；取消勾选的官方模型不写进目录
#[test]
fn codex_catalog_follows_the_pick_order_with_official_models_in_between() {
    let f = fixture();
    f.configure();
    let id = f.first_provider().unwrap();
    f.pick_models(&id, vec![pick("weibo/glm-5"), pick("kimi-k3")])
        .unwrap();
    f.app.enable().unwrap();
    assert_eq!(
        catalog_entries(&f),
        [
            ("gpt-5.6-sol".to_owned(), 1),
            ("gw.example-weibo-glm-5".to_owned(), 2),
            ("gw.example-kimi-k3".to_owned(), 3)
        ]
    );
    let official = ModelRef::official("gpt-5.6-sol");
    f.app
        .set_picks(
            Agent::Codex,
            vec![
                ModelRef::new(&id, "kimi-k3"),
                official.clone(),
                ModelRef::new(&id, "weibo/glm-5"),
            ],
        )
        .unwrap();
    assert_eq!(
        catalog_entries(&f),
        [
            ("gw.example-kimi-k3".to_owned(), 1),
            ("gpt-5.6-sol".to_owned(), 2),
            ("gw.example-weibo-glm-5".to_owned(), 3)
        ]
    );
    f.app.pick(Agent::Codex, &official, false).unwrap();
    let slugs: Vec<String> = catalog_entries(&f).into_iter().map(|(s, _)| s).collect();
    assert_eq!(slugs, ["gw.example-kimi-k3", "gw.example-weibo-glm-5"]);
    let view = f.codex_state().models;
    assert_eq!(view.picked.len(), 2);
    assert!(!view.groups[0].models[0].picked, "官方组里它没勾");
}

/// 排序（#265）：浮层「已选」里拖动或 ⌥↑ / ⌥↓ 之后，开着的 Codex 目录按新顺序重编排序值（只给看得见的几项，
/// 别的原地不动）；恢复默认顺序＝官方在前、第三方按启用先后
#[test]
fn reordering_rewrites_the_codex_catalog_and_restoring_puts_official_first() {
    let f = fixture();
    f.configure();
    let id = f.first_provider().unwrap();
    f.app.enable().unwrap();
    f.pick_models(&id, vec![pick("weibo/glm-5"), pick("kimi-k3")])
        .unwrap();
    let glm = ModelRef::new(&id, "weibo/glm-5");
    let kimi = ModelRef::new(&id, "kimi-k3");
    let official = ModelRef::official("gpt-5.6-sol");

    f.app
        .reorder_picks(Agent::Codex, vec![kimi.clone(), glm.clone()])
        .unwrap();
    assert_eq!(
        catalog_entries(&f),
        [
            ("gpt-5.6-sol".to_owned(), 1),
            ("gw.example-kimi-k3".to_owned(), 2),
            ("gw.example-weibo-glm-5".to_owned(), 3)
        ]
    );
    f.app
        .reorder_picks(Agent::Codex, vec![kimi, glm, official])
        .unwrap();
    assert_eq!(
        catalog_entries(&f),
        [
            ("gw.example-kimi-k3".to_owned(), 1),
            ("gw.example-weibo-glm-5".to_owned(), 2),
            ("gpt-5.6-sol".to_owned(), 3)
        ]
    );

    f.app.restore_order(Agent::Codex).unwrap();
    assert_eq!(
        catalog_entries(&f),
        [
            ("gpt-5.6-sol".to_owned(), 1),
            ("gw.example-weibo-glm-5".to_owned(), 2),
            ("gw.example-kimi-k3".to_owned(), 3)
        ]
    );
}

/// 恢复默认顺序不增不减（走查 2026-10-07 第 6 条）：没登录 OpenAI 时也只重排存着的那几项。
/// 存着的官方模型是打开 Codex 那一刻第一次见到时整组并进来的（`sync_official`），不是恢复顺序补的
#[test]
fn restoring_the_order_neither_adds_nor_drops_picks() {
    let f = fixture();
    std::fs::remove_file(f.codex().join("auth.json")).unwrap();
    f.configure();
    f.app.enable().unwrap();
    let stored = |f: &Fixture| {
        let mut picked = f.world.lock().unwrap().models.picked("codex").to_vec();
        picked.sort();
        picked
    };
    let before = stored(&f);
    f.app.restore_order(Agent::Codex).unwrap();
    assert_eq!(stored(&f), before);
}

/// Codex 升级带来的新官方模型默认选上、排最后；用户取消过的不会被选回来
#[test]
fn new_official_models_join_the_end_and_unpicked_ones_stay_out() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    f.app
        .pick(Agent::Codex, &ModelRef::official("gpt-5.6-sol"), false)
        .unwrap();
    std::fs::write(
        f.codex().join("models_cache.json"),
        r#"{"client_version":"0.155.0","models":[
          {"slug":"gpt-5.6-sol","display_name":"GPT-5.6 Sol","priority":2,"visibility":"list","base_instructions":"You are Codex."},
          {"slug":"gpt-7","display_name":"GPT-7","priority":1,"visibility":"list","base_instructions":"You are Codex."}]}"#,
    )
    .unwrap();
    let id = f.first_provider().unwrap();
    f.pick_models(&id, vec![pick("weibo/glm-5"), pick("kimi-k3")])
        .unwrap();
    let slugs: Vec<String> = catalog_entries(&f).into_iter().map(|(s, _)| s).collect();
    assert_eq!(
        slugs,
        ["gw.example-weibo-glm-5", "gw.example-kimi-k3", "gpt-7"]
    );
}

/// 浮层的视图：Codex 官方组在前；没登录 OpenAI 时官方组置灰、不算进已选；Claude 的官方组总是置灰
/// （关着第三方时说它自己管，开着时说用不了，见 claude_tests）
#[test]
fn the_picker_view_follows_sign_in_and_agent_rules() {
    use sophia_core::model_providers::picks::Blocked;
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    let view = f.codex_state().models;
    assert_eq!(view.groups[0].blocked, None);
    assert_eq!(view.picked.len(), 2);
    std::fs::remove_file(f.codex().join("auth.json")).unwrap();
    let view = f.codex_state().models;
    assert_eq!(view.groups[0].blocked, Some(Blocked::SignedOut));
    assert_eq!(view.picked.len(), 1);
    let claude = f.app.state().agent(Agent::Claude).unwrap().models.clone();
    assert_eq!(claude.groups[0].blocked, Some(Blocked::ReadOnly));
}
