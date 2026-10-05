//! 每日上报的本机记账（Codex 复审 1、3、4、5、7）：把内存里的次数落进 `report-counts.json`、组装要发的批次、
//! 记下发成功与失败、开关切换。同步、不联网——发请求在 `src-tauri/src/report.rs`。
//!
//! 事件（第二段，`events.rs`）也经它：内存里的事件随次数一起落进 `report-events.json`，组装要发的事件、记下结果。
//!
//! 锁的先后：计数文件锁（`file`）在前，内存里的 `Pending` 锁、settings.json 读改写锁（`Store::lock_settings`）在后；
//! 后两把互不嵌套。发请求时一把都不拿。
use super::{CountsFile, Event, EventOutcome, EventsFile, Pending, CRASH_FILE};
use crate::store::Store;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, TryLockError};

/// 崩溃时没能落盘的那次崩溃记在这里（数据目录下，每行一个本地日期），下次启动并进计数（复审 7）
pub const PANIC_MARKERS_FILE: &str = "report-panics.log";

/// 崩溃钩子里用：在 `dir` 下的 [`PANIC_MARKERS_FILE`] 末尾追加一行 `day`
pub fn append_panic_marker(dir: &Path, day: &str) -> io::Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(dir)?;
    std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(dir.join(PANIC_MARKERS_FILE))?
        .write_all(format!("{day}\n").as_bytes())
}

/// 崩溃旁文件到了这么大就不再追加（下次启动读进去、删掉之前，总量有个上限）
pub const CRASH_FILE_MAX_BYTES: u64 = 1024 * 1024;

/// 崩溃钩子里用（上报开着时）：把已去隐私的崩溃记录追加到 `dir` 下的 [`CRASH_FILE`]，下次启动读进事件队列
/// 已经超过 [`CRASH_FILE_MAX_BYTES`] 就不再追加（只看一次大小，不报错）
pub fn append_crash_report(dir: &Path, report: &str) -> io::Result<()> {
    use std::io::Write;
    let path = dir.join(CRASH_FILE);
    // 只看一次 lstat：是符号链接就不写（不跟着它写到别处、也绕不过上限），超过上限也不写
    if std::fs::symlink_metadata(&path)
        .is_ok_and(|m| m.file_type().is_symlink() || m.len() > CRASH_FILE_MAX_BYTES)
    {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)?
        .write_all(report.as_bytes())
}

/// 一批要发的事件：组装时的安装 ID 与开关代次（同 [`Batch`]，开关一动就作废）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventBatch {
    pub install_id: String,
    generation: u64,
    pub events: Vec<Event>,
}

/// 一批要发的每日上报：组装时的安装 ID 与开关代次。开关一动代次就变，这一批剩下的不发、发完的不记（复审 3）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Batch {
    pub install_id: String,
    generation: u64,
    pub days: Vec<(String, super::Counts)>,
}

pub struct Reporter {
    store: Store,
    pending: &'static Pending,
    file: Mutex<()>,
    generation: AtomicU64,
}

impl Reporter {
    pub fn new(store: Store, pending: &'static Pending) -> Self {
        Self {
            store,
            pending,
            file: Mutex::new(()),
            generation: AtomicU64::new(0),
        }
    }

    fn lock(&self) -> MutexGuard<'_, ()> {
        self.file.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn markers_path(&self) -> std::path::PathBuf {
        self.store.dir().join(PANIC_MARKERS_FILE)
    }

    fn crash_path(&self) -> std::path::PathBuf {
        self.store.dir().join(CRASH_FILE)
    }

    /// 启动时调：按设置决定计不计数；把上次崩溃时没落进去的崩溃次数、崩溃旁文件里的崩溃记录并进来
    /// （关着就丢掉），删掉这两个小文件
    pub fn start(&self, today: &str) -> io::Result<()> {
        let _guard = self.lock();
        let on = self.store.load_settings()?.auto_report;
        self.pending.set_enabled(on);
        self.absorb_crash_file(today, on)?;
        let markers = match std::fs::read_to_string(self.markers_path()) {
            Ok(text) => text,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        if on {
            let mut file = self.load_counts();
            file.add_panics(today, &markers);
            self.store.save_report_counts(&file)?;
        }
        std::fs::remove_file(self.markers_path())
    }

    /// 崩溃旁文件读进事件队列（开着时）后删掉；存不下就留着，下次启动再读
    /// 是符号链接就只删链接、不跟着读（不把别处的文件当崩溃记录发出去）
    fn absorb_crash_file(&self, today: &str, on: bool) -> io::Result<()> {
        match std::fs::symlink_metadata(self.crash_path()) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return std::fs::remove_file(self.crash_path())
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        }
        let bytes = std::fs::read(self.crash_path())?;
        if on {
            let events = super::crash_events(&String::from_utf8_lossy(&bytes), today);
            let mut file = self.load_events();
            file.absorb(today, events);
            self.store.save_report_events(&file)?;
        }
        std::fs::remove_file(self.crash_path())
    }

    /// 事件文件坏了（读不懂）从头记，别的读错照报
    fn load_events(&self) -> EventsFile {
        self.store.load_report_events().unwrap_or_else(|e| {
            log::warn!("没发出去的错误事件读不了，从头记：{e}");
            EventsFile::default()
        })
    }

    /// 内存里取出的事件并进事件文件。存不下：放回内存、报错。调用方拿着 `file` 锁、确认过开着
    fn persist_events_locked(&self, today: &str, events: Vec<Event>) -> io::Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        let mut file = self.load_events();
        let before = file.clone();
        file.absorb(today, events.clone());
        if file != before {
            if let Err(e) = self.store.save_report_events(&file) {
                self.pending.restore_events(events);
                return Err(e);
            }
        }
        Ok(())
    }

    /// 计数文件坏了（读不懂）从头记，别的读错照报
    fn load_counts(&self) -> CountsFile {
        self.store.load_report_counts().unwrap_or_else(|e| {
            log::warn!("按天的异常次数读不了，从头记：{e}");
            CountsFile::default()
        })
    }

    /// 内存里的次数并进计数文件、事件并进事件文件。关着：丢掉、不碰文件，返回 None。次数存不下：放回内存、
    /// 报错（复审 4）；事件存不下：放回内存、记一条日志，不耽误次数与每日上报。调用方拿着 `file` 锁
    fn persist_locked(&self, today: &str) -> io::Result<Option<CountsFile>> {
        let taken = self.pending.take();
        let events = self.pending.take_events();
        if !self.pending.enabled() {
            return Ok(None);
        }
        if let Err(e) = self.persist_events_locked(today, events) {
            log::warn!("错误事件存不下（留在内存里，下次再存）：{e}");
        }
        let mut file = self.load_counts();
        let before = file.clone();
        file.absorb(today, &taken);
        if file != before {
            if let Err(e) = self.store.save_report_counts(&file) {
                self.pending.restore(taken);
                return Err(e);
            }
        }
        Ok(Some(file))
    }

    /// 定时落盘、正常退出时调
    pub fn persist(&self, today: &str) -> io::Result<()> {
        let _guard = self.lock();
        self.persist_locked(today).map(|_| ())
    }

    /// 组装这一次要发的：先落盘（存不下就不发这份快照），再按 `due` 挑日子；关着、没有要发的为 None
    pub fn begin_batch(&self, today: &str, now: u64) -> io::Result<Option<Batch>> {
        let _guard = self.lock();
        let generation = self.generation.load(Ordering::SeqCst);
        let Some(file) = self.persist_locked(today)? else {
            return Ok(None);
        };
        let days = file.due(today, now);
        if days.is_empty() {
            return Ok(None);
        }
        // 拿 settings.json 读改写锁读开关、要安装 ID：关着就是 None，不会把「开着」写回去（复审 1）
        let Some(install_id) = self.store.report_install_id()? else {
            return Ok(None);
        };
        Ok(Some(Batch {
            install_id,
            generation,
            days,
        }))
    }

    /// 这一批还作数：组装之后开关没动过
    pub fn is_current(&self, batch: &Batch) -> bool {
        self.generation.load(Ordering::SeqCst) == batch.generation
    }

    /// 发成功了一天：开关动过就不记（返回 false）
    pub fn record_sent(
        &self,
        batch: &Batch,
        day: &str,
        sent: super::Counts,
        now: u64,
    ) -> io::Result<bool> {
        let _guard = self.lock();
        if !self.is_current(batch) {
            return Ok(false);
        }
        let mut file = self.load_counts();
        file.record_sent(day, sent, now);
        self.store.save_report_counts(&file)?;
        Ok(true)
    }

    /// 发失败了：往后等（`retry_delay`）。开关动过就不记
    pub fn record_failure(&self, batch: &Batch, now: u64) -> io::Result<()> {
        let _guard = self.lock();
        if !self.is_current(batch) {
            return Ok(());
        }
        let mut file = self.load_counts();
        file.record_failure(now);
        self.store.save_report_counts(&file)
    }

    /// `使用统计和错误报告` 开关：代次加一（正在发的那一批作废）、内存里的次数与事件清掉，再改设置
    /// （关掉删安装 ID、计数文件、事件文件与崩溃旁文件，再开换新 ID）。计数开不开以改完之后的设置为准
    pub fn set_auto_report(&self, enabled: bool) -> io::Result<()> {
        let _guard = self.lock();
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.pending.set_enabled(false);
        let result = self.store.set_auto_report(enabled);
        let on = self
            .store
            .load_settings()
            .map(|s| s.auto_report)
            .unwrap_or(false);
        self.pending.set_enabled(on);
        result
    }

    /// 崩溃钩子里调：只试一次锁（正在落盘的可能就是崩溃的这条线程），落进去了返回 true。
    /// 拿不到锁或存不下返回 false，调用方改记 [`append_panic_marker`]
    pub fn flush_on_panic(&self, today: &str) -> bool {
        let _guard = match self.file.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(p)) => p.into_inner(),
            Err(TryLockError::WouldBlock) => return false,
        };
        self.persist_locked(today).is_ok()
    }

    /// 组装这一次要发的事件：先把内存里的落盘（存不下就不发），发失败后还在等、没有要发的、关着为 None
    pub fn begin_event_batch(&self, today: &str, now: u64) -> io::Result<Option<EventBatch>> {
        let _guard = self.lock();
        let generation = self.generation.load(Ordering::SeqCst);
        let taken = self.pending.take_events();
        if !self.pending.enabled() {
            return Ok(None);
        }
        self.persist_events_locked(today, taken)?;
        // 排着的旧事件按现在的正文规则再处理一遍（幂等；规则变严之后旧队列不按旧规则发出）
        let events: Vec<Event> = self
            .load_events()
            .due(now)
            .into_iter()
            .map(|mut event| {
                event.body = super::event_body(&event.body);
                event
            })
            .collect();
        if events.is_empty() {
            return Ok(None);
        }
        // 同每日上报：拿 settings.json 读改写锁读开关、要安装 ID，关着就是 None（复审 1）
        let Some(install_id) = self.store.report_install_id()? else {
            return Ok(None);
        };
        Ok(Some(EventBatch {
            install_id,
            generation,
            events,
        }))
    }

    /// 这一批事件还作数：组装之后开关没动过
    pub fn is_event_batch_current(&self, batch: &EventBatch) -> bool {
        self.generation.load(Ordering::SeqCst) == batch.generation
    }

    /// 记下一条事件的结果：处理完 / 不合格移出队列（等待清零），重试往后等。开关动过就不记（返回 false）
    pub fn record_event_result(
        &self,
        batch: &EventBatch,
        event: &Event,
        outcome: EventOutcome,
        now: u64,
    ) -> io::Result<bool> {
        let _guard = self.lock();
        if !self.is_event_batch_current(batch) {
            return Ok(false);
        }
        let mut file = self.load_events();
        match outcome {
            EventOutcome::Done | EventOutcome::Rejected => file.record_done(event),
            EventOutcome::Retry => file.record_failure(now),
        }
        self.store.save_report_events(&file)?;
        Ok(true)
    }

    /// 事件文件的当前内容（测试与诊断用）
    pub fn events(&self) -> io::Result<EventsFile> {
        let _guard = self.lock();
        self.store.load_report_events()
    }

    /// 计数文件的当前内容（测试与诊断用）
    pub fn counts(&self) -> io::Result<CountsFile> {
        let _guard = self.lock();
        self.store.load_report_counts()
    }
}

/// 内存里还没落盘的（测试用）
#[cfg(test)]
fn pending_days(p: &Pending) -> std::collections::BTreeMap<String, super::Counts> {
    p.take()
}

#[cfg(test)]
mod tests {
    use super::super::{Counts, Kind};
    use super::super::{Event, EventOutcome, EventsFile};
    use super::*;
    use crate::test_support::TempTree;

    const DAY: &str = "2026-10-04";
    // 东八区 2026-10-04 12:00
    const NOON: u64 = 1_791_086_400;

    fn setup() -> (TempTree, std::path::PathBuf, &'static Pending, Reporter) {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        let pending: &'static Pending = Box::leak(Box::new(Pending::new()));
        pending.set_local_offset(8 * 3600);
        let r = Reporter::new(Store::new(dir.clone()), pending);
        r.start(DAY).unwrap();
        (t, dir, pending, r)
    }

    fn one(kind: Kind) -> Counts {
        let mut c = Counts::default();
        c.add(kind, 1);
        c
    }

    #[test]
    fn start_follows_the_setting() {
        let (_t, _dir, pending, r) = setup();
        assert!(pending.enabled(), "新装默认开");
        r.set_auto_report(false).unwrap();
        assert!(!pending.enabled());
        r.set_auto_report(true).unwrap();
        assert!(pending.enabled());
    }

    #[test]
    fn batch_persists_then_sends_today_once() {
        let (_t, dir, pending, r) = setup();
        pending.count_at(Kind::Network, NOON);
        let batch = r.begin_batch(DAY, NOON).unwrap().unwrap();
        assert_eq!(batch.days, vec![(DAY.to_string(), one(Kind::Network))]);
        assert!(dir.join(super::super::COUNTS_FILE).exists());
        assert!(r
            .record_sent(&batch, DAY, one(Kind::Network), NOON)
            .unwrap());
        assert_eq!(r.begin_batch(DAY, NOON + 60).unwrap(), None);
    }

    /// 关掉再打开：组装好的那一批作废，剩下的不发、发完的不记，新 ID 不带旧次数（复审 3）
    #[test]
    fn toggling_cancels_the_batch_in_flight() {
        let (_t, _dir, pending, r) = setup();
        pending.count_at(Kind::Auth, NOON);
        let batch = r.begin_batch(DAY, NOON).unwrap().unwrap();
        assert!(r.is_current(&batch));
        r.set_auto_report(false).unwrap();
        r.set_auto_report(true).unwrap();
        assert!(!r.is_current(&batch));
        assert!(!r.record_sent(&batch, DAY, one(Kind::Auth), NOON).unwrap());
        r.record_failure(&batch, NOON).unwrap();
        let fresh = r.begin_batch(DAY, NOON).unwrap().unwrap();
        assert_ne!(fresh.install_id, batch.install_id);
        assert_eq!(fresh.days, vec![(DAY.to_string(), Counts::default())]);
        assert_eq!(r.counts().unwrap().retry, Default::default());
    }

    /// 关着：不计数、不建计数文件、不组装批次、不生成安装 ID（复审 1、5）
    #[test]
    fn nothing_happens_while_off() {
        let (_t, dir, pending, r) = setup();
        r.set_auto_report(false).unwrap();
        pending.count_at(Kind::Panic, NOON);
        assert_eq!(r.begin_batch(DAY, NOON).unwrap(), None);
        assert!(!dir.join(super::super::COUNTS_FILE).exists());
        let settings = Store::new(dir).load_settings().unwrap();
        assert!(!settings.auto_report);
        assert_eq!(settings.install_id, None);
    }

    /// 计数文件存不下：次数放回内存、这一次不发；能写了再落进去，一次不少（复审 4）
    #[test]
    fn persist_failure_keeps_the_counts_and_sends_nothing() {
        let (_t, dir, pending, r) = setup();
        pending.count_at(Kind::Upstream, NOON);
        // 计数文件的位置被一个目录占着：先写临时文件再改名会失败
        let counts_path = dir.join(super::super::COUNTS_FILE);
        std::fs::create_dir_all(counts_path.join("x")).unwrap();
        assert!(r.begin_batch(DAY, NOON).is_err());
        assert!(r.persist(DAY).is_err());
        std::fs::remove_dir_all(&counts_path).unwrap();
        let batch = r.begin_batch(DAY, NOON).unwrap().unwrap();
        assert_eq!(batch.days, vec![(DAY.to_string(), one(Kind::Upstream))]);
        assert!(pending_days(pending).is_empty());
    }

    /// 发失败之后按 1 小时往后等；发成功清零
    #[test]
    fn failure_backs_off_until_the_retry_time() {
        let (_t, _dir, _pending, r) = setup();
        let batch = r.begin_batch(DAY, NOON).unwrap().unwrap();
        r.record_failure(&batch, NOON).unwrap();
        assert_eq!(r.begin_batch(DAY, NOON + 3599).unwrap(), None);
        let batch = r.begin_batch(DAY, NOON + 3600).unwrap().unwrap();
        r.record_sent(&batch, DAY, Counts::default(), NOON + 3600)
            .unwrap();
        assert_eq!(r.counts().unwrap().retry, Default::default());
    }

    /// 崩溃：拿得到锁就当场落盘；拿不到返回 false，记在旁边小文件里，下次启动并进那一天（复审 7）
    #[test]
    fn panic_counts_survive_a_held_lock() {
        let (_t, dir, pending, r) = setup();
        pending.count_at(Kind::Panic, NOON);
        assert!(r.flush_on_panic(DAY));
        assert_eq!(
            r.counts().unwrap().days[DAY].counts,
            one(Kind::Panic),
            "拿得到锁：当场落盘"
        );

        let held = r.lock();
        pending.count_at(Kind::Panic, NOON);
        assert!(!r.flush_on_panic(DAY));
        drop(held);
        append_panic_marker(&dir, DAY).unwrap();
        // 进程就此结束：内存里那一次没了
        pending.clear();

        let again = Reporter::new(Store::new(dir.clone()), pending);
        again.start(DAY).unwrap();
        let mut two = Counts::default();
        two.add(Kind::Panic, 2);
        assert_eq!(again.counts().unwrap().days[DAY].counts, two);
        assert!(!dir.join(PANIC_MARKERS_FILE).exists());
    }

    const LOC: &str = "src-tauri/src/gateway.rs:47";

    /// 内存里的事件随定时落盘进 `report-events.json`；组装、发完（202）移出队列，同一天同签名不再收（AC4）
    #[test]
    fn events_persist_batch_and_dedupe_across_restarts() {
        let (_t, dir, pending, r) = setup();
        pending.capture_at(
            Kind::Internal,
            LOC,
            "读 /Users/alice/a 失败 sk-abcdefghijklmnopqrstuvwx",
            NOON,
        );
        r.persist(DAY).unwrap();
        assert!(dir.join(super::super::EVENTS_FILE).exists());
        let batch = r.begin_event_batch(DAY, NOON).unwrap().unwrap();
        assert_eq!(batch.events.len(), 1);
        let body = &batch.events[0].body;
        assert!(
            !body.contains("alice") && !body.contains("sk-abcdefghij"),
            "{body}"
        );
        assert_eq!(
            Some(batch.install_id.clone()),
            Store::new(dir.clone()).load_settings().unwrap().install_id
        );
        assert!(r
            .record_event_result(&batch, &batch.events[0], EventOutcome::Done, NOON)
            .unwrap());
        assert_eq!(r.begin_event_batch(DAY, NOON).unwrap(), None);

        // 重开一次（内存清空）：同一天同一处再出，不再收
        let again = Reporter::new(Store::new(dir.clone()), pending);
        again.start(DAY).unwrap();
        pending.capture_at(
            Kind::Internal,
            LOC,
            "读 /Users/bob/b 失败 sk-zyxwvutsrqponmlkjihgfedc",
            NOON + 60,
        );
        assert_eq!(again.begin_event_batch(DAY, NOON + 60).unwrap(), None);
        assert!(again.events().unwrap().queue.is_empty());
    }

    /// 不合格（400 / 413）丢掉；重试（429、5xx、断网）留着并往后等，等够了再发
    #[test]
    fn rejected_events_drop_and_retries_back_off() {
        let (_t, _dir, pending, r) = setup();
        pending.capture_at(Kind::Internal, "a.rs:1", "x", NOON);
        pending.capture_at(Kind::PageFault, "", "y", NOON);
        let batch = r.begin_event_batch(DAY, NOON).unwrap().unwrap();
        assert_eq!(batch.events.len(), 2);
        r.record_event_result(&batch, &batch.events[0], EventOutcome::Rejected, NOON)
            .unwrap();
        r.record_event_result(&batch, &batch.events[1], EventOutcome::Retry, NOON)
            .unwrap();
        assert_eq!(r.begin_event_batch(DAY, NOON + 3599).unwrap(), None);
        let batch = r.begin_event_batch(DAY, NOON + 3600).unwrap().unwrap();
        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].kind, Kind::PageFault);
    }

    /// 关掉再打开：在途那一批作数不了，发完的不记；新 ID 不带旧事件
    #[test]
    fn toggling_cancels_the_event_batch_in_flight() {
        let (_t, _dir, pending, r) = setup();
        pending.capture_at(Kind::Internal, LOC, "x", NOON);
        let batch = r.begin_event_batch(DAY, NOON).unwrap().unwrap();
        assert!(r.is_event_batch_current(&batch));
        r.set_auto_report(false).unwrap();
        r.set_auto_report(true).unwrap();
        assert!(!r.is_event_batch_current(&batch));
        assert!(!r
            .record_event_result(&batch, &batch.events[0], EventOutcome::Retry, NOON)
            .unwrap());
        assert_eq!(r.begin_event_batch(DAY, NOON).unwrap(), None);
        assert_eq!(r.events().unwrap(), EventsFile::default());
    }

    /// 关掉：清内存里的事件，删 `report-events.json` 与崩溃旁文件；关着不收、不建文件
    #[test]
    fn turning_off_clears_events_and_deletes_both_files() {
        let (_t, dir, pending, r) = setup();
        pending.capture_at(Kind::Internal, LOC, "persisted", NOON);
        r.persist(DAY).unwrap();
        pending.capture_at(Kind::Uncaught, "", "in memory", NOON);
        append_crash_report(&dir, "==== panic ====\nlocation: a.rs:1:2\nmessage: m\n").unwrap();
        assert!(dir.join(CRASH_FILE).exists());
        r.set_auto_report(false).unwrap();
        assert!(!dir.join(super::super::EVENTS_FILE).exists());
        assert!(!dir.join(CRASH_FILE).exists());
        assert!(pending.take_events().is_empty());
        pending.capture_at(Kind::Internal, LOC, "while off", NOON);
        r.persist(DAY).unwrap();
        assert_eq!(r.begin_event_batch(DAY, NOON).unwrap(), None);
        assert!(!dir.join(super::super::EVENTS_FILE).exists());
    }

    /// 上次崩溃：下次启动把旁文件读进事件队列（带调用栈），然后删掉（AC5）
    #[test]
    fn crash_file_is_queued_on_start_and_deleted() {
        let (_t, dir, pending, _r) = setup();
        let report = crate::diagnostics::crash_report(&crate::diagnostics::CrashInfo {
            unix_secs: NOON,
            version: "0.3.0",
            os: "macos 15",
            thread: "main",
            location: Some("src-tauri/src/lib.rs:12:5"),
            message: "boom at /Users/alice/x",
            backtrace: "   0: sophia_lib::run\n",
        });
        append_crash_report(&dir, &report).unwrap();
        let again = Reporter::new(Store::new(dir.clone()), pending);
        again.start(DAY).unwrap();
        assert!(!dir.join(CRASH_FILE).exists());
        let batch = again.begin_event_batch(DAY, NOON).unwrap().unwrap();
        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].kind, Kind::Panic);
        assert!(batch.events[0].body.contains("sophia_lib::run"));
        assert!(!batch.events[0].body.contains("alice"));
    }

    /// 上报关着时，崩溃旁文件丢掉、不读，不建事件文件
    #[test]
    fn crash_file_is_dropped_while_off() {
        let (_t, dir, _pending, r) = setup();
        r.set_auto_report(false).unwrap();
        append_crash_report(&dir, "==== panic ====\nlocation: a.rs:1:2\nmessage: m\n").unwrap();
        let pending: &'static Pending = Box::leak(Box::new(Pending::new()));
        Reporter::new(Store::new(dir.clone()), pending)
            .start(DAY)
            .unwrap();
        assert!(!dir.join(CRASH_FILE).exists());
        assert!(!dir.join(super::super::EVENTS_FILE).exists());
    }

    /// 复审 P1：关掉时删不掉旧文件（这里把崩溃旁文件的位置换成目录来模拟），之后再打开也不启用、报错；
    /// 旧事件无论如何不会带着新安装 ID 发出去。删得掉了再打开，从空的开始
    #[test]
    fn a_failed_delete_keeps_reporting_off_and_old_events_never_go_out() {
        let (_t, dir, pending, r) = setup();
        pending.capture_at(Kind::Internal, LOC, "old secret event", NOON);
        r.persist(DAY).unwrap();
        let events_path = dir.join(super::super::EVENTS_FILE);
        let old = std::fs::read(&events_path).unwrap();
        let old_id = r.begin_event_batch(DAY, NOON).unwrap().unwrap().install_id;
        // 崩溃旁文件的位置被一个非空目录占着：删不掉
        std::fs::create_dir_all(dir.join(CRASH_FILE).join("x")).unwrap();
        // 关掉：删不掉只记一条，不报错（界面不回滚成「开」，第二轮复审 P2）
        r.set_auto_report(false).unwrap();
        assert!(!pending.enabled());
        let settings = Store::new(dir.clone()).load_settings().unwrap();
        assert!(!settings.auto_report);
        assert_eq!(settings.install_id, None);
        // 设想事件文件也没删掉（被锁住）
        std::fs::write(&events_path, &old).unwrap();
        // 再打开：旧文件还删不掉，就不打开
        assert!(r.set_auto_report(true).is_err());
        assert!(!pending.enabled());
        let settings = Store::new(dir.clone()).load_settings().unwrap();
        assert!(!settings.auto_report);
        assert_eq!(settings.install_id, None);
        assert_eq!(r.begin_event_batch(DAY, NOON).unwrap(), None);
        // 删得掉了：打开，新 ID，旧事件没了
        std::fs::remove_dir_all(dir.join(CRASH_FILE)).unwrap();
        r.set_auto_report(true).unwrap();
        assert!(pending.enabled());
        pending.capture_at(Kind::PageFault, "", "new", NOON);
        let batch = r.begin_event_batch(DAY, NOON).unwrap().unwrap();
        assert_ne!(batch.install_id, old_id);
        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].kind, Kind::PageFault);
    }

    /// 第二轮复审 P1：排着的旧事件按发送时的正文规则再处理一遍（规则变严之后，旧队列不按旧规则发出）
    #[test]
    fn queued_bodies_are_reprocessed_before_sending() {
        let (_t, dir, _pending, r) = setup();
        let mut file = EventsFile::default();
        file.absorb(
            DAY,
            vec![Event {
                day: DAY.into(),
                kind: Kind::Internal,
                signature: "internal:0123456789ab".into(),
                body: "旧规则留下的 error:~/work/Secret/x.txt".into(),
                version: "0.3.0".into(),
                os: "macOS 15".into(),
            }],
        );
        Store::new(dir).save_report_events(&file).unwrap();
        let batch = r.begin_event_batch(DAY, NOON).unwrap().unwrap();
        assert_eq!(batch.events[0].body, "旧规则留下的 error:…/x.txt");
        // 结果按原来的那条记（处理过的正文不影响移出队列）
        r.record_event_result(&batch, &batch.events[0], EventOutcome::Done, NOON)
            .unwrap();
        assert!(r.events().unwrap().queue.is_empty());
    }

    /// 第二轮复审 P2：崩溃旁文件的位置是符号链接就不写，也不跟着它读
    #[cfg(unix)]
    #[test]
    fn crash_file_symlinks_are_neither_written_nor_read() {
        let (_t, dir, pending, _r) = setup();
        let target = dir.join("elsewhere.txt");
        std::fs::write(
            &target,
            "==== panic ====\nlocation: a.rs:1:2\nmessage: secret elsewhere\n",
        )
        .unwrap();
        std::os::unix::fs::symlink(&target, dir.join(CRASH_FILE)).unwrap();
        append_crash_report(&dir, "more").unwrap();
        assert!(!std::fs::read_to_string(&target).unwrap().contains("more"));
        let again = Reporter::new(Store::new(dir.clone()), pending);
        again.start(DAY).unwrap();
        assert!(
            std::fs::symlink_metadata(dir.join(CRASH_FILE)).is_err(),
            "链接删掉"
        );
        assert!(target.exists(), "链接指向的文件不动");
        assert_eq!(again.begin_event_batch(DAY, NOON).unwrap(), None);
    }

    /// 复审 P2：崩溃旁文件超过 1 MiB 就不再追加
    #[test]
    fn crash_file_stops_growing_past_one_mib() {
        let (_t, dir, _pending, _r) = setup();
        append_crash_report(&dir, "a").unwrap();
        assert_eq!(std::fs::metadata(dir.join(CRASH_FILE)).unwrap().len(), 1);
        let big = "x".repeat(CRASH_FILE_MAX_BYTES as usize);
        append_crash_report(&dir, &big).unwrap();
        let len = std::fs::metadata(dir.join(CRASH_FILE)).unwrap().len();
        assert_eq!(len, CRASH_FILE_MAX_BYTES + 1);
        append_crash_report(&dir, "more").unwrap();
        assert_eq!(std::fs::metadata(dir.join(CRASH_FILE)).unwrap().len(), len);
    }

    /// 崩溃时拿得到锁：内存里还没落盘的事件也当场落进去
    #[test]
    fn flush_on_panic_also_persists_events() {
        let (_t, _dir, pending, r) = setup();
        pending.capture_at(Kind::Internal, LOC, "x", NOON);
        assert!(r.flush_on_panic(DAY));
        assert_eq!(r.events().unwrap().queue.len(), 1);
    }

    /// 上报关着时，旁边小文件里的崩溃丢掉，不建计数文件
    #[test]
    fn panic_markers_are_dropped_while_off() {
        let (_t, dir, _pending, r) = setup();
        r.set_auto_report(false).unwrap();
        append_panic_marker(&dir, DAY).unwrap();
        let pending: &'static Pending = Box::leak(Box::new(Pending::new()));
        Reporter::new(Store::new(dir.clone()), pending)
            .start(DAY)
            .unwrap();
        assert!(!dir.join(PANIC_MARKERS_FILE).exists());
        assert!(!dir.join(super::super::COUNTS_FILE).exists());
    }
}
