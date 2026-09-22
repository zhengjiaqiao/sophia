import { test } from "node:test";
import assert from "node:assert/strict";
import { defer, flushAll, pendingCount } from "../src/deferredCommit.ts";

test("撤销后提交什么都不做", async () => {
  let ran = 0;
  const d = defer("a", async () => void ran++);
  d.undo();
  await d.commit();
  assert.equal(ran, 0);
  assert.equal(pendingCount(), 0);
});

test("同 key 再挂一次先提交旧的", async () => {
  const ran: string[] = [];
  defer("k", async () => void ran.push("old"));
  const d = defer("k", async () => void ran.push("new"));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(ran, ["old"]);
  await d.commit();
  await d.commit();
  assert.deepEqual(ran, ["old", "new"]);
});

test("flushAll 提交全部并收集失败", async () => {
  let ok = 0;
  defer("x", async () => void ok++);
  defer("y", async () => {
    throw new Error("写不进");
  });
  const failed = await flushAll();
  assert.equal(ok, 1);
  assert.equal(failed.length, 1);
  assert.equal(pendingCount(), 0);
});
