import { test } from "node:test";
import assert from "node:assert/strict";

import { columnsOf, defaultTargets, sameSet } from "../src/pages/importDefaults.ts";

test("默认目标：上次用的（只留现在还在的），没有上次则前两个", () => {
  assert.deepEqual(defaultTargets(["cc", "codex", "cursor"], undefined), ["cc", "codex"]);
  assert.deepEqual(defaultTargets(["cc", "codex", "cursor"], ["cursor"]), ["cursor"]);
  assert.deepEqual(defaultTargets(["cc", "codex"], ["gone", "codex"]), ["codex"]);
  assert.deepEqual(defaultTargets(["cc", "codex"], ["gone"]), ["cc", "codex"]);
  assert.deepEqual(defaultTargets([], ["gone"]), []);
});

test("同一组目标与顺序无关；按列切", () => {
  assert.ok(sameSet(["a", "b"], ["b", "a"]));
  assert.ok(!sameSet(["a"], ["a", "b"]));
  assert.deepEqual(columnsOf([1, 2, 3, 4, 5], 2), [
    [1, 2, 3],
    [4, 5],
  ]);
});
