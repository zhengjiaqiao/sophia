//! 外观（spec 2026-09-30-language-and-theme R2 R4 R5）：读写设置里的外观，并把它设到每个窗口的原生外观上。
//!
//! 窗口外观一设，WebKit 里的 `prefers-color-scheme` 就跟着变（2026-09-30 真机验证；tao 的 `set_theme`
//! 设的是整个应用的 NSAppearance），前端只认那一个媒体查询，全应用只有这一处判断。
//! 跟随系统时给 `None`，系统切深浅色，窗口与网页当场跟着变。
use crate::AppState;
use sophia_core::store::Appearance;
use tauri::window::Color;
use tauri::{AppHandle, Manager, Runtime, Theme};

/// 设置里的外观 → 窗口的原生外观；跟随系统是 `None`
pub fn window_theme(value: Appearance) -> Option<Theme> {
    match value {
        Appearance::System => None,
        Appearance::Light => Some(Theme::Light),
        Appearance::Dark => Some(Theme::Dark),
    }
}

/// 网页画出来之前窗口底下的颜色：机壳色（与 src/tokens.css 的 `--shell` 两套值同值）。
/// 不设时 WebKit 在 CSS 生效前先铺白底，深色外观冷启动会闪一下白（独立审查 2026-09-30）
pub fn shell_color(theme: Theme) -> Color {
    match theme {
        Theme::Dark => Color(0x14, 0x14, 0x13, 0xff),
        _ => Color(0xf4, 0xf4, 0xf2, 0xff),
    }
}

/// 把外观设到所有窗口上（主窗口、托盘面板），主窗口的底色跟着换；设不上的报出来
pub fn apply<R: Runtime>(app: &AppHandle<R>, value: Appearance) -> Result<(), String> {
    for (label, window) in app.webview_windows() {
        window
            .set_theme(window_theme(value))
            .map_err(|e| sophia_core::t!("settings.appearance.applyFailed", error = e))?;
        // 托盘面板不画底（系统材质垫底，见 tray.rs），不设底色
        if label == "main" {
            let theme = window.theme().unwrap_or(Theme::Light);
            let _ = window.set_background_color(Some(shell_color(theme)));
        }
    }
    Ok(())
}

/// 启动时按存下的外观设一次
pub fn apply_saved<R: Runtime>(app: &AppHandle<R>) {
    let value = app
        .state::<AppState>()
        .store
        .load_settings()
        .map(|s| s.appearance)
        .unwrap_or_default();
    if let Err(e) = apply(app, value) {
        eprintln!("{e}");
    }
}

/// 设置页读外观
#[tauri::command]
pub fn appearance(state: tauri::State<'_, AppState>) -> Result<Appearance, String> {
    Ok(state
        .store
        .load_settings()
        .map_err(|e| e.to_string())?
        .appearance)
}

/// 设置页改外观：写进设置，当场设到所有窗口；设不上把原因交给设置页
#[tauri::command]
pub fn set_appearance(
    value: Appearance,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .store
        .set_appearance(value)
        .map_err(|e| e.to_string())?;
    apply(&app, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_theme_maps_system_to_none() {
        assert_eq!(window_theme(Appearance::System), None);
        assert_eq!(window_theme(Appearance::Light), Some(Theme::Light));
        assert_eq!(window_theme(Appearance::Dark), Some(Theme::Dark));
    }

    /// 与 tokens.css 的 `--shell` 同值：浅 #F4F4F2、深 #141413
    #[test]
    fn shell_color_matches_tokens() {
        let tokens = include_str!("../../src/tokens.css");
        assert!(tokens.contains("--shell: #f4f4f2;"));
        assert!(tokens.contains("--shell: #141413;"));
        assert_eq!(shell_color(Theme::Light), Color(0xf4, 0xf4, 0xf2, 0xff));
        assert_eq!(shell_color(Theme::Dark), Color(0x14, 0x14, 0x13, 0xff));
    }
}
