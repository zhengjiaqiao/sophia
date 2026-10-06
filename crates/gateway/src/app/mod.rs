//! 把各模块串成“保存网关 / 选模型 / 启用 / 恢复 / 接管 / 查看状态”这几个动作，界面和命令行共用。
//! 行为移植自 agents-manager 的 `internal/app`（Go，已在真实环境验证）。
//!
//! 两家（`Agent::Codex`、`Agent::Claude`）共用一个 `App`、一把锁、一个路由：路由的引用计数
//! （任一家开着就留着，都关了才停，spec R8）与两家之间的同步需要同时看到两家的状态。
//! 路由在 Sophia 进程里运行（spec 2026-10-03-gateway-in-app）：打开时接上、退出时收尾、关机时同步改回，在 `lifecycle.rs`。
//! 本文件是公共部分与 Codex；按家的网关增删改在 `providers.rs`，Claude 桌面应用在 `claude.rs`。
mod claude;
#[cfg(test)]
mod claude_tests;
#[cfg(test)]
mod hookup_tests;
mod lifecycle;
#[cfg(test)]
mod lifecycle_tests;
mod providers;
#[cfg(test)]
mod tests;

pub use crate::claude_desktop::DesktopInfo;
pub use crate::router::Agent;
pub use crate::router_host::{Occupant, StartError};
pub use claude::{
    claude_routing_file, ClaudeAgentView, DesktopView, ProfileModel, MIN_DESKTOP_VERSION,
};
pub use lifecycle::{AttachReport, FamilyError, PortNotice, QuitPreview, QuitStep};
pub use providers::{same_address, ProbeTarget, ProviderSaved};

use crate::process::{self, RestartReport};
use crate::{codex_desktop, takeover};
use sophia_core::atomicfile::{self, FileState, ReadError};
use sophia_core::claude_models::desktop::DesktopDirs;
use sophia_core::claude_models::settings::ClaudeGatewaySettings;
use sophia_core::codex_models::catalog::{self, Model};
use sophia_core::codex_models::config::{self, ConfigError, Managed};
use sophia_core::codex_models::login::{self, ModeReason};
use sophia_core::codex_models::settings::{
    self, GatewaySettings, HookupMode, ProviderSettings, SavedModel, UnreachableReason,
};
use sophia_core::file_issue::FileIssue;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 旧版本装的 launchd 路由服务的标签：只用来在升级后卸掉它（R14）
pub const SERVICE_LABEL: &str = "com.zhengjiaqiao.sophia.gateway";
/// 本功能放在 Codex 目录下的文件统一用这个前缀，恢复时据此精确清理
pub const OWN_FILE_PREFIX: &str = "sophia-";
const CATALOG_FILE: &str = "sophia-models.json";
/// Codex 的路由清单（在 Codex 目录下）；路由每个请求重读
pub const ROUTING_FILE: &str = "sophia-routing.json";
/// 备份后缀：备份目录里的 `<序号>-models.bak`，与 MCP 的 `<序号>-mcp.bak` 分得清是谁写的
const BACKUP_SUFFIX: &str = "models";
/// 接管 agents-manager 时生成的那一家网关的首选 id 与名字（对方只接了 wecode 这一家）；
/// 实际 id 见 `takeover_provider_id`
pub const TAKEOVER_PROVIDER_ID: &str = "wecode";

/// 带错误码的错误，显示为 `[代码] 说明`，代码取值见 docs/gateway-commands.md
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
    /// 技术原文（请求、状态码、返回的错误；已去隐私），界面 `详情` 里给（spec 2026-10-04-local-diagnostics R13）
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
        }
    }

    /// 带上技术原文；空的不带
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        self.detail = (!detail.trim().is_empty()).then_some(detail);
        self
    }
}

/// 命令错误串里技术原文的分隔（docs/gateway-commands.md「错误」）：`[code] 一句话` 之后另起一行
/// `[detail] 原文`。界面 `parseBackendError` 按它拆开，一句话照旧给人看，原文进 `详情`
pub const DETAIL_MARK: &str = "\n[detail] ";

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)?;
        if let Some(detail) = &self.detail {
            write!(f, "{DETAIL_MARK}{detail}")?;
        }
        Ok(())
    }
}

impl std::error::Error for AppError {}

type Op<A, R> = Box<dyn Fn(A) -> R + Send + Sync>;
type Get<R> = Box<dyn Fn() -> R + Send + Sync>;
/// 参数按引用传入的操作
type RefOp<A, R> = Box<dyn for<'a> Fn(&'a A) -> R + Send + Sync>;
type StrOp<R> = Box<dyn Fn(&str) -> R + Send + Sync>;
/// 按（家, 网关 id）读 / 删服务商密钥
type KeyOp<R> = Box<dyn Fn(Agent, &str) -> R + Send + Sync>;
/// 按（家, 网关 id）写服务商密钥：`(家, id, key)`
type KeyWrite = Box<dyn Fn(Agent, &str, &str) -> Result<(), String> + Send + Sync>;

/// 对外部世界的全部依赖，测试里全部替换成假的
pub struct Deps {
    pub codex_home: PathBuf,
    /// Sophia 的数据目录。旧版本在它的 `bin/` 下放过后台程序副本（R14 删掉）；同目录还有 settings.json 等，清理时不能碰
    pub data_dir: PathBuf,
    /// agents-manager 的数据目录（`~/.agents-manager`），只读
    pub agents_manager_dir: PathBuf,
    pub load_settings: Get<io::Result<GatewaySettings>>,
    pub save_settings: RefOp<GatewaySettings, io::Result<()>>,
    /// launchd 的 LaunchAgents 目录：看旧版本的路由服务还在不在（R14）
    pub launch_agents_dir: PathBuf,
    /// 卸掉一个 launchd 服务并删它的 plist（按标签）：旧版本的路由服务（R14）、接管时 agents-manager 的
    pub service_uninstall: StrOp<io::Result<()>>,
    /// 在本进程里起路由（同步：bind 成功即可服务）；已在这个端口上跑着不算错
    pub router_start: Op<u16, Result<(), StartError>>,
    /// 停下路由、放掉端口
    pub router_stop: Get<()>,
    /// 路由正在哪个端口上跑；没在跑为 None
    pub router_running: Get<Option<u16>>,
    /// 运行 `codex debug models --bundled`
    pub bundled: Get<io::Result<Vec<u8>>>,
    /// 按（家, 网关 id）读密钥（密钥文件 `secrets.json` 里两家各一份）：没有为 `Ok(None)`；
    /// 读不出（文件权限、格式损坏、还在钥匙串里没迁完）为 `Err(原因)`，原因是当前语言的一句话
    pub get_key: KeyOp<Result<Option<String>, String>>,
    /// 按（家, 网关 id）写密钥
    pub set_key: KeyWrite,
    /// 按（家, 网关 id）删密钥；本来就没有不算错
    pub delete_key: KeyOp<Result<(), String>>,
    pub get_agents_manager_key: Get<Result<String, String>>,
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
    /// 密钥文件里的 Claude 网关令牌；没有为 `Ok(None)`
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
    /// 路由端口的说明（另一个 Sophia 占着、换了端口、端口都被占），模型页显示；只在内存里
    notice: Mutex<Option<PortNotice>>,
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
    /// 用户手动填的（#117）
    pub manual: bool,
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
    /// 从哪个服务商预设建的（spec S1）；手填的为 None
    pub preset: Option<String>,
    /// 密钥：有 / 没有 / 读不出（spec 2026-10-03-keys-in-file R4）
    pub key: KeyStatus,
    /// 读不出时的原因（当前语言的一句话：「读不出密钥文件：没有读取权限」「密钥还在钥匙串里…」）；其余为 None
    pub key_problem: Option<String>,
    pub models: Vec<ModelView>,
    /// 上次拉取模型失败的原因（当前语言的短句：「地址无法访问」「密钥无效，请换一个密钥」…，返回界面时才取句）；
    /// None 表示上次成功或还没拉过
    pub unreachable: Option<String>,
    /// 那次失败的技术原文（已去隐私），网关行 `详情` 里给；没有为 None
    pub unreachable_detail: Option<String>,
    /// `unreachable` 是真实调用被拒了密钥记下的（#144）：重拉模型列表清不掉它，界面不给 `再试一次`
    pub key_rejected_on_call: bool,
    /// `unreachable` 的原因是密钥被拒（拉列表或真实调用都算）：网络是通的，界面不写「无法连接」，只写原因
    pub key_invalid: bool,
}

/// 一家网关的密钥状态。不再把「读不出」当成「没有」（R4）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyStatus {
    Set,
    #[default]
    Missing,
    Unreadable,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterView {
    /// 本进程里的路由在 `port` 上跑着
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
    /// 用户开着 Codex 的第三方模型（模型页开关的选择）。`AgentGatewayView.enabled` 是 Codex 设置现在
    /// 指着路由；两者不同只在打开 Sophia 时没接上（见 `GatewayState.port_notice`）
    pub wanted: bool,
    pub needs_restart: bool,
    pub app: CodexView,
    pub takeover: Option<TakeoverOffer>,
    /// 接法：Codex 设置指着路由时是写着的那一种，否则是上次写的（spec 2026-10-03-codex-hookup-auto）
    pub mode: HookupMode,
    /// 选这种接法的原因；还没判断过为 None
    pub mode_reason: Option<ModeReason>,
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
    /// 读不到第三方模型的状态（spec 2026-10-04-local-diagnostics R11）：哪个文件、哪一种（没权限 / 格式有误 / 别的）。
    /// 其余字段照能读到的给，模型页顶上据它出灰面板与往前走的键；没有为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unreadable: Option<FileIssue>,
    pub router: RouterView,
    /// 路由端口的说明：另一个 Sophia 占着、换了端口、端口都被占；没有为 None
    pub port_notice: Option<PortNotice>,
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
pub(super) enum Untouched {
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
            notice: Mutex::new(None),
            #[cfg(test)]
            step_hook: Default::default(),
        }
    }

    fn config_path(&self) -> PathBuf {
        self.deps.codex_home.join("config.toml")
    }

    /// Codex 的设置文件（`~/.codex/config.toml`）
    pub fn codex_config_path(&self) -> PathBuf {
        self.config_path()
    }

    /// Sophia 自己的设置（`settings.json`，网关设置存在里面）
    fn settings_path(&self) -> PathBuf {
        self.deps.data_dir.join("settings.json")
    }

    /// `修复权限`、`打开文件` 只认这些（spec 2026-10-04-local-diagnostics R11）：Codex 的设置文件，
    /// 与 Sophia 数据目录里直接放着的 JSON（`settings.json`、`secrets.json`……），逐字比对、不解析；
    /// 路径上任何一级是软链、带 `..`、不在白名单里都为 None（`file_issue::managed_path`）
    pub fn managed_file(&self, path: &Path) -> Option<PathBuf> {
        sophia_core::file_issue::managed_path(
            path,
            &[self.config_path().as_path()],
            &self.deps.data_dir,
        )
    }
    /// 改写用户配置前的备份放这里：Sophia 数据目录下的 `backups/`（见 `atomicfile::backup`）
    fn backups_dir(&self) -> PathBuf {
        self.deps.data_dir.join(atomicfile::BACKUPS_DIR)
    }
    fn catalog_path(&self) -> PathBuf {
        self.deps.codex_home.join(CATALOG_FILE)
    }
    fn routing_path(&self) -> PathBuf {
        self.deps.codex_home.join(ROUTING_FILE)
    }
    fn managed(&self, settings: &GatewaySettings) -> Managed {
        Managed {
            catalog_path: self.catalog_path().to_string_lossy().into_owned(),
            base_url: config::router_base_url(settings.port),
            mode: settings.mode,
        }
    }

    /// 网关设置读不出（settings.json 坏了、还没修）时用来**只删**本功能写进 Codex 设置的内容（spec S7）：
    /// 目录路径只看 `codex_home`；路由地址用默认端口——`remove` 认端口范围内任一端口写下的值；
    /// 接法无所谓，`remove` 两种形态都删
    fn managed_fallback(&self) -> Managed {
        Managed {
            catalog_path: self.catalog_path().to_string_lossy().into_owned(),
            base_url: config::router_base_url(sophia_core::codex_models::settings::DEFAULT_PORT),
            mode: Default::default(),
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
            atomicfile::backup(&path, existing, BACKUP_SUFFIX, &self.backups_dir()).map_err(
                |e| {
                    internal(sophia_core::t!(
                        "models.app.configWriteFailed",
                        error = atomicfile::backup_failure_text(&path, &e)
                            .unwrap_or_else(|| e.to_string())
                    ))
                },
            )?;
        }
        atomicfile::atomic_write(&path, text.as_bytes(), &snapshot.state).map_err(|e| {
            if e.to_string() == "changed" {
                AppError::new("changed", sophia_core::t!("models.app.configChanged"))
            } else {
                internal(sophia_core::t!(
                    "models.app.configWriteFailed",
                    error = atomicfile::write_error_text(&path, &e)
                ))
            }
        })
    }

    fn enabled(&self, settings: &GatewaySettings) -> bool {
        self.read_config()
            .ok()
            .and_then(|snapshot| config::inspect(&snapshot.text, &self.managed(settings)).ok())
            .is_some_and(|inspection| inspection.enabled)
    }

    /// 按 Codex 的登录状态选接法（spec 2026-10-03-codex-hookup-auto R1、R2）。`auth.json` 的字节只交给
    /// `login_state` 看字段有没有值，不进日志、不进错误、不出这个函数
    fn decide_mode(&self, config_text: &str) -> (HookupMode, ModeReason) {
        let login = match std::fs::read(self.deps.codex_home.join("auth.json")) {
            Ok(bytes) => {
                let store = config::root_string(config_text, "cli_auth_credentials_store");
                login::login_state(Some(&bytes), store.as_deref())
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let store = config::root_string(config_text, "cli_auth_credentials_store");
                login::login_state(None, store.as_deref())
            }
            // 在却读不了：说不准
            Err(_) => login::LoginState::Unknown,
        };
        // 没登录又显式写着 `model_provider = "openai"`：照样选独立服务商，写入时按冲突拒绝并说清下一步
        // （不改别人写的这一行，也不悄悄借用内置——那样 Codex 会停在登录页）
        login::choose_mode(login)
    }

    /// Codex 设置正指着路由、写着的接法与 `settings.mode` 不同：先把本功能写的删干净（两种形态都删），
    /// 返回删后的内容，调用方再按新接法写。不用换为 None
    fn strip_other_form(
        &self,
        text: &str,
        settings: &GatewaySettings,
    ) -> Result<Option<String>, AppError> {
        let managed = self.managed(settings);
        let Ok(inspection) = config::inspect(text, &managed) else {
            return Ok(None);
        };
        match inspection.mode {
            Some(written) if inspection.points_at_router && written != settings.mode => {
                let removed =
                    config::remove(text, &managed, settings.added_newline).map_err(config_error)?;
                Ok(Some(removed.text))
            }
            _ => Ok(None),
        }
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

    /// 已启用时，勾选或上游变了：让 Codex 目录下的两份清单跟上。先确保路由在跑，再写清单。
    /// `redecide`：这次是改选模型（spec 2026-10-03-codex-hookup-auto R4 的时刻之一）——重新判断接法，变了就换形态、
    /// 提示重启；只改网关地址等别的变化不重新判断
    fn republish(&self, settings: &mut GatewaySettings, redecide: bool) -> Result<(), AppError> {
        if settings.published().is_empty() {
            return Err(AppError::new(
                "invalid",
                sophia_core::t!("models.app.needOneModel"),
            ));
        }
        let before = self.read_config()?;
        let written = settings.mode;
        let (mode, reason) = if redecide {
            self.decide_mode(&before.text)
        } else {
            (
                written,
                settings.mode_reason.unwrap_or(ModeReason::SignedIn),
            )
        };
        settings.mode = mode;
        // 先在内存里试一次：换不过去（冲突、设置不合法）就留在现在写着的形态，不因此挡住改选模型
        if let Some(stripped) = self.strip_other_form(&before.text, settings)? {
            if config::apply(&stripped, &self.managed(settings)).is_err() {
                settings.mode = written;
            }
        }
        if settings.mode == mode {
            settings.mode_reason = Some(reason);
        }
        self.ensure_router(settings, Untouched::Codex)?;
        self.write_catalogs(settings)?;
        // 被取消的模型若正是 Codex 当前的默认模型，改回启用前的值
        let retired = retired_slugs(settings);
        let snapshot = self.read_config()?;
        let mut text = snapshot.text.clone();
        if let Some(stripped) = self.strip_other_form(&text, settings)? {
            let applied =
                config::apply(&stripped, &self.managed(settings)).map_err(config_error)?;
            settings.added_newline = applied.added_newline;
            text = applied.text;
            let now = (self.deps.now)();
            settings.changed_at = Some(now);
            settings.record_change(now, true);
        }
        let updated = reset_default_model(&text, settings, &retired);
        self.write_config(&snapshot, &updated)
    }

    /// 先起好路由，再写 Codex 设置；记下用户「开着」
    pub fn enable(&self) -> Result<(), AppError> {
        let _guard = self.guard();
        self.enable_locked()
    }

    pub(super) fn enable_locked(&self) -> Result<(), AppError> {
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
            self.require_key(Agent::Codex, provider, settings.providers.len() == 1)?;
        }
        let first = self.read_config()?;
        if self.detect_agents_manager(&first.text).is_some() {
            return Err(AppError::new(
                "conflict",
                sophia_core::t!("models.app.takeoverFirst"),
            ));
        }
        // 打开开关、打开 Sophia 接上都走这里：按此刻的登录状态选接法（spec 2026-10-03-codex-hookup-auto R4）
        let (mode, reason) = self.decide_mode(&first.text);
        settings.mode = mode;
        settings.mode_reason = Some(reason);
        let managed = self.managed(&settings);
        // 先在内存里试一次：有冲突或设置不合法，就在产生任何副作用之前退出。
        // 写着另一种形态（换了接法、或崩溃留下的）就先删掉再按这次的写
        let base = self
            .strip_other_form(&first.text, &settings)?
            .unwrap_or_else(|| first.text.clone());
        let trial = config::apply(&base, &managed).map_err(config_error)?;
        if trial.inserted {
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
        // 先起好路由再写清单；端口被别的程序占着时路由换了端口，按新端口写
        self.ensure_router(&mut settings, Untouched::Codex)?;
        let managed = self.managed(&settings);
        self.write_catalogs(&mut settings)?;
        // 起路由、写清单的这段时间里别人可能改过设置：基于最新内容重新生成，绝不拿旧内容覆盖
        let latest = self.read_config()?;
        let stripped = self.strip_other_form(&latest.text, &settings)?;
        let switched = stripped.is_some();
        let applied = config::apply(stripped.as_deref().unwrap_or(&latest.text), &managed)
            .map_err(config_error)?;
        // 已启用时再点启用也会走到这里：默认模型若指向一个已经不在目录里的标识
        // （比如旧的单网关格式迁移后标识带上了前缀），一并改回启用前的值
        let text = reset_default_model(&applied.text, &settings, &retired_slugs(&settings));
        if text != latest.text {
            self.write_config(&latest, &text)?;
        }
        if applied.inserted {
            settings.added_newline = applied.added_newline;
        }
        if applied.changed || switched {
            settings.changed_at = Some((self.deps.now)());
        }
        settings.enabled = Some(true);
        settings.record_change((self.deps.now)(), true);
        self.save(&settings)
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
        let combined = catalog::build_combined(&native.models, &models, settings.mode.is_builtin())
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
                error = atomicfile::write_error_text(path, &e)
            ))
        })
    }

    /// 关掉 Codex 的第三方模型（用户的选择）：从 Codex 设置里移除本功能写的内容（两种接法都删），
    /// 清理本功能文件，两家都关了就停路由。Claude 还开着时路由留着，Codex 的路由清单改成「无生效模型」（R8）
    pub fn restore(&self) -> Result<Vec<String>, AppError> {
        let _guard = self.guard();
        self.restore_locked()
    }

    pub(super) fn restore_locked(&self) -> Result<Vec<String>, AppError> {
        self.unwrite_codex_locked(true)
    }

    /// 把 Codex 设置改回开启前（逐字节）。`user_off`：用户关掉（记下「没开着」、忘掉启用前的默认模型）；
    /// 否则是退出或接不上时的改回，「开着」与启用前默认模型的记录不变，下次打开 Sophia 时接上
    pub(super) fn unwrite_codex_locked(&self, user_off: bool) -> Result<Vec<String>, AppError> {
        let mut settings = match self.load() {
            Ok(settings) => settings,
            // 设置读不出（spec S7）：照样把 Codex 改回官方——这是用户（或命令行）明确要的；
            // 设置本身改不了，告诉调用方
            Err(error) => return self.unwrite_codex_without_settings(error),
        };
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
            (self.deps.router_stop)();
            if user_off {
                self.set_notice(None);
            }
            warnings.extend(self.remove_codex_files(&[]));
        }
        settings.added_newline = false;
        settings.catalog_client_version.clear();
        // published_slugs 不清：没重启过的 Codex 选择器里旧模型还在，下次启用时它们仍要进停用名单
        if user_off {
            settings.prev_model = None;
            settings.had_prev_model = false;
            settings.enabled = Some(false);
        }
        settings.changed_at = Some((self.deps.now)());
        settings.record_change((self.deps.now)(), false);
        self.save(&settings)?;
        Ok(warnings)
    }

    /// 网关设置读不出时的改回（spec S7）：只删本功能写进 Codex 设置的内容、停路由、清自己的文件；
    /// 启用前的默认模型记录在设置里，读不出就还原不了（`model` 原样留着，Codex 自己会报模型不存在）。
    /// 设置文件不写；返回的警告里带上设置读不出这一条
    fn unwrite_codex_without_settings(&self, error: AppError) -> Result<Vec<String>, AppError> {
        let managed = self.managed_fallback();
        let snapshot = self.read_config()?;
        let removed = config::remove(&snapshot.text, &managed, false).map_err(config_error)?;
        let mut warnings = removed.warnings.clone();
        self.write_config(&snapshot, &removed.text)?;
        if config::inspect(&removed.text, &managed).is_ok_and(|i| i.points_at_router) {
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
        (self.deps.router_stop)();
        warnings.extend(self.remove_codex_files(&[]));
        warnings.push(error.to_string());
        log::warn!("改回 Codex 设置时网关设置读不出，设置文件没动：{error}");
        Ok(warnings)
    }

    /// 重启生效：让 Codex 读到新配置。
    ///
    /// 1. 桌面应用（包 id `com.openai.codex`）在运行 → 发退出请求（主进程正常退出，同 ⌘Q；没发成、或 3 秒后还在才 SIGTERM），
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
            preset: None,
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
                        manual: false,
                    },
                    selected: m.selected,
                })
                .collect(),
            unreachable: None,
            unreachable_detail: None,
            key_rejected_on_call: false,
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
        // 先把本功能的目录和路由准备好；这一步失败时对方仍然完好
        if let Err(error) = self
            .write_catalogs(&mut settings)
            .and_then(|()| self.ensure_router(&mut settings, Untouched::Codex))
        {
            // 没成：对方仍然完好，本功能不留下路由和文件
            self.remove_own_traces();
            return Err(error);
        }
        // 路由起好之后才动密钥：失败的接管不能覆盖本功能原有的密钥
        if let Err(error) = (self.deps.set_key)(Agent::Codex, &target, key.trim()) {
            self.remove_own_traces();
            return Err(AppError::new("invalid", error));
        }

        // 从这里往后，密钥已经被覆盖、路由在跑、目录文件已落盘：任何失败都要把这些撤掉，
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
            mode: HookupMode::Builtin,
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
        settings.enabled = Some(true);
        settings.changed_at = Some((self.deps.now)());
        settings.record_change((self.deps.now)(), true);
        self.save(settings)
    }

    /// 停下路由并删掉 Codex 目录下本功能前缀的文件（只删普通文件）。
    /// Claude 开着时路由留着（R8），只删 Codex 目录下的文件
    fn remove_own_traces(&self) {
        if !self.claude_on() {
            (self.deps.router_stop)();
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

    /// 这一家这个网关的密钥：有就给出来（去掉首尾空白）；没有为 `Ok(None)`；读不出为 `Err(原因)`
    fn key_of(&self, agent: Agent, id: &str) -> Result<Option<String>, String> {
        (self.deps.get_key)(agent, id)
            .map(|key| key.map(|k| k.trim().to_owned()).filter(|k| !k.is_empty()))
    }

    /// 有模型要发布的网关必须有读得出的密钥；没有、读不出各说各的（`only` 为真时只有这一家，不点名）
    fn require_key(
        &self,
        agent: Agent,
        provider: &ProviderSettings,
        only: bool,
    ) -> Result<String, AppError> {
        match self.key_of(agent, &provider.id) {
            Ok(Some(key)) => Ok(key),
            Ok(None) => Err(AppError::new(
                "invalid",
                if only {
                    sophia_core::t!("models.app.noKey")
                } else {
                    sophia_core::t!("models.app.providerNoKey", name = provider.name)
                },
            )),
            Err(reason) => Err(AppError::new(
                "invalid",
                sophia_core::t!(
                    "models.app.keyUnreadable",
                    name = provider.name,
                    reason = reason
                ),
            )),
        }
    }

    /// 一家的网关列表视图
    fn provider_views(&self, agent: Agent, providers: &[ProviderSettings]) -> Vec<ProviderView> {
        providers
            .iter()
            .map(|provider| (provider, self.key_of(agent, &provider.id)))
            .map(|(provider, read)| ProviderView {
                id: provider.id.clone(),
                name: provider.name.clone(),
                short_name: provider.short_name(),
                base_url: provider.base_url.clone(),
                protocol: provider.protocol().to_owned(),
                preset: provider.preset.clone(),
                key: match &read {
                    Ok(Some(_)) => KeyStatus::Set,
                    Ok(None) => KeyStatus::Missing,
                    Err(_) => KeyStatus::Unreadable,
                },
                key_problem: read.err(),
                unreachable: provider.unreachable.as_ref().map(UnreachableReason::text),
                unreachable_detail: provider
                    .unreachable
                    .as_ref()
                    .and(provider.unreachable_detail.clone()),
                key_rejected_on_call: provider.unreachable.is_some()
                    && provider.key_rejected_on_call,
                key_invalid: provider.unreachable == Some(UnreachableReason::Auth),
                models: provider
                    .models
                    .iter()
                    .map(|m| ModelView {
                        manual: m.model.manual,
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
        // 读不出 Sophia 自己的设置：照旧当空的往下画，但说出来是哪个文件、为什么（R11），不再悄悄当没有网关
        let my_uid = sophia_core::file_issue::current_uid();
        let mut unreadable: Option<FileIssue> = None;
        let settings = (self.deps.load_settings)().unwrap_or_else(|e| {
            unreadable.get_or_insert_with(|| {
                FileIssue::from_io(&self.settings_path(), &e, my_uid, false)
            });
            GatewaySettings::default()
        });
        let claude_settings = (self.deps.load_claude)().unwrap_or_else(|e| {
            unreadable.get_or_insert_with(|| {
                FileIssue::from_io(&self.settings_path(), &e, my_uid, false)
            });
            ClaudeGatewaySettings::default()
        });
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
        let mut extra = CodexAgentView {
            mode: settings.mode,
            mode_reason: settings.mode_reason,
            ..Default::default()
        };
        let mut codex_points = false;

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
                            codex_points = inspection.points_at_router;
                            if let Some(written) = inspection.mode {
                                extra.mode = written;
                            }
                            codex.conflict = inspection.conflict.unwrap_or_default();
                        }
                        Err(e) => {
                            if let ConfigError::Invalid(detail) = &e {
                                unreadable.get_or_insert_with(|| {
                                    FileIssue::format(
                                        &self.config_path(),
                                        config::invalid_line(&snapshot.text),
                                        detail,
                                    )
                                });
                            }
                            codex.conflict = e.to_string();
                        }
                    }
                }
            }
            Err(e) => {
                // 读本身失败（没权限、IO）：说是哪个文件、哪一种；软链、不是普通文件只当冲突说
                if let Err(ReadError::Io(io)) = atomicfile::read_state(&self.config_path()) {
                    unreadable.get_or_insert_with(|| {
                        FileIssue::from_io(&self.config_path(), &io, my_uid, true)
                    });
                }
                codex.conflict = e.message;
            }
        }

        view.unreadable = unreadable;
        // 路由在本进程里：直接看宿主，不再探 HTTP（也就不在锁里等）
        view.router.port = settings.port;
        view.router.running = (self.deps.router_running)() == Some(settings.port);
        view.port_notice = self.notice();
        let claude_applied = claude_settings.applied.is_some();
        if !view.router.running && (codex_points || claude_applied) {
            let reason = view.port_notice.as_ref().map_or_else(
                || sophia_core::t!("models.app.routerStopped"),
                PortNotice::text,
            );
            view.router.error = if codex_points {
                sophia_core::t!(
                    "models.app.routerNoResponse",
                    port = settings.port,
                    error = reason
                )
            } else {
                sophia_core::t!(
                    "models.claude.routerNoResponse",
                    port = settings.port,
                    error = reason
                )
            };
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
        extra.wanted = settings.enabled.unwrap_or(codex_points);
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
