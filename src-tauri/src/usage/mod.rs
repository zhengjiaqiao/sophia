//! 用量的桌面接线（T8，spec 第 6 节）：启动调度循环、命令、`usage-changed` 事件、菜单栏绘制。
//!
//! 调度本身在 `sophia_gateway::usage::scheduler`；这里给它一个 [`Host`]：墙上时钟、屏幕与电源状态、
//! 交出新状态（存一份快照给 `usage_view`、发事件、重画菜单栏）、存上一次的读数。
//! 只在 macOS 上跑调度与菜单栏（菜单栏入口本来就只有 macOS 有）；别的系统上命令照常可调，只是没有数。
#[cfg(target_os = "macos")]
mod menubar;
#[cfg(target_os = "macos")]
mod system;

use crate::AppState;
use sophia_core::store::Store;
use sophia_core::usage::connect::ConnectState;
use sophia_core::usage::{AgentId, UsageSettings, UsageState, UsageSubject, MAX_MENU_BAR_ITEMS};
use sophia_gateway::usage::connect::{ConnectStart, Connector, RealConnect};
use sophia_gateway::usage::scheduler::{Command, Handle};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// 给命令用的共享状态：调度循环的遥控、最近一次交出的状态、当前设置
pub struct UsageShared {
    handle: Handle,
    state: Mutex<UsageState>,
    settings: Mutex<UsageSettings>,
    /// 调度最近一次读到的电源状态：过期变淡的阈值要与调度实际的间隔一致
    power: Mutex<sophia_core::usage::PowerState>,
    /// 「连接 Claude 用量」（票 #208）：托盘与用量页共用一份；只在 macOS 上有
    connector: Option<Arc<Connector<RealConnect>>>,
}

impl UsageShared {
    fn connect_state(&self) -> ConnectState {
        self.connector
            .as_ref()
            .map(|c| c.state())
            .unwrap_or_default()
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 启动时调用（托盘建好之后，菜单栏第一次重画才有按钮可画）
pub fn setup(app: &tauri::App) -> Result<(), String> {
    let dir = crate::runtime_store_dir()?;
    let store = Store::new(dir.clone());
    // 设置文件坏了不挡启动：用默认值（菜单栏显示关），用量页保存时会报出来
    let settings = store.load_settings().map(|s| s.usage).unwrap_or_default();
    let restored = store.load_usage_readings().unwrap_or_default();
    let memo = store.load_usage_memo().unwrap_or_default();
    let (handle, rx) = Handle::channel();
    #[cfg(target_os = "macos")]
    let connector = Some(Arc::new(Connector::new(real_connect(
        app.handle().clone(),
        handle.clone(),
    )?)));
    #[cfg(not(target_os = "macos"))]
    let connector = None;
    app.manage(UsageShared {
        handle,
        state: Mutex::new(UsageState::default()),
        settings: Mutex::new(settings.clone()),
        power: Mutex::new(Default::default()),
        connector,
    });

    #[cfg(target_os = "macos")]
    {
        use sophia_gateway::usage::scheduler::{run, RealFetcher};
        use std::sync::Arc;
        let host = Arc::new(TauriHost {
            app: app.handle().clone(),
            store,
        });
        let fetcher = Arc::new(RealFetcher {
            base_dir: dir,
            account: usage_account()?,
        });
        tauri::async_runtime::spawn(run(rx, fetcher, host, settings, restored, memo));
        tauri::async_runtime::spawn(redraw_every_minute(app.handle().clone()));
    }
    #[cfg(not(target_os = "macos"))]
    drop((rx, store, restored, memo));
    Ok(())
}

/// 真实的「连接 Claude 用量」：进程走到新的一步就发 `usage-changed`（托盘与用量页重读视图）；
/// 连上后让调度只取 Claude 一次（不等最短间隔），取完才算连接结束
#[cfg(target_os = "macos")]
fn real_connect(app: AppHandle, handle: Handle) -> Result<RealConnect, String> {
    Ok(RealConnect {
        account: usage_account()?,
        on_change: Box::new(move |_state| {
            use tauri::Emitter;
            let state = lock(&app.state::<UsageShared>().state).clone();
            let _ = app.emit("usage-changed", state);
        }),
        on_connected: Box::new(move || {
            let done = handle.retry(UsageSubject::Agent(AgentId::ClaudeCode));
            Box::pin(async move {
                let _ = done.await;
            })
        }),
    })
}

/// 用量看哪个账号：调试版指定了测试主目录（`SOPHIA_TEST_HOME`）时看它，否则看真实环境
#[cfg(target_os = "macos")]
fn usage_account() -> Result<sophia_gateway::usage::Account, String> {
    #[cfg(debug_assertions)]
    if std::env::var_os("SOPHIA_TEST_HOME").is_some() {
        let home = crate::runtime_env()?.home;
        return Ok(sophia_gateway::usage::Account::in_home(&home));
    }
    Ok(sophia_gateway::usage::Account::real())
}

/// 倒计时（「2:58」）与过期变淡随时间变化，读数不变也要按分钟重画
#[cfg(target_os = "macos")]
async fn redraw_every_minute(app: AppHandle) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        if lock(&app.state::<UsageShared>().settings).menu_bar_enabled {
            redraw(&app);
        }
    }
}

#[cfg(target_os = "macos")]
struct TauriHost {
    app: AppHandle,
    store: Store,
}

#[cfg(target_os = "macos")]
impl sophia_gateway::usage::scheduler::Host for TauriHost {
    fn now(&self) -> i64 {
        unix_now()
    }

    fn display_asleep(&self) -> bool {
        system::display_asleep()
    }

    fn system(&self) -> sophia_gateway::usage::scheduler::SystemState {
        let s = system::read();
        *lock(&self.app.state::<UsageShared>().power) = sophia_core::usage::PowerState {
            on_battery: s.on_battery,
            constrained: s.constrained,
        };
        s
    }

    fn publish(&self, state: &UsageState) {
        use tauri::Emitter;
        *lock(&self.app.state::<UsageShared>().state) = state.clone();
        let _ = self.app.emit("usage-changed", state);
        redraw(&self.app);
    }

    fn save_readings(&self, readings: &[sophia_core::usage::Reading]) {
        // 存不下只影响重启后的首屏（R13），不打断调度
        if let Err(e) = self.store.save_usage_readings(readings) {
            log::warn!("存用量读数失败：{e}");
        }
    }

    fn save_memo(&self, memo: &sophia_core::usage::ScheduleMemo) {
        // 存不下只是重启后少了上次尝试与限流的记忆，不打断调度
        if let Err(e) = self.store.save_usage_memo(memo) {
            log::warn!("存用量调度记录失败：{e}");
        }
    }
}

/// 按当前状态与设置重画菜单栏（设置里关着时恢复成只有图标）。换了界面语言也调它（读数里有字）
pub(crate) fn redraw(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let shared = app.state::<UsageShared>();
        let state = lock(&shared.state).clone();
        let settings = lock(&shared.settings).clone();
        let power = *lock(&shared.power);
        let view = sophia_core::usage::format::menu_bar_view(&state, &settings, power, unix_now());
        let Some(tray) = app.tray_by_id("main") else {
            return;
        };
        if view.segments.is_empty() {
            // 关着：交回 tray-icon 自己设原图标，与改版前完全一样（AC22）
            if let Ok(icon) =
                tauri::image::Image::from_bytes(include_bytes!("../../icons/tray.png"))
            {
                let _ = tray.set_icon(Some(icon));
                let _ = tray.set_icon_as_template(true);
            }
            return;
        }
        let _ = tray.with_inner_tray_icon(move |inner| {
            let (Some(item), Some(icon)) = (inner.ns_status_item(), menubar::app_icon()) else {
                return;
            };
            menubar::apply(&item, &menubar::draw(&icon, &view.segments));
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// 托盘、用量页要画的一份视图（状态、设置、托盘各块、菜单栏预览，文字都在 core 里算好）。
/// `opened`：刚打开托盘或用量页，顺带触发补取（R6），补取的结果经 `usage-changed` 送达；
/// 收到事件或按分钟重画时传 false，只读不取。菜单栏用量只在 macOS 上有，别的系统返回 None
#[tauri::command]
pub fn usage_view(
    shared: tauri::State<'_, UsageShared>,
    opened: bool,
) -> Option<sophia_core::usage::format::UsageView> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    if opened {
        shared.handle.send(Command::Opened);
    }
    let state = lock(&shared.state).clone();
    let settings = lock(&shared.settings).clone();
    let power = *lock(&shared.power);
    Some(sophia_core::usage::format::usage_view_with(
        &state,
        &settings,
        power,
        unix_now(),
        &shared.connect_state(),
    ))
}

#[tauri::command]
pub fn usage_settings(state: tauri::State<'_, AppState>) -> Result<UsageSettings, String> {
    Ok(state
        .store
        .load_settings()
        .map_err(|e| crate::cmd_error::data_unread(e))?
        .usage)
}

/// 存用量设置，调度与菜单栏立即生效
#[tauri::command]
pub fn usage_set_settings(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    shared: tauri::State<'_, UsageShared>,
    mut settings: UsageSettings,
) -> Result<(), String> {
    if settings
        .items
        .as_ref()
        .is_some_and(|items| items.len() > MAX_MENU_BAR_ITEMS)
    {
        return Err(sophia_core::tn!(
            "usage.agents.maxMenuBar",
            MAX_MENU_BAR_ITEMS
        ));
    }
    let _settings_guard = state.store.lock_settings();
    let mut all = state
        .store
        .load_settings()
        .map_err(|e| crate::cmd_error::data_unread(e))?;
    // 旧版的 `agents` / `perAgent` 以盘上原文为准，原样写回（换回旧版本时照旧读得懂）
    settings.keep_legacy_keys(&all.usage);
    all.usage = settings.clone();
    state
        .store
        .save_settings(&all)
        .map_err(|e| crate::cmd_error::settings_unsaved(e))?;
    *lock(&shared.settings) = settings.clone();
    shared.handle.send(Command::Settings(settings));
    redraw(&app);
    Ok(())
}

/// 手动刷新。给了 `key`（项的键，`agent:codex`、`provider:<id>`）是原因行旁的「再试一次」（2026-10-03）：
/// 只取这一项，起进程的取法不等最短间隔、限流退避照守，这一轮跑完才返回（界面据此收回「正在读取…」，
/// 新数照常经 `usage-changed` 到）。`key` 为空刷全部，仍受各取法的最短间隔与限流约束，发出即返回（R6、R7）
#[tauri::command]
pub async fn usage_refresh(
    shared: tauri::State<'_, UsageShared>,
    key: Option<UsageSubject>,
) -> Result<(), String> {
    match key {
        // 调度循环没在跑（非 macOS）时回话端随命令丢了，立即返回
        Some(subject) => {
            let _ = shared.handle.retry(subject).await;
        }
        None => shared.handle.send(Command::Refresh(None)),
    }
    Ok(())
}

/// 点「连接 Claude 用量」或失败后的「再试一次」（票 #208）。找不到 Claude Code、`allow_install` 为假时
/// 返回 `needsInstall`（界面先问一句「安装 Claude Code？」，确认后带 `allow_install` 再调）；
/// 已有一个连接在跑返回 `busy`。过程的每一步经 `usage-changed` 送达。Claude「需要重新登录」时
/// 登录记录还在也走登录
#[tauri::command]
pub async fn usage_connect(
    shared: tauri::State<'_, UsageShared>,
    allow_install: bool,
) -> Result<ConnectStart, String> {
    let Some(connector) = shared.connector.clone() else {
        // 用量只在 macOS 上有（`usage_view` 返回 None，界面不出这颗键），走不到这里
        return Err("usage is only available on macOS".into());
    };
    let force_login = sophia_core::usage::connect::force_login(&lock(&shared.state));
    let start = connector.start(allow_install, force_login);
    if start == ConnectStart::Started {
        log::info!("开始连接 Claude 用量（需要时安装：{allow_install}，重新登录：{force_login}）");
    }
    Ok(start)
}

/// Sophia 退出（`RunEvent::Exit`）：给正在跑的连接发取消——正在装就结束安装脚本整组（SIGTERM，2 秒后
/// SIGKILL），正在登录就结束登录——再等它收尾，最多 [`EXIT_WAIT`]。没在连接时立刻返回
pub fn on_exit(app: &AppHandle) {
    let Some(shared) = app.try_state::<UsageShared>() else {
        return;
    };
    let Some(connector) = &shared.connector else {
        return;
    };
    if !connector.running() {
        return;
    }
    connector.shutdown();
    let deadline = std::time::Instant::now() + EXIT_WAIT;
    while connector.running() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if connector.running() {
        log::warn!(
            "退出时连接 Claude 用量没能在 {} 秒内收尾",
            EXIT_WAIT.as_secs()
        );
    }
}

/// 退出时等连接收尾的上限：比结束整组的 SIGTERM 宽限（2 秒）多 1 秒
const EXIT_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

/// 等授权时点「取消」：结束登录，回到点之前的样子（安装中不可取消）
#[tauri::command]
pub fn usage_connect_cancel(shared: tauri::State<'_, UsageShared>) {
    if let Some(connector) = &shared.connector {
        connector.cancel();
    }
}

/// 「没看到授权页 · 再打开 ↗」
#[tauri::command]
pub fn usage_connect_reopen(shared: tauri::State<'_, UsageShared>) -> Result<(), String> {
    match &shared.connector {
        Some(connector) => connector.reopen().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}
