//! 用量调度循环（T7，spec R5 R6 R7 R13）：每个 agent 一条取法链，按 core 的
//! `usage::schedule::decide` 决定这次跑谁、下次什么时候醒；跑完把结果记进 [`Tracker`]，
//! 通过 [`Host`] 交出新的 `UsageState`，并把上一次的读数存盘。
//!
//! 分两层：
//! - [`Tracker`] 是同步的状态机（读数、状态、各取法上次尝试时刻、限流截止与连续次数），
//!   不做 IO，单测直接喂结果；
//! - [`run`] 是异步循环：收命令、按 `wake_at` 睡、屏幕睡着时停。取数和时钟 / 系统状态
//!   都经 [`Fetcher`] / [`Host`] 注入，测试用假的，桌面层（src-tauri）给真的。
//!
//! 睡眠检测：循环每次最多睡 [`CHECK_EVERY`]，醒来比较单调时钟与墙上时钟走过的时间——整机睡眠时
//! 单调时钟停走（macOS 上 tokio 的计时器也跟着停），墙上时钟多走一大截就是刚睡醒（[`woke_from_sleep`]）。
//! 屏幕睡着时不取数，醒来补一次（R6）。只有菜单栏显示开着、刷新不是「关」时才这样轮询；
//! 否则循环只等命令，闲着时不醒（R13）。

use super::{claude, codex, Account, FetchError};
use futures_util::future::BoxFuture;
use sophia_core::usage::schedule::{
    decide, rate_limited_until, AgentSchedule, ScheduleInput, SourceSchedule, Trigger,
};
use sophia_core::usage::{
    AgentId, AgentUsage, ParseFailure, Reading, Refresh, ScheduleMemo, Source, SourceMemo,
    UsageSettings, UsageState, UsageStatus,
};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

/// 后台轮询的最长睡眠：到点、屏幕醒来、整机睡醒最迟这么久能发现
pub const CHECK_EVERY: Duration = Duration::from_secs(60);

/// 墙上时钟比单调时钟多走了这么多，就认为中间整机睡过一觉
const SLEEP_GAP: Duration = Duration::from_secs(30);

/// 一轮里最多连着决策几次：链上后一条取法要等前一条跑完才知道要不要跑（Codex 会话记录 → app-server）
const MAX_PASSES: usize = 3;

/// 这一段时间里单调时钟走了 `mono`、墙上时钟走了 `wall`：墙上时钟多出 [`SLEEP_GAP`] 以上，
/// 就是中间整机睡过一觉
pub fn woke_from_sleep(mono: Duration, wall: Duration) -> bool {
    wall.saturating_sub(mono) > SLEEP_GAP
}

/// 一个 agent 能不能取（R5）：起进程之前就判断，判断本身不起任何进程
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    Ready,
    NotInstalled,
    NotSignedIn,
}

/// 可用性（R5）：先看登录了没有，再看找不到程序。没登录的不列出来；登录了却找不到程序（比如从 Dock
/// 启动时 PATH 里没有 npm / volta 装的 `claude`），要列出来并说「没找到」，不能让用户以为功能不存在
pub fn availability_of(installed: bool, signed_in: bool) -> Availability {
    match (signed_in, installed) {
        (false, _) => Availability::NotSignedIn,
        (true, false) => Availability::NotInstalled,
        (true, true) => Availability::Ready,
    }
}

/// 每个 agent 的取法链（spec 第 2 节）：Claude 只有 `get_usage`；Codex 先读本机会话记录，
/// 不够新再起 `app-server`
pub fn chain(agent: AgentId) -> &'static [Source] {
    match agent {
        AgentId::ClaudeCode => &[Source::GetUsage],
        AgentId::Codex => &[Source::Rollout, Source::AppServer],
    }
}

/// 一次取数的结果：`Ok(None)` 是「会话记录里没有额度记录」，不算失败，交给链上下一条
pub type Outcome = Result<Option<Reading>, FetchError>;

#[derive(Debug, Clone)]
struct SourceTrack {
    source: Source,
    last_attempt: Option<i64>,
    rate_limited_until: Option<i64>,
}

#[derive(Debug, Clone)]
struct AgentTrack {
    availability: Availability,
    reading: Option<Reading>,
    status: UsageStatus,
    attempted_at: Option<i64>,
    sources: Vec<SourceTrack>,
    /// 连续被限流（没给时间）的次数，取到一次新数清零（R7）
    rate_limit_streak: u32,
    /// 回过「没有订阅额度」：不再重试，直到重启或登录状态变化（R5、AC11）
    no_plan_limits: bool,
    /// 回过「程序不认这个请求」（旧版 Claude Code 没有 `get_usage`）：后台不再起进程，状态一直写原因；
    /// 重启、登录 / 安装状态变化、手动刷新后重新尝试。不存盘
    unsupported: bool,
}

/// 调度的内存状态。只在调度循环里改，交出去的是 [`Tracker::state`] 的快照
#[derive(Debug, Clone)]
pub struct Tracker {
    agents: BTreeMap<AgentId, AgentTrack>,
}

impl Tracker {
    /// `restored` 是上次存盘的读数（R13）：同一个 agent 有多条时取最新的。`memo` 是上次存盘的调度记忆：
    /// 各取法的上次尝试、限流截止与连续被限流次数，重启后接着算最短间隔与退避
    pub fn new(restored: Vec<Reading>, memo: ScheduleMemo) -> Self {
        let mut agents = BTreeMap::new();
        for agent in AgentId::ALL {
            let reading = restored
                .iter()
                .filter(|r| r.agent == agent)
                .max_by_key(|r| r.observed_at)
                .cloned();
            agents.insert(
                agent,
                AgentTrack {
                    availability: Availability::Ready,
                    reading,
                    status: UsageStatus::Ok,
                    attempted_at: None,
                    sources: chain(agent)
                        .iter()
                        .map(|&source| {
                            let m = memo
                                .sources
                                .iter()
                                .find(|m| m.agent == agent && m.source == source);
                            SourceTrack {
                                source,
                                last_attempt: m.and_then(|m| m.last_attempt),
                                rate_limited_until: m.and_then(|m| m.rate_limited_until),
                            }
                        })
                        .collect(),
                    rate_limit_streak: memo.rate_limit_streaks.get(&agent).copied().unwrap_or(0),
                    no_plan_limits: false,
                    unsupported: false,
                },
            );
        }
        Self { agents }
    }

    /// 要存盘的调度记忆
    pub fn memo(&self) -> ScheduleMemo {
        ScheduleMemo {
            sources: self
                .agents
                .iter()
                .flat_map(|(&agent, t)| {
                    t.sources.iter().map(move |s| SourceMemo {
                        agent,
                        source: s.source,
                        last_attempt: s.last_attempt,
                        rate_limited_until: s.rate_limited_until,
                    })
                })
                .collect(),
            rate_limit_streaks: self
                .agents
                .iter()
                .filter(|(_, t)| t.rate_limit_streak > 0)
                .map(|(&agent, t)| (agent, t.rate_limit_streak))
                .collect(),
        }
    }

    fn track(&mut self, agent: AgentId) -> &mut AgentTrack {
        self.agents
            .get_mut(&agent)
            .expect("AgentId::ALL 里的每个 agent 都建过")
    }

    /// 记下这一轮的可用性。登录 / 安装状态一变，「没有订阅额度」「版本可能太旧」的判断作废（R5）
    pub fn set_availability(&mut self, agent: AgentId, availability: Availability) {
        let t = self.track(agent);
        if t.availability != availability {
            t.availability = availability;
            t.no_plan_limits = false;
            t.unsupported = false;
        }
    }

    /// 手动刷新：「版本可能太旧」的判断作废，再试一次（用户多半刚更新了 Claude Code）。
    /// `only` 为 None 时是全部 agent
    pub fn retry_unsupported(&mut self, only: Option<AgentId>) {
        for (&agent, t) in self.agents.iter_mut() {
            if only.is_none_or(|a| a == agent) {
                t.unsupported = false;
            }
        }
    }

    /// 喂给 `decide` 的各 agent 状态
    pub fn schedule_agents(&self) -> Vec<AgentSchedule> {
        self.agents
            .iter()
            .map(|(&agent, t)| AgentSchedule {
                agent,
                available: t.availability == Availability::Ready
                    && !t.no_plan_limits
                    && !t.unsupported,
                sources: t
                    .sources
                    .iter()
                    .map(|s| SourceSchedule {
                        source: s.source,
                        last_attempt: s.last_attempt,
                        rate_limited_until: s.rate_limited_until,
                    })
                    .collect(),
                // 只算这次读数之后的重置：已经被它覆盖过的过去时刻不挡住后面真正要追的
                next_reset: t.reading.as_ref().and_then(|r| {
                    r.windows
                        .iter()
                        .filter_map(|w| w.resets_at)
                        .filter(|&at| at > r.observed_at)
                        .min()
                }),
                last_success_observed_at: t.reading.as_ref().map(|r| r.observed_at),
            })
            .collect()
    }

    /// 记下一次取数的结果；读数变了返回 true（调用方据此存盘）
    pub fn record(&mut self, agent: AgentId, source: Source, at: i64, outcome: Outcome) -> bool {
        let t = self.track(agent);
        t.attempted_at = Some(at);
        if let Some(s) = t.sources.iter_mut().find(|s| s.source == source) {
            s.last_attempt = Some(at);
        }
        match outcome {
            Ok(Some(reading)) => {
                // 服务端这一侧取到新数：限流解除、连续次数清零。本机会话记录不打服务端，不算
                if source != Source::Rollout {
                    t.rate_limit_streak = 0;
                    for s in t.sources.iter_mut().filter(|s| s.source != Source::Rollout) {
                        s.rate_limited_until = None;
                    }
                }
                // 会话记录可能比手上的读数还旧：旧的不换，状态也不因此变成正常
                let newer = t
                    .reading
                    .as_ref()
                    .is_none_or(|old| reading.observed_at >= old.observed_at);
                if newer {
                    // 会话记录只带主额度：保留上一次 app-server 读到的模型限定窗口（Spark 等）
                    let mut reading = reading;
                    if source == Source::Rollout {
                        if let Some(old) = &t.reading {
                            let kept: Vec<_> = old
                                .windows
                                .iter()
                                .filter(|w| {
                                    w.key.starts_with("model:")
                                        && !reading.windows.iter().any(|n| n.key == w.key)
                                })
                                .cloned()
                                .collect();
                            reading.windows.extend(kept);
                        }
                    }
                    t.reading = Some(reading);
                    t.status = UsageStatus::Ok;
                }
                newer
            }
            Ok(None) => false,
            Err(FetchError::NotInstalled) => {
                t.availability = Availability::NotInstalled;
                false
            }
            Err(FetchError::NotSignedIn) => {
                t.availability = Availability::NotSignedIn;
                false
            }
            Err(FetchError::Failed(ParseFailure::NoPlanLimits)) => {
                t.no_plan_limits = true;
                false
            }
            Err(FetchError::Failed(ParseFailure::RateLimited { until })) => {
                t.rate_limit_streak = t.rate_limit_streak.saturating_add(1);
                let until = rate_limited_until(at, until, t.rate_limit_streak);
                if let Some(s) = t.sources.iter_mut().find(|s| s.source == source) {
                    s.rate_limited_until = Some(until);
                }
                t.status = UsageStatus::RateLimited { until };
                false
            }
            Err(e) => {
                t.unsupported = matches!(e, FetchError::Failed(ParseFailure::Unsupported));
                t.status = UsageStatus::Failing {
                    reason: e.fail_reason(),
                };
                false
            }
        }
    }

    /// 给界面的快照：可用性优先于上一次取数的状态
    pub fn state(&self) -> UsageState {
        UsageState {
            agents: self
                .agents
                .iter()
                .map(|(&agent, t)| AgentUsage {
                    agent,
                    status: match t.availability {
                        Availability::NotInstalled => UsageStatus::NotInstalled,
                        Availability::NotSignedIn => UsageStatus::NotSignedIn,
                        Availability::Ready if t.no_plan_limits => UsageStatus::NoPlanLimits,
                        Availability::Ready => t.status.clone(),
                    },
                    reading: t.reading.clone(),
                    attempted_at: t.attempted_at,
                })
                .collect(),
        }
    }

    /// 要存盘的读数（R13）
    pub fn readings(&self) -> Vec<Reading> {
        self.agents
            .values()
            .filter_map(|t| t.reading.clone())
            .collect()
    }
}

/// 取数的一侧：判断可用性、跑一条取法。真实实现见 [`RealFetcher`]
pub trait Fetcher: Send + Sync {
    fn availability(&self, agent: AgentId) -> Availability;
    fn fetch(&self, agent: AgentId, source: Source, now: i64) -> BoxFuture<'_, Outcome>;
}

/// 调度要看的系统状态（R6），由桌面层读
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SystemState {
    pub on_battery: bool,
    /// 低电量模式或发热
    pub constrained: bool,
}

/// 调度循环的宿主：时钟、系统状态、交出结果。桌面层实现它，测试用假的
pub trait Host: Send + Sync {
    /// 墙上时钟，Unix 秒
    fn now(&self) -> i64;
    /// 屏幕是否睡着（轮询时每分钟查一次，要便宜）
    fn display_asleep(&self) -> bool;
    /// 电池、低电量、发热（只在要做调度决定时查）
    fn system(&self) -> SystemState;
    /// 新的状态（和上一次交出的不同时才调）
    fn publish(&self, state: &UsageState);
    /// 读数变了，存盘（R13）
    fn save_readings(&self, readings: &[Reading]);
    /// 每次取数之后存调度记忆（上次尝试、限流），重启后接着用
    fn save_memo(&self, memo: &ScheduleMemo);
}

/// 发给调度循环的命令
#[derive(Debug)]
pub enum Command {
    /// 刚打开托盘或用量页
    Opened,
    /// 手动刷新；`Some` 只刷这一个 agent
    Refresh(Option<AgentId>),
    /// 原因行旁点了「再试一次」：只取这一个 agent，起进程的取法不等最短间隔（限流退避照守）。
    /// 这一轮跑完（或没得跑）就经第二项回话，界面据此收回「正在读取…」
    Retry(AgentId, oneshot::Sender<()>),
    /// 用量设置改了
    Settings(UsageSettings),
    Shutdown,
}

/// 调度循环的遥控：桌面层持有，命令发出即返回
#[derive(Debug, Clone)]
pub struct Handle {
    tx: mpsc::UnboundedSender<Command>,
}

impl Handle {
    pub fn channel() -> (Self, mpsc::UnboundedReceiver<Command>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self { tx }, rx)
    }

    /// 循环已经退出时发不出去，忽略即可
    pub fn send(&self, command: Command) {
        let _ = self.tx.send(command);
    }

    /// 「再试一次」：返回的接收端在这一轮跑完时收到回话；循环已经退出时立即报错（发送端随命令丢了）
    pub fn retry(&self, agent: AgentId) -> oneshot::Receiver<()> {
        let (done, rx) = oneshot::channel();
        self.send(Command::Retry(agent, done));
        rx
    }
}

fn is_explicit(trigger: Trigger) -> bool {
    matches!(
        trigger,
        Trigger::Opened | Trigger::Manual | Trigger::Retry | Trigger::SettingsChanged
    )
}

/// 后台要不要自己醒：菜单栏数字开着、刷新不是「关」（R6「什么都不显示时不跑」）
fn runs_in_background(settings: &UsageSettings) -> bool {
    settings.menu_bar_enabled && settings.refresh != Refresh::Off
}

struct Loop<'a> {
    tracker: Tracker,
    settings: UsageSettings,
    last_opened: Option<i64>,
    published: Option<UsageState>,
    fetcher: &'a dyn Fetcher,
    host: &'a dyn Host,
}

impl Loop<'_> {
    fn publish(&mut self) {
        let state = self.tracker.state();
        if self.published.as_ref() != Some(&state) {
            self.host.publish(&state);
            self.published = Some(state);
        }
    }

    /// 一轮：刷新可用性 → 决策 → 跑 → 记结果，链上还有要跑的就再决策一次。返回下次该醒的时刻。
    /// 一轮里每条取法最多跑一次：「再试一次」不等最短间隔，不挡就会在同一轮里连着再起
    async fn step(&mut self, trigger: Trigger, only: Option<AgentId>) -> Option<i64> {
        for agent in AgentId::ALL {
            let availability = self.fetcher.availability(agent);
            self.tracker.set_availability(agent, availability);
        }
        self.publish();
        let system = self.host.system();
        let mut wake_at = None;
        let mut ran: Vec<(AgentId, Source)> = Vec::new();
        for _ in 0..MAX_PASSES {
            let now = self.host.now();
            let plan = decide(&ScheduleInput {
                now,
                last_opened: self.last_opened,
                refresh: self.settings.refresh,
                on_battery: system.on_battery,
                constrained: system.constrained,
                visible: self.settings.menu_bar_enabled || is_explicit(trigger),
                trigger,
                agents: self.tracker.schedule_agents(),
            });
            wake_at = plan.wake_at;
            let run: Vec<_> = plan
                .run
                .into_iter()
                .filter(|(agent, _)| only.is_none_or(|a| a == *agent))
                .filter(|pair| !ran.contains(pair))
                .collect();
            if run.is_empty() {
                break;
            }
            for (agent, source) in run {
                ran.push((agent, source));
                let outcome = self.fetcher.fetch(agent, source, now).await;
                let at = self.host.now();
                if self.tracker.record(agent, source, at, outcome) {
                    self.host.save_readings(&self.tracker.readings());
                }
                self.host.save_memo(&self.tracker.memo());
                self.publish();
            }
        }
        wake_at
    }
}

/// 调度循环。`restored` 是上次存盘的读数，`memo` 是上次存盘的调度记忆；启动时先交出读数，再按设置与记忆取一次
pub async fn run(
    mut rx: mpsc::UnboundedReceiver<Command>,
    fetcher: Arc<dyn Fetcher>,
    host: Arc<dyn Host>,
    settings: UsageSettings,
    restored: Vec<Reading>,
    memo: ScheduleMemo,
) {
    let mut lp = Loop {
        tracker: Tracker::new(restored, memo),
        settings,
        last_opened: None,
        published: None,
        fetcher: fetcher.as_ref(),
        host: host.as_ref(),
    };
    // 第一次交出之前先判断登录与安装：没登录的 agent 不先冒出来再消失
    for agent in AgentId::ALL {
        lp.tracker
            .set_availability(agent, fetcher.availability(agent));
    }
    lp.publish();

    let mut pending: Option<(Trigger, Option<AgentId>)> = Some((Trigger::Tick, None));
    // 「再试一次」等着的回话：这一轮跑完就回
    let mut reply: Option<oneshot::Sender<()>> = None;
    let mut wake_at: Option<i64> = None;
    let mut display_was_asleep = false;

    loop {
        if let Some((trigger, only)) = pending.take() {
            // 屏幕睡着时后台一概不取，醒来那一轮当作「唤醒」补一次（R6）
            if !is_explicit(trigger) && host.display_asleep() {
                display_was_asleep = true;
            } else {
                display_was_asleep = false;
                wake_at = lp.step(trigger, only).await;
            }
        }
        if let Some(done) = reply.take() {
            // 界面已经不等了（面板关了）也无妨
            let _ = done.send(());
        }

        let background = runs_in_background(&lp.settings);
        let mono_start = tokio::time::Instant::now();
        let wall_start = host.now();
        let command = if background {
            tokio::select! {
                c = rx.recv() => Some(c),
                _ = tokio::time::sleep(CHECK_EVERY) => None,
            }
        } else {
            Some(rx.recv().await)
        };

        match command {
            Some(None) | Some(Some(Command::Shutdown)) => break,
            Some(Some(Command::Opened)) => {
                lp.last_opened = Some(host.now());
                // 托盘先拿到手上的读数（AC23），取数在后面
                lp.publish();
                pending = Some((Trigger::Opened, None));
            }
            Some(Some(Command::Refresh(agent))) => {
                lp.tracker.retry_unsupported(agent);
                pending = Some((Trigger::Manual, agent));
            }
            Some(Some(Command::Retry(agent, done))) => {
                lp.tracker.retry_unsupported(Some(agent));
                pending = Some((Trigger::Retry, Some(agent)));
                reply = Some(done);
            }
            Some(Some(Command::Settings(settings))) => {
                lp.settings = settings;
                pending = Some((Trigger::SettingsChanged, None));
            }
            None => {
                let now = host.now();
                let wall = Duration::from_secs((now - wall_start).max(0) as u64);
                let slept = woke_from_sleep(mono_start.elapsed(), wall);
                if display_was_asleep || slept {
                    pending = Some((Trigger::Woke, None));
                } else if wake_at.is_some_and(|w| now >= w) {
                    pending = Some((Trigger::Tick, None));
                }
            }
        }
    }
}

/// 真实的取数：本机会话记录、`claude -p` 的 `get_usage`、`codex app-server`
pub struct RealFetcher {
    /// Sophia 应用支持目录，探测目录在它下面
    pub base_dir: PathBuf,
    /// 看哪个账号：平时 [`Account::real`]，调试版的测试主目录用 [`Account::in_home`]
    pub account: Account,
}

impl Fetcher for RealFetcher {
    fn availability(&self, agent: AgentId) -> Availability {
        match agent {
            AgentId::ClaudeCode => availability_of(
                !super::claude_executables().is_empty(),
                self.account.claude_signed_in(),
            ),
            AgentId::Codex => availability_of(
                !super::codex_executables().is_empty(),
                self.account.codex_signed_in(),
            ),
        }
    }

    fn fetch(&self, agent: AgentId, source: Source, now: i64) -> BoxFuture<'_, Outcome> {
        Box::pin(async move {
            match (agent, source) {
                (AgentId::Codex, Source::Rollout) => {
                    let codex_home = self.account.codex_home.clone();
                    tokio::task::spawn_blocking(move || codex::read_rollout(&codex_home))
                        .await
                        .map_err(|e| {
                            let why = format!("读会话记录失败: {e}"); // i18n-exempt: 诊断信息，界面只显示 reason()
                            FetchError::Spawn(why)
                        })
                }
                (AgentId::ClaudeCode, Source::GetUsage) => {
                    claude::fetch_get_usage(&self.base_dir, &self.account, now)
                        .await
                        .map(Some)
                }
                (AgentId::Codex, Source::AppServer) => {
                    codex::fetch_app_server(&self.base_dir, &self.account, now)
                        .await
                        .map(Some)
                }
                _ => Err(FetchError::Failed(ParseFailure::Malformed(
                    "这个 agent 没有这条取法".to_string(), // i18n-exempt: 诊断信息，界面只显示 reason()
                ))),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sophia_core::usage::{FailReason, Severity, Window, WindowKind};
    use std::sync::Mutex;

    const T0: i64 = 1_790_000_000;

    fn reading(agent: AgentId, source: Source, observed_at: i64, used: f64) -> Reading {
        Reading {
            agent,
            source,
            observed_at,
            windows: vec![Window {
                key: "session".into(),
                kind: WindowKind::Session,
                used_percent: used,
                resets_at: Some(observed_at + 3 * 3600),
                window_minutes: Some(300),
                severity: Severity::Normal,
                active: true,
            }],
            plan: Some("max".into()),
        }
    }

    fn agent_state(t: &Tracker, agent: AgentId) -> AgentUsage {
        t.state()
            .agents
            .into_iter()
            .find(|a| a.agent == agent)
            .unwrap()
    }

    fn get_usage_track(t: &Tracker) -> SourceSchedule {
        t.schedule_agents()
            .into_iter()
            .find(|a| a.agent == AgentId::ClaudeCode)
            .unwrap()
            .sources
            .remove(0)
    }

    fn rate_limited() -> Outcome {
        Err(FetchError::Failed(ParseFailure::RateLimited {
            until: None,
        }))
    }

    // ---------------- Tracker ----------------

    #[test]
    fn success_sets_reading_and_ok() {
        let mut t = Tracker::new(vec![], ScheduleMemo::default());
        let r = reading(AgentId::ClaudeCode, Source::GetUsage, T0, 13.0);
        assert!(t.record(
            AgentId::ClaudeCode,
            Source::GetUsage,
            T0,
            Ok(Some(r.clone()))
        ));
        let a = agent_state(&t, AgentId::ClaudeCode);
        assert_eq!(a.status, UsageStatus::Ok);
        assert_eq!(a.reading, Some(r));
        assert_eq!(a.attempted_at, Some(T0));
        assert_eq!(get_usage_track(&t).last_attempt, Some(T0));
    }

    /// R7、AC3：失败时照常保留上一次读数，状态写原因
    #[test]
    fn failure_keeps_last_reading_with_reason() {
        let mut t = Tracker::new(vec![], ScheduleMemo::default());
        let r = reading(AgentId::ClaudeCode, Source::GetUsage, T0, 13.0);
        t.record(
            AgentId::ClaudeCode,
            Source::GetUsage,
            T0,
            Ok(Some(r.clone())),
        );
        assert!(!t.record(
            AgentId::ClaudeCode,
            Source::GetUsage,
            T0 + 900,
            Err(FetchError::Timeout)
        ));
        let a = agent_state(&t, AgentId::ClaudeCode);
        assert_eq!(
            a.status,
            UsageStatus::Failing {
                reason: FailReason::Timeout
            }
        );
        assert_eq!(
            FailReason::Timeout.text("Claude Code"),
            "Claude Code 没有回应"
        );
        assert_eq!(a.reading, Some(r));
    }

    /// AC18b：没给时间的限流 5 → 10 → 20 分钟，取到一次新数清零
    #[test]
    fn ac18b_rate_limit_streak_doubles_and_resets_on_success() {
        let mut t = Tracker::new(vec![], ScheduleMemo::default());
        let mut at = T0;
        for minutes in [5, 10, 20] {
            t.record(AgentId::ClaudeCode, Source::GetUsage, at, rate_limited());
            let until = at + minutes * 60;
            assert_eq!(get_usage_track(&t).rate_limited_until, Some(until));
            assert_eq!(
                agent_state(&t, AgentId::ClaudeCode).status,
                UsageStatus::RateLimited { until }
            );
            at = until;
        }
        let r = reading(AgentId::ClaudeCode, Source::GetUsage, at, 20.0);
        t.record(AgentId::ClaudeCode, Source::GetUsage, at, Ok(Some(r)));
        assert_eq!(get_usage_track(&t).rate_limited_until, None);
        t.record(
            AgentId::ClaudeCode,
            Source::GetUsage,
            at + 900,
            rate_limited(),
        );
        assert_eq!(
            get_usage_track(&t).rate_limited_until,
            Some(at + 900 + 5 * 60),
            "取到过新数，下一次退避回到 5 分钟"
        );
    }

    #[test]
    fn rate_limit_with_told_until_uses_it() {
        let mut t = Tracker::new(vec![], ScheduleMemo::default());
        t.record(
            AgentId::ClaudeCode,
            Source::GetUsage,
            T0,
            Err(FetchError::Failed(ParseFailure::RateLimited {
                until: Some(T0 + 1800),
            })),
        );
        assert_eq!(get_usage_track(&t).rate_limited_until, Some(T0 + 1800));
    }

    /// AC11：没有订阅额度 → 不再调度，直到登录状态变化
    #[test]
    fn ac11_no_plan_limits_is_sticky_until_sign_in_changes() {
        let mut t = Tracker::new(vec![], ScheduleMemo::default());
        t.record(
            AgentId::ClaudeCode,
            Source::GetUsage,
            T0,
            Err(FetchError::Failed(ParseFailure::NoPlanLimits)),
        );
        let claude = |t: &Tracker| {
            t.schedule_agents()
                .into_iter()
                .find(|a| a.agent == AgentId::ClaudeCode)
                .unwrap()
        };
        assert!(!claude(&t).available);
        assert_eq!(
            agent_state(&t, AgentId::ClaudeCode).status,
            UsageStatus::NoPlanLimits
        );
        t.set_availability(AgentId::ClaudeCode, Availability::Ready);
        assert!(!claude(&t).available, "可用性没变，判断照旧");
        t.set_availability(AgentId::ClaudeCode, Availability::NotSignedIn);
        t.set_availability(AgentId::ClaudeCode, Availability::Ready);
        assert!(claude(&t).available, "退出再登录后重新尝试");
    }

    /// 旧版 Claude Code 不认 get_usage：不再调度，状态一直写「版本可能太旧」，上次读数照留；
    /// 手动刷新（这个 agent 或全部）、登录状态变化、重启后重新尝试
    #[test]
    fn unsupported_is_sticky_until_manual_refresh() {
        let claude = |t: &Tracker| {
            t.schedule_agents()
                .into_iter()
                .find(|a| a.agent == AgentId::ClaudeCode)
                .unwrap()
        };
        let unsupported = || Err(FetchError::Failed(ParseFailure::Unsupported));
        let mut t = Tracker::new(vec![], ScheduleMemo::default());
        let r = reading(AgentId::ClaudeCode, Source::GetUsage, T0, 13.0);
        t.record(
            AgentId::ClaudeCode,
            Source::GetUsage,
            T0,
            Ok(Some(r.clone())),
        );
        t.record(
            AgentId::ClaudeCode,
            Source::GetUsage,
            T0 + 900,
            unsupported(),
        );
        assert!(!claude(&t).available);
        let a = agent_state(&t, AgentId::ClaudeCode);
        assert_eq!(
            a.status,
            UsageStatus::Failing {
                reason: FailReason::Unsupported
            }
        );
        assert_eq!(a.reading, Some(r));
        t.set_availability(AgentId::ClaudeCode, Availability::Ready);
        assert!(!claude(&t).available, "可用性没变，判断照旧");
        t.retry_unsupported(Some(AgentId::Codex));
        assert!(!claude(&t).available, "只刷 Codex 不碰 Claude");
        t.retry_unsupported(Some(AgentId::ClaudeCode));
        assert!(claude(&t).available, "手动刷新 Claude 后重新尝试");

        t.record(
            AgentId::ClaudeCode,
            Source::GetUsage,
            T0 + 1800,
            unsupported(),
        );
        t.retry_unsupported(None);
        assert!(claude(&t).available, "手动刷新全部也算");

        t.record(
            AgentId::ClaudeCode,
            Source::GetUsage,
            T0 + 2700,
            unsupported(),
        );
        t.set_availability(AgentId::ClaudeCode, Availability::NotInstalled);
        t.set_availability(AgentId::ClaudeCode, Availability::Ready);
        assert!(claude(&t).available, "重装后重新尝试");

        t.record(
            AgentId::ClaudeCode,
            Source::GetUsage,
            T0 + 3600,
            unsupported(),
        );
        let restarted = Tracker::new(vec![], t.memo());
        assert!(claude(&restarted).available, "不存盘：重启后重新尝试");
    }

    /// 会话记录读到比手上更旧的数：不替换，也不把状态改成正常
    #[test]
    fn older_rollout_reading_does_not_replace_newer() {
        let mut t = Tracker::new(vec![], ScheduleMemo::default());
        let fresh = reading(AgentId::Codex, Source::AppServer, T0, 40.0);
        t.record(
            AgentId::Codex,
            Source::AppServer,
            T0,
            Ok(Some(fresh.clone())),
        );
        t.record(
            AgentId::Codex,
            Source::AppServer,
            T0 + 600,
            Err(FetchError::Timeout),
        );
        let old = reading(AgentId::Codex, Source::Rollout, T0 - 3600, 30.0);
        assert!(!t.record(AgentId::Codex, Source::Rollout, T0 + 601, Ok(Some(old))));
        let a = agent_state(&t, AgentId::Codex);
        assert_eq!(a.reading, Some(fresh));
        assert!(matches!(a.status, UsageStatus::Failing { .. }));
    }

    #[test]
    fn rollout_without_record_is_not_a_failure() {
        let mut t = Tracker::new(vec![], ScheduleMemo::default());
        assert!(!t.record(AgentId::Codex, Source::Rollout, T0, Ok(None)));
        assert_eq!(agent_state(&t, AgentId::Codex).status, UsageStatus::Ok);
    }

    /// 本机会话记录不打服务端，它的成功不解除 app-server 的限流
    #[test]
    fn rollout_success_does_not_clear_server_rate_limit() {
        let mut t = Tracker::new(vec![], ScheduleMemo::default());
        t.record(AgentId::Codex, Source::AppServer, T0, rate_limited());
        let r = reading(AgentId::Codex, Source::Rollout, T0 + 10, 30.0);
        t.record(AgentId::Codex, Source::Rollout, T0 + 10, Ok(Some(r)));
        let codex = t
            .schedule_agents()
            .into_iter()
            .find(|a| a.agent == AgentId::Codex)
            .unwrap();
        assert_eq!(codex.sources[1].rate_limited_until, Some(T0 + 300));
    }

    #[test]
    fn not_signed_in_error_updates_availability() {
        let mut t = Tracker::new(vec![], ScheduleMemo::default());
        t.record(
            AgentId::Codex,
            Source::AppServer,
            T0,
            Err(FetchError::NotSignedIn),
        );
        assert_eq!(
            agent_state(&t, AgentId::Codex).status,
            UsageStatus::NotSignedIn
        );
    }

    /// R13：重启后先有上一次的读数
    #[test]
    fn restored_readings_show_immediately() {
        let old = reading(AgentId::ClaudeCode, Source::GetUsage, T0 - 60, 10.0);
        let newer = reading(AgentId::ClaudeCode, Source::GetUsage, T0, 11.0);
        let t = Tracker::new(vec![old, newer.clone()], ScheduleMemo::default());
        assert_eq!(agent_state(&t, AgentId::ClaudeCode).reading, Some(newer));
        assert_eq!(agent_state(&t, AgentId::Codex).reading, None);
    }

    /// 重启后记得上次尝试、限流截止与连续次数（2026-09-29 独立验证：否则每次重启都立刻起一次 claude，
    /// 也绕过限流退避——9-27 被限流正是反复重启造成的）
    #[test]
    fn schedule_memo_survives_restart() {
        let mut t = Tracker::new(vec![], ScheduleMemo::default());
        t.record(AgentId::ClaudeCode, Source::GetUsage, T0, rate_limited());
        t.record(
            AgentId::ClaudeCode,
            Source::GetUsage,
            T0 + 300,
            rate_limited(),
        );
        let memo = t.memo();
        let restored = Tracker::new(vec![], memo);
        assert_eq!(get_usage_track(&restored).last_attempt, Some(T0 + 300));
        assert_eq!(
            get_usage_track(&restored).rate_limited_until,
            Some(T0 + 300 + 10 * 60)
        );
        // 连续次数也接上：第三次被限流退避 20 分钟
        let mut restored = restored;
        restored.record(
            AgentId::ClaudeCode,
            Source::GetUsage,
            T0 + 1000,
            rate_limited(),
        );
        assert_eq!(
            get_usage_track(&restored).rate_limited_until,
            Some(T0 + 1000 + 20 * 60)
        );
    }

    /// 已经被本次读数覆盖过的过去重置时刻不算「下一次重置」，免得挡住后面真正要追的（2026-09-29 代码评审）
    #[test]
    fn next_reset_ignores_resets_before_observation() {
        let mut t = Tracker::new(vec![], ScheduleMemo::default());
        let mut r = reading(AgentId::ClaudeCode, Source::GetUsage, T0, 10.0);
        r.windows[0].resets_at = Some(T0 - 100);
        let mut later = r.windows[0].clone();
        later.key = "weekly".into();
        later.resets_at = Some(T0 + 3600);
        r.windows.push(later);
        t.record(AgentId::ClaudeCode, Source::GetUsage, T0, Ok(Some(r)));
        let claude = t
            .schedule_agents()
            .into_iter()
            .find(|a| a.agent == AgentId::ClaudeCode)
            .unwrap();
        assert_eq!(claude.next_reset, Some(T0 + 3600));
    }

    /// 会话记录只带主额度：换上它时保留上一次 app-server 读到的模型限定窗口（如 Spark）
    #[test]
    fn rollout_keeps_model_scoped_windows_from_app_server() {
        let mut t = Tracker::new(vec![], ScheduleMemo::default());
        let mut full = reading(AgentId::Codex, Source::AppServer, T0, 40.0);
        let mut spark = full.windows[0].clone();
        spark.key = "model:Spark".into();
        spark.kind = WindowKind::Model {
            name: "Spark".into(),
        };
        full.windows.push(spark);
        t.record(AgentId::Codex, Source::AppServer, T0, Ok(Some(full)));
        let rollout = reading(AgentId::Codex, Source::Rollout, T0 + 60, 50.0);
        t.record(AgentId::Codex, Source::Rollout, T0 + 60, Ok(Some(rollout)));
        let now = agent_state(&t, AgentId::Codex).reading.unwrap();
        assert_eq!(
            now.windows
                .iter()
                .map(|w| (w.key.as_str(), w.used_percent))
                .collect::<Vec<_>>(),
            vec![("session", 50.0), ("model:Spark", 40.0)]
        );
    }

    /// R5：先看登录了没有，再看找不到程序——没登录不列；登录了但找不到程序要说「没找到」
    #[test]
    fn availability_checks_sign_in_before_install() {
        assert_eq!(availability_of(false, false), Availability::NotSignedIn);
        assert_eq!(availability_of(true, false), Availability::NotSignedIn);
        assert_eq!(availability_of(false, true), Availability::NotInstalled);
        assert_eq!(availability_of(true, true), Availability::Ready);
    }

    #[test]
    fn sleep_gap_boundary() {
        let s = Duration::from_secs;
        assert!(!woke_from_sleep(s(60), s(60)));
        assert!(!woke_from_sleep(s(60), s(90)), "恰好多 30 秒：不算");
        assert!(woke_from_sleep(s(60), s(91)));
        assert!(!woke_from_sleep(s(60), s(30)), "墙上时钟往回拨：不算");
    }

    // ---------------- 调度循环（tokio 暂停时间 + 假时钟 + 假取数） ----------------

    struct FakeHost {
        start: tokio::time::Instant,
        /// 模拟整机睡眠：墙上时钟额外多走的秒数
        jump: Mutex<i64>,
        display_asleep: Mutex<bool>,
        published: Mutex<Vec<UsageState>>,
        saved: Mutex<usize>,
        memo_saved: Mutex<usize>,
    }

    impl FakeHost {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                start: tokio::time::Instant::now(),
                jump: Mutex::new(0),
                display_asleep: Mutex::new(false),
                published: Mutex::new(Vec::new()),
                saved: Mutex::new(0),
                memo_saved: Mutex::new(0),
            })
        }
    }

    impl Host for FakeHost {
        fn now(&self) -> i64 {
            T0 + self.start.elapsed().as_secs() as i64 + *self.jump.lock().unwrap()
        }
        fn display_asleep(&self) -> bool {
            *self.display_asleep.lock().unwrap()
        }
        fn system(&self) -> SystemState {
            SystemState::default()
        }
        fn publish(&self, state: &UsageState) {
            self.published.lock().unwrap().push(state.clone());
        }
        fn save_readings(&self, _: &[Reading]) {
            *self.saved.lock().unwrap() += 1;
        }
        fn save_memo(&self, _: &ScheduleMemo) {
            *self.memo_saved.lock().unwrap() += 1;
        }
    }

    /// 假取数：记下每次调用；Claude 回成功，Codex 会话记录回 `rollout_age` 秒前的数（None 表示没有记录），
    /// app-server 回成功。`claude_outcome` 可换成失败
    struct FakeFetcher {
        host: Arc<FakeHost>,
        calls: Mutex<Vec<(AgentId, Source, i64)>>,
        rollout_age: Mutex<Option<i64>>,
        claude_rate_limited: Mutex<bool>,
        claude_unsupported: Mutex<bool>,
        claude_signed_out: Mutex<bool>,
    }

    impl FakeFetcher {
        fn new(host: Arc<FakeHost>) -> Arc<Self> {
            Arc::new(Self {
                host,
                calls: Mutex::new(Vec::new()),
                rollout_age: Mutex::new(Some(5)),
                claude_rate_limited: Mutex::new(false),
                claude_unsupported: Mutex::new(false),
                claude_signed_out: Mutex::new(false),
            })
        }
        fn calls(&self) -> Vec<(AgentId, Source, i64)> {
            self.calls.lock().unwrap().clone()
        }
        fn count(&self, source: Source) -> usize {
            self.calls().iter().filter(|c| c.1 == source).count()
        }
    }

    impl Fetcher for FakeFetcher {
        fn availability(&self, agent: AgentId) -> Availability {
            if agent == AgentId::ClaudeCode && *self.claude_signed_out.lock().unwrap() {
                Availability::NotSignedIn
            } else {
                Availability::Ready
            }
        }
        fn fetch(&self, agent: AgentId, source: Source, now: i64) -> BoxFuture<'_, Outcome> {
            self.calls.lock().unwrap().push((agent, source, now));
            let now = self.host.now();
            let outcome = match source {
                Source::Rollout => Ok(self
                    .rollout_age
                    .lock()
                    .unwrap()
                    .map(|age| reading(agent, source, now - age, 30.0))),
                Source::GetUsage if *self.claude_rate_limited.lock().unwrap() => rate_limited(),
                Source::GetUsage if *self.claude_unsupported.lock().unwrap() => {
                    Err(FetchError::Failed(ParseFailure::Unsupported))
                }
                _ => Ok(Some(reading(agent, source, now, 20.0))),
            };
            Box::pin(async move { outcome })
        }
    }

    fn menu_bar_on() -> UsageSettings {
        UsageSettings {
            menu_bar_enabled: true,
            ..UsageSettings::default()
        }
    }

    struct Running {
        handle: Handle,
        task: tokio::task::JoinHandle<()>,
        host: Arc<FakeHost>,
        fetcher: Arc<FakeFetcher>,
    }

    fn start(settings: UsageSettings, setup: impl FnOnce(&FakeFetcher, &FakeHost)) -> Running {
        let host = FakeHost::new();
        let fetcher = FakeFetcher::new(host.clone());
        setup(&fetcher, &host);
        let (handle, rx) = Handle::channel();
        let task = tokio::spawn(run(
            rx,
            fetcher.clone(),
            host.clone(),
            settings,
            Vec::new(),
            ScheduleMemo::default(),
        ));
        Running {
            handle,
            task,
            host,
            fetcher,
        }
    }

    async fn advance(secs: u64) {
        tokio::time::sleep(Duration::from_secs(secs)).await;
    }

    impl Running {
        async fn stop(self) -> (Arc<FakeHost>, Arc<FakeFetcher>) {
            self.handle.send(Command::Shutdown);
            self.task.await.unwrap();
            (self.host, self.fetcher)
        }
    }

    /// 启动：菜单栏开着就取一次；Codex 会话记录够新（5 秒前）就不起 app-server（AC5）
    #[tokio::test(start_paused = true)]
    async fn startup_fetches_and_fresh_rollout_skips_app_server() {
        let r = start(menu_bar_on(), |_, _| {});
        advance(1).await;
        let (host, fetcher) = r.stop().await;
        assert_eq!(fetcher.count(Source::GetUsage), 1);
        assert_eq!(fetcher.count(Source::Rollout), 1);
        assert_eq!(fetcher.count(Source::AppServer), 0);
        let last = host.published.lock().unwrap().last().cloned().unwrap();
        assert!(last.agents.iter().all(|a| a.reading.is_some()));
        assert!(*host.saved.lock().unwrap() >= 2);
    }

    /// 重启：上次 1 分钟前刚起过 claude，启动时不再起（按记忆里的上次尝试算最短间隔）
    #[tokio::test(start_paused = true)]
    async fn restart_with_memo_does_not_spawn_claude_immediately() {
        let host = FakeHost::new();
        let fetcher = FakeFetcher::new(host.clone());
        let memo = ScheduleMemo {
            sources: vec![SourceMemo {
                agent: AgentId::ClaudeCode,
                source: Source::GetUsage,
                last_attempt: Some(T0 - 60),
                rate_limited_until: None,
            }],
            ..ScheduleMemo::default()
        };
        let (handle, rx) = Handle::channel();
        let task = tokio::spawn(run(
            rx,
            fetcher.clone(),
            host.clone(),
            menu_bar_on(),
            Vec::new(),
            memo,
        ));
        advance(1).await;
        handle.send(Command::Shutdown);
        task.await.unwrap();
        assert_eq!(fetcher.count(Source::GetUsage), 0);
        assert_eq!(fetcher.count(Source::Rollout), 1, "本机会话记录照读");
        assert!(*host.memo_saved.lock().unwrap() >= 1, "取过数就存记忆");
    }

    /// 第一次交出的状态就已经按登录与安装判断过：没登录的 agent 不会先冒出来再消失（2026-09-29 代码评审）
    #[tokio::test(start_paused = true)]
    async fn first_publish_already_knows_availability() {
        let r = start(menu_bar_on(), |f, h| {
            *f.claude_signed_out.lock().unwrap() = true;
            *h.display_asleep.lock().unwrap() = true;
        });
        advance(1).await;
        let (host, _) = r.stop().await;
        let first = host.published.lock().unwrap().first().cloned().unwrap();
        let claude = first
            .agents
            .iter()
            .find(|a| a.agent == AgentId::ClaudeCode)
            .unwrap();
        assert_eq!(claude.status, UsageStatus::NotSignedIn);
    }

    /// AC6：会话记录太旧（或没有）就在同一轮里退到 app-server
    #[tokio::test(start_paused = true)]
    async fn stale_rollout_falls_back_to_app_server_in_same_round() {
        let r = start(menu_bar_on(), |f, _| *f.rollout_age.lock().unwrap() = None);
        advance(1).await;
        let (_, fetcher) = r.stop().await;
        let codex: Vec<_> = fetcher
            .calls()
            .into_iter()
            .filter(|c| c.0 == AgentId::Codex)
            .map(|c| c.1)
            .collect();
        assert_eq!(codex, vec![Source::Rollout, Source::AppServer]);
    }

    /// R6：菜单栏关着，后台不取；打开托盘才取
    #[tokio::test(start_paused = true)]
    async fn menu_bar_off_only_fetches_when_opened() {
        let r = start(UsageSettings::default(), |_, _| {});
        advance(3 * 3600).await;
        assert!(r.fetcher.calls().is_empty(), "关着时启动和后台都不取");
        r.handle.send(Command::Opened);
        advance(1).await;
        let (_, fetcher) = r.stop().await;
        assert_eq!(fetcher.count(Source::GetUsage), 1);
        assert_eq!(fetcher.count(Source::Rollout), 1);
    }

    fn claude_times(fetcher: &FakeFetcher) -> Vec<i64> {
        fetcher
            .calls()
            .into_iter()
            .filter(|c| c.1 == Source::GetUsage)
            .map(|c| c.2 - T0)
            .collect()
    }

    /// AC13：选了固定 5 分钟档，get_usage 严格每 5 分钟一次
    #[tokio::test(start_paused = true)]
    async fn fixed_5_min_setting_runs_get_usage_every_5_minutes() {
        let settings = UsageSettings {
            refresh: Refresh::Every5,
            ..menu_bar_on()
        };
        let r = start(settings, |_, _| {});
        advance(3600 - 30).await;
        let (_, fetcher) = r.stop().await;
        assert_eq!(
            claude_times(&fetcher),
            (0..12).map(|i| i * 300).collect::<Vec<_>>()
        );
    }

    /// AC13b：「自动」档没人打开过（30 分钟一级），一小时里 get_usage 后台起 2 次
    #[tokio::test(start_paused = true)]
    async fn auto_setting_idle_runs_get_usage_every_30_min() {
        let r = start(menu_bar_on(), |_, _| {});
        advance(3600 - 30).await;
        let (_, fetcher) = r.stop().await;
        assert_eq!(claude_times(&fetcher), vec![0, 1800]);
    }

    /// 屏幕睡着时一概不取；醒来补一次
    #[tokio::test(start_paused = true)]
    async fn display_asleep_pauses_then_wake_refreshes() {
        let r = start(menu_bar_on(), |_, h| {
            *h.display_asleep.lock().unwrap() = true
        });
        advance(2 * 3600).await;
        assert!(r.fetcher.calls().is_empty(), "{:?}", r.fetcher.calls());
        *r.host.display_asleep.lock().unwrap() = false;
        advance(61).await;
        let (_, fetcher) = r.stop().await;
        assert_eq!(fetcher.count(Source::GetUsage), 1);
        assert_eq!(fetcher.count(Source::Rollout), 1);
    }

    /// 整机睡眠醒来补一次，不等下一个到点：睡了 10 分钟，离「自动」档 30 分钟的醒点还早，
    /// 只有睡醒检测会让会话记录再读一次（get_usage 仍受后台 15 分钟间隔约束）
    #[tokio::test(start_paused = true)]
    async fn machine_sleep_is_detected_and_refreshes() {
        let r = start(menu_bar_on(), |_, _| {});
        advance(1).await;
        let before = r.fetcher.calls().len();
        *r.host.jump.lock().unwrap() = 10 * 60;
        advance(61).await;
        let (_, fetcher) = r.stop().await;
        let after: Vec<_> = fetcher.calls()[before..].iter().map(|c| c.1).collect();
        assert_eq!(after, vec![Source::Rollout]);
    }

    /// AC18：限流期间打开托盘、手动刷新都不起 claude
    #[tokio::test(start_paused = true)]
    async fn rate_limited_blocks_even_explicit_refresh() {
        let r = start(menu_bar_on(), |f, _| {
            *f.claude_rate_limited.lock().unwrap() = true
        });
        // 启动时第一次被限流，退避 5 分钟；6 分钟时退避已过，手动刷新会跑第二次
        advance(6 * 60).await;
        r.handle.send(Command::Refresh(Some(AgentId::ClaudeCode)));
        advance(1).await;
        assert_eq!(r.fetcher.count(Source::GetUsage), 2);
        // 第二次限流退避 10 分钟：3 分钟后再手动刷新，不跑
        advance(3 * 60).await;
        r.handle.send(Command::Refresh(Some(AgentId::ClaudeCode)));
        r.handle.send(Command::Opened);
        advance(1).await;
        let (host, fetcher) = r.stop().await;
        assert_eq!(fetcher.count(Source::GetUsage), 2);
        let last = host.published.lock().unwrap().last().cloned().unwrap();
        let claude = last
            .agents
            .iter()
            .find(|a| a.agent == AgentId::ClaudeCode)
            .unwrap();
        assert!(matches!(claude.status, UsageStatus::RateLimited { .. }));
    }

    /// 旧版 Claude Code（get_usage 回 Unsupported）：之后两小时后台不再起 claude，打开托盘也不起；
    /// 托盘一直写「版本可能太旧」；手动刷新起一次
    #[tokio::test(start_paused = true)]
    async fn unsupported_stops_background_probes_until_manual_refresh() {
        let settings = UsageSettings {
            refresh: Refresh::Every5,
            ..menu_bar_on()
        };
        let r = start(settings, |f, _| {
            *f.claude_unsupported.lock().unwrap() = true
        });
        advance(2 * 3600).await;
        r.handle.send(Command::Opened);
        r.handle.send(Command::Refresh(Some(AgentId::Codex)));
        advance(1).await;
        assert_eq!(claude_times(&r.fetcher), vec![0]);
        let last = r.host.published.lock().unwrap().last().cloned().unwrap();
        let claude = last
            .agents
            .iter()
            .find(|a| a.agent == AgentId::ClaudeCode)
            .unwrap();
        assert_eq!(
            claude.status,
            UsageStatus::Failing {
                reason: FailReason::Unsupported
            }
        );

        r.handle.send(Command::Refresh(Some(AgentId::ClaudeCode)));
        advance(1).await;
        assert_eq!(r.fetcher.count(Source::GetUsage), 2, "手动刷新起一次");
        // 还是旧版：又停下来
        advance(3600).await;
        let (_, fetcher) = r.stop().await;
        assert_eq!(fetcher.count(Source::GetUsage), 2);
    }

    /// 「再试一次」：1 分钟前刚起过 claude，打开托盘照旧不起（5 分钟），点「再试一次」当场起一次——
    /// 只起一次（同一轮里不连跑），只碰这一个 agent；跑完才回话
    #[tokio::test(start_paused = true)]
    async fn retry_within_spacing_probes_immediately_once() {
        let r = start(menu_bar_on(), |_, _| {});
        advance(60).await;
        r.handle.send(Command::Opened);
        advance(1).await;
        assert_eq!(r.fetcher.count(Source::GetUsage), 1, "打开托盘仍按 5 分钟");
        let before = r.fetcher.calls().len();
        r.handle.retry(AgentId::ClaudeCode).await.unwrap();
        assert_eq!(r.fetcher.count(Source::GetUsage), 2, "回话时已经取过");
        let after = r.fetcher.calls()[before..].to_vec();
        assert_eq!(after.len(), 1, "{after:?}");
        advance(1).await;
        let (_, fetcher) = r.stop().await;
        assert_eq!(fetcher.count(Source::GetUsage), 2);
    }

    /// 「再试一次」在限流退避期间也不起 claude；没得跑也照样回话（界面上的「正在读取…」要收回）
    #[tokio::test(start_paused = true)]
    async fn retry_during_rate_limit_backoff_does_not_probe() {
        let r = start(menu_bar_on(), |f, _| {
            *f.claude_rate_limited.lock().unwrap() = true
        });
        advance(60).await;
        r.handle.retry(AgentId::ClaudeCode).await.unwrap();
        let (_, fetcher) = r.stop().await;
        assert_eq!(fetcher.count(Source::GetUsage), 1);
    }

    /// 旧版 Claude Code 停下后台之后，「再试一次」不等间隔、当场再试（用户多半刚更新完）
    #[tokio::test(start_paused = true)]
    async fn retry_clears_unsupported_and_probes_within_spacing() {
        let r = start(menu_bar_on(), |f, _| {
            *f.claude_unsupported.lock().unwrap() = true
        });
        advance(60).await;
        *r.fetcher.claude_unsupported.lock().unwrap() = false;
        r.handle.retry(AgentId::ClaudeCode).await.unwrap();
        let (host, fetcher) = r.stop().await;
        assert_eq!(fetcher.count(Source::GetUsage), 2);
        let last = host.published.lock().unwrap().last().cloned().unwrap();
        let claude = last
            .agents
            .iter()
            .find(|a| a.agent == AgentId::ClaudeCode)
            .unwrap();
        assert_eq!(claude.status, UsageStatus::Ok);
    }

    /// 只刷一个 agent 时不碰另一个
    #[tokio::test(start_paused = true)]
    async fn manual_refresh_for_one_agent_only() {
        let r = start(menu_bar_on(), |_, _| {});
        advance(10 * 60).await;
        let before = r.fetcher.calls().len();
        r.handle.send(Command::Refresh(Some(AgentId::Codex)));
        advance(1).await;
        let (_, fetcher) = r.stop().await;
        let after = &fetcher.calls()[before..];
        assert!(!after.is_empty());
        assert!(after.iter().all(|c| c.0 == AgentId::Codex), "{after:?}");
    }
}
