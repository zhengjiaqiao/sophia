import { test } from "node:test";
import assert from "node:assert/strict";

import { outsideTip } from "../src/outsideText.ts";

test("自带与插件都有：+N 是两者之和，提示框分类报数", () => {
  assert.deepEqual(outsideTip({ system: 6, plugin: 48 }, "Codex"), {
    more: 54,
    lines: ["另有 54 个不在列表里：自带 6 · 插件 48", "由 Codex 管理，不在这里同步"],
  });
});

test("只写非零的类", () => {
  assert.deepEqual(outsideTip({ system: 0, plugin: 31 }, "Claude Code")?.lines[0], "另有 31 个不在列表里：插件 31");
});

test("一个都没有：不出 +N", () => {
  assert.equal(outsideTip({ system: 0, plugin: 0 }, "Codex"), null);
});
