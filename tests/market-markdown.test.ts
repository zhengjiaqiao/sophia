/// 介绍页正文的渲染安全（spec 2026-09-27-skill-mcp-market 非功能「介绍页的 Markdown 渲染」，AC6）：
/// 原始 HTML 不执行、不嵌入；图片不加载、只留替代文字；`javascript:` 等链接去掉；frontmatter 去掉、description 作首段。
/// react-markdown 升级时必须重跑这一份。渲染方式同 ui.test.ts（ui-render.ts）
import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";

const { MarkdownBody } = await import("../src/market/markdown.tsx");
const { htmlToText, linkBase, safeHref, stripFrontmatter } =
  await import("../src/market/markdownText.ts");

const BASE = "https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md";
const html = (text: string, base: string | null = BASE) =>
  render(MarkdownBody, { text, base, onOpenLink: () => {} });

test("原始 HTML：script 不出标签也不出内容，其余标签只留字", () => {
  const out = html(
    [
      "# 标题",
      "",
      "<script>alert('block')</script>",
      "",
      "前 <script>alert('inline')</script> 后",
      "",
      '<div onclick="steal()"><b>粗</b> 与 <iframe src="https://evil.example"></iframe></div>',
      "",
      "<style>body{display:none}</style>",
      "",
      "<!-- 注释 -->正文",
    ].join("\n"),
  );
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /alert\(/);
  assert.doesNotMatch(out, /<iframe/i);
  assert.doesNotMatch(out, /<style/i);
  assert.doesNotMatch(out, /onclick/i);
  assert.doesNotMatch(out, /<div(?! class="md">)/i);
  assert.doesNotMatch(out, /<b>/);
  assert.doesNotMatch(out, /注释/);
  assert.doesNotMatch(out, /display:none/);
  assert.match(out, /前\s+后/);
  assert.match(out, /粗 与/);
  assert.match(out, /正文/);
});

test("图片不加载：Markdown 图片与 HTML 图片都只留替代文字，没有 <img>、没有预加载", () => {
  const out = html(
    '![架构图](https://example.com/a.png)\n\n<p align="center"><img src="https://example.com/logo.png" alt="徽标"></p>\n\n![](https://example.com/noalt.png)',
  );
  assert.doesNotMatch(out, /<img/i);
  assert.doesNotMatch(out, /<link/i);
  assert.doesNotMatch(out, /example\.com/);
  assert.match(out, /架构图/);
  assert.match(out, /徽标/);
});

test("链接：javascript: 与页内锚点只留文字；http(s) 成链接带 ↗；相对地址按 GitHub 页补全；不出 <a href>", () => {
  const out = html(
    "[坏](javascript:alert(1)) [锚](#usage) [好](https://skills.sh/x) [相对](./reference.md) [数据](data:text/html,hi)",
  );
  assert.doesNotMatch(out, /javascript:/);
  assert.doesNotMatch(out, /data:text/);
  assert.doesNotMatch(out, /<a\b/);
  // 去哪儿经提示框说（行内包层，链接照常折行），不写原生 title
  assert.match(
    out,
    /class="ss-tipwrap ss-tipwrap--inline"><span class="md-link" role="link"[^]*?role="tooltip"[^>]*><span class="ss-mono[^"]*">https:\/\/skills\.sh\/x</,
  );
  assert.match(
    out,
    /role="tooltip"[^>]*><span class="ss-mono[^"]*">https:\/\/github\.com\/anthropics\/skills\/blob\/main\/skills\/pdf\/reference\.md</,
  );
  assert.doesNotMatch(out, / title=/);
  assert.equal((out.match(/role="link"/g) ?? []).length, 2);
  assert.match(out, /<span>坏<\/span>/);
  assert.match(out, /<span>锚<\/span>/);
  // ↗ 是图标词表里的图形
  assert.match(out, /md-link__leave/);
});

test("代码块与小标题：代码块走 recess 底的 md-pre；标题一律降到 h3", () => {
  const out = html("# 一\n\n## 二\n\n```js\nconst a = 1;\n```\n\n行内 `code`");
  assert.doesNotMatch(out, /<h1|<h2/);
  assert.equal((out.match(/<h3 class="md-heading">/g) ?? []).length, 2);
  assert.match(out, /<pre class="md-pre"><code class="md-code language-js">const a = 1;/);
  assert.match(out, /<code class="md-code">code<\/code>/);
});

test("htmlToText：img 留 alt、实体只解一层", () => {
  assert.equal(htmlToText('<img alt="x" src=y>'), "x");
  assert.equal(htmlToText("<img alt='单引号'>"), "单引号");
  assert.equal(htmlToText("<img src=y>"), "");
  assert.equal(htmlToText("a<br/>b"), "a b");
  assert.equal(htmlToText("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
  assert.equal(htmlToText("<SCRIPT type=x>bad()</SCRIPT>ok"), "ok");
});

test("safeHref：只放 http(s) 与 mailto", () => {
  assert.equal(safeHref("https://a.b/c", null), "https://a.b/c");
  assert.equal(safeHref("mailto:x@y.z", null), "mailto:x@y.z");
  assert.equal(safeHref("javascript:alert(1)", BASE), null);
  assert.equal(safeHref(" JavaScript:alert(1)", BASE), null);
  assert.equal(safeHref("vbscript:x", BASE), null);
  assert.equal(safeHref("file:///etc/passwd", BASE), null);
  assert.equal(safeHref("#top", BASE), null);
  assert.equal(safeHref("./x.md", null), null);
  assert.equal(safeHref("", BASE), null);
  assert.equal(safeHref(undefined, BASE), null);
});

test("linkBase：文件夹页补一个 /，文件页原样", () => {
  assert.equal(linkBase(null), null);
  assert.equal(linkBase(BASE), BASE);
  assert.equal(
    linkBase("https://github.com/o/r/tree/main/skills/pdf"),
    "https://github.com/o/r/tree/main/skills/pdf/",
  );
  assert.equal(linkBase("https://github.com/o/r/tree/main/"), "https://github.com/o/r/tree/main/");
});

test("frontmatter：去掉，description 作首段（单行、引号、折叠块、字面块）", () => {
  const plain = stripFrontmatter("---\nname: pdf\ndescription: 读写 PDF\n---\n\n# PDF\n正文");
  assert.equal(plain.description, "读写 PDF");
  assert.equal(plain.body, "# PDF\n正文");

  const quoted = stripFrontmatter(
    '---\nname: x\ndescription: "Use when: \\"quoted\\" ok"\n---\nbody',
  );
  assert.equal(quoted.description, 'Use when: "quoted" ok');
  assert.equal(quoted.body, "body");

  const single = stripFrontmatter("---\ndescription: 'it''s fine'\n---\nb");
  assert.equal(single.description, "it's fine");

  const folded = stripFrontmatter(
    "---\nname: x\ndescription: >\n  first line\n  second line\nlicense: MIT\n---\nbody",
  );
  assert.equal(folded.description, "first line second line");

  const literal = stripFrontmatter("---\ndescription: |\n  a\n  b\n---\nbody");
  assert.equal(literal.description, "a\nb");

  const crlf = stripFrontmatter("﻿---\r\ndescription: win\r\n---\r\nbody");
  assert.equal(crlf.description, "win");
  assert.equal(crlf.body, "body");
});

test("frontmatter：没有、不闭合、没有 description 时原样", () => {
  assert.deepEqual(stripFrontmatter("# 标题\n正文"), { body: "# 标题\n正文", description: null });
  assert.deepEqual(stripFrontmatter("---\nname: x\n正文"), {
    body: "---\nname: x\n正文",
    description: null,
  });
  assert.deepEqual(stripFrontmatter("---\nname: x\n---\n正文"), {
    body: "正文",
    description: null,
  });
  // 正文中间的分隔线不是 frontmatter
  assert.equal(stripFrontmatter("前言\n---\ndescription: no\n---\n").description, null);
});

test("渲染后的正文里没有 frontmatter 的残迹", () => {
  const { body } = stripFrontmatter("---\nname: pdf\ndescription: d\n---\n正文");
  const out = html(body);
  assert.doesNotMatch(out, /name: pdf/);
  assert.match(out, /正文/);
});
