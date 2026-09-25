import { test } from "node:test";
import assert from "node:assert/strict";

import { outsideTip } from "../src/outsideText.ts";

test("自带与插件都有：提示框报总数并分类", () => {
  assert.deepEqual(outsideTip({ system: 6, plugin: 48 }, "Codex"), [
    "另有 54 个不在列表里：自带 6 · 插件 48",
    "由 Codex 管理，不在这里同步",
  ]);
});

test("只写非零的类", () => {
  assert.deepEqual(outsideTip({ system: 0, plugin: 31 }, "Claude Code")?.[0], "另有 31 个不在列表里：插件 31");
});

test("一个都没有：提示框不加行", () => {
  assert.equal(outsideTip({ system: 0, plugin: 0 }, "Codex"), null);
});
