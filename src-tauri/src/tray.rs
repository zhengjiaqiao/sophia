//! 菜单栏入口（docs/specs/2026-09-21-tray.md）：常驻图标、弹出面板、关窗不退出。
//!
//! 面板是应用自己的一个无边框小窗（标签 `tray`），和主窗口同一份前端产物，换成不激活应用的
//! NSPanel（tauri-nspanel）：弹出不把 Sophia 切到前台，主窗口不跟着冒出来。左右键都弹这一个面板。
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
/// 面板与屏幕边缘至少留这么多（点）
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

/// 面板左上角放哪：点击处正下方、水平居中；贴近屏幕边缘时往回收，整体不出屏（单位随调用方，现用 Cocoa 的点）。
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

/// 第一次调用返回 true 并留下标记，之后一律 false。标记写入失败时宁可每次都不提示，也不要每次都提示。
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
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::{
        AppHandle, Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
    };
    use tauri_nspanel::{CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt};

    /// 面板的 NSPanel 子类。放进子模块：`tauri_panel!` 会在所在模块里 `use` 一批 AppKit 名字
    mod class {
        tauri_nspanel::tauri_panel! {
            panel!(SophiaTrayPanel {
                config: {
                    // 要能成为 key window：Esc、输入框、开关都靠键盘焦点
                    can_become_key_window: true,
                    // 不当 main window：主窗口的「当前窗口」身份不被面板抢走
                    can_become_main_window: false,
                    is_floating_panel: true,
                    // NSPanel 默认在应用失活时自己藏起来；收起统一走失焦（Focused(false)），
                    // 那条路会记下收起时刻给 REOPEN_GUARD 用
                    hides_on_deactivate: false
                }
            })
        }
    }

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

    fn toggle_panel(app: &AppHandle) {
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

        place_under_menu_bar(&panel);
        // 不能用 WebviewWindow::show / set_focus：tauri 的 set_focus 会激活整个应用，
        // 主窗口哪怕压在别的应用后面也会跟着跳到最前。非激活面板只 orderFront + makeKey
        match app.get_webview_panel(PANEL) {
            Ok(ns_panel) => ns_panel.show_and_make_key(),
            Err(_) => {
                let _ = panel.show();
            }
        }
    }

    /// 把面板窗口换成不激活应用的 NSPanel（tauri-nspanel）。
    /// 换类只改对象的 isa，tauri 的窗口委托不动：失焦照旧收到 `WindowEvent::Focused(false)`
    fn make_nonactivating(panel: &tauri::WebviewWindow) -> tauri::Result<()> {
        let ns_panel = panel.to_panel::<class::SophiaTrayPanel>()?;
        // 只加 NonactivatingPanel 一位，保留 tauri 建窗时的其余样式
        if let Err(e) = ns_panel.add_style_mask(StyleMask::empty().nonactivating_panel().into()) {
            eprintln!("托盘面板设不成非激活：{e}");
        }
        // 菜单栏下拉的层级：与状态栏同层，压在普通窗口和浮动窗口之上
        ns_panel.set_level(PanelLevel::Status.value());
        // 所有桌面空间都能弹出；别的应用全屏时也能盖在它上面
        ns_panel.set_collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .full_screen_auxiliary()
                .into(),
        );
        Ok(())
    }

    /// 面板的原生窗口细节（DESIGN「托盘面板」）：
    /// - 不要系统默认的出现动画——普通窗口 orderFront 时会从中心放大弹出，菜单栏面板应当直接出现在图标下
    /// - 圆角 12（同确认弹窗 `dialog`）：窗口本身透明，内容层按圆角裁切；描边在前端画成同样的圆角
    fn style_panel(panel: &tauri::WebviewWindow) {
        use objc2_app_kit::{NSColor, NSWindow, NSWindowAnimationBehavior};
        let Ok(ptr) = panel.ns_window() else {
            return;
        };
        // SAFETY: tauri 给的是这个面板的 NSWindow 指针，窗口与本函数都在主线程（setup 期间）
        let window: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
        window.setAnimationBehavior(NSWindowAnimationBehavior::None);
        window.setOpaque(false);
        window.setBackgroundColor(Some(&NSColor::clearColor()));
        if let Some(view) = window.contentView() {
            view.setWantsLayer(true);
            if let Some(layer) = view.layer() {
                layer.setCornerRadius(12.0);
                layer.setMasksToBounds(true);
            }
        }
    }

    /// 把面板放到菜单栏下沿、点击处正下方（水平居中于点击处，夹在那块屏幕里）。
    ///
    /// 直接用 Cocoa 的屏幕坐标（左下为原点、单位点）：鼠标此刻的位置、它所在那块屏幕的
    /// `visibleFrame` 上沿就是菜单栏下沿。不走托盘事件给的图标矩形再经 tauri / tao 换算——
    /// 多块屏幕、缩放不同时那条换算会把面板放到屏幕中间（产品负责人真机：在页面中央弹出）
    fn place_under_menu_bar(panel: &tauri::WebviewWindow) {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSEvent, NSScreen, NSWindow};
        use objc2_foundation::NSPoint;
        let (Ok(ptr), Some(mtm)) = (panel.ns_window(), MainThreadMarker::new()) else {
            return;
        };
        // SAFETY: tauri 给的是这个面板的 NSWindow 指针；托盘事件在主线程上处理
        let window: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
        let mouse = NSEvent::mouseLocation();
        let screens = NSScreen::screens(mtm);
        let screen = screens.iter().find(|s| {
            let f = s.frame();
            mouse.x >= f.origin.x
                && mouse.x <= f.origin.x + f.size.width
                && mouse.y >= f.origin.y
                && mouse.y <= f.origin.y + f.size.height
        });
        let Some(screen) = screen else {
            return;
        };
        let frame = screen.frame();
        let visible = screen.visibleFrame();
        let top = visible.origin.y + visible.size.height;
        let width = window.frame().size.width;
        let (x, _) = panel_origin(
            (mouse.x, top, 0.0, 0.0),
            width,
            (frame.origin.x, frame.size.width),
            EDGE_MARGIN,
        );
        window.setFrameTopLeftPoint(NSPoint::new(x, top));
    }

    pub fn setup(app: &tauri::App) -> tauri::Result<()> {
        app.manage(PanelState::default());

        // 面板窗口：启动时就建好、藏着，弹出时不用等前端加载
        let panel = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("index.html".into()))
            .title("Sophia")
            .inner_size(PANEL_WIDTH, 260.0)
            .decorations(false)
            .resizable(false)
            .shadow(false) // 零阴影（DESIGN「Elevation」）；边界由面板自己的 1px ink 描边给出
            .always_on_top(true)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
            .visible(false)
            .build()?;
        // 先换成 NSPanel、改完样式掩码，再做动画与圆角：改样式掩码可能重建窗口边框视图，
        // 放在后面保证圆角、透明底落在最终的那一层上
        make_nonactivating(&panel)?;
        style_panel(&panel);
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

        // 左键、右键（双指）都弹同一个面板（DESIGN「托盘面板」）：图标只做一件事，
        // 不再挂一份只有「打开 / 退出」的原生菜单——面板里就有这两项；面板万一出不来，
        // Dock 图标与 ⌘Q 仍能打开和退出
        TrayIconBuilder::with_id("main")
            .icon(tauri::image::Image::from_bytes(include_bytes!(
                "../icons/tray.png"
            ))?)
            .icon_as_template(true) // 单色模板图，系统按深浅色着色：零色彩
            .tooltip("Sophia")
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left | MouseButton::Right,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    toggle_panel(tray.app_handle());
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
                .title("Sophia 还在菜单栏里")
                .show(|_| {});
        }
        true
    }

    /// 面板高度跟着内容走。上沿钉住不动：Cocoa 改窗口大小默认钉的是左下角，
    /// 内容一变面板就会往上或往下跳
    pub fn set_panel_height(app: &AppHandle, height: f64) {
        use objc2_app_kit::NSWindow;
        use objc2_foundation::{NSPoint, NSRect, NSSize};
        let height = clamp_panel_height(height);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(panel) = handle.get_webview_window(PANEL) else {
                return;
            };
            let Ok(ptr) = panel.ns_window() else {
                let _ = panel.set_size(LogicalSize::new(PANEL_WIDTH, height));
                return;
            };
            // SAFETY: 主线程上取这个面板的 NSWindow；窗口在应用整个生命周期里都在
            let window: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
            let f = window.frame();
            let top = f.origin.y + f.size.height;
            window.setFrame_display(
                NSRect::new(
                    NSPoint::new(f.origin.x, top - height),
                    NSSize::new(f.size.width, height),
                ),
                true,
            );
        });
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
pub fn tray_hide(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    hide_panel(&app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
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
