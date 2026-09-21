//! 菜单栏入口（docs/specs/2026-09-21-tray.md）：常驻图标、弹出面板、关窗不退出。
//!
//! 面板是应用自己的一个无边框小窗（标签 `tray`），和主窗口同一份前端产物——
//! 系统原生菜单套不上 docs/DESIGN.md，所以只拿它做右键的兜底。
//! 仅 macOS：模型注入本身只支持 macOS，别的系统上这个入口没有东西可放。
use serde::Serialize;
use std::path::Path;

/// 主窗口与面板窗口的标签
pub const MAIN: &str = "main";
pub const PANEL: &str = "tray";

/// 面板宽度（逻辑像素）。高度由内容决定，前端量好了报上来
pub const PANEL_WIDTH: f64 = 320.0;
const PANEL_MIN_HEIGHT: f64 = 80.0;
const PANEL_MAX_HEIGHT: f64 = 640.0;
/// 面板与屏幕边缘至少留这么多（物理像素之前先乘缩放）
const EDGE_MARGIN: f64 = 8.0;

/// 第一次关窗时说一次「还在菜单栏里」；说过就在数据目录里留这个标记
const CLOSE_HINT_MARKER: &str = ".close-hint-shown";

#[derive(Debug, Clone, Serialize)]
pub struct Navigate {
    /// "models" / "settings"；None 表示只把窗口带到前面
    pub page: Option<String>,
    /// 面板里做不成的事，带到主窗口去说
    pub error: Option<String>,
}

/// 面板左上角放哪（物理像素）：图标正下方、水平居中；贴近屏幕边缘时往回收，整体不出屏。
/// `icon` 是 (x, y, 宽, 高)，`screen` 是所在显示器的 (x, 宽)。
pub fn panel_origin(
    icon: (f64, f64, f64, f64),
    panel_width: f64,
    screen: (f64, f64),
    margin: f64,
) -> (f64, f64) {
    let (icon_x, icon_y, icon_w, icon_h) = icon;
    let (screen_x, screen_w) = screen;
    let centered = icon_x + icon_w / 2.0 - panel_width / 2.0;
    let min = screen_x + margin;
    let max = screen_x + screen_w - panel_width - margin;
    // 屏幕比面板还窄时 max < min：贴左
    let x = if max < min {
        min
    } else {
        centered.clamp(min, max)
    };
    (x, icon_y + icon_h)
}

pub fn clamp_panel_height(height: f64) -> f64 {
    if height.is_finite() {
        height.clamp(PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT)
    } else {
        PANEL_MIN_HEIGHT
    }
}

/// 第一次调用返回 true 并留下标记，之后一律 false。标记写不进去时宁可每次都不提示，也不要每次都提示。
pub fn take_close_hint(store_dir: &Path) -> bool {
    let marker = store_dir.join(CLOSE_HINT_MARKER);
    if marker.exists() {
        return false;
    }
    std::fs::create_dir_all(store_dir)
        .and_then(|()| std::fs::write(&marker, b""))
        .is_ok()
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::{
        AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl,
        WebviewWindowBuilder, WindowEvent,
    };

    /// 面板失焦收起的时刻。点菜单栏图标会先让面板失焦收起、紧接着又收到一次点击：
    /// 不记这个时刻的话，想关面板的那一下会把它又弹出来
    #[derive(Default)]
    pub struct PanelState {
        hidden_at: Mutex<Option<Instant>>,
    }
    const REOPEN_GUARD: Duration = Duration::from_millis(250);

    pub fn show_main(app: &AppHandle) {
        if let Some(window) = app.get_webview_window(MAIN) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    pub fn hide_panel(app: &AppHandle) {
        if let Some(panel) = app.get_webview_window(PANEL) {
            let _ = panel.hide();
        }
    }

    fn toggle_panel(app: &AppHandle, icon: tauri::Rect) {
        let Some(panel) = app.get_webview_window(PANEL) else {
            return;
        };
        if panel.is_visible().unwrap_or(false) {
            let _ = panel.hide();
            return;
        }
        let state = app.state::<PanelState>();
        let just_hidden = state
            .hidden_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some_and(|at| at.elapsed() < REOPEN_GUARD);
        if just_hidden {
            return;
        }

        // 图标矩形换算到物理像素，再找它所在的显示器——多屏时缩放和边界都以那一块为准
        let fallback_scale = panel.scale_factor().unwrap_or(1.0);
        let position = icon.position.to_physical::<f64>(fallback_scale);
        let size = icon.size.to_physical::<f64>(fallback_scale);
        let monitor = panel.available_monitors().ok().and_then(|monitors| {
            monitors.into_iter().find(|m| {
                let origin = m.position();
                let extent = m.size();
                position.x >= origin.x as f64
                    && position.x < origin.x as f64 + extent.width as f64
                    && position.y >= origin.y as f64
                    && position.y < origin.y as f64 + extent.height as f64
            })
        });
        let (scale, screen) = match &monitor {
            Some(m) => (
                m.scale_factor(),
                (m.position().x as f64, m.size().width as f64),
            ),
            None => (fallback_scale, (position.x - 4096.0, 8192.0)),
        };
        let (x, y) = panel_origin(
            (position.x, position.y, size.width, size.height),
            PANEL_WIDTH * scale,
            screen,
            EDGE_MARGIN * scale,
        );
        let _ = panel.set_position(PhysicalPosition::new(x, y));
        let _ = panel.show();
        let _ = panel.set_focus();
    }

    pub fn setup(app: &tauri::App) -> tauri::Result<()> {
        app.manage(PanelState::default());

        // 面板窗口：启动时就建好、藏着，弹出时不用等前端加载
        let panel = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("index.html".into()))
            .title("SymSync")
            .inner_size(PANEL_WIDTH, 260.0)
            .decorations(false)
            .resizable(false)
            .shadow(false) // 零阴影（DESIGN「Elevation」）；边界由面板自己的 1px ink 描边给出
            .always_on_top(true)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
            .visible(false)
            .build()?;
        let handle = app.handle().clone();
        panel.on_window_event(move |event| {
            if let WindowEvent::Focused(false) = event {
                hide_panel(&handle);
                *handle
                    .state::<PanelState>()
                    .hidden_at
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Instant::now());
            }
        });

        // 右键的原生菜单只做兜底：面板万一出不来，也总有办法打开和退出
        let open = MenuItem::with_id(app, "open", "打开 SymSync", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;

        TrayIconBuilder::with_id("main")
            .icon(tauri::image::Image::from_bytes(include_bytes!(
                "../icons/tray.png"
            ))?)
            .icon_as_template(true) // 单色模板图，系统按深浅色着色：零色彩
            .tooltip("SymSync")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "open" => show_main(app),
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    rect,
                    ..
                } = event
                {
                    toggle_panel(tray.app_handle(), rect);
                }
            })
            .build(app)?;
        Ok(())
    }

    /// 关主窗口＝藏起来，不退出（R6）。返回 true 表示这次关闭已被接管
    pub fn intercept_close(window: &tauri::Window, event: &WindowEvent, store_dir: &Path) -> bool {
        let WindowEvent::CloseRequested { api, .. } = event else {
            return false;
        };
        if window.label() != MAIN {
            return false;
        }
        api.prevent_close();
        let _ = window.hide();
        if take_close_hint(store_dir) {
            use tauri_plugin_dialog::DialogExt;
            window
                .app_handle()
                .dialog()
                .message("要退出，点菜单栏图标里的「退出」。模型注入由系统后台服务维持，退出应用也不受影响。")
                .title("SymSync 还在菜单栏里")
                .show(|_| {});
        }
        true
    }

    pub fn set_panel_height(app: &AppHandle, height: f64) {
        if let Some(panel) = app.get_webview_window(PANEL) {
            let _ = panel.set_size(LogicalSize::new(PANEL_WIDTH, clamp_panel_height(height)));
        }
    }

    pub fn navigate(app: &AppHandle, payload: Navigate) {
        hide_panel(app);
        show_main(app);
        let _ = app.emit_to(MAIN, "tray-navigate", payload);
    }
}

#[cfg(target_os = "macos")]
pub use imp::*;

// ----- 面板调用的命令：窗口的显示、隐藏、退出走这里，不给面板窗口开放通用的窗口权限 -----

#[tauri::command]
pub fn tray_open_main(app: tauri::AppHandle, page: Option<String>, error: Option<String>) {
    #[cfg(target_os = "macos")]
    navigate(&app, Navigate { page, error });
    #[cfg(not(target_os = "macos"))]
    let _ = (app, page, error);
}

#[tauri::command]
pub fn tray_set_height(app: tauri::AppHandle, height: f64) {
    #[cfg(target_os = "macos")]
    set_panel_height(&app, height);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, height);
}

#[tauri::command]
pub fn tray_quit(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AC9：图标正下方、水平居中
    #[test]
    fn panel_sits_centered_under_the_icon() {
        let (x, y) = panel_origin((1000.0, 0.0, 44.0, 48.0), 640.0, (0.0, 2880.0), 16.0);
        assert_eq!(x, 1000.0 + 22.0 - 320.0);
        assert_eq!(y, 48.0);
    }

    /// AC9：贴近屏幕右缘时往回收，整体不出屏
    #[test]
    fn panel_is_pulled_back_from_the_right_edge() {
        let (x, _) = panel_origin((2820.0, 0.0, 44.0, 48.0), 640.0, (0.0, 2880.0), 16.0);
        assert_eq!(x, 2880.0 - 640.0 - 16.0);
        assert!(x + 640.0 <= 2880.0);
    }

    #[test]
    fn panel_is_pulled_back_from_the_left_edge() {
        let (x, _) = panel_origin((4.0, 0.0, 44.0, 48.0), 640.0, (0.0, 2880.0), 16.0);
        assert_eq!(x, 16.0);
    }

    /// 副屏在主屏左边时坐标是负的：边界要用那块屏自己的原点
    #[test]
    fn panel_respects_a_monitor_with_a_negative_origin() {
        let (x, _) = panel_origin((-60.0, 0.0, 44.0, 48.0), 640.0, (-1920.0, 1920.0), 16.0);
        assert_eq!(x, -1920.0 + 1920.0 - 640.0 - 16.0);
        let (x, _) = panel_origin((-1900.0, 0.0, 44.0, 48.0), 640.0, (-1920.0, 1920.0), 16.0);
        assert_eq!(x, -1920.0 + 16.0);
    }

    #[test]
    fn a_screen_narrower_than_the_panel_pins_left_instead_of_panicking() {
        let (x, _) = panel_origin((100.0, 0.0, 44.0, 48.0), 640.0, (0.0, 600.0), 16.0);
        assert_eq!(x, 16.0);
    }

    #[test]
    fn panel_height_is_clamped_and_survives_nonsense() {
        assert_eq!(clamp_panel_height(300.0), 300.0);
        assert_eq!(clamp_panel_height(1.0), PANEL_MIN_HEIGHT);
        assert_eq!(clamp_panel_height(1e9), PANEL_MAX_HEIGHT);
        assert_eq!(clamp_panel_height(f64::NAN), PANEL_MIN_HEIGHT);
        assert_eq!(clamp_panel_height(f64::INFINITY), PANEL_MIN_HEIGHT);
    }

    /// AC7：第一次关窗提示一次，之后不再提示
    #[test]
    fn close_hint_is_given_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("SymSync");
        assert!(take_close_hint(&store));
        assert!(!take_close_hint(&store));
        assert!(!take_close_hint(&store));
    }
}
