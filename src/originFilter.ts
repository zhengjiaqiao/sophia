/// 位置页的来源筛选（DESIGN「位置页 › 来源筛选」「添加来源」）：选中的来源 id，空＝全部。
///
/// **单选 + `全部`**（2026-09-25 评审第二轮）：第一颗 `全部`（默认选中），其后每个来源一颗；点一颗＝只看
/// 这个来源，点 `全部` 回到全部。再点已选中的那颗不变（`全部` 一直在，回去的路看得见）。
/// 加完来源滑回位置页时：只加了一个就选中它，加了几个停在 `全部`（新行闪一下，由调用方做）。
/// 筛选值仍是数组（空或一个），与各处的并集判断共用一套。skill 与 MCP 共用。纯逻辑，不产 JSX。

/// 这一行过不过筛选：行的来源 id（skill 一个；MCP 一行几份定义各一个）有一个被选中就算
export function originMatches(filter: readonly string[], ids: readonly string[]): boolean {
  return filter.length === 0 || ids.some((id) => filter.includes(id));
}

/// 点了一颗（null＝`全部`）之后的筛选：只看这一个来源；`全部` 回到不筛
export function pickOrigin(id: string | null): string[] {
  return id === null ? [] : [id];
}

/// 一个来源被移除之后的筛选：正选着它就回到全部，其余不动
export function dropOrigin(filter: readonly string[], id: string): string[] {
  return filter.includes(id) ? filter.filter((x) => x !== id) : [...filter];
}

/// 此刻真正生效的筛选：只留来源筛选里还有这一项的 id。筛过的来源被移除、换了项目、重扫后没了行，
/// 留着它就会筛出空表——没了就回到全部
export function liveOrigins(filter: readonly string[], chips: Iterable<string>): string[] {
  if (filter.length === 0) return [];
  const shown = new Set(chips);
  return filter.filter((id) => shown.has(id));
}

/// 加完来源之后新来源里、重扫后来源筛选里真有这一项的（去重，按加的先后）
export function addedOrigins(added: readonly string[], chips: Iterable<string>): string[] {
  const shown = new Set(chips);
  return [...new Set(added)].filter((id) => shown.has(id));
}

/// 加完来源滑回时的筛选：只加了一个（且它在来源筛选里有一项）就选中它；加了几个、或一个都没有行，
/// 停在 `全部`
export function filterAfterAdd(added: readonly string[]): string[] {
  return added.length === 1 ? [added[0]] : [];
}
