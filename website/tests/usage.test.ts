/// 用量演示的联动逻辑（AC7）：示例数据 + 三项设置 → 菜单栏分段与面板行。
/// 期望值都是照 spec R11 与示例数据手算的字面量，不在测试里再算一遍
import assert from "node:assert/strict";
import test from "node:test";
import { computeUsage, DEFAULT_SETTINGS, toggleAgent, USAGE_SAMPLE } from "../src/demos/usage.ts";

test("默认：两家都列，数字是剩余；Claude 三个窗口、Codex 只有本周", () => {
  const v = computeUsage(DEFAULT_SETTINGS);
  assert.deepEqual(v.tray, [
    { agent: "claude", values: ["58%"] },
    { agent: "codex", values: ["65%"] },
  ]);
  assert.deepEqual(
    v.panel.map((s) => [s.agent, s.plan, s.rows.map((r) => r.window)]),
    [
      ["claude", "Max", ["w5h", "week", "weekFable"]],
      ["codex", "Pro", ["week"]],
    ],
  );
  assert.equal(v.empty, false);
});

test("剩余：面板写「剩」、条是剩余比例；已用：写「用」、条是已用比例", () => {
  const rem = computeUsage(DEFAULT_SETTINGS).panel[0].rows[0];
  assert.deepEqual([rem.kind, rem.value, rem.fill, rem.reset], ["left", "58%", 0.58, "reset5h"]);
  const used = computeUsage({ ...DEFAULT_SETTINGS, mode: "used" });
  const row = used.panel[0].rows[0];
  assert.deepEqual([row.kind, row.value, row.fill], ["used", "42%", 0.42]);
  assert.deepEqual(used.tray[0].values, ["42%"]);
  assert.deepEqual(used.tray[1].values, ["35%"]);
});

test("取消一家：菜单栏与面板都不再列它", () => {
  const v = computeUsage(toggleAgent(DEFAULT_SETTINGS, "claude"));
  assert.deepEqual(
    v.tray.map((s) => s.agent),
    ["codex"],
  );
  assert.deepEqual(
    v.panel.map((s) => s.agent),
    ["codex"],
  );
});

test("两家都取消：什么都不列，标成 empty（面板写「菜单栏没显示用量」）", () => {
  const s = toggleAgent(toggleAgent(DEFAULT_SETTINGS, "claude"), "codex");
  const v = computeUsage(s);
  assert.deepEqual([v.tray, v.panel, v.empty], [[], [], true]);
});

test("叠放：只对有两个以上窗口的那家起作用，上 5 小时、下本周；Codex 仍一行", () => {
  const v = computeUsage({ ...DEFAULT_SETTINGS, stack: true });
  assert.deepEqual(v.tray, [
    { agent: "claude", values: ["58%", "33%"] },
    { agent: "codex", values: ["65%"] },
  ]);
});

test("叠放 + 已用：两行都跟着换", () => {
  const v = computeUsage({ ...DEFAULT_SETTINGS, stack: true, mode: "used" });
  assert.deepEqual(v.tray[0].values, ["42%", "67%"]);
});

test("toggleAgent 不改原对象", () => {
  toggleAgent(DEFAULT_SETTINGS, "codex");
  assert.equal(DEFAULT_SETTINGS.show.codex, true);
});

test("示例数据与 spec 一致：Claude 5 小时 / 本周 / 本周 · Fable，Codex 只有本周", () => {
  assert.deepEqual(
    USAGE_SAMPLE.claude.windows.map((w) => w.id),
    ["w5h", "week", "weekFable"],
  );
  assert.deepEqual(
    USAGE_SAMPLE.codex.windows.map((w) => w.id),
    ["week"],
  );
});
