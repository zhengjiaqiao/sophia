//! 把各模块串成“保存网关 / 选模型 / 启用 / 恢复 / 接管 / 查看状态”这几个动作，界面和命令行共用。
//! 行为移植自 agents-manager 的 `internal/app`（Go，已在真实环境验证）。
#[cfg(test)]
mod tests;

use crate::{service, takeover};
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use symsync_core::atomicfile::{self, FileState};
use symsync_core::codex_models::catalog::{self, Model};
use symsync_core::codex_models::config::{self, ConfigError, Managed};
use symsync_core::codex_models::settings::{GatewaySettings, SavedModel};

pub const SERVICE_LABEL: &str = "com.zhengjiaqiao.symsync.gateway";
/// 本功能放在 Codex 目录下的文件统一用这个前缀，恢复时据此精确清理
pub const OWN_FILE_PREFIX: &str = "symsync-";
const CATALOG_FILE: &str = "symsync-models.json";
const ROUTING_FILE: &str = "symsync-routing.json";
/// 备份后缀：`config.models.bak`，与 MCP 的 `config.mcp.bak` 不撞名
const BACKUP_SUFFIX: &str = "models";

/// 带错误码的错误，显示为 `[代码] 说明`，代码取值见 docs/gateway-commands.md
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
}

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

type Op<A, R> = Box<dyn Fn(A) -> R + Send + Sync>;
type Get<R> = Box<dyn Fn() -> R + Send + Sync>;

/// 对外部世界的全部依赖，测试里全部替换成假的
pub struct Deps {
    pub codex_home: PathBuf,
    /// SymSync 的数据目录；后台程序副本放在它的 `bin/` 下。同目录还有 settings.json 等，清理时不能碰
    pub data_dir: PathBuf,
    /// agents-manager 的数据目录（`~/.agents-manager`），只读
    pub agents_manager_dir: PathBuf,
    pub load_settings: Get<io::Result<GatewaySettings>>,
    pub save_settings: Box<dyn Fn(&GatewaySettings) -> io::Result<()> + Send + Sync>,
    pub service_install: Box<dyn Fn(&service::Spec) -> io::Result<()> + Send + Sync>,
    pub service_uninstall: Box<dyn Fn(&str) -> io::Result<()> + Send + Sync>,
    pub service_status: Box<dyn Fn(&str) -> io::Result<service::Status> + Send + Sync>,
    pub service_restart: Box<dyn Fn(&str) -> io::Result<()> + Send + Sync>,
    /// 在端口上确认本功能的路由已就绪（内部自带等待）
    pub router_healthy: Op<u16, Result<(), String>>,
    /// 运行 `codex debug models --bundled`
    pub bundled: Get<io::Result<Vec<u8>>>,
    pub get_key: Get<Result<String, String>>,
    pub set_key: Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
    pub get_agents_manager_key: Get<Result<String, String>>,
    /// 把当前可执行文件复制到稳定路径；返回副本是否被更新
    pub install_binary: Box<dyn Fn(&Path) -> io::Result<bool> + Send + Sync>,
    /// Codex 桌面应用主进程的启动时间（unix 秒）；没在运行为 None
    pub codex_started_at: Get<Option<u64>>,
    pub codex_version: Get<String>,
    pub now: Get<u64>,
}

pub struct App {
    deps: Deps,
    /// 同一进程里的动作串行执行
    lock: Mutex<()>,
}

// ----- 状态视图（字段与 docs/gateway-commands.md 一致） -----

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelView {
    pub id: String,
    pub slug: String,
    pub display_name: String,
    pub selected: bool,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub base_url: String,
    pub has_key: bool,
    pub models: Vec<ModelView>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterView {
    pub installed: bool,
    pub running: bool,
    pub port: u16,
    pub error: String,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexView {
    pub version: String,
    pub running: bool,
    pub catalog_version: String,
    pub drift: bool,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeoverOffer {
    pub base_url: String,
    pub selected_count: usize,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayState {
    pub supported: bool,
    pub provider: ProviderView,
    pub enabled: bool,
    pub needs_codex_restart: bool,
    pub router: RouterView,
    pub codex: CodexView,
    pub conflict: String,
    pub takeover: Option<TakeoverOffer>,
}

fn internal(e: impl fmt::Display) -> AppError {
    AppError::new("internal", e.to_string())
}

fn config_error(e: ConfigError) -> AppError {
    match e {
        ConfigError::Conflict(conflict) => AppError::new("conflict", conflict.to_string()),
        ConfigError::Invalid(_) => AppError::new("invalid", e.to_string()),
    }
}

/// 网关地址：密钥会随每个请求发过去，只允许 https（本机回环除外），不能带用户名密码
pub fn clean_base_url(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim().trim_end_matches('/');
    let parsed = url::Url::parse(trimmed)
        .map_err(|_| AppError::new("invalid", "网关地址需要是完整的 https 地址"))?;
    let host = parsed.host_str().unwrap_or("");
    if !matches!(parsed.scheme(), "http" | "https") || host.is_empty() {
        return Err(AppError::new("invalid", "网关地址需要是完整的 https 地址"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppError::new(
            "invalid",
            "网关地址里不要带用户名和密码，密钥请填在密钥一栏",
        ));
    }
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if parsed.scheme() == "http" && !loopback {
        return Err(AppError::new(
            "invalid",
            "网关地址必须是 https：密钥会随请求发送，不能走明文",
        ));
    }
    Ok(trimmed.to_owned())
}

struct ConfigSnapshot {
    state: FileState,
    text: String,
}

impl App {
    pub fn new(deps: Deps) -> Self {
        Self {
            deps,
            lock: Mutex::new(()),
        }
    }

    fn config_path(&self) -> PathBuf {
        self.deps.codex_home.join("config.toml")
    }
    fn catalog_path(&self) -> PathBuf {
        self.deps.codex_home.join(CATALOG_FILE)
    }
    fn routing_path(&self) -> PathBuf {
        self.deps.codex_home.join(ROUTING_FILE)
    }
    fn binary_path(&self) -> PathBuf {
        self.deps.data_dir.join("bin").join("symsync")
    }
    fn log_dir(&self) -> PathBuf {
        self.deps.data_dir.join("gateway-logs")
    }

    fn managed(&self, settings: &GatewaySettings) -> Managed {
        Managed {
            catalog_path: self.catalog_path().to_string_lossy().into_owned(),
            base_url: format!("http://127.0.0.1:{}/v1", settings.port),
        }
    }

    fn load(&self) -> Result<GatewaySettings, AppError> {
        (self.deps.load_settings)().map_err(internal)
    }

    fn save(&self, settings: &GatewaySettings) -> Result<(), AppError> {
        (self.deps.save_settings)(settings).map_err(internal)
    }

    fn read_config(&self) -> Result<ConfigSnapshot, AppError> {
        let state = atomicfile::read_state(&self.config_path())
            .map_err(|_| AppError::new("invalid", "Codex 设置文件不可读，或不是普通文件"))?;
        let text = match &state {
            FileState::Missing => String::new(),
            FileState::Present(snapshot) => String::from_utf8(snapshot.bytes.clone())
                .map_err(|_| AppError::new("invalid", "Codex 设置文件不是 UTF-8 文本"))?,
        };
        Ok(ConfigSnapshot { state, text })
    }

    /// 与 MCP 同步共用同一套写入：备份、原子替换、写前写后校验
    fn write_config(&self, snapshot: &ConfigSnapshot, text: &str) -> Result<(), AppError> {
        if text == snapshot.text {
            return Ok(());
        }
        let path = self.config_path();
        if let FileState::Present(existing) = &snapshot.state {
            atomicfile::backup(&path, existing, BACKUP_SUFFIX).map_err(internal)?;
        }
        atomicfile::atomic_write(&path, text.as_bytes(), &snapshot.state).map_err(|e| {
            if e.to_string() == "changed" {
                AppError::new(
                    "changed",
                    "Codex 设置在操作期间被别的程序改动了，未做任何覆盖，请重试",
                )
            } else {
                internal(format!("写入 Codex 设置失败: {e}"))
            }
        })
    }

    fn enabled(&self, settings: &GatewaySettings) -> bool {
        self.read_config()
            .ok()
            .and_then(|snapshot| config::inspect(&snapshot.text, &self.managed(settings)).ok())
            .is_some_and(|inspection| inspection.enabled)
    }

    fn detect_agents_manager(&self, config_text: &str) -> Option<takeover::Detected> {
        takeover::detect(config_text, &self.deps.codex_home)
    }

    // ----- 动作 -----

    /// 保存网关地址。密钥由 `commit_verified_provider` 或调用方另行写入钥匙串
    pub fn save_provider(&self, base_url: &str) -> Result<(), AppError> {
        let _guard = self.lock.lock().unwrap();
        self.save_provider_locked(base_url)
    }

    fn save_provider_locked(&self, base_url: &str) -> Result<(), AppError> {
        let cleaned = clean_base_url(base_url)?;
        let mut settings = self.load()?;
        let changed = settings.base_url != cleaned;
        settings.base_url = cleaned;
        if changed {
            settings.api_base = None; // 旧地址探明的接口基址作废
        }
        self.save(&settings)?;
        if changed && self.enabled(&settings) {
            // 后台服务的启动参数里带着网关地址，地址变了要重装服务
            self.install_router(&settings)?;
        }
        Ok(())
    }

    /// 调用方已经用这个密钥向网关校验通过：保存地址、密钥和模型列表。
    /// 校验失败时调用方不应调用本函数，这样错误的密钥不会覆盖钥匙串里原本好用的那个。
    pub fn commit_verified_provider(
        &self,
        base_url: &str,
        key: &str,
        ids: Vec<String>,
        api_base: &str,
    ) -> Result<(), AppError> {
        let _guard = self.lock.lock().unwrap();
        let key = key.trim();
        if key.is_empty() {
            return Err(AppError::new("invalid", "密钥为空"));
        }
        clean_base_url(base_url)?;
        (self.deps.set_key)(key).map_err(|e| AppError::new("invalid", e))?;
        self.save_provider_locked(base_url)?;
        self.merge_locked(ids, api_base)
    }

    /// 把网关返回的模型列表并入已保存的列表，保留原有的勾选和显示名
    pub fn merge_fetched_models(&self, ids: Vec<String>, api_base: &str) -> Result<(), AppError> {
        let _guard = self.lock.lock().unwrap();
        self.merge_locked(ids, api_base)
    }

    fn merge_locked(&self, ids: Vec<String>, api_base: &str) -> Result<(), AppError> {
        let mut settings = self.load()?;
        let api_base = api_base.trim().trim_end_matches('/');
        let api_base_changed =
            !api_base.is_empty() && settings.api_base.as_deref() != Some(api_base);
        if api_base_changed {
            settings.api_base = Some(api_base.to_owned());
        }
        let mut merged: Vec<SavedModel> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for id in ids.iter().map(|id| id.trim()).filter(|id| !id.is_empty()) {
            if !seen.insert(id.to_owned()) {
                continue;
            }
            match settings.models.iter().find(|m| m.model.id == id) {
                Some(existing) => merged.push(existing.clone()),
                None => merged.push(SavedModel {
                    model: Model {
                        id: id.to_owned(),
                        ..Default::default()
                    },
                    selected: false,
                }),
            }
        }
        // 已勾选但网关这次没返回的模型保留，避免一次网络抖动丢掉选择
        for model in &settings.models {
            if model.selected && !seen.contains(&model.model.id) {
                merged.push(model.clone());
            }
        }
        settings.models = merged;
        self.save(&settings)?;
        if api_base_changed && self.enabled(&settings) {
            self.install_router(&settings)?;
        }
        Ok(())
    }

    /// 保存勾选的模型；已启用时同时重写合并目录和路由清单
    pub fn set_models(&self, selected: Vec<Model>) -> Result<(), AppError> {
        let _guard = self.lock.lock().unwrap();
        let mut settings = self.load()?;
        let mut chosen: Vec<Model> = Vec::new();
        for mut model in selected {
            model.id = model.id.trim().to_owned();
            if !model.id.is_empty() && !chosen.iter().any(|m| m.id == model.id) {
                chosen.push(model);
            }
        }
        let mut next: Vec<SavedModel> = Vec::new();
        for existing in &settings.models {
            match chosen.iter().find(|m| m.id == existing.model.id) {
                Some(pick) => {
                    let mut pick = pick.clone();
                    if pick
                        .display_name
                        .as_deref()
                        .map_or(true, |n| n.trim().is_empty())
                    {
                        pick.display_name = existing.model.display_name.clone();
                    }
                    next.push(SavedModel {
                        model: pick,
                        selected: true,
                    });
                }
                None => next.push(SavedModel {
                    selected: false,
                    ..existing.clone()
                }),
            }
        }
        for pick in &chosen {
            if !settings.models.iter().any(|m| m.model.id == pick.id) {
                next.push(SavedModel {
                    model: pick.clone(),
                    selected: true,
                });
            }
        }
        settings.models = next;
        if !self.enabled(&settings) {
            return self.save(&settings);
        }
        if settings.selected().is_empty() {
            return Err(AppError::new(
                "invalid",
                "已启用时至少要保留一个模型；如需全部移除请先恢复",
            ));
        }
        self.write_catalogs(&mut settings)?;
        // 被取消的模型若正是 Codex 当前的默认模型，改回启用前的值
        let active: Vec<String> = settings.selected().iter().map(Model::slug).collect();
        let retired: Vec<String> = settings
            .published_slugs
            .iter()
            .filter(|s| !active.contains(s))
            .cloned()
            .collect();
        let snapshot = self.read_config()?;
        let updated = reset_default_model(&snapshot.text, &settings, &retired);
        self.write_config(&snapshot, &updated)?;
        self.save(&settings)
    }

    /// 先让路由常驻并确认健康，再写 Codex 设置
    pub fn enable(&self) -> Result<(), AppError> {
        let _guard = self.lock.lock().unwrap();
        let mut settings = self.load()?;
        if settings.base_url.is_empty() {
            return Err(AppError::new("invalid", "还没有填写网关地址"));
        }
        if (self.deps.get_key)().map_or(true, |k| k.trim().is_empty()) {
            return Err(AppError::new("invalid", "还没有保存密钥"));
        }
        if settings.selected().is_empty() {
            return Err(AppError::new("invalid", "还没有勾选任何模型"));
        }
        let first = self.read_config()?;
        if self.detect_agents_manager(&first.text).is_some() {
            return Err(AppError::new(
                "conflict",
                "本机当前由 agents-manager 启用，请先在本页点「接管」",
            ));
        }
        let managed = self.managed(&settings);
        // 先在内存里试一次：有冲突或设置不合法，就在产生任何副作用之前退出
        let trial = config::apply(&first.text, &managed).map_err(config_error)?;
        if trial.changed {
            // 记住启用前的默认模型：Codex 会把用户选中的模型写回设置，恢复时要能改回来
            let current = config::root_string(&first.text, "model");
            let ours = current.as_ref().is_some_and(|m| {
                settings
                    .published_slugs
                    .iter()
                    .any(|s| s.eq_ignore_ascii_case(m))
            });
            if !ours {
                settings.had_prev_model = current.is_some();
                settings.prev_model = current;
            }
        }
        self.write_catalogs(&mut settings)?;
        self.install_router(&settings)?;
        // 装服务、等路由就绪要花几秒，这期间别人可能改过设置：基于最新内容重新生成，绝不拿旧内容覆盖
        let latest = self.read_config()?;
        let applied = config::apply(&latest.text, &managed).map_err(config_error)?;
        if applied.changed {
            self.write_config(&latest, &applied.text)?;
            settings.added_newline = applied.added_newline;
            settings.changed_at = Some((self.deps.now)());
        }
        self.save(&settings)
    }

    fn install_router(&self, settings: &GatewaySettings) -> Result<(), AppError> {
        let binary = self.binary_path();
        let binary_changed = (self.deps.install_binary)(&binary)
            .map_err(|e| internal(format!("安装后台程序失败: {e}")))?;
        let log_dir = self.log_dir();
        std::fs::create_dir_all(&log_dir).map_err(internal)?;
        let spec = service::Spec {
            label: SERVICE_LABEL.to_owned(),
            program: binary.to_string_lossy().into_owned(),
            args: [
                "gateway",
                "run",
                "--port",
                &settings.port.to_string(),
                "--third-party-url",
                settings.upstream_base(),
                "--routing-catalog",
                &self.routing_path().to_string_lossy(),
                "--log",
                &log_dir.join("router.log").to_string_lossy(),
                "--protocol",
                settings.protocol(),
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            log_path: Some(log_dir.join("service.log").to_string_lossy().into_owned()),
            env: Default::default(),
        };
        let was_loaded = (self.deps.service_status)(SERVICE_LABEL)
            .map(|s| s.loaded)
            .unwrap_or(false);
        (self.deps.service_install)(&spec)
            .map_err(|e| AppError::new("router_down", format!("安装路由后台服务失败: {e}")))?;
        if binary_changed && was_loaded {
            // 程序文件换了，让已在运行的后台服务重启以用上新版本
            (self.deps.service_restart)(SERVICE_LABEL)
                .map_err(|e| AppError::new("router_down", format!("重启路由后台服务失败: {e}")))?;
        }
        (self.deps.router_healthy)(settings.port).map_err(|e| {
            AppError::new(
                "router_down",
                format!(
                    "路由没有在端口 {} 上就绪（端口可能被占用）: {e}。Codex 设置未改动",
                    settings.port
                ),
            )
        })
    }

    fn write_catalogs(&self, settings: &mut GatewaySettings) -> Result<(), AppError> {
        let before = std::fs::read(self.catalog_path()).ok();
        let native = catalog::load_native(&self.deps.codex_home, || (self.deps.bundled)())
            .map_err(internal)?;
        let models = settings.selected();
        for slug in models.iter().map(Model::slug) {
            if !settings.published_slugs.contains(&slug) {
                settings.published_slugs.push(slug);
            }
        }
        let combined = catalog::build_combined(&native.models, &models)
            .map_err(|e| AppError::new("invalid", e))?;
        let routing = catalog::build_routing(&models, &settings.published_slugs)
            .map_err(|e| AppError::new("invalid", e))?;
        // 先写路由清单再写合并目录：选择器里出现的模型必须已经能被路由识别
        self.write_own_file(&self.routing_path(), &routing)?;
        self.write_own_file(&self.catalog_path(), &combined)?;
        // 模型目录只在 Codex 启动时加载：只有它真的变了，才需要提示重启
        if before.as_deref() != Some(combined.as_slice()) {
            settings.changed_at = Some((self.deps.now)());
        }
        // 记录的版本必须和状态里比较用的是同一个来源，否则会误报漂移
        let version = (self.deps.codex_version)();
        settings.catalog_client_version = if version.is_empty() {
            native.client_version
        } else {
            version
        };
        Ok(())
    }

    fn write_own_file(&self, path: &Path, bytes: &[u8]) -> Result<(), AppError> {
        let state = atomicfile::read_state(path)
            .map_err(|_| internal(format!("{} 不可读", path.display())))?;
        if matches!(&state, FileState::Present(existing) if existing.bytes == bytes) {
            return Ok(());
        }
        atomicfile::atomic_write(path, bytes, &state)
            .map_err(|e| internal(format!("写入 {} 失败: {e}", path.display())))
    }

    /// 从 Codex 设置里移除本功能的两项，清理本功能文件并卸载后台服务。路由不通时也可用
    pub fn restore(&self) -> Result<Vec<String>, AppError> {
        let _guard = self.lock.lock().unwrap();
        let mut settings = self.load()?;
        let managed = self.managed(&settings);
        let snapshot = self.read_config()?;
        let reset = reset_default_model(&snapshot.text, &settings, &settings.published_slugs);
        let removed =
            config::remove(&reset, &managed, settings.added_newline).map_err(config_error)?;
        let mut warnings = removed.warnings.clone();
        self.write_config(&snapshot, &removed.text)?;
        // 设置已经不再指向路由之后，才拆路由和目录文件。没移除干净就停在这里：
        // 此时拆掉路由，Codex 会指向一个不存在的地址，官方模型也用不了
        let still_pointing =
            config::inspect(&removed.text, &managed).is_ok_and(|i| i.points_at_router);
        if still_pointing {
            return Err(AppError::new("conflict", format!("Codex 设置里仍有指向本机路由的项没能自动移除（{}）。路由已保留，请手动删除后再恢复", warnings.join("；"))));
        }
        if let Err(e) = (self.deps.service_uninstall)(SERVICE_LABEL) {
            warnings.push(format!("卸载路由后台服务失败: {e}"));
        }
        // 只删 Codex 目录下本功能前缀的文件；数据目录里还有 settings.json 等，不碰
        if let Ok(entries) = std::fs::read_dir(&self.deps.codex_home) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let is_file = entry.file_type().is_ok_and(|t| t.is_file());
                if is_file && name.starts_with(OWN_FILE_PREFIX) {
                    if let Err(e) = std::fs::remove_file(entry.path()) {
                        warnings.push(format!("删除 {name} 失败: {e}"));
                    }
                }
            }
        }
        settings.added_newline = false;
        settings.catalog_client_version.clear();
        settings.published_slugs.clear();
        settings.prev_model = None;
        settings.had_prev_model = false;
        settings.changed_at = Some((self.deps.now)());
        self.save(&settings)?;
        Ok(warnings)
    }

    /// 接管 agents-manager 的现有配置：地址、模型、显示名、密钥、启用前默认模型原样带过来
    pub fn takeover(&self) -> Result<(), AppError> {
        let _guard = self.lock.lock().unwrap();
        let first = self.read_config()?;
        let detected = self
            .detect_agents_manager(&first.text)
            .ok_or_else(|| AppError::new("invalid", "没有检测到由 agents-manager 启用的配置"))?;
        let old = takeover::read_state(&self.deps.agents_manager_dir).map_err(|e| {
            AppError::new("invalid", format!("读取 agents-manager 的状态失败: {e}"))
        })?;
        let key = (self.deps.get_agents_manager_key)().map_err(|e| {
            AppError::new("invalid", format!("读取 agents-manager 的密钥失败: {e}"))
        })?;

        let mut settings = self.load()?;
        settings.base_url = clean_base_url(&old.base_url)?;
        settings.api_base = Some(old.api_base.trim().to_owned()).filter(|b| !b.is_empty());
        settings.protocol = if old.protocol == "responses" {
            "responses".into()
        } else {
            "chat".into()
        };
        settings.models = old
            .models
            .iter()
            .map(|m| SavedModel {
                model: Model {
                    id: m.id.clone(),
                    display_name: Some(m.display_name.trim().to_owned()).filter(|n| !n.is_empty()),
                    ..Default::default()
                },
                selected: m.selected,
            })
            .collect();
        settings.prev_model = Some(old.prev_model.clone()).filter(|_| old.had_prev_model);
        settings.had_prev_model = old.had_prev_model;
        settings.published_slugs = old.published_slugs.clone();
        if settings.selected().is_empty() {
            return Err(AppError::new(
                "invalid",
                "agents-manager 里没有选中的模型，无法接管",
            ));
        }
        (self.deps.set_key)(key.trim()).map_err(|e| AppError::new("invalid", e))?;

        // 先把本功能的目录和路由准备好并确认健康；这一步失败时对方仍然完好
        self.write_catalogs(&mut settings)?;
        self.install_router(&settings)?;

        // 一次原子写：移除对方的两个键，写入本功能的两个键
        let latest = self.read_config()?;
        let old_catalog = config::root_string(&latest.text, config::KEY_CATALOG)
            .filter(|path| path.ends_with(&detected.catalog_file_name))
            .ok_or_else(|| {
                AppError::new(
                    "changed",
                    "Codex 设置在接管期间被改动了，未做任何覆盖，请重试",
                )
            })?;
        let old_managed = Managed {
            catalog_path: old_catalog,
            base_url: takeover::ROUTER_BASE_URL.to_owned(),
        };
        let removed = config::remove(&latest.text, &old_managed, false).map_err(config_error)?;
        if !removed.warnings.is_empty() {
            return Err(AppError::new(
                "conflict",
                format!(
                    "没能移除 agents-manager 写入的项：{}",
                    removed.warnings.join("；")
                ),
            ));
        }
        let applied =
            config::apply(&removed.text, &self.managed(&settings)).map_err(config_error)?;
        self.write_config(&latest, &applied.text)?;
        settings.added_newline = applied.added_newline;
        settings.changed_at = Some((self.deps.now)());
        self.save(&settings)?;

        // 设置已经指向本功能之后，才撤下对方的后台服务和它放在 Codex 目录下的文件；它的数据目录和钥匙串条目保留
        let _ = (self.deps.service_uninstall)(takeover::LAUNCH_AGENT_LABEL);
        if let Ok(entries) = std::fs::read_dir(&self.deps.codex_home) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if entry.file_type().is_ok_and(|t| t.is_file())
                    && takeover::is_owned_file_name(&name)
                {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        Ok(())
    }

    pub fn state(&self) -> GatewayState {
        let _guard = self.lock.lock().unwrap();
        let settings = self.load().unwrap_or_default();
        let mut view = GatewayState {
            supported: true,
            ..Default::default()
        };
        view.provider.base_url = settings.base_url.clone();
        view.provider.has_key = (self.deps.get_key)().is_ok_and(|k| !k.trim().is_empty());
        view.provider.models = settings
            .models
            .iter()
            .map(|m| ModelView {
                id: m.model.id.clone(),
                slug: m.model.slug(),
                display_name: m
                    .model
                    .display_name
                    .clone()
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| m.model.id.clone()),
                selected: m.selected,
            })
            .collect();

        match self.read_config() {
            Ok(snapshot) => {
                if let Some(_detected) = self.detect_agents_manager(&snapshot.text) {
                    let old = takeover::read_state(&self.deps.agents_manager_dir).ok();
                    view.takeover = Some(TakeoverOffer {
                        base_url: old.as_ref().map(|s| s.base_url.clone()).unwrap_or_default(),
                        selected_count: old
                            .as_ref()
                            .map_or(0, |s| s.models.iter().filter(|m| m.selected).count()),
                    });
                } else {
                    match config::inspect(&snapshot.text, &self.managed(&settings)) {
                        Ok(inspection) => {
                            view.enabled = inspection.enabled;
                            view.conflict = inspection.conflict.unwrap_or_default();
                        }
                        Err(e) => view.conflict = e.to_string(),
                    }
                }
            }
            Err(e) => view.conflict = e.message,
        }

        view.router.port = settings.port;
        view.router.installed =
            (self.deps.service_status)(SERVICE_LABEL).is_ok_and(|s| s.installed);
        if view.enabled || view.router.installed {
            match (self.deps.router_healthy)(settings.port) {
                Ok(()) => view.router.running = true,
                Err(e) if view.enabled => {
                    view.router.error = format!("Codex 设置指向本机路由，但路由在端口 {} 上没有响应：{e}。此时官方模型也无法使用，可以点「恢复」。", settings.port)
                }
                Err(_) => {}
            }
        }

        view.codex.version = (self.deps.codex_version)();
        view.codex.catalog_version = settings.catalog_client_version.clone();
        view.codex.drift = view.enabled
            && !settings.catalog_client_version.is_empty()
            && !view.codex.version.is_empty()
            && settings.catalog_client_version != view.codex.version;
        if let Some(started_at) = (self.deps.codex_started_at)() {
            view.codex.running = true;
            view.needs_codex_restart = settings
                .changed_at
                .is_some_and(|changed_at| started_at < changed_at);
        }
        view
    }
}

/// Codex 的默认模型若是 `invalid` 里的某个第三方标识，改回启用前的值（原来没有就删掉这一行）
fn reset_default_model(text: &str, settings: &GatewaySettings, invalid: &[String]) -> String {
    let Some(current) = config::root_string(text, "model") else {
        return text.to_owned();
    };
    if !invalid
        .iter()
        .any(|slug| slug.eq_ignore_ascii_case(current.trim()))
    {
        return text.to_owned();
    }
    let previous = if settings.had_prev_model {
        settings.prev_model.as_deref()
    } else {
        None
    };
    config::replace_root_string(text, "model", previous).unwrap_or_else(|| text.to_owned())
}
