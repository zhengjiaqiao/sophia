//! 用量的共享类型。前端 `src/types.ts` 与这里一一对应（serde 统一 camelCase）。
//! 时间一律是 Unix 秒（i64）；百分比一律是「已用」0–100，剩余由显示层换算。
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 有用量的 agent。id 与前端 agent 注册表、`AgentIcon` 用的 id 一致
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum AgentId {
    #[serde(rename = "claude-code")]
    ClaudeCode,
    #[serde(rename = "codex")]
    Codex,
}

impl AgentId {
    /// 注册表顺序：默认显示名单、托盘的先后都按它
    pub const ALL: [AgentId; 2] = [AgentId::ClaudeCode, AgentId::Codex];

    /// 给人看的名字（专名，不翻译）
    pub fn label(self) -> &'static str {
        match self {
            AgentId::ClaudeCode => "Claude Code",
            AgentId::Codex => "Codex",
        }
    }

    /// 稳定的字符串 id（与 serde 一致）：用量项的键 `agent:<id>`、菜单栏与前端取标志都用它
    pub fn id(self) -> &'static str {
        match self {
            AgentId::ClaudeCode => "claude-code",
            AgentId::Codex => "codex",
        }
    }

    /// 由 [`AgentId::id`] 认回来；认不出是 None
    pub fn from_id(id: &str) -> Option<AgentId> {
        AgentId::ALL.into_iter().find(|a| a.id() == id)
    }

    /// 托盘块、用量页上的名字（专名）：Claude 的额度属于 Claude 账号（命令行、桌面应用、claude.ai 共用），
    /// 写 `Claude`（产品负责人 2026-09-29）；出错句里说程序时仍用 [`AgentId::label`]
    pub fn display_name(self) -> &'static str {
        match self {
            AgentId::ClaudeCode => "Claude",
            AgentId::Codex => "Codex",
        }
    }
}

/// 用量的「项」：一个 agent，或一个模型提供商（spec #322）。序列化成字符串 `agent:claude-code`、
/// `agent:codex`、`provider:<提供商 id>`：设置里的 `usage.items` / `usage.perItem`、菜单栏段、托盘行、
/// 刷新命令都按它认。派生的 `Ord` 只给有序容器用，页面上的先后见 `format::page_order`
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum UsageSubject {
    Agent(AgentId),
    /// 模型提供商（提供商列表里的 id）。读数在 #325 接入
    Provider(String),
}

const AGENT_PREFIX: &str = "agent:";
const PROVIDER_PREFIX: &str = "provider:";

impl UsageSubject {
    /// 键：`agent:<id>` / `provider:<id>`
    pub fn key(&self) -> String {
        match self {
            UsageSubject::Agent(agent) => format!("{AGENT_PREFIX}{}", agent.id()),
            UsageSubject::Provider(id) => format!("{PROVIDER_PREFIX}{id}"),
        }
    }

    /// 由键认回来；前缀不对、agent id 认不出、提供商 id 为空都是 None
    pub fn parse(key: &str) -> Option<UsageSubject> {
        if let Some(id) = key.strip_prefix(AGENT_PREFIX) {
            return AgentId::from_id(id).map(UsageSubject::Agent);
        }
        key.strip_prefix(PROVIDER_PREFIX)
            .filter(|id| !id.is_empty())
            .map(|id| UsageSubject::Provider(id.to_string()))
    }

    pub fn agent(&self) -> Option<AgentId> {
        match self {
            UsageSubject::Agent(agent) => Some(*agent),
            UsageSubject::Provider(_) => None,
        }
    }

    /// 取标志用的 id：agent 是 agent id；提供商暂用提供商 id（#325 / #326 换成预设 id）
    pub fn brand(&self) -> String {
        match self {
            UsageSubject::Agent(agent) => agent.id().to_string(),
            UsageSubject::Provider(id) => id.clone(),
        }
    }
}

impl std::fmt::Display for UsageSubject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.key())
    }
}

impl Serialize for UsageSubject {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.key())
    }
}

impl<'de> Deserialize<'de> for UsageSubject {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let key = String::deserialize(deserializer)?;
        UsageSubject::parse(&key)
            .ok_or_else(|| serde::de::Error::custom(format!("unknown usage item key: {key}")))
    }
}

/// 读数从哪条取法来（R1、R3）
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// Claude Code 程序化模式的 `get_usage` 控制请求
    GetUsage,
    /// Codex 本机会话记录（rollout JSONL）里的 `token_count.rate_limits`
    Rollout,
    /// `codex app-server` 的 `account/rateLimits/read`
    AppServer,
    /// Claude 桌面应用自己记在本机的用量历史（`plan-usage-history.json`）的最新一条：
    /// 只有 5 小时、本周两个窗口的百分比，没有重置时刻。只在 Claude Code 命令行不可用时读
    DesktopHistory,
}

impl Source {
    /// 只读本机文件（不起进程、不打服务端）：Codex 会话记录、Claude 桌面应用的用量历史。
    /// 调度按「读本机文件」一类对待：最短间隔 30 秒、不受起进程的后台下限与限流退避牵连（见 `schedule`）
    pub fn reads_local_file(self) -> bool {
        matches!(self, Source::Rollout | Source::DesktopHistory)
    }

    /// 这条取法要不要起进程（起进程的最短间隔更长，见 `schedule`）
    pub fn spawns_process(self) -> bool {
        !self.reads_local_file()
    }
}

/// 轻重程度：有服务端的 `severity` 就用它，没有时由解析按阈值给（见 `parse`）
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    #[default]
    Normal,
    Warning,
    /// 已用尽（100%）或服务端给了比 warning 更重的等级
    Critical,
}

/// 窗口名的「种类」：落盘与内存里只存它，界面上的名字由 [`WindowKind::label`] 按当前语言现算
/// （换语言后不用等下次取数）。参数只有分钟数与服务端给的模型名，都不是翻译文字。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum WindowKind {
    /// 5 小时（300 分钟）
    Session,
    /// 本周（10080 分钟）
    Weekly,
    /// 其余时长：整天写「N 天」，否则按四舍五入的小时写「N 小时」
    Minutes { minutes: u32 },
    /// 模型限定的周窗口：「本周 · Fable」
    Model { name: String },
    /// 模型限定、且时长不是一周：「5 小时 · Spark」
    ModelDuration { name: String, minutes: u32 },
    /// 旧版 `usage-last.json` 里只有一句写好的名字、键又认不出来：原样显示（下次取数后被新种类覆盖）
    Legacy { label: String },
}

impl WindowKind {
    /// 由窗口的键认出种类。`session` / `weekly` / `minutes:<N>` / `model:<名>` / `model:<名>:<N>`；
    /// 认不出返回 None。旧文件没有种类字段时靠它重算
    pub fn from_key(key: &str) -> Option<WindowKind> {
        match key {
            "session" => return Some(WindowKind::Session),
            "weekly" => return Some(WindowKind::Weekly),
            _ => {}
        }
        if let Some(minutes) = key.strip_prefix("minutes:") {
            return minutes
                .parse()
                .ok()
                .map(|minutes| WindowKind::Minutes { minutes });
        }
        let model = key.strip_prefix("model:")?;
        // `model:Spark` 与 `model:Spark:300`；名字里带冒号但末段不是数字时整段算名字
        Some(match model.rsplit_once(':') {
            Some((name, m)) => match m.parse::<u32>() {
                Ok(minutes) => WindowKind::ModelDuration {
                    name: name.to_string(),
                    minutes,
                },
                Err(_) => WindowKind::Model {
                    name: model.to_string(),
                },
            },
            None => WindowKind::Model {
                name: model.to_string(),
            },
        })
    }

    /// 界面上的名字（当前语言）：「5 小时」「本周」「本周 · Fable」「1 天」……
    pub fn label(&self) -> String {
        match self {
            WindowKind::Session => crate::t!("usage.window.session"),
            WindowKind::Weekly => crate::t!("usage.window.weekly"),
            WindowKind::Minutes { minutes } => minutes_label(*minutes),
            WindowKind::Model { name } => crate::t!("usage.window.weeklyModel", name = name),
            WindowKind::ModelDuration { name, minutes } => crate::t!(
                "usage.window.durationModel",
                duration = minutes_label(*minutes),
                name = name
            ),
            WindowKind::Legacy { label } => label.clone(),
        }
    }
}

/// 按时长的名字：300 →「5 小时」、10080 →「本周」；整除 1440 就是「N 天」，
/// 否则四舍五入到最近的小时（90 分钟 →「2 小时」）
fn minutes_label(minutes: u32) -> String {
    match minutes {
        300 => crate::t!("usage.window.session"),
        10080 => crate::t!("usage.window.weekly"),
        m if m % 1440 == 0 => crate::tn!("usage.window.days", m / 1440),
        m => crate::tn!("usage.window.hours", (f64::from(m) / 60.0).round() as u32),
    }
}

/// 一个额度窗口（R4）
///
/// 落盘（`usage-last.json`）写 `kind`，同时照旧写一份当前语言的 `label`，让旧版 App 仍读得到；
/// 读入以 `kind` 为准。旧文件里只有 `label` 的，能按 `key` 重算就重算，认不出才退回原句
/// （见 [`WindowKind::Legacy`]）
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", from = "WindowWire")]
pub struct Window {
    /// 稳定的键：`session`、`weekly`、`model:<显示名>`，或按时长的 `minutes:<N>`。设置里记主 / 第二窗口用它
    pub key: String,
    /// 显示名的种类；名字本身用 [`Window::label`] 现算
    pub kind: WindowKind,
    /// 已用百分比 0–100
    pub used_percent: f64,
    /// 重置时刻（Unix 秒）；服务端没给就是 None
    pub resets_at: Option<i64>,
    /// 窗口时长（分钟）；来源没给就是 None
    pub window_minutes: Option<u32>,
    pub severity: Severity,
    /// 服务端标为「此刻正起作用」的窗口（Claude 的 `is_active`）；来源没有这个信息时为 false
    pub active: bool,
}

impl Window {
    /// 显示名（当前语言）：「5 小时」「本周」「本周 · Fable」「本周 · Spark」「1 天」……
    pub fn label(&self) -> String {
        self.kind.label()
    }
}

/// 写盘的形状：`kind` 之外照旧带一句 `label`（旧版 App 的窗口必须有它）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowOut<'a> {
    key: &'a str,
    kind: &'a WindowKind,
    label: String,
    used_percent: f64,
    resets_at: Option<i64>,
    window_minutes: Option<u32>,
    severity: Severity,
    active: bool,
}

impl Serialize for Window {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        WindowOut {
            key: &self.key,
            kind: &self.kind,
            label: self.label(),
            used_percent: self.used_percent,
            resets_at: self.resets_at,
            window_minutes: self.window_minutes,
            severity: self.severity,
            active: self.active,
        }
        .serialize(serializer)
    }
}

/// 读盘用的形状：新文件有 `kind`，旧文件只有 `label`；两者都有时以 `kind` 为准
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowWire {
    key: String,
    kind: Option<WindowKind>,
    label: Option<String>,
    used_percent: f64,
    resets_at: Option<i64>,
    window_minutes: Option<u32>,
    severity: Severity,
    active: bool,
}

impl From<WindowWire> for Window {
    fn from(w: WindowWire) -> Self {
        // 旧文件没有 kind：按 key 重算，但 key 有歧义（`model:y:300` 可能是名叫 `y:300` 的周窗口），
        // 重算出的名字与存下的 label 对不上时，原样显示存下的
        let kind = match (w.kind, w.label) {
            (Some(kind), _) => kind,
            (None, Some(label)) => WindowKind::from_key(&w.key)
                .filter(|kind| kind.label() == label)
                .unwrap_or(WindowKind::Legacy { label }),
            (None, None) => WindowKind::from_key(&w.key).unwrap_or_else(|| WindowKind::Legacy {
                label: w.key.clone(),
            }),
        };
        Window {
            key: w.key,
            kind,
            used_percent: w.used_percent,
            resets_at: w.resets_at,
            window_minutes: w.window_minutes,
            severity: w.severity,
            active: w.active,
        }
    }
}

/// 一次成功取到的读数
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub agent: AgentId,
    pub source: Source,
    /// 数据本身的观测时刻：会话记录用那条记录的 `timestamp`，桌面应用历史用那条样本的时刻，其余用取到的时刻
    pub observed_at: i64,
    pub windows: Vec<Window>,
    /// 套餐名（`max`、`prolite`……），只用于显示和判断，不存账号标识
    pub plan: Option<String>,
}

/// 解析失败的种类：调用方据此决定状态与要不要重试（R5、R7）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseFailure {
    /// 账号没有订阅额度（`rate_limits_available: false`、API key、第三方云）：不重试
    NoPlanLimits,
    /// 服务端说被限流；`until` 是它给的截止时刻，没给就是 None（调用方按 5 分钟退避）
    RateLimited { until: Option<i64> },
    /// 鉴权失败（需要重新登录）
    AuthRequired,
    /// 程序不认这个请求：没有 `get_usage` 的旧版 Claude Code
    Unsupported,
    /// 格式对不上：字段缺失、类型不对、控制请求回了认不出的 error。带一句给人看的原因（不含账号信息）
    Malformed(String),
}

/// 取数失败的原因种类：状态里只存它，界面上的句子由 [`FailReason::text`] 按当前语言现算。
/// agent 名（专名）不存，出句时由 `AgentUsage.agent` 提供
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FailReason {
    NotInstalled,
    NotSignedIn,
    Timeout,
    SpawnFailed,
    NoPlanLimits,
    AuthRequired,
    RateLimited,
    Unsupported,
    Malformed,
}

impl FailReason {
    /// 给人看的一句话原因（当前语言），不含错误码、不含账号信息。`agent` 是「Claude Code」或「Codex」
    pub fn text(self, agent: &str) -> String {
        match self {
            FailReason::NotInstalled => crate::t!("usage.reason.notInstalled", agent = agent),
            FailReason::NotSignedIn => crate::t!("usage.reason.notSignedIn", agent = agent),
            FailReason::Timeout => crate::t!("usage.reason.timeout", agent = agent),
            FailReason::SpawnFailed => crate::t!("usage.reason.spawnFailed", agent = agent),
            FailReason::NoPlanLimits => crate::t!("usage.reason.noPlanLimits"),
            FailReason::AuthRequired => crate::t!("usage.reason.authRequired", agent = agent),
            FailReason::RateLimited => crate::t!("usage.reason.rateLimited", agent = agent),
            FailReason::Unsupported => crate::t!("usage.reason.unsupported", agent = agent),
            FailReason::Malformed => crate::t!("usage.reason.malformed", agent = agent),
        }
    }
}

/// 一个 agent 此刻的状态（托盘、菜单栏、用量页都读它）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum UsageStatus {
    Ok,
    NotInstalled,
    NotSignedIn,
    NoPlanLimits,
    RateLimited {
        until: i64,
    },
    /// 最近一次取数失败；原因只存种类，句子在显示时取（`format`）
    Failing {
        reason: FailReason,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub agent: AgentId,
    pub status: UsageStatus,
    /// 最近一次成功的读数（失败时照常保留，界面标明时间）
    pub reading: Option<Reading>,
    /// 最近一次尝试取数的时刻
    pub attempted_at: Option<i64>,
    /// 这个 agent 的桌面应用装着（只 Claude 看：装了 Claude 桌面应用，命令行不可用、也没有读数时
    /// Claude 块照样出现，给「连接 Claude 用量」，画板 #206 第 7 条）
    #[serde(default)]
    pub desktop_app: bool,
}

/// 电源状态（R6）：过期变淡的阈值要与调度实际的间隔一致，所以格式化也要知道
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerState {
    pub on_battery: bool,
    /// 低电量模式或发热
    pub constrained: bool,
}

/// 一条取法的调度记忆（存 `usage-schedule.json`，重启后接着用）：上次尝试、限流截止
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceMemo {
    pub agent: AgentId,
    pub source: Source,
    pub last_attempt: Option<i64>,
    pub rate_limited_until: Option<i64>,
}

/// 调度记忆：重启后不立刻起进程、不绕过限流退避（2026-09-29）。只有时刻与次数，没有账号信息
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScheduleMemo {
    pub sources: Vec<SourceMemo>,
    /// 每个 agent 连续被限流（没给时间）的次数
    pub rate_limit_streaks: BTreeMap<AgentId, u32>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageState {
    pub agents: Vec<AgentUsage>,
}

// ---------------- 设置（R12，存进 settings.json 的 `usage`） ----------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DisplayMode {
    #[default]
    Remaining,
    Used,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StackedSize {
    /// 9pt（默认）
    #[default]
    Small,
    /// 10pt
    Medium,
    /// 11pt
    Large,
}

/// 刷新节奏（R6）：自动、关、固定分钟。
/// 曾有过「1 分钟」档（`"1"`），已去掉：存着它的老设置读成 5 分钟
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Refresh {
    #[default]
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "off")]
    Off,
    #[serde(rename = "5", alias = "1")]
    Every5,
    #[serde(rename = "10")]
    Every10,
    #[serde(rename = "15")]
    Every15,
}

/// 每个 agent 在菜单栏上怎么显示：主窗口、第二窗口、
/// 叠放与字号都跟着 agent 走。名字沿用 agent，现在也给模型提供商用（设置里的 `perItem`）
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentDisplay {
    /// 主窗口的 `Window.key`；None 表示「自动」（服务端标为起作用的窗口，没有就取用得最多的）
    pub primary: Option<String>,
    /// 第二窗口的 `Window.key`；None 表示「无」
    pub secondary: Option<String>,
    /// 选了第二窗口时，两个窗口上下两行（否则一行「5h 87% | 7d 13%」）
    pub stacked: bool,
    pub stacked_size: StackedSize,
}

/// 用量设置（settings.json 的 `usage`）。
///
/// 读：新键 `items` / `perItem` 在就用新键；不在（或不是数组 / 对象）就从旧版的 `agents` / `perAgent`
/// 迁移（保留前 [`MAX_MENU_BAR_ITEMS`] 项）。认不出、格式不对的项逐个忽略，不让整份 settings.json 解析失败
/// （旧版的 `agents` 只认两家 agent，新值写进去会让旧版把整个文件当损坏挪走，所以另起新键）。
/// 写：只写新键；旧键的原文存在 `legacy_*` 里原样写回，本版本不改它，换回旧版本时照旧读得懂
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "UsageSettingsWire")]
pub struct UsageSettings {
    /// 菜单栏显示数字，默认关
    pub menu_bar_enabled: bool,
    pub display_mode: DisplayMode,
    /// 选进菜单栏的项（集合，最多 [`MAX_MENU_BAR_ITEMS`] 项；先后按页面顺序算，这里不存顺序）。
    /// None 表示没配过：取有用量来源的，按页面顺序
    pub items: Option<Vec<UsageSubject>>,
    /// 每项在菜单栏上怎么显示
    pub per_item: BTreeMap<UsageSubject, AgentDisplay>,
    pub refresh: Refresh,
    /// 旧版 `agents` 的原文：只用来迁移，写回时原样带上
    #[serde(rename = "agents", skip_serializing_if = "Option::is_none")]
    pub legacy_agents: Option<serde_json::Value>,
    /// 旧版 `perAgent` 的原文：同 `legacy_agents`
    #[serde(rename = "perAgent", skip_serializing_if = "Option::is_none")]
    pub legacy_per_agent: Option<serde_json::Value>,
}

impl UsageSettings {
    /// 旧键以盘上那份为准：界面传来的设置里没有（或带了别的）旧键时，存盘前用它换回盘上的原文
    pub fn keep_legacy_keys(&mut self, on_disk: &UsageSettings) {
        self.legacy_agents = on_disk.legacy_agents.clone();
        self.legacy_per_agent = on_disk.legacy_per_agent.clone();
    }
}

/// 读盘的形状：新旧键都先按原文读进来，再在 `From` 里逐项认（见 [`UsageSettings`]）
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct UsageSettingsWire {
    menu_bar_enabled: bool,
    display_mode: DisplayMode,
    items: Option<serde_json::Value>,
    per_item: Option<serde_json::Value>,
    refresh: Refresh,
    agents: Option<serde_json::Value>,
    per_agent: Option<serde_json::Value>,
}

impl From<UsageSettingsWire> for UsageSettings {
    fn from(w: UsageSettingsWire) -> Self {
        let items = w
            .items
            .as_ref()
            .and_then(parse_items)
            .or_else(|| w.agents.as_ref().and_then(migrate_agents));
        let per_item = w
            .per_item
            .as_ref()
            .and_then(parse_per_item)
            .or_else(|| w.per_agent.as_ref().and_then(migrate_per_agent))
            .unwrap_or_default();
        UsageSettings {
            menu_bar_enabled: w.menu_bar_enabled,
            display_mode: w.display_mode,
            items,
            per_item,
            refresh: w.refresh,
            legacy_agents: w.agents,
            legacy_per_agent: w.per_agent,
        }
    }
}

/// 不重复地收进来（保留第一次出现的位置）
fn push_unique(list: &mut Vec<UsageSubject>, subject: UsageSubject) {
    if !list.contains(&subject) {
        list.push(subject);
    }
}

/// `items`：是数组就逐个认（认不出的忽略）；不是数组（含 null）当作没有这个键
fn parse_items(value: &serde_json::Value) -> Option<Vec<UsageSubject>> {
    let mut items = Vec::new();
    for key in value.as_array()?.iter().filter_map(|v| v.as_str()) {
        if let Some(subject) = UsageSubject::parse(key) {
            push_unique(&mut items, subject);
        }
    }
    Some(items)
}

/// `perItem`：是对象就逐个认（键认不出、值格式不对的忽略）；不是对象当作没有这个键
fn parse_per_item(value: &serde_json::Value) -> Option<BTreeMap<UsageSubject, AgentDisplay>> {
    Some(
        value
            .as_object()?
            .iter()
            .filter_map(|(key, v)| {
                Some((
                    UsageSubject::parse(key)?,
                    AgentDisplay::deserialize(v).ok()?,
                ))
            })
            .collect(),
    )
}

/// 旧版 `agents`（有序的 agent id 数组，旧版最多 3 个）→ 前 [`MAX_MENU_BAR_ITEMS`] 项
fn migrate_agents(value: &serde_json::Value) -> Option<Vec<UsageSubject>> {
    let mut items = Vec::new();
    for id in value.as_array()?.iter().filter_map(|v| v.as_str()) {
        if let Some(agent) = AgentId::from_id(id) {
            push_unique(&mut items, UsageSubject::Agent(agent));
        }
    }
    items.truncate(MAX_MENU_BAR_ITEMS);
    Some(items)
}

/// 旧版 `perAgent`（agent id → 显示方式）
fn migrate_per_agent(value: &serde_json::Value) -> Option<BTreeMap<UsageSubject, AgentDisplay>> {
    Some(
        value
            .as_object()?
            .iter()
            .filter_map(|(id, v)| {
                Some((
                    UsageSubject::Agent(AgentId::from_id(id)?),
                    AgentDisplay::deserialize(v).ok()?,
                ))
            })
            .collect(),
    )
}

/// 菜单栏最多显示几项：agent 与模型提供商合计（spec #322；原来是 3 个 agent）
pub const MAX_MENU_BAR_ITEMS: usize = 2;

#[cfg(test)]
mod tests {
    use super::*;

    fn old_window(key: &str, label: &str) -> Window {
        let json = format!(
            r#"{{"key":{key:?},"label":{label:?},"usedPercent":10.0,"resetsAt":null,"windowMinutes":null,"severity":"normal","active":true}}"#
        );
        serde_json::from_str::<WindowWire>(&json).unwrap().into()
    }

    /// 旧版 Claude Code 没有 `get_usage`：给一句能照着做的话（M17）
    #[test]
    fn unsupported_reason_says_update() {
        assert_eq!(
            FailReason::Unsupported.text("Claude Code"),
            "Claude Code 版本可能太旧，更新后再试"
        );
    }

    #[test]
    fn 旧文件只有_label_时按_key_重算_算出来与存下的不一致就原样显示存下的() {
        // 能对上：按 key 重算，换语言跟着换
        assert!(!matches!(
            old_window("session", "5 小时").kind,
            WindowKind::Legacy { .. }
        ));
        assert_eq!(old_window("session", "5 小时").label(), "5 小时");
        // key 有歧义（模型名以「:数字」结尾）：重算成「5 小时 · y」对不上存下的「本周 · y:300」，原样显示
        assert_eq!(
            old_window("model:y:300", "本周 · y:300").label(),
            "本周 · y:300"
        );
        assert_eq!(old_window("model:a:5", "本周 · a:5").label(), "本周 · a:5");
    }
}
