import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  addedOrigins,
  dropOrigin,
  filterAfterAdd,
  liveOrigins,
  originMatches,
  pickOrigin,
} from "../src/originFilter.ts";

test("来源筛选：空＝全部；MCP 一行几份定义有一份被选中就算", () => {
  assert.equal(originMatches([], ["a"]), true);
  assert.equal(originMatches([], []), true);
  assert.equal(originMatches(["a"], ["a"]), true);
  assert.equal(originMatches(["a"], ["b"]), false);
  assert.equal(originMatches(["a", "b"], ["b"]), true);
  assert.equal(originMatches(["a", "b"], ["c", "b"]), true);
  assert.equal(originMatches(["a", "b"], ["c"]), false);
});

test("单选 + `全部`：点一颗＝只看这个来源（换一颗就换过去，不叠加）；点 `全部` 回到不筛；再点选中的不变", () => {
  assert.deepEqual(pickOrigin("a"), ["a"]);
  assert.deepEqual(pickOrigin("b"), ["b"]);
  assert.deepEqual(pickOrigin(null), []);
  // 源码里不再有多选纳入式
  const src = readFileSync(new URL("../src/originFilter.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /toggleOrigin/);
});

test("加完来源滑回：只加了一个就选中它；加了几个（或新来源一行都没有）停在 `全部`", () => {
  assert.deepEqual(filterAfterAdd(["a"]), ["a"]);
  assert.deepEqual(filterAfterAdd(["a", "b"]), []);
  assert.deepEqual(filterAfterAdd([]), []);
});

test("移除一个来源：正选着它就回到全部，选着别的照旧", () => {
  assert.deepEqual(dropOrigin(["a"], "a"), []);
  assert.deepEqual(dropOrigin(["b"], "a"), ["b"]);
  assert.deepEqual(dropOrigin([], "a"), []);
});

test("加完的来源里，重扫后来源筛选里真有一项的：去重、按加的先后", () => {
  assert.deepEqual(addedOrigins(["b", "a", "b"], ["a", "b", "c"]), ["b", "a"]);
  assert.deepEqual(addedOrigins(["x", "a"], new Set(["a"])), ["a"]);
  assert.deepEqual(addedOrigins(["x"], ["a"]), []);
});

test("liveOrigins：筛过的来源没了（被移除、换了项目），自动去掉，其余照旧；不筛出空表", () => {
  assert.deepEqual(liveOrigins([], ["a", "b"]), []);
  assert.deepEqual(liveOrigins(["a"], ["a", "b"]), ["a"]);
  assert.deepEqual(liveOrigins(["gone"], ["a", "b"]), []);
  assert.deepEqual(liveOrigins(["gone", "b"], ["a", "b"]), ["b"]);
});

test("加完来源滑回（Skills 与 MCP 同一套）：按 filterAfterAdd 选；停在 `全部` 时新行的格闪一下", () => {
  for (const file of ["SkillsTab.tsx", "McpTab.tsx"]) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.match(src, /const pick = filterAfterAdd\(ids\);/, file);
    assert.match(
      src,
      /setOriginFilter\(pick\);\s*[^]*?if \(pick\.length === 0\)\s*setFlash\(\{/,
      file,
    );
  }
});
