//! 退出的三条路（spec 2026-10-03-gateway-in-app 设计 §2）：
//!
//! - 用户主动退出（托盘「退出」、菜单「退出 Sophia」⌘Q）：前端先 `quit_preview` 问要不要确认，
//!   确认后（或什么都没开着时直接）`app_quit` 收尾——Codex 改回并重启、Claude 切回官方、停路由——再 `app.exit(0)`。
//!   收尾进行到哪一步经 `quit-progress` 事件告诉主窗口与托盘面板；某一家没做成就不退出、把没做成的交回前端，
//!   用户看过说明后点「退出」走 `app_exit_now`（R9）
//! - 系统关机、注销、从 Dock 退出：AppKit 直接 terminate，只到不可阻止的 `RunEvent::Exit`，
//!   在这里同步把 Codex 设置改回（R10）
//! - 升级后重启：先到 `ExitRequested{code: RESTART_EXIT_CODE}`，记下来，`Exit` 时什么都不改（R11）
use crate::tray::{MAIN, PANEL};
use crate::AppState;
use sophia_gateway::app::{FamilyError, QuitPreview, QuitStep};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, RunEvent};

/// 菜单「退出 Sophia」（⌘Q）按下：主窗口走退出流程
pub const QUIT_REQUESTED: &str = "quit-requested";
/// 退出收尾进行到哪一步，载荷 `{ step }`
const QUIT_PROGRESS: &str = "quit-progress";
/// 收尾有没做成的：载荷是没做成的那几家。发给主窗口——托盘里点的退出，Codex 重启抢走焦点后面板已经收起，
/// 说明放在面板里就没人看见，所以一律由主窗口说
const QUIT_FAILED: &str = "quit-failed";

/// 这次退出是升级后的重启（`Exit` 时不改回）
static RESTARTING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
struct Progress {
    step: QuitStep,
}

/// 退出前要不要确认、确认框里说什么。没有模型网关（非 macOS）时什么都没开着
#[tauri::command]
pub async fn quit_preview(state: tauri::State<'_, AppState>) -> Result<QuitPreview, String> {
    let Some(gateway) = state.gateway.clone() else {
        return Ok(QuitPreview::default());
    };
    tauri::async_runtime::spawn_blocking(move || gateway.quit_preview())
        .await
        .map_err(|e| format!("[internal] {e}"))
}

/// 用户确认退出（或什么都没开着）：收尾后退出。都做成了就退出，不返回；
/// 有没做成的就不退出，返回没做成的那几家（前端说明后果，用户点「退出」再走 `app_exit_now`）。
/// 配置写锁只在写文件时取（`acquire`），等 Codex、Claude 退出再打开时不占着
#[tauri::command]
pub async fn app_quit(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<FamilyError>, String> {
    let failures = match state.gateway.clone() {
        None => Vec::new(),
        Some(gateway) => {
            let lock = state.config_lock.clone();
            let emitter = app.clone();
            // 在阻塞线程池里跑，那里可以 blocking_lock（它不能在 tokio 运行时线程上调用）
            let failures = tauri::async_runtime::spawn_blocking(move || {
                gateway.detach_for_quit(
                    || lock.blocking_lock(),
                    |step| {
                        for window in [MAIN, PANEL] {
                            let _ = emitter.emit_to(window, QUIT_PROGRESS, Progress { step });
                        }
                    },
                )
            })
            .await
            .map_err(|e| format!("[internal] {e}"))?;
            failures
        }
    };
    if failures.is_empty() {
        app.exit(0);
    } else {
        #[cfg(target_os = "macos")]
        crate::tray::show_main(&app);
        let _ = app.emit_to(MAIN, QUIT_FAILED, &failures);
    }
    Ok(failures)
}

/// 没做成的说明看过了：直接退出（收尾已经做过）
#[tauri::command]
pub fn app_exit_now(app: AppHandle) {
    app.exit(0);
}

/// `.run` 回调里调：分清升级重启与关机，关机时同步改回 Codex 设置
pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    match event {
        RunEvent::ExitRequested {
            code: Some(code), ..
        } if *code == tauri::RESTART_EXIT_CODE => RESTARTING.store(true, Ordering::SeqCst),
        // 收尾做过了也照样再做一次：做几次都一样，而没做成、用户留在应用里又打开了 Codex 的情况下，
        // 之后从 Dock 退出仍要改回
        RunEvent::Exit => {
            if !RESTARTING.load(Ordering::SeqCst) {
                if let Some(gateway) = app.state::<AppState>().gateway.clone() {
                    gateway.exit_sync();
                }
            }
            // 正常退出（含升级重启）：清掉运行标记，下次打开不算意外退出（spec 2026-10-04-local-diagnostics R8）；
            // 放在改回之后，那里记下的日志一并落盘
            #[cfg(not(feature = "weiboap"))]
            crate::report::flush();
            crate::diagnostics::on_exit(crate::runtime_store_dir().ok().as_deref());
        }
        _ => {}
    }
}
