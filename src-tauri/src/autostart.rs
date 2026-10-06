//! 开机启动（spec 2026-10-03-gateway-in-app R15、R16）：系统登录项，用 SMAppService.mainAppService。
//!
//! 开没开以系统为准、不另存：只有 `Enabled` 算开。真机上用户在系统设置里关掉后读到的是 `NotFound`
//! （不是文档说的 `RequiresApproval`），其余状态一律按关显示。
//! 用户在系统设置里删掉之后再 `unregister` 会报 "Operation not permitted"：之后读状态不是 `Enabled` 就算关成了。
//! 只有 macOS 有；别的系统上读到的是关、打开时报错
//!
//! 默认开（spec 2026-10-05-keep-running R1）：第一次打开时注册一次，之后以系统为准。
//! 登录项拉起时只出现在菜单栏（R2）：`Ready` 时看打开事件带不带「登录项」标记。

#[cfg(target_os = "macos")]
mod imp {
    use objc2_service_management::{SMAppService, SMAppServiceStatus};

    pub fn enabled() -> bool {
        // SAFETY: 无参的类方法与只读属性，没有指针参数
        unsafe { SMAppService::mainAppService().status() == SMAppServiceStatus::Enabled }
    }

    /// 刚注册完，系统改状态可能比 register 返回晚一点：最多等 2 秒看它变成开
    fn settle(on: bool) -> bool {
        for _ in 0..10 {
            let now = enabled();
            if now == on {
                return now;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        enabled()
    }

    pub fn set(on: bool) -> Result<bool, String> {
        // SAFETY: 同上；register / unregister 的错误以 NSError 返回，下面转成文字。
        // 这两个调用与读状态都要一两秒（真机），所以命令放在阻塞线程池里跑，不占主线程——
        // 占着主线程时界面卡住，开关看着没反应，用户再点一下就又关掉了（2026-10-03 真机）
        let service = unsafe { SMAppService::mainAppService() };
        let result = if on {
            unsafe { service.registerAndReturnError() }
        } else {
            unsafe { service.unregisterAndReturnError() }
        };
        let now = settle(on);
        match result {
            Ok(()) => Ok(now),
            // 关：已经不在登录项里就算成了（用户在系统设置里删掉过）
            Err(_) if !on && !now => Ok(false),
            Err(error) => Err(error.localizedDescription().to_string()),
        }
    }

    /// 这次是不是登录项拉起的：打开事件（`kAEOpenApplication`）的 `keyAEPropData` 参数等于
    /// `keyAELaunchedAsLogInItem`。要在打开事件还是当前事件时问（`RunEvent::Ready`，对应
    /// `applicationDidFinishLaunching`）；读不到一律当用户自己打开的
    pub fn launched_as_login_item() -> bool {
        use objc2::rc::Retained;
        use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventManager};
        // SAFETY: 无参的类方法与只读访问；`paramDescriptorForKeyword:` 的参数是四字码整数、返回可空的描述符，
        // 用 msg_send 直接调（objc2-foundation 把它锁在 objc2-core-services 特性后面，只为一个整数参数不值得多拉一个 crate）
        unsafe {
            let Some(event) = NSAppleEventManager::sharedAppleEventManager().currentAppleEvent()
            else {
                return false;
            };
            let prop: Option<Retained<NSAppleEventDescriptor>> =
                objc2::msg_send![&*event, paramDescriptorForKeyword: super::KEY_AE_PROP_DATA];
            prop.is_some_and(|prop| prop.enumCodeValue() == super::KEY_AE_LAUNCHED_AS_LOGIN_ITEM)
        }
    }
}

/// AppleEvents.h 的 `keyAEPropData`（'prdt'）与 `keyAELaunchedAsLogInItem`（'lgit'）：四字码按大端拼成整数
pub const KEY_AE_PROP_DATA: u32 = four_cc(b"prdt");
pub const KEY_AE_LAUNCHED_AS_LOGIN_ITEM: u32 = four_cc(b"lgit");

const fn four_cc(code: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*code)
}

/// 第一次打开时默认注册登录项（R1）：只做一次，成败都记下；注册要一两秒，放后台线程。
/// 别的系统什么都不做
pub fn default_on_first_launch(app: tauri::AppHandle, store_dir: std::path::PathBuf) {
    #[cfg(target_os = "macos")]
    std::thread::spawn(move || {
        let store = sophia_core::store::Store::new(store_dir);
        let defaulted = match store.load_settings() {
            Ok(settings) => settings.autostart_defaulted,
            Err(e) => {
                log::warn!("读设置失败，这次不默认注册登录项：{e}");
                return;
            }
        };
        if !should_default(defaulted, crate::test_home_active()) {
            return;
        }
        match imp::set(true) {
            Ok(on) => log::info!(
                "第一次打开：登录项已注册（现在{}）",
                if on { "是开的" } else { "没开" }
            ),
            Err(e) => log::warn!("第一次打开：注册登录项失败：{e}"),
        }
        if let Err(e) = store.mark_autostart_defaulted() {
            log::warn!("记「登录项已默认注册」失败：{e}");
        }
        // 设置页可能已经打开、读到的还是注册前的「关」：让它重读（Codex 复审）
        use tauri::Emitter;
        let _ = app.emit(AUTOSTART_CHANGED, ());
    });
    #[cfg(not(target_os = "macos"))]
    let _ = (app, store_dir);
}

/// 要不要在这次启动时默认注册登录项：没注册过才注册；测试主目录（验证用的 debug 实例）一律不注册——
/// 否则 worktree 里的 debug 二进制会被注册成这台电脑的系统登录项（2026-10-05 retro，一轮验证里删了五次）
fn should_default(defaulted: bool, test_home: bool) -> bool {
    !defaulted && !test_home
}

/// 登录项在后台被改过（默认注册完成）：设置页收到就重读
pub const AUTOSTART_CHANGED: &str = "autostart-changed";

/// 这次启动要不要开主窗口：登录项拉起且菜单栏图标建成了才只留菜单栏；
/// 图标没建成就没有别的入口，必须开窗口（spec prelaunch-five R3）
fn should_show_main(tray_built: bool, login_item: bool) -> bool {
    !(tray_built && login_item)
}

/// `Ready` 时调（R2）：登录项拉起就只留菜单栏，否则开主窗口。别的系统上一律开窗口
pub fn show_main_unless_login_item(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let login_item = imp::launched_as_login_item();
        let tray_built = crate::tray::icon_built();
        if !should_show_main(tray_built, login_item) {
            log::info!("由登录项拉起：只出现在菜单栏");
            return;
        }
        if login_item {
            log::warn!("由登录项拉起，但菜单栏图标没建成：照常打开主窗口");
        }
    }
    #[cfg(target_os = "macos")]
    crate::tray::show_main(app);
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = tauri::Manager::get_webview_window(app, crate::tray::MAIN) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AppleEvents.h 里的两个四字码
    #[test]
    fn test_home_never_registers_a_login_item() {
        assert!(super::should_default(false, false));
        assert!(!super::should_default(true, false), "注册过就不再注册");
        assert!(
            !super::should_default(false, true),
            "测试主目录里的实例不碰系统登录项"
        );
    }

    #[test]
    fn show_main_decision_covers_tray_and_login_item() {
        // 图标在 × 登录项拉起：只留菜单栏
        assert!(!should_show_main(true, true));
        // 图标在 × 自己打开：开窗口
        assert!(should_show_main(true, false));
        // 图标不在 × 登录项拉起：没有别的入口，必须开窗口
        assert!(should_show_main(false, true));
        // 图标不在 × 自己打开：开窗口
        assert!(should_show_main(false, false));
    }

    #[test]
    fn four_char_codes_match_apple_headers() {
        assert_eq!(KEY_AE_PROP_DATA, 0x7072_6474);
        assert_eq!(KEY_AE_LAUNCHED_AS_LOGIN_ITEM, 0x6C67_6974);
    }
}

/// 开机启动开着没有（系统登录项的真实状态）；这个平台没有这一项时为 None，设置页不画这一节
#[tauri::command]
pub async fn autostart_get() -> Option<bool> {
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(imp::enabled)
        .await
        .ok();
    #[cfg(not(target_os = "macos"))]
    None
}

/// 打开或关掉开机启动；返回改完之后系统里的真实状态
#[tauri::command]
pub async fn autostart_set(on: bool) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(move || imp::set(on))
        .await
        .map_err(|e| format!("[internal] {e}"))?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = on;
        Err(sophia_core::t!("models.cmd.macOnly"))
    }
}
