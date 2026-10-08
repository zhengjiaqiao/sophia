//! 自动上报的纯逻辑（spec 2026-10-04-reporting-feedback R5–R9）：异常按两层固定类别计数、按天存在数据目录的
//! `report-counts.json`、每日上报的内容与「该不该发」。只组装、不联网——发送在 `src-tauri/src/report.rs`。
//!
//! 接入点只调 [`count`]：上报开着才记，按出事时的本地日期记在内存里（[`Pending`]），不碰文件。应用侧的
//! [`Reporter`] 定时把它并进 `report-counts.json`、组装要发的批次、记下发成功与失败；开关也经它，切换时作废
//! 正在发的那一批。安装 ID 与开关在 `settings.json`（`Store::set_auto_report`）。
use serde::{Deserialize, Serialize};
use std::cell::Cell;
use std::collections::BTreeMap;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

mod events;
pub mod feedback;
mod reporter;
pub use events::{
    body as event_body, crash_events, normalize, signature, Event, EventsFile, BODY_MAX_BYTES,
    CRASH_FILE, EVENTS_FILE, MAX_QUEUED,
};
pub use reporter::{
    append_crash_report, append_panic_marker, Batch, EventBatch, Reporter, CRASH_FILE_MAX_BYTES,
    PANIC_MARKERS_FILE,
};

/// 数据目录下按天计数的文件
pub const COUNTS_FILE: &str = "report-counts.json";
/// 当天已经发过，至少隔这么久、且次数变了，才用累计数再覆盖一次（服务端按安装 ID + 日期只留一行）
pub const RESEND_AFTER_SECS: u64 = 6 * 3600;
/// 没发出去的前几天最多补到这么多天前；更早的记录丢掉（文件里至多 31 天）
pub const MAX_AGE_DAYS: i64 = 30;

/// 异常的固定类别。前四种是 Sophia 自身的，后四种是外部原因（网络、第三方服务、用户自己的配置）。
/// 序列化成与计数里同名的 camelCase（`panic`、`pageFault`……），事件签名的前缀也用它
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// Rust 崩溃（panic）
    Panic,
    /// 网页某一页渲染出错（错误边界接住的）
    PageFault,
    /// 网页侧未捕获的错误、未处理的 Promise 拒绝
    Uncaught,
    /// 命令报的 `internal` 类内部错误
    Internal,
    /// 连不上、超时
    Network,
    /// 第三方服务回了错（5xx、限流、读不懂的响应）
    Upstream,
    /// 写用户的配置文件没写成（磁盘满、没权限、只读……）
    WriteFailure,
    /// 第三方服务鉴权失败（密钥不对）
    Auth,
}

impl Kind {
    pub const ALL: [Kind; 8] = [
        Kind::Panic,
        Kind::PageFault,
        Kind::Uncaught,
        Kind::Internal,
        Kind::Network,
        Kind::Upstream,
        Kind::WriteFailure,
        Kind::Auth,
    ];

    /// Sophia 自身的错误（崩溃、页面出错、未捕获的错误、内部错误）：这四类才上传事件，外部原因只计数（R8）
    pub fn is_own(self) -> bool {
        matches!(
            self,
            Kind::Panic | Kind::PageFault | Kind::Uncaught | Kind::Internal
        )
    }

    /// 与序列化同名（`pageFault`……）
    pub fn name(self) -> &'static str {
        match self {
            Kind::Panic => "panic",
            Kind::PageFault => "pageFault",
            Kind::Uncaught => "uncaught",
            Kind::Internal => "internal",
            Kind::Network => "network",
            Kind::Upstream => "upstream",
            Kind::WriteFailure => "writeFailure",
            Kind::Auth => "auth",
        }
    }

    /// 网页侧经命令报上来的类别名；网页只报它自己的两种
    pub fn from_frontend(name: &str) -> Option<Kind> {
        match name {
            "pageFault" => Some(Kind::PageFault),
            "uncaught" => Some(Kind::Uncaught),
            _ => None,
        }
    }

    /// 命令错误串的代码（docs/gateway-commands.md「错误」）→ 类别。用户填的不对（`invalid`）、文件被别人改过、
    /// 桌面应用忙这些不是异常，不计
    pub fn from_error_code(code: &str) -> Option<Kind> {
        match code {
            "internal" => Some(Kind::Internal),
            "network" => Some(Kind::Network),
            "upstream" => Some(Kind::Upstream),
            "auth" => Some(Kind::Auth),
            _ => None,
        }
    }
}

/// Sophia 自身的异常次数
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SelfCounts {
    pub panic: u32,
    pub page_fault: u32,
    pub uncaught: u32,
    pub internal: u32,
}

/// 外部原因的异常次数
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExternalCounts {
    pub network: u32,
    pub upstream: u32,
    pub write_failure: u32,
    pub auth: u32,
}

/// 两层异常次数，写盘与上报都是 `{"self": {…}, "external": {…}}`
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Counts {
    #[serde(rename = "self")]
    pub own: SelfCounts,
    pub external: ExternalCounts,
}

impl Counts {
    fn slot(&mut self, kind: Kind) -> &mut u32 {
        match kind {
            Kind::Panic => &mut self.own.panic,
            Kind::PageFault => &mut self.own.page_fault,
            Kind::Uncaught => &mut self.own.uncaught,
            Kind::Internal => &mut self.own.internal,
            Kind::Network => &mut self.external.network,
            Kind::Upstream => &mut self.external.upstream,
            Kind::WriteFailure => &mut self.external.write_failure,
            Kind::Auth => &mut self.external.auth,
        }
    }

    pub fn get(&self, kind: Kind) -> u32 {
        let mut copy = *self;
        *copy.slot(kind)
    }

    /// 加 `n` 次；到顶不再长
    pub fn add(&mut self, kind: Kind, n: u32) {
        let slot = self.slot(kind);
        *slot = slot.saturating_add(n);
    }

    pub fn merge(&mut self, other: &Counts) {
        for kind in Kind::ALL {
            self.add(kind, other.get(kind));
        }
    }

    /// 逐项取大
    pub fn max(&self, other: &Counts) -> Counts {
        let mut out = *self;
        for kind in Kind::ALL {
            let n = other.get(kind);
            let slot = out.slot(kind);
            *slot = (*slot).max(n);
        }
        out
    }

    pub fn is_zero(&self) -> bool {
        Kind::ALL.iter().all(|&kind| self.get(kind) == 0)
    }
}

/// 进程里还没落盘的次数，按出事那一刻的本地日期分（Codex 复审 6：午夜前的异常不能记到第二天）。
/// 上报关着时（`enabled` 为假，默认）什么都不记（复审 5）；本地时区偏移由应用侧给
pub struct Pending {
    /// 开关的快速判断（关着时不进锁）；作数的是锁里的那一份
    enabled: AtomicBool,
    /// 开关每动一次加一；计数开始时先读它，拿到锁后再对一次（Codex 第 2 轮 3）
    generation: AtomicU64,
    offset_secs: AtomicI64,
    state: Mutex<PendingState>,
}

struct PendingState {
    enabled: bool,
    generation: u64,
    days: BTreeMap<String, Counts>,
    /// 还没落盘的事件（[`events`]）：与次数同一把锁、同一个开关与代次
    events: Vec<Event>,
    /// 应用侧交来的应用版本与系统大版本，收事件时记进去（[`Pending::set_app_info`]）
    app_version: String,
    app_os: String,
}

impl Pending {
    pub const fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            offset_secs: AtomicI64::new(0),
            state: Mutex::new(PendingState {
                enabled: false,
                generation: 0,
                days: BTreeMap::new(),
                events: Vec::new(),
                app_version: String::new(),
                app_os: String::new(),
            }),
        }
    }

    fn state(&self) -> MutexGuard<'_, PendingState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// 开着才计数、收事件；关掉时把还没落盘的次数与事件一并清掉。开关真的变了，代次加一
    pub fn set_enabled(&self, enabled: bool) {
        let mut state = self.state();
        if state.enabled != enabled {
            state.enabled = enabled;
            state.generation += 1;
            self.generation.store(state.generation, Ordering::SeqCst);
            self.enabled.store(enabled, Ordering::SeqCst);
        }
        if !enabled {
            state.days.clear();
            state.events.clear();
        }
    }

    /// 本地时区相对 UTC 的秒数（东八区 28800）
    pub fn set_local_offset(&self, offset_secs: i64) {
        self.offset_secs.store(offset_secs, Ordering::Relaxed);
    }

    pub fn count(&self, kind: Kind) {
        self.count_at(kind, unix_now());
    }

    /// 记在 `unix_secs` 那一刻的本地日期上
    pub fn count_at(&self, kind: Kind, unix_secs: u64) {
        self.count_at_with(kind, unix_secs, || {}, || {});
    }

    /// 同 [`Pending::count_at`]。第一件事是读开关代次（出事那一刻的代次），之后才看开关、算日期、拿锁；
    /// 拿到锁时开关已关、或代次变了（关掉又打开过），这一次落不进新的一段，丢掉（Codex 第 2、3 轮）。
    /// `first` 在读代次之后、看开关之前跑，`between` 在拿锁之前跑（测试用来插入开关切换）
    fn count_at_with(
        &self,
        kind: Kind,
        unix_secs: u64,
        first: impl FnOnce(),
        between: impl FnOnce(),
    ) {
        let generation = self.generation.load(Ordering::SeqCst);
        first();
        if !self.enabled() {
            return;
        }
        let day = local_day(unix_secs, self.offset_secs.load(Ordering::Relaxed));
        between();
        {
            let mut state = self.state();
            if !state.enabled || state.generation != generation {
                return;
            }
            state.days.entry(day).or_default().add(kind, 1);
        }
        mark_scope();
    }

    /// 写用户的配置文件没写成：记一次 `writeFailure`。「被别人改过」不是失败，不计
    pub fn count_write_failure(&self, error: &io::Error) {
        if crate::atomicfile::write_failure(error) != crate::atomicfile::WriteFailure::Changed {
            self.count(Kind::WriteFailure);
        }
    }

    /// 命令报错时按错误代码记一次（[`Kind::from_error_code`]）。这次出错的下层已经记过（例如写配置失败
    /// 被包成 `internal`）就不再记：一次失败只算一次（复审 8）
    pub fn count_command_error(&self, code: &str, inner_counted: bool) {
        if inner_counted {
            return;
        }
        if let Some(kind) = Kind::from_error_code(code) {
            self.count(kind);
        }
    }

    /// 取出并清空（按日期）
    pub fn take(&self) -> BTreeMap<String, Counts> {
        std::mem::take(&mut self.state().days)
    }

    /// 落盘没成：把取出来的放回去，下次再落（复审 4）。这期间关掉了就不放回
    pub fn restore(&self, taken: BTreeMap<String, Counts>) {
        let mut state = self.state();
        if !state.enabled {
            return;
        }
        for (day, counts) in taken {
            state.days.entry(day).or_default().merge(&counts);
        }
    }

    pub fn clear(&self) {
        let mut state = self.state();
        state.days.clear();
        state.events.clear();
    }
}

impl Default for Pending {
    fn default() -> Self {
        Self::new()
    }
}

/// 在 [`scoped`] 里时，记下这条线程记过异常
fn mark_scope() {
    SCOPE.with(|scope| {
        if scope.get().is_some() {
            scope.set(Some(true));
        }
    });
}

thread_local! {
    /// [`scoped`] 里这条线程有没有记过异常；不在 `scoped` 里为 None
    static SCOPE: Cell<Option<bool>> = const { Cell::new(None) };
}

/// 跑 `f`，并告诉调用方这期间这条线程有没有记过异常。命令层据此避免把下层已经记过的失败再记一次（复审 8）
pub fn scoped<R>(f: impl FnOnce() -> R) -> (R, bool) {
    let outer = SCOPE.with(|scope| scope.replace(Some(false)));
    let result = f();
    let counted = SCOPE.with(|scope| scope.get() == Some(true));
    SCOPE.with(|scope| scope.set(outer.map(|o| o || counted)));
    (result, counted)
}

/// 进程里共用的那一份：接入点都记在这里，应用侧的 [`Reporter`] 定时落盘
pub static PENDING: Pending = Pending::new();

/// 记一次异常（各接入点只调这一行）。上报关着时什么都不做
pub fn count(kind: Kind) {
    PENDING.count(kind);
}

/// 记一次 Sophia 自身的错误并收一条事件（去隐私后的原文，[`events`]）；外部原因只计数、不收原文（R8）。
/// 计数与入队是同一次代次判定（[`Pending::capture`]）。`location` 是出错位置（`文件:行`；网页侧为空）。
/// 上报关着时什么都不做
pub fn capture(kind: Kind, location: &str, text: &str) {
    #[cfg(test)]
    captured::record(kind, location);
    PENDING.capture(kind, location, text);
}

/// 测试用：这条测试线程经 [`capture`] 交来的（类别, 出错位置）。全局的 `PENDING` 要开着上报才收、
/// 并行的测试会互相串，这里按线程记，只看自己的
#[cfg(test)]
pub(crate) mod captured {
    use super::Kind;
    use std::cell::RefCell;

    thread_local! {
        static SEEN: RefCell<Vec<(Kind, String)>> = const { RefCell::new(Vec::new()) };
    }

    pub(crate) fn record(kind: Kind, location: &str) {
        SEEN.with(|seen| seen.borrow_mut().push((kind, location.to_owned())));
    }

    /// 取出并清空
    pub(crate) fn take() -> Vec<(Kind, String)> {
        SEEN.with(|seen| std::mem::take(&mut *seen.borrow_mut()))
    }
}

/// 命令报的 `internal` 类内部错误：计数并收一条事件，出错位置是调用处的 `文件:行`。取代单独的
/// `count(Kind::Internal)`
#[track_caller]
pub fn capture_internal(text: &str) {
    capture(Kind::Internal, &caller_location(), text);
}

/// 调用处的 `文件:行`
#[track_caller]
fn caller_location() -> String {
    let at = std::panic::Location::caller();
    format!("{}:{}", at.file(), at.line())
}

/// 命令报错时按错误代码记一次；不算异常的代码不记
pub fn count_error_code(code: &str) {
    PENDING.count_command_error(code, false);
}

/// 同 [`count_error_code`]，下层已经记过（[`scoped`] 的第二个值）就不记
pub fn count_command_error(code: &str, inner_counted: bool) {
    PENDING.count_command_error(code, inner_counted);
}

/// 写用户的配置文件没写成时调（[`Pending::count_write_failure`]）
pub fn count_write_failure(error: &io::Error) {
    PENDING.count_write_failure(error);
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// 发不出去之后隔多久再试（复审：持续失败不能每 30 分钟打一次接收服务）：第 1 次失败 1 小时，
/// 第 2 次 3 小时，第 3 次 6 小时，之后每 24 小时；发成功一次就清零
pub fn retry_delay(failures: u32) -> u64 {
    match failures {
        0 => 0,
        1 => 3600,
        2 => 3 * 3600,
        3 => 6 * 3600,
        _ => 24 * 3600,
    }
}

/// 一天的记录：累计次数，以及上一次发出去的时刻与当时发的次数（没发过为 None）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DayRecord {
    pub counts: Counts,
    pub sent_at: Option<u64>,
    pub sent_counts: Option<Counts>,
}

/// 连续发失败的次数与下次最早什么时候再试
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Retry {
    pub failures: u32,
    pub not_before: Option<u64>,
}

impl Retry {
    /// 发失败后还在等。等待时刻比现在晚 24 小时以上（改过系统时间）不当真
    pub fn waiting(&self, now: u64) -> bool {
        self.not_before
            .is_some_and(|t| now < t && t - now <= retry_delay(u32::MAX))
    }

    /// 又失败了一次：按连续失败的次数往后等（[`retry_delay`]）
    pub fn fail(&mut self, at: u64) {
        self.failures = self.failures.saturating_add(1);
        self.not_before = Some(at.saturating_add(retry_delay(self.failures)));
    }
}

/// `report-counts.json`：本地日期（`YYYY-MM-DD`）→ 那一天的记录，加上发失败后的等待
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CountsFile {
    pub days: BTreeMap<String, DayRecord>,
    pub retry: Retry,
}

impl CountsFile {
    /// 把还没落盘的次数按各自的日期并进来，并保证今天有一条（当天运行过就算活跃，没出错也要报）。
    /// 顺手丢掉超过 30 天的与认不出的日期
    pub fn absorb(&mut self, today: &str, pending: &BTreeMap<String, Counts>) {
        self.days.entry(today.to_owned()).or_default();
        for (day, counts) in pending {
            if day_number(day).is_some() {
                self.days
                    .entry(day.clone())
                    .or_default()
                    .counts
                    .merge(counts);
            }
        }
        self.prune(today);
    }

    /// 上次崩溃时没能落盘、记在旁边小文件里的崩溃（每行一个日期，复审 7）并进来
    pub fn add_panics(&mut self, today: &str, lines: &str) {
        let mut panics: BTreeMap<String, Counts> = BTreeMap::new();
        for day in lines
            .lines()
            .map(str::trim)
            .filter(|d| day_number(d).is_some())
        {
            panics
                .entry(day.to_owned())
                .or_default()
                .add(Kind::Panic, 1);
        }
        self.absorb(today, &panics);
    }

    /// 该发的日子（从旧到新）与各自要发的次数：
    /// - 发失败后还在等（[`retry_delay`]）：都不发
    /// - 今天：没发过就发；发过的，隔够 6 小时且次数变了再用累计数覆盖一次
    /// - 前几天（30 天内）：没发过、或发完之后次数又变了（发完到午夜之间又出过错），补发一次
    /// - 比今天晚的日期（改过系统时间）不发
    ///
    /// 要发的次数逐项不低于那一天已经发过的（本地记录丢过也不会把服务端的数改小，复审 4）
    pub fn due(&self, today: &str, now: u64) -> Vec<(String, Counts)> {
        let Some(today_n) = day_number(today) else {
            return Vec::new();
        };
        if self.retry.waiting(now) {
            return Vec::new();
        }
        self.days
            .iter()
            .filter_map(|(day, record)| {
                let n = day_number(day)?;
                if n > today_n || today_n - n > MAX_AGE_DAYS {
                    return None;
                }
                let send = record.counts.max(&record.sent_counts.unwrap_or_default());
                let changed = record.sent_counts != Some(send);
                let due = match record.sent_at {
                    None => true,
                    Some(_) if n < today_n => changed,
                    Some(at) => changed && now >= at.saturating_add(RESEND_AFTER_SECS),
                };
                due.then(|| (day.clone(), send))
            })
            .collect()
    }

    /// 发成功了：记下时刻与这次发的次数（发的过程中又多出来的次数下次再发），失败的等待清零
    pub fn record_sent(&mut self, day: &str, sent: Counts, at: u64) {
        if let Some(record) = self.days.get_mut(day) {
            record.sent_at = Some(at);
            record.sent_counts = Some(sent);
        }
        self.retry = Retry::default();
    }

    /// 发失败了：按连续失败的次数往后等（[`retry_delay`]）
    pub fn record_failure(&mut self, at: u64) {
        self.retry.fail(at);
    }

    fn prune(&mut self, today: &str) {
        let Some(today_n) = day_number(today) else {
            return;
        };
        // 比今天晚的日期（改过系统时间）留着，等日子到了再发
        self.days
            .retain(|day, _| day_number(day).is_some_and(|n| today_n - n <= MAX_AGE_DAYS));
    }
}

/// `POST /v1/daily` 的内容：只有这几项
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyReport {
    pub install_id: String,
    /// 本地日期 `YYYY-MM-DD`
    pub day: String,
    pub version: String,
    /// 系统大版本，如 `macOS 15`
    pub os: String,
    /// 芯片架构，如 `aarch64`
    pub arch: String,
    pub counts: Counts,
}

/// 一次 `POST /v1/daily` 的结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DailyOutcome {
    /// 200 + `{"ok": true}`：存下了，记已发
    Sent,
    /// 202 + `{"stored": false}`：服务端满了这次不收。不算已发，照失败往后等再补；不是网络问题
    NotStored,
    /// 别的一切：失败，往后等再试
    Failed,
}

/// 按状态码与返回体判断（Codex 第 2 轮 2）：只有 200 `{"ok": true}` 算发出去了
pub fn daily_outcome(status: u16, body: &[u8]) -> DailyOutcome {
    let json: Option<serde_json::Value> = serde_json::from_slice(body).ok();
    let field = |name: &str| {
        json.as_ref()
            .and_then(|v| v.get(name))
            .and_then(|v| v.as_bool())
    };
    match status {
        200 if field("ok") == Some(true) => DailyOutcome::Sent,
        202 if field("stored") == Some(false) => DailyOutcome::NotStored,
        _ => DailyOutcome::Failed,
    }
}

/// `POST /v1/event` 的内容：只有这几项（接收服务 `server/src/ingest.ts` 的 `event`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventReport {
    pub install_id: String,
    pub version: String,
    /// 系统大版本，如 `macOS 15`
    pub os: String,
    pub signature: String,
    pub body: String,
}

/// 一次 `POST /v1/event` 的结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventOutcome {
    /// 202：接收服务处理完了（`stored` 真假都算：假是重复、当天名额满了或库满了，再发也一样）。移出队列
    Done,
    /// 400 / 413：这条不合格，重发也没用。记日志、移出队列
    Rejected,
    /// 别的（网不通、429 限流、5xx、读不懂的回答）：留在队列里，按 1 / 3 / 6 / 24 小时往后等
    Retry,
}

/// 按状态码与返回体判断一次事件上传的结果
pub fn event_outcome(status: u16, body: &[u8]) -> EventOutcome {
    let stored = || {
        serde_json::from_slice::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v.get("stored").and_then(|s| s.as_bool()))
    };
    match status {
        202 if stored().is_some() => EventOutcome::Done,
        400 | 413 => EventOutcome::Rejected,
        _ => EventOutcome::Retry,
    }
}

/// 新的安装 ID：随机 UUID v4，与用户、机器都无关
pub fn new_install_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// `DO_NOT_TRACK` 设了（非空、且不是 `0` / `false`）就不自动发送任何东西
pub fn do_not_track(value: Option<&str>) -> bool {
    value.is_some_and(|v| {
        let v = v.trim();
        !v.is_empty() && v != "0" && !v.eq_ignore_ascii_case("false")
    })
}

/// 每日上报的地址：设了 `DO_NOT_TRACK`、或没有接收服务的基址（开发版、自己编译的版本）就是 None
pub fn daily_endpoint(base: Option<&str>, do_not_track_value: Option<&str>) -> Option<String> {
    endpoint(base, do_not_track_value, "/v1/daily")
}

fn endpoint(base: Option<&str>, do_not_track_value: Option<&str>, path: &str) -> Option<String> {
    if do_not_track(do_not_track_value) {
        return None;
    }
    let base = base?.trim().trim_end_matches('/');
    (!base.is_empty()).then(|| format!("{base}{path}"))
}

/// 事件上传的地址（与 [`daily_endpoint`] 同一套规则，拼 `/v1/event`）
pub fn event_endpoint(base: Option<&str>, do_not_track_value: Option<&str>) -> Option<String> {
    endpoint(base, do_not_track_value, "/v1/event")
}

/// 本地日期 `YYYY-MM-DD`：`unix_secs`（UTC）加上本地时区偏移 `offset_secs` 再取日期
pub fn local_day(unix_secs: u64, offset_secs: i64) -> String {
    let local = (unix_secs as i64).saturating_add(offset_secs).max(0) as u64;
    crate::diagnostics::utc_rfc3339(local)[..10].to_owned()
}

/// `YYYY-MM-DD` → 自 1970-01-01 起的天数（Howard Hinnant 的 days_from_civil）；格式不对为 None
pub fn day_number(day: &str) -> Option<i64> {
    let bytes = day.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| -> Option<i64> {
        let s = &day[r];
        s.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| s.parse().ok())
            .flatten()
    };
    let (y, m, d) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(pairs: &[(Kind, u32)]) -> Counts {
        let mut c = Counts::default();
        for &(kind, n) in pairs {
            c.add(kind, n);
        }
        c
    }

    #[test]
    fn counts_serialize_as_two_layers_with_fixed_names() {
        let c = counts(&[
            (Kind::Panic, 1),
            (Kind::PageFault, 2),
            (Kind::Uncaught, 3),
            (Kind::Internal, 4),
            (Kind::Network, 5),
            (Kind::Upstream, 6),
            (Kind::WriteFailure, 7),
            (Kind::Auth, 8),
        ]);
        assert_eq!(
            serde_json::to_value(c).unwrap(),
            serde_json::json!({
                "self": {"panic": 1, "pageFault": 2, "uncaught": 3, "internal": 4},
                "external": {"network": 5, "upstream": 6, "writeFailure": 7, "auth": 8}
            })
        );
        // 缺字段读成 0
        let partial: Counts = serde_json::from_str(r#"{"self":{"panic":2}}"#).unwrap();
        assert_eq!(partial, counts(&[(Kind::Panic, 2)]));
    }

    #[test]
    fn counts_add_merge_and_saturate() {
        let mut c = counts(&[(Kind::Auth, u32::MAX - 1)]);
        c.add(Kind::Auth, 5);
        assert_eq!(c.get(Kind::Auth), u32::MAX);
        let mut a = counts(&[(Kind::Network, 2)]);
        a.merge(&counts(&[(Kind::Network, 3), (Kind::Panic, 1)]));
        assert_eq!(a, counts(&[(Kind::Network, 5), (Kind::Panic, 1)]));
        assert!(Counts::default().is_zero());
        assert!(!a.is_zero());
    }

    #[test]
    fn kinds_from_frontend_and_error_codes() {
        assert_eq!(Kind::from_frontend("pageFault"), Some(Kind::PageFault));
        assert_eq!(Kind::from_frontend("uncaught"), Some(Kind::Uncaught));
        // 网页侧不能报别的类别
        assert_eq!(Kind::from_frontend("panic"), None);
        assert_eq!(Kind::from_frontend(""), None);
        assert_eq!(Kind::from_error_code("internal"), Some(Kind::Internal));
        assert_eq!(Kind::from_error_code("network"), Some(Kind::Network));
        assert_eq!(Kind::from_error_code("upstream"), Some(Kind::Upstream));
        assert_eq!(Kind::from_error_code("auth"), Some(Kind::Auth));
        for code in [
            "invalid",
            "changed",
            "conflict",
            "desktop_busy",
            "desktop_unavailable",
        ] {
            assert_eq!(Kind::from_error_code(code), None, "{code}");
        }
    }

    // 2026-10-04T15:59:50Z ＝ 东八区 23:59:50
    const BEFORE_MIDNIGHT: u64 = 1_791_129_590;

    fn pending_on() -> Pending {
        let p = Pending::new();
        p.set_local_offset(8 * 3600);
        p.set_enabled(true);
        p
    }

    fn map(entries: &[(&str, Counts)]) -> BTreeMap<String, Counts> {
        entries.iter().map(|(d, c)| (d.to_string(), *c)).collect()
    }

    /// 用独立的一份，不碰进程里共用的那份
    #[test]
    fn pending_counts_by_local_day_of_the_moment() {
        let p = pending_on();
        p.count_at(Kind::Panic, BEFORE_MIDNIGHT);
        p.count_at(Kind::Panic, BEFORE_MIDNIGHT + 5);
        // 20 秒后已是第二天（复审 6）
        p.count_at(Kind::Upstream, BEFORE_MIDNIGHT + 20);
        assert_eq!(
            p.take(),
            map(&[
                ("2026-10-04", counts(&[(Kind::Panic, 2)])),
                ("2026-10-05", counts(&[(Kind::Upstream, 1)])),
            ])
        );
        assert!(p.take().is_empty());
    }

    /// 关着时不记；关掉时清掉还没落盘的（复审 5）
    #[test]
    fn pending_is_a_no_op_while_off_and_turning_off_clears_it() {
        let p = Pending::new();
        p.count_at(Kind::Panic, BEFORE_MIDNIGHT);
        assert!(p.take().is_empty());
        p.set_enabled(true);
        p.count_at(Kind::Panic, BEFORE_MIDNIGHT);
        p.set_enabled(false);
        p.set_enabled(true);
        assert!(p.take().is_empty());
    }

    /// 落盘没成时放回去；这期间关掉了就不放回（复审 4、5）
    #[test]
    fn pending_restore_merges_back_unless_switched_off() {
        let p = pending_on();
        p.count_at(Kind::Auth, BEFORE_MIDNIGHT);
        let taken = p.take();
        p.count_at(Kind::Auth, BEFORE_MIDNIGHT);
        p.restore(taken.clone());
        assert_eq!(p.take(), map(&[("2026-10-04", counts(&[(Kind::Auth, 2)]))]));
        p.set_enabled(false);
        p.restore(taken);
        p.set_enabled(true);
        assert!(p.take().is_empty());
    }

    #[test]
    fn write_failures_count_except_changed() {
        let p = pending_on();
        p.count_write_failure(&io::Error::from_raw_os_error(28));
        p.count_write_failure(&io::Error::from(io::ErrorKind::PermissionDenied));
        p.count_write_failure(&io::Error::other("symlink parent"));
        p.count_write_failure(&io::Error::other("changed"));
        p.count_write_failure(&io::Error::from(io::ErrorKind::AlreadyExists));
        let total: u32 = p.take().values().map(|c| c.get(Kind::WriteFailure)).sum();
        assert_eq!(total, 3);
    }

    /// 一次失败只算一次（复审 8）：下层已经记了写失败，命令层把它包成 internal 时不再记
    #[test]
    fn command_errors_are_not_counted_twice() {
        let p = pending_on();
        let (code, inner) = scoped(|| {
            p.count_write_failure(&io::Error::from(io::ErrorKind::PermissionDenied));
            "internal"
        });
        assert!(inner);
        p.count_command_error(code, inner);
        let (code, inner) = scoped(|| "internal");
        assert!(!inner);
        p.count_command_error(code, inner);
        p.count_command_error("invalid", false);
        let total = p.take().values().fold(Counts::default(), |mut a, c| {
            a.merge(c);
            a
        });
        assert_eq!(
            total,
            counts(&[(Kind::WriteFailure, 1), (Kind::Internal, 1)])
        );
    }

    /// 套着用：里面记过，外面也算记过；里面没记，不影响外面已记的
    #[test]
    fn scopes_nest() {
        let p = pending_on();
        let ((_, inner), outer) = scoped(|| {
            p.count(Kind::Network);
            scoped(|| ())
        });
        assert!(!inner);
        assert!(outer);
        let ((_, inner), outer) = scoped(|| scoped(|| p.count(Kind::Network)));
        assert!(inner && outer);
        // 不在 scoped 里记，不出错
        p.count(Kind::Network);
    }

    /// 本地日期：UTC 时刻加上本地时区偏移再取日期
    #[test]
    fn local_day_applies_the_offset() {
        // 2026-10-04T16:30:00Z
        let t = 1_791_131_400;
        assert_eq!(local_day(t, 0), "2026-10-04");
        assert_eq!(local_day(t, 8 * 3600), "2026-10-05");
        assert_eq!(local_day(t, -17 * 3600), "2026-10-03");
        assert_eq!(day_number(&local_day(t, 0)), Some(20_730));
    }

    #[test]
    fn day_numbers() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_number("2026-10-04"), Some(20_730));
        assert_eq!(
            day_number("2024-03-01").unwrap() - day_number("2024-02-28").unwrap(),
            2
        );
        for bad in [
            "",
            "2026-1-04",
            "2026/10/04",
            "2026-13-01",
            "2026-10-00",
            "abcd-ef-gh",
            "+026-10-04",
        ] {
            assert_eq!(day_number(bad), None, "{bad}");
        }
    }

    #[test]
    fn absorb_creates_today_even_without_errors_and_prunes_old_days() {
        let mut file = CountsFile::default();
        file.absorb("2026-10-04", &map(&[("2026-10-04", Counts::default())]));
        assert_eq!(file.days.len(), 1);
        assert!(file.days["2026-10-04"].counts.is_zero());

        file.absorb(
            "2026-10-04",
            &map(&[("2026-10-04", counts(&[(Kind::Network, 2)]))]),
        );
        file.absorb(
            "2026-10-04",
            &map(&[("2026-10-04", counts(&[(Kind::Network, 1)]))]),
        );
        assert_eq!(
            file.days["2026-10-04"].counts,
            counts(&[(Kind::Network, 3)])
        );

        file.days.insert("2026-09-04".into(), DayRecord::default()); // 恰 30 天前：留
        file.days.insert("2026-09-03".into(), DayRecord::default()); // 31 天前：丢
        file.days.insert("garbage".into(), DayRecord::default());
        file.absorb("2026-10-04", &map(&[("2026-10-04", Counts::default())]));
        let days: Vec<&str> = file.days.keys().map(String::as_str).collect();
        assert_eq!(days, ["2026-09-04", "2026-10-04"]);
    }

    const H: u64 = 3600;

    #[test]
    fn today_is_due_until_sent_then_every_six_hours_if_changed() {
        let mut file = CountsFile::default();
        file.absorb("2026-10-04", &map(&[("2026-10-04", Counts::default())]));
        let t0 = 1_000_000;
        assert_eq!(
            file.due("2026-10-04", t0),
            vec![("2026-10-04".to_string(), Counts::default())]
        );
        file.record_sent("2026-10-04", Counts::default(), t0);
        // 发过、没变：不再发
        assert!(file.due("2026-10-04", t0 + 7 * H).is_empty());
        // 变了但不到 6 小时：不发
        file.absorb(
            "2026-10-04",
            &map(&[("2026-10-04", counts(&[(Kind::Auth, 1)]))]),
        );
        assert!(file.due("2026-10-04", t0 + 6 * H - 1).is_empty());
        // 满 6 小时：用累计数覆盖
        assert_eq!(
            file.due("2026-10-04", t0 + 6 * H),
            vec![("2026-10-04".to_string(), counts(&[(Kind::Auth, 1)]))]
        );
        // 时钟往回拨：不当成隔够了
        assert!(file.due("2026-10-04", t0 - H).is_empty());
    }

    #[test]
    fn previous_days_are_resent_when_unsent_or_changed_and_failures_do_not_record() {
        let mut file = CountsFile::default();
        file.absorb(
            "2026-10-01",
            &map(&[("2026-10-01", counts(&[(Kind::Panic, 1)]))]),
        );
        file.absorb("2026-10-02", &map(&[("2026-10-02", Counts::default())]));
        file.record_sent("2026-10-02", Counts::default(), 10);
        file.absorb("2026-10-03", &map(&[("2026-10-03", Counts::default())]));
        file.record_sent("2026-10-03", Counts::default(), 20);
        // 10-03 发完之后又出过错（还在 10-03 那天）
        file.days.get_mut("2026-10-03").unwrap().counts = counts(&[(Kind::Uncaught, 2)]);
        file.absorb("2026-10-04", &map(&[("2026-10-04", Counts::default())]));

        let due = file.due("2026-10-04", 30);
        let days: Vec<&str> = due.iter().map(|(d, _)| d.as_str()).collect();
        // 从旧到新；10-02 发过且没变，不补
        assert_eq!(days, ["2026-10-01", "2026-10-03", "2026-10-04"]);
        assert_eq!(due[1].1, counts(&[(Kind::Uncaught, 2)]));

        // 发失败的不记：再问还是这些
        assert_eq!(file.due("2026-10-04", 40), due);
        // 发成功一天，只少那一天
        file.record_sent("2026-10-01", due[0].1, 50);
        assert_eq!(file.due("2026-10-04", 60).len(), 2);
        // 不存在的日子记不上，也不新建
        file.record_sent("2026-01-01", Counts::default(), 70);
        assert!(!file.days.contains_key("2026-01-01"));
    }

    /// 次数按各自的日期并进来：昨天的不会记到今天
    #[test]
    fn absorb_keeps_each_day_and_ignores_bad_keys() {
        let mut file = CountsFile::default();
        file.absorb(
            "2026-10-05",
            &map(&[
                ("2026-10-04", counts(&[(Kind::Panic, 1)])),
                ("bad", counts(&[(Kind::Panic, 9)])),
            ]),
        );
        let days: Vec<&str> = file.days.keys().map(String::as_str).collect();
        assert_eq!(days, ["2026-10-04", "2026-10-05"]);
        assert_eq!(file.days["2026-10-04"].counts, counts(&[(Kind::Panic, 1)]));
        assert!(file.days["2026-10-05"].counts.is_zero());
    }

    /// 本地记录丢过（比已发的少）：要发的逐项不低于已发的，不把服务端的数改小（复审 4）
    #[test]
    fn never_send_a_lower_cumulative_than_already_sent() {
        let mut file = CountsFile::default();
        file.absorb("2026-10-04", &BTreeMap::new());
        file.record_sent("2026-10-04", counts(&[(Kind::Panic, 2)]), 0);
        // 本地只剩 0：与已发的取大还是已发的，不用再发
        assert!(file.due("2026-10-04", 7 * H).is_empty());
        file.absorb(
            "2026-10-04",
            &map(&[("2026-10-04", counts(&[(Kind::Auth, 1)]))]),
        );
        assert_eq!(
            file.due("2026-10-04", 7 * H),
            vec![(
                "2026-10-04".to_string(),
                counts(&[(Kind::Panic, 2), (Kind::Auth, 1)])
            )]
        );
    }

    /// 发失败后的等待：1 小时、3 小时、6 小时、之后 24 小时；发成功清零（复审：额度）
    #[test]
    fn failures_back_off_one_three_six_then_twenty_four_hours() {
        assert_eq!(
            (1..=6).map(retry_delay).collect::<Vec<_>>(),
            [H, 3 * H, 6 * H, 24 * H, 24 * H, 24 * H]
        );
        let mut file = CountsFile::default();
        file.absorb("2026-10-04", &BTreeMap::new());
        let t0 = 1_000_000;
        let mut at = t0;
        for wait in [H, 3 * H, 6 * H, 24 * H, 24 * H] {
            file.record_failure(at);
            assert!(file.due("2026-10-04", at + wait - 1).is_empty(), "{wait}");
            assert_eq!(file.due("2026-10-04", at + wait).len(), 1, "{wait}");
            at += wait;
        }
        file.record_sent("2026-10-04", Counts::default(), at);
        assert_eq!(file.retry, Retry::default());
        file.record_failure(at);
        assert_eq!(file.retry.not_before, Some(at + H));
        // 等待时刻比现在晚 24 小时以上（系统时间往回拨过）：不当真
        file.retry.not_before = Some(at + 30 * H);
        file.days.get_mut("2026-10-04").unwrap().sent_at = None;
        assert_eq!(file.due("2026-10-04", at).len(), 1);
    }

    /// 上次崩溃时没落进去的崩溃次数（旁边小文件里每行一个日期）并进各自那一天
    #[test]
    fn panic_markers_fold_into_their_days() {
        let mut file = CountsFile::default();
        file.add_panics(
            "2026-10-05",
            "2026-10-04\n2026-10-04\n2026-10-05\ngarbage\n\n",
        );
        assert_eq!(file.days["2026-10-04"].counts, counts(&[(Kind::Panic, 2)]));
        assert_eq!(file.days["2026-10-05"].counts, counts(&[(Kind::Panic, 1)]));
    }

    #[test]
    fn days_older_than_thirty_or_in_the_future_are_not_sent() {
        let mut file = CountsFile::default();
        file.days.insert("2026-09-03".into(), DayRecord::default());
        file.days.insert("2026-10-05".into(), DayRecord::default());
        file.days.insert("2026-09-04".into(), DayRecord::default());
        let days: Vec<String> = file
            .due("2026-10-04", 0)
            .into_iter()
            .map(|(d, _)| d)
            .collect();
        assert_eq!(days, ["2026-09-04"]);
        // 今天认不出：什么都不发
        assert!(file.due("bad", 0).is_empty());
    }

    #[test]
    fn counts_file_round_trips_and_tolerates_missing_fields() {
        let mut file = CountsFile::default();
        file.absorb(
            "2026-10-04",
            &map(&[("2026-10-04", counts(&[(Kind::Internal, 1)]))]),
        );
        file.record_sent("2026-10-04", counts(&[(Kind::Internal, 1)]), 99);
        let json = serde_json::to_value(&file).unwrap();
        assert_eq!(json["days"]["2026-10-04"]["sentAt"], serde_json::json!(99));
        assert_eq!(serde_json::from_value::<CountsFile>(json).unwrap(), file);
        let old: CountsFile = serde_json::from_str(r#"{"days":{"2026-10-04":{}}}"#).unwrap();
        assert_eq!(old.days["2026-10-04"], DayRecord::default());
    }

    #[test]
    fn daily_report_has_exactly_the_documented_fields() {
        let report = DailyReport {
            install_id: "3f0c0f9e-0000-4000-8000-000000000000".into(),
            day: "2026-10-04".into(),
            version: "0.2.0".into(),
            os: "macOS 15".into(),
            arch: "aarch64".into(),
            counts: counts(&[(Kind::Network, 1)]),
        };
        let json = serde_json::to_value(&report).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["arch", "counts", "day", "installId", "os", "version"]
        );
        assert_eq!(json["counts"]["external"]["network"], serde_json::json!(1));
    }

    #[test]
    fn install_ids_are_random_uuid_v4() {
        let a = new_install_id();
        let b = new_install_id();
        assert_ne!(a, b);
        let parsed = uuid::Uuid::parse_str(&a).unwrap();
        assert_eq!(parsed.get_version_num(), 4);
    }

    /// 只有 200 + `{"ok": true}` 算发出去了；202 `{"stored": false}`（服务端满了不收）算没发、照样往后等再补，
    /// 别的都是失败（Codex 第 2 轮 2）
    #[test]
    fn only_ok_true_counts_as_sent() {
        assert_eq!(daily_outcome(200, br#"{"ok":true}"#), DailyOutcome::Sent);
        assert_eq!(
            daily_outcome(202, br#"{"stored":false}"#),
            DailyOutcome::NotStored
        );
        assert_eq!(
            daily_outcome(202, br#"{"stored":true}"#),
            DailyOutcome::Failed
        );
        assert_eq!(daily_outcome(200, br#"{"ok":false}"#), DailyOutcome::Failed);
        assert_eq!(daily_outcome(200, b"not json"), DailyOutcome::Failed);
        assert_eq!(daily_outcome(200, b""), DailyOutcome::Failed);
        assert_eq!(daily_outcome(204, b""), DailyOutcome::Failed);
        assert_eq!(
            daily_outcome(429, br#"{"error":"rate_limited"}"#),
            DailyOutcome::Failed
        );
        assert_eq!(daily_outcome(500, br#"{"ok":true}"#), DailyOutcome::Failed);
    }

    /// 出事那一刻先记下开关代次（Codex 第 3 轮）：出事之后、读开关之前关掉又打开过，这一次也落不进新的一段
    #[test]
    fn a_count_whose_event_preceded_off_then_on_lands_nowhere() {
        let p = pending_on();
        p.count_at_with(
            Kind::Panic,
            BEFORE_MIDNIGHT,
            || {
                p.set_enabled(false);
                p.set_enabled(true);
            },
            || {},
        );
        assert!(p.take().is_empty());
    }

    /// 关掉再打开期间的计数落不进新的一段（Codex 第 2 轮 3）：计数开始时的开关代次与拿到锁时不同就丢掉
    #[test]
    fn a_count_racing_with_off_then_on_lands_nowhere() {
        let p = pending_on();
        p.count_at_with(
            Kind::Panic,
            BEFORE_MIDNIGHT,
            || {},
            || {
                p.set_enabled(false);
                p.set_enabled(true);
            },
        );
        assert!(p.take().is_empty());
        // 只是关掉：同样不记
        p.count_at_with(Kind::Panic, BEFORE_MIDNIGHT, || {}, || p.set_enabled(false));
        p.set_enabled(true);
        assert!(p.take().is_empty());
        // 期间开关没动：照常记
        p.count_at_with(Kind::Panic, BEFORE_MIDNIGHT, || {}, || {});
        assert_eq!(p.take().len(), 1);
        // 已经是开着的再设一次开，不算动过
        p.count_at_with(Kind::Panic, BEFORE_MIDNIGHT, || {}, || p.set_enabled(true));
        assert_eq!(p.take().len(), 1);
    }

    /// 事件上传：202 不论 `stored` 真假都算处理完；400 / 413 丢；别的（429、5xx、读不懂）留着重试
    #[test]
    fn event_outcomes() {
        assert_eq!(
            event_outcome(202, br#"{"stored":true}"#),
            EventOutcome::Done
        );
        assert_eq!(
            event_outcome(202, br#"{"stored":false}"#),
            EventOutcome::Done
        );
        assert_eq!(
            event_outcome(400, br#"{"error":"bad_body"}"#),
            EventOutcome::Rejected
        );
        assert_eq!(event_outcome(413, b""), EventOutcome::Rejected);
        assert_eq!(
            event_outcome(429, br#"{"error":"rate_limited"}"#),
            EventOutcome::Retry
        );
        assert_eq!(event_outcome(500, b""), EventOutcome::Retry);
        assert_eq!(
            event_outcome(503, br#"{"stored":true}"#),
            EventOutcome::Retry
        );
        assert_eq!(event_outcome(202, b"not json"), EventOutcome::Retry);
        assert_eq!(event_outcome(200, br#"{"ok":true}"#), EventOutcome::Retry);
    }

    #[test]
    fn event_report_has_exactly_the_documented_fields() {
        let report = EventReport {
            install_id: "3f0c0f9e-0000-4000-8000-000000000000".into(),
            version: "0.3.0".into(),
            os: "macOS 15".into(),
            signature: "internal:0123456789ab".into(),
            body: "b".into(),
        };
        let json = serde_json::to_value(&report).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["body", "installId", "os", "signature", "version"]);
    }

    #[test]
    fn event_endpoint_follows_the_daily_rules() {
        assert_eq!(
            event_endpoint(Some("https://r.example.workers.dev/"), None).as_deref(),
            Some("https://r.example.workers.dev/v1/event")
        );
        assert_eq!(event_endpoint(None, None), None);
        assert_eq!(event_endpoint(Some(" "), None), None);
        assert_eq!(event_endpoint(Some("https://r.example"), Some("1")), None);
    }

    /// 内部错误的出错位置是调用处：两行调用，位置不同
    #[test]
    fn caller_location_is_the_call_site() {
        let a = caller_location();
        let b = caller_location();
        assert!(a.starts_with("crates/core/src/report/mod.rs:"), "{a}");
        assert_ne!(a, b);
        assert!(a.rsplit_once(':').unwrap().1.parse::<u32>().is_ok(), "{a}");
    }

    #[test]
    fn own_kinds_are_the_first_four() {
        let own: Vec<Kind> = Kind::ALL.into_iter().filter(|k| k.is_own()).collect();
        assert_eq!(
            own,
            [Kind::Panic, Kind::PageFault, Kind::Uncaught, Kind::Internal]
        );
        for kind in Kind::ALL {
            assert_eq!(
                serde_json::to_value(kind).unwrap(),
                serde_json::json!(kind.name())
            );
        }
    }

    #[test]
    fn endpoint_needs_a_base_and_respects_do_not_track() {
        assert_eq!(
            daily_endpoint(Some("https://r.example.workers.dev/"), None).as_deref(),
            Some("https://r.example.workers.dev/v1/daily")
        );
        assert_eq!(
            daily_endpoint(Some("http://127.0.0.1:8799"), Some("0")).as_deref(),
            Some("http://127.0.0.1:8799/v1/daily")
        );
        assert_eq!(daily_endpoint(None, None), None);
        assert_eq!(daily_endpoint(Some("  "), None), None);
        assert_eq!(daily_endpoint(Some(""), None), None);
        for dnt in ["1", "true", "yes"] {
            assert_eq!(
                daily_endpoint(Some("https://r.example"), Some(dnt)),
                None,
                "{dnt}"
            );
        }
        for not_dnt in ["", "0", "false", "FALSE", " "] {
            assert!(!do_not_track(Some(not_dnt)), "{not_dnt:?}");
        }
        assert!(!do_not_track(None));
    }
}
