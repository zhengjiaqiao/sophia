/// 用量演示的标记：同一份函数既给 Astro 出静态默认态，也给客户端脚本重画，所以要稳、要转义文案
import assert from "node:assert/strict";
import test from "node:test";
import { computeUsage, DEFAULT_SETTINGS } from "../src/demos/usage.ts";
import { renderPanel, renderTray, type UsageLabels } from "../src/demos/usageHtml.ts";

const labels: UsageLabels = {
  none: "NONE",
  left: "L [[pct]]",
  usedPct: "U [[pct]]",
  windows: { w5h: "W5", week: "WK", weekFable: "WF" },
  resets: { reset5h: "R5", resetWeek: "RW", resetCodexWeek: "RC" },
  agents: { claude: "Claude", codex: "Codex" },
};

test("面板：每家一节、每个窗口一行，写「剩」与重置时间，条按比例填", () => {
  const html = renderPanel(computeUsage(DEFAULT_SETTINGS), labels);
  assert.equal((html.match(/class="meter"/g) ?? []).length, 4);
  assert.match(html, /L 58%/);
  assert.match(html, /R5/);
  assert.match(html, /scaleX\(0\.58\)/);
  assert.match(html, /<hr>/);
  assert.doesNotMatch(html, /NONE/);
});

test("面板：已用模式写「用」", () => {
  const html = renderPanel(computeUsage({ ...DEFAULT_SETTINGS, mode: "used" }), labels);
  assert.match(html, /U 42%/);
  assert.doesNotMatch(html, /L \d/);
});

test("面板：两家都不选时只写一句「菜单栏没显示用量」", () => {
  const html = renderPanel(computeUsage({ ...DEFAULT_SETTINGS, show: { claude: false, codex: false } }), labels);
  assert.match(html, /NONE/);
  assert.doesNotMatch(html, /meter/);
});

test("菜单栏：叠放时 Claude 两行、Codex 一行；文案里的尖括号被转义", () => {
  const html = renderTray(computeUsage({ ...DEFAULT_SETTINGS, stack: true }));
  assert.match(html, /<b class="stk"><span>58%<\/span><span>33%<\/span><\/b>/);
  assert.match(html, /<b>65%<\/b>/);
  const evil = renderPanel(computeUsage(DEFAULT_SETTINGS), { ...labels, none: "x", windows: { ...labels.windows, w5h: "<i>" } });
  assert.doesNotMatch(evil, /<i>/);
  assert.match(evil, /&lt;i&gt;/);
});
