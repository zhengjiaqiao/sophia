/// 应用菜单的命令怎么走（DESIGN「应用菜单」，裁决 D15 / D16）。纯逻辑，tests/shell-menu.test.ts 直接测。
///
/// 菜单栏按下一项，Rust 把项的 id 作为 `menu-command` 事件发给主窗口（`src-tauri/src/menu.rs`）；
/// 这里把它翻译成「去哪」+「交给谁」：
/// - 壳自己做的：换目的地（SKILLS / MCP / 模型 / 设置）
/// - 设置页做的：停在「关于」、开始检查更新
/// - 壳当场做的：添加项目（弹系统文件夹选择器，不换页）
/// - 输入框里的文字：撤销 / 全选作用于正在输入的那个框
/// - SKILLS / MCP 页做的：筛选、撤销、全选行、添加来源、切换项目、返回——经 `menuBus` 的页面命令发给当前页
///
/// 每一项都是界面上已有入口的另一条路，行为与那个入口完全相同，不新增能力。

import { goDestination, goFace, type Nav } from "./nav.ts";
import type { Proceed } from "./leaveGuard.ts";
import { destCommand, destinationOfCommand, DESTINATIONS, isScoped } from "./destinations.ts";

/// 与 `src-tauri/src/menu.rs` 的 `ITEMS` 一一对应（目的地项不在这里：由目的地表生成，见 `DEST_COMMANDS`）
export const FIXED_COMMANDS = [
  "about",
  "check-update",
  "settings",
  "add-source",
  "add-project",
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
  /// 弹系统文件夹选择器，选的文件夹加成项目（同设置「生效范围」的 `+ 项目`）
  addProject?: true;
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
    // 在 SKILLS 时加到当前位置；在别处（MCP 不再添加来源，spec 2026-09-30-mcp-config-scope R5）先到 SKILLS。
    // 来源只在 `我的` 里管：停在 `发现` 时先回到 `我的`
    case "add-source":
      return {
        nav: goFace(nav.destination === "skills" ? nav : goDestination(nav, "skills"), "mine"),
        page: "add-source",
      };
    // 设置「生效范围」的 `+ 项目` 的另一条路：在哪一页都不换页，直接弹文件夹选择器
    case "add-project":
      return { nav, addProject: true };
    // 菜单里只在 SKILLS / MCP 时亮着（menuState）；`更多` 项目列表在 `我的` 的筛选行上，停在 `发现` 时先回来
    case "switch-project":
      return { nav: goFace(nav, "mine"), page: "switch-project" };
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

/// 模态小窗（反馈小窗）开着时：只留作用于输入框的撤销 / 全选（小窗里的输入框要用），换目的地、交给页面、
/// 停在「关于」的都拿掉——不换页、不把焦点放到遮罩后面去
export function routeUnderModal(route: MenuRoute, nav: Nav): MenuRoute {
  return route.text ? { nav, text: route.text } : { nav };
}

/// 填短表单的弹窗（`FormDialog`：反馈小窗、添加 / 编辑模型提供商）开着时菜单命令怎么走——一处判断，不分弹窗种类
/// （走查 2026-10-08）：弹窗里有没保存的改动（页面登记了离开前询问，`guarded`）照常走，换页先经那一问、问完接着走；
/// 没有改动同 `routeUnderModal`，不换页、不交给页面
export function routeWithDialog(
  route: MenuRoute,
  nav: Nav,
  dialog: { open: boolean; guarded: boolean },
): MenuRoute {
  if (!dialog.open || dialog.guarded) return route;
  return routeUnderModal(route, nav);
}

/// 收到退出请求（应用菜单「退出 Sophia」⌘Q）时填短表单的弹窗怎么办——同 `routeWithDialog` 一处判断、不分弹窗种类
/// （产品负责人 2026-10-08：弹窗留着时壳 inert，退出确认框点不到）。退出确认框在应用壳里，弹窗得先收起：
/// 没有改动当场收起（反馈小窗发送中也直接放弃）再走退出；有没保存的改动先经离开前那一问（`ask`，弹窗里
/// `模型提供商还没保存` · `丢弃` / `保存`），答了才收起、走退出，没答就留在弹窗里、不退出。
/// 问出来后用户没答、继续在弹窗里编辑：交给 `ask` 的那一下带 `cancel`，弹窗调它就取消这次待定的退出，
/// 之后保存不再接着退出（意外退出比多点一次 ⌘Q 糟得多）；换页那条路不带，语义不变
export function quitWithDialog(
  dialog: { open: boolean; guarded: boolean },
  steps: { dismiss: () => void; ask: (proceed: Proceed) => void; quit: () => void },
) {
  let live = true;
  const go: Proceed = () => {
    if (!live) return;
    if (dialog.open) steps.dismiss();
    steps.quit();
  };
  go.cancel = () => {
    live = false;
  };
  if (dialog.open && dialog.guarded) steps.ask(go);
  else go();
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
  /// 有没有项目：一个都没有时筛选行不画位置胶囊，「切换项目…」也灰着
  hasProjects = true,
): MenuState {
  return {
    // 输入框里总能撤销文字；否则看当前页有没有可撤销的操作
    undo: editing || flags.undo,
    filter: isScoped(nav.destination),
    back: flags.back,
    switchProject: isScoped(nav.destination) && hasProjects,
  };
}
