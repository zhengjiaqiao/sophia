/// 组件库 2026-09-25 设计系统梳理新增 / 收编的组件：渲染断言与纯逻辑。
/// 渲染方式同 ui.test.ts（ui-render.ts：node:test + typescript 转 JSX + react-dom/server）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { render } from "./ui-render.ts";

const noop = () => {};
const uiCss = readFileSync(new URL("../src/ui/ui.css", import.meta.url), "utf8");
const tokensCss = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8");

function cssRule(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n|,)\\s*${esc}\\s*(?:,[^{]*)?\\{([^}]*)\\}`));
  assert.ok(match, `找不到规则 ${selector}`);
  return match[1];
}

const { parseDuration, motionMs } = await import("../src/ui/motion.ts");
const { edgeFades, NO_FADE } = await import("../src/ui/edgeFades.ts");
const { TextField } = await import("../src/ui/TextField.tsx");
const { Menu, MenuItem } = await import("../src/ui/Menu.tsx");
const { CheckMark, CheckRow } = await import("../src/ui/CheckRow.tsx");
const { ListRow } = await import("../src/ui/ListRow.tsx");
const { SectionLabel } = await import("../src/ui/SectionLabel.tsx");
const { ChipRow } = await import("../src/ui/ChipRow.tsx");
const { Note } = await import("../src/ui/Note.tsx");
const { Mono } = await import("../src/ui/Mono.tsx");
const { FadeViewport } = await import("../src/ui/EdgeFade.tsx");
const { Tooltip } = await import("../src/ui/Tooltip.tsx");
const { Chip } = await import("../src/ui/Chip.tsx");
const { setHome } = await import("../src/pathText.ts");

// ===== 时长只在 tokens.css 写一次 =====

test("parseDuration：CSS 时长写法 → 毫秒；写错、空、负数一律 0", () => {
  assert.equal(parseDuration("260ms"), 260);
  assert.equal(parseDuration(" 120ms "), 120);
  assert.equal(parseDuration("0.8s"), 800);
  assert.equal(parseDuration("0ms"), 0);
  assert.equal(parseDuration(""), 0);
  assert.equal(parseDuration("fast"), 0);
  assert.equal(parseDuration("-5ms"), 0);
  // 没有文档（服务端渲染、node:test）：0，不拖延卸载
  assert.equal(motionMs("--dur-drawer"), 0);
});

test("JS 里不再镜像 CSS 的时长：抽屉、新手提示条、提示条淡出、推入页都读 token", () => {
  const read = (f: string) => readFileSync(new URL(`../src/ui/${f}`, import.meta.url), "utf8");
  assert.match(read("Drawer.tsx"), /motionMs\("--dur-drawer"\)/);
  assert.match(read("HintStrip.tsx"), /motionMs\("--dur-drawer"\)/);
  assert.match(read("Toast.tsx"), /motionMs\("--motion-fast"\)/);
  assert.match(read("PushedPage.tsx"), /motionMs\("--dur-push"\)/);
  for (const f of ["Drawer.tsx", "HintStrip.tsx", "Toast.tsx", "PushedPage.tsx"]) {
    assert.doesNotMatch(read(f), /(_MS|Ms)\s*=\s*(120|200|260)\b/, f);
  }
  // 被读的 token 都在，且减少动效时位移类置 0（JS 读到的也是 0，不必再各判一次）
  for (const name of ["dur-drawer", "dur-push", "motion-fast"]) {
    assert.match(tokensCss, new RegExp(`--${name}:\\s*\\d+ms;`), name);
  }
});

// ===== 滚动边缘渐隐：一份判定、一份监听 =====

test("edgeFades：内容比可见区多出 1px 以上才渐隐；滚到顶只下沿、滚到底只上沿", () => {
  assert.deepEqual(edgeFades(0, 300, 300), NO_FADE);
  assert.deepEqual(edgeFades(0, 300, 301), NO_FADE, "1px 容差");
  assert.deepEqual(edgeFades(0, 300, 600), { start: false, end: true });
  assert.deepEqual(edgeFades(150, 300, 600), { start: true, end: true });
  assert.deepEqual(edgeFades(300, 300, 600), { start: true, end: false });
  // 页面的旧入口转到这里，判定只有一份
  const modelsView = readFileSync(new URL("../src/modelsView.ts", import.meta.url), "utf8");
  assert.match(modelsView, /export \{ edgeFades \} from "\.\/ui\/edgeFades\.ts";/);
  assert.doesNotMatch(
    readFileSync(new URL("../src/ui/FloatingLayer.tsx", import.meta.url), "utf8"),
    /modelsView/,
    "组件库不反向依赖页面模块",
  );
});

test("FadeViewport：上 / 下被裁掉时那一边出渐隐，浮层里从 paper、机面上从 face；渐隐层走 --z-fade", () => {
  assert.equal(
    render(FadeViewport, { fade: { start: true, end: false }, tone: "face", children: "x" }),
    '<div class="ss-layer__viewport ss-layer__viewport--face" data-fade-top="true">x</div>',
  );
  assert.match(
    cssRule(uiCss, ".ss-layer__viewport--face::before"),
    /linear-gradient\(to bottom, var\(--face\), transparent\)/,
  );
  assert.match(uiCss, /\.ss-layer__viewport::after \{[^}]*z-index: var\(--z-fade\);/);
});

// ===== 输入框 =====

test("TextField：凹面 recess + hairline 边 + control 7、高 28、左右 10、13 号字；聚焦边转 ink-mute", () => {
  const html = render(TextField, {
    value: "",
    onChange: noop,
    label: "地址",
    placeholder: "https://…",
  });
  assert.equal(
    html,
    '<label class="ss-textfield"><input class="ss-textfield__input" type="text" placeholder="https://…" aria-label="地址" value=""/></label>',
  );
  const box = cssRule(uiCss, ".ss-textfield");
  assert.match(box, /height:\s*var\(--control-h\)/);
  assert.match(box, /padding:\s*0 10px/);
  assert.match(box, /border:\s*1px solid var\(--hairline\)/);
  assert.match(box, /border-radius:\s*var\(--radius-control\)/);
  assert.match(box, /background:\s*var\(--recess\)/);
  assert.match(cssRule(uiCss, ".ss-textfield:focus-within"), /border-color:\s*var\(--ink-mute\)/);
  assert.match(cssRule(uiCss, ".ss-textfield__input"), /font-size:\s*var\(--size-caption\)/);
  // 密钥
  assert.match(
    render(TextField, { value: "", onChange: noop, label: "密钥", type: "password" }),
    /type="password"/,
  );
});

test("TextField 搜索形态：词表里那一枚放大镜在左；空着写快捷键提示，有字换成清除键；定宽由调用方给", () => {
  const empty = render(TextField, {
    value: "",
    onChange: noop,
    label: "筛选",
    placeholder: "筛选",
    search: true,
    shortcut: "⌘F",
    width: 200,
  });
  assert.match(empty, /^<label class="ss-textfield ss-textfield--search" style="width:200px">/);
  // IconSearch：16 画布、r 4.3（模型列表手画的那一枚 r 4.6 不再有第二份）
  assert.match(empty, /<circle cx="7" cy="7" r="4\.3">/);
  assert.match(empty, /<span class="ss-textfield__key" aria-hidden="true">⌘F<\/span><\/label>$/);
  const typed = render(TextField, {
    value: "pdf",
    onChange: noop,
    label: "筛选",
    search: true,
    shortcut: "⌘F",
  });
  assert.match(typed, /class="ss-textfield__clear" title="清除筛选" aria-label="清除筛选"/);
  assert.doesNotMatch(typed, /⌘F/);
  assert.match(cssRule(uiCss, ".ss-textfield__clear"), /width:\s*var\(--hit-min\)/);
  // 不用 type="search"：WebKit 的搜索框会自己吃掉 Esc
  assert.doesNotMatch(typed, /type="search"/);
});

// ===== 菜单（裁决：项高 30、13 号字）=====

test("Menu：普通 / 单选 ✓ / 多选勾选三种项；项高 30、13 号字、悬停 surface、左右内缩 4", () => {
  const html = render(Menu, {
    label: "项目排序",
    children: [
      createElement(MenuItem, { key: "a", kind: "radio", checked: true, children: "最近活跃" }),
      createElement(MenuItem, { key: "b", kind: "radio", children: "名称" }),
    ],
  });
  assert.match(
    html,
    /^<div class="ss-menulist ss-menulist--layer" role="menu" aria-label="项目排序" style="max-width:320px">/,
  );
  // 当前项前打 ✓（统一对勾），没打勾的项留同宽一格
  assert.match(
    html,
    /role="menuitemradio" aria-checked="true" class="ss-menuitem ss-menuitem--radio is-on"><span class="ss-menuitem__tick"><svg class="ss-tick"/,
  );
  assert.match(
    html,
    /aria-checked="false" class="ss-menuitem ss-menuitem--radio"><span class="ss-menuitem__tick"><\/span>/,
  );
  const item = cssRule(uiCss, ".ss-menuitem");
  assert.match(item, /min-height:\s*30px/);
  assert.match(item, /font-size:\s*var\(--size-caption\)/);
  assert.match(item, /margin:\s*0 var\(--space-xxs\)/);
  assert.match(item, /border-radius:\s*var\(--radius-control\)/);
  assert.match(
    cssRule(uiCss, ".ss-menuitem:hover:not(:disabled)"),
    /background:\s*var\(--surface\)/,
  );
  // 键盘高亮同悬停，指针操作时程序放的焦点不画
  assert.match(
    uiCss,
    /html:not\(\[data-input="pointer"\]\) \.ss-menuitem:focus-visible \{\s*background: var\(--surface\);/,
  );
});

test("MenuItem 多选：勾选框在前（没勾的名字 ink-mute）、可带图标；点不了的原因写在副行里并作读屏描述", () => {
  const on = render(MenuItem, {
    kind: "check",
    checked: true,
    icon: createElement("span", null, "✳"),
    children: "Claude Code",
  });
  assert.match(
    on,
    /role="menuitemcheckbox" aria-checked="true" class="ss-menuitem ss-menuitem--check is-on" data-checkrow=""/,
  );
  assert.match(on, /<span class="ss-checkbox ss-checkmark is-on" aria-hidden="true">/);
  assert.match(
    cssRule(uiCss, ".ss-menuitem--check:not(.is-on) .ss-menuitem__name"),
    /color:\s*var\(--ink-mute\)/,
  );
  const off = render(MenuItem, {
    kind: "check",
    disabledReason: "Cursor 不支持用命令生成请求头",
    children: "Cursor",
  });
  assert.match(off, /aria-describedby="([^"]+)"[^>]*disabled=""/);
  const id = off.match(/aria-describedby="([^"]+)"/)![1];
  assert.match(
    off,
    new RegExp(`class="ss-menuitem__sub" id="${id}">Cursor 不支持用命令生成请求头<`),
  );
  assert.doesNotMatch(off, /data-checkrow/);
  // 普通项：副行（同名几份差在哪）
  const action = render(MenuItem, {
    sub: "差在 env、args",
    children: "Claude Code · Project MCPs",
  });
  assert.match(action, /role="menuitem" class="ss-menuitem ss-menuitem--action"/);
  assert.match(action, /class="ss-menuitem__sub">差在 env、args</);
});

test("Menu 放在面板里（托盘）：项内缩 6，文字对齐面板的 16；带一句标题时读屏名取它", () => {
  const html = render(Menu, {
    context: "panel",
    title: "notion 有 3 份，写进哪一份？",
    children: createElement(MenuItem, { children: "退出" }),
  });
  assert.match(
    html,
    /class="ss-menulist ss-menulist--panel" role="menu" aria-labelledby="([^"]+)"/,
  );
  assert.match(html, /class="ss-menulist__title" id="[^"]+">notion 有 3 份/);
  assert.match(cssRule(uiCss, ".ss-menulist--panel .ss-menuitem"), /margin:\s*0 6px/);
});

// ===== 勾选行 =====

test("CheckMark：画出来的 14 方（与 Checkbox 同一套样式、同一个记号），只画状态；按钮禁用时平贴", () => {
  assert.equal(
    render(CheckMark, { on: false }),
    '<span class="ss-checkbox ss-checkmark" aria-hidden="true"></span>',
  );
  assert.match(
    render(CheckMark, { on: true }),
    /class="ss-checkbox ss-checkmark is-on"[^>]*><svg class="ss-tick"/,
  );
  assert.match(render(CheckMark, { on: "mixed" }), /is-mixed[^>]*><svg[^>]*><path d="M1 5h8">/);
  assert.match(cssRule(uiCss, ":disabled > .ss-checkmark"), /border-color:\s*var\(--hairline\)/);
});

test("CheckRow：整行是命中区（role=checkbox），勾选框 + 图标 + 名字 + 行尾；list 34 / grid 36；悬停 surface、方框随行手靠近", () => {
  const html = render(CheckRow, {
    checked: true,
    onChange: noop,
    icon: createElement("span", null, "✳"),
    size: "grid",
    children: "Claude Code",
  });
  assert.match(
    html,
    /<button type="button" role="checkbox" aria-checked="true" class="ss-checkrow ss-checkrow--grid" data-checkrow="">/,
  );
  assert.match(
    html,
    /ss-checkmark is-on[^]*class="ss-checkrow__icon"[^]*class="ss-checkrow__name">Claude Code</,
  );
  assert.match(cssRule(uiCss, ".ss-checkrow"), /height:\s*var\(--row-h\)/);
  assert.match(cssRule(uiCss, ".ss-checkrow--grid"), /height:\s*36px/);
  assert.match(
    uiCss,
    /\.ss-checkrow:hover:not\(:disabled\),\s*\.ss-checkrow\.is-noted \{\s*background: var\(--surface\);/,
  );
  // 不可选：原因提示框（按下当即出），行不回应悬停、方框平贴
  const off = render(CheckRow, {
    checked: false,
    onChange: noop,
    disabledReason: "最多显示 4 个，先取消一个",
    children: "Cline",
  });
  assert.match(off, /class="ss-tipwrap is-explain" tabindex="0"/);
  assert.match(off, /disabled=""/);
  assert.doesNotMatch(off, /data-checkrow/);
  // 行尾（模型 id）
  assert.match(
    render(CheckRow, {
      checked: false,
      onChange: noop,
      trailing: "anthropic/claude-opus-4-6",
      children: "Opus 4.6",
    }),
    /class="ss-checkrow__trailing">anthropic\/claude-opus-4-6</,
  );
});

// ===== 列表行（裁决：整行可点的列表行都有悬停底）=====

test("ListRow：拉手 18 + 6 + 名字 / 第二行 + 行尾动作列；有抽屉才整行可点、才有悬停带；没有勾选格时拉手常显", () => {
  const html = render(ListRow, {
    title: "openrouter",
    sub: "openrouter.ai/api/v1 · 已连接 · 已选 2 / 103",
    actions: createElement("button", { type: "button" }, "编辑"),
    drawer: "模型列表",
    open: false,
    onToggle: noop,
    drawerLabel: "openrouter 的模型",
    drawerId: "gw-openrouter",
  });
  assert.match(html, /^<div class="ss-listrow"><div class="ss-listrow__main" data-drawer-row="">/);
  assert.match(
    html,
    /class="ss-drawerhandle is-always" aria-label="openrouter 的模型" aria-expanded="false" aria-controls="gw-openrouter"/,
  );
  assert.match(
    html,
    /class="ss-listrow__title">openrouter<\/span><span class="ss-listrow__sub">openrouter\.ai/,
  );
  assert.match(html, /class="ss-listrow__actions"><button type="button">编辑</);
  // 抽屉左沿对齐名字（拉手 18 + 6）、行线归这一组、紧贴行
  assert.match(html, /class="ss-drawer is-bare is-flush" id="gw-openrouter" inert=""/);
  const main = cssRule(uiCss, ".ss-listrow__main");
  assert.match(main, /margin:\s*0 calc\(var\(--space-xs\) \* -1\)/);
  assert.match(main, /padding:\s*10px var\(--space-xs\)/);
  assert.match(
    uiCss,
    /\.ss-listrow__main\[data-drawer-row\]:hover,\s*\.ss-listrow\.is-highlighted \.ss-listrow__main \{\s*background: var\(--surface\);/,
  );
  assert.match(cssRule(uiCss, ".ss-listrow"), /border-bottom:\s*var\(--border-row\)/);
  assert.match(cssRule(uiCss, ".ss-listrow:last-child"), /border-bottom:\s*0/);
  // 没有抽屉：不可点、没有悬停带、拉手格留空（名字照样对齐）
  const plain = render(ListRow, { title: "docs-site" });
  assert.match(plain, /<div class="ss-listrow__main"><span class="ss-listrow__handle"><\/span>/);
});

test("ListRow 有勾选格：勾选 24 + 8 在最前，拉手平时不画（悬停这一行才出），抽屉左沿让到 56", () => {
  const html = render(ListRow, {
    title: "superpowers",
    sub: "检测到的 · 6 个 skill",
    check: createElement("button", { type: "button", role: "checkbox", "aria-checked": false }, ""),
    drawer: "brainstorming · writing-plans",
    open: true,
    onToggle: noop,
    drawerLabel: "superpowers 里的 skill",
  });
  assert.match(html, /^<div class="ss-listrow has-check is-open">/);
  assert.match(html, /class="ss-listrow__check"><button type="button" role="checkbox"/);
  assert.match(html, /class="ss-drawerhandle is-open"/);
  assert.doesNotMatch(html, /is-always/);
  assert.match(html, /class="ss-drawer__well" style="margin-inline-start:56px">brainstorming/);
});

// ===== 区块小标（裁决：Condensed 12 / 600 ink-mute，可选下 7 一条 hairline）=====

test("SectionLabel：Condensed 12 / 600 ink-mute；rule 时下 7 一条 hairline；右端可带一颗键", () => {
  assert.equal(
    render(SectionLabel, { children: "关于" }),
    '<div class="ss-sectionlabel"><span class="ss-sectionlabel__text">关于</span></div>',
  );
  const html = render(SectionLabel, {
    rule: true,
    action: createElement("button", { type: "button" }, "+ 网关"),
    children: "网关",
  });
  assert.match(html, /class="ss-sectionlabel has-rule has-action"/);
  assert.match(html, /class="ss-sectionlabel__action"><button type="button">\+ 网关</);
  const rule = cssRule(uiCss, ".ss-sectionlabel");
  assert.match(rule, /font-family:\s*var\(--font-cond\)/);
  assert.match(rule, /font-size:\s*var\(--size-label\)/);
  assert.match(rule, /font-weight:\s*600/);
  assert.match(rule, /color:\s*var\(--ink-mute\)/);
  const ruled = cssRule(uiCss, ".ss-sectionlabel.has-rule");
  assert.match(ruled, /padding-bottom:\s*7px/);
  assert.match(ruled, /border-bottom:\s*var\(--border-structure\)/);
});

// ===== 胶囊行、灰字一句、等宽读数 =====

test("ChipRow：行首标签 12 / 500 与胶囊同高（--control-h-chip），+ 8 + 胶囊（间 6、行间 8），读屏按列表读", () => {
  const html = render(ChipRow, {
    label: "来源",
    children: [
      createElement(Chip, { key: "all", selected: true, onClick: noop, children: "全部" }),
      createElement(Chip, { key: "u", count: 11, onClick: noop, children: "通用仓库" }),
    ],
  });
  assert.match(
    html,
    /^<div class="ss-chiprow"><span class="ss-chiprow__label">来源<\/span><div class="ss-chiprow__chips" role="list" aria-label="来源">/,
  );
  assert.equal(html.match(/class="ss-chiprow__chip" role="listitem"/g)?.length, 2);
  assert.match(cssRule(uiCss, ".ss-chiprow__label"), /line-height:\s*var\(--control-h-chip\)/);
  assert.match(cssRule(uiCss, ".ss-chiprow__label"), /font-weight:\s*500/);
  assert.match(cssRule(uiCss, ".ss-chiprow__chips"), /gap:\s*var\(--space-xs\) 6px/);
});

test("Note：一句 13 ink-mute，可带一颗紧凑默认键；离开 Sophia 的给 leave 画成浅键", () => {
  const html = render(Note, {
    action: { label: "清除筛选", onClick: noop },
    children: "没有匹配的模型",
  });
  assert.match(html, /^<p class="ss-note"><span class="ss-note__text">没有匹配的模型<\/span>/);
  assert.match(html, /class="ss-btn ss-btn--compact">清除筛选</);
  assert.match(
    render(Note, {
      action: { label: "去发布页", onClick: noop, leave: true },
      children: "下载没成",
    }),
    /class="ss-btn ss-btn--quiet">去发布页<svg class="ss-btn__external"/,
  );
  const note = cssRule(uiCss, ".ss-note");
  assert.match(note, /font-size:\s*var\(--size-caption\)/);
  assert.match(note, /color:\s*var\(--ink-mute\)/);
});

test("Mono：Plex Mono 12 ink-faint、可拖选、任意处折行；path 时主目录写成 ~；inherit 随句子", () => {
  setHome("/Users/me");
  assert.equal(
    render(Mono, { path: true, children: "/Users/me/.agents/skills/defuddle" }),
    '<span class="ss-mono ss-selectable">~/.agents/skills/defuddle</span>',
  );
  setHome(null);
  assert.match(
    render(Mono, { inherit: true, children: "x" }),
    /class="ss-mono ss-selectable ss-mono--inherit"/,
  );
  assert.match(render(Mono, { truncate: true, children: "x" }), /ss-mono--truncate/);
  const mono = cssRule(uiCss, ".ss-mono");
  assert.match(mono, /font-family:\s*var\(--font-mono\)/);
  assert.match(mono, /color:\s*var\(--ink-faint\)/);
  assert.match(mono, /overflow-wrap:\s*anywhere/);
});

// ===== 提示框的表格格子用法（受控）=====

test("Tooltip 受控（表格格子）：open 决定开没开，包层不接悬停与按下；ceiling 往上弹不钻进吸顶区", () => {
  const cell = () => createElement("button", { type: "button" }, "●");
  const shut = render(Tooltip, {
    content: "点一下加上",
    context: "table",
    open: false,
    children: cell(),
  });
  assert.match(shut, /class="ss-tip ss-tip--top"/);
  assert.doesNotMatch(shut, /is-open/);
  const open = render(Tooltip, {
    content: "点一下加上",
    shortcut: "空格",
    context: "table",
    open: true,
    ceiling: true,
    children: cell(),
  });
  assert.match(open, /class="ss-tip ss-tip--top is-open"/);
  // 快捷键只在键盘焦点唤起时写（is-keyed），鼠标悬停不写
  assert.match(
    open,
    /<span class="ss-tip__keyhint"> · <span class="ss-tip__key">空格<\/span><\/span>/,
  );
  assert.match(cssRule(uiCss, ".ss-tip__keyhint"), /display:\s*none/);
  const src = readFileSync(new URL("../src/ui/Tooltip.tsx", import.meta.url), "utf8");
  assert.match(src, /ceiling && p\.side === "above" && p\.top < tipCeiling\(w\)/);
});
