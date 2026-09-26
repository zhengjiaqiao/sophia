/// 加完来源之后的收尾（R9 去掉了按来源筛选之后，这个模块只剩这一个函数）：纯逻辑，不产 JSX。
/// skill 与 MCP 共用。

/// 加完来源之后新来源里、重扫后来源列里真有这一项的（去重，按加的先后）：
/// 给 SkillsTab / McpTab 算「该闪哪些行、报几个 skill / MCP」用
export function addedOrigins(added: readonly string[], chips: Iterable<string>): string[] {
  const shown = new Set(chips);
  return [...new Set(added)].filter((id) => shown.has(id));
}
