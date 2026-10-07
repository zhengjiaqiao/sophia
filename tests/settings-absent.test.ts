import { test } from "node:test";
import assert from "node:assert/strict";

import { render } from "./ui-render.ts";

const { AbsentAgents } = await import("../src/pages/AbsentAgents.tsx");

const agent = (id: string, displayName: string, enabled: boolean) => ({
  id,
  displayName,
  enabled,
  installed: false,
});

test("设置页未安装那一节：信息不是设置——不渲染复选框，小标题说装上后可以在这里勾选", () => {
  const html = render(AbsentAgents, {
    agents: [agent("amp", "Amp", true), agent("droid", "Droid", true)],
  });
  assert.doesNotMatch(html, /checkbox/);
  // 小标是组件库的区块小标（与设置页的节小标同一种）；「未安装的 N 个」已在展开行上说过（①）
  assert.match(html, /class="ss-sectionlabel"><span class="ss-sectionlabel__text">装上后可以在这里勾选显示</);
  assert.match(html, />Amp</);
  assert.doesNotMatch(html, /恢复/);
});

// 2026-10-07：没有「不显示标记」——勾选与否只对已安装的有意义，未安装的一律只列名字，
// 不写「装上后也不显示 · 恢复」，按 agent 表的先后排
test("未安装的只列名字：不写「装上后也不显示」、没有「恢复」键，按传入先后排", () => {
  const html = render(AbsentAgents, {
    agents: [agent("amp", "Amp", true), agent("kiro", "Kiro", false)],
  });
  assert.ok(html.indexOf("Amp") < html.indexOf("Kiro"));
  assert.doesNotMatch(html, /装上后也不显示|恢复|<button/);
});

// 2026-10-06 设置页并节：`显示的 agent` 是一条设置行，名单紧跟在行下，行连同名单是一块；
// 「未安装的 N 个」字在前、拉手在后；名单下那行「MCP 页只显示…」并进了灰字
test("设置页 `显示的 agent` 一块：设置行（灰字说上限与 MCP 页）+ 名单；「未安装的 N 个 ›」字在前、拉手在后", async () => {
  const { readFileSync } = await import("node:fs");
  const { withCopy } = await import("./copy.ts");
  const src = withCopy(
    readFileSync(new URL("../src/pages/SettingsPage.tsx", import.meta.url), "utf8"),
  );
  const at = src.search(/<SettingRow\s+label="显示的 agent"/);
  assert.ok(at > 0);
  const block = src.slice(at);
  assert.match(
    block,
    /^<SettingRow\s+label="显示的 agent"\s+note=\{list \? t\("最多显示 \{max\} 个 · MCP 页只显示其中支持 MCP 的", \{ max: maxShown \}\) : undefined\}\s*\/>/,
  );
  // 字在前、拉手在后
  const more = block.slice(block.indexOf('<div className="settings-page__more">'));
  assert.ok(more.indexOf("settings-page__more-label") < more.indexOf("<DrawerHandle"));
  assert.match(more, /controls="settings-absent"/);
  assert.doesNotMatch(src, /settings-page__mcp-note|列表里的 agent/);
  // 左栏不限宽；块与块、块与设置行之间一道行线
  const css = readFileSync(new URL("../src/pages/SettingsPage.css", import.meta.url), "utf8");
  assert.match(css, /\.settings-page__text \{\s*min-width: 0;\s*\}/);
  assert.match(
    css,
    /\.settings-page__block \+ \.settings-page__block,\s*\.settings-page__block \+ \.settings-page__row,\s*\.settings-page__row \+ \.settings-page__block \{\s*border-top: var\(--border-row\);/,
  );
});
