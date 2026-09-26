//! 原生应用菜单（DESIGN「应用菜单」，裁决 D15）：`Sophia` `文件` `编辑` `显示` `窗口` 五个菜单。
//!
//! 每一项都是界面上已有入口的另一条路，不新增能力。菜单只管「按了哪一项」：自定义项一律把
//! 项的 id 原样作为 `menu-command` 事件发给主窗口，前端按 id 路由（`src/shell/menuCommands.ts`）；
//! 剪切 / 拷贝 / 粘贴与隐藏、退出、窗口这些系统标准项用预置项，由系统直接处理。
//!
//! 「显示」里的目的地项由目的地表生成（`src/shell/destinations.json`，与前端同一个文件，
//! spec 2026-09-26-object-first-navigation R2）：命令名 `dest-<id>`，快捷键写在表里、不按先后推算。
//! 加一个目的地不用改这里。
//!
//! 做不了的项灰着、不隐藏：`撤销`（没有可撤销的操作）、`筛选` 与 `切换项目…`（不在 SKILLS / MCP）、
//! `返回`（不在添加来源页）由前端按界面状态调 `set_menu_state` 开关。
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
pub const ADD_SOURCE: Item = item("add-source", "添加来源…", None);
pub const SWITCH_PROJECT: Item = item("switch-project", "切换项目…", Some("CmdOrCtrl+P"));
pub const UNDO: Item = item("undo", "撤销", Some("CmdOrCtrl+Z"));
pub const SELECT_ALL: Item = item("select-all", "全选", Some("CmdOrCtrl+A"));
pub const FILTER: Item = item("filter", "筛选", Some("CmdOrCtrl+F"));
pub const BACK: Item = item("back", "返回", Some("CmdOrCtrl+["));

/// 全部自定义项：收到菜单事件时只认这张表里的 id（右键菜单等别处的项不转发）
pub const ITEMS: [&Item; 9] = [
    &ABOUT,
    &CHECK_UPDATE,
    &SETTINGS,
    &ADD_SOURCE,
    &SWITCH_PROJECT,
    &UNDO,
    &SELECT_ALL,
    &FILTER,
    &BACK,
];

/// 侧栏的一个目的地：与前端 `src/shell/destinations.ts` 读同一个 JSON
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Destination {
    pub id: String,
    /// 侧栏上的字，拉丁结构词原样小写写（`skills` `mcp`），中文原样（`模型`）；菜单项在 `dest_item` 里转大写
    pub label: String,
    /// 快捷键（`CmdOrCtrl+N`），按 id 写死，不随先后变
    pub shortcut: String,
    /// 页面头有没有范围滑槽（前端用；菜单不用）
    pub scoped: bool,
}

const DESTINATIONS_JSON: &str = include_str!("../../src/shell/destinations.json");

/// 目的地表；文件是随代码一起提交的常量，读不出来就是构建错误，测试里钉住
pub fn destinations() -> Vec<Destination> {
    serde_json::from_str(DESTINATIONS_JSON).expect("src/shell/destinations.json 格式不对")
}

/// 一个目的地的菜单项：命令 `dest-<id>`，名字＝侧栏上显示的字（拉丁词大写，`SKILLS` `MCP` `模型`），
/// 快捷键取表里的。原生菜单用系统字体、没有 `Cap`，所以在这里直接转大写——
/// 与前端 `destinationMenuItems` 同一条规则（DESIGN「应用菜单」：名字与界面上同一个命令同名）
pub fn dest_item(d: &Destination) -> (String, String, String) {
    (
        format!("dest-{}", d.id),
        d.label.to_uppercase(),
        d.shortcut.clone(),
    )
}

/// 菜单事件的 id 是不是应用菜单的自定义项；是就返回要发给前端的命令名
pub fn command_for(id: &str) -> Option<String> {
    if let Some(i) = ITEMS.iter().find(|i| i.id == id) {
        return Some(i.id.to_string());
    }
    let dest = id.strip_prefix("dest-")?;
    destinations()
        .iter()
        .any(|d| d.id == dest)
        .then(|| id.to_string())
}

/// 前端报上来的界面状态：这几项灰不灰
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MenuState {
    /// 有可撤销的操作（或输入框聚焦、可以撤销文字）
    pub undo: bool,
    /// 在 SKILLS / MCP
    pub filter: bool,
    /// 在添加来源页
    pub back: bool,
    /// 在 SKILLS / MCP（有项目筛选片的页）
    #[serde(default)]
    pub switch_project: bool,
}

/// 启用状态跟着界面走的几项，建菜单时留下句柄
pub struct MenuHandles<R: Runtime> {
    undo: MenuItem<R>,
    filter: MenuItem<R>,
    back: MenuItem<R>,
    switch_project: MenuItem<R>,
    window: Submenu<R>,
}

fn custom<R: Runtime>(app: &AppHandle<R>, i: &Item) -> tauri::Result<MenuItem<R>> {
    let mut b = MenuItemBuilder::with_id(i.id, i.text);
    if let Some(acc) = i.accelerator {
        b = b.accelerator(acc);
    }
    b.build(app)
}

/// 建整套菜单，并把要跟着界面开关的项交给 app 管理。这几项起始都是灰的：
/// 前端第一次报状态之前，哪一项都还做不了
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let undo = custom(app, &UNDO)?;
    let filter = custom(app, &FILTER)?;
    let back = custom(app, &BACK)?;
    let switch_project = custom(app, &SWITCH_PROJECT)?;
    for it in [&undo, &filter, &back, &switch_project] {
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
    for d in destinations() {
        let (id, text, accelerator) = dest_item(&d);
        view = view.item(
            &MenuItemBuilder::with_id(id, text)
                .accelerator(accelerator)
                .build(app)?,
        );
    }
    let view = view.separator().item(&switch_project).item(&back).build()?;
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
        switch_project,
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

/// 前端报界面状态：这几项跟着开关。没装菜单（非 macOS）时什么都不做
#[tauri::command]
pub fn set_menu_state(app: AppHandle, state: MenuState) {
    if let Some(h) = app.try_state::<MenuHandles<tauri::Wry>>() {
        let _ = h.undo.set_enabled(state.undo);
        let _ = h.filter.set_enabled(state.filter);
        let _ = h.back.set_enabled(state.back);
        let _ = h.switch_project.set_enabled(state.switch_project);
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
        assert_eq!(command_for("dest-skills").as_deref(), Some("dest-skills"));
        assert_eq!(command_for("dest-mcp").as_deref(), Some("dest-mcp"));
        assert_eq!(command_for("dest-models").as_deref(), Some("dest-models"));
        assert_eq!(command_for("dest-usage"), None);
        assert_eq!(command_for("tab-skills"), None);
        assert_eq!(command_for("add-project"), None);
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
        assert_eq!(acc(&SWITCH_PROJECT), Some("CmdOrCtrl+P"));
        // 要再操作一步的项带省略号
        for i in [&SETTINGS, &CHECK_UPDATE, &ADD_SOURCE, &SWITCH_PROJECT] {
            assert!(i.text.ends_with('…'), "{} 应带 …", i.text);
        }
    }

    #[test]
    fn 显示菜单的目的地项由目的地表生成_快捷键按表() {
        let items: Vec<_> = destinations().iter().map(dest_item).collect();
        assert_eq!(
            items,
            vec![
                ("dest-skills".into(), "SKILLS".into(), "CmdOrCtrl+1".into()),
                ("dest-mcp".into(), "MCP".into(), "CmdOrCtrl+2".into()),
                ("dest-models".into(), "模型".into(), "CmdOrCtrl+3".into()),
            ]
        );
        // 以后插一项（会话 ⌘5）：用它自己写的键，不按先后推算
        let sessions = Destination {
            id: "sessions".into(),
            label: "sessions".into(),
            shortcut: "CmdOrCtrl+5".into(),
            scoped: true,
        };
        assert_eq!(dest_item(&sessions).2, "CmdOrCtrl+5");
    }

    #[test]
    fn 界面状态按驼峰读() {
        let s: MenuState = serde_json::from_str(
            r#"{"undo":true,"filter":false,"back":true,"switchProject":true}"#,
        )
        .unwrap();
        assert_eq!(
            s,
            MenuState {
                undo: true,
                filter: false,
                back: true,
                switch_project: true
            }
        );
    }
}
