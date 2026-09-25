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
