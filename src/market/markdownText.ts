/// 介绍页正文的纯逻辑（spec 2026-09-27-skill-mcp-market R5B、非功能「介绍页的 Markdown 渲染」；
/// DESIGN「发现与安装 › 介绍页」）：去 frontmatter、原始 HTML 变纯文字、链接地址的取舍。
/// 渲染在 markdown.tsx；这里不碰 React，node:test 直接测（tests/market-markdown.test.ts）

/// 去掉开头的 YAML frontmatter（`---` 起止），取出其中的 `description` 作首段。
/// 只认最常见的写法：单行值（可带引号）与 `>` / `|` 块（下面缩进的几行）；读不懂就当没有 description
export function stripFrontmatter(text: string): { body: string; description: string | null } {
  const src = text.replace(/^﻿/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { body: src, description: null };
  const body = src.slice(m[0].length).replace(/^(?:[ \t]*\r?\n)+/, "");
  return { body, description: frontmatterValue(m[1], "description") };
}

function frontmatterValue(yaml: string, key: string): string | null {
  const lines = yaml.split(/\r?\n/);
  const at = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (at < 0) return null;
  const rest = lines[at].replace(new RegExp(`^${key}\\s*:\\s*`), "").trim();
  let value: string;
  if (rest === "" || /^[>|][+-]?$/.test(rest)) {
    // 块：下面缩进的几行；`|` 保留换行，`>` 与空（普通多行）折成空格
    const block: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (line.trim() !== "" && !/^\s/.test(line)) break;
      block.push(line.trim());
    }
    value = rest.startsWith("|") ? block.join("\n").trim() : block.filter(Boolean).join(" ");
  } else {
    value = rest;
    const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
    if (quoted)
      value = quoted[1] === "'" ? quoted[2].replace(/''/g, "'") : quoted[2].replace(/\\"/g, '"');
  }
  return value.trim() === "" ? null : value.trim();
}

/// 原始 HTML 的一段换成它的纯文字：脚本、样式、注释连内容一起去掉；`<img alt>` 留替代文字；其余标签去掉只留字。
/// 实体只解最常见的几个（`&amp;` 最后解，`&amp;lt;` 不会变成 `<`）
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|iframe|object|embed|template|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      return alt ? (alt[1] ?? alt[2] ?? alt[3] ?? "") : "";
    })
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/// mdast 的最小形状（不引 @types/mdast）
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/// 成块的容器：块级的 HTML 在这里要包成一段
const BLOCK_PARENTS = new Set(["root", "blockquote", "listItem"]);
/// 行内成对出现时，开与关之间的文字也不显示
const DROP_BETWEEN = /^<(script|style|iframe|object|embed|template|noscript)\b/i;

/// remark 插件：原始 HTML 一律不执行、不嵌入（非功能）——每个 `html` 节点换成它的纯文字（`htmlToText`），
/// 行内被 `<script>…</script>` 夹住的文字一并去掉。不引 rehype-raw，渲染器本身也就见不到 HTML
export function remarkPlainHtml() {
  return (tree: MdNode) => {
    rewrite(tree);
  };
}

function rewrite(node: MdNode): void {
  if (!node.children) return;
  const out: MdNode[] = [];
  let dropping: string | null = null;
  for (const child of node.children) {
    if (dropping !== null) {
      if (child.type === "html" && new RegExp(`</${dropping}\\s*>`, "i").test(child.value ?? ""))
        dropping = null;
      continue;
    }
    if (child.type === "html") {
      const raw = child.value ?? "";
      const open = DROP_BETWEEN.exec(raw);
      if (open && !new RegExp(`</${open[1]}\\s*>`, "i").test(raw)) {
        dropping = open[1];
        continue;
      }
      const text = htmlToText(raw);
      if (text.trim() === "") continue;
      const leaf: MdNode = { type: "text", value: text };
      out.push(BLOCK_PARENTS.has(node.type) ? { type: "paragraph", children: [leaf] } : leaf);
      continue;
    }
    rewrite(child);
    out.push(child);
  }
  node.children = out;
}

/// 链接地址的取舍：只放 http(s) 与 mailto；相对地址按原文件在 GitHub 上的页补全（`base`）；
/// 页内锚点、`javascript:` 等其余一律不当链接（null＝只显示文字）
export function safeHref(href: string | null | undefined, base: string | null): string | null {
  if (!href) return null;
  const raw = href.trim();
  if (raw === "" || raw.startsWith("#")) return null;
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "mailto:")
    return null;
  return url.href;
}

/// 相对链接的基准：原文件在 GitHub 上的页。指到文件夹（`/tree/…`）时补一个 `/`，
/// 否则 `./x.md` 会落到上一级
export function linkBase(pageUrl: string | null): string | null {
  if (!pageUrl) return null;
  return /\/tree\/[^?#]*[^/]$/.test(pageUrl) ? `${pageUrl}/` : pageUrl;
}
