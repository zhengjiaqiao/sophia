//! 用量的桌面接线（T8，spec 第 6 节）：启动调度循环、命令、`usage-changed` 事件、菜单栏绘制。
//!
//! 调度本身在 `sophia_gateway::usage::scheduler`；这里给它一个 [`Host`]：墙上时钟、屏幕与电源状态、
//! 交出新状态（存一份快照给 `usage_view`、发事件、重画菜单栏）、存上一次的读数。
//! 只在 macOS 上跑调度与菜单栏（菜单栏入口本来就只有 macOS 有）；别的系统上命令照常可调，只是没有数。
#[cfg(target_os = "macos")]
mod menubar;
#[cfg(target_os = "macos")]
mod system;

use crate::{err, AppState};
use sophia_core::store::Store;
use sophia_core::usage::{AgentId, UsageSettings, UsageState, MAX_MENU_BAR_AGENTS};
use sophia_gateway::usage::scheduler::{Command, Handle};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// 给命令用的共享状态：调度循环的遥控、最近一次交出的状态、当前设置
pub struct UsageShared {
    handle: Handle,
    state: Mutex<UsageState>,
    settings: Mutex<UsageSettings>,
    /// 调度最近一次读到的电源状态：过期变淡的阈值要与调度实际的间隔一致
    power: Mutex<sophia_core::usage::PowerState>,
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
    app.manage(UsageShared {
        handle,
        state: Mutex::new(UsageState::default()),
        settings: Mutex::new(settings.clone()),
        power: Mutex::new(Default::default()),
    });

    #[cfg(target_os = "macos")]
    {
        use sophia_gateway::usage::scheduler::{run, RealFetcher};
        use std::sync::Arc;
        let host = Arc::new(TauriHost {
            app: app.handle().clone(),
            store,
        });
        let fetcher = Arc::new(RealFetcher { base_dir: dir });
        tauri::async_runtime::spawn(run(rx, fetcher, host, settings, restored, memo));
        tauri::async_runtime::spawn(redraw_every_minute(app.handle().clone()));
    }
    #[cfg(not(target_os = "macos"))]
    drop((rx, store, restored, memo));
    Ok(())
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
        let _ = self.store.save_usage_readings(readings);
    }

    fn save_memo(&self, memo: &sophia_core::usage::ScheduleMemo) {
        // 存不下只是重启后少了上次尝试与限流的记忆，不打断调度
        let _ = self.store.save_usage_memo(memo);
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
    Some(sophia_core::usage::format::usage_view(
        &state,
        &settings,
        power,
        unix_now(),
    ))
}

#[tauri::command]
pub fn usage_settings(state: tauri::State<'_, AppState>) -> Result<UsageSettings, String> {
    Ok(state.store.load_settings().map_err(err)?.usage)
}

/// 存用量设置，调度与菜单栏立即生效
#[tauri::command]
pub fn usage_set_settings(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    shared: tauri::State<'_, UsageShared>,
    settings: UsageSettings,
) -> Result<(), String> {
    if settings
        .agents
        .as_ref()
        .is_some_and(|a| a.len() > MAX_MENU_BAR_AGENTS)
    {
        return Err(sophia_core::tn!(
            "usage.agents.maxMenuBar",
            MAX_MENU_BAR_AGENTS
        ));
    }
    let mut all = state.store.load_settings().map_err(err)?;
    all.usage = settings.clone();
    state.store.save_settings(&all).map_err(err)?;
    *lock(&shared.settings) = settings.clone();
    shared.handle.send(Command::Settings(settings));
    redraw(&app);
    Ok(())
}

/// 手动刷新（`agent` 为空刷全部），仍受各取法的最短间隔与限流约束（R6、R7）
#[tauri::command]
pub fn usage_refresh(shared: tauri::State<'_, UsageShared>, agent: Option<AgentId>) {
    shared.handle.send(Command::Refresh(agent));
}
