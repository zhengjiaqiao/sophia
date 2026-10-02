/// 右键菜单（DESIGN「右键菜单」，裁决 D18）：原生菜单（`@tauri-apps/api/menu` 的 `Menu.popup`），
/// 不画网页浮层。**只作加速器**：每一项在界面上都另有入口，点了走与那个入口同一条命令、
/// 同样的确认与反馈，不新增能力。
///
/// - 不适用的项不出（与菜单栏相反）：调用方只把此刻能做的项放进来；一项都没有就不弹、也不拦默认行为。
/// - 要确认的项名字后带 `…`，点了走界面上同一个锚定确认，锚在被右键的那一行 / 那一片上。
/// - 右键不改变勾选；菜单开着时被右键的那一行出 `surface` 行带（`onOpen` / `onClose` 里自己加减），
///   菜单关掉即消失。
/// - 不在 Tauri 里（vite 预览、node:test）时安全降级为无操作：不弹、不报错。
///
/// 用法：
///
///   <li onContextMenu={contextMenuHandler(() => manual ? [{ label: "从侧栏移除", run: remove }] : [])}>
///
/// 或在事件处理里直接 `void popupContextMenu(items, { onOpen, onClose })`。

import type { MouseEvent as ReactMouseEvent } from "react";

export type ContextMenuItem =
  | {
      label: string;
      run: () => void;
      /// 给了就灰着（右键菜单通常直接不放这一项，只在确有必要时灰）
      disabled?: boolean;
    }
  | "separator";

export interface ContextMenuHooks {
  /// 菜单弹出之前：给被右键的那一行加 `surface` 行带
  onOpen?: () => void;
  /// 菜单关掉之后（选了一项或点了别处）：摘掉行带
  onClose?: () => void;
}

/// 此刻能不能弹原生菜单（在不在 Tauri 里）
export function canPopup(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/// 前后的分隔线、连着的两条分隔线都去掉：条件项被拿掉之后不会留下空段
export function tidyItems(items: ReadonlyArray<ContextMenuItem>): ContextMenuItem[] {
  const out: ContextMenuItem[] = [];
  for (const item of items) {
    if (item === "separator" && (out.length === 0 || out[out.length - 1] === "separator")) continue;
    out.push(item);
  }
  while (out[out.length - 1] === "separator") out.pop();
  return out;
}

/// 在指针处弹出原生菜单。没有可做的项、或不在 Tauri 里，返回 false、什么都不做。
/// 选中的那一项在菜单关掉之后才执行（先摘掉行带，再走确认，顺序与点界面入口一致）
export async function popupContextMenu(
  items: ReadonlyArray<ContextMenuItem>,
  hooks: ContextMenuHooks = {},
): Promise<boolean> {
  const list = tidyItems(items);
  if (list.length === 0 || !canPopup()) return false;
  const { Menu, MenuItem, PredefinedMenuItem } = await import("@tauri-apps/api/menu");
  let chosen: (() => void) | null = null;
  const built = await Promise.all(
    list.map((item) =>
      item === "separator"
        ? PredefinedMenuItem.new({ item: "Separator" })
        : MenuItem.new({
            text: item.label,
            enabled: !item.disabled,
            action: () => {
              chosen = item.run;
            },
          }),
    ),
  );
  const menu = await Menu.new({ items: built });
  hooks.onOpen?.();
  try {
    // macOS 上 popup 是模态的：菜单关掉才返回
    await menu.popup();
  } finally {
    hooks.onClose?.();
    void menu.close().catch(() => undefined);
  }
  // action 回调经通道送回，可能比 popup 的返回晚一拍
  if (chosen === null) await new Promise((r) => setTimeout(r, 0));
  (chosen as (() => void) | null)?.();
  return true;
}

/// React 的 onContextMenu：`items` 在右键那一刻才取（拿到最新状态）。有项、能弹才拦下默认菜单
export function contextMenuHandler(
  items: () => ReadonlyArray<ContextMenuItem>,
  hooks?: ContextMenuHooks,
) {
  return (event: ReactMouseEvent) => {
    const list = tidyItems(items());
    // 不在 Tauri 里时不拦：浏览器自己的菜单照常出，而不是右键没反应
    if (list.length === 0 || !canPopup()) return;
    event.preventDefault();
    event.stopPropagation();
    void popupContextMenu(list, hooks);
  };
}
