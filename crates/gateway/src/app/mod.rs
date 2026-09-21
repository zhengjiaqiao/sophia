//! 把各模块串成“保存网关 / 选模型 / 启用 / 恢复 / 接管 / 查看状态”这几个动作，界面和命令行共用。
//! 行为移植自 agents-manager 的 `internal/app`（Go，已在真实环境验证）。
#[cfg(test)]
mod tests;

use crate::process::{self, RestartReport};
use crate::{service, takeover};
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use symsync_core::atomicfile::{self, FileState};
use symsync_core::codex_models::catalog::{self, Model};
use symsync_core::codex_models::config::{self, ConfigError, Managed};
use symsync_core::codex_models::settings::{self, GatewaySettings, ProviderSettings, SavedModel};

pub const SERVICE_LABEL: &str = "com.zhengjiaqiao.symsync.gateway";
/// 本功能放在 Codex 目录下的文件统一用这个前缀，恢复时据此精确清理
pub const OWN_FILE_PREFIX: &str = "symsync-";
const CATALOG_FILE: &str = "symsync-models.json";
const ROUTING_FILE: &str = "symsync-routing.json";
/// 备份后缀：`config.models.bak`，与 MCP 的 `config.mcp.bak` 不撞名
const BACKUP_SUFFIX: &str = "models";
/// 接管 agents-manager 时生成的那一家网关的首选 id 与名字（对方只接了 wecode 这一家）；
/// 实际 id 见 `takeover_provider_id`
pub const TAKEOVER_PROVIDER_ID: &str = "wecode";

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
/// 参数按引用传入的操作
type RefOp<A, R> = Box<dyn for<'a> Fn(&'a A) -> R + Send + Sync>;
type StrOp<R> = Box<dyn Fn(&str) -> R + Send + Sync>;
type PathOp<R> = Box<dyn Fn(&Path) -> R + Send + Sync>;
type KeyWrite = Box<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>;

/// 对外部世界的全部依赖，测试里全部替换成假的
pub struct Deps {
    pub codex_home: PathBuf,
    /// SymSync 的数据目录；后台程序副本放在它的 `bin/` 下。同目录还有 settings.json 等，清理时不能碰
    pub data_dir: PathBuf,
    /// agents-manager 的数据目录（`~/.agents-manager`），只读
    pub agents_manager_dir: PathBuf,
    pub load_settings: Get<io::Result<GatewaySettings>>,
    pub save_settings: RefOp<GatewaySettings, io::Result<()>>,
    pub service_install: RefOp<service::Spec, io::Result<()>>,
    pub service_uninstall: StrOp<io::Result<()>>,
    pub service_status: StrOp<io::Result<service::Status>>,
    pub service_restart: StrOp<io::Result<()>>,
    /// 在端口上确认本功能的路由已就绪（内部自带等待）
    pub router_healthy: Op<u16, Result<(), String>>,
    /// 运行 `codex debug models --bundled`
    pub bundled: Get<io::Result<Vec<u8>>>,
    /// 按网关 id 读密钥
    pub get_key: StrOp<Result<String, String>>,
    /// 按网关 id 写密钥：`(id, key)`
    pub set_key: KeyWrite,
    /// 按网关 id 删密钥；本来就没有不算错
    pub delete_key: StrOp<Result<(), String>>,
    pub get_agents_manager_key: Get<Result<String, String>>,
    /// 把当前可执行文件复制到稳定路径；返回副本是否被更新
    pub install_binary: PathOp<io::Result<bool>>,
    /// 当前进程表（pid + 完整命令行）
    pub list_processes: Get<io::Result<Vec<process::ProcessInfo>>>,
    /// 向进程发 SIGTERM
    pub terminate: Op<u32, io::Result<()>>,
    /// Codex 桌面应用主进程的启动时间（unix 秒）；没在运行为 None
    pub codex_started_at: Get<Option<u64>>,
    pub codex_version: Get<String>,
    pub now: Get<u64>,
}

pub struct App {
    deps: Deps,
    /// 同一进程里的动作串行执行。某个动作 panic 之后锁会被标记为中毒，
    /// 但它保护的是磁盘上的文件、不是内存里的不变量，所以继续用，不让整个功能瘫掉。
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
    /// 创建后不变；新命令用它指明操作哪一家
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// "chat" 或 "responses"
    pub protocol: String,
    pub has_key: bool,
    pub models: Vec<ModelView>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterView {
    pub installed: bool,
    pub running: bool,
    pub port: u16,
    /// 网关支持的协议："chat" 或 "responses"。界面只读展示，不给改
    pub protocol: String,
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
    /// 第一家网关，给还没迁到 `providers` 的旧界面用；一家都没有时是空的
    pub provider: ProviderView,
    /// 全部网关，按用户添加的顺序
    pub providers: Vec<ProviderView>,
    pub enabled: bool,
    pub needs_codex_restart: bool,
    pub router: RouterView,
    pub codex: CodexView,
    pub conflict: String,
    pub takeover: Option<TakeoverOffer>,
}

/// 合并目录内容的指纹：只用来判断「Codex 加载到的目录和现在的是不是同一份」
fn fingerprint(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
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
    //
    // 每个动作都有按网关 id 操作的版本；不带 id 的旧版本作用在第一家上（没有就新建一家），
    // 给还没迁到多网关的界面用。

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 旧命令作用的那一家：第一家；一家都没有时返回 None，由调用方决定要不要新建
    fn first_provider_id(&self) -> Result<Option<String>, AppError> {
        Ok(self.load()?.providers.first().map(|p| p.id.clone()))
    }

    /// 保存网关地址。密钥由 `commit_verified_provider` 或调用方另行写入钥匙串
    pub fn save_provider(&self, base_url: &str) -> Result<(), AppError> {
        let _guard = self.guard();
        let id = self.first_provider_id()?;
        self.upsert_locked(id.as_deref(), None, base_url)
            .map(|_| ())
    }

    /// 新建或修改一家网关，返回它的 id。`id` 为 None 是新建：id 由名称生成，之后不变。
    /// `name` 为 None 表示不改名（新建时用地址里的主机名）。
    pub fn upsert_provider(
        &self,
        id: Option<&str>,
        name: Option<&str>,
        base_url: &str,
    ) -> Result<String, AppError> {
        let _guard = self.guard();
        self.upsert_locked(id, name, base_url)
    }

    fn upsert_locked(
        &self,
        id: Option<&str>,
        name: Option<&str>,
        base_url: &str,
    ) -> Result<String, AppError> {
        let cleaned = clean_base_url(base_url)?;
        let name = name.map(str::trim).filter(|name| !name.is_empty());
        let mut settings = self.load()?;
        let (id, changed) = match id {
            Some(id) => {
                let provider = settings
                    .provider_mut(id)
                    .ok_or_else(|| unknown_provider(id))?;
                let changed = provider.base_url != cleaned;
                provider.base_url = cleaned;
                if changed {
                    provider.api_base = None; // 旧地址探明的接口基址作废
                }
                if let Some(name) = name {
                    provider.name = name.to_owned();
                }
                (id.to_owned(), changed)
            }
            None => {
                let name = name.map(str::to_owned).unwrap_or_else(|| host_of(&cleaned));
                let taken: Vec<&str> = settings.providers.iter().map(|p| p.id.as_str()).collect();
                let id = settings::new_provider_id(&name, &taken);
                settings.providers.push(ProviderSettings {
                    id: id.clone(),
                    name,
                    base_url: cleaned,
                    ..ProviderSettings::default()
                });
                (id, false)
            }
        };
        let publishes = settings.published().iter().any(|p| p.provider == id);
        if changed && publishes && self.enabled(&settings) {
            // 上游地址写在路由清单里：地址变了，重写清单即可，路由每个请求都会重读
            self.republish(&mut settings)?;
        }
        self.save(&settings)?;
        Ok(id)
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
        let _guard = self.guard();
        let id = self.first_provider_id()?;
        self.commit_locked(id.as_deref(), None, base_url, key, ids, api_base)
            .map(|_| ())
    }

    /// `commit_verified_provider` 的多网关版本，返回这一家的 id
    pub fn commit_verified_provider_for(
        &self,
        id: Option<&str>,
        name: Option<&str>,
        base_url: &str,
        key: &str,
        ids: Vec<String>,
        api_base: &str,
    ) -> Result<String, AppError> {
        let _guard = self.guard();
        self.commit_locked(id, name, base_url, key, ids, api_base)
    }

    fn commit_locked(
        &self,
        id: Option<&str>,
        name: Option<&str>,
        base_url: &str,
        key: &str,
        ids: Vec<String>,
        api_base: &str,
    ) -> Result<String, AppError> {
        let key = key.trim();
        if key.is_empty() {
            return Err(AppError::new("invalid", "密钥为空"));
        }
        clean_base_url(base_url)?;
        let id = match id {
            Some(id) => {
                // 已有的网关：先确认它存在，再写密钥，最后才改地址——密钥没存成时地址保持原样
                self.load()?
                    .provider(id)
                    .ok_or_else(|| unknown_provider(id))?;
                (self.deps.set_key)(id, key).map_err(|e| AppError::new("invalid", e))?;
                self.upsert_locked(Some(id), name, base_url)?
            }
            None => {
                // 新建的网关要先有 id 才有钥匙串账户；密钥没存成就把刚建的这一家撤掉，
                // 免得界面上多出一张没法用的卡片
                let id = self.upsert_locked(None, name, base_url)?;
                if let Err(error) = (self.deps.set_key)(&id, key) {
                    let mut settings = self.load()?;
                    settings.providers.retain(|p| p.id != id);
                    self.save(&settings)?;
                    return Err(AppError::new("invalid", error));
                }
                id
            }
        };
        self.merge_locked(&id, ids, api_base)?;
        Ok(id)
    }

    /// 拉取模型列表要用的地址和密钥；任一缺失则报错，不联网
    pub fn provider_for_fetch(&self) -> Result<(String, String), AppError> {
        let id = self
            .first_provider_id()?
            .ok_or_else(|| AppError::new("invalid", "还没有填写网关地址"))?;
        self.provider_for_fetch_of(&id)
    }

    pub fn provider_for_fetch_of(&self, id: &str) -> Result<(String, String), AppError> {
        let settings = self.load()?;
        let provider = settings.provider(id).ok_or_else(|| unknown_provider(id))?;
        if provider.base_url.is_empty() {
            return Err(AppError::new("invalid", "还没有填写网关地址"));
        }
        let key = (self.deps.get_key)(id)
            .ok()
            .filter(|k| !k.trim().is_empty());
        let key = key.ok_or_else(|| AppError::new("invalid", "还没有保存密钥"))?;
        Ok((provider.base_url.clone(), key))
    }

    /// 把网关返回的模型列表并入已保存的列表，保留原有的勾选和显示名
    pub fn merge_fetched_models(&self, ids: Vec<String>, api_base: &str) -> Result<(), AppError> {
        let _guard = self.guard();
        let id = self
            .first_provider_id()?
            .ok_or_else(|| AppError::new("invalid", "还没有填写网关地址"))?;
        self.merge_locked(&id, ids, api_base)
    }

    pub fn merge_fetched_models_for(
        &self,
        id: &str,
        ids: Vec<String>,
        api_base: &str,
    ) -> Result<(), AppError> {
        let _guard = self.guard();
        self.merge_locked(id, ids, api_base)
    }

    fn merge_locked(&self, id: &str, ids: Vec<String>, api_base: &str) -> Result<(), AppError> {
        let mut settings = self.load()?;
        let provider = settings
            .provider_mut(id)
            .ok_or_else(|| unknown_provider(id))?;
        let api_base = api_base.trim().trim_end_matches('/');
        let api_base_changed =
            !api_base.is_empty() && provider.api_base.as_deref() != Some(api_base);
        if api_base_changed {
            provider.api_base = Some(api_base.to_owned());
        }
        let mut merged: Vec<SavedModel> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for id in ids.iter().map(|id| id.trim()).filter(|id| !id.is_empty()) {
            if !seen.insert(id.to_owned()) {
                continue;
            }
            match provider.models.iter().find(|m| m.model.id == id) {
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
        for model in &provider.models {
            if model.selected && !seen.contains(&model.model.id) {
                merged.push(model.clone());
            }
        }
        provider.models = merged;
        let publishes = settings.published().iter().any(|p| p.provider == id);
        if api_base_changed && publishes && self.enabled(&settings) {
            self.republish(&mut settings)?;
        }
        self.save(&settings)
    }

    /// 保存勾选的模型；已启用时同时重写合并目录和路由清单
    pub fn set_models(&self, selected: Vec<Model>) -> Result<(), AppError> {
        let _guard = self.guard();
        let id = self
            .first_provider_id()?
            .ok_or_else(|| AppError::new("invalid", "还没有填写网关地址"))?;
        self.set_models_locked(&id, selected)
    }

    pub fn set_models_for(&self, id: &str, selected: Vec<Model>) -> Result<(), AppError> {
        let _guard = self.guard();
        self.set_models_locked(id, selected)
    }

    fn set_models_locked(&self, id: &str, selected: Vec<Model>) -> Result<(), AppError> {
        let mut settings = self.load()?;
        let provider = settings
            .provider_mut(id)
            .ok_or_else(|| unknown_provider(id))?;
        let mut chosen: Vec<Model> = Vec::new();
        for mut model in selected {
            model.id = model.id.trim().to_owned();
            if !model.id.is_empty() && !chosen.iter().any(|m| m.id == model.id) {
                chosen.push(model);
            }
        }
        let mut next: Vec<SavedModel> = Vec::new();
        for existing in &provider.models {
            match chosen.iter().find(|m| m.id == existing.model.id) {
                Some(pick) => {
                    let mut pick = pick.clone();
                    if pick
                        .display_name
                        .as_deref()
                        .is_none_or(|n| n.trim().is_empty())
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
            if !provider.models.iter().any(|m| m.model.id == pick.id) {
                next.push(SavedModel {
                    model: pick.clone(),
                    selected: true,
                });
            }
        }
        provider.models = next;
        if self.enabled(&settings) {
            self.republish(&mut settings)?;
        }
        self.save(&settings)
    }

    /// 删掉一家网关：它的模型、地址和钥匙串里的密钥。已启用时同步重写目录。
    /// 钥匙串条目删了就回不来，界面负责在调用前向用户确认。
    pub fn remove_provider(&self, id: &str) -> Result<(), AppError> {
        let _guard = self.guard();
        let mut settings = self.load()?;
        if settings.provider(id).is_none() {
            return Err(unknown_provider(id));
        }
        let published_here = settings.published().iter().any(|p| p.provider == id);
        settings.providers.retain(|p| p.id != id);
        if published_here && self.enabled(&settings) {
            self.republish(&mut settings)?;
        }
        self.save(&settings)?;
        // 设置已经不再引用这一家之后才删密钥：中途失败时，留下一个没人用的密钥好过留下一家没密钥的网关
        (self.deps.delete_key)(id)
            .map_err(|e| AppError::new("internal", format!("网关已删除，但清除它的密钥失败: {e}")))
    }

    /// 已启用时，勾选或上游变了：让 Codex 目录下的两份清单跟上。
    /// 先确保后台的路由程序是当前版本，再写清单——旧版路由不认清单里的归属，
    /// 会把所有第三方模型都发给启动参数里的那一家，第二家的请求内容就发错了地方。
    fn republish(&self, settings: &mut GatewaySettings) -> Result<(), AppError> {
        if settings.published().is_empty() {
            return Err(AppError::new(
                "invalid",
                "已启用时至少要保留一个模型；如需全部移除请先恢复",
            ));
        }
        self.install_router(settings)?;
        self.write_catalogs(settings)?;
        // 被取消的模型若正是 Codex 当前的默认模型，改回启用前的值
        let retired = retired_slugs(settings);
        let snapshot = self.read_config()?;
        let updated = reset_default_model(&snapshot.text, settings, &retired);
        self.write_config(&snapshot, &updated)
    }

    /// 先让路由常驻并确认健康，再写 Codex 设置
    pub fn enable(&self) -> Result<(), AppError> {
        let _guard = self.guard();
        let mut settings = self.load()?;
        if settings.providers.iter().all(|p| p.base_url.is_empty()) {
            return Err(AppError::new("invalid", "还没有填写网关地址"));
        }
        if settings.published().is_empty() {
            return Err(AppError::new("invalid", "还没有勾选任何模型"));
        }
        // 只检查有模型要发布的网关：没勾选任何模型的那几家不影响启用
        for provider in &settings.providers {
            if provider.selected().is_empty() {
                continue;
            }
            if provider.base_url.is_empty() {
                return Err(AppError::new(
                    "invalid",
                    format!("网关「{}」还没有填写地址", provider.name),
                ));
            }
            if (self.deps.get_key)(&provider.id).map_or(true, |k| k.trim().is_empty()) {
                return Err(AppError::new(
                    "invalid",
                    if settings.providers.len() == 1 {
                        "还没有保存密钥".to_owned()
                    } else {
                        format!("网关「{}」还没有保存密钥", provider.name)
                    },
                ));
            }
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
        // 先确保后台路由是当前版本，再写清单，理由同 `republish`：升级后第一次点启用时旧版路由还在跑
        self.install_router(&settings)?;
        self.write_catalogs(&mut settings)?;
        // 装服务、等路由就绪要花几秒，这期间别人可能改过设置：基于最新内容重新生成，绝不拿旧内容覆盖
        let latest = self.read_config()?;
        let applied = config::apply(&latest.text, &managed).map_err(config_error)?;
        // 已启用时再点启用也会走到这里：默认模型若指向一个已经不在目录里的标识
        // （比如旧的单网关格式迁移后标识带上了前缀），一并改回启用前的值
        let text = reset_default_model(&applied.text, &settings, &retired_slugs(&settings));
        if text != latest.text {
            self.write_config(&latest, &text)?;
        }
        if applied.changed {
            settings.added_newline = applied.added_newline;
            settings.changed_at = Some((self.deps.now)());
        }
        settings.record_change((self.deps.now)(), true);
        self.save(&settings)
    }

    /// 预热：把程序副本更新到位；后台服务正开着且程序变了，就让它换上新版本。返回副本是否被更新过。
    ///
    /// 这一步原本只在启用时做。但新程序文件第一次运行要过系统校验，实测会让启用卡上好几秒，
    /// 甚至撞上就绪等待的上限而失败。所以应用启动时在后台先做掉；启用时只剩「装服务、等就绪」。
    /// 不碰 Codex 的设置，也不安装后台服务。
    pub fn prewarm(&self) -> Result<bool, AppError> {
        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let changed = (self.deps.install_binary)(&self.binary_path())
            .map_err(|e| internal(format!("安装后台程序失败: {e}")))?;
        let loaded = (self.deps.service_status)(SERVICE_LABEL)
            .map(|s| s.loaded)
            .unwrap_or(false);
        // 已知的、可接受的窗口：此刻正好在走路由的那一个请求会断（重启是几百毫秒的事，
        // 只在应用更新后的第一次启动出现一次）。不为此加活跃连接计数，见 docs/specs/2026-09-21-tray.md「修订」
        if changed && loaded {
            (self.deps.service_restart)(SERVICE_LABEL)
                .map_err(|e| AppError::new("router_down", format!("重启路由后台服务失败: {e}")))?;
        }
        Ok(changed)
    }

    /// 程序副本的路径；预热之后调用方拿它空跑一次，让系统把首次校验做掉
    pub fn router_binary(&self) -> PathBuf {
        self.binary_path()
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
                // 上游地址和协议不在启动参数里：它们写在路由清单里，路由每个请求重读，
                // 增删网关、改地址都不用重装后台服务
                "--routing-catalog",
                &self.routing_path().to_string_lossy(),
                "--log",
                &log_dir.join("router.log").to_string_lossy(),
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
        let models = settings.published();
        for published in &models {
            if !settings.published_slugs.contains(&published.slug) {
                settings.published_slugs.push(published.slug.clone());
            }
        }
        let combined = catalog::build_combined(&native.models, &models)
            .map_err(|e| AppError::new("invalid", e))?;
        let routing = catalog::build_routing(
            &models,
            &settings.routing_providers(),
            &settings.published_slugs,
        )
        .map_err(|e| AppError::new("invalid", e))?;
        // 先写路由清单再写合并目录：选择器里出现的模型必须已经能被路由识别
        self.write_own_file(&self.routing_path(), &routing)?;
        self.write_own_file(&self.catalog_path(), &combined)?;
        // 模型目录只在 Codex 启动时加载：只有它真的变了，才需要提示重启
        if before.as_deref() != Some(combined.as_slice()) {
            settings.changed_at = Some((self.deps.now)());
        }
        settings.catalog_fingerprint = fingerprint(&combined);
        if self.enabled(settings) {
            settings.record_change((self.deps.now)(), true);
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
        let _guard = self.guard();
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
        // published_slugs 不清：没重启过的 Codex 选择器里旧模型还在，下次启用时它们仍要进停用名单
        settings.prev_model = None;
        settings.had_prev_model = false;
        settings.changed_at = Some((self.deps.now)());
        settings.record_change((self.deps.now)(), false);
        self.save(&settings)?;
        Ok(warnings)
    }

    /// 重启我们自己装的 launchd 路由服务（`launchctl kickstart -k`）。
    ///
    /// **只重启路由，不碰 Codex**：Codex 是用户的编辑器 / CLI，我们无权重启它。
    /// 不读写 `~/.codex/config.toml`，也不改 settings.json，所以不取 `self.lock`。
    /// 失败时把 `launchctl` 的原话原样带出去——那是运维信息，用户要拿它去查。
    pub fn restart_router(&self) -> Result<(), AppError> {
        (self.deps.service_restart)(SERVICE_LABEL)
            .map_err(|e| AppError::new("router_down", e.to_string()))
    }

    /// 结束 Codex 的后台进程（SIGTERM）：`codex app-server` 与 `codex-code-mode-host`。
    /// 它们启动时读一次 `~/.codex/config.toml`，之后不重读，所以改完配置要让它们重起。
    /// 下次任何工具拉起 Codex 时会带着新配置起来，这里不负责拉起。
    ///
    /// **不碰用户在终端里的交互式 `codex` 会话**，匹配规则见 `process::is_codex_background`。
    /// 一个都没找到不算失败，返回 `terminated: 0`。
    /// 不读写 `~/.codex/config.toml`，所以不取 `self.lock`
    pub fn restart_codex(&self) -> Result<RestartReport, AppError> {
        let processes = (self.deps.list_processes)()
            .map_err(|e| AppError::new("internal", format!("列出进程失败: {e}")))?;
        let mut report = RestartReport::default();
        for target in processes
            .iter()
            .filter(|p| process::is_codex_background(&p.command))
        {
            // 失败时原样转述系统的话，不编，也不把它当成「结束成功」
            (self.deps.terminate)(target.pid).map_err(|e| {
                AppError::new("internal", format!("结束进程 {} 失败: {e}", target.pid))
            })?;
            report.pids.push(target.pid);
        }
        report.terminated = report.pids.len() as u32;
        Ok(report)
    }

    /// 接管 agents-manager 的现有配置：地址、模型、显示名、密钥、启用前默认模型原样带过来
    pub fn takeover(&self) -> Result<(), AppError> {
        let _guard = self.guard();
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
        // 对方只有一家网关。同一家（地址相同）重复接管时覆盖原来那一家；
        // 用户自己建的网关即使 id 相同，只要地址不同就绝不覆盖——另起一家
        let base_url = clean_base_url(&old.base_url)?;
        let target = takeover_provider_id(&settings, &base_url);
        let provider = ProviderSettings {
            id: target.clone(),
            name: TAKEOVER_PROVIDER_ID.to_owned(),
            base_url,
            api_base: Some(old.api_base.trim().to_owned()).filter(|b| !b.is_empty()),
            protocol: if old.protocol == "responses" {
                "responses".into()
            } else {
                "chat".into()
            },
            models: old
                .models
                .iter()
                .map(|m| SavedModel {
                    model: Model {
                        id: m.id.clone(),
                        display_name: Some(m.display_name.trim().to_owned())
                            .filter(|n| !n.is_empty()),
                        context_window: m.context_window,
                        vision: m.vision,
                    },
                    selected: m.selected,
                })
                .collect(),
        };
        match settings.provider_mut(&target) {
            Some(existing) => *existing = provider,
            None => settings.providers.push(provider),
        }
        settings.prev_model = old.had_prev_model.then_some(old.prev_model.clone());
        settings.had_prev_model = old.had_prev_model;
        // 对方的标识不带网关前缀，接管后全部换成带前缀的：旧标识留在这里，会进停用名单
        for slug in &old.published_slugs {
            if !settings.published_slugs.contains(slug) {
                settings.published_slugs.push(slug.clone());
            }
        }
        if settings
            .provider(&target)
            .is_none_or(|p| p.selected().is_empty())
        {
            return Err(AppError::new(
                "invalid",
                "agents-manager 里没有选中的模型，无法接管",
            ));
        }
        // 先把本功能的目录和路由准备好并确认健康；这一步失败时对方仍然完好
        if let Err(error) = self
            .write_catalogs(&mut settings)
            .and_then(|()| self.install_router(&settings))
        {
            // 没成：对方仍然完好，本功能不留下后台服务和文件
            self.remove_own_traces();
            return Err(error);
        }
        // 路由确认健康之后才动密钥：失败的接管不能覆盖本功能原有的密钥
        if let Err(error) = (self.deps.set_key)(&target, key.trim()) {
            self.remove_own_traces();
            return Err(AppError::new("invalid", error));
        }

        // 从这里往后，密钥已经被覆盖、服务在跑、目录文件已落盘：任何失败都要把这些撤掉，
        // 否则会留下“两边都半开着”的状态。
        match self.finish_takeover(&mut settings, &detected, old.added_newline) {
            Ok(()) => {}
            Err(error) => {
                self.remove_own_traces();
                return Err(error);
            }
        }

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

    /// 只把 agents-manager 的密钥复制过来（命令行的 adopt-key）。放进接管会用的那一家的账户，
    /// 规则与 `takeover` 相同，所以不会覆盖用户自己那家同名网关的密钥。返回用的网关 id
    pub fn adopt_agents_manager_key(&self) -> Result<String, AppError> {
        let _guard = self.guard();
        let old = takeover::read_state(&self.deps.agents_manager_dir).map_err(|e| {
            AppError::new("invalid", format!("读取 agents-manager 的状态失败: {e}"))
        })?;
        let key = (self.deps.get_agents_manager_key)().map_err(|e| {
            AppError::new("invalid", format!("读取 agents-manager 的密钥失败: {e}"))
        })?;
        let target = takeover_provider_id(&self.load()?, &clean_base_url(&old.base_url)?);
        (self.deps.set_key)(&target, key.trim()).map_err(|e| AppError::new("invalid", e))?;
        Ok(target)
    }

    /// 接管的收尾：一次原子写把两个键从对方改指向本功能
    fn finish_takeover(
        &self,
        settings: &mut GatewaySettings,
        detected: &takeover::Detected,
        old_added_newline: bool,
    ) -> Result<(), AppError> {
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
            config::apply(&removed.text, &self.managed(settings)).map_err(config_error)?;
        // 对方的标识不带网关前缀，接管后都进了停用名单；Codex 的默认模型若正是其中之一，改回启用前的值
        let text = reset_default_model(&applied.text, settings, &retired_slugs(settings));
        self.write_config(&latest, &text)?;
        // 对方当初给末行补过的换行还在文件里，恢复时同样要还原
        settings.added_newline = applied.added_newline || old_added_newline;
        settings.changed_at = Some((self.deps.now)());
        settings.record_change((self.deps.now)(), true);
        self.save(settings)
    }

    /// 卸载本功能的后台服务并删掉 Codex 目录下本功能前缀的文件（只删普通文件）
    fn remove_own_traces(&self) {
        let _ = (self.deps.service_uninstall)(SERVICE_LABEL);
        if let Ok(entries) = std::fs::read_dir(&self.deps.codex_home) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if entry.file_type().is_ok_and(|t| t.is_file()) && name.starts_with(OWN_FILE_PREFIX)
                {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }

    pub fn state(&self) -> GatewayState {
        let _guard = self.guard();
        let settings = self.load().unwrap_or_default();
        let mut view = GatewayState {
            supported: true,
            ..Default::default()
        };
        view.providers = settings
            .providers
            .iter()
            .map(|provider| ProviderView {
                id: provider.id.clone(),
                name: provider.name.clone(),
                base_url: provider.base_url.clone(),
                protocol: provider.protocol().to_owned(),
                has_key: (self.deps.get_key)(&provider.id).is_ok_and(|k| !k.trim().is_empty()),
                models: provider
                    .models
                    .iter()
                    .map(|m| ModelView {
                        id: m.model.id.clone(),
                        slug: provider.slug_of(&m.model.id),
                        display_name: m
                            .model
                            .display_name
                            .clone()
                            .filter(|n| !n.trim().is_empty())
                            .unwrap_or_else(|| m.model.id.clone()),
                        selected: m.selected,
                    })
                    .collect(),
            })
            .collect();
        view.provider = view.providers.first().cloned().unwrap_or_default();

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
        // 协议已经挪到每家网关各自身上（多网关）。`router.protocol` 只留给还没迁过去的旧界面，
        // 取兼容字段那一家（＝第一家）的值；一家都没有时为空，旧界面自己退回 "chat"
        view.router.protocol = view.provider.protocol.clone();
        view.router.installed =
            (self.deps.service_status)(SERVICE_LABEL).is_ok_and(|s| s.installed);
        if view.enabled || view.router.installed {
            match (self.deps.router_healthy)(settings.port) {
                Ok(()) => view.router.running = true,
                Err(e) if view.enabled => {
                    view.router.error = format!("Codex 设置指向本机路由，但路由在端口 {} 上没有响应：{e}。此时官方模型也无法使用，可以点「重启路由」，或者停用本功能。", settings.port)
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
            // 比的是状态，不是时间：Codex 启动时加载到的和现在一样，就不用重启。
            // 旧版本留下的设置没有变更记录，说不清它加载过什么：只在当前确实开着时按时间提示
            let enabled = view.enabled;
            view.needs_codex_restart =
                settings.needs_codex_restart(started_at).unwrap_or_else(|| {
                    enabled
                        && settings
                            .changed_at
                            .is_some_and(|changed_at| started_at < changed_at)
                });
        }
        view
    }
}

/// 接管来的配置该落到哪一家：地址相同的那家（重复接管）；否则新起一个 id，
/// 首选 `wecode`，已被用户自己的网关占用就顺延
fn takeover_provider_id(settings: &GatewaySettings, base_url: &str) -> String {
    if let Some(same) = settings.providers.iter().find(|p| p.base_url == base_url) {
        return same.id.clone();
    }
    let taken: Vec<&str> = settings.providers.iter().map(|p| p.id.as_str()).collect();
    settings::new_provider_id(TAKEOVER_PROVIDER_ID, &taken)
}

fn unknown_provider(id: &str) -> AppError {
    AppError::new("invalid", format!("没有这个网关：{id}"))
}

/// 曾经发布过、现在已不在目录里的标识
fn retired_slugs(settings: &GatewaySettings) -> Vec<String> {
    let active: Vec<String> = settings.published().into_iter().map(|p| p.slug).collect();
    settings
        .published_slugs
        .iter()
        .filter(|slug| !active.contains(slug))
        .cloned()
        .collect()
}

/// 新建网关时没给名字，用地址里的主机名
fn host_of(base_url: &str) -> String {
    url::Url::parse(base_url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .unwrap_or_else(|| base_url.to_owned())
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
