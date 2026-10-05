//! 菜单栏与托盘的文字排版（R9、R10）与设置的默认值解析。由 T4 实现。
//!
//! 全部是纯函数：`now`（当前时刻，Unix 秒）永远由调用方传入，这里不读时钟。绘制层
//! （`src-tauri/src/tray.rs`）只管把这里给的字符串画出来，不重新判断任何业务规则。

use super::model::{
    AgentDisplay, AgentId, AgentUsage, DisplayMode, FailReason, PowerState, Reading, Refresh,
    Severity, Source, StackedSize, UsageSettings, UsageState, UsageStatus, Window,
};
use super::MAX_MENU_BAR_AGENTS;
use serde::Serialize;

// ---------------- 窗口选择（R11：AgentDisplay 的语义） ----------------

/// 主 / 第二窗口怎么选。主窗口 `primary` 为 `None`（「自动」）时取服务端标为「正起作用」的
/// 窗口，没有就取用得最多的（下称「自动」）；`primary` 给了窗口键但这个 agent 当前的窗口里
/// 找不到（设置留存的旧键，窗口集合变了）时，也按「自动」处理。第二窗口 `secondary` 为
/// `None` 表示「无」，不展示；给了键但找不到时，同样按「自动」补一个，不留空。
pub fn resolve_display_windows<'a>(
    display: &AgentDisplay,
    windows: &'a [Window],
) -> (Option<&'a Window>, Option<&'a Window>) {
    let auto = auto_primary_window(windows);
    let primary = match &display.primary {
        None => auto,
        Some(key) => windows.iter().find(|w| &w.key == key).or(auto),
    };
    let secondary = match &display.secondary {
        None => None,
        Some(key) => windows.iter().find(|w| &w.key == key).or(auto),
    };
    (primary, secondary)
}

/// 「自动」：服务端标为正起作用的窗口，没有就取已用百分比最高的；一个窗口都没有就是 `None`
fn auto_primary_window(windows: &[Window]) -> Option<&Window> {
    windows.iter().find(|w| w.active).or_else(|| {
        windows.iter().max_by(|a, b| {
            a.used_percent
                .partial_cmp(&b.used_percent)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    })
}

// ---------------- 倒计时 / 剩余时长的共同底层（R9 AC21、R10 重置时间） ----------------

/// 倒计时按什么单位显示：不到 24 小时用时:分，否则用整天数（四舍五入到分钟 / 天）
enum CountdownUnit {
    HourMinute(i64, i64),
    Days(i64),
}

fn countdown_unit(seconds_left: i64) -> CountdownUnit {
    let seconds_left = seconds_left.max(0);
    let total_minutes = ((seconds_left as f64) / 60.0).round() as i64;
    if total_minutes < 24 * 60 {
        CountdownUnit::HourMinute(total_minutes / 60, total_minutes % 60)
    } else {
        let days = ((total_minutes as f64) / 1440.0).round() as i64;
        CountdownUnit::Days(days)
    }
}

/// 菜单栏倒计时文字（AC21）：不到 24 小时「H:MM」，否则「Nd」。
/// 边界：59 分钟 → 「0:59」，61 分钟 → 「1:01」，25 小时 → 「1d」
fn countdown_text(seconds_left: i64) -> String {
    match countdown_unit(seconds_left) {
        CountdownUnit::HourMinute(h, m) => format!("{h}:{m:02}"),
        CountdownUnit::Days(d) => format!("{d}d"),
    }
}

// ---------------- 百分比与重置状态 ----------------

fn window_has_passed_reset(window: &Window, now: i64) -> bool {
    window.resets_at.is_some_and(|r| r <= now)
}

/// 剩余 / 已用百分比文字（不含重置、倒计时那些特殊情况），四舍五入到整数
fn percent_text(used_percent: f64, mode: DisplayMode) -> String {
    let value = match mode {
        DisplayMode::Remaining => 100.0 - used_percent,
        DisplayMode::Used => used_percent,
    };
    format!("{}%", value.clamp(0.0, 100.0).round() as i64)
}

/// 单个窗口在菜单栏上的取值（R9、AC21、R7）：
/// - 重置时刻已经过了、还没取到新数：按「已重置」处理，菜单栏当 0% 已用显示；
/// - 已用 ≥ 100 且重置时刻还没到：换成倒计时（「2:58」「3d」）；
/// - 其余：正常的百分比（剩余或已用，按 `mode`）。
pub fn window_menu_bar_value(window: &Window, mode: DisplayMode, now: i64) -> String {
    if window_has_passed_reset(window, now) {
        return percent_text(0.0, mode);
    }
    if window.used_percent >= 100.0 {
        if let Some(resets_at) = window.resets_at {
            if resets_at > now {
                return countdown_text(resets_at - now);
            }
        }
    }
    percent_text(window.used_percent, mode)
}

// ---------------- 菜单栏一个 agent 的文字（R9） ----------------

/// 窗口简称：两个窗口并排时写在数前面。
/// 5 小时 `5h`、本周 `7d`、模型窗口写模型名（`Fable`）；别的时长按整天 `1d`、整小时 `12h`，否则分钟 `90m`
pub fn window_short_label(window: &Window) -> String {
    match window.key.as_str() {
        "session" => "5h".to_string(),
        "weekly" => "7d".to_string(),
        key => {
            if let Some(model) = key.strip_prefix("model:") {
                // `model:Spark` → Spark；`model:Spark:300` → Spark 5h
                return match model.rsplit_once(':') {
                    Some((name, m)) => match m.parse::<u32>() {
                        Ok(m) => format!("{name} {}", duration_short(m)),
                        Err(_) => model.to_string(),
                    },
                    None => model.to_string(),
                };
            }
            match key
                .strip_prefix("minutes:")
                .and_then(|m| m.parse::<u32>().ok())
            {
                Some(m) => duration_short(m),
                None => window.label(),
            }
        }
    }
}

fn duration_short(m: u32) -> String {
    if m.is_multiple_of(1440) {
        format!("{}d", m / 1440)
    } else if m.is_multiple_of(60) {
        format!("{}h", m / 60)
    } else {
        format!("{m}m")
    }
}

/// 一个 agent 在菜单栏上的文字（2026-09-26）：
/// - 没有读数（`reading` 是 `None`，或者一个窗口都没有）：单行「—」；
/// - 只有主窗口（第二窗口「无」，或选的就是主窗口那一个）：一个数，不带简称；
/// - 选了第二窗口：两个都显示、数前带简称——叠放关着是一行「5h 87% | 7d 13%」，开着拆成上下两行
pub fn menu_bar_agent_lines(
    reading: Option<&Reading>,
    display: &AgentDisplay,
    mode: DisplayMode,
    now: i64,
) -> Vec<String> {
    let Some(reading) = reading else {
        return vec!["—".to_string()];
    };
    let (primary, secondary) = resolve_display_windows(display, &reading.windows);
    let Some(primary) = primary else {
        return vec!["—".to_string()];
    };
    let primary_value = window_menu_bar_value(primary, mode, now);
    match secondary.filter(|s| s.key != primary.key) {
        Some(secondary) => {
            let first = format!("{} {primary_value}", window_short_label(primary));
            let second = format!(
                "{} {}",
                window_short_label(secondary),
                window_menu_bar_value(secondary, mode, now)
            );
            if display.stacked {
                vec![first, second]
            } else {
                vec![format!("{first} | {second}")]
            }
        }
        None => vec![primary_value],
    }
}

// ---------------- 过期文字与过期标记（R7、R9、R10） ----------------

/// 「N 分钟前更新」/「N 小时前更新」：不到 1 分钟也写「1 分钟前更新」（spec 没有「刚刚」这种
/// 特例，就近取整数分钟）；60 分钟及以上换算成小时（四舍五入）
fn elapsed_text(observed_at: i64, now: i64) -> String {
    let elapsed_secs = (now - observed_at).max(0);
    let minutes = (((elapsed_secs as f64) / 60.0).round() as i64).max(1);
    if minutes < 60 {
        crate::tn!("usage.tray.updatedMinutesAgo", minutes)
    } else {
        let hours = (((minutes as f64) / 60.0).round() as i64).max(1);
        crate::tn!("usage.tray.updatedHoursAgo", hours)
    }
}

/// 菜单栏「读数过期」标记（R9）：观测时刻比当前刷新间隔的 2 倍还旧就算过期，绘制层据此把
/// 这个 agent 的数字整体调淡
pub fn is_stale(observed_at: i64, now: i64, refresh_interval_secs: i64) -> bool {
    now - observed_at > 2 * refresh_interval_secs
}

/// 判断过期用的「当前刷新间隔」（R9）：固定档按它的分钟数（调度也严格按它，R6）；「自动」会在
/// 2–30 分钟之间变，「关」只在打开时取，两者都按最长的 30 分钟算，免得数字随档位忽明忽暗
pub fn stale_interval_secs(refresh: Refresh, power: PowerState) -> i64 {
    // 与调度实际的间隔一致：低电量 / 发热不短于 30 分钟，固定档用电池翻倍（「自动」「关」本来就按 30 分钟）
    let minutes = match refresh {
        Refresh::Every5 => 5,
        Refresh::Every10 => 10,
        Refresh::Every15 => 15,
        Refresh::Auto | Refresh::Off => 30,
    };
    let minutes = if power.on_battery && !matches!(refresh, Refresh::Auto | Refresh::Off) {
        minutes * 2
    } else {
        minutes
    };
    let minutes = if power.constrained {
        minutes.max(30)
    } else {
        minutes
    };
    minutes * 60
}

/// 托盘块头名字后的「N 分钟前更新」（R10：总写，不只在过期时，产品负责人 2026-09-29）
pub fn updated_text(observed_at: i64, now: i64) -> String {
    elapsed_text(observed_at, now)
}

// ---------------- 托盘（R10） ----------------

/// 重置时间的文字：给的窗口里「还没到」的最近一个重置时刻，写全单位、后面加「后重置」——
/// 「2 小时 58 分后重置」「3 小时后重置」「45 分钟后重置」「3 天后重置」，都是经过多少时间（2026-09-30 真机：
/// 「3:45」读成了钟点；菜单栏仍用紧凑的「H:MM」，见 `countdown_text`）。托盘每个窗口各写各的（传一个窗口，见 [`tray_window_row`]）。
/// 一个「还没到」的重置时刻都没有（数据没给，或已经过了却还没取到新数）时返回 `None`，不显示这一段。
pub fn nearest_reset_text(windows: &[Window], now: i64) -> Option<String> {
    let nearest = windows
        .iter()
        .filter_map(|w| w.resets_at)
        .filter(|&r| r > now)
        .min()?;
    Some(match countdown_unit(nearest - now) {
        CountdownUnit::HourMinute(0, m) => crate::tn!("usage.tray.resetInMinutes", m),
        CountdownUnit::HourMinute(h, 0) => crate::tn!("usage.tray.resetInHours", h),
        CountdownUnit::HourMinute(h, m) => crate::tn!("usage.tray.resetInHoursMinutes", h, m = m),
        CountdownUnit::Days(d) => crate::tn!("usage.tray.resetInDays", d),
    })
}

/// 托盘一个窗口行的数据（R10：名字、进度条、百分比；进度条和文字用同一种刻度）
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayWindowRow {
    pub label: String,
    /// 百分比文字（按 `DisplayMode`，带「剩 / 用」：「剩 93%」），重置时刻已过、还没取到新数时是「已重置」
    pub percent_text: String,
    /// 进度条刻度 0–100：剩余模式下也换算成「剩余」的刻度，和 `percent_text` 保持一致
    pub gauge_percent: f64,
    /// 服务端 severity 为 warning 或更重时为真：这一行要整行加粗（R10：不用红色/橙色）
    pub emphasize: bool,
    /// 这个窗口多久后重置：「4 小时 19 分后重置」「6 天后重置」；已经过了或没给是 None
    pub reset_text: Option<String>,
}

/// 见 [`TrayWindowRow`]
pub fn tray_window_row(window: &Window, mode: DisplayMode, now: i64) -> TrayWindowRow {
    let reset_passed = window_has_passed_reset(window, now);
    let used_percent = if reset_passed {
        0.0
    } else {
        window.used_percent
    };
    // 托盘里写明是剩还是用：只写「93%」分不出是哪种
    let percent_text = if reset_passed {
        crate::t!("usage.tray.resetDone")
    } else {
        let percent = percent_text(used_percent, mode);
        match mode {
            DisplayMode::Remaining => crate::t!("usage.tray.remaining", percent = percent),
            DisplayMode::Used => crate::t!("usage.tray.used", percent = percent),
        }
    };
    let gauge_percent = match mode {
        DisplayMode::Remaining => 100.0 - used_percent,
        DisplayMode::Used => used_percent,
    };
    TrayWindowRow {
        label: window.label(),
        percent_text,
        gauge_percent: gauge_percent.clamp(0.0, 100.0),
        // 已经重置过的窗口不按旧的紧张程度加粗
        emphasize: !reset_passed
            && matches!(window.severity, Severity::Warning | Severity::Critical),
        reset_text: nearest_reset_text(std::slice::from_ref(window), now),
    }
}

// ---------------- 默认 agent 列表（R12） ----------------

/// 「显示哪些 agent」的默认值：检测到已登录的 agent，按 `AgentId::ALL` 的顺序，
/// 最多 `MAX_MENU_BAR_AGENTS` 个
pub fn default_agents(signed_in: &[AgentId]) -> Vec<AgentId> {
    AgentId::ALL
        .into_iter()
        .filter(|id| signed_in.contains(id))
        .take(MAX_MENU_BAR_AGENTS)
        .collect()
}

/// 有效的显示 agent 列表：设置里配置过（`UsageSettings.agents` 是 `Some`）就用配置的
/// （截到最多 `MAX_MENU_BAR_AGENTS` 个，防御性处理——正常写入的设置不会超）；
/// 没配置过（`None`，包括全新安装）就是默认值（见 [`default_agents`]）
pub fn effective_agents(settings: &UsageSettings, signed_in: &[AgentId]) -> Vec<AgentId> {
    match &settings.agents {
        Some(agents) => agents.iter().copied().take(MAX_MENU_BAR_AGENTS).collect(),
        None => default_agents(signed_in),
    }
}

// ---------------- 菜单栏整段（R9） ----------------

/// 菜单栏上一个 agent 的一段
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuBarSegment {
    pub agent: AgentId,
    /// 一行或两行（见 [`menu_bar_agent_lines`]）
    pub lines: Vec<String>,
    /// 读数过期：整段变淡
    pub stale: bool,
    pub stacked_size: StackedSize,
}

/// 菜单栏要画的全部：Sophia 图标后面的各段。没有悬停提示（产品负责人 2026-09-29：点一下就出面板，
/// 悬停再说一遍是重复），菜单栏按钮的提示仍是建托盘时的「Sophia」
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuBarView {
    /// 空：只有 Sophia 图标（菜单栏显示关着）
    pub segments: Vec<MenuBarSegment>,
}

/// 由状态与设置算出菜单栏（R9）。显示哪些 agent 按 [`effective_agents`]，「已登录」指状态不是
/// 没登录、没找到；每段的过期按 [`stale_interval_secs`] 的 2 倍（[`is_stale`]）
pub fn menu_bar_view(
    state: &UsageState,
    settings: &UsageSettings,
    power: PowerState,
    now: i64,
) -> MenuBarView {
    if !settings.menu_bar_enabled {
        return MenuBarView {
            segments: Vec::new(),
        };
    }
    let signed_in: Vec<AgentId> = state
        .agents
        .iter()
        .filter(|a| signed_in(&a.status))
        .map(|a| a.agent)
        .collect();
    let mut segments = Vec::new();
    for agent in effective_agents(settings, &signed_in) {
        let display = settings.per_agent.get(&agent).cloned().unwrap_or_default();
        let reading = state
            .agents
            .iter()
            .find(|a| a.agent == agent)
            .and_then(|a| a.reading.as_ref());
        let lines = menu_bar_agent_lines(reading, &display, settings.display_mode, now);
        let stale = reading.is_some_and(|r| {
            is_stale(
                r.observed_at,
                now,
                stale_interval_secs(settings.refresh, power),
            )
        });
        segments.push(MenuBarSegment {
            agent,
            lines,
            stale,
            stacked_size: display.stacked_size,
        });
    }
    MenuBarView { segments }
}

// ---------------- 用量视图（托盘与用量页共用，R7 R10 R11） ----------------

/// 托盘里一个 agent 的用量（R10）：块头名字后的「N 分钟前更新」、各窗口（一窗口一行，各带重置时间）、一句状态
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayUsage {
    pub agent: AgentId,
    /// 块头名字后的「3 分钟前更新」：有读数就写（R10）；还没有读数是 None
    pub updated_text: Option<String>,
    pub windows: Vec<TrayWindowRow>,
    /// 取不到新数的原因、被限流还要等多久、没有订阅额度、还没有读数；正常时 None
    pub note: Option<String>,
    /// 原因行右端给不给「再试一次」：只在再试可能有用的原因后面给（见 [`can_retry`]）
    pub retry: bool,
}

/// 给前端的窗口：同 [`Window`]，但名字是按当前语言算好的一句（内存与落盘里只存种类）
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowView {
    pub key: String,
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<i64>,
    pub window_minutes: Option<u32>,
    pub severity: Severity,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingView {
    pub agent: AgentId,
    pub source: Source,
    pub observed_at: i64,
    pub windows: Vec<WindowView>,
    pub plan: Option<String>,
}

/// 给前端的状态：形状同 [`UsageStatus`]，失败原因是按当前语言算好的一句
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum UsageStatusView {
    Ok,
    NotInstalled,
    NotSignedIn,
    NoPlanLimits,
    RateLimited { until: i64 },
    Failing { reason: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageView {
    pub agent: AgentId,
    pub status: UsageStatusView,
    pub reading: Option<ReadingView>,
    pub attempted_at: Option<i64>,
}

/// 给前端的 [`UsageState`]：JSON 形状不变，文字按当前语言现算
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStateView {
    pub agents: Vec<AgentUsageView>,
}

impl UsageStateView {
    pub fn from_state(state: &UsageState) -> Self {
        UsageStateView {
            agents: state
                .agents
                .iter()
                .map(|a| AgentUsageView {
                    agent: a.agent,
                    status: match &a.status {
                        UsageStatus::Ok => UsageStatusView::Ok,
                        UsageStatus::NotInstalled => UsageStatusView::NotInstalled,
                        UsageStatus::NotSignedIn => UsageStatusView::NotSignedIn,
                        UsageStatus::NoPlanLimits => UsageStatusView::NoPlanLimits,
                        UsageStatus::RateLimited { until } => {
                            UsageStatusView::RateLimited { until: *until }
                        }
                        UsageStatus::Failing { reason } => UsageStatusView::Failing {
                            reason: reason.text(a.agent.label()),
                        },
                    },
                    reading: a.reading.as_ref().map(|r| ReadingView {
                        agent: r.agent,
                        source: r.source,
                        observed_at: r.observed_at,
                        windows: r
                            .windows
                            .iter()
                            .map(|w| WindowView {
                                key: w.key.clone(),
                                label: w.label(),
                                used_percent: w.used_percent,
                                resets_at: w.resets_at,
                                window_minutes: w.window_minutes,
                                severity: w.severity,
                                active: w.active,
                            })
                            .collect(),
                        plan: r.plan.clone(),
                    }),
                    attempted_at: a.attempted_at,
                })
                .collect(),
        }
    }
}

/// 托盘、用量页、菜单栏共用的一份视图（spec 第 6 节 `usage_view`）：文字全在这里算好，
/// 前端只管画，不另写一份倒计时与百分比规则
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageView {
    pub state: UsageStateView,
    pub settings: UsageSettings,
    /// 已登录的 agent（状态不是没登录、没找到），按 `AgentId::ALL`
    pub signed_in: Vec<AgentId>,
    /// 托盘各块的用量，只含已登录的 agent
    pub tray: Vec<TrayUsage>,
    /// 用量页的预览：打开菜单栏显示后会是的样子（开关关着也照样算）
    pub menu_bar: MenuBarView,
}

/// 这个 agent 要不要列出来：登录了就列，找不到程序也列（说「没找到」，R5）；没登录不列。
/// 「找不到程序」只在登录了之后才会判出来（见 gateway 的可用性判断）
fn signed_in(status: &UsageStatus) -> bool {
    !matches!(status, UsageStatus::NotSignedIn)
}

/// 托盘里那一句状态（R7「写成人话，不写错误码」）
fn tray_note(usage: &AgentUsage, now: i64) -> Option<String> {
    match &usage.status {
        UsageStatus::RateLimited { until } if *until > now => {
            let minutes = (until - now + 59) / 60;
            Some(crate::tn!("usage.tray.rateLimitedFor", minutes))
        }
        UsageStatus::RateLimited { .. } => Some(crate::t!("usage.tray.rateLimitedLater")),
        UsageStatus::Failing { reason } => Some(reason.text(usage.agent.label())),
        UsageStatus::NoPlanLimits => Some(crate::t!("usage.reason.noPlanLimits")),
        UsageStatus::NotInstalled => Some(crate::t!(
            "usage.reason.notInstalled",
            agent = usage.agent.label()
        )),
        UsageStatus::Ok if usage.reading.is_none() => Some(crate::t!("usage.tray.noReading")),
        _ => None,
    }
}

/// 原因行后给不给「再试一次」（2026-10-03 产品负责人）：版本可能太旧（多半刚更新完）、没有回应、没能启动、
/// 认不出、没找到——这些再试可能就好了。被限流（要等退避，点了也不会取）、没有订阅额度、要登录（点了也没用）、
/// 还没有读数（没失败过，取数本来就在路上）不给
pub fn can_retry(status: &UsageStatus) -> bool {
    match status {
        UsageStatus::NotInstalled => true,
        UsageStatus::Failing { reason } => matches!(
            reason,
            FailReason::Unsupported
                | FailReason::Timeout
                | FailReason::SpawnFailed
                | FailReason::Malformed
                | FailReason::NotInstalled
        ),
        UsageStatus::Ok
        | UsageStatus::NotSignedIn
        | UsageStatus::NoPlanLimits
        | UsageStatus::RateLimited { .. } => false,
    }
}

/// 由状态与设置算出整份视图
pub fn usage_view(
    state: &UsageState,
    settings: &UsageSettings,
    power: PowerState,
    now: i64,
) -> UsageView {
    let mut signed = Vec::new();
    let mut tray = Vec::new();
    for agent in AgentId::ALL {
        let Some(usage) = state
            .agents
            .iter()
            .find(|a| a.agent == agent && signed_in(&a.status))
        else {
            continue;
        };
        signed.push(agent);
        let reading = usage.reading.as_ref();
        tray.push(TrayUsage {
            agent,
            updated_text: reading.map(|r| updated_text(r.observed_at, now)),
            windows: reading
                .map(|r| {
                    r.windows
                        .iter()
                        .map(|w| tray_window_row(w, settings.display_mode, now))
                        .collect()
                })
                .unwrap_or_default(),
            note: tray_note(usage, now),
            retry: can_retry(&usage.status),
        });
    }
    UsageView {
        state: UsageStateView::from_state(state),
        settings: settings.clone(),
        signed_in: signed,
        tray,
        // 预览：关着也画打开后的样子（菜单栏本身由 menu_bar_view 按真实开关画）
        menu_bar: menu_bar_view(
            state,
            &UsageSettings {
                menu_bar_enabled: true,
                ..settings.clone()
            },
            power,
            now,
        ),
    }
}

#[cfg(test)]
mod tests {
    use crate::usage::model::{AgentUsage, UsageStatus};

    /// R9「超过当前刷新间隔的 2 倍」里的「当前刷新间隔」：固定档严格按档位（两个 agent 一样）
    #[test]
    fn stale_interval_by_refresh() {
        let ac = PowerState::default();
        assert_eq!(stale_interval_secs(Refresh::Every5, ac), 300);
        assert_eq!(stale_interval_secs(Refresh::Every10, ac), 600);
        assert_eq!(stale_interval_secs(Refresh::Auto, ac), 1800);
        assert_eq!(stale_interval_secs(Refresh::Off, ac), 1800);
        // 与调度实际的间隔一致（2026-09-29 代码评审）：固定档用电池翻倍，低电量 / 发热不短于 30 分钟
        let battery = PowerState {
            on_battery: true,
            constrained: false,
        };
        let low = PowerState {
            on_battery: false,
            constrained: true,
        };
        assert_eq!(stale_interval_secs(Refresh::Every5, battery), 600);
        assert_eq!(stale_interval_secs(Refresh::Every5, low), 1800);
        assert_eq!(stale_interval_secs(Refresh::Auto, battery), 1800);
    }

    use super::*;
    use crate::usage::model::{Source, StackedSize, WindowKind};

    fn window(key: &str, label: &str, used_percent: f64, resets_at: Option<i64>) -> Window {
        Window {
            key: key.to_string(),
            kind: WindowKind::from_key(key).unwrap_or_else(|| WindowKind::Legacy {
                label: label.to_string(),
            }),
            used_percent,
            resets_at,
            window_minutes: None,
            severity: Severity::Normal,
            active: false,
        }
    }

    fn reading(windows: Vec<Window>) -> Reading {
        Reading {
            agent: AgentId::ClaudeCode,
            source: Source::GetUsage,
            observed_at: 0,
            windows,
            plan: None,
        }
    }

    // ---------------- 用量视图（托盘与用量页共用，R7 R10） ----------------

    fn signed_in_view(status: UsageStatus, reading: Option<Reading>, now: i64) -> UsageView {
        let state = UsageState {
            agents: vec![
                agent_usage(AgentId::ClaudeCode, status, reading),
                agent_usage(AgentId::Codex, UsageStatus::NotSignedIn, None),
            ],
        };
        usage_view(
            &state,
            &UsageSettings::default(),
            PowerState::default(),
            now,
        )
    }

    /// R10：只列已登录的 agent；块头名字后是最近一次重置；各窗口按剩余模式给文字与刻度
    #[test]
    fn view_tray_lists_signed_in_agents_with_windows() {
        let now = 100_000;
        let mut weekly = window("weekly", "本周", 90.0, Some(now + 3 * 86400));
        weekly.severity = Severity::Warning;
        let r = at(
            AgentId::ClaudeCode,
            now - 60,
            vec![
                window("session", "5 小时", 7.0, Some(now + 2 * 3600 + 58 * 60)),
                weekly,
            ],
        );
        let v = signed_in_view(UsageStatus::Ok, Some(r), now);
        assert_eq!(v.tray.len(), 1, "Codex 没登录，不列");
        let t = &v.tray[0];
        assert_eq!(t.agent, AgentId::ClaudeCode);
        assert_eq!(t.updated_text.as_deref(), Some("1 分钟前更新"));
        assert_eq!(t.note, None);
        assert_eq!(
            t.windows
                .iter()
                .map(|w| (
                    w.label.as_str(),
                    w.percent_text.as_str(),
                    w.gauge_percent,
                    w.emphasize,
                    w.reset_text.as_deref()
                ))
                .collect::<Vec<_>>(),
            vec![
                ("5 小时", "剩 93%", 93.0, false, Some("2 小时 58 分后重置")),
                ("本周", "剩 10%", 10.0, true, Some("3 天后重置"))
            ],
            "每个窗口各写自己的重置时间"
        );
        assert_eq!(v.signed_in, vec![AgentId::ClaudeCode]);
    }

    /// R10：块头名字后总写「N 分钟前更新」，不只在过期时（产品负责人 2026-09-29）；没有读数就不写
    #[test]
    fn view_tray_always_says_when_updated() {
        let now = 100_000;
        let w = vec![window("session", "5 小时", 7.0, None)];
        let updated = |ago: i64| {
            signed_in_view(
                UsageStatus::Ok,
                Some(at(AgentId::ClaudeCode, now - ago, w.clone())),
                now,
            )
            .tray[0]
                .updated_text
                .clone()
        };
        assert_eq!(updated(2 * 3600).as_deref(), Some("2 小时前更新"));
        assert_eq!(updated(3 * 60).as_deref(), Some("3 分钟前更新"));
        assert_eq!(
            updated(0).as_deref(),
            Some("1 分钟前更新"),
            "不到 1 分钟也写 1 分钟"
        );
        assert_eq!(
            signed_in_view(UsageStatus::Ok, None, now).tray[0].updated_text,
            None
        );
    }

    /// R7：失败写成人话；被限流说还要等多久；没有订阅额度；还没有读数
    #[test]
    fn view_tray_note_by_status() {
        let now = 100_000;
        let note = |status: UsageStatus| signed_in_view(status, None, now).tray[0].note.clone();
        assert_eq!(
            note(UsageStatus::RateLimited {
                until: now + 5 * 60
            }),
            Some("被限流，约 5 分钟后再试".to_string())
        );
        assert_eq!(
            note(UsageStatus::RateLimited { until: now + 61 }),
            Some("被限流，约 2 分钟后再试".to_string()),
            "不足整分钟往上取"
        );
        assert_eq!(
            note(UsageStatus::RateLimited { until: now - 1 }),
            Some("被限流，稍后再试".to_string())
        );
        assert_eq!(
            note(UsageStatus::Failing {
                reason: FailReason::Timeout
            }),
            Some("Claude Code 没有回应".to_string())
        );
        assert_eq!(
            note(UsageStatus::NoPlanLimits),
            Some("这个账号没有订阅额度".to_string())
        );
        assert_eq!(note(UsageStatus::Ok), Some("还没有读数".to_string()));
    }

    /// 状态与窗口名在内存里只存种类；给前端的视图里是按当前语言算好的句子，JSON 形状不变
    #[test]
    fn view_state_serializes_computed_label_and_failing_reason() {
        let r = reading(vec![
            window("session", "x", 7.0, None),
            window("model:Spark:300", "x", 8.0, None),
            window("没见过的键", "旧句", 9.0, None),
        ]);
        let v = signed_in_view(
            UsageStatus::Failing {
                reason: FailReason::Timeout,
            },
            Some(r),
            1000,
        );
        let json = serde_json::to_value(&v).unwrap();
        let agent = &json["state"]["agents"][0];
        assert_eq!(
            agent["status"],
            serde_json::json!({"kind": "failing", "reason": "Claude Code 没有回应"})
        );
        let labels: Vec<_> = agent["reading"]["windows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["label"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(labels, ["5 小时", "5 小时 · Spark", "旧句"]);
        assert!(agent["reading"]["windows"][0].get("kind").is_none());
    }

    /// 「再试一次」只跟在再试可能有用的原因后面（2026-10-03 产品负责人）：版本可能太旧、没有回应、
    /// 没能启动、认不出、没找到；被限流（等退避）、没有订阅额度、要登录、还没有读数（没失败过）不给
    #[test]
    fn view_tray_retry_by_status() {
        let now = 100_000;
        let retry = |status: UsageStatus| signed_in_view(status, None, now).tray[0].retry;
        let failing = |reason: FailReason| retry(UsageStatus::Failing { reason });
        for (reason, want) in [
            (FailReason::Unsupported, true),
            (FailReason::Timeout, true),
            (FailReason::SpawnFailed, true),
            (FailReason::Malformed, true),
            (FailReason::NotInstalled, true),
            (FailReason::RateLimited, false),
            (FailReason::NoPlanLimits, false),
            (FailReason::NotSignedIn, false),
            (FailReason::AuthRequired, false),
        ] {
            assert_eq!(failing(reason), want, "{reason:?}");
        }
        assert!(retry(UsageStatus::NotInstalled), "没找到（可用性判出来的）");
        assert!(!retry(UsageStatus::RateLimited { until: now + 60 }));
        assert!(!retry(UsageStatus::RateLimited { until: now - 1 }));
        assert!(!retry(UsageStatus::NoPlanLimits));
        assert!(!retry(UsageStatus::Ok), "还没有读数、也没失败过");
        let ok = signed_in_view(
            UsageStatus::Ok,
            Some(at(
                AgentId::ClaudeCode,
                now,
                vec![window("session", "5 小时", 7.0, None)],
            )),
            now,
        );
        assert!(!ok.tray[0].retry);
        // 失败时照常画上一次的读数，原因行后照样给
        let stale = signed_in_view(
            UsageStatus::Failing {
                reason: FailReason::Timeout,
            },
            Some(at(
                AgentId::ClaudeCode,
                now - 3600,
                vec![window("session", "5 小时", 7.0, None)],
            )),
            now,
        );
        assert!(stale.tray[0].retry);
        assert_eq!(
            serde_json::to_value(&stale.tray[0]).unwrap()["retry"],
            serde_json::json!(true)
        );
    }

    /// R5：登录了但找不到程序时照样列出这个 agent，写「没找到 Claude Code」；没登录才不列
    #[test]
    fn view_not_installed_but_signed_in_is_listed_with_note() {
        let now = 100_000;
        let v = signed_in_view(UsageStatus::NotInstalled, None, now);
        assert_eq!(v.signed_in, vec![AgentId::ClaudeCode]);
        assert_eq!(v.tray[0].note.as_deref(), Some("没找到 Claude Code"));
        let hidden = signed_in_view(UsageStatus::NotSignedIn, None, now);
        assert!(hidden.tray.is_empty());
    }

    /// 用量页的预览：菜单栏显示关着时也画「打开后会是什么样」（R11）
    #[test]
    fn view_menu_bar_previews_even_when_menu_bar_is_off() {
        let now = 100_000;
        let state = UsageState {
            agents: vec![agent_usage(
                AgentId::Codex,
                UsageStatus::Ok,
                Some(at(
                    AgentId::Codex,
                    now,
                    vec![window("weekly", "本周", 57.0, None)],
                )),
            )],
        };
        let off = UsageSettings::default();
        let on = UsageSettings {
            menu_bar_enabled: true,
            ..UsageSettings::default()
        };
        let preview = usage_view(&state, &off, PowerState::default(), now).menu_bar;
        assert_eq!(
            preview,
            menu_bar_view(&state, &on, PowerState::default(), now)
        );
        assert_eq!(preview.segments.len(), 1);
    }

    /// 用量页的预览与菜单栏同一份结果
    #[test]
    fn view_menu_bar_is_the_same_as_menu_bar_view() {
        let now = 100_000;
        let state = UsageState {
            agents: vec![agent_usage(
                AgentId::Codex,
                UsageStatus::Ok,
                Some(at(
                    AgentId::Codex,
                    now,
                    vec![window("weekly", "本周", 57.0, None)],
                )),
            )],
        };
        let settings = UsageSettings {
            menu_bar_enabled: true,
            ..UsageSettings::default()
        };
        assert_eq!(
            usage_view(&state, &settings, PowerState::default(), now).menu_bar,
            menu_bar_view(&state, &settings, PowerState::default(), now)
        );
    }

    // ---------------- 菜单栏整段（R9） ----------------

    fn agent_usage(agent: AgentId, status: UsageStatus, reading: Option<Reading>) -> AgentUsage {
        AgentUsage {
            agent,
            status,
            reading,
            attempted_at: None,
        }
    }

    fn at(agent: AgentId, observed_at: i64, windows: Vec<Window>) -> Reading {
        Reading {
            agent,
            observed_at,
            ..reading(windows)
        }
    }

    #[test]
    fn menu_bar_off_is_icon_only() {
        let v = menu_bar_view(
            &UsageState::default(),
            &UsageSettings::default(),
            PowerState::default(),
            0,
        );
        assert!(v.segments.is_empty());
    }

    #[test]
    fn menu_bar_default_agents_are_signed_in_ones() {
        let now = 10_000;
        let state = UsageState {
            agents: vec![
                agent_usage(AgentId::ClaudeCode, UsageStatus::NotSignedIn, None),
                agent_usage(
                    AgentId::Codex,
                    UsageStatus::Ok,
                    Some(at(
                        AgentId::Codex,
                        now - 60,
                        vec![window("weekly", "本周", 57.0, None)],
                    )),
                ),
            ],
        };
        let settings = UsageSettings {
            menu_bar_enabled: true,
            ..UsageSettings::default()
        };
        let v = menu_bar_view(&state, &settings, PowerState::default(), now);
        assert_eq!(
            v.segments,
            vec![MenuBarSegment {
                agent: AgentId::Codex,
                lines: vec!["43%".into()],
                stale: false,
                stacked_size: StackedSize::Small,
            }]
        );
    }

    /// AC17：2 小时没取到新数就变淡；没有读数显示「—」且不算过期
    #[test]
    fn menu_bar_stale_and_missing() {
        let now = 100_000;
        let state = UsageState {
            agents: vec![
                agent_usage(
                    AgentId::ClaudeCode,
                    UsageStatus::Ok,
                    Some(at(
                        AgentId::ClaudeCode,
                        now - 2 * 3600,
                        vec![window("session", "5 小时", 13.0, None)],
                    )),
                ),
                agent_usage(AgentId::Codex, UsageStatus::Ok, None),
            ],
        };
        let settings = UsageSettings {
            menu_bar_enabled: true,
            ..UsageSettings::default()
        };
        let v = menu_bar_view(&state, &settings, PowerState::default(), now);
        assert_eq!(v.segments.len(), 2);
        assert!(v.segments[0].stale);
        assert_eq!(v.segments[1].lines, vec!["—".to_string()]);
        assert!(!v.segments[1].stale);
    }

    // ---------------- 倒计时边界（AC21） ----------------

    #[test]
    fn ac21_countdown_59_minutes() {
        assert_eq!(countdown_text(59 * 60), "0:59");
    }

    #[test]
    fn ac21_countdown_61_minutes() {
        assert_eq!(countdown_text(61 * 60), "1:01");
    }

    #[test]
    fn ac21_countdown_25_hours() {
        assert_eq!(countdown_text(25 * 3600), "1d");
    }

    #[test]
    fn ac21_exhausted_window_shows_countdown_not_zero_percent() {
        let now = 1_000_000;
        let w = window("weekly", "本周", 100.0, Some(now + 61 * 60));
        assert_eq!(
            window_menu_bar_value(&w, DisplayMode::Remaining, now),
            "1:01"
        );
        assert_eq!(window_menu_bar_value(&w, DisplayMode::Used, now), "1:01");
    }

    #[test]
    fn exhausted_window_without_future_reset_shows_percent() {
        let now = 1_000_000;
        let w = window("weekly", "本周", 100.0, None);
        assert_eq!(window_menu_bar_value(&w, DisplayMode::Remaining, now), "0%");
        assert_eq!(window_menu_bar_value(&w, DisplayMode::Used, now), "100%");
    }

    // ---------------- 已过重置时刻（AC17「已重置」） ----------------

    #[test]
    fn ac17_passed_reset_is_zero_percent_on_menu_bar() {
        let now = 1_000_000;
        let w = window("weekly", "本周", 87.0, Some(now - 1));
        assert_eq!(
            window_menu_bar_value(&w, DisplayMode::Remaining, now),
            "100%"
        );
        assert_eq!(window_menu_bar_value(&w, DisplayMode::Used, now), "0%");
    }

    #[test]
    fn ac17_passed_reset_shows_as_reset_label_on_tray() {
        let now = 1_000_000;
        let w = window("weekly", "本周", 87.0, Some(now - 1));
        let row = tray_window_row(&w, DisplayMode::Remaining, now);
        assert_eq!(row.percent_text, "已重置");
        assert_eq!(row.gauge_percent, 100.0);
        assert_eq!(row.reset_text, None, "已经重置过，不再写多久后重置");
    }

    /// 已经重置过的窗口不再按旧的紧张程度加粗
    #[test]
    fn passed_reset_is_not_emphasized() {
        let now = 1_000_000;
        let mut w = window("weekly", "本周", 95.0, Some(now - 1));
        w.severity = Severity::Warning;
        assert!(!tray_window_row(&w, DisplayMode::Remaining, now).emphasize);
    }

    #[test]
    fn future_reset_is_not_treated_as_passed() {
        let now = 1_000_000;
        let w = window("weekly", "本周", 50.0, Some(now + 1));
        let row = tray_window_row(&w, DisplayMode::Used, now);
        assert_eq!(row.percent_text, "用 50%");
        let row = tray_window_row(&w, DisplayMode::Remaining, now);
        assert_eq!(row.percent_text, "剩 50%", "托盘里写明剩还是用");
    }

    // ---------------- 过期文字 / 过期标记 ----------------

    #[test]
    fn ac17_two_hours_shows_hours_text() {
        let now = 1_000_000;
        assert_eq!(updated_text(now - 2 * 3600, now), "2 小时前更新");
        assert_eq!(updated_text(now - 59 * 60, now), "59 分钟前更新");
    }

    #[test]
    fn ac17_menu_bar_stale_flag_boundary() {
        let refresh = 300; // 5 分钟档
        let now = 1_000_000;
        // 恰好 2 倍：还不算过期（严格大于才算）
        assert!(!is_stale(now - 600, now, refresh));
        assert!(is_stale(now - 601, now, refresh));
    }

    // ---------------- 主 / 第二窗口选择 ----------------

    #[test]
    fn auto_primary_picks_active_window() {
        let mut a = window("session", "5 小时", 5.0, None);
        let mut b = window("weekly", "本周", 87.0, None);
        b.active = true;
        a.active = false;
        let windows = vec![a, b.clone()];
        let display = AgentDisplay::default();
        let (primary, secondary) = resolve_display_windows(&display, &windows);
        assert_eq!(primary.unwrap().key, "weekly");
        assert_eq!(secondary, None);
    }

    #[test]
    fn auto_primary_picks_highest_used_when_none_active() {
        let a = window("session", "5 小时", 5.0, None);
        let b = window("weekly", "本周", 87.0, None);
        let windows = vec![a, b];
        let display = AgentDisplay::default();
        let (primary, _) = resolve_display_windows(&display, &windows);
        assert_eq!(primary.unwrap().key, "weekly");
    }

    #[test]
    fn unknown_primary_key_falls_back_to_auto() {
        let a = window("session", "5 小时", 5.0, None);
        let windows = vec![a];
        let display = AgentDisplay {
            primary: Some("stale-key".to_string()),
            ..Default::default()
        };
        let (primary, _) = resolve_display_windows(&display, &windows);
        assert_eq!(primary.unwrap().key, "session");
    }

    #[test]
    fn secondary_none_means_no_second_window() {
        let a = window("session", "5 小时", 5.0, None);
        let b = window("weekly", "本周", 87.0, None);
        let windows = vec![a, b];
        let display = AgentDisplay::default();
        let (_, secondary) = resolve_display_windows(&display, &windows);
        assert_eq!(secondary, None);
    }

    // ---------------- 菜单栏一 / 两行 ----------------

    #[test]
    fn no_reading_shows_dash() {
        assert_eq!(
            menu_bar_agent_lines(None, &AgentDisplay::default(), DisplayMode::Remaining, 0),
            vec!["—".to_string()]
        );
    }

    fn two_windows() -> Reading {
        reading(vec![
            window("session", "5 小时", 38.0, None),
            window("weekly", "本周", 75.0, None),
        ])
    }

    fn display(secondary: Option<&str>, stacked: bool) -> AgentDisplay {
        AgentDisplay {
            primary: Some("session".to_string()),
            secondary: secondary.map(str::to_string),
            stacked,
            stacked_size: StackedSize::Small,
        }
    }

    /// 2026-09-26：选了第二窗口时两个都显示，数前带窗口简称；
    /// 叠放打开拆成上下两行
    #[test]
    fn secondary_stacked_yields_two_prefixed_lines() {
        let lines = menu_bar_agent_lines(
            Some(&two_windows()),
            &display(Some("weekly"), true),
            DisplayMode::Remaining,
            0,
        );
        assert_eq!(lines, vec!["5h 62%".to_string(), "7d 25%".to_string()]);
    }

    /// 叠放关着、选了第二窗口：一行显示两个「5h 62% | 7d 25%」，不是只显示主窗口
    #[test]
    fn secondary_not_stacked_yields_one_line_with_both() {
        let lines = menu_bar_agent_lines(
            Some(&two_windows()),
            &display(Some("weekly"), false),
            DisplayMode::Remaining,
            0,
        );
        assert_eq!(lines, vec!["5h 62% | 7d 25%".to_string()]);
    }

    /// 只有主窗口（第二窗口「无」、或选的就是主窗口那一个）：一个数、不带简称，叠放开着也一样
    #[test]
    fn primary_only_is_one_bare_number() {
        for secondary in [None, Some("session")] {
            let lines = menu_bar_agent_lines(
                Some(&two_windows()),
                &display(secondary, true),
                DisplayMode::Remaining,
                0,
            );
            assert_eq!(lines, vec!["62%".to_string()], "{secondary:?}");
        }
    }

    /// 窗口简称：5 小时 5h、本周 7d、模型窗口写模型名；别的时长按天 / 小时 / 分钟
    #[test]
    fn window_short_labels() {
        let short = |key: &str| window_short_label(&window(key, "x", 0.0, None));
        assert_eq!(short("session"), "5h");
        assert_eq!(short("weekly"), "7d");
        assert_eq!(short("model:Fable"), "Fable");
        assert_eq!(short("minutes:1440"), "1d");
        assert_eq!(short("minutes:720"), "12h");
        assert_eq!(short("minutes:90"), "90m");
    }

    #[test]
    fn window_short_label_for_model_scoped_duration() {
        assert_eq!(
            window_short_label(&window("model:Spark:300", "x", 0.0, None)),
            "Spark 5h"
        );
    }

    /// 「已登录」一处定义：找不到程序的 agent 也进菜单栏（写「—」），与用量页的选择一致（2026-09-29 代码评审）
    #[test]
    fn menu_bar_includes_signed_in_but_not_installed() {
        let state = UsageState {
            agents: vec![agent_usage(
                AgentId::ClaudeCode,
                UsageStatus::NotInstalled,
                None,
            )],
        };
        let settings = UsageSettings {
            menu_bar_enabled: true,
            ..UsageSettings::default()
        };
        let v = menu_bar_view(&state, &settings, PowerState::default(), 0);
        assert_eq!(v.segments.len(), 1);
        assert_eq!(v.segments[0].lines, vec!["—".to_string()]);
    }

    /// 叠放、字号跟着每个 agent 走
    #[test]
    fn stacking_is_per_agent() {
        let now = 100_000;
        let state = UsageState {
            agents: vec![
                agent_usage(
                    AgentId::ClaudeCode,
                    UsageStatus::Ok,
                    Some(at(
                        AgentId::ClaudeCode,
                        now,
                        vec![
                            window("session", "5 小时", 38.0, None),
                            window("weekly", "本周", 75.0, None),
                        ],
                    )),
                ),
                agent_usage(
                    AgentId::Codex,
                    UsageStatus::Ok,
                    Some(at(
                        AgentId::Codex,
                        now,
                        vec![window("weekly", "本周", 28.0, None)],
                    )),
                ),
            ],
        };
        let settings = UsageSettings {
            menu_bar_enabled: true,
            per_agent: [
                (
                    AgentId::ClaudeCode,
                    AgentDisplay {
                        primary: Some("session".into()),
                        secondary: Some("weekly".into()),
                        stacked: true,
                        stacked_size: StackedSize::Large,
                    },
                ),
                (AgentId::Codex, AgentDisplay::default()),
            ]
            .into_iter()
            .collect(),
            ..UsageSettings::default()
        };
        let v = menu_bar_view(&state, &settings, PowerState::default(), now);
        assert_eq!(
            v.segments
                .iter()
                .map(|s| (s.agent, s.lines.clone(), s.stacked_size))
                .collect::<Vec<_>>(),
            vec![
                (
                    AgentId::ClaudeCode,
                    vec!["5h 62%".into(), "7d 25%".into()],
                    StackedSize::Large
                ),
                (AgentId::Codex, vec!["72%".into()], StackedSize::Small),
            ]
        );
    }

    // ---------------- 最近重置时间 ----------------

    /// 托盘与用量页写全单位（2026-09-30 真机「这个是几点后重置，还是经过多少时间重置？」：「3:45」读成了钟点）；
    /// 与下面的「5 天后重置」同是经过多少时间。菜单栏仍用紧凑的「H:MM」（countdown_text）
    #[test]
    fn nearest_reset_text_hour_minute_form() {
        let now = 1_000_000;
        let at = |secs: i64| {
            nearest_reset_text(&[window("weekly", "本周", 50.0, Some(now + secs))], now)
        };
        assert_eq!(at(61 * 60), Some("1 小时 1 分后重置".to_string()));
        assert_eq!(
            at(3 * 3600 + 45 * 60),
            Some("3 小时 45 分后重置".to_string())
        );
        assert_eq!(
            at(3 * 3600),
            Some("3 小时后重置".to_string()),
            "整点不写 0 分"
        );
        assert_eq!(
            at(45 * 60),
            Some("45 分钟后重置".to_string()),
            "不到 1 小时只写分钟"
        );
        assert_eq!(
            at(23 * 3600 + 59 * 60),
            Some("23 小时 59 分后重置".to_string())
        );
    }

    #[test]
    fn nearest_reset_text_days_form() {
        let now = 1_000_000;
        let windows = vec![window("weekly", "本周", 50.0, Some(now + 3 * 86400))];
        assert_eq!(
            nearest_reset_text(&windows, now),
            Some("3 天后重置".to_string())
        );
    }

    #[test]
    fn nearest_reset_text_picks_the_soonest_future_one() {
        let now = 1_000_000;
        let windows = vec![
            window("weekly", "本周", 50.0, Some(now + 3 * 86400)),
            window("session", "5 小时", 5.0, Some(now + 60)),
        ];
        assert_eq!(
            nearest_reset_text(&windows, now),
            Some("1 分钟后重置".to_string())
        );
    }

    #[test]
    fn nearest_reset_text_none_when_no_future_reset() {
        let now = 1_000_000;
        let windows = vec![window("weekly", "本周", 50.0, Some(now - 1))];
        assert_eq!(nearest_reset_text(&windows, now), None);
    }

    // ---------------- 严重程度加粗（AC24） ----------------

    #[test]
    fn ac24_warning_severity_is_emphasized_without_color() {
        let mut w = window("weekly", "本周", 87.0, None);
        w.severity = Severity::Warning;
        let row = tray_window_row(&w, DisplayMode::Used, 0);
        assert!(row.emphasize);
    }

    #[test]
    fn normal_severity_is_not_emphasized() {
        let w = window("weekly", "本周", 5.0, None);
        let row = tray_window_row(&w, DisplayMode::Used, 0);
        assert!(!row.emphasize);
    }

    // ---------------- default_agents / effective_agents（AC22、AC27） ----------------

    #[test]
    fn default_agents_with_zero_signed_in() {
        assert_eq!(default_agents(&[]), Vec::<AgentId>::new());
    }

    #[test]
    fn default_agents_with_one_signed_in() {
        assert_eq!(default_agents(&[AgentId::Codex]), vec![AgentId::Codex]);
    }

    #[test]
    fn default_agents_with_two_signed_in_keeps_all_order() {
        assert_eq!(
            default_agents(&[AgentId::Codex, AgentId::ClaudeCode]),
            vec![AgentId::ClaudeCode, AgentId::Codex]
        );
    }

    #[test]
    fn ac22_effective_agents_defaults_when_unconfigured() {
        let settings = UsageSettings::default();
        assert_eq!(
            effective_agents(&settings, &[AgentId::ClaudeCode]),
            vec![AgentId::ClaudeCode]
        );
        // 默认关着菜单栏显示（AC22 的另一半在 store 测试里覆盖设置整体默认值）
        assert!(!settings.menu_bar_enabled);
    }

    #[test]
    fn effective_agents_uses_configured_list_when_present() {
        let settings = UsageSettings {
            agents: Some(vec![AgentId::Codex]),
            ..Default::default()
        };
        assert_eq!(
            effective_agents(&settings, &[AgentId::ClaudeCode, AgentId::Codex]),
            vec![AgentId::Codex]
        );
    }
}
