/// 项目筛选片（spec 2026-09-26-object-first-navigation R4 R5）：SKILLS / MCP 页面头下那一行 `项目` 的纯逻辑。
/// 露出最近活跃的前 6 个，其余收进 `更多 ▾`；从「更多」里选中的那个替换第 6 个位置，保证选中项始终看得见。
/// 不碰 api、不产 JSX，tests/scope-view.test.ts 直接测。

import type { ScopeLevel } from "./shell/nav.ts";

export interface ScopeProject {
  /// 域 key：`project:<路径>`
  key: string;
  label: string;
  path: string;
}

/// 一行里最多露出几个项目片（`全部` 与 `更多` 不算）
export const MAX_CHIPS = 6;

/// `ordered` 已按最近活跃排好。返回露出的片与收进「更多」的项目（都保持原来的先后）
export function chipProjects(
  ordered: ReadonlyArray<ScopeProject>,
  selected: string | null,
): { chips: ScopeProject[]; more: ScopeProject[] } {
  const top = ordered.slice(0, MAX_CHIPS);
  const picked =
    selected === null ? undefined : ordered.slice(MAX_CHIPS).find((p) => p.key === selected);
  const chips = picked ? [...top.slice(0, -1), picked] : top;
  return { chips, more: ordered.filter((p) => !chips.includes(p)) };
}

/// 用户级只有一个位置，没有项目可选：这一行不出
export const showsProjectChips = (level: ScopeLevel): boolean => level !== "user";

/// 「更多」里的搜索：名字或路径里有就算，不分大小写；空查询全留
export function matchProject(p: ScopeProject, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return p.label.toLowerCase().includes(q) || p.path.toLowerCase().includes(q);
}

/// 来源管理页、添加来源页作用于哪个位置（R8）：在选位置浮层里选过的，还在范围里就用它；选过的已经不在了
/// （后台重扫后项目没了）就没有——不悄悄换成别的位置，调用方收起开着的来源页。没选过用范围里的第一个
/// （只有一个位置时就是它）。范围里一个位置都没有（项目级下没有检测到项目）也没有：不落到用户级
export function sourceLocation(
  locations: ReadonlyArray<string>,
  picked: string | null,
): string | null {
  if (picked !== null) return locations.includes(picked) ? picked : null;
  return locations[0] ?? null;
}
