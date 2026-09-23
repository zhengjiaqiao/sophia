/// 主视图工具行第二行的来源筛选（DESIGN「主视图」「添加来源」）：选中的来源 id，空＝全部。
///
/// 用户点片是单选：点一片只选它，再点已单独选中的那片、或点 `全部`，回到全部。
/// 只有加完来源滑回主视图的那一刻由系统选中几片（加了几个选几片），列表显示它们的并集。
/// skill 与 MCP 共用。纯逻辑，不产 JSX。

/// 这一行过不过筛选：行的来源 id（skill 一个；MCP 一行几份定义各一个）有一个被选中就算
export function originMatches(filter: readonly string[], ids: readonly string[]): boolean {
  return filter.length === 0 || ids.some((id) => filter.includes(id));
}

/// 点了一片（null＝`全部`）之后的筛选：单选；再点已单独选中的那片回到全部
export function pickOrigin(filter: readonly string[], id: string | null): string[] {
  if (id === null || (filter.length === 1 && filter[0] === id)) return [];
  return [id];
}

/// 加完来源之后要选中的片：新加的来源里，重扫后工具行真有这一片的（去重，按加的先后）。
/// 一个都没有（新来源在这个位置下一行都没有）时是空＝不筛
export function addedOrigins(added: readonly string[], chips: Iterable<string>): string[] {
  const shown = new Set(chips);
  return [...new Set(added)].filter((id) => shown.has(id));
}

/// 本次运行里刚加的来源（筛选片带 `新`，只在内存里、重启就没了）的记法：按位置记——
/// 别的位置早就订阅着的同一个来源，在那边不算新
export const newOriginKey = (domain: string, id: string): string => `${domain}\n${id}`;
