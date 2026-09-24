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
    onRestore: () => {},
  });
  assert.doesNotMatch(html, /checkbox/);
  assert.match(html, /未安装的 2 个 · 装上后可以在这里勾选显示/);
  assert.match(html, />Amp</);
  assert.doesNotMatch(html, /恢复/);
});

test("在不显示名单里又卸载了的：排在最前，写「装上后也不显示 · 恢复」", () => {
  const html = render(AbsentAgents, {
    agents: [agent("amp", "Amp", true), agent("kiro", "Kiro", false)],
    onRestore: () => {},
  });
  assert.ok(html.indexOf("Kiro") < html.indexOf("Amp"), "不显示名单里的排在最前");
  // `恢复` 是应用内的动作：默认键紧凑 24（浅键只给离开 Sophia 的）。
  // 键外那层 is-idle 包层是 Button 自带的原因提示框层，没禁用时不占盒（display: contents）
  assert.match(
    html,
    /装上后也不显示 ·<\/span><span class="ss-tipwrap is-idle"><button[^>]*class="ss-btn ss-btn--compact"[^>]*>恢复<\/button><\/span>/,
  );
  assert.doesNotMatch(html, /ss-btn--quiet/);
  assert.equal(html.match(/恢复/g)?.length, 1);
  assert.doesNotMatch(html, /checkbox/);
});
