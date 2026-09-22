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

test("一次只挂一个撤销：挂第二笔前先提交第一笔，离开时提交还挂着的", async () => {
  const { defer, pendingCount } = await import("../src/deferredCommit.ts");
  const { undoSlot } = await import("../src/pages/importDefaults.ts");
  const ran: string[] = [];
  const slot = undoSlot();

  // 第一笔：换一个来源前挂着
  slot.hold(defer("replace:global:/a", async () => void ran.push("a")));
  // 第二笔（另一个来源，key 不同，defer 自己不会顶掉第一笔）：先 flush 再挂
  await slot.flush();
  assert.deepEqual(ran, ["a"]);
  slot.hold(defer("replace:global:/b", async () => void ran.push("b")));
  assert.equal(pendingCount(), 1);

  // 撤销过的不再提交
  slot.undo();
  await slot.flush();
  assert.deepEqual(ran, ["a"]);
  assert.equal(pendingCount(), 0);

  // 离开页面：还挂着的那一笔提交；提交失败原样抛给调用方（ImportPage 交给 onError）
  slot.hold(
    defer("replace:global:/c", async () => {
      throw new Error("写不进去");
    }),
  );
  await assert.rejects(slot.flush(), /写不进去/);
  assert.equal(pendingCount(), 0);
  await slot.flush();
});

test("同名来源：只挑出路径里不同的那一级", async () => {
  const { distinguishingSegments } = await import("../src/pages/importDefaults.ts");
  const base = "/Users/me/Library/Application Support/WeiboAP";
  assert.deepEqual(
    distinguishingSegments([`${base}/alpha/skills`, `${base}/beta/skills`, `${base}/gamma/skills`]),
    ["alpha", "beta", "gamma"],
  );
  // 各自取第一个与别人在同一位置上都不同的那一级（只一级，不拼接）
  assert.deepEqual(distinguishingSegments(["/a/x/one/s", "/b/x/two/s", "/b/y/one/s"]), [
    "a",
    "two",
    "y",
  ]);
  // 真机的情形：一个项目里的 WeiboAP 和两个应用数据目录里的
  assert.deepEqual(distinguishingSegments(["/w", `${base}/alpha/skills`, `${base}/beta/skills`]), [
    "w",
    "alpha",
    "beta",
  ]);
  // 结尾不同就直接是结尾
  assert.deepEqual(distinguishingSegments(["/p/q/skills", "/p/q/skills-2"]), [
    "skills",
    "skills-2",
  ]);
  // 只有一条：不需要区分
  assert.deepEqual(distinguishingSegments(["/only/one"]), [""]);
  // 反斜杠也认
  assert.deepEqual(distinguishingSegments(["C:\\a\\one\\s", "C:\\a\\two\\s"]), ["one", "two"]);
});
