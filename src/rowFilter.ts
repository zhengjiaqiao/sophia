/// 位置页的筛选框（⌘F，DESIGN「位置页 › 页面头」）：R9 去掉了按来源筛选的胶囊行，
/// 筛选框改为同时命中名字与来源名。纯逻辑，不产 JSX；skill 与 MCP 共用。

/// 这一行过不过筛选：命中名字或来源（大小写不敏感、查询两端去空白）；空查询总是过。
/// `source` 给 null 表示这一行没有可比对的来源名（例如孤链行的伪来源），这时只按名字命中
export function matchesFilter(query: string, name: string, source: string | null): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (name.toLowerCase().includes(q)) return true;
  return source !== null && source.toLowerCase().includes(q);
}
