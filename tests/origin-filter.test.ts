import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { addedOrigins } from "../src/originFilter.ts";

/// R9 去掉了按来源筛选：这个模块只剩 `addedOrigins`（加完来源之后，筛出真的在这个位置有行的那几个 id），
/// 给 SkillsTab / McpTab 算「加完来源之后该闪哪些行、报哪句话」用。别的筛选函数（原来给来源筛选片用的
/// pickOrigin / dropOrigin / liveOrigins / originMatches / filterAfterAdd）已随筛选片一起删掉

test("加完的来源里，重扫后来源列里真有一项的：去重、按加的先后", () => {
  assert.deepEqual(addedOrigins(["b", "a", "b"], ["a", "b", "c"]), ["b", "a"]);
  assert.deepEqual(addedOrigins(["x", "a"], new Set(["a"])), ["a"]);
  assert.deepEqual(addedOrigins(["x"], ["a"]), []);
});

test("加完来源滑回（Skills 与 MCP 同一套）：不再筛选，只有新行的格闪一下", () => {
  for (const file of ["SkillsTab.tsx", "McpTab.tsx"]) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    // 只剩来自 originFilter.ts 的 addedOrigins；筛选状态与 filterAfterAdd 都已删掉
    assert.doesNotMatch(src, /setOriginFilter|filterAfterAdd|\[originFilter,/, file);
    assert.match(src, /setFlash\(\{/, file);
  }
});
