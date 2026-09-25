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
