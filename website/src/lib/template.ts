/// 文案模板的占位约定（官网唯一一种）：`[[name]]`。
/// 服务端取文案时把占位参数传成 `slot("agent")`，取好带记号的整句放进 data-* 或传给演示逻辑，
/// 浏览器里（取不到整本目录）再用 `fillTemplate` 换成真值。
/// 不用目录自己的 `{name}`：它会撞构建检查的「HTML 残留 {占位符}」。无依赖，浏览器脚本可直接 import。

/// 占位记号：`slot("agent")` → `[[agent]]`
export const slot = (name: string): string => `[[${name}]]`;

/// 一次造几个：`slots("name", "agent")` → `{ name: "[[name]]", agent: "[[agent]]" }`
export function slots<K extends string>(...names: K[]): Record<K, string> {
  return Object.fromEntries(names.map((n) => [n, slot(n)])) as Record<K, string>;
}

/// 把模板里的 `[[x]]` 换成 params.x；params 里没有的记号换成空串
export function fillTemplate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\[\[(\w+)\]\]/g, (_, k: string) => String(params[k] ?? ""));
}
