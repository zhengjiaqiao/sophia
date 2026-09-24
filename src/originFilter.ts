/// 位置页的来源筛选（DESIGN「位置页 › 来源筛选」「添加来源」）：选中的来源 id，空＝全部。
///
/// **多选、纳入式**：点一项＝纳入这个来源，再点＝去掉；一个都不选＝不筛（没有 `全部` 项）。
/// 进位置页时一个都不选。加完来源滑回位置页的那一刻由系统选中新来源（加了几个选几个），列表显示它们的并集。
/// skill 与 MCP 共用。纯逻辑，不产 JSX。

/// 这一行过不过筛选：行的来源 id（skill 一个；MCP 一行几份定义各一个）有一个被选中就算
export function originMatches(filter: readonly string[], ids: readonly string[]): boolean {
  return filter.length === 0 || ids.some((id) => filter.includes(id));
}

/// 点了一项之后的筛选：没选的纳入（排在最后），选着的去掉；其余选中的不动
export function toggleOrigin(filter: readonly string[], id: string): string[] {
  return filter.includes(id) ? filter.filter((x) => x !== id) : [...filter, id];
}

/// 一个来源被移除之后的筛选：正选着它就去掉它，其余不动（不再「回到全部」）
export function dropOrigin(filter: readonly string[], id: string): string[] {
  return filter.includes(id) ? filter.filter((x) => x !== id) : [...filter];
}

/// 此刻真正生效的筛选：只留来源筛选里还有这一项的 id。筛过的来源被移除、换了项目、重扫后没了行，
/// 留着它就会筛出空表——没了的自动去掉，其余选中的照旧
export function liveOrigins(filter: readonly string[], chips: Iterable<string>): string[] {
  if (filter.length === 0) return [];
  const shown = new Set(chips);
  return filter.filter((id) => shown.has(id));
}

/// 加完来源之后要选中的项：新加的来源里，重扫后来源筛选里真有这一项的（去重，按加的先后）。
/// 一个都没有（新来源在这个位置下一行都没有）时是空＝不筛
export function addedOrigins(added: readonly string[], chips: Iterable<string>): string[] {
  const shown = new Set(chips);
  return [...new Set(added)].filter((id) => shown.has(id));
}
