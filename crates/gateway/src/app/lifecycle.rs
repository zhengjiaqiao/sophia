//! 路由在 Sophia 进程里运行之后的生命周期（spec 2026-10-03-gateway-in-app）：
//! 起路由与自动换端口（R4）、打开时接上（R12、R13）、退出前的预览与收尾（R5–R9）、关机时同步改回（R10）、
//! 旧版 launchd 服务的迁移（R14）。
//!
//! 「开着」与「接上」分开记：开着是用户在模型页的选择（Codex：`GatewaySettings.enabled`；Claude：`enabled`），
//! 只由开关改变；接上是 Sophia 此刻写着对方的设置、路由在跑。退出、关机、接不上只改「接上」。
use super::{
    config, internal, reset_default_model, Agent, App, AppError, Untouched, SERVICE_LABEL,
};
use crate::process;
use crate::router_host::{Occupant, StartError};
use sophia_core::codex_models::settings::{GatewaySettings, PORT_RANGE};
use std::time::{Duration, Instant};

/// 关机时等别的动作放锁最多等这么久：关机不能被一个慢动作拖住，写入本身有写前写后校验兜底
const EXIT_LOCK_PATIENCE: Duration = Duration::from_secs(1);

/// 路由端口的说明（模型页显示，`GatewayState.port_notice`）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum PortNotice {
    /// 另一个 Sophia（比如开发版）占着端口：不换端口，Codex 设置改回了原样
    AnotherSophia { port: u16 },
    /// 端口被别的程序占着，换到了 `to` 并记住；正在运行的 Codex、Claude 要重启生效
    PortMoved { from: u16, to: u16 },
    /// 端口范围里全被别的程序占着：Codex 设置改回了原样
    PortsBusy,
}

impl PortNotice {
    /// 当前语言的一句话
    pub fn text(&self) -> String {
        match self {
            PortNotice::AnotherSophia { port } => {
                sophia_core::t!("models.app.anotherSophia", port = port)
            }
            PortNotice::PortMoved { from, to } => {
                sophia_core::t!("models.app.portMoved", from = from, to = to)
            }
            PortNotice::PortsBusy => sophia_core::t!(
                "models.app.portsBusy",
                from = PORT_RANGE.start(),
                to = PORT_RANGE.end()
            ),
        }
    }
}

/// 某一家没做成：哪一家、错误代码（`desktop_busy`、`router_down`…）与当前语言的说明
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyError {
    pub agent: Agent,
    pub code: String,
    pub message: String,
}

impl FamilyError {
    fn new(agent: Agent, error: AppError) -> Self {
        Self {
            agent,
            code: error.code.to_owned(),
            message: error.message,
        }
    }
}

/// 打开 Sophia 时接上的结果
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachReport {
    /// 同 `GatewayState.port_notice`
    pub notice: Option<PortNotice>,
    /// 没接上的那几家
    pub errors: Vec<FamilyError>,
}

/// 退出前要不要确认、确认框里说什么（R5、R6）
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuitPreview {
    /// Codex 设置正指着路由：退出会改回并重启 Codex
    pub codex: bool,
    /// Codex 桌面应用在运行
    pub codex_app_running: bool,
    /// 终端里有交互式 `codex` 在运行：它不会被重启，要用户自己重启
    pub codex_terminal: bool,
    /// Claude 桌面应用处在 Sophia 写入的第三方模式：退出会切回官方
    pub claude: bool,
    /// Claude 桌面应用在运行（切回要先退出再重新打开）
    pub claude_running: bool,
}

/// 退出收尾进行到哪一步（确认框里的忙碌文案）
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QuitStep {
    RestartingCodex,
    RestartingClaude,
}

impl App {
    pub(super) fn notice(&self) -> Option<PortNotice> {
        self.notice
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub(super) fn set_notice(&self, notice: Option<PortNotice>) {
        *self.notice.lock().unwrap_or_else(|p| p.into_inner()) = notice;
    }

    /// 写对方设置之前起好路由；端口被别的程序占着时换了端口（已记住），已经指着旧端口的 Codex 设置跟着改。
    /// 起不来 → `router_down`，`untouched` 定「哪份配置没动」那一句
    pub(super) fn ensure_router(
        &self,
        settings: &mut GatewaySettings,
        untouched: Untouched,
    ) -> Result<(), AppError> {
        let port = settings.port;
        match self.bring_up(settings) {
            Ok(None) => Ok(()),
            Ok(Some(_)) => self.follow_port_move(settings),
            Err(reason) => Err(AppError::new(
                "router_down",
                match untouched {
                    Untouched::Codex => {
                        sophia_core::t!("models.app.routerNotReady", port = port, error = reason)
                    }
                    Untouched::Claude => sophia_core::t!(
                        "models.claude.routerNotReadyBusy",
                        port = port,
                        error = reason
                    ),
                },
            )),
        }
    }

    /// 在记住的端口上起路由（R4）。被别的程序占着 → 依次试端口范围里的其余端口，第一个起得来的就记住它
    /// （跳过另一个 Sophia 占着的）；被另一个 Sophia 占着 → 不换。返回换端口之前的端口（没换为 None）；
    /// 起不来时返回原因（当前语言），端口的说明记在 `notice`
    fn bring_up(&self, settings: &mut GatewaySettings) -> Result<Option<u16>, String> {
        let port = settings.port;
        match (self.deps.router_start)(port) {
            Ok(()) => {
                // 这回起来了：另一个 Sophia、端口都被占的说明作废；换过端口的说明留着（还要重启生效）
                if !matches!(self.notice(), Some(PortNotice::PortMoved { .. })) {
                    self.set_notice(None);
                }
                Ok(None)
            }
            Err(StartError::Failed(reason)) => Err(reason),
            Err(StartError::Busy(Occupant::Sophia)) => {
                let notice = PortNotice::AnotherSophia { port };
                let reason = notice.text();
                self.set_notice(Some(notice));
                Err(reason)
            }
            Err(StartError::Busy(Occupant::Other)) => {
                for candidate in PORT_RANGE.filter(|candidate| *candidate != port) {
                    if (self.deps.router_start)(candidate).is_err() {
                        continue;
                    }
                    settings.port = candidate;
                    if let Err(e) = self.save(settings) {
                        // 记不住新端口：别留着一个下次找不到的路由
                        (self.deps.router_stop)();
                        settings.port = port;
                        return Err(e.message);
                    }
                    self.set_notice(Some(PortNotice::PortMoved {
                        from: port,
                        to: candidate,
                    }));
                    return Ok(Some(port));
                }
                let notice = PortNotice::PortsBusy;
                let reason = notice.text();
                self.set_notice(Some(notice));
                Err(reason)
            }
        }
    }

    /// 换了端口之后：Codex 设置还指着本功能的旧端口，就把路由地址原位换成新端口（其余逐字节不动；
    /// 独立服务商形态的表里那一个也换），
    /// 并记一笔变更——正在运行的 Codex 还指着旧端口，要重启生效（R13）
    fn follow_port_move(&self, settings: &mut GatewaySettings) -> Result<(), AppError> {
        let snapshot = self.read_config()?;
        let managed = self.managed(settings);
        let points = config::inspect(&snapshot.text, &managed).is_ok_and(|i| i.points_at_router);
        if !points {
            return Ok(());
        }
        let Some(text) = config::retarget(&snapshot.text, &managed) else {
            return Ok(());
        };
        self.write_config(&snapshot, &text)?;
        let now = (self.deps.now)();
        settings.changed_at = Some(now);
        settings.record_change(now, true);
        self.save(settings)
    }

    /// Codex「开着」：旧版本留下的设置里没有这个字段，按 Codex 设置现在指不指着路由补上并存回
    fn codex_wanted(&self, settings: &mut GatewaySettings) -> bool {
        if let Some(wanted) = settings.enabled {
            return wanted;
        }
        let wanted = self.codex_on();
        settings.enabled = Some(wanted);
        let _ = self.save(settings);
        wanted
    }

    /// 打开 Sophia 时（包括崩溃、被强制结束之后）接上（R12、R13）。调用方持有配置写锁（界面是 `config_lock`）。
    ///
    /// 两家都没开着 → 什么都不做（不起路由，R1）。起路由：另一个 Sophia 占着端口、或端口都被占 → Codex 设置还指着路由
    /// 就改回原样（官方模型照常可用），「开着」不变；被别的程序占着 → 换端口并按新端口重写设置（不重启 Codex、Claude）。
    /// 起来之后：Codex 开着且没写 → 写；Claude 开着、桌面应用里没写（或端口换了）→ 走「打开」（在运行就是待生效）。
    /// 已经接上时再调用什么都不变
    pub fn attach(&self) -> AttachReport {
        let _guard = self.guard();
        let mut report = AttachReport::default();
        // 上一次接上时的说明作废，这次重新判断
        self.set_notice(None);
        let mut settings = match self.load() {
            Ok(settings) => settings,
            Err(error) => {
                report.errors.push(FamilyError::new(Agent::Codex, error));
                return report;
            }
        };
        let codex_wanted = self.codex_wanted(&mut settings);
        let claude = self.load_claude().unwrap_or_default();
        if !codex_wanted && !claude.enabled && claude.applied.is_none() {
            return report;
        }
        let moved = match self.bring_up(&mut settings) {
            Ok(moved) => moved,
            Err(reason) => {
                if self.codex_on() {
                    if let Err(error) = self.unwrite_codex_locked(false) {
                        report.errors.push(FamilyError::new(Agent::Codex, error));
                    }
                }
                if self.notice().is_none() {
                    let agent = if codex_wanted {
                        Agent::Codex
                    } else {
                        Agent::Claude
                    };
                    report.errors.push(FamilyError::new(
                        agent,
                        AppError::new(
                            "router_down",
                            sophia_core::t!(
                                "models.app.routerNotReady",
                                port = settings.port,
                                error = reason
                            ),
                        ),
                    ));
                }
                report.notice = self.notice();
                return report;
            }
        };
        if moved.is_some() {
            if let Err(error) = self.follow_port_move(&mut settings) {
                report.errors.push(FamilyError::new(Agent::Codex, error));
            }
        }
        if codex_wanted {
            if let Err(error) = self.enable_locked() {
                report.errors.push(FamilyError::new(Agent::Codex, error));
            }
        }
        if claude.enabled && (claude.applied.is_none() || moved.is_some()) {
            if let Err(error) = self.open_claude_locked(false) {
                report.errors.push(FamilyError::new(Agent::Claude, error));
            }
        }
        report.notice = self.notice();
        report
    }

    /// 退出前：要不要确认、确认框里说什么（R5、R6）。只读
    pub fn quit_preview(&self) -> QuitPreview {
        let (codex, claude) = {
            let _guard = self.guard();
            (
                self.codex_on(),
                self.load_claude().is_ok_and(|s| s.applied.is_some()),
            )
        };
        let processes = (self.deps.list_processes)().unwrap_or_default();
        QuitPreview {
            codex,
            codex_app_running: (self.deps.codex_app_running)().unwrap_or(false),
            codex_terminal: processes
                .iter()
                .any(|p| process::is_codex_interactive(&p.command)),
            claude,
            claude_running: (self.deps.desktop_running)().unwrap_or(false),
        }
    }

    /// 用户确认退出后的收尾（R7、R9）：Codex 设置逐字节改回并重启 Codex → Claude 切回官方（在运行就退出再打开）
    /// → 停路由。两家的「开着」都不变，下次打开 Sophia 时接上（R8）。某一家没做成不中断其余的，
    /// 返回没做成的那几家（空＝都做成了）。`acquire` 取调用方的配置写锁（界面是 `config_lock`），只在写文件时持有，
    /// 等应用退出、打开时不持有；`progress` 报告进行到哪一步
    pub fn detach_for_quit<G>(
        &self,
        acquire: impl Fn() -> G,
        progress: impl Fn(QuitStep),
    ) -> Vec<FamilyError> {
        let mut failures = Vec::new();
        let codex = {
            let _outer = acquire();
            let _guard = self.guard();
            self.codex_on()
                .then(|| self.unwrite_codex_locked(false).map(|_| ()))
        };
        match codex {
            Some(Ok(())) => {
                progress(QuitStep::RestartingCodex);
                if let Err(error) = self.restart_codex() {
                    failures.push(FamilyError::new(Agent::Codex, error));
                }
            }
            Some(Err(error)) => failures.push(FamilyError::new(Agent::Codex, error)),
            None => {}
        }
        if self.load_claude().is_ok_and(|s| s.applied.is_some()) {
            progress(QuitStep::RestartingClaude);
            if let Err(error) = self.switch_back_for_quit(&acquire) {
                failures.push(FamilyError::new(Agent::Claude, error));
            }
        }
        (self.deps.router_stop)();
        self.set_notice(None);
        failures
    }

    /// 系统关机、注销、从 Dock 退出（应用拦不住的退出，R10）：只把 Codex 设置同步改回原样，
    /// 不起子进程、不联网、不动 Claude、不动「开着」。做几次都一样；任何一步不成就停下，不报错（进程马上要退出）
    pub fn exit_sync(&self) {
        let _guard = self.guard_within(EXIT_LOCK_PATIENCE);
        // 每个停下的地方记一条日志（spec 2026-10-04-local-diagnostics R4）：界面上照旧不报错
        let snapshot = self.read_config();
        let Ok(snapshot) = snapshot.inspect_err(|e| log::warn!("退出时读 Codex 设置失败：{e}"))
        else {
            return;
        };
        // 网关设置读不出（settings.json 坏了，spec S7）：Codex 照样要改回，否则它指着一个不在的网关；
        // 只是启用前的默认模型还原不了、设置文件不写
        let settings = self.load().inspect_err(|e| {
            log::warn!("退出时读网关设置失败，只改回 Codex 设置：{e}");
        });
        let managed = match &settings {
            Ok(settings) => self.managed(settings),
            Err(_) => self.managed_fallback(),
        };
        if !config::inspect(&snapshot.text, &managed).is_ok_and(|i| i.points_at_router) {
            return;
        }
        let Ok(mut settings) = settings else {
            let removed = config::remove(&snapshot.text, &managed, false);
            let Ok(removed) = removed.inspect_err(|e| log::warn!("退出时改回 Codex 设置失败：{e}"))
            else {
                return;
            };
            if let Err(e) = self.write_config(&snapshot, &removed.text) {
                log::warn!("退出时写回 Codex 设置失败：{e}");
            }
            return;
        };
        let reset = reset_default_model(&snapshot.text, &settings, &settings.published_slugs);
        let removed = config::remove(&reset, &managed, settings.added_newline);
        let Ok(removed) = removed.inspect_err(|e| log::warn!("退出时改回 Codex 设置失败：{e}"))
        else {
            return;
        };
        if let Err(e) = self.write_config(&snapshot, &removed.text) {
            log::warn!("退出时写回 Codex 设置失败：{e}");
            return;
        }
        if config::inspect(&removed.text, &managed).is_ok_and(|i| i.points_at_router) {
            log::warn!("退出时改回 Codex 设置后仍指向路由");
            return;
        }
        let now = (self.deps.now)();
        settings.added_newline = false;
        settings.changed_at = Some(now);
        settings.record_change(now, false);
        if let Err(e) = self.save(&settings) {
            log::warn!("退出时存网关设置失败：{e}");
        }
    }

    /// 最多等 `patience` 拿锁；拿不到就不拿（关机时不能卡住）
    fn guard_within(&self, patience: Duration) -> Option<std::sync::MutexGuard<'_, ()>> {
        let deadline = Instant::now() + patience;
        loop {
            match self.lock.try_lock() {
                Ok(guard) => return Some(guard),
                Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                    return Some(poisoned.into_inner())
                }
                Err(std::sync::TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(std::sync::TryLockError::WouldBlock) => return None,
            }
        }
    }

    /// 升级自旧版本（R14）：旧版装的 launchd 路由服务还在 → 卸掉（连 plist）；`<数据目录>/bin/` 的程序副本 → 删掉。
    /// 都不在就什么都不做，所以天然只做一次。返回这次做了没有。卸服务失败时 `bin/` 也留着，下次打开再试
    pub fn migrate_legacy_service(&self) -> Result<bool, AppError> {
        let _guard = self.guard();
        let plist = self
            .deps
            .launch_agents_dir
            .join(format!("{SERVICE_LABEL}.plist"));
        let bin = self.deps.data_dir.join("bin");
        let has_plist = std::fs::symlink_metadata(&plist).is_ok();
        let bin_kind = std::fs::symlink_metadata(&bin).ok().map(|m| m.file_type());
        if !has_plist && bin_kind.is_none() {
            return Ok(false);
        }
        if has_plist {
            (self.deps.service_uninstall)(SERVICE_LABEL).map_err(|e| {
                internal(sophia_core::t!("models.app.legacyServiceFailed", error = e))
            })?;
        }
        match bin_kind {
            Some(kind) if kind.is_dir() => std::fs::remove_dir_all(&bin),
            Some(_) => std::fs::remove_file(&bin),
            None => Ok(()),
        }
        .map_err(|e| {
            internal(sophia_core::t!(
                "models.app.deleteFileFailed",
                name = bin.display(),
                error = e
            ))
        })?;
        Ok(true)
    }
}
