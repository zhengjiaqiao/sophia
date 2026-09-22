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

test("设置页未安装那一节：信息不是设置——不渲染复选框，小标题说装上后会出现", () => {
  const html = render(AbsentAgents, {
    agents: [agent("amp", "Amp", true), agent("droid", "Droid", true)],
    onRestore: () => {},
  });
  assert.doesNotMatch(html, /checkbox/);
  assert.match(html, /未安装的 2 个 · 装上后会自动出现在列表里/);
  assert.match(html, />Amp</);
  assert.doesNotMatch(html, /恢复/);
});

test("在不显示名单里又卸载了的：排在最前，写「装上后也不显示 · 恢复」", () => {
  const html = render(AbsentAgents, {
    agents: [agent("amp", "Amp", true), agent("kiro", "Kiro", false)],
    onRestore: () => {},
  });
  assert.ok(html.indexOf("Kiro") < html.indexOf("Amp"), "不显示名单里的排在最前");
  assert.match(
    html,
    /装上后也不显示 ·<\/span><button[^>]*class="ss-btn ss-btn--link"[^>]*>恢复<\/button>/,
  );
  assert.equal(html.match(/恢复/g)?.length, 1);
  assert.doesNotMatch(html, /checkbox/);
});
