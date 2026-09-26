/// scripts/lint-ui.mjs 的规则自测：每条防回潮规则一组正例（该报）与反例（不该报），
/// 外加取可见文案的扫描器（行尾注释里的反引号曾让字符串配对错位、误报整段代码）。
import assert from "node:assert/strict";
import test from "node:test";

const { rules, visibleText, stripComments, lintSource } = await import("../scripts/lint-ui.mjs");

type Rule = { id: string; run: (src: string, path: string) => string[] };
const rule = (id: string): Rule => {
  const r = (rules as Rule[]).find((x) => x.id === id);
  assert.ok(r, `没有规则 ${id}`);
  return r;
};
const hits = (id: string, src: string, path: string) => rule(id).run(src, path);

// ===== 可见文案的扫描器 =====

test("visibleText：行尾注释里的反引号不让字符串配对错位（不再把整段代码当成文案）", () => {
  // 旧写法按反引号成对取：注释里那一个 ` 与下一行模板字符串的开头配成一对，中间的代码与注释
  // （含「操作失败」）整段被当成文案，mechanism-words 误报
  const src = [
    "const a = pick(x); // 结尾的 ` 是模板字符串的开头",
    "const b = layout(1); // 操作失败时回退",
    "const label = `筛选`;",
  ].join("\n");
  const text = visibleText(src, "src/X.tsx");
  assert.equal(text, "筛选");
  assert.deepEqual(hits("mechanism-words", src, "src/X.tsx"), []);
});

test("visibleText：行尾注释里的词不算文案；字符串里的 // 不是注释；模板字符串只取 ${} 之外的字", () => {
  const src = [
    'const url = "https://example.com 打开";',
    "const n = 3; // 操作失败（注释，不算）",
    "const t = `已添加 ${name} 的 ${count} 个`;",
  ].join("\n");
  const text = visibleText(src, "src/X.tsx");
  assert.match(text, /https:\/\/example\.com 打开/);
  assert.doesNotMatch(text, /操作失败/);
  assert.match(text, /已添加 /);
  assert.doesNotMatch(text, /name|count/);
  // 正则字面量里的引号不开字符串
  const re = 'const q = /["\']/.test(s); const z = "同名";';
  assert.equal(visibleText(re, "src/X.tsx"), "同名");
});

test("visibleText：JSX 文本节点照样取到（含跨行的）；CSS 的 // 不是注释", () => {
  assert.match(visibleText("<p>\n  没有匹配的 skill\n</p>", "src/X.tsx"), /没有匹配的 skill/);
  assert.equal(
    stripComments("a { background: url(https://x/y.png); } /* 注释 */", "src/x.css").trim(),
    "a { background: url(https://x/y.png); }",
  );
});

// ===== ss-outside-ui =====

test("ss-outside-ui：页面的字符串与 CSS 选择器里不写 ss-*；组件库自己、注释、别的词里的 ss- 不算", () => {
  assert.deepEqual(hits("ss-outside-ui", 'const c = "ss-dot-btn mx-cell";', "src/Matrix.tsx"), [
    "ss-dot-btn",
  ]);
  assert.deepEqual(
    hits("ss-outside-ui", ".mx-selrow .ss-dot__halo { fill: var(--track); }", "src/Matrix.css"),
    ["ss-dot__halo"],
  );
  assert.deepEqual(hits("ss-outside-ui", ".app:has(.ss-pushed__foot) {}", "src/App.css"), [
    "ss-pushed__foot",
  ]);
  // 组件库、样张自己写
  assert.deepEqual(hits("ss-outside-ui", ".ss-chip {}", "src/ui/ui.css"), []);
  assert.deepEqual(
    hits("ss-outside-ui", '<b className="ss-dot-btn" />', "src/ui/gallery/marks.tsx"),
    [],
  );
  // 注释里、别的词里（--press-transform、glass-mark）不算
  assert.deepEqual(
    hits("ss-outside-ui", "/* 见 .ss-cap */ :root { --press-transform: none; }", "src/tokens.css"),
    [],
  );
  assert.deepEqual(
    hits("ss-outside-ui", 'performance.mark("glass-mark:x");', "src/brand/g.ts"),
    [],
  );
});

// ===== svg-outside-ui =====

test("svg-outside-ui：页面里不画 <svg；组件库与标志资产可以", () => {
  const svg = '<svg width="10" viewBox="0 0 10 10"><path d="M1 5H9" /></svg>';
  assert.equal(hits("svg-outside-ui", `const x = ${svg};`, "src/SourceRow.tsx").length, 1);
  assert.deepEqual(hits("svg-outside-ui", `const x = ${svg};`, "src/ui/icons.tsx"), []);
  assert.deepEqual(
    hits("svg-outside-ui", `const x = ${svg};`, "src/brand/AnimatedWordmark.tsx"),
    [],
  );
  // 注释里提到不算
  assert.deepEqual(hits("svg-outside-ui", "// 不再手写 <svg>", "src/Matrix.tsx"), []);
});

// ===== spacing-token =====

test("spacing-token：外距 / 内距 / 间隙的档位写成字面量报错；token、负值补偿、非档位值、别的属性不算", () => {
  assert.deepEqual(hits("spacing-token", ".a { padding-right: 4px; }", "src/App.css"), [
    "padding-right: 4px（4px）",
  ]);
  assert.equal(hits("spacing-token", ".a { padding: 12px 0 6px; }", "src/x.css").length, 1);
  assert.equal(hits("spacing-token", ".a { gap: 8px 6px; }", "src/x.css").length, 1);
  assert.equal(hits("spacing-token", ".a { margin: calc(16px + 2px) 0; }", "src/x.css").length, 1);
  // 反例
  for (const css of [
    ".a { padding: var(--space-sm) 0 6px; }",
    ".a { margin: -4px -6px -4px auto; }",
    ".a { margin: 0 calc(1px - var(--space-xl)); }",
    ".a { padding: 10px 14px; }",
    ".a { width: 24px; height: 16px; top: 8px; }",
    ":root { --space-xs: 8px; --mx-handle-col: 24px; }",
  ])
    assert.deepEqual(hits("spacing-token", css, "src/x.css"), [], css);
  // JSX 的 style
  assert.equal(
    hits("spacing-token", "<div style={{ marginTop: 8, color: x }} />", "src/X.tsx").length,
    1,
  );
  assert.equal(
    hits("spacing-token", '<div style={{ padding: "12px 0" }} />', "src/X.tsx").length,
    1,
  );
  assert.deepEqual(hits("spacing-token", "<div style={{ marginTop: 10 }} />", "src/X.tsx"), []);
  // style 之外的同名键（定位函数的 gap 参数）不算
  assert.deepEqual(hits("spacing-token", "placeLayer(a, b, v, { gap: 8 });", "src/X.tsx"), []);
});

// ===== z-index-token =====

test("z-index-token：只许 var(--z-*) 或基于它的 calc", () => {
  assert.deepEqual(hits("z-index-token", ".a { z-index: 5; }", "src/Matrix.css"), ["z-index: 5"]);
  assert.deepEqual(hits("z-index-token", ".a { z-index: calc(5 + 1); }", "src/x.css"), [
    "z-index: calc(5 + 1)",
  ]);
  assert.deepEqual(hits("z-index-token", "<div style={{ zIndex: 40 }} />", "src/X.tsx"), [
    "zIndex: 40",
  ]);
  for (const css of [
    ".a { z-index: var(--z-layer); }",
    ".a { z-index: calc(var(--z-pushed) - 3); }",
    ".a { z-index: calc(var(--z-pushed) + 1); }",
  ])
    assert.deepEqual(hits("z-index-token", css, "src/x.css"), [], css);
});

// ===== font-size-token =====

test("font-size-token：只许 var(--size-*) 或六档；11px 只在首字母方块", () => {
  assert.equal(hits("font-size-token", ".a { font-size: 14px; }", "src/x.css").length, 1);
  assert.equal(hits("font-size-token", ".a { font-size: 0.9em; }", "src/x.css").length, 1);
  assert.equal(hits("font-size-token", ".a { font-size: 11px; }", "src/x.css").length, 1);
  assert.equal(hits("font-size-token", "<span style={{ fontSize: 14 }} />", "src/X.tsx").length, 1);
  for (const css of [
    ".a { font-size: var(--size-caption); }",
    ".a { font-size: 13px; }",
    ".a { font-size: inherit; }",
    ".ss-mark__box { font-size: 11px; }",
  ])
    assert.deepEqual(hits("font-size-token", css, "src/x.css"), [], css);
  assert.deepEqual(
    hits("font-size-token", '<span style={{ fontSize: "var(--size-label)" }} />', "src/X.tsx"),
    [],
  );
});

// ===== 退役字符 =====

test("no-retired-ui：文案里的 ▾ 也拦（下拉记号是 IconChevronDown），注释里画示意图不算", () => {
  assert.ok(
    hits("no-retired-ui", 'const t = "选目标 ▾";', "src/SourceRow.tsx").some((x) =>
      x.includes("▾"),
    ),
  );
  assert.deepEqual(
    hits("no-retired-ui", "/// [开关] [选目标 ▾]\nconst a = 1;", "src/SourceRow.tsx"),
    [],
  );
});

// ===== 整体 =====

test("lintSource：一个干净的页面文件零违规", () => {
  const src = [
    'import { Tooltip } from "./ui";',
    "// 页面只用组件与公开钩子",
    'export const Row = () => <div className="mx-cell" data-flash="">加到 Codex</div>;',
  ].join("\n");
  assert.deepEqual(lintSource(src, "src/Matrix.tsx"), []);
});
