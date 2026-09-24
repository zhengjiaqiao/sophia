import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addedOrigins,
  dropOrigin,
  liveOrigins,
  originMatches,
  toggleOrigin,
} from "../src/originFilter.ts";

test("来源筛选：空＝全部；选中几个时列表是并集（MCP 一行几份定义有一份被选中就算）", () => {
  assert.equal(originMatches([], ["a"]), true);
  assert.equal(originMatches([], []), true);
  assert.equal(originMatches(["a"], ["a"]), true);
  assert.equal(originMatches(["a"], ["b"]), false);
  assert.equal(originMatches(["a", "b"], ["b"]), true);
  assert.equal(originMatches(["a", "b"], ["c", "b"]), true);
  assert.equal(originMatches(["a", "b"], ["c"]), false);
});

test("多选纳入式：点一项纳入、再点去掉，其余选中的不动；全去掉＝不筛（没有 `全部` 项）", () => {
  assert.deepEqual(toggleOrigin([], "a"), ["a"]);
  // 再点一项＝两个来源的行都在
  assert.deepEqual(toggleOrigin(["a"], "b"), ["a", "b"]);
  // 再点选着的＝只去掉它
  assert.deepEqual(toggleOrigin(["a", "b"], "a"), ["b"]);
  // 最后一个也去掉＝回到不筛
  assert.deepEqual(toggleOrigin(["a"], "a"), []);
  // 不改传入的数组
  const before = ["a"];
  toggleOrigin(before, "b");
  assert.deepEqual(before, ["a"]);
});

test("移除一个来源：正选着它就从筛选里去掉，其余选中的照旧（不再回到全部）", () => {
  assert.deepEqual(dropOrigin(["a", "b"], "a"), ["b"]);
  assert.deepEqual(dropOrigin(["b"], "a"), ["b"]);
  assert.deepEqual(dropOrigin([], "a"), []);
});

test("加完来源要选中的项：只取重扫后来源筛选里真有的，去重、按加的先后", () => {
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
