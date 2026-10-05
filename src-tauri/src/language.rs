//! 界面语言（spec 2026-09-30-language-and-theme R1 R2 R12 R13）：读写设置里的界面语言，解析「跟随系统」，
//! 写进 core 的当前语言，并让已经画出来的文字跟着换——应用菜单重建、菜单栏用量重画、两个窗口收到
//! `locale-changed` 后各自重渲染、重拉后端算好的句子。
//!
//! 系统语言读 `NSLocale.preferredLanguages`（系统设置里的首选语言列表）。不用 `NSBundle.preferredLocalizations`：
//! 那是按应用包声明的本地化过滤过的结果，开发构建（没有打包的 Info.plist）下拿不到（第 0 步原型实测）。
use crate::AppState;
use serde::Serialize;
use sophia_core::i18n::{self, Lang};
use sophia_core::store::{Language, Store};
use tauri::{AppHandle, Emitter};

/// 换了语言之后发给两个窗口的事件；载荷是实际语言（`zh-Hans` / `zh-Hant` / `en`）
pub const EVENT: &str = "locale-changed";

/// 设置页读到的：设置里存的，和此刻实际用的
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiLanguage {
    pub setting: Language,
    pub resolved: Lang,
}

/// 系统首选语言列表，先后即优先次序
pub fn system_tags() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        objc2_foundation::NSLocale::preferredLanguages()
            .iter()
            .map(|tag| tag.to_string())
            .collect()
    }
    // 别的系统：看 LANG（`zh_TW.UTF-8`）
    #[cfg(not(target_os = "macos"))]
    {
        std::env::var("LANG")
            .ok()
            .and_then(|v| v.split('.').next().map(str::to_string))
            .into_iter()
            .collect()
    }
}

/// 启动时（建菜单之前）按设置写入当前语言
pub fn init(store: &Store) {
    let setting = store
        .load_settings()
        .map(|s| s.language)
        .unwrap_or_default();
    i18n::set_locale(i18n::resolve(setting, system_tags));
}

/// 换到这种语言：写进 core，重建应用菜单，重画菜单栏用量，通知两个窗口
pub fn apply(app: &AppHandle, lang: Lang) {
    i18n::set_locale(lang);
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Err(e) = crate::menu::rebuild(&handle) {
                log::warn!("重建应用菜单失败：{e}");
            }
        });
    }
    crate::usage::redraw(app);
    let _ = app.emit(EVENT, lang);
}

/// 读界面语言：设置里存的，和此刻实际用的（core 的当前语言）
#[tauri::command]
pub fn ui_language(state: tauri::State<'_, AppState>) -> Result<UiLanguage, String> {
    Ok(UiLanguage {
        setting: state
            .store
            .load_settings()
            .map_err(|e| e.to_string())?
            .language,
        resolved: i18n::locale(),
    })
}

/// 改界面语言：写进设置，解析成实际语言，当场换掉（选了就生效，R2）
#[tauri::command]
pub fn set_ui_language(
    value: Language,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<UiLanguage, String> {
    state.store.set_language(value).map_err(|e| e.to_string())?;
    let resolved = i18n::resolve(value, system_tags);
    apply(&app, resolved);
    Ok(UiLanguage {
        setting: value,
        resolved,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 读给前端的形状() {
        let v = UiLanguage {
            setting: Language::System,
            resolved: Lang::ZhHant,
        };
        assert_eq!(
            serde_json::to_value(v).unwrap(),
            serde_json::json!({"setting": "system", "resolved": "zh-Hant"})
        );
    }
}
