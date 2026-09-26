/// 应用菜单的命令怎么走（DESIGN「应用菜单」，裁决 D15 / D16）。纯逻辑，tests/shell-menu.test.ts 直接测。
///
/// 菜单栏按下一项，Rust 把项的 id 作为 `menu-command` 事件发给主窗口（`src-tauri/src/menu.rs`）；
/// 这里把它翻译成「去哪」+「交给谁」：
/// - 壳自己做的：换目的地（SKILLS / MCP / 模型 / 设置）
/// - 设置页做的：停在「关于」、开始检查更新
/// - 输入框里的文字：撤销 / 全选作用于正在输入的那个框
/// - SKILLS / MCP 页做的：筛选、撤销、全选行、添加来源、切换项目、返回——经 `menuBus` 的页面命令发给当前页
///
/// 每一项都是界面上已有入口的另一条路，行为与那个入口完全相同，不新增能力。

import { goDestination, type Nav } from "./nav.ts";
import { destCommand, destinationOfCommand, DESTINATIONS, isScoped } from "./destinations.ts";

/// 与 `src-tauri/src/menu.rs` 的 `ITEMS` 一一对应（目的地项不在这里：由目的地表生成，见 `DEST_COMMANDS`）
export const FIXED_COMMANDS = [
  "about",
  "check-update",
  "settings",
  "add-source",
  "switch-project",
  "undo",
  "select-all",
  "filter",
  "back",
] as const;
type FixedCommand = (typeof FIXED_COMMANDS)[number];
/// 「显示」菜单里的目的地项：`dest-<id>`，快捷键写在目的地表里
export type DestCommand = `dest-${string}`;
export type MenuCommand = FixedCommand | DestCommand;

export const DEST_COMMANDS: ReadonlyArray<DestCommand> = DESTINATIONS.map(
  (d) => destCommand(d.id) as DestCommand,
);
export const MENU_COMMANDS: ReadonlyArray<MenuCommand> = [...FIXED_COMMANDS, ...DEST_COMMANDS];

/// 交给当前页的命令（各页用 `usePageCommand` 接）
export type PageCommand =
  "add-source" | "switch-project" | "undo" | "select-all" | "filter" | "back";

export interface MenuRoute {
  /// 按下之后停在哪（不换目的地时就是原来的同一个对象）
  nav: Nav;
  /// 设置页：停在「关于」；`check` 为真时同时开始检查（同点 `检查更新`）
  settings?: { check: boolean };
  /// 作用于正在输入的框
  text?: "undo" | "select-all";
  /// 交给当前页
  page?: PageCommand;
}

export const isMenuCommand = (s: unknown): s is MenuCommand =>
  typeof s === "string" && (MENU_COMMANDS as ReadonlyArray<string>).includes(s);

/// `editing`：焦点此刻在输入框里（撤销 / 全选作用于文字，不作用于行）
export function routeMenuCommand(command: MenuCommand, nav: Nav, editing: boolean): MenuRoute {
  switch (command) {
    case "settings":
      return { nav: goDestination(nav, "settings") };
    // 版本号只在设置「关于」一处，不另开系统关于面板
    case "about":
      return { nav: goDestination(nav, "settings"), settings: { check: false } };
    case "check-update":
      return { nav: goDestination(nav, "settings"), settings: { check: true } };
    // 在 SKILLS / MCP 时加到当前范围（多个位置时由页面先问加到哪）；在别处先到 SKILLS
    case "add-source":
      return {
        nav: isScoped(nav.destination) ? nav : goDestination(nav, "skills"),
        page: "add-source",
      };
    // 菜单里只在 SKILLS / MCP 时亮着（menuState）
    case "switch-project":
      return { nav, page: "switch-project" };
    case "undo":
      return editing ? { nav, text: "undo" } : { nav, page: "undo" };
    // 输入框聚焦时全选文字，否则勾选当前筛选的全部行
    case "select-all":
      return editing ? { nav, text: "select-all" } : { nav, page: "select-all" };
    case "filter":
      return { nav, page: "filter" };
    case "back":
      return { nav, page: "back" };
  }
  // 目的地项：换目的地，范围不变
  const destination = destinationOfCommand(command);
  return destination === null ? { nav } : { nav: goDestination(nav, destination) };
}

/// 菜单里跟着界面灰 / 亮的几项（`set_menu_state`）
export interface MenuState {
  undo: boolean;
  filter: boolean;
  back: boolean;
  switchProject: boolean;
}

export function menuState(
  nav: Nav,
  flags: { undo: boolean; back: boolean },
  editing: boolean,
): MenuState {
  return {
    // 输入框里总能撤销文字；否则看当前页有没有可撤销的操作
    undo: editing || flags.undo,
    filter: isScoped(nav.destination),
    back: flags.back,
    switchProject: isScoped(nav.destination),
  };
}
