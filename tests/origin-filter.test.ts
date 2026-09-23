import { test } from "node:test";
import assert from "node:assert/strict";

import {
  liveOrigins,
  addedOrigins,
  newOriginKey,
  originMatches,
  pickOrigin,
} from "../src/originFilter.ts";

test("来源筛选：空＝全部；选中几片时列表是并集（MCP 一行几份定义有一份被选中就算）", () => {
  assert.equal(originMatches([], ["a"]), true);
  assert.equal(originMatches([], []), true);
  assert.equal(originMatches(["a"], ["a"]), true);
  assert.equal(originMatches(["a"], ["b"]), false);
  assert.equal(originMatches(["a", "b"], ["b"]), true);
  assert.equal(originMatches(["a", "b"], ["c", "b"]), true);
  assert.equal(originMatches(["a", "b"], ["c"]), false);
});

test("用户点片仍是单选：点一片只选它；再点单独选中的那片、或点全部，回到全部", () => {
  assert.deepEqual(pickOrigin([], "a"), ["a"]);
  assert.deepEqual(pickOrigin(["a"], "b"), ["b"]);
  assert.deepEqual(pickOrigin(["a"], "a"), []);
  // 加完来源选中了几片：点其中一片＝只留它，不是取消它
  assert.deepEqual(pickOrigin(["a", "b"], "a"), ["a"]);
  assert.deepEqual(pickOrigin(["a", "b"], "c"), ["c"]);
  assert.deepEqual(pickOrigin(["a", "b"], null), []);
});

test("加完来源要选中的片：只取重扫后工具行真有的，去重、按加的先后", () => {
  assert.deepEqual(addedOrigins(["b", "a", "b"], ["a", "b", "c"]), ["b", "a"]);
  assert.deepEqual(addedOrigins(["x", "a"], new Set(["a"])), ["a"]);
  assert.deepEqual(addedOrigins(["x"], ["a"]), []);
});

test("「新」按位置记：同一个来源在另一个位置不算新", () => {
  assert.notEqual(newOriginKey("global", "/s"), newOriginKey("project:/p", "/s"));
  assert.equal(newOriginKey("global", "/s"), newOriginKey("global", "/s"));
});

test("liveOrigins：筛过的来源没了片（被移除、换了项目），回到全部，不筛出空表", () => {
  assert.deepEqual(liveOrigins([], ["a", "b"]), []);
  assert.deepEqual(liveOrigins(["a"], ["a", "b"]), ["a"]);
  assert.deepEqual(liveOrigins(["gone"], ["a", "b"]), []);
  assert.deepEqual(liveOrigins(["gone", "b"], ["a", "b"]), ["b"]);
});
