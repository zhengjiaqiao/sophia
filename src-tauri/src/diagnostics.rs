//! 本机诊断的应用侧（spec 2026-10-04-local-diagnostics R1–R8）：日志插件、崩溃记录、意外退出标记、
//! 开发者的故意出错入口。规则与格式在 `sophia_core::{redact, diagnostics}`，这里只接线。
use sophia_core::diagnostics::{self as core_diag, CrashInfo};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::plugin::TauriPlugin;
use tauri::Runtime;

/// 单个日志文件的上限，到了换新文件（R2）
const LOG_MAX_BYTES: u64 = 5_000_000;
const LOG_FILE: &str = "sophia.log";
/// 旧的留 2 份：连同正在写的一共 3 份（R2）
const LOG_KEEP_OLD: usize = 2;
/// 日志队列能攒多少条：写盘卡住时调用方不等，满了就丢
const LOG_QUEUE: usize = 1024;
/// 后台写日志的线程名：它自己 panic 时 flush 不能等它自己
const WRITER_THREAD: &str = "sophia-log";
const CRASH_LOG: &str = "crash.log";
/// `crash.log` 的上限：到了改名 `crash.log.1`，共留 2 份（R5）
const CRASH_LOG_MAX_BYTES: u64 = 1_000_000;

/// setup 之前（或命令行模式下）崩溃时用的日志目录：与插件的 `app_log_dir()` 同一处。
/// 调试版用开发版的应用标识（`tauri.dev.conf.json`），正式版用 `tauri.conf.json` 的
#[cfg(debug_assertions)]
const IDENTIFIER: &str = "com.zhengjiaqiao.sophia.dev";
#[cfg(not(debug_assertions))]
const IDENTIFIER: &str = "com.zhengjiaqiao.sophia";

/// 本项目各 crate 的日志类别（`log` 宏默认用模块路径，首段是 crate 名：二进制 `sophia`、库 `sophia_lib`），
/// 加上网页侧经插件写来的 `webview`；这些记 info 及以上，别的（tauri、reqwest 等）只记 warn 及以上
const OUR_TARGETS: &[&str] = &[
    "sophia",
    "sophia_lib",
    "sophia_core",
    "sophia_gateway",
    tauri_plugin_log::WEBVIEW_TARGET,
];

static LOG_SENDER: OnceLock<LogSender> = OnceLock::new();
static VERSION: OnceLock<String> = OnceLock::new();
/// 运行时的应用标识（开发版 `.dev`），运行标记按它分
static IDENTITY: OnceLock<String> = OnceLock::new();
static OS: OnceLock<String> = OnceLock::new();

/// 日志行：时间、类别、级别、内容，整行去隐私并限长（网页侧经 `plugin:log` 来的也走这里）
pub fn log_line(time: &str, target: &str, level: log::Level, message: &str) -> String {
    sophia_core::redact::redact(&format!("{time} [{target}][{level}] {message}"))
}

/// 日志插件：每行过 `log_line`，交给后台线程写 `~/Library/Logs/<应用标识>/sophia.log`（调试版另抄一份到终端）。
/// 不用插件自带的文件输出：它在界面线程上同步写盘，打开失败会让应用起不来，写不进去时缓冲无限长
/// （Codex 复审 4/6/7）。这里调用方只做格式化和 `try_send`，队列满了就丢；写不进去静默放弃、下一条再试
pub fn log_plugin<R: Runtime>() -> TauriPlugin<R> {
    use tauri_plugin_log::{fern, Builder, Target, TargetKind};
    let sender = LOG_SENDER.get_or_init(|| {
        let mut file = LogFile::new(log_dir(), LOG_MAX_BYTES);
        spawn_writer(LOG_QUEUE, move |line: &str| {
            file.write(line);
            if cfg!(debug_assertions) {
                use std::io::Write;
                let _ = writeln!(std::io::stderr(), "{line}");
            }
        })
        .unwrap_or_else(LogSender::disconnected)
    });
    let output = fern::Output::call(move |record| sender.send(record.args().to_string()));
    let mut builder = Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::Dispatch(
            fern::Dispatch::new().chain(output),
        )))
        .level(log::LevelFilter::Warn);
    for target in OUR_TARGETS {
        builder = builder.level_for(*target, log::LevelFilter::Info);
    }
    builder
        .format(|out, message, record| {
            out.finish(format_args!(
                "{}",
                log_line(
                    &now(),
                    record.target(),
                    record.level(),
                    &message.to_string()
                )
            ))
        })
        .build()
}

/// 等后台线程把已排队的日志写完，最多等 `timeout`；退出、崩溃前调。写日志的线程自己调时直接返回
pub fn flush_log(timeout: Duration) -> bool {
    LOG_SENDER.get().is_some_and(|s| s.flush(timeout))
}

enum LogMsg {
    Line(String),
    Flush(SyncSender<()>),
}

/// 交给后台写日志线程的一头：发送从不阻塞
pub struct LogSender {
    tx: Option<SyncSender<LogMsg>>,
    dropped: Arc<AtomicU64>,
}

impl LogSender {
    /// 线程起不来时用：什么都不写
    fn disconnected() -> Self {
        Self {
            tx: None,
            dropped: Arc::default(),
        }
    }

    pub fn send(&self, line: String) {
        let Some(tx) = &self.tx else {
            return;
        };
        if tx.try_send(LogMsg::Line(line)).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// 已排队的写完了返回 true；超时、线程没了、或就在写日志的线程上调用返回 false
    pub fn flush(&self, timeout: Duration) -> bool {
        let Some(tx) = &self.tx else {
            return false;
        };
        if std::thread::current().name() == Some(WRITER_THREAD) {
            return false;
        }
        let deadline = Instant::now() + timeout;
        let (ack_tx, ack_rx) = sync_channel(1);
        let mut msg = LogMsg::Flush(ack_tx);
        loop {
            match tx.try_send(msg) {
                Ok(()) => break,
                Err(TrySendError::Full(back)) if Instant::now() < deadline => {
                    msg = back;
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return false,
            }
        }
        ack_rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .is_ok()
    }
}

/// 起后台写日志线程：队列最多 `capacity` 条，满了丢掉并记数，下一次写成时补一行说丢了几条
pub fn spawn_writer(
    capacity: usize,
    mut write: impl FnMut(&str) + Send + 'static,
) -> Option<LogSender> {
    let (tx, rx) = sync_channel(capacity);
    let dropped = Arc::new(AtomicU64::new(0));
    let counter = dropped.clone();
    std::thread::Builder::new()
        .name(WRITER_THREAD.into())
        .spawn(move || {
            for msg in rx {
                match msg {
                    LogMsg::Line(line) => {
                        write(&line);
                        let lost = counter.swap(0, Ordering::Relaxed);
                        if lost > 0 {
                            write(&format!("[sophia-log] queue full, dropped {lost} lines"));
                        }
                    }
                    LogMsg::Flush(ack) => {
                        let _ = ack.send(());
                    }
                }
            }
        })
        .ok()?;
    Some(LogSender {
        tx: Some(tx),
        dropped,
    })
}

/// 自己管的日志文件：用到时才建目录、开文件，写不进去就丢掉这条、关掉句柄，下一条重新开
pub struct LogFile {
    dir: PathBuf,
    max_bytes: u64,
    open: Option<(std::fs::File, u64)>,
}

impl LogFile {
    pub fn new(dir: PathBuf, max_bytes: u64) -> Self {
        Self {
            dir,
            max_bytes,
            open: None,
        }
    }

    pub fn write(&mut self, line: &str) {
        if self.try_write(line).is_err() {
            self.open = None;
        }
    }

    fn try_write(&mut self, line: &str) -> std::io::Result<()> {
        use std::io::Write;
        let path = self.dir.join(LOG_FILE);
        let incoming = line.len() as u64 + 1;
        let full = self.open.as_ref().is_some_and(|(_, size)| {
            *size > 0 && (*size >= self.max_bytes || size + incoming > self.max_bytes)
        });
        if full || self.open.is_none() {
            // 换文件前先关掉手上的；没开过的也先按盘上的大小判一次
            self.open = None;
            std::fs::create_dir_all(&self.dir)?;
            core_diag::rotate_before_append(&path, incoming, self.max_bytes, LOG_KEEP_OLD)?;
            let file = std::fs::OpenOptions::new()
                .append(true)
                .create(true)
                .open(&path)?;
            let size = file.metadata()?.len();
            self.open = Some((file, size));
        }
        let Some((file, size)) = self.open.as_mut() else {
            return Ok(());
        };
        file.write_all(format!("{line}\n").as_bytes())?;
        *size += incoming;
        Ok(())
    }
}

/// 本地时间（拿不到时区时插件退回 UTC），带时区偏移，免得分不清
fn now() -> String {
    let t = tauri_plugin_log::TimezoneStrategy::UseLocal.get_now();
    let offset = t.offset();
    let (h, m, _) = offset.as_hms();
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}{}{:02}:{:02}",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        if offset.is_negative() { '-' } else { '+' },
        h.unsigned_abs(),
        m.unsigned_abs()
    )
}

fn version() -> &'static str {
    VERSION
        .get()
        .map_or(env!("CARGO_PKG_VERSION"), String::as_str)
}

fn identity() -> &'static str {
    IDENTITY.get().map_or(IDENTIFIER, String::as_str)
}

fn os() -> &'static str {
    OS.get_or_init(os_description)
}

fn os_description() -> String {
    let arch = std::env::consts::ARCH;
    #[cfg(target_os = "macos")]
    {
        let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersionString();
        format!("macOS {version} {arch}")
    }
    #[cfg(not(target_os = "macos"))]
    format!("{} {arch}", std::env::consts::OS)
}

/// `~/Library/Logs/<应用标识>`：与 tauri 的 `app_log_dir()` 在 macOS 上是同一处。不靠 `AppHandle`，
/// 应用建起来之前（插件注册、早期崩溃）就能用
fn log_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map_or_else(std::env::temp_dir, PathBuf::from);
    home.join("Library/Logs").join(identity())
}

/// 正在写的日志文件 `sophia.log`（反馈附诊断内容时读它的末尾；内部版没有反馈）
#[cfg(not(feature = "weiboap"))]
pub fn log_file() -> PathBuf {
    log_dir().join(LOG_FILE)
}

/// `run()` 里、建应用之前调：用这次构建配置里的应用标识（开发版带 `.dev`）
pub fn set_identity(identifier: &str) {
    let _ = IDENTITY.set(identifier.to_owned());
}

/// 追加一段崩溃记录到 `<dir>/crash.log`：已到 1 MB、或这段写进去会越过 1 MB，先改名 `crash.log.1`（共留 2 份）
pub fn write_crash(dir: &Path, report: &str) -> std::io::Result<PathBuf> {
    use std::io::Write;
    std::fs::create_dir_all(dir)?;
    let path = dir.join(CRASH_LOG);
    core_diag::rotate_before_append(&path, report.len() as u64, CRASH_LOG_MAX_BYTES, 1)?;
    std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)?
        .write_all(report.as_bytes())?;
    Ok(path)
}

/// 进程最早期装上（`main.rs` 第一行，界面与命令行两条路都覆盖）：panic 时先做退出前的收尾（[`on_panic_exit`]），
/// 再写 `crash.log` 与日志，再交给原来的 hook。`panic = "abort"` 下 hook 在 abort 之前执行
pub fn install_panic_hook() {
    os();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // 记录过程中自己又 panic（例如写日志出错、收尾里出错）时不再进来，直接交给原来的 hook
        let first = IN_HOOK.with(|flag| !flag.replace(true));
        if first {
            run_panic_exit();
            record_panic(info);
            IN_HOOK.with(|flag| flag.set(false));
        }
        previous(info);
    }));
}

/// panic 时、abort 之前要做的收尾（spec 2026-10-05-exit-fallback R1）：网关建好后挂上「把 Codex 设置改回原样」。
/// 只能挂一次；崩溃后进程马上退出，所以和关机时一样只做同步、有时限的事
static PANIC_EXIT: std::sync::OnceLock<Box<dyn Fn() + Send + Sync>> = std::sync::OnceLock::new();

pub fn on_panic_exit(f: impl Fn() + Send + Sync + 'static) {
    let _ = PANIC_EXIT.set(Box::new(f));
}

fn run_panic_exit() {
    if let Some(f) = PANIC_EXIT.get() {
        f();
    }
}

thread_local! {
    static IN_HOOK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn record_panic(info: &std::panic::PanicHookInfo<'_>) {
    let thread = std::thread::current();
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
    let payload = info.payload();
    let message = payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("<non-string panic payload>");
    let backtrace = std::backtrace::Backtrace::force_capture().to_string();
    let unix_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let report = core_diag::crash_report(&CrashInfo {
        unix_secs,
        version: version(),
        os: os(),
        thread: thread.name().unwrap_or("<unnamed>"),
        location: location.as_deref(),
        message,
        backtrace: &backtrace,
    });
    // 先写 crash.log；写不进去就算了：进程马上要退出，不能再添乱。日志只是顺带，等它最多 1 秒
    let _ = write_crash(&log_dir(), &report);
    // 自动上报的崩溃次数：panic = "abort"，内存里的次数马上就没了，当场落盘（落不进去记在旁边，下次启动补上）；
    // 已去隐私的崩溃记录记在崩溃旁文件里，下次启动作为事件补传（R8）
    sophia_core::report::count(sophia_core::report::Kind::Panic);
    #[cfg(not(feature = "weiboap"))]
    crate::report::on_panic(&report);
    log::error!("panic（{}）：{message}", location.as_deref().unwrap_or("-"));
    flush_log(Duration::from_secs(1));
}

/// setup 里调：记下日志目录与版本，写启动日志，判上次是否意外退出（R8）并写入本次的运行标记
pub fn on_setup<R: Runtime>(app: &tauri::App<R>, data_dir: Option<&Path>) -> bool {
    let _ = VERSION.set(app.package_info().version.to_string());
    set_identity(&app.config().identifier);
    log::info!("Sophia {} 启动（{}）", version(), os());
    let unexpected = data_dir.is_some_and(|dir| core_diag::begin_run(dir, identity()));
    if unexpected {
        log::warn!("上次没有正常退出（崩溃、被强制结束或断电）");
    }
    faults::init(app.handle());
    unexpected
}

/// `RunEvent::Exit` 里调（正常退出与升级重启都算正常）：删运行标记，写退出日志
pub fn on_exit(data_dir: Option<&Path>) {
    if let Some(dir) = data_dir {
        if let Err(e) = core_diag::end_run(dir, identity()) {
            log::warn!("删运行标记失败：{e}");
        }
    }
    log::info!("Sophia {} 退出", version());
    flush_log(Duration::from_secs(2));
}

/// 复制详情之前去隐私（R13）。不按单条日志限长：详情里的调用栈要留全
#[tauri::command]
pub fn redact_text(text: String) -> String {
    sophia_core::redact::redact_full(&text)
}

/// 开发者的故意出错入口（`SOPHIA_FAULT` 原值）；正式版恒为 `None`
#[tauri::command]
pub fn debug_fault() -> Option<String> {
    faults::raw()
}

/// `gateway_state` 是否该故意报「读不到状态 · 没权限」（`SOPHIA_FAULT=gateway-state`）：一直报，直到
/// `修复权限` 成功一次（[`clear_gateway_state_fault`]）——重读、换页都还在，才验证得了那块灰面板与修复的路
pub fn gateway_state_fault() -> bool {
    faults::gateway_state_active()
}

/// `修复权限` 做成了：开发者入口的那次故障就此解除
pub fn clear_gateway_state_fault() {
    faults::clear_gateway_state();
}

/// `SOPHIA_FAULT=tray-panel`：托盘面板这一步要当成建失败（发行版恒为 false）
pub fn tray_panel_fault() -> bool {
    faults::tray_panel_active()
}

/// `SOPHIA_FAULT=tray-icon`：托盘图标这一步要当成建失败（发行版恒为 false）
pub fn tray_icon_fault() -> bool {
    faults::tray_icon_active()
}

/// 故意出错的入口只在调试版、或显式开了 `diag-faults` 的构建里有（spec 风险 2）
#[cfg(any(debug_assertions, feature = "diag-faults"))]
mod faults {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use tauri::Runtime;

    static RAW: OnceLock<Option<String>> = OnceLock::new();
    static GATEWAY_STATE_USED: AtomicBool = AtomicBool::new(false);

    /// 故意出错的入口（`SOPHIA_FAULT`）
    #[derive(Debug, PartialEq, Eq)]
    pub enum Fault {
        /// 启动后不久在主线程 panic，验证崩溃记录
        Panic,
        /// `gateway_state` 失败一次，验证读不到模型状态时的界面
        GatewayState,
        /// 网页侧某一页渲染出错（由前端经 `debug_fault` 读）
        Page(String),
        /// 托盘面板这一步建不出来（验证「面板缺席，图标仍在」）
        TrayPanel,
        /// 托盘图标这一步建不出来（验证「无图标，Dock 仍在」）
        TrayIcon,
    }

    pub fn parse_fault(value: &str) -> Option<Fault> {
        match value.trim() {
            "panic" => Some(Fault::Panic),
            "gateway-state" => Some(Fault::GatewayState),
            "tray-panel" => Some(Fault::TrayPanel),
            "tray-icon" => Some(Fault::TrayIcon),
            other => other
                .strip_prefix("page:")
                .filter(|page| !page.is_empty())
                .map(|page| Fault::Page(page.to_owned())),
        }
    }

    pub(super) fn raw() -> Option<String> {
        RAW.get_or_init(|| {
            std::env::var("SOPHIA_FAULT")
                .ok()
                .filter(|v| parse_fault(v).is_some())
        })
        .clone()
    }

    pub(super) fn init<R: Runtime>(app: &tauri::AppHandle<R>) {
        let Some(fault) = raw() else {
            return;
        };
        log::warn!("SOPHIA_FAULT={fault}");
        if parse_fault(&fault) == Some(Fault::Panic) {
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let _ = app.run_on_main_thread(|| panic!("SOPHIA_FAULT=panic：故意的崩溃"));
            });
        }
    }

    pub(super) fn gateway_state_active() -> bool {
        raw().is_some_and(|v| parse_fault(&v) == Some(Fault::GatewayState))
            && !GATEWAY_STATE_USED.load(Ordering::SeqCst)
    }

    pub(super) fn clear_gateway_state() {
        GATEWAY_STATE_USED.store(true, Ordering::SeqCst);
    }

    pub(super) fn tray_panel_active() -> bool {
        raw().is_some_and(|v| parse_fault(&v) == Some(Fault::TrayPanel))
    }

    pub(super) fn tray_icon_active() -> bool {
        raw().is_some_and(|v| parse_fault(&v) == Some(Fault::TrayIcon))
    }
}

#[cfg(not(any(debug_assertions, feature = "diag-faults")))]
mod faults {
    use tauri::Runtime;

    pub(super) fn raw() -> Option<String> {
        None
    }

    pub(super) fn init<R: Runtime>(_app: &tauri::AppHandle<R>) {}

    pub(super) fn gateway_state_active() -> bool {
        false
    }

    pub(super) fn clear_gateway_state() {}

    pub(super) fn tray_panel_active() -> bool {
        false
    }

    pub(super) fn tray_icon_active() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    #[cfg(any(debug_assertions, feature = "diag-faults"))]
    use super::faults::{parse_fault, Fault};
    use super::*;

    /// AC4 的代理：挂上的收尾在 panic 路径里被调到；没挂时什么都不做
    #[test]
    fn panic_exit_runs_the_registered_fallback() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        run_panic_exit();
        assert_eq!(CALLS.load(Ordering::SeqCst), 0);
        on_panic_exit(|| {
            CALLS.fetch_add(1, Ordering::SeqCst);
        });
        on_panic_exit(|| {
            CALLS.fetch_add(100, Ordering::SeqCst);
        });
        run_panic_exit();
        assert_eq!(CALLS.load(Ordering::SeqCst), 1, "只认第一次挂上的");
    }

    #[test]
    fn log_line_is_redacted_and_has_fields() {
        let home = std::env::var("HOME").unwrap();
        let line = log_line(
            "2026-10-04 12:00:00+08:00",
            "sophia_lib::watch",
            log::Level::Warn,
            &format!("监视 {home}/x 失败 https://h.example/a?token=abc"),
        );
        assert_eq!(
            line,
            "2026-10-04 12:00:00+08:00 [sophia_lib::watch][WARN] 监视 ~/x 失败 https://h.example/a?…"
        );
    }

    #[test]
    fn log_line_is_capped() {
        let line = log_line("t", "webview", log::Level::Error, &"x".repeat(10_000));
        assert!(line.chars().count() <= sophia_core::redact::MAX_CHARS + 1);
    }

    fn temp_dir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        (dir, root)
    }

    #[test]
    fn log_file_rotates_and_keeps_two_old_copies() {
        let (_guard, root) = temp_dir();
        let dir = root.join("Logs");
        let mut file = LogFile::new(dir.clone(), 20);
        for line in ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd"] {
            file.write(line);
        }
        let read = |name: &str| std::fs::read_to_string(dir.join(name)).ok();
        // 每行连换行 11 字节，两行就越过 20：每个文件一行
        assert_eq!(read("sophia.log").as_deref(), Some("dddddddddd\n"));
        assert_eq!(read("sophia.log.1").as_deref(), Some("cccccccccc\n"));
        assert_eq!(read("sophia.log.2").as_deref(), Some("bbbbbbbbbb\n"));
        assert_eq!(read("sophia.log.3"), None);
    }

    /// 日志目录建不起来（Codex 复审 4）：不崩、不报错，之后能写了再接着写
    #[test]
    fn log_file_survives_unwritable_dir_and_recovers() {
        let (_guard, root) = temp_dir();
        let dir = root.join("Logs");
        std::fs::write(&dir, "这里是个文件，建不了目录").unwrap();
        let mut file = LogFile::new(dir.clone(), 1_000);
        file.write("lost");
        std::fs::remove_file(&dir).unwrap();
        file.write("kept");
        assert_eq!(
            std::fs::read_to_string(dir.join("sophia.log")).unwrap(),
            "kept\n"
        );
    }

    /// 写日志不阻塞调用方（Codex 复审 6/7）：写盘卡住时队列满了就丢，丢了几条事后补一行
    #[test]
    fn writer_never_blocks_and_counts_drops() {
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let written = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let sink = written.clone();
        let mut first = true;
        let sender = spawn_writer(4, move |line: &str| {
            if first {
                // 第一行卡住，模拟写盘卡死
                first = false;
                let _ = release_rx.recv();
            }
            sink.lock().unwrap().push(line.to_owned());
        })
        .unwrap();
        let started = std::time::Instant::now();
        for i in 0..20 {
            sender.send(format!("line {i}"));
        }
        assert!(started.elapsed() < std::time::Duration::from_millis(500));
        // 卡着的时候 flush 等不到，按时限放弃
        assert!(!sender.flush(std::time::Duration::from_millis(50)));
        release_tx.send(()).unwrap();
        assert!(sender.flush(std::time::Duration::from_secs(5)));
        let written = written.lock().unwrap();
        assert!(written.len() < 20, "{written:?}");
        assert!(written.iter().any(|l| l.contains("dropped")), "{written:?}");
        assert_eq!(written[0], "line 0");
    }

    #[test]
    fn crash_log_appends_and_rotates() {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path().canonicalize().unwrap().join("Logs");
        let path = write_crash(&dir, "first\n").unwrap();
        assert_eq!(path, dir.join("crash.log"));
        write_crash(&dir, "second\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first\nsecond\n");
        std::fs::write(&path, vec![b'x'; 1_000_001]).unwrap();
        write_crash(&dir, "third\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "third\n");
        assert_eq!(
            std::fs::metadata(dir.join("crash.log.1")).unwrap().len(),
            1_000_001
        );
    }

    #[cfg(any(debug_assertions, feature = "diag-faults"))]
    #[test]
    fn faults_are_parsed() {
        assert_eq!(parse_fault("panic"), Some(Fault::Panic));
        assert_eq!(parse_fault(" gateway-state "), Some(Fault::GatewayState));
        assert_eq!(
            parse_fault("page:models"),
            Some(Fault::Page("models".into()))
        );
        assert_eq!(parse_fault("tray-panel"), Some(Fault::TrayPanel));
        assert_eq!(parse_fault(" tray-icon "), Some(Fault::TrayIcon));
        assert_eq!(parse_fault("tray"), None);
        assert_eq!(parse_fault("page:"), None);
        assert_eq!(parse_fault(""), None);
        assert_eq!(parse_fault("nonsense"), None);
    }
}
