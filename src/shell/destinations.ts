/// 目的地表（spec 2026-09-26-object-first-navigation R1 R2）：侧栏平铺的项、应用菜单「显示」里的项与快捷键、
/// 菜单命令 `dest-<id>` 都由它生成。**唯一来源是 `destinations.json`**：`src-tauri/src/menu.rs` 用 include_str! 读同一个文件。
///
/// 快捷键按 id 写死在表里，不按先后推算：以后在 MCP 后插「会话」（⌘5），已有项的键不变（⌘4 留给用量）。
/// `设置` 不进表：它贴底、走 ⌘, 与 `settings` 命令。
/// 拉丁结构词原样小写写（`skills` `mcp`），侧栏经 `Cap`、菜单经 `toUpperCase` 显示为大写；中文词（`模型`）不受影响。

import table from "./destinations.json" with { type: "json" };
import type { Destination } from "./nav.ts";

export type TableDestination = Exclude<Destination, "settings">;

export interface DestinationEntry {
  id: string;
  label: string;
  /// 应用菜单的快捷键（`CmdOrCtrl+N`）
  shortcut: string;
  /// 页面头有没有范围滑槽与项目筛选片（按位置分的东西）
  scoped: boolean;
}

export const DESTINATIONS: ReadonlyArray<DestinationEntry> = table;

/// 菜单命令名：`dest-<id>`
export const destCommand = (id: string): string => `dest-${id}`;

/// 菜单命令名反查目的地；不是目的地命令返回 null
export function destinationOfCommand(command: string): TableDestination | null {
  const id = command.startsWith("dest-") ? command.slice("dest-".length) : null;
  return id !== null && DESTINATIONS.some((d) => d.id === id) ? (id as TableDestination) : null;
}

/// 这一页按不按位置分（有没有范围滑槽）
export const isScoped = (d: Destination): boolean =>
  DESTINATIONS.some((e) => e.id === d && e.scoped);

/// 侧栏与菜单上的名字：拉丁结构词大写，中文原样（原生菜单没有 `Cap`，直接转大写）
export const destinationMenuLabel = (d: DestinationEntry): string => d.label.toUpperCase();

/// 应用菜单「显示」里的目的地项（与 `src-tauri/src/menu.rs` 的 `dest_item` 同一条规则）
export function destinationMenuItems(
  entries: ReadonlyArray<DestinationEntry> = DESTINATIONS,
): Array<{ command: string; label: string; accelerator: string }> {
  return entries.map((d) => ({
    command: destCommand(d.id),
    label: destinationMenuLabel(d),
    accelerator: d.shortcut,
  }));
}
