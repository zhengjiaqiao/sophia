/// 应用菜单的命令怎么走（DESIGN「应用菜单」，裁决 D15 / D16）。纯逻辑，tests/shell-menu.test.ts 直接测。
///
/// 菜单栏按下一项，Rust 把项的 id 作为 `menu-command` 事件发给主窗口（`src-tauri/src/menu.rs`）；
/// 这里把它翻译成「去哪」+「交给谁」：
/// - 壳自己做的：换目的地（设置、Codex、位置 + 页签）、添加项目（与侧栏 `+ 项目` 同一条路）
/// - 设置页做的：停在「关于」、开始检查更新
/// - 输入框里的文字：撤销 / 全选作用于正在输入的那个框
/// - 位置页做的：筛选、撤销、全选行、添加来源、返回——经 `menuBus` 的页面命令发给当前页
///
/// 每一项都是界面上已有入口的另一条路，行为与那个入口完全相同，不新增能力。

import { goSettings, goTab, type Place } from "./place.ts";
import { domainOfCommand, LOCATION_DOMAINS, tabCommand } from "./domains.ts";

/// 与 `src-tauri/src/menu.rs` 的 `ITEMS` 一一对应（页签项不在这里：由 domain 表生成，见 `TAB_COMMANDS`）
export const FIXED_COMMANDS = [
  "about",
  "check-update",
  "settings",
  "add-project",
  "add-source",
  "undo",
  "select-all",
  "filter",
  "back",
] as const;
type FixedCommand = (typeof FIXED_COMMANDS)[number];
/// 「显示」菜单里的页签项：`tab-<domain id>`，按 domain 表的先后，第 N 项 ⌘N
export type TabCommand = `tab-${string}`;
export type MenuCommand = FixedCommand | TabCommand;

export const TAB_COMMANDS: ReadonlyArray<TabCommand> = LOCATION_DOMAINS.map(
  (d) => tabCommand(d.id) as TabCommand,
);
export const MENU_COMMANDS: ReadonlyArray<MenuCommand> = [...FIXED_COMMANDS, ...TAB_COMMANDS];

/// 交给当前页的命令（第二波各页用 `usePageCommand` 接）
export type PageCommand = "add-source" | "undo" | "select-all" | "filter" | "back";

export interface MenuRoute {
  /// 按下之后停在哪（不换目的地时就是原来的）
  place: Place;
  /// 壳自己要做的事
  shell?: "add-project";
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
export function routeMenuCommand(command: MenuCommand, place: Place, editing: boolean): MenuRoute {
  switch (command) {
    case "settings":
      return { place: goSettings(place) };
    // 版本号只在设置「关于」一处，不另开系统关于面板
    case "about":
      return { place: goSettings(place), settings: { check: false } };
    case "check-update":
      return { place: goSettings(place), settings: { check: true } };
    case "add-project":
      return { place, shell: "add-project" };
    // 加到当前位置；不在位置页时加到上次停的位置
    case "add-source":
      return { place: { ...place, view: "location" }, page: "add-source" };
    case "undo":
      return editing ? { place, text: "undo" } : { place, page: "undo" };
    // 输入框聚焦时全选文字，否则勾选当前筛选的全部行
    case "select-all":
      return editing ? { place, text: "select-all" } : { place, page: "select-all" };
    case "filter":
      return { place, page: "filter" };
    case "back":
      return { place, page: "back" };
  }
  // 页签项：不在位置页时先回到上次停的位置
  const domain = domainOfCommand(command);
  return domain === null ? { place } : { place: goTab(place, domain) };
}

/// 菜单里跟着界面灰 / 亮的三项（`set_menu_state`）
export interface MenuState {
  undo: boolean;
  filter: boolean;
  back: boolean;
}

export function menuState(
  place: Place,
  flags: { undo: boolean; back: boolean },
  editing: boolean,
): MenuState {
  return {
    // 输入框里总能撤销文字；否则看当前页有没有可撤销的操作
    undo: editing || flags.undo,
    filter: place.view === "location",
    back: flags.back,
  };
}
