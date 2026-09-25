/// 组件库第四波（四路页面迁移之后补齐的能力）：页面为了用组件而另写的外包层、抵消规则、内部类覆盖，
/// 一律收进组件的参数或公开钩子。渲染方式同 ui.test.ts（ui-render.ts：node:test + typescript 转 JSX + react-dom/server）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { render } from "./ui-render.ts";

const uiCss = readFileSync(new URL("../src/ui/ui.css", import.meta.url), "utf8");
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function cssRule(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n|,)\\s*${esc}\\s*(?:,[^{]*)?\\{([^}]*)\\}`));
  assert.ok(match, `找不到规则 ${selector}`);
  return match[1];
}

const { Tooltip, ReasonTip, TruncTip } = await import("../src/ui/Tooltip.tsx");

// ===== 提示框在 flex 行里收缩 / 撑满 =====

test("Tooltip fit：shrink 按内容定宽、放不下收窄；grow 撑满余下；两种都让触发控件随包层收窄", () => {
  const shrink = render(Tooltip, {
    content: "https://openrouter.ai/api/v1",
    fit: "shrink",
    children: createElement("span", null, "openrouter.ai/api/v1"),
  });
  assert.match(shrink, /class="ss-tipwrap ss-tipwrap--shrink"/);
  const grow = render(ReasonTip, {
    reason: "正在移除项目，稍等",
    fit: "grow",
    children: createElement("button", { disabled: true }, "项目"),
  });
  assert.match(grow, /class="ss-tipwrap ss-tipwrap--grow is-explain"/);
  // 只给完整值的一样能收缩
  assert.match(
    render(TruncTip, { content: "WeiboAP", fit: "shrink", children: createElement("span") }),
    /ss-tipwrap--shrink/,
  );
  // 不给：随触发控件，老样子
  assert.match(
    render(Tooltip, { content: "说明", children: createElement("span") }),
    /class="ss-tipwrap"/,
  );
  const both = cssRule(uiCss, ".ss-tipwrap--shrink");
  assert.match(both, /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(both, /min-width:\s*0/);
  assert.match(cssRule(uiCss, ".ss-tipwrap--shrink"), /display:\s*grid/);
  assert.match(uiCss, /\.ss-tipwrap--shrink \{\s*flex: 0 1 auto;/);
  assert.match(uiCss, /\.ss-tipwrap--grow \{\s*flex: 1 1 auto;\s*align-self: stretch;/);
  // 没有内容时照样不占盒：页面的 fit 不能把空包层撑回来
  assert.match(cssRule(uiCss, ".ss-tipwrap.is-idle"), /display:\s*contents !important/);
});

test("页面不再为提示框另包一层、也不再覆盖 .ss-tipwrap", () => {
  for (const path of [
    "src/App.css",
    "src/ModelsTab.css",
    "src/SourceRow.css",
    "src/Matrix.css",
    "src/pages/AddSourcePanel.css",
  ]) {
    const css = read(path);
    assert.doesNotMatch(css, /ss-tipwrap/, path);
    assert.doesNotMatch(css, /__urlbox|__fit\b|srcline__fit|mx-origin__slot|add-src__sub/, path);
  }
});

// ===== 新手提示条：宿主的钩子与不带上外距的形态 =====

const { HintStrip } = await import("../src/ui/HintStrip.tsx");

test("HintStrip：根上 data-hint 说展开没有（宿主据它让间距）；flush 不带上外距、只带下外距 16", () => {
  const html = render(HintStrip, {
    open: true,
    onDismiss: () => {},
    flush: true,
    children: "说明",
  });
  // 挂上的那一帧是收起态，展开由下一帧加 is-open / data-hint="open"
  assert.match(html, /^<div class="ss-hint ss-hint--flush" data-hint="closed" role="note"/);
  assert.match(
    render(HintStrip, { open: true, onDismiss: () => {}, children: "说明" }),
    /^<div class="ss-hint" data-hint="closed"/,
  );
  const css = read("src/ui/HintStrip.css");
  assert.match(css, /\.ss-hint--flush\.is-open \{\s*margin-block: 0 var\(--space-md\);/);
  // 两个宿主认公开钩子，不认 .ss-hint 的内部类
  assert.match(
    read("src/App.css"),
    /\.agent-page__section:has\(> \[data-hint="open"\]\) \{\s*padding-top: var\(--space-md\);/,
  );
  assert.doesNotMatch(read("src/App.css"), /ss-hint/);
  assert.match(
    read("src/ModelsTab.tsx"),
    /<HintStrip open=\{codexHint\.visible\} onDismiss=\{codexHint\.dismiss\} flush>/,
  );
  assert.doesNotMatch(read("src/Matrix.tsx"), /hintOpen/);
  assert.doesNotMatch(read("src/DomainView.tsx"), /hintOpen/);
});

// ===== 推入页：焦点落页面名、贴底行的钩子 =====

test("PushedPage：焦点给页面名（focusRef）；有贴底行时根上 data-footer，壳据它抬高右下那一叠", () => {
  const src = read("src/ui/PushedPage.tsx");
  assert.match(src, /titleRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(src, /<PageTitle focusRef=\{titleRef\}>/);
  assert.doesNotMatch(src, /pageRef/);
  const app = read("src/App.css");
  assert.match(app, /\.app:has\(\[data-footer\]\) \.app__toast \{/);
  assert.doesNotMatch(app, /ss-pushed/);
});

test("指针模式下不画焦点框、程序放焦点的落点不画框：规则在组件库里（样张单独用组件也一样）", () => {
  assert.match(uiCss, /html\[data-input="pointer"\] \*:focus-visible \{\s*outline: none;/);
  assert.match(uiCss, /\[tabindex="-1"\]:focus-visible \{\s*outline: none;/);
  assert.doesNotMatch(read("src/App.css"), /html\[data-input="pointer"\] \*:focus-visible/);
});

// ===== 状态点：外层按钮、surface 底上的光晕、刚点亮的反色闪 =====

const { StateDot } = await import("../src/ui/StateDot.tsx");
const { StateDotButton } = await import("../src/ui/StateDotButton.tsx");

test("StateDotButton：状态点的外层按钮是公开组件（命中至少 24、没有键面），属性原样落到 button 上", () => {
  const html = render(StateDotButton, {
    className: "mx-cellbtn",
    "aria-label": "docx · Codex：未加上",
    children: createElement(StateDot, { dot: "missing", hoverable: true }),
  });
  assert.match(
    html,
    /^<button type="button" class="ss-dot-btn mx-cellbtn" aria-label="docx · Codex：未加上"><span class="ss-dot-wrap"/,
  );
  assert.match(
    render(StateDotButton, { children: "x" }),
    /^<button type="button" class="ss-dot-btn">/,
  );
  // 页面不再手写这个类
  assert.doesNotMatch(read("src/Matrix.tsx"), /ss-dot-btn/);
});

test("StateDot onSurface：surface 底上光晕换 track；页面不再覆盖 .ss-dot__halo", () => {
  assert.match(
    render(StateDot, { dot: "missing", hoverable: true, onSurface: true }),
    /class="ss-dot ss-dot--missing is-on-surface"/,
  );
  assert.match(cssRule(uiCss, ".ss-dot.is-on-surface .ss-dot__halo"), /fill:\s*var\(--track\)/);
  assert.doesNotMatch(read("src/Matrix.css"), /ss-dot__halo|\.ss-/);
});

test("刚点亮的反色闪：格子上的 data-flash 是公开钩子；闪的那一帧不出光晕由组件库自己做", () => {
  const matrix = read("src/Matrix.tsx");
  assert.match(matrix, /data-flash=\{flashing\.has\(key\) \? "" : undefined\}/);
  assert.doesNotMatch(matrix, /ss-flash/);
  assert.doesNotMatch(uiCss, /\.ss-flash\b/);
  assert.match(cssRule(uiCss, "[data-flash] .ss-dot"), /animation:\s*ss-flash-dot/);
});

test("格子下方浮起的忙碌一句不接指针：Matrix 不再为它拦 portal 冒上来的悬停 / 右键", () => {
  assert.match(uiCss, /\.ss-floattoast:has\(> \.ss-toast--busy\) \{\s*pointer-events: none;/);
  assert.doesNotMatch(read("src/Matrix.tsx"), /\binside\(/);
});

// ===== 来源胶囊：长名截断、不可选的原因 =====

const { Chip } = await import("../src/ui/Chip.tsx");

test("Chip：名字最宽 220、放不下截断（计数完整）；不可选的原因经 ReasonTip", () => {
  const label = cssRule(uiCss, ".ss-chip__label");
  assert.match(label, /max-width:\s*220px/);
  assert.match(label, /overflow:\s*hidden/);
  assert.match(label, /text-overflow:\s*ellipsis/);
  assert.match(cssRule(uiCss, ".ss-chip"), /min-width:\s*0;\s*max-width:\s*100%/);
  const off = render(Chip, {
    children: "WeiboAP",
    disabled: true,
    disabledReason: "这个来源里还没有 skill",
  });
  assert.match(
    off,
    /^<span class="ss-tipwrap is-explain"[^>]*><button type="button" class="ss-chip"/,
  );
  assert.match(off, /role="tooltip"[^>]*>这个来源里还没有 skill</);
  // 页面不再包一层去截断
  assert.doesNotMatch(read("src/Matrix.tsx") + read("src/Matrix.css"), /mx-chiplabel/);
});

// ===== 空态：上面已被占掉的高度 =====

const { Empty } = await import("../src/ui/Empty.tsx");

test("Empty above：有图时图的上沿按机面上沿量，调用方给上面已占的高度；表头下的空态不再用负外距去抵", () => {
  const html = render(Empty, { description: "还没有 skill", art: "emptyFolder", above: 171 });
  assert.match(html, /<div class="ss-empty has-art" style="--empty-above:171px">/);
  // 不给就是紧跟页面头（50）；没有图时不写
  assert.match(
    render(Empty, { description: "x", art: "noDirs" }),
    /<div class="ss-empty has-art">/,
  );
  assert.match(render(Empty, { description: "x", above: 90 }), /^<div class="ss-empty">/);
  assert.match(
    cssRule(uiCss, ".ss-empty.has-art:has(> .ss-empty__art--noDirs)"),
    /padding-top:\s*calc\(230px - var\(--empty-above, 50px\)\)/,
  );
  const domain = read("src/DomainView.tsx");
  assert.match(domain, /above=\{art === "noDirs" \? ABOVE_TABLE : ABOVE_TABLE_WITH_SOURCES\}/);
  assert.doesNotMatch(read("src/Matrix.css"), /mx-emptyart/);
  assert.doesNotMatch(domain, /多选纳入式/);
});

// ===== 等宽读数收节点 =====

const { Mono } = await import("../src/ui/Mono.tsx");

test("Mono 收节点：一段读数里加粗其中几个字仍是一块等宽；path 只对纯文本起作用", () => {
  assert.equal(
    render(Mono, {
      inherit: true,
      children: ["npx -y ", createElement("b", { key: "b" }, "@notionhq"), "/mcp"],
    }),
    '<span class="ss-mono ss-selectable ss-mono--inherit">npx -y <b>@notionhq</b>/mcp</span>',
  );
  assert.doesNotMatch(read("src/McpDiffPanel.tsx"), /<b>\s*<Mono/);
});

// ===== 输入框关联可见标签、面板里的菜单、成功提示条的读数槽、时长 token =====

const { TextField } = await import("../src/ui/TextField.tsx");
const { Menu, MenuItem } = await import("../src/ui/Menu.tsx");
const { Toast } = await import("../src/ui/Toast.tsx");

test("TextField id / labelledBy：有可见标签时读屏名就是它（aria-labelledby），点标签聚焦（htmlFor → id）", () => {
  const html = render(TextField, {
    id: "gw-url",
    labelledBy: "gw-url-label",
    value: "",
    onChange: () => {},
  });
  assert.match(
    html,
    /<input id="gw-url" class="ss-textfield__input" type="text" aria-labelledby="gw-url-label"/,
  );
  assert.doesNotMatch(html, /aria-label=/);
  // 没有可见标签：照旧 aria-label
  assert.match(
    render(TextField, { label: "筛选", value: "", onChange: () => {} }),
    /aria-label="筛选"/,
  );
});

test("Menu context=panel：占满面板宽，不套浮层的 320 上限；浮层里照旧 320", () => {
  const panel = render(Menu, {
    context: "panel",
    label: "Sophia",
    children: createElement(MenuItem, { children: "退出" }),
  });
  assert.match(
    panel,
    /^<div class="ss-menulist ss-menulist--panel" role="menu" aria-label="Sophia">/,
  );
  assert.doesNotMatch(panel, /max-width/);
  const layer = render(Menu, {
    label: "项目排序",
    children: createElement(MenuItem, { children: "名称" }),
  });
  assert.match(layer, /style="max-width:320px"/);
  assert.match(
    render(Menu, {
      context: "panel",
      maxWidth: 280,
      children: createElement(MenuItem, { children: "x" }),
    }),
    /style="max-width:280px"/,
  );
});

test("Toast trail：成功档「名字 · 读数」有正式槽位，不借 reason；档位只由 kind 定（没有 tier）", () => {
  const html = render(Toast, {
    kind: "success",
    verb: "已添加",
    names: ["WeiboAP"],
    trail: ["已筛选出它的 39 个 skill"],
  });
  assert.match(
    html,
    /class="ss-toast__names">WeiboAP<\/span><span class="ss-toast__trail"><span class="ss-toast__sep">·<\/span><span>已筛选出它的 39 个 skill<\/span><\/span>/,
  );
  assert.doesNotMatch(html, /ss-toast__reason/);
  assert.match(cssRule(uiCss, ".ss-toast__trail"), /gap:\s*var\(--space-xs\)/);
  const src = read("src/ui/Toast.tsx");
  assert.doesNotMatch(src, /tier/);
  for (const page of ["src/pages/AddSourcePage.tsx", "src/pages/SettingsPage.tsx"]) {
    assert.doesNotMatch(read(page), /tier=|reason="已建好|reason=\{rest/, page);
  }
});

test("时长 token：行收起 --dur-collapse 200、刚加入闪 --dur-flash 900；CSS 与 JS 都从 token 取", () => {
  const tokens = read("src/tokens.css");
  assert.match(tokens, /--dur-collapse: 200ms;/);
  assert.match(tokens, /--dur-flash: 900ms;/);
  assert.match(tokens, /--dur-collapse: 0ms;/);
  const css = read("src/SourceRow.css");
  assert.match(css, /animation: srcline-leave var\(--dur-collapse\)/);
  assert.match(css, /animation: srcline-flash var\(--dur-flash\)/);
  assert.doesNotMatch(css, /\b(200|900)ms\b/);
  const page = read("src/pages/SourcesPage.tsx");
  assert.match(page, /motionMs\("--dur-collapse"\)/);
  assert.doesNotMatch(page, /LEAVE_MS/);
});
