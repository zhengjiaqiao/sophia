/// 位置页的 domain（页签）表（DESIGN「位置页：skills ｜ mcp」；扩展预留：以后加第三个「会话」）。
///
/// **唯一来源是 `locationDomains.json`**：位置页页面头的页签、应用菜单「显示」里的项与快捷键
/// （第 N 项＝⌘N，`src-tauri/src/menu.rs` 用 include_str! 读同一个文件）、菜单命令 `tab-<id>`
/// 都由它生成。落点记忆存 domain 的 id，不存序号——表里插一项，记着的落点不会错位。
///
/// 加一个 domain：往 JSON 里加一行 `{ id, label }`（label 是页签上的字，原样小写写，界面上经 `Cap` 显示为大写），
/// 再在 App.tsx 的 `LOCATION_PAGES` 里给这个 id 配一页。

import table from "./locationDomains.json" with { type: "json" };

export interface LocationDomain {
  /// 稳定的标识：落点记忆、菜单命令 `tab-<id>` 都用它
  id: string;
  /// 页签上的字，原样写（界面经 `Cap`、菜单经 `domainMenuLabel` 显示为大写）
  label: string;
}

export const LOCATION_DOMAINS: ReadonlyArray<LocationDomain> = table;

export type DomainId = string;

export const isDomain = (id: unknown): id is DomainId =>
  typeof id === "string" && LOCATION_DOMAINS.some((d) => d.id === id);

/// 第一个 domain：首次启动、记着的 domain 已不在表里时落在它上面（今天是 skills）
export const FIRST_DOMAIN: DomainId = LOCATION_DOMAINS[0].id;

/// 菜单命令名：`tab-<id>`
export const tabCommand = (id: DomainId): string => `tab-${id}`;

/// 菜单命令名反查 domain；不是页签命令返回 null
export function domainOfCommand(command: string): DomainId | null {
  const id = command.startsWith("tab-") ? command.slice("tab-".length) : null;
  return id !== null && isDomain(id) ? id : null;
}

/// 菜单项的快捷键：按表里的先后，第 1 项 ⌘1、第 2 项 ⌘2……（第 10 项起不给快捷键）
export function domainShortcut(index: number): string | null {
  return index < 9 ? `CmdOrCtrl+${index + 1}` : null;
}

/// 菜单项上的名字：与页签显示的一样写大写（`SKILLS` `MCP`）。原生菜单用系统字体、没有 `Cap`，
/// 所以直接转大写（DESIGN「应用菜单」：名字与界面上同一个命令同名）
export const domainMenuLabel = (d: LocationDomain): string => d.label.toUpperCase();

/// 应用菜单「显示」里的页签项（与 `src-tauri/src/menu.rs` 的 `tab_item` 同一条规则）：
/// 命令 `tab-<id>`、名字即页签上显示的字（大写）、第 N 项 ⌘N
export function domainMenuItems(
  domains: ReadonlyArray<LocationDomain> = LOCATION_DOMAINS,
): Array<{ command: string; label: string; accelerator: string | null }> {
  return domains.map((d, i) => ({
    command: tabCommand(d.id),
    label: domainMenuLabel(d),
    accelerator: domainShortcut(i),
  }));
}
