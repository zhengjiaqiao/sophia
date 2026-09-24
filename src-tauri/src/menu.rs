//! 原生应用菜单（DESIGN「应用菜单」，裁决 D15）：`Sophia` `文件` `编辑` `显示` `窗口` 五个菜单。
//!
//! 每一项都是界面上已有入口的另一条路，不新增能力。菜单只管「按了哪一项」：自定义项一律把
//! 项的 id 原样作为 `menu-command` 事件发给主窗口，前端按 id 路由（`src/shell/menuCommands.ts`）；
//! 剪切 / 拷贝 / 粘贴与隐藏、退出、窗口这些系统标准项用预置项，由系统直接处理。
//!
//! 「显示」里的页签项由位置页的 domain 表生成（`src/shell/locationDomains.json`，与前端同一个文件）：
//! 第 N 项 `CmdOrCtrl+N`，命令名 `tab-<id>`。加一个 domain 不用改这里。
//!
//! 做不了的项灰着、不隐藏：`撤销`（没有可撤销的操作）、`筛选`（不在位置页）、`返回`（不在添加来源页）
//! 由前端按界面状态调 `set_menu_state` 开关。
//!
//! 只在 macOS 上装：别的系统上菜单栏会画进窗口里，那不是这个设计。
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use serde::Deserialize;
use tauri::menu::{
    Menu, MenuEvent, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// 发给前端的事件名；载荷是项的 id（字符串）
pub const EVENT: &str = "menu-command";

/// 自定义项：id、名字、快捷键。id 就是发给前端的命令名，前端 `MENU_COMMANDS` 与它一一对应
pub struct Item {
    pub id: &'static str,
    pub text: &'static str,
    pub accelerator: Option<&'static str>,
}

const fn item(id: &'static str, text: &'static str, accelerator: Option<&'static str>) -> Item {
    Item {
        id,
        text,
        accelerator,
    }
}

pub const ABOUT: Item = item("about", "关于 Sophia", None);
pub const CHECK_UPDATE: Item = item("check-update", "检查更新…", None);
pub const SETTINGS: Item = item("settings", "设置…", Some("CmdOrCtrl+,"));
pub const ADD_PROJECT: Item = item("add-project", "添加项目…", None);
pub const ADD_SOURCE: Item = item("add-source", "添加来源…", None);
pub const UNDO: Item = item("undo", "撤销", Some("CmdOrCtrl+Z"));
pub const SELECT_ALL: Item = item("select-all", "全选", Some("CmdOrCtrl+A"));
pub const FILTER: Item = item("filter", "筛选", Some("CmdOrCtrl+F"));
pub const BACK: Item = item("back", "返回", Some("CmdOrCtrl+["));

/// 全部自定义项：收到菜单事件时只认这张表里的 id（右键菜单等别处的项不转发）
pub const ITEMS: [&Item; 9] = [
    &ABOUT,
    &CHECK_UPDATE,
    &SETTINGS,
    &ADD_PROJECT,
    &ADD_SOURCE,
    &UNDO,
    &SELECT_ALL,
    &FILTER,
    &BACK,
];

/// 位置页的一个 domain（页签）：与前端 `src/shell/domains.ts` 读同一个 JSON
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Domain {
    pub id: String,
    /// 页签上的字，原样小写写（`skills` `mcp`）；页签经 `Cap` 显示为大写，菜单项在 `tab_item` 里转大写
    pub label: String,
}

const DOMAINS_JSON: &str = include_str!("../../src/shell/locationDomains.json");

/// domain 表；文件是随代码一起提交的常量，读不出来就是构建错误，测试里钉住
pub fn domains() -> Vec<Domain> {
    serde_json::from_str(DOMAINS_JSON).expect("src/shell/locationDomains.json 格式不对")
}

/// 第 i 个 domain 的菜单项：命令 `tab-<id>`，名字＝页签上显示的字（大写，`SKILLS` `MCP`），
/// 快捷键 ⌘(i+1)（第 10 项起不给）。原生菜单用系统字体、没有 `Cap`，所以在这里直接转大写——
/// 与前端 `domainMenuItems` 同一条规则（DESIGN「应用菜单」：名字与界面上同一个命令同名）
pub fn tab_item(i: usize, d: &Domain) -> (String, String, Option<String>) {
    let accelerator = (i < 9).then(|| format!("CmdOrCtrl+{}", i + 1));
    (format!("tab-{}", d.id), d.label.to_uppercase(), accelerator)
}

/// 菜单事件的 id 是不是应用菜单的自定义项；是就返回要发给前端的命令名
pub fn command_for(id: &str) -> Option<String> {
    if let Some(i) = ITEMS.iter().find(|i| i.id == id) {
        return Some(i.id.to_string());
    }
    let domain = id.strip_prefix("tab-")?;
    domains()
        .iter()
        .any(|d| d.id == domain)
        .then(|| id.to_string())
}

/// 前端报上来的界面状态：这三项灰不灰
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MenuState {
    /// 有可撤销的操作（或输入框聚焦、可以撤销文字）
    pub undo: bool,
    /// 在位置页
    pub filter: bool,
    /// 在添加来源页
    pub back: bool,
}

/// 启用状态跟着界面走的三项，建菜单时留下句柄
pub struct MenuHandles<R: Runtime> {
    undo: MenuItem<R>,
    filter: MenuItem<R>,
    back: MenuItem<R>,
    window: Submenu<R>,
}

fn custom<R: Runtime>(app: &AppHandle<R>, i: &Item) -> tauri::Result<MenuItem<R>> {
    let mut b = MenuItemBuilder::with_id(i.id, i.text);
    if let Some(acc) = i.accelerator {
        b = b.accelerator(acc);
    }
    b.build(app)
}

/// 建整套菜单，并把要跟着界面开关的项交给 app 管理。三项起始都是灰的：
/// 前端第一次报状态之前，哪一项都还做不了
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let undo = custom(app, &UNDO)?;
    let filter = custom(app, &FILTER)?;
    let back = custom(app, &BACK)?;
    for it in [&undo, &filter, &back] {
        it.set_enabled(false)?;
    }

    let sophia = SubmenuBuilder::new(app, "Sophia")
        .item(&custom(app, &ABOUT)?)
        .item(&custom(app, &CHECK_UPDATE)?)
        .separator()
        .item(&custom(app, &SETTINGS)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("隐藏 Sophia"))?)
        .item(&PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?)
        .item(&PredefinedMenuItem::show_all(app, Some("全部显示"))?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("退出 Sophia"))?)
        .build()?;
    let file = SubmenuBuilder::new(app, "文件")
        .item(&custom(app, &ADD_PROJECT)?)
        .item(&custom(app, &ADD_SOURCE)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, Some("关闭窗口"))?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "编辑")
        .item(&undo)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some("剪切"))?)
        .item(&PredefinedMenuItem::copy(app, Some("拷贝"))?)
        .item(&PredefinedMenuItem::paste(app, Some("粘贴"))?)
        .item(&custom(app, &SELECT_ALL)?)
        .separator()
        .item(&filter)
        .build()?;
    let mut view = SubmenuBuilder::new(app, "显示");
    for (i, d) in domains().iter().enumerate() {
        let (id, text, accelerator) = tab_item(i, d);
        let mut b = MenuItemBuilder::with_id(id, text);
        if let Some(acc) = accelerator {
            b = b.accelerator(acc);
        }
        view = view.item(&b.build(app)?);
    }
    let view = view.separator().item(&back).build()?;
    let window = SubmenuBuilder::new(app, "窗口")
        .item(&PredefinedMenuItem::minimize(app, Some("最小化"))?)
        .item(&PredefinedMenuItem::maximize(app, Some("缩放"))?)
        .separator()
        .item(&PredefinedMenuItem::bring_all_to_front(
            app,
            Some("前置全部窗口"),
        )?)
        .build()?;
    // 不做「帮助」菜单：没有帮助内容，空菜单是噪音
    let menu = Menu::with_items(app, &[&sophia, &file, &edit, &view, &window])?;
    app.manage(MenuHandles {
        undo,
        filter,
        back,
        window,
    });
    Ok(menu)
}

/// 菜单已经装到应用上之后调：「窗口」菜单登记成系统的窗口菜单（系统往里列出打开的窗口）
pub fn after_setup<R: Runtime>(app: &AppHandle<R>) {
    if let Some(h) = app.try_state::<MenuHandles<R>>() {
        let _ = h.window.set_as_windows_menu_for_nsapp();
    }
}

/// 自定义项被按下：把主窗口带到前面（窗口可能藏在菜单栏里），再把命令发给它
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let Some(command) = command_for(event.id().as_ref()) else {
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit_to("main", EVENT, command);
}

/// 前端报界面状态：三项跟着开关。没装菜单（非 macOS）时什么都不做
#[tauri::command]
pub fn set_menu_state(app: AppHandle, state: MenuState) {
    if let Some(h) = app.try_state::<MenuHandles<tauri::Wry>>() {
        let _ = h.undo.set_enabled(state.undo);
        let _ = h.filter.set_enabled(state.filter);
        let _ = h.back.set_enabled(state.back);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 自定义项的_id_互不相同且都认得出() {
        let mut ids: Vec<&str> = ITEMS.iter().map(|i| i.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), ITEMS.len());
        for i in ITEMS {
            assert_eq!(command_for(i.id).as_deref(), Some(i.id));
        }
        assert_eq!(command_for("tab-skills").as_deref(), Some("tab-skills"));
        assert_eq!(command_for("tab-mcp").as_deref(), Some("tab-mcp"));
        assert_eq!(command_for("tab-nope"), None);
        assert_eq!(command_for("quit"), None);
        assert_eq!(command_for(""), None);
    }

    #[test]
    fn 快捷键按规范() {
        let acc = |i: &Item| i.accelerator;
        assert_eq!(acc(&SETTINGS), Some("CmdOrCtrl+,"));
        assert_eq!(acc(&FILTER), Some("CmdOrCtrl+F"));
        assert_eq!(acc(&UNDO), Some("CmdOrCtrl+Z"));
        assert_eq!(acc(&SELECT_ALL), Some("CmdOrCtrl+A"));
        assert_eq!(acc(&BACK), Some("CmdOrCtrl+["));
        // 要再操作一步的项带省略号
        for i in [&SETTINGS, &CHECK_UPDATE, &ADD_PROJECT, &ADD_SOURCE] {
            assert!(i.text.ends_with('…'), "{} 应带 …", i.text);
        }
    }

    #[test]
    fn 显示菜单的页签项由_domain_表生成_第_n_项是_cmd_n() {
        let ds = domains();
        assert_eq!(ds[0].id, "skills");
        assert_eq!(ds[1].id, "mcp");
        let items: Vec<_> = ds.iter().enumerate().map(|(i, d)| tab_item(i, d)).collect();
        assert_eq!(
            items[0],
            (
                "tab-skills".into(),
                "SKILLS".into(),
                Some("CmdOrCtrl+1".into())
            )
        );
        // 菜单项与页签显示的字同写大写
        assert_eq!(items[1].1, "MCP");
        assert_eq!(items[1].2.as_deref(), Some("CmdOrCtrl+2"));
        // 表里加第三项（以后的 sessions）：自动得到 ⌘3
        let third = Domain {
            id: "sessions".into(),
            label: "sessions".into(),
        };
        assert_eq!(
            tab_item(2, &third),
            (
                "tab-sessions".into(),
                "SESSIONS".into(),
                Some("CmdOrCtrl+3".into())
            )
        );
        assert_eq!(tab_item(9, &third).2, None);
    }

    #[test]
    fn 界面状态按驼峰读() {
        let s: MenuState =
            serde_json::from_str(r#"{"undo":true,"filter":false,"back":true}"#).unwrap();
        assert_eq!(
            s,
            MenuState {
                undo: true,
                filter: false,
                back: true
            }
        );
    }
}
