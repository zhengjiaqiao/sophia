//! 刷新节奏的决策（R6、R7）：纯函数，输入当前时刻与各种状态，输出下次唤醒时刻与这次要跑的取法。
//! 由 T3 实现。不读时钟、不做 IO；`scheduler.rs`（`sophia-gateway`）只负责按这里给的时刻睡、
//! 跑取法、把结果喂回下一轮的输入。
//!
//! ## 设计要点（写在这里，别处不重复）
//!
//! - **刷新档位决定「后台多久醒一次」；谁能跑看每条取法自己的最短间隔**、限流状态、以及 Codex
//!   的取法链新鲜度（下面单独说）。选了固定档时，起进程的取法的最短间隔就是这个档位（AC13，
//!   选 1 分钟就每分钟一次）；「自动」「关」时 `get_usage` 后台按
//!   15 分钟、有人看着按 5 分钟挡住多出来的 Tick（AC13b）。见 `spacing_seconds`。
//! - **`visible=false` 时什么都不跑、也不再醒。** spec 原话是「后台不跑」，这里做成更强的
//!   「这一轮谁都不跑」：显式触发（打开托盘、手动刷新、设置改动）在真实场景里必然伴随
//!   `visible=true`（打开托盘这个动作本身就让 `visible` 变 true），所以两种读法在实际输入下
//!   等价；用更强的读法是因为它更简单、也更安全（不会有「设置错了导致后台偷跑」的空子）。
//! - **`refresh=Off` 时不产生任何后台醒来（`wake_at=None`）**，但显式触发仍按各自的最短间隔
//!   照常跑（R6：「关」表示只在打开托盘或用量页时取）。
//! - **Codex 的取法链新鲜度**：链里排在后面的取法，只有在「这个 agent 目前最新的成功观测时刻」
//!   比「链里前一条取法自己的最短间隔」还旧时才纳入考虑；否则直接不看它（`break`，不是
//!   `continue`——新鲜就没有必要往下退）。对 Codex 就是 AC5／AC6：会话记录 30 秒内有数就不起
//!   `app-server`；超过 30 秒才升级。这是本任务把 spec 「读数够新就不往下走」和 T3 任务描述
//!   「更通用地表述成：更靠后的取法只在 agent 最新观测时刻比 base interval 更旧时才跑」这两句
//!   合起来的落地方式——这里的「base interval」取的是「链上前一条取法自己的最短间隔」，不是
//!   刷新档位算出来的分钟级间隔（分钟级间隔在 300+ 会话文件、几十秒就有新数据的场景下太粗，
//!   会导致明明有更新的会话记录也要等一整个刷新周期才升级到 app-server，或者反过来刷新周期
//!   很短时把 app-server 当成兜底频繁打）。
//! - **限流按「后端」聚合，Rollout 例外。** 同一个 agent 除 Rollout 外的取法这一版都算同一个
//!   后端：只要其中一条被限流，其余非 Rollout 的取法在这个 agent 上一起等到限流解除，
//!   Rollout 因为是本机文件、不打服务端请求，永远按自己的状态单独判断。
//! - **`wake_at` 不为「单纯的最短间隔冷却」单独提前，只为「重置边界」单独提前。** 每条取法的
//!   最短间隔本身只在每次 Tick／显式触发时当场检查（能跑就跑，不能跑就等下一次），不会
//!   反过来把 `wake_at` 拉到冷却结束的那一刻——否则「自动」档的 15 / 30 分钟两级会形同虚设
//!   （最短间隔都不超过 15 分钟，一旦被它牵着提前唤醒，就永远达不到更久的那几档，
//!   违背 R6「更久没打开就少刷」、R13「闲着时不产生持续 CPU 占用」的本意）。重置边界是唯一的
//!   例外：spec 明确要求过了重置时刻要尽快补刷（AC15），所以只有它会把 `wake_at` 往前拉。

use super::model::{AgentId, Refresh, Source};

/// 促成这次决策的原因
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// 到了上一轮算好的 `wake_at`
    Tick,
    /// 刚打开托盘或用量页
    Opened,
    /// 用户手动点了刷新
    Manual,
    /// 屏幕唤醒后的补刷
    Woke,
    /// 用量设置刚被改动
    SettingsChanged,
}

/// 一次决策的输入。时刻一律是 Unix 秒；这里只做决策，不读时钟、不做 IO
#[derive(Debug, Clone)]
pub struct ScheduleInput {
    /// 决策发生的当前时刻
    pub now: i64,
    /// 最近一次打开托盘或用量页的时刻（「自动」档按它分四级）；从没打开过是 `None`
    pub last_opened: Option<i64>,
    /// 用户在设置里选的刷新档位
    pub refresh: Refresh,
    /// 是否在用电池供电：非 `constrained` 时把算出来的间隔翻倍
    pub on_battery: bool,
    /// 低电量模式或机器发热：一律 30 分钟，优先级比电池翻倍和固定档位都高
    pub constrained: bool,
    /// 菜单栏数字开着，或者托盘 / 用量页正打开着；两者都不成立时这一轮什么都不跑
    pub visible: bool,
    /// 促成这次决策的触发原因
    pub trigger: Trigger,
    /// 各 agent 的调度状态，顺序不重要
    pub agents: Vec<AgentSchedule>,
}

/// 一个 agent 的调度状态
#[derive(Debug, Clone)]
pub struct AgentSchedule {
    pub agent: AgentId,
    /// 已登录、且不是「没有订阅额度」；为 `false` 时这个 agent 这一轮永远不跑
    pub available: bool,
    /// 这个 agent 的取法，按 spec 第 2 节的回退顺序排列（Codex：Rollout 在前，AppServer 在后；
    /// Claude 只有 `GetUsage` 一条）
    pub sources: Vec<SourceSchedule>,
    /// 它的窗口里最早的、还没被观测到已经发生过的未来重置时刻；没有窗口、或所有窗口都没有
    /// `resets_at` 时是 `None`
    pub next_reset: Option<i64>,
    /// 这个 agent 目前最新一次成功读数的观测时刻（不分取法，取最新的一次）；`None` 表示从没
    /// 成功读到过。用于判断「本机数据是否够新」（见上面的设计要点）
    pub last_success_observed_at: Option<i64>,
}

/// 一条取法的调度状态
#[derive(Debug, Clone)]
pub struct SourceSchedule {
    pub source: Source,
    /// 最近一次尝试这条取法的时刻（不论成功失败）；`None` 表示从没跑过
    pub last_attempt: Option<i64>,
    /// 服务端限流的截止时刻；`None` 表示当前没有被限流。这个字段只记「这条取法自己被告知的
    /// 截止时刻」，是否要连带挡住同 agent 的其它取法由 `effective_rate_limited_until` 决定
    pub rate_limited_until: Option<i64>,
}

/// 一次决策的输出
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchedulePlan {
    /// 这次要跑的 `(agent, source)` 组合
    pub run: Vec<(AgentId, Source)>,
    /// 下次应该唤醒调度器的时刻；`None` 表示这一轮之后不会再有后台触发
    /// （`refresh=Off`，或者什么都不 visible）
    pub wake_at: Option<i64>,
}

/// 本机会话记录的最短间隔（R6）
const ROLLOUT_MIN_SPACING_SECONDS: i64 = 30;
/// 要起进程的取法的最短间隔（R6）：`app-server` 一律如此，`get_usage` 在有人看着时如此
const PROCESS_MIN_SPACING_SECONDS: i64 = 5 * 60;
/// `get_usage` 后台的最短间隔（R6）：同一个用量接口的限额还被 Claude Code 自己的 `/usage`
/// 与别的读令牌工具共用，限流只能靠降频
const GET_USAGE_BACKGROUND_SPACING_SECONDS: i64 = 15 * 60;

/// 限流但没给截止时刻时，第一次退避的时长（R7）
const RATE_LIMIT_BASE_BACKOFF_SECONDS: i64 = 5 * 60;
/// 连续被限流时退避的上限（R7）
const RATE_LIMIT_MAX_BACKOFF_SECONDS: i64 = 60 * 60;

/// 低电量 / 发热时的固定间隔（分钟）
const CONSTRAINED_INTERVAL_MINUTES: i64 = 30;

/// 用户选的固定档（分钟）；「自动」「关」是 None
fn fixed_minutes(refresh: Refresh) -> Option<i64> {
    match refresh {
        Refresh::Every1 => Some(1),
        Refresh::Every5 => Some(5),
        Refresh::Every10 => Some(10),
        Refresh::Every15 => Some(15),
        Refresh::Auto | Refresh::Off => None,
    }
}

/// 一条取法的最短间隔。`attended`：有人看着（打开托盘或用量页、手动刷新、改设置），
/// 或者这个 agent 有窗口过了重置时刻还没取到新数（过了重置就不按后台节流）。
///
/// 起进程的取法：选了固定档就严格按它（最短 1 分钟），有人看着时
/// 取 5 分钟与档位中较短的那个；「自动」「关」时 `get_usage` 后台 15 分钟、有人看着 5 分钟，
/// `app-server` 一律 5 分钟
fn spacing_seconds(source: Source, attended: bool, refresh: Refresh) -> i64 {
    if source == Source::Rollout {
        return ROLLOUT_MIN_SPACING_SECONDS;
    }
    match (fixed_minutes(refresh), source, attended) {
        (Some(m), _, false) => m * 60,
        (Some(m), _, true) => (m * 60).min(PROCESS_MIN_SPACING_SECONDS),
        (None, Source::GetUsage, false) => GET_USAGE_BACKGROUND_SPACING_SECONDS,
        (None, _, _) => PROCESS_MIN_SPACING_SECONDS,
    }
}

/// 后台触发时起进程的取法的最短间隔下限：按此刻的系统状态（低电量 / 发热一律 30 分钟，固定档用电池翻倍）。
/// 下次醒来的时刻是上一轮按当时的状态算的，状态在中间变了（刚开低电量、刚拔电源），到点那一轮也要按
/// 新状态挡住（SCH-11，2026-09-29 真机）。有人看着时不用它；本机会话记录不起进程，也不用它
fn background_floor_seconds(input: &ScheduleInput) -> i64 {
    if input.constrained {
        return CONSTRAINED_INTERVAL_MINUTES * 60;
    }
    match fixed_minutes(input.refresh) {
        Some(m) if input.on_battery => m * 2 * 60,
        _ => 0,
    }
}

/// 限流但服务端没给截止时刻时，第 `consecutive` 次连续被限流（从 1 起，0 当作 1）要等多久：
/// 5 分钟起一次翻一倍，最长 60 分钟（R7、AC18b）。取到一次新数后调用方把次数清零
pub fn rate_limit_backoff_secs(consecutive: u32) -> i64 {
    let doublings = consecutive.saturating_sub(1).min(8);
    (RATE_LIMIT_BASE_BACKOFF_SECONDS << doublings).min(RATE_LIMIT_MAX_BACKOFF_SECONDS)
}

/// 被限流后这条取法的截止时刻：服务端给了就照它给的（不再叠加翻倍），
/// 没给就按连续次数退避；结果不早于 `now`
pub fn rate_limited_until(now: i64, told: Option<i64>, consecutive: u32) -> i64 {
    told.unwrap_or_else(|| now + rate_limit_backoff_secs(consecutive))
        .max(now)
}

/// 决定这一轮要跑哪些取法、下次什么时候醒
pub fn decide(input: &ScheduleInput) -> SchedulePlan {
    if !input.visible {
        // 什么都不 visible：这一轮不跑、也不再安排后台唤醒
        return SchedulePlan {
            run: Vec::new(),
            wake_at: None,
        };
    }

    if matches!(input.trigger, Trigger::Tick) && matches!(input.refresh, Refresh::Off) {
        // 架构上 Off 不应该产生 Tick（没有 wake_at 可醒），这里是防御性兜底
        return SchedulePlan {
            run: Vec::new(),
            wake_at: None,
        };
    }

    let mut run = Vec::new();
    let mut wake_candidates: Vec<i64> = Vec::new();
    let floor = background_floor_seconds(input);
    let explicit = matches!(
        input.trigger,
        Trigger::Opened | Trigger::Manual | Trigger::SettingsChanged
    );

    for agent in &input.agents {
        if !agent.available {
            continue;
        }

        // 这个 agent 目前的数据是否已经盖过了它的重置边界（R7：过了重置时刻还没取到新数时，
        // 那个窗口要显示「已重置」——调度这边要保证尽快去补一次新数）
        let covers_reset = match (agent.next_reset, agent.last_success_observed_at) {
            (Some(reset), Some(observed)) => observed >= reset,
            (Some(_), None) => false,
            (None, _) => true,
        };
        let reset_passed = agent.next_reset.is_some_and(|reset| reset <= input.now);
        let attended = explicit || (reset_passed && !covers_reset);

        let (runnable, earliest_future) =
            decide_agent_source(agent, input.now, attended, input.refresh, floor);

        if let Some(source) = runnable {
            run.push((agent.agent, source));
        } else if !covers_reset {
            if let Some(reset) = agent.next_reset {
                // 这条取法此刻还不能跑，但重置边界还没被盖住：按 max(重置时刻, 最短间隔允许的
                // 时刻) 记一个 wake 候选（AC15）。过了重置时刻就按「有人看着」的间隔，
                // 所以这里的「最短间隔允许的时刻」也按那个间隔算
                let earliest_at_reset = if attended {
                    earliest_future
                } else {
                    decide_agent_source(agent, input.now, true, input.refresh, floor).1
                };
                let candidate = match earliest_at_reset {
                    Some(earliest) => earliest.max(reset),
                    None => reset,
                };
                wake_candidates.push(candidate.max(input.now + 1));
            }
        }
        // 注意：这里故意不把单纯被自己最短间隔挡住的 `earliest_future`（没有重置边界要追的
        // 情况）也记成 wake 候选。最短间隔都不超过 15 分钟，如果单靠它就能提前唤醒，
        // 「自动」档 15 / 30 分钟那两级会形同虚设——每次都会在最短间隔一到就被叫醒，
        // 跟「更久没打开就少刷」的本意相反。这类情况完全交给下面的周期性 tick 兜底：每次
        // Tick 到了都会重新检查一遍最短间隔，最坏也只会晚一个刷新周期发现取法已经能跑了。
    }

    if !matches!(input.refresh, Refresh::Off) {
        if let Some(minutes) = base_interval_minutes(input) {
            wake_candidates.push(input.now + minutes * 60);
        }
    }

    let wake_at = if matches!(input.refresh, Refresh::Off) {
        // 「关」只在显式触发时取，不安排后台唤醒
        None
    } else {
        wake_candidates.into_iter().min()
    };

    SchedulePlan { run, wake_at }
}

/// 给一个 agent 的取法链做决策：`(Some(source), _)` 表示这条取法此刻就能跑；
/// `(None, Some(t))` 表示都不能跑，最早要等到 `t`；`(None, None)` 表示这个 agent 没有
/// 任何取法（空链），永远不会自己触发
fn decide_agent_source(
    agent: &AgentSchedule,
    now: i64,
    attended: bool,
    refresh: Refresh,
    background_floor: i64,
) -> (Option<Source>, Option<i64>) {
    let mut earliest_wake: Option<i64> = None;

    for (idx, candidate) in agent.sources.iter().enumerate() {
        if idx > 0 {
            let prev_spacing = spacing_seconds(agent.sources[idx - 1].source, attended, refresh);
            let fresh_enough = agent
                .last_success_observed_at
                .is_some_and(|observed| now - observed < prev_spacing);
            if fresh_enough {
                // 前一条取法给出的数据还新，没必要退到这一条
                break;
            }
        }

        if let Some(until) = effective_rate_limited_until(&agent.sources, candidate.source) {
            if now < until {
                earliest_wake = Some(earliest_wake.map_or(until, |w| w.min(until)));
                continue;
            }
        }

        let mut spacing = spacing_seconds(candidate.source, attended, refresh);
        if !attended && candidate.source.spawns_process() {
            spacing = spacing.max(background_floor);
        }
        let next_ok = candidate
            .last_attempt
            .map_or(now, |attempt| attempt + spacing);
        if next_ok <= now {
            return (Some(candidate.source), None);
        }
        earliest_wake = Some(earliest_wake.map_or(next_ok, |w| w.min(next_ok)));
    }

    (None, earliest_wake)
}

/// 这条取法实际生效的限流截止时刻：Rollout 只看它自己；其它取法这一版共享同一个后端，
/// 谁被限流，同 agent 里其余非 Rollout 的取法一起等到最晚的那个截止时刻
fn effective_rate_limited_until(sources: &[SourceSchedule], source: Source) -> Option<i64> {
    if source == Source::Rollout {
        return sources
            .iter()
            .find(|s| s.source == source)
            .and_then(|s| s.rate_limited_until);
    }
    sources
        .iter()
        .filter(|s| s.source != Source::Rollout)
        .filter_map(|s| s.rate_limited_until)
        .max()
}

/// 算出这一档刷新设置对应的分钟数；`Off` 由调用方单独处理，这里不会被调用到
fn base_interval_minutes(input: &ScheduleInput) -> Option<i64> {
    if matches!(input.refresh, Refresh::Off) {
        return None;
    }

    if input.constrained {
        // 低电量 / 发热：一律 30 分钟，优先级最高，覆盖固定档位和电池翻倍
        return Some(CONSTRAINED_INTERVAL_MINUTES);
    }

    let base_minutes = match input.refresh {
        Refresh::Auto => auto_interval_minutes(input.now, input.last_opened),
        Refresh::Every1 => 1,
        Refresh::Every5 => 5,
        Refresh::Every10 => 10,
        Refresh::Every15 => 15,
        Refresh::Off => unreachable!("上面已经处理过 Off"),
    };

    Some(if input.on_battery {
        base_minutes * 2
    } else {
        base_minutes
    })
}

/// 「自动」档：按上次打开托盘或用量页多久之前分四级（R6）。边界取「以内」，即恰好等于
/// 边界值时归到更短的那一档
fn auto_interval_minutes(now: i64, last_opened: Option<i64>) -> i64 {
    const FIVE_MIN: i64 = 5 * 60;
    const SIXTY_MIN: i64 = 60 * 60;
    const FOUR_HOUR: i64 = 4 * 60 * 60;

    match last_opened {
        None => 30,
        Some(opened) => {
            let age = (now - opened).max(0);
            if age <= FIVE_MIN {
                2
            } else if age <= SIXTY_MIN {
                5
            } else if age <= FOUR_HOUR {
                15
            } else {
                30
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000_000;

    fn claude_agent(sources: Vec<SourceSchedule>) -> AgentSchedule {
        AgentSchedule {
            agent: AgentId::ClaudeCode,
            available: true,
            sources,
            next_reset: None,
            last_success_observed_at: None,
        }
    }

    fn codex_agent(sources: Vec<SourceSchedule>) -> AgentSchedule {
        AgentSchedule {
            agent: AgentId::Codex,
            available: true,
            sources,
            next_reset: None,
            last_success_observed_at: None,
        }
    }

    fn never_run(source: Source) -> SourceSchedule {
        SourceSchedule {
            source,
            last_attempt: None,
            rate_limited_until: None,
        }
    }

    fn base_input(agents: Vec<AgentSchedule>) -> ScheduleInput {
        ScheduleInput {
            now: NOW,
            last_opened: None,
            refresh: Refresh::Auto,
            on_battery: false,
            constrained: false,
            visible: true,
            trigger: Trigger::Tick,
            agents,
        }
    }

    // ---------------- 自动档四级边界（AC12） ----------------

    #[test]
    fn ac12_auto_exactly_5_min_is_2_min_tier() {
        assert_eq!(auto_interval_minutes(NOW, Some(NOW - 5 * 60)), 2);
    }

    #[test]
    fn ac12_auto_just_over_5_min_is_5_min_tier() {
        assert_eq!(auto_interval_minutes(NOW, Some(NOW - 5 * 60 - 1)), 5);
    }

    #[test]
    fn ac12_auto_exactly_60_min_is_5_min_tier() {
        assert_eq!(auto_interval_minutes(NOW, Some(NOW - 60 * 60)), 5);
    }

    #[test]
    fn ac12_auto_just_over_60_min_is_15_min_tier() {
        assert_eq!(auto_interval_minutes(NOW, Some(NOW - 60 * 60 - 1)), 15);
    }

    #[test]
    fn ac12_auto_exactly_4_hour_is_15_min_tier() {
        assert_eq!(auto_interval_minutes(NOW, Some(NOW - 4 * 60 * 60)), 15);
    }

    #[test]
    fn ac12_auto_just_over_4_hour_is_30_min_tier() {
        assert_eq!(auto_interval_minutes(NOW, Some(NOW - 4 * 60 * 60 - 1)), 30);
    }

    #[test]
    fn ac12_auto_never_opened_is_30_min_tier() {
        assert_eq!(auto_interval_minutes(NOW, None), 30);
    }

    #[test]
    fn ac12_on_battery_doubles_interval() {
        let mut input = base_input(vec![]);
        input.last_opened = Some(NOW - 5 * 60); // 2 分钟档
        input.on_battery = true;
        let plan = decide(&input);
        assert_eq!(plan.wake_at, Some(NOW + 4 * 60));
    }

    #[test]
    fn ac12_constrained_forces_30_min_even_on_fixed_1_min_setting() {
        let mut input = base_input(vec![]);
        input.refresh = Refresh::Every1;
        input.on_battery = true; // constrained 优先级更高，电池翻倍不再叠加
        input.constrained = true;
        let plan = decide(&input);
        assert_eq!(plan.wake_at, Some(NOW + 30 * 60));
    }

    #[test]
    fn ac12_fixed_5_min_setting_wakes_in_5_min() {
        let mut input = base_input(vec![]);
        input.refresh = Refresh::Every5;
        let plan = decide(&input);
        assert_eq!(plan.wake_at, Some(NOW + 5 * 60));
    }

    // ---------------- Off（R6） ----------------

    #[test]
    fn off_tick_does_not_run_and_has_no_wake() {
        let mut input = base_input(vec![claude_agent(vec![never_run(Source::GetUsage)])]);
        input.refresh = Refresh::Off;
        input.trigger = Trigger::Tick;
        let plan = decide(&input);
        assert_eq!(plan.run, vec![]);
        assert_eq!(plan.wake_at, None);
    }

    #[test]
    fn off_manual_trigger_still_runs_when_spacing_allows() {
        let mut input = base_input(vec![claude_agent(vec![never_run(Source::GetUsage)])]);
        input.refresh = Refresh::Off;
        input.trigger = Trigger::Manual;
        let plan = decide(&input);
        assert_eq!(plan.run, vec![(AgentId::ClaudeCode, Source::GetUsage)]);
        assert_eq!(plan.wake_at, None, "关档不安排后台唤醒");
    }

    // ---------------- 不 visible（AC16） ----------------

    #[test]
    fn ac16_not_visible_runs_nothing_regardless_of_trigger() {
        let mut input = base_input(vec![claude_agent(vec![never_run(Source::GetUsage)])]);
        input.visible = false;
        input.trigger = Trigger::Manual;
        let plan = decide(&input);
        assert_eq!(plan.run, vec![]);
        assert_eq!(plan.wake_at, None);
    }

    // ---------------- 每条取法的最短间隔（regardless of trigger） ----------------

    #[test]
    fn rollout_spacing_exactly_30s_allows_run() {
        let mut input = base_input(vec![codex_agent(vec![SourceSchedule {
            source: Source::Rollout,
            last_attempt: Some(NOW - 30),
            rate_limited_until: None,
        }])]);
        input.trigger = Trigger::Manual;
        let plan = decide(&input);
        assert_eq!(plan.run, vec![(AgentId::Codex, Source::Rollout)]);
    }

    #[test]
    fn rollout_spacing_just_under_30s_blocks_run() {
        let mut input = base_input(vec![codex_agent(vec![SourceSchedule {
            source: Source::Rollout,
            last_attempt: Some(NOW - 29),
            rate_limited_until: None,
        }])]);
        input.trigger = Trigger::Manual;
        let plan = decide(&input);
        assert_eq!(plan.run, vec![]);
        // 没有重置边界要追时，单纯的最短间隔冷却不会把 wake_at 提前——那是周期性 tick 的活
        // （见模块开头「wake_at 不为单纯的最短间隔冷却单独提前」）；这里退回到自动档、从没
        // 打开过托盘的 30 分钟周期
        assert_eq!(plan.wake_at, Some(NOW + 30 * 60));
    }

    #[test]
    fn process_spacing_exactly_5min_allows_run() {
        let mut input = base_input(vec![claude_agent(vec![SourceSchedule {
            source: Source::GetUsage,
            last_attempt: Some(NOW - 5 * 60),
            rate_limited_until: None,
        }])]);
        input.trigger = Trigger::Manual;
        let plan = decide(&input);
        assert_eq!(plan.run, vec![(AgentId::ClaudeCode, Source::GetUsage)]);
    }

    #[test]
    fn process_spacing_just_under_5min_blocks_run() {
        let mut input = base_input(vec![claude_agent(vec![SourceSchedule {
            source: Source::GetUsage,
            last_attempt: Some(NOW - 5 * 60 + 1),
            rate_limited_until: None,
        }])]);
        input.trigger = Trigger::Manual;
        let plan = decide(&input);
        assert_eq!(plan.run, vec![]);
    }

    // ---------------- AC13 / AC13b：固定档严格按档位；自动档 get_usage 后台 15 分钟、有人看着 5 分钟 ----------------

    fn claude_attempted(ago: i64) -> ScheduleInput {
        base_input(vec![claude_agent(vec![SourceSchedule {
            source: Source::GetUsage,
            last_attempt: Some(NOW - ago),
            rate_limited_until: None,
        }])])
    }

    /// AC13：选了固定档，起进程的取法严格按这个频率
    #[test]
    fn ac13_fixed_setting_is_honored_for_get_usage() {
        for (refresh, minutes) in [(Refresh::Every1, 1), (Refresh::Every10, 10)] {
            let mut input = claude_attempted(minutes * 60);
            input.refresh = refresh;
            input.trigger = Trigger::Tick;
            assert_eq!(
                decide(&input).run,
                vec![(AgentId::ClaudeCode, Source::GetUsage)],
                "{refresh:?} 恰好到点"
            );
            let mut input = claude_attempted(minutes * 60 - 1);
            input.refresh = refresh;
            input.trigger = Trigger::Tick;
            assert_eq!(decide(&input).run, vec![], "{refresh:?} 差 1 秒");
        }
    }

    /// AC13：固定档下有人看着时，最短间隔取 5 分钟与档位中较短的那个
    #[test]
    fn ac13_fixed_setting_attended_spacing_is_min_of_5_and_setting() {
        for (refresh, minutes) in [(Refresh::Every1, 1), (Refresh::Every15, 5)] {
            let mut input = claude_attempted(minutes * 60);
            input.refresh = refresh;
            input.trigger = Trigger::Manual;
            assert_eq!(
                decide(&input).run,
                vec![(AgentId::ClaudeCode, Source::GetUsage)],
                "{refresh:?}"
            );
            let mut input = claude_attempted(minutes * 60 - 1);
            input.refresh = refresh;
            input.trigger = Trigger::Manual;
            assert_eq!(decide(&input).run, vec![], "{refresh:?}");
        }
    }

    #[test]
    fn ac13_fixed_setting_is_honored_for_app_server() {
        let mut input = base_input(vec![codex_agent(vec![SourceSchedule {
            source: Source::AppServer,
            last_attempt: Some(NOW - 60),
            rate_limited_until: None,
        }])]);
        input.refresh = Refresh::Every1;
        input.trigger = Trigger::Tick;
        assert_eq!(
            decide(&input).run,
            vec![(AgentId::Codex, Source::AppServer)]
        );
    }

    /// SCH-11（2026-09-29 真机）：下次醒来的时刻是开低电量之前按 1 分钟算的，到点那一轮不能照旧起进程——
    /// 后台触发时，起进程的取法的最短间隔不低于此刻状态下的刷新间隔（低电量 / 发热一律 30 分钟）
    #[test]
    fn constrained_background_tick_does_not_spawn_before_30_min() {
        for trigger in [Trigger::Tick, Trigger::Woke] {
            let mut input = claude_attempted(60);
            input.refresh = Refresh::Every1;
            input.constrained = true;
            input.trigger = trigger;
            assert_eq!(decide(&input).run, vec![], "{trigger:?} 1 分钟前跑过");
            let mut input = claude_attempted(30 * 60);
            input.refresh = Refresh::Every1;
            input.constrained = true;
            input.trigger = trigger;
            assert_eq!(
                decide(&input).run,
                vec![(AgentId::ClaudeCode, Source::GetUsage)],
                "{trigger:?} 恰好 30 分钟"
            );
        }
        // 自动档同理：get_usage 后台 15 分钟的下限，低电量时抬到 30 分钟
        let mut input = claude_attempted(20 * 60);
        input.constrained = true;
        input.trigger = Trigger::Tick;
        assert_eq!(decide(&input).run, vec![]);
    }

    /// 同一类问题：固定档切到用电池后，到点那一轮也按翻倍的间隔算
    #[test]
    fn battery_background_tick_doubles_fixed_spacing() {
        let mut input = claude_attempted(60);
        input.refresh = Refresh::Every1;
        input.on_battery = true;
        input.trigger = Trigger::Tick;
        assert_eq!(decide(&input).run, vec![]);
        let mut input = claude_attempted(120);
        input.refresh = Refresh::Every1;
        input.on_battery = true;
        input.trigger = Trigger::Tick;
        assert_eq!(
            decide(&input).run,
            vec![(AgentId::ClaudeCode, Source::GetUsage)]
        );
    }

    /// 有人看着（打开托盘、手动刷新）不受低电量影响：仍按有人看着的间隔
    #[test]
    fn constrained_does_not_block_attended_refresh() {
        let mut input = claude_attempted(60);
        input.refresh = Refresh::Every1;
        input.constrained = true;
        input.trigger = Trigger::Manual;
        assert_eq!(
            decide(&input).run,
            vec![(AgentId::ClaudeCode, Source::GetUsage)]
        );
    }

    /// 本机会话记录不起进程，不受这条限制
    #[test]
    fn constrained_background_still_reads_rollout() {
        let mut input = base_input(vec![codex_agent(vec![SourceSchedule {
            source: Source::Rollout,
            last_attempt: Some(NOW - 60),
            rate_limited_until: None,
        }])]);
        input.refresh = Refresh::Every1;
        input.constrained = true;
        input.trigger = Trigger::Tick;
        assert_eq!(decide(&input).run, vec![(AgentId::Codex, Source::Rollout)]);
    }

    /// 固定档也挡不住限流
    #[test]
    fn ac13_fixed_setting_still_respects_rate_limit() {
        let mut input = base_input(vec![claude_agent(vec![SourceSchedule {
            source: Source::GetUsage,
            last_attempt: Some(NOW - 60),
            rate_limited_until: Some(NOW + 60),
        }])]);
        input.refresh = Refresh::Every1;
        input.trigger = Trigger::Manual;
        assert_eq!(decide(&input).run, vec![]);
    }

    // 以下 AC13b 是「自动」档（base_input 的默认）：Claude 后台 15 分钟、有人看着 5 分钟

    #[test]
    fn ac13b_background_get_usage_just_under_15_min_blocks() {
        for trigger in [Trigger::Tick, Trigger::Woke] {
            let mut input = claude_attempted(15 * 60 - 1);
            input.trigger = trigger;
            assert_eq!(decide(&input).run, vec![], "{trigger:?}");
        }
    }

    #[test]
    fn ac13b_background_get_usage_exactly_15_min_runs() {
        for trigger in [Trigger::Tick, Trigger::Woke] {
            let mut input = claude_attempted(15 * 60);
            input.trigger = trigger;
            assert_eq!(
                decide(&input).run,
                vec![(AgentId::ClaudeCode, Source::GetUsage)],
                "{trigger:?}"
            );
        }
    }

    #[test]
    fn ac13b_attended_get_usage_spaced_at_5_min() {
        for trigger in [Trigger::Opened, Trigger::Manual, Trigger::SettingsChanged] {
            let mut input = claude_attempted(5 * 60);
            input.trigger = trigger;
            assert_eq!(
                decide(&input).run,
                vec![(AgentId::ClaudeCode, Source::GetUsage)],
                "{trigger:?}"
            );
            let mut input = claude_attempted(5 * 60 - 1);
            input.trigger = trigger;
            assert_eq!(decide(&input).run, vec![], "{trigger:?}");
        }
    }

    #[test]
    fn ac13b_app_server_background_spacing_stays_5_min() {
        let mut input = base_input(vec![codex_agent(vec![SourceSchedule {
            source: Source::AppServer,
            last_attempt: Some(NOW - 5 * 60),
            rate_limited_until: None,
        }])]);
        input.trigger = Trigger::Tick;
        assert_eq!(
            decide(&input).run,
            vec![(AgentId::Codex, Source::AppServer)]
        );
    }

    // ---------------- AC18b：没给时间的限流，退避翻倍、封顶 60 分钟 ----------------

    #[test]
    fn ac18b_backoff_doubles_from_5_min_and_caps_at_60() {
        let minutes: Vec<i64> = (1..=7).map(|n| rate_limit_backoff_secs(n) / 60).collect();
        assert_eq!(minutes, vec![5, 10, 20, 40, 60, 60, 60]);
        assert_eq!(rate_limit_backoff_secs(0), 5 * 60, "0 当作第一次");
        assert_eq!(rate_limit_backoff_secs(u32::MAX), 60 * 60, "不溢出");
    }

    #[test]
    fn ac18b_told_until_wins_over_backoff() {
        assert_eq!(
            rate_limited_until(NOW, Some(NOW + 30 * 60), 3),
            NOW + 30 * 60
        );
        assert_eq!(rate_limited_until(NOW, None, 3), NOW + 20 * 60);
        assert_eq!(
            rate_limited_until(NOW, Some(NOW - 10), 1),
            NOW,
            "给的时刻已经过去：不早于现在"
        );
    }

    #[test]
    fn ac13_codex_rollout_can_run_every_minute_tick() {
        let mut input = base_input(vec![codex_agent(vec![
            SourceSchedule {
                source: Source::Rollout,
                last_attempt: Some(NOW - 60), // 1 分钟前跑过，早就超过 30 秒
                rate_limited_until: None,
            },
            never_run(Source::AppServer),
        ])]);
        input.refresh = Refresh::Every1;
        input.trigger = Trigger::Tick;
        let plan = decide(&input);
        assert_eq!(plan.run, vec![(AgentId::Codex, Source::Rollout)]);
    }

    // ---------------- Codex 取法链新鲜度（AC5、AC6） ----------------

    #[test]
    fn ac5_fresh_rollout_data_skips_app_server() {
        let mut agent = codex_agent(vec![
            SourceSchedule {
                source: Source::Rollout,
                last_attempt: Some(NOW - 10),
                rate_limited_until: None,
            },
            never_run(Source::AppServer),
        ]);
        // 会话记录 10 秒前刚成功读到（远小于 30 秒最短间隔），数据够新
        agent.last_success_observed_at = Some(NOW - 10);
        let mut input = base_input(vec![agent]);
        input.trigger = Trigger::Manual;
        let plan = decide(&input);
        // Rollout 自己 10 秒前刚跑过，30 秒最短间隔没到；数据又够新，不该退到 AppServer
        assert_eq!(plan.run, vec![]);
    }

    #[test]
    fn ac6_stale_rollout_data_falls_back_to_app_server() {
        let mut agent = codex_agent(vec![
            SourceSchedule {
                source: Source::Rollout,
                last_attempt: Some(NOW - 40), // 超过 30 秒最短间隔，Rollout 本可以再跑
                rate_limited_until: None,
            },
            never_run(Source::AppServer),
        ]);
        agent.last_success_observed_at = Some(NOW - 40); // 数据本身也超过 30 秒，不够新
        let mut input = base_input(vec![agent]);
        input.trigger = Trigger::Manual;
        let plan = decide(&input);
        // Rollout 此刻自己就能跑，取法链找到第一个能跑的就返回，不需要 AppServer
        assert_eq!(plan.run, vec![(AgentId::Codex, Source::Rollout)]);
    }

    #[test]
    fn ac6_rollout_blocked_by_spacing_and_stale_falls_back_to_app_server() {
        let mut agent = codex_agent(vec![
            SourceSchedule {
                source: Source::Rollout,
                last_attempt: Some(NOW - 10), // Rollout 自己 30 秒间隔还没到，不能再跑
                rate_limited_until: None,
            },
            never_run(Source::AppServer),
        ]);
        // 但目前手头的数据是很久以前成功读到的（例如那次 Rollout 之后一直没找到新的额度记录），
        // 已经超过 Rollout 的最短间隔，判定为不够新，允许退到 app-server
        agent.last_success_observed_at = Some(NOW - 40);
        let mut input = base_input(vec![agent]);
        input.trigger = Trigger::Manual;
        let plan = decide(&input);
        assert_eq!(plan.run, vec![(AgentId::Codex, Source::AppServer)]);
    }

    // ---------------- 限流（AC18） ----------------

    #[test]
    fn ac18_rate_limited_source_never_runs_before_until() {
        let mut input = base_input(vec![claude_agent(vec![SourceSchedule {
            source: Source::GetUsage,
            last_attempt: Some(NOW - 10 * 60),
            rate_limited_until: Some(NOW + 30 * 60),
        }])]);
        input.trigger = Trigger::Manual;
        let plan = decide(&input);
        assert_eq!(plan.run, vec![]);
        assert_eq!(plan.wake_at, Some(NOW + 30 * 60));
    }

    #[test]
    fn ac18_rate_limited_until_exactly_now_allows_run() {
        let mut input = base_input(vec![claude_agent(vec![SourceSchedule {
            source: Source::GetUsage,
            last_attempt: Some(NOW - 10 * 60),
            rate_limited_until: Some(NOW),
        }])]);
        input.trigger = Trigger::Manual;
        let plan = decide(&input);
        assert_eq!(plan.run, vec![(AgentId::ClaudeCode, Source::GetUsage)]);
    }

    #[test]
    fn ac18_rate_limit_on_app_server_also_blocks_it_but_not_local_rollout() {
        // 同一个 agent 里，AppServer 被限流时，Rollout（本机、不打服务端请求）不受影响；
        // 但如果 Rollout 数据也不够新，取法链本来就该先看 Rollout——这里让 Rollout 数据够新，
        // 确认它照样能跑，AppServer 被限流挡住不影响它
        let mut agent = codex_agent(vec![
            SourceSchedule {
                source: Source::Rollout,
                last_attempt: Some(NOW - 40),
                rate_limited_until: None,
            },
            SourceSchedule {
                source: Source::AppServer,
                last_attempt: Some(NOW - 10 * 60),
                rate_limited_until: Some(NOW + 30 * 60),
            },
        ]);
        agent.last_success_observed_at = Some(NOW - 40);
        let mut input = base_input(vec![agent]);
        input.trigger = Trigger::Manual;
        let plan = decide(&input);
        assert_eq!(plan.run, vec![(AgentId::Codex, Source::Rollout)]);
    }

    #[test]
    fn ac18_rate_limit_on_one_process_source_blocks_sibling_process_source() {
        // 这一版 Codex 只有一条会起进程的取法，用两个假想的「同一 agent 下两条起进程取法」的
        // 场景验证「同后端」聚合：AppServer 被限流时，另一条非 Rollout 取法（这里复用 GetUsage
        // 只是为了在类型系统里造出「非 Rollout 的第二条取法」，不代表真实产品形态）也一起挡住
        let agent = codex_agent(vec![
            SourceSchedule {
                source: Source::AppServer,
                last_attempt: None,
                rate_limited_until: Some(NOW + 10 * 60),
            },
            SourceSchedule {
                source: Source::GetUsage,
                last_attempt: None,
                rate_limited_until: None,
            },
        ]);
        let mut input = base_input(vec![agent]);
        input.trigger = Trigger::Manual;
        let plan = decide(&input);
        assert_eq!(
            plan.run,
            vec![],
            "AppServer 被限流时，同 agent 下另一条非 Rollout 取法也一起等"
        );
        // 限流解除的时刻本身不会把 wake_at 提前（同「单纯的最短间隔冷却」，交给周期性 tick
        // 兜底）：这里退回自动档、从没打开过托盘的 30 分钟周期
        assert_eq!(plan.wake_at, Some(NOW + 30 * 60));
    }

    // ---------------- 重置边界（AC15） ----------------

    #[test]
    fn ac15_reset_already_past_and_uncovered_runs_immediately_if_spacing_allows() {
        let mut agent = claude_agent(vec![SourceSchedule {
            source: Source::GetUsage,
            last_attempt: Some(NOW - 10 * 60), // 早就超过 5 分钟最短间隔
            rate_limited_until: None,
        }]);
        agent.next_reset = Some(NOW - 60); // 重置时刻已经过去 1 分钟
        agent.last_success_observed_at = Some(NOW - 10 * 60); // 上次成功读数比重置还早，没盖住
        let mut input = base_input(vec![agent]);
        input.trigger = Trigger::Tick;
        let plan = decide(&input);
        assert_eq!(plan.run, vec![(AgentId::ClaudeCode, Source::GetUsage)]);
    }

    #[test]
    fn ac15_reset_past_but_spacing_not_yet_allows_wakes_at_earliest_allowed() {
        let mut agent = claude_agent(vec![SourceSchedule {
            source: Source::GetUsage,
            last_attempt: Some(NOW - 60), // 1 分钟前跑过，5 分钟间隔还没到
            rate_limited_until: None,
        }]);
        agent.next_reset = Some(NOW - 10); // 重置时刻已经过去 10 秒
        agent.last_success_observed_at = Some(NOW - 60);
        let mut input = base_input(vec![agent]);
        input.trigger = Trigger::Tick;
        let plan = decide(&input);
        assert_eq!(plan.run, vec![]);
        // 最短间隔允许的时刻 = 上次尝试(NOW-60) + 300s = NOW + 240；重置早就过去，
        // wake_at 取 max(重置时刻, 最短间隔允许的时刻) = NOW + 240
        assert_eq!(plan.wake_at, Some(NOW + 240));
    }

    #[test]
    fn ac15_reset_covered_by_fresh_reading_does_not_force_extra_run() {
        let mut agent = claude_agent(vec![SourceSchedule {
            source: Source::GetUsage,
            last_attempt: Some(NOW - 60),
            rate_limited_until: None,
        }]);
        agent.next_reset = Some(NOW - 10);
        agent.last_success_observed_at = Some(NOW); // 已经在重置之后成功读过一次，数据是新的
        let mut input = base_input(vec![agent]);
        input.trigger = Trigger::Tick;
        let plan = decide(&input);
        assert_eq!(plan.run, vec![]);
        // 重置边界已经被盖住，不应该出现来自重置逻辑的额外 wake 候选；这里唯一的候选是
        // 常规的自动档周期（30 分钟，因为 last_opened 是 None）
        assert_eq!(plan.wake_at, Some(NOW + 30 * 60));
    }

    #[test]
    fn ac15_future_reset_pulls_wake_at_earlier_than_periodic_tick() {
        // last_attempt 定在 4 分钟前：5 分钟最短间隔还没到（这条取法此刻不能跑），但间隔
        // 允许的时刻（NOW+60）比重置时刻（NOW+120）更早，所以最终候选取的是重置时刻本身
        let mut agent = claude_agent(vec![SourceSchedule {
            source: Source::GetUsage,
            last_attempt: Some(NOW - 4 * 60),
            rate_limited_until: None,
        }]);
        agent.next_reset = Some(NOW + 120); // 2 分钟后重置，比自动档 30 分钟周期短得多
        agent.last_success_observed_at = Some(NOW - 4 * 60);
        let mut input = base_input(vec![agent]);
        input.trigger = Trigger::Tick;
        let plan = decide(&input);
        assert_eq!(
            plan.run,
            vec![],
            "重置时刻还没到，取法自己的最短间隔也还没到"
        );
        assert_eq!(
            plan.wake_at,
            Some(NOW + 120),
            "应该提前在重置时刻醒一次，而不是等 30 分钟的周期"
        );
    }

    // ---------------- 没有可用 agent / agent 不可用 ----------------

    #[test]
    fn unavailable_agent_never_runs() {
        let mut agent = claude_agent(vec![never_run(Source::GetUsage)]);
        agent.available = false;
        let mut input = base_input(vec![agent]);
        input.trigger = Trigger::Manual;
        let plan = decide(&input);
        assert_eq!(plan.run, vec![]);
    }

    #[test]
    fn no_agents_still_has_periodic_wake_when_visible_and_not_off() {
        let input = base_input(vec![]);
        let plan = decide(&input);
        assert_eq!(plan.run, vec![]);
        assert_eq!(plan.wake_at, Some(NOW + 30 * 60));
    }
}
