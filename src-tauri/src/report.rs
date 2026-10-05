//! 自动上报的应用侧（spec 2026-10-04-reporting-feedback R5–R9）：定时把进程里的异常次数落盘、每天往接收服务发一条
//! 每日上报、把 Sophia 自身的错误与崩溃事件逐条上传（R8）、设置页那个开关的命令。计数、事件与「该不该发」的规则在
//! `sophia_core::report`，这里只接线和发请求。
//!
//! 整个模块只编进公开版（`lib.rs` 里 `#[cfg(not(feature = "weiboap"))]`）：内部版没有上报代码，也没有地址。
//! 接收服务的地址：正式版只认编译期注入的 `SOPHIA_REPORT_URL`（发版流水线给，`build.rs` 盯着它重编）；
//! 调试版不认编译期的、只认运行时的同名环境变量（本机对 `wrangler dev` 验证用）。都没有、或 `DO_NOT_TRACK=1`，
//! 这个模块什么都不做（R9：开发版、自己编译的版本天然不发）。发不出去只记一条日志，不打扰用户。
use crate::AppState;
use serde::Serialize;
use sophia_core::report::{
    self, DailyOutcome, DailyReport, EventOutcome, EventReport, Kind, Reporter, PENDING,
};
use sophia_core::store::Store;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Notify;

/// 启动后等这么久再动（不拖慢启动）
const START_DELAY: Duration = Duration::from_secs(30);
/// 每隔这么久把进程里的次数落一次盘
const PERSIST_EVERY: Duration = Duration::from_secs(60);
/// 每隔这么久看一次该不该发（发失败之后的等待在 core 的 `retry_delay`）
const CHECK_EVERY: Duration = Duration::from_secs(30 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

static REPORTER: OnceLock<Reporter> = OnceLock::new();
static VERSION: OnceLock<String> = OnceLock::new();
/// 开关一动就叫醒正在等响应的那一次发送，放弃它（Codex 复审 3）
static CANCEL: Notify = Notify::const_new();

/// 接收服务的基址：正式版只认编译期注入的，调试版只认运行时的环境变量（开发者自己指向测试服务）。反馈（`feedback.rs`）同用
pub(crate) fn base_url() -> Option<String> {
    #[cfg(debug_assertions)]
    {
        std::env::var("SOPHIA_REPORT_URL").ok()
    }
    #[cfg(not(debug_assertions))]
    {
        option_env!("SOPHIA_REPORT_URL").map(str::to_owned)
    }
}

/// 每日上报的地址；None：这份构建、这次运行不上报
fn endpoint() -> Option<String> {
    report::daily_endpoint(
        base_url().as_deref(),
        std::env::var("DO_NOT_TRACK").ok().as_deref(),
    )
}

/// 事件上传的地址（与每日上报同一套规则，同有同无）
fn event_endpoint() -> Option<String> {
    report::event_endpoint(
        base_url().as_deref(),
        std::env::var("DO_NOT_TRACK").ok().as_deref(),
    )
}

/// 两个上传地址
struct Urls {
    daily: String,
    event: String,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// 本地日期 `YYYY-MM-DD`。时区偏移从系统取（`time` 的 `now_local` 在多线程进程里会退回 UTC）
pub(crate) fn today() -> String {
    report::local_day(now(), local_offset_secs())
}

#[cfg(target_os = "macos")]
fn local_offset_secs() -> i64 {
    objc2_foundation::NSTimeZone::localTimeZone().secondsFromGMT() as i64
}

#[cfg(not(target_os = "macos"))]
fn local_offset_secs() -> i64 {
    0
}

/// 系统大版本：`macOS 15`
pub(crate) fn os_major() -> String {
    #[cfg(target_os = "macos")]
    {
        let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
        format!("macOS {}", version.majorVersion)
    }
    #[cfg(not(target_os = "macos"))]
    std::env::consts::OS.to_owned()
}

/// setup 里调（`usage::setup` 之后）：这份构建、这次运行能上报，就开始计数（开关开着时），30 秒后起后台循环
pub fn setup(app: &tauri::App) {
    let (Some(daily), Some(event)) = (endpoint(), event_endpoint()) else {
        log::info!("自动上报不可用（没有接收服务地址，或设了 DO_NOT_TRACK）");
        return;
    };
    let dir = match crate::runtime_store_dir() {
        Ok(dir) => dir,
        Err(e) => {
            log::warn!("自动上报找不到数据目录：{e}");
            return;
        }
    };
    PENDING.set_local_offset(local_offset_secs());
    let version = app.package_info().version.to_string();
    // 之后收的事件记下这时的应用版本与系统（补传时发记下的，复审 P2）
    PENDING.set_app_info(&version, &os_major());
    let reporter = Reporter::new(Store::new(dir), &PENDING);
    if let Err(e) = reporter.start(&today()) {
        log::warn!("自动上报启动时读写本机记录失败：{e}");
    }
    let _ = VERSION.set(version);
    if REPORTER.set(reporter).is_ok() {
        tauri::async_runtime::spawn(run(Urls { daily, event }));
    }
}

async fn run(urls: Urls) {
    tokio::time::sleep(START_DELAY).await;
    let client = match client() {
        Ok(client) => client,
        Err(e) => {
            log::warn!("自动上报建不起联网组件：{e}");
            return;
        }
    };
    let Some(r) = REPORTER.get() else {
        return;
    };
    let mut last_check: Option<Instant> = None;
    loop {
        // 夏令时、换了时区：跟着系统
        PENDING.set_local_offset(local_offset_secs());
        if last_check.is_none_or(|at| at.elapsed() >= CHECK_EVERY) {
            last_check = Some(Instant::now());
            send_due(r, &client, &urls.daily).await;
            send_events(r, &client, &urls.event).await;
        } else if let Err(e) = r.persist(&today()) {
            log::warn!("按天的异常次数存不下（次数留在内存里，下次再存）：{e}");
        }
        tokio::time::sleep(PERSIST_EVERY).await;
    }
}

/// 与 `market.rs` 同一套客户端设置（rustls、超时、UA；代理照 reqwest 的默认），总时限 10 秒
fn client() -> Result<reqwest::Client, reqwest::Error> {
    client_with(REQUEST_TIMEOUT)
}

/// 同 [`client`]，总时限另给（反馈上传截图要久一点）
pub(crate) fn client_with(timeout: Duration) -> Result<reqwest::Client, reqwest::Error> {
    // reqwest 用 rustls-no-provider：不装加密提供方，建 client 会 panic（同 market.rs、sophia-gateway）
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .user_agent(concat!("Sophia/", env!("CARGO_PKG_VERSION")))
        .build()
}

/// 正常退出时调：把还没落盘的次数存下
pub fn flush() {
    if let Some(r) = REPORTER.get() {
        if let Err(e) = r.persist(&today()) {
            log::warn!("退出时按天的异常次数存不下：{e}");
        }
    }
}

/// 崩溃钩子里调（`panic = "abort"`，内存里的次数马上就没了）：能落盘就当场落盘；拿不到锁、存不下，或者
/// 上报还没起来（启动早期、命令行模式），就在数据目录旁边记一行，下次启动并进那一天（Codex 复审 7）。
/// 上报开着时，再把已去隐私的崩溃记录 `crash_report` 追加到崩溃旁文件，下次启动作为事件补传（R8、AC5）
pub fn on_panic(crash_report: &str) {
    let day = today();
    let (enabled, flushed) = match REPORTER.get() {
        Some(r) => {
            let flushed = r.flush_on_panic(&day);
            (PENDING.enabled(), flushed)
        }
        None => {
            let enabled = endpoint().is_some()
                && crate::runtime_store_dir()
                    .ok()
                    .and_then(|dir| Store::new(dir).load_settings().ok())
                    .is_some_and(|s| s.auto_report);
            (enabled, false)
        }
    };
    if !enabled {
        return;
    }
    if let Ok(dir) = crate::runtime_store_dir() {
        if !flushed {
            let _ = report::append_panic_marker(&dir, &day);
        }
        let _ = report::append_crash_report(&dir, crash_report);
    }
}

/// 发这一次该发的。开关动了（代次变了）就停：剩下的不发、在等的那一次放弃、发完的不记（复审 3）。
/// 失败只记日志、按 1 / 3 / 6 / 24 小时往后等，不打扰用户
async fn send_due(r: &'static Reporter, client: &reqwest::Client, url: &str) {
    let batch = match r.begin_batch(&today(), now()) {
        Ok(Some(batch)) => batch,
        Ok(None) => return,
        Err(e) => {
            log::warn!("按天的异常次数存不下，这次不发：{e}");
            return;
        }
    };
    for (day, counts) in batch.days.clone() {
        // 先登记等「开关动了」的通知，再查代次：查完到开始等之间动的也收得到
        let cancelled = CANCEL.notified();
        if !r.is_current(&batch) {
            return;
        }
        let body = DailyReport {
            install_id: batch.install_id.clone(),
            day: day.clone(),
            version: VERSION.get().cloned().unwrap_or_default(),
            os: os_major(),
            arch: std::env::consts::ARCH.to_owned(),
            counts,
        };
        let sent = tokio::select! {
            result = post(client, url, &body) => result,
            _ = cancelled => return,
        };
        match sent {
            Ok(DailyOutcome::Sent) => {
                record(r.record_sent(&batch, &day, counts, now()).map(|_| ()))
            }
            // 服务端满了这次不收：不算已发，照失败往后等、之后补（不是网络问题，只记一行 info）
            Ok(DailyOutcome::NotStored) => {
                log::info!("每日上报（{day}）接收服务这次没收，稍后再试");
                record(r.record_failure(&batch, now()));
                return;
            }
            Ok(DailyOutcome::Failed) | Err(_) => {
                let why = sent.err().unwrap_or_default();
                log::warn!("每日上报（{day}）没发出去：{why}");
                record(r.record_failure(&batch, now()));
                return;
            }
        }
    }
}

/// 逐条上传排着的错误事件（R8）。开关动了就停（同 [`send_due`]）；202 处理完、400 / 413 丢掉，别的
/// （断网、429、5xx）留着并按 1 / 3 / 6 / 24 小时往后等，这一轮剩下的不发。失败只记日志
async fn send_events(r: &'static Reporter, client: &reqwest::Client, url: &str) {
    let batch = match r.begin_event_batch(&today(), now()) {
        Ok(Some(batch)) => batch,
        Ok(None) => return,
        Err(e) => {
            log::warn!("错误事件存不下，这次不发：{e}");
            return;
        }
    };
    for event in &batch.events {
        let cancelled = CANCEL.notified();
        if !r.is_event_batch_current(&batch) {
            return;
        }
        // 出事时记下的版本与系统（补传的是那时的）；没记下的用现在的
        let or_now = |recorded: &str, now: String| {
            if recorded.is_empty() {
                now
            } else {
                recorded.to_owned()
            }
        };
        let body = EventReport {
            install_id: batch.install_id.clone(),
            version: or_now(&event.version, VERSION.get().cloned().unwrap_or_default()),
            os: or_now(&event.os, os_major()),
            signature: event.signature.clone(),
            body: event.body.clone(),
        };
        let sent = tokio::select! {
            result = post_json(client, url, &body) => result,
            _ = cancelled => return,
        };
        let outcome = match &sent {
            Ok((status, head)) => report::event_outcome(*status, head),
            Err(_) => EventOutcome::Retry,
        };
        match outcome {
            EventOutcome::Done => {}
            EventOutcome::Rejected => {
                let status = sent.as_ref().map_or(0, |(status, _)| *status);
                log::warn!(
                    "错误事件 {} 接收服务不收（HTTP {status}），丢掉",
                    event.signature
                );
            }
            EventOutcome::Retry => {
                let why = match &sent {
                    Ok((status, _)) => format!("HTTP {status}"),
                    Err(e) => e.clone(),
                };
                log::warn!("错误事件 {} 没发出去：{why}", event.signature);
            }
        }
        record(
            r.record_event_result(&batch, event, outcome, now())
                .map(|_| ()),
        );
        if outcome == EventOutcome::Retry {
            return;
        }
    }
}

fn record(result: std::io::Result<()>) {
    if let Err(e) = result {
        log::warn!("记不下每日上报的发送结果：{e}");
    }
}

/// 发一次；连不上为 Err，收到响应按状态码与返回体判断（[`report::daily_outcome`]）
async fn post(
    client: &reqwest::Client,
    url: &str,
    body: &DailyReport,
) -> Result<DailyOutcome, String> {
    let (status, head) = post_json(client, url, body).await?;
    match report::daily_outcome(status, &head) {
        DailyOutcome::Failed => Err(format!("HTTP {status}")),
        outcome => Ok(outcome),
    }
}

/// POST 一份 JSON；连不上、读断了为 Err，否则返回状态码与返回体开头（最多读 4 KB）
pub(crate) async fn post_json(
    client: &reqwest::Client,
    url: &str,
    body: &impl Serialize,
) -> Result<(u16, Vec<u8>), String> {
    let bytes = serde_json::to_vec(body).map_err(|e| e.to_string())?;
    let resp = client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(bytes)
        .send()
        .await;
    read_head(resp).await
}

/// 发出去的请求的结果：连不上、读断了为 Err，否则状态码与返回体开头（最多读 4 KB）
pub(crate) async fn read_head(
    resp: Result<reqwest::Response, reqwest::Error>,
) -> Result<(u16, Vec<u8>), String> {
    let resp = resp.map_err(|e| e.to_string())?;
    let status = resp.status();
    let mut resp = resp;
    let mut head = Vec::new();
    while head.len() < 4096 {
        match resp.chunk().await {
            Ok(Some(chunk)) => head.extend_from_slice(&chunk),
            Ok(None) => break,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok((status.as_u16(), head))
}

/// 设置「关于」里那一行（R6）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSettings {
    pub auto_report: bool,
    /// 这份构建、这次运行能不能上报（有接收服务地址、没设 `DO_NOT_TRACK`）；不能时界面不画开关
    pub available: bool,
    /// 有没有接收服务能收反馈（有地址就有；`DO_NOT_TRACK` 不管它，反馈是用户自己点的）
    pub feedback: bool,
}

#[tauri::command]
pub fn report_settings(state: tauri::State<'_, AppState>) -> Result<ReportSettings, String> {
    let settings = state.store.load_settings().map_err(|e| e.to_string())?;
    Ok(ReportSettings {
        auto_report: settings.auto_report,
        available: endpoint().is_some(),
        feedback: crate::feedback::available(),
    })
}

/// 自动上报此刻在生效：这次运行能上报（有地址、没设 `DO_NOT_TRACK`）且开关开着。反馈据此决定带不带安装 ID
pub(crate) fn active(store: &Store) -> bool {
    endpoint().is_some() && store.load_settings().is_ok_and(|s| s.auto_report)
}

/// `使用统计和错误报告` 开关（R6）：关掉删安装 ID、清计数；再开生成新的安装 ID。正在发的那一批作废
#[tauri::command]
pub fn set_auto_report(enabled: bool, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let result = match REPORTER.get() {
        Some(r) => r.set_auto_report(enabled),
        // 这次运行不上报（没有地址、DO_NOT_TRACK）：只改设置，计数本来就没开
        None => state.store.set_auto_report(enabled),
    };
    CANCEL.notify_waiters();
    result.map_err(|e| e.to_string())
}

/// 网页侧的两种异常（页面出错、未捕获的错误）各记一次；别的名字不认。带了原文（`text`）就再收一条事件
/// （去隐私在 core 里做，R8）
#[tauri::command]
pub fn report_count_frontend(kind: String, text: Option<String>) {
    let Some(kind) = Kind::from_frontend(&kind) else {
        return;
    };
    match text {
        Some(text) => report::capture(kind, "", &text),
        None => report::count(kind),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn os_is_the_major_version_only() {
        let os = os_major();
        let major = os.strip_prefix("macOS ").expect(&os);
        assert!(major.parse::<u32>().is_ok_and(|n| n >= 11), "{os}");
    }

    #[test]
    fn today_is_a_valid_local_date() {
        assert!(report::day_number(&today()).is_some(), "{}", today());
    }

    /// 调试版只认运行时的环境变量：测试进程里没设，就不上报
    #[cfg(debug_assertions)]
    #[test]
    fn debug_build_without_runtime_url_is_inert() {
        if std::env::var_os("SOPHIA_REPORT_URL").is_none() {
            assert_eq!(endpoint(), None);
        }
    }
}
