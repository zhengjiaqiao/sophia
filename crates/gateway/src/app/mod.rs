//! 把各模块串成“保存网关 / 选模型 / 启用 / 恢复 / 接管 / 查看状态”这几个动作，界面和命令行共用。
//! 行为移植自 agents-manager 的 `internal/app`（Go，已在真实环境验证）。
//!
//! 两家（`Agent::Codex`、`Agent::Claude`）共用一个 `App`、一把锁、一个路由服务：路由服务的引用计数
//! （任一家开着就保留，都关了才卸，spec R8）与两家之间的同步需要同时看到两家的状态。
//! 本文件是公共部分与 Codex；按家的网关增删改在 `providers.rs`，Claude 桌面应用在 `claude.rs`。
mod claude;
#[cfg(test)]
mod claude_tests;
mod providers;
#[cfg(test)]
mod tests;

pub use crate::claude_desktop::DesktopInfo;
pub use crate::router::Agent;
pub use claude::{ClaudeAgentView, DesktopView, ProfileModel, MIN_DESKTOP_VERSION};
pub use providers::{same_address, ProbeTarget, ProviderSaved};

use crate::process::{self, RestartReport};
use crate::{codex_desktop, service, takeover};
use sophia_core::atomicfile::{self, FileState};
use sophia_core::claude_models::desktop::DesktopDirs;
use sophia_core::claude_models::settings::ClaudeGatewaySettings;
use sophia_core::codex_models::catalog::{self, Model};
use sophia_core::codex_models::config::{self, ConfigError, Managed};
use sophia_core::codex_models::settings::{
    self, GatewaySettings, ProviderSettings, SavedModel, UnreachableReason,
};
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const SERVICE_LABEL: &str = "com.zhengjiaqiao.sophia.gateway";
/// Sophia 的 bundle identifier（tauri.conf.json 的 `identifier`）：路由后台服务挂在它名下
pub const APP_BUNDLE_ID: &str = "com.zhengjiaqiao.sophia";
/// 本功能放在 Codex 目录下的文件统一用这个前缀，恢复时据此精确清理
pub const OWN_FILE_PREFIX: &str = "sophia-";
const CATALOG_FILE: &str = "sophia-models.json";
const ROUTING_FILE: &str = "sophia-routing.json";
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
/// 按（家, 网关 id）读 / 删服务商密钥
type KeyOp<R> = Box<dyn Fn(Agent, &str) -> R + Send + Sync>;
/// 按（家, 网关 id）写服务商密钥：`(家, id, key)`
type KeyWrite = Box<dyn Fn(Agent, &str, &str) -> Result<(), String> + Send + Sync>;

/// 对外部世界的全部依赖，测试里全部替换成假的
pub struct Deps {
    pub codex_home: PathBuf,
    /// Sophia 的数据目录；后台程序副本放在它的 `bin/` 下。同目录还有 settings.json 等，清理时不能碰
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
    /// 按（家, 网关 id）读密钥：Codex 账户 `codex-gateway.<id>`，Claude 账户 `claude-gateway.<id>`（R4）
    pub get_key: KeyOp<Result<String, String>>,
    /// 按（家, 网关 id）写密钥
    pub set_key: KeyWrite,
    /// 按（家, 网关 id）删密钥；本来就没有不算错
    pub delete_key: KeyOp<Result<(), String>>,
    pub get_agents_manager_key: Get<Result<String, String>>,
    /// 把当前可执行文件复制到稳定路径；返回副本是否被更新
    pub install_binary: PathOp<io::Result<bool>>,
    /// 当前进程表（pid + 完整命令行）
    pub list_processes: Get<io::Result<Vec<process::ProcessInfo>>>,
    /// 向进程发 SIGTERM
    pub terminate: Op<u32, io::Result<()>>,
    /// 打开 Codex 桌面应用（按应用标识，不写死路径）；打不开时带回系统的原话
    pub launch_codex: Get<io::Result<()>>,
    /// 装着的 Codex 桌面应用（包 id `com.openai.codex`）的显示名；没装为空串
    pub codex_app_name: Get<String>,
    /// Codex 桌面应用在不在运行；拿不准时报错
    pub codex_app_running: Get<io::Result<bool>>,
    /// 让 Codex 桌面应用退出并等到它不在运行（最多 15 秒；超时 `TimedOut`）
    pub codex_app_quit: Get<io::Result<()>>,
    /// 打开 Codex 桌面应用并等到在运行（最多 20 秒；超时 `TimedOut`，打不开带回 `open` 的原话）
    pub codex_app_open: Get<io::Result<()>>,
    /// Codex 后台进程（app-server，配置是它读的）最早的启动时间（unix 秒）；没在运行为 None
    pub codex_started_at: Get<Option<u64>>,
    pub codex_version: Get<String>,
    pub now: Get<u64>,

    // ----- 家 claude -----
    pub load_claude: Get<io::Result<ClaudeGatewaySettings>>,
    pub save_claude: RefOp<ClaudeGatewaySettings, io::Result<()>>,
    /// `/_health` 的 `features`（R9：写桌面应用配置前确认路由认得家 claude）
    pub router_features: Op<u16, Result<Vec<String>, String>>,
    /// 钥匙串里的令牌（`claude-router-token`）；没有为 `Ok(None)`
    pub get_router_token: Get<Result<Option<String>, String>>,
    pub set_router_token: StrOp<Result<(), String>>,
    /// 生成一个新令牌（256 位系统随机数，R5）
    pub new_router_token: Get<io::Result<String>>,
    /// 桌面应用的两个数据目录（测试指向临时目录）
    pub desktop_dirs: DesktopDirs,
    /// 受管偏好的两个位置（存在即算「由组织统一配置」）
    pub managed_prefs: Vec<PathBuf>,
    /// 装着的桌面应用与版本；没装为 None
    pub desktop_info: Get<Option<DesktopInfo>>,
    /// 桌面应用在不在运行（R48）；拿不准时报错
    pub desktop_running: Get<io::Result<bool>>,
    /// 让它退出并等到全部退出（最多 15 秒；超时 `TimedOut`，R50）
    pub desktop_quit: Get<io::Result<()>>,
    /// 打开它并等到在运行（最多 20 秒，R49）
    pub desktop_open: Get<io::Result<()>>,
}

pub struct App {
    deps: Deps,
    /// 同一进程里的动作串行执行。某个动作 panic 之后锁会被标记为中毒，
    /// 但它保护的是磁盘上的文件、不是内存里的不变量，所以继续用，不让整个功能瘫掉。
    lock: Mutex<()>,
    /// 测试用：在写桌面应用的每一个文件之前调用，返回 Err 即模拟这一步写失败
    #[cfg(test)]
    step_hook: claude::StepHook,
}

// ----- 状态视图（字段与 docs/gateway-commands.md 一致） -----

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelView {
    pub id: String,
    pub slug: String,
    pub display_name: String,
    pub selected: bool,
    /// 拉取模型列表时网关给的上下文长度（token）；网关没给为 None（JSON `null`）。
    /// Codex 目录在 None 时写保守的缺省值，这里不替它填
    pub context_window: Option<u32>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    /// 创建后不变；新命令用它指明操作哪一家
    pub id: String,
    pub name: String,
    /// 网关短名（`ProviderSettings::short_name`）：网关行的名字，也是撞名模型在 Codex 目录里的后缀。
    /// 界面只读它，不自己再算一份，Sophia 与 Codex 里看到的是同一个名字
    pub short_name: String,
    pub base_url: String,
    /// "chat" 或 "responses"
    pub protocol: String,
    pub has_key: bool,
    pub models: Vec<ModelView>,
    /// 上次拉取模型失败的原因（当前语言的短句：「地址无法访问」「密钥无效，请换一个密钥」…，返回界面时才取句）；
    /// None 表示上次成功或还没拉过
    pub unreachable: Option<String>,
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
    /// 装着的 Codex 桌面应用的显示名（如 `ChatGPT`）；没装为空串
    pub app_name: String,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeoverOffer {
    pub base_url: String,
    pub selected_count: usize,
}

/// Codex 那一家特有的状态
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAgentView {
    pub needs_restart: bool,
    pub app: CodexView,
    pub takeover: Option<TakeoverOffer>,
}

/// 一家的状态（契约 §6 `AgentGatewayView`）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGatewayView {
    pub agent: Agent,
    /// Codex：读得到 Codex 版本；Claude：桌面应用已安装
    pub installed: bool,
    pub providers: Vec<ProviderView>,
    /// 开关。Codex：设置文件指向路由；Claude：想要的值（写没写进去看 `claude.desktop`）
    pub enabled: bool,
    pub conflict: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex: Option<CodexAgentView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude: Option<ClaudeAgentView>,
}

/// 模型页的状态（契约 §6）：路由两家共用，其余按家拆开（顺序 codex、claude）
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayState {
    pub supported: bool,
    pub router: RouterView,
    /// 按家拆开的状态
    pub agents: Vec<AgentGatewayView>,
}

impl GatewayState {
    /// 某一家的状态；`supported: false` 时两家都不列，返回 None
    pub fn agent(&self, agent: Agent) -> Option<&AgentGatewayView> {
        self.agents.iter().find(|view| view.agent == agent)
    }
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

/// 路由没就绪时，告诉用户哪一家的配置没动
#[derive(Debug, Clone, Copy)]
enum Untouched {
    Codex,
    Claude,
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
        .map_err(|_| AppError::new("invalid", sophia_core::t!("models.app.badUrl")))?;
    let host = parsed.host_str().unwrap_or("");
    if !matches!(parsed.scheme(), "http" | "https") || host.is_empty() {
        return Err(AppError::new(
            "invalid",
            sophia_core::t!("models.app.badUrl"),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppError::new(
            "invalid",
            sophia_core::t!("models.app.urlHasCredentials"),
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
            sophia_core::t!("models.app.urlNotHttps"),
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
            #[cfg(test)]
            step_hook: Default::default(),
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
        self.deps.data_dir.join("bin").join("Sophia")
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
        let state = atomicfile::read_state(&self.config_path()).map_err(|_| {
            AppError::new("invalid", sophia_core::t!("models.app.configUnreadable"))
        })?;
        let text = match &state {
            FileState::Missing => String::new(),
            FileState::Present(snapshot) => {
                String::from_utf8(snapshot.bytes.clone()).map_err(|_| {
                    AppError::new("invalid", sophia_core::t!("models.app.configNotUtf8"))
                })?
            }
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
                AppError::new("changed", sophia_core::t!("models.app.configChanged"))
            } else {
                internal(sophia_core::t!("models.app.configWriteFailed", error = e))
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
    // 网关的增删改、拉模型、勾选在 `providers.rs`（按家）；Claude 的打开 / 切回 / 重启生效在 `claude.rs`。

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 已启用时，勾选或上游变了：让 Codex 目录下的两份清单跟上。
    /// 先确保后台的路由程序是当前版本，再写清单——旧版路由不认清单里的归属，
    /// 会把所有第三方模型都发给启动参数里的那一家，第二家的请求内容就发错了地方。
    fn republish(&self, settings: &mut GatewaySettings) -> Result<(), AppError> {
        if settings.published().is_empty() {
            return Err(AppError::new(
                "invalid",
                sophia_core::t!("models.app.needOneModel"),
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
            return Err(AppError::new(
                "invalid",
                sophia_core::t!("models.app.noBaseUrl"),
            ));
        }
        if settings.published().is_empty() {
            return Err(AppError::new(
                "invalid",
                sophia_core::t!("models.app.noModelsSelected"),
            ));
        }
        // 只检查有模型要发布的网关：没勾选任何模型的那几家不影响启用
        for provider in &settings.providers {
            if provider.selected().is_empty() {
                continue;
            }
            if provider.base_url.is_empty() {
                return Err(AppError::new(
                    "invalid",
                    sophia_core::t!("models.app.providerNoUrl", name = provider.name),
                ));
            }
            if (self.deps.get_key)(Agent::Codex, &provider.id).map_or(true, |k| k.trim().is_empty())
            {
                return Err(AppError::new(
                    "invalid",
                    if settings.providers.len() == 1 {
                        sophia_core::t!("models.app.noKey")
                    } else {
                        sophia_core::t!("models.app.providerNoKey", name = provider.name)
                    },
                ));
            }
        }
        let first = self.read_config()?;
        if self.detect_agents_manager(&first.text).is_some() {
            return Err(AppError::new(
                "conflict",
                sophia_core::t!("models.app.takeoverFirst"),
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
            .map_err(|e| internal(sophia_core::t!("models.app.installBinaryFailed", error = e)))?;
        let loaded = (self.deps.service_status)(SERVICE_LABEL)
            .map(|s| s.loaded)
            .unwrap_or(false);
        // 已知的、可接受的窗口：此刻正好在走路由的那一个请求会断（重启是几百毫秒的事，
        // 只在应用更新后的第一次启动出现一次）。不为此加活跃连接计数，见 docs/specs/2026-09-21-tray.md「修订」
        if changed && loaded {
            (self.deps.service_restart)(SERVICE_LABEL).map_err(|e| {
                AppError::new(
                    "router_down",
                    sophia_core::t!("models.app.restartServiceFailed", error = e),
                )
            })?;
        }
        Ok(changed)
    }

    /// 程序副本的路径；预热之后调用方拿它空跑一次，让系统把首次校验做掉
    pub fn router_binary(&self) -> PathBuf {
        self.binary_path()
    }

    fn install_router(&self, settings: &GatewaySettings) -> Result<(), AppError> {
        self.install_router_on(settings.port, Untouched::Codex)
    }

    /// 装好并确认路由健康。启动参数在两家开关的任何组合下都相同（R7）：只在升级后第一次安装时改一次 plist，
    /// 之后开关某一家不会重载服务。`untouched` 定失败时告诉用户「哪份配置没动」的那一句
    fn install_router_on(&self, port: u16, untouched: Untouched) -> Result<(), AppError> {
        let binary = self.binary_path();
        let binary_changed = (self.deps.install_binary)(&binary)
            .map_err(|e| internal(sophia_core::t!("models.app.installBinaryFailed", error = e)))?;
        let log_dir = self.log_dir();
        std::fs::create_dir_all(&log_dir).map_err(internal)?;
        let spec = service::Spec {
            label: SERVICE_LABEL.to_owned(),
            program: binary.to_string_lossy().into_owned(),
            args: [
                "gateway",
                "run",
                "--port",
                &port.to_string(),
                // 上游地址和协议不在启动参数里：它们写在路由清单里，路由每个请求重读，
                // 增删网关、改地址都不用重装后台服务
                "--routing-catalog",
                &self.routing_path().to_string_lossy(),
                "--claude-routing",
                &self.claude_routing_path().to_string_lossy(),
                "--log",
                &log_dir.join("router.log").to_string_lossy(),
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            log_path: Some(log_dir.join("service.log").to_string_lossy().into_owned()),
            env: Default::default(),
            associated_bundle: Some(APP_BUNDLE_ID.to_owned()),
        };
        let was_loaded = (self.deps.service_status)(SERVICE_LABEL)
            .map(|s| s.loaded)
            .unwrap_or(false);
        (self.deps.service_install)(&spec).map_err(|e| {
            AppError::new(
                "router_down",
                sophia_core::t!("models.app.installServiceFailed", error = e),
            )
        })?;
        if binary_changed && was_loaded {
            // 程序文件换了，让已在运行的后台服务重启以用上新版本
            (self.deps.service_restart)(SERVICE_LABEL).map_err(|e| {
                AppError::new(
                    "router_down",
                    sophia_core::t!("models.app.restartServiceFailed", error = e),
                )
            })?;
        }
        (self.deps.router_healthy)(port).map_err(|e| {
            AppError::new(
                "router_down",
                match untouched {
                    Untouched::Codex => {
                        sophia_core::t!("models.app.routerNotReady", port = port, error = e)
                    }
                    Untouched::Claude => {
                        sophia_core::t!("models.claude.routerNotReadyBusy", port = port, error = e)
                    }
                },
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
        let state = atomicfile::read_state(path).map_err(|_| {
            internal(sophia_core::t!(
                "models.app.fileUnreadable",
                path = path.display()
            ))
        })?;
        if matches!(&state, FileState::Present(existing) if existing.bytes == bytes) {
            return Ok(());
        }
        atomicfile::atomic_write(path, bytes, &state).map_err(|e| {
            internal(sophia_core::t!(
                "models.app.fileWriteFailed",
                path = path.display(),
                error = e
            ))
        })
    }

    /// 从 Codex 设置里移除本功能的两项，清理本功能文件并卸载后台服务。路由不通时也可用。
    /// Claude 还开着时路由服务保留，Codex 的路由清单改成「无生效模型」（R8）
    pub fn restore(&self) -> Result<Vec<String>, AppError> {
        let _guard = self.guard();
        self.restore_locked()
    }

    fn restore_locked(&self) -> Result<Vec<String>, AppError> {
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
            return Err(AppError::new(
                "conflict",
                sophia_core::t!(
                    "models.app.stillPointing",
                    warnings = sophia_core::i18n::list_text(
                        &warnings,
                        sophia_core::i18n::ListStyle::Semicolon
                    )
                ),
            ));
        }
        if self.claude_on() {
            // Claude 还开着：路由服务留着。还没重启的 Codex 仍会发请求——官方模型照常放行，
            // 已取消的第三方模型按停用拒绝，所以清单改成「无生效模型、停用名单是全部发布过的标识」
            let routing = catalog::build_routing(&[], &[], &settings.published_slugs)
                .map_err(|e| AppError::new("invalid", e))?;
            self.write_own_file(&self.routing_path(), &routing)?;
            warnings.extend(self.remove_codex_files(&[ROUTING_FILE]));
        } else {
            if let Err(e) = (self.deps.service_uninstall)(SERVICE_LABEL) {
                warnings.push(sophia_core::t!(
                    "models.app.uninstallServiceFailed",
                    error = e
                ));
            }
            warnings.extend(self.remove_codex_files(&[]));
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

    /// 重启生效：让 Codex 读到新配置。
    ///
    /// 1. 桌面应用（包 id `com.openai.codex`）在运行 → 发退出请求（SIGTERM 给主进程，同 ⌘Q），
    ///    等到它不在运行，最多 15 秒；退不掉 → `desktop_busy`，不强杀、不结束别的、不打开。
    ///    只重启 app-server 不够：桌面应用的窗口缓存了模型列表，新加的模型要整个应用重开才出现。
    /// 2. 结束剩下的 Codex 后台进程（SIGTERM）：编辑器插件等拉起的 `codex app-server` 与
    ///    `codex-code-mode-host`。**不碰用户在终端里的交互式 `codex` 会话**，匹配规则见
    ///    `process::is_codex_background`。
    /// 3. 桌面应用原本在运行 → 重新打开并等到在运行，最多 20 秒；原本没开就不打开，
    ///    下次任何工具拉起 Codex 时会带着新配置起来。
    ///
    /// 一个都没在跑不算失败。不读写 `~/.codex/config.toml`，所以不取 `self.lock`（等待时也就不持锁）
    pub fn restart_codex(&self) -> Result<RestartReport, AppError> {
        let app = self.codex_app_display_name();
        // 查不了在不在运行（lsappinfo 不可用）：不因此失败，退回只结束后台进程——
        // 那样至少引擎换上新配置（ChatGPT 窗口里的模型列表可能要它自己重开才刷新）
        let was_running = (self.deps.codex_app_running)().unwrap_or(false);
        if was_running {
            (self.deps.codex_app_quit)().map_err(|e| {
                if e.kind() == io::ErrorKind::TimedOut {
                    AppError::new("desktop_busy", codex_desktop::busy_message(&app))
                } else {
                    AppError::new(
                        "internal",
                        sophia_core::t!("models.desktop.quitFailed", app = app, error = e),
                    )
                }
            })?;
        }
        let ended = self.terminate_codex_background();
        if !was_running {
            return ended;
        }
        // 结束后台进程失败也照样把桌面应用打开：刚才是我们让它退出的，不能把它关着丢给用户
        let opened = (self.deps.codex_app_open)().map_err(|e| {
            if e.kind() == io::ErrorKind::TimedOut {
                AppError::new("internal", codex_desktop::open_timeout_message(&app))
            } else {
                // 失败时原样转述 `open` 的话，不编
                AppError::new("internal", e.to_string())
            }
        });
        match (ended, opened) {
            (Ok(report), Ok(())) => Ok(RestartReport {
                reopened: true,
                ..report
            }),
            (Ok(_), Err(error)) | (Err(error), Ok(())) => Err(error),
            (Err(error), Err(open)) => Err(AppError::new(
                error.code,
                sophia_core::t!(
                    "models.desktop.alsoNotReopened",
                    reason = error.message,
                    app = app,
                    error = open.message
                ),
            )),
        }
    }

    /// 结束 Codex 后台进程（重启生效第 2 步）。发信号失败时再看一眼进程表：
    /// 它已经不在了（刚随桌面应用一起退出）不算失败，也不计入；还在就原样转述系统的话
    fn terminate_codex_background(&self) -> Result<RestartReport, AppError> {
        let list = || {
            (self.deps.list_processes)().map_err(|e| {
                AppError::new(
                    "internal",
                    sophia_core::t!("models.app.listProcessesFailed", error = e),
                )
            })
        };
        let processes = list()?;
        let mut report = RestartReport::default();
        for target in processes
            .iter()
            .filter(|p| process::is_codex_background(&p.command))
        {
            if let Err(e) = (self.deps.terminate)(target.pid) {
                let still_there = list()?
                    .iter()
                    .any(|p| p.pid == target.pid && process::is_codex_background(&p.command));
                if still_there {
                    return Err(AppError::new(
                        "internal",
                        sophia_core::t!("models.app.killFailed", pid = target.pid, error = e),
                    ));
                }
                continue;
            }
            report.pids.push(target.pid);
        }
        report.terminated = report.pids.len() as u32;
        Ok(report)
    }

    /// 提示里用的 Codex 桌面应用名字：装着的显示名，没装时用 `Codex`
    fn codex_app_display_name(&self) -> String {
        Some((self.deps.codex_app_name)())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| codex_desktop::FALLBACK_NAME.to_owned())
    }

    /// 打开 Codex 桌面应用。只发出打开请求、不等它起来——界面自己轮询 `codex.running`，
    /// 刚起来的 Codex 读的就是现在的设置。不读写 `~/.codex/config.toml`，所以不取 `self.lock`。
    /// 失败时原样转述系统的话，不编
    pub fn launch_codex(&self) -> Result<(), AppError> {
        (self.deps.launch_codex)().map_err(|e| AppError::new("internal", e.to_string()))
    }

    /// 接管 agents-manager 的现有配置：地址、模型、显示名、密钥、启用前默认模型原样带过来
    pub fn takeover(&self) -> Result<(), AppError> {
        let _guard = self.guard();
        let first = self.read_config()?;
        let detected = self
            .detect_agents_manager(&first.text)
            .ok_or_else(|| AppError::new("invalid", sophia_core::t!("models.app.noAmConfig")))?;
        let old = takeover::read_state(&self.deps.agents_manager_dir).map_err(|e| {
            AppError::new(
                "invalid",
                sophia_core::t!("models.app.readAmStateFailed", error = e),
            )
        })?;
        let key = (self.deps.get_agents_manager_key)().map_err(|e| {
            AppError::new(
                "invalid",
                sophia_core::t!("models.app.readAmKeyFailed", error = e),
            )
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
            unreachable: None,
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
                sophia_core::t!("models.app.noAmModels"),
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
        if let Err(error) = (self.deps.set_key)(Agent::Codex, &target, key.trim()) {
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
            AppError::new(
                "invalid",
                sophia_core::t!("models.app.readAmStateFailed", error = e),
            )
        })?;
        let key = (self.deps.get_agents_manager_key)().map_err(|e| {
            AppError::new(
                "invalid",
                sophia_core::t!("models.app.readAmKeyFailed", error = e),
            )
        })?;
        let target = takeover_provider_id(&self.load()?, &clean_base_url(&old.base_url)?);
        (self.deps.set_key)(Agent::Codex, &target, key.trim())
            .map_err(|e| AppError::new("invalid", e))?;
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
                AppError::new("changed", sophia_core::t!("models.app.takeoverChanged"))
            })?;
        let old_managed = Managed {
            catalog_path: old_catalog,
            base_url: takeover::ROUTER_BASE_URL.to_owned(),
        };
        let removed = config::remove(&latest.text, &old_managed, false).map_err(config_error)?;
        if !removed.warnings.is_empty() {
            return Err(AppError::new(
                "conflict",
                sophia_core::t!(
                    "models.app.takeoverRemoveFailed",
                    warnings = sophia_core::i18n::list_text(
                        &removed.warnings,
                        sophia_core::i18n::ListStyle::Semicolon
                    )
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

    /// 卸载本功能的后台服务并删掉 Codex 目录下本功能前缀的文件（只删普通文件）。
    /// Claude 开着时服务留着（R8），只删 Codex 目录下的文件
    fn remove_own_traces(&self) {
        if !self.claude_on() {
            let _ = (self.deps.service_uninstall)(SERVICE_LABEL);
        }
        let _ = self.remove_codex_files(&[]);
    }

    /// 删掉 Codex 目录下本功能前缀的普通文件（`keep` 里的除外）；数据目录里还有 settings.json 等，不碰。
    /// 返回删不掉的提示
    fn remove_codex_files(&self, keep: &[&str]) -> Vec<String> {
        let mut warnings = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&self.deps.codex_home) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let is_file = entry.file_type().is_ok_and(|t| t.is_file());
                if is_file && name.starts_with(OWN_FILE_PREFIX) && !keep.contains(&name.as_str()) {
                    if let Err(e) = std::fs::remove_file(entry.path()) {
                        warnings.push(sophia_core::t!(
                            "models.app.deleteFileFailed",
                            name = name,
                            error = e
                        ));
                    }
                }
            }
        }
        warnings
    }

    /// 一家的网关列表视图
    fn provider_views(&self, agent: Agent, providers: &[ProviderSettings]) -> Vec<ProviderView> {
        providers
            .iter()
            .map(|provider| ProviderView {
                id: provider.id.clone(),
                name: provider.name.clone(),
                short_name: provider.short_name(),
                base_url: provider.base_url.clone(),
                protocol: provider.protocol().to_owned(),
                has_key: (self.deps.get_key)(agent, &provider.id)
                    .is_ok_and(|k| !k.trim().is_empty()),
                unreachable: provider.unreachable.as_ref().map(UnreachableReason::text),
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
                        context_window: m.model.context_window,
                    })
                    .collect(),
            })
            .collect()
    }

    pub fn state(&self) -> GatewayState {
        let _guard = self.guard();
        let settings = self.load().unwrap_or_default();
        let claude_settings = self.load_claude().unwrap_or_default();
        let mut view = GatewayState {
            supported: true,
            ..Default::default()
        };
        let mut codex = AgentGatewayView {
            agent: Agent::Codex,
            installed: false,
            providers: self.provider_views(Agent::Codex, &settings.providers),
            enabled: false,
            conflict: String::new(),
            codex: None,
            claude: None,
        };
        let mut extra = CodexAgentView::default();

        match self.read_config() {
            Ok(snapshot) => {
                if let Some(_detected) = self.detect_agents_manager(&snapshot.text) {
                    let old = takeover::read_state(&self.deps.agents_manager_dir).ok();
                    extra.takeover = Some(TakeoverOffer {
                        base_url: old.as_ref().map(|s| s.base_url.clone()).unwrap_or_default(),
                        selected_count: old
                            .as_ref()
                            .map_or(0, |s| s.models.iter().filter(|m| m.selected).count()),
                    });
                } else {
                    match config::inspect(&snapshot.text, &self.managed(&settings)) {
                        Ok(inspection) => {
                            codex.enabled = inspection.enabled;
                            codex.conflict = inspection.conflict.unwrap_or_default();
                        }
                        Err(e) => codex.conflict = e.to_string(),
                    }
                }
            }
            Err(e) => codex.conflict = e.message,
        }

        view.router.port = settings.port;
        view.router.installed =
            (self.deps.service_status)(SERVICE_LABEL).is_ok_and(|s| s.installed);
        let claude_applied = claude_settings.applied.is_some();
        // 健康检查每次只做一次，两家共用
        if codex.enabled || view.router.installed || claude_applied {
            match (self.deps.router_healthy)(settings.port) {
                Ok(()) => view.router.running = true,
                Err(e) if codex.enabled => {
                    view.router.error = sophia_core::t!(
                        "models.app.routerNoResponse",
                        port = settings.port,
                        error = e
                    )
                }
                Err(e) if claude_applied => {
                    view.router.error = sophia_core::t!(
                        "models.claude.routerNoResponse",
                        port = settings.port,
                        error = e
                    )
                }
                Err(_) => {}
            }
        }

        extra.app.version = (self.deps.codex_version)();
        extra.app.app_name = (self.deps.codex_app_name)();
        extra.app.catalog_version = settings.catalog_client_version.clone();
        extra.app.drift = codex.enabled
            && !settings.catalog_client_version.is_empty()
            && !extra.app.version.is_empty()
            && settings.catalog_client_version != extra.app.version;
        if let Some(started_at) = (self.deps.codex_started_at)() {
            extra.app.running = true;
            // 比的是状态，不是时间：Codex 启动时加载到的和现在一样，就不用重启。
            // 旧版本留下的设置没有变更记录，说不清它加载过什么：只在当前确实开着时按时间提示
            let enabled = codex.enabled;
            extra.needs_restart = settings.needs_codex_restart(started_at).unwrap_or_else(|| {
                enabled
                    && settings
                        .changed_at
                        .is_some_and(|changed_at| started_at < changed_at)
            });
        }
        codex.installed = !extra.app.version.is_empty();
        codex.codex = Some(extra);
        view.agents = vec![codex, self.claude_view(&claude_settings, settings.port)];
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
    AppError::new(
        "invalid",
        sophia_core::t!("models.app.unknownProvider", id = id),
    )
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
