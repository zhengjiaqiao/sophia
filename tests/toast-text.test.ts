import assert from "node:assert/strict";
import test from "node:test";
import { toastFor } from "../src/toastText.ts";

const cc = { id: "claude-code", name: "Claude Code" };
const codex = { id: "codex", name: "Codex" };

test("例行成功：动词与键一致，走 routine 一行字，名字与图标去重保序", () => {
  const t = toastFor("write", {
    done: [
      { name: "excalidraw", agent: codex },
      { name: "notion", agent: codex },
      { name: "excalidraw", agent: cc },
    ],
  });
  assert.equal(t.tier, "routine");
  assert.equal(t.kind, "success");
  assert.equal(t.verb, "写进");
  assert.deepEqual(t.names, ["excalidraw", "notion"]);
  assert.deepEqual(
    t.agents.map((a) => a.id),
    ["codex", "claude-code"],
  );
  // 动词带方向：加到 [图标] 名字 / 从 [图标] 移除 名字（后半截在 verbTail）
  const off = toastFor("unlink", { done: [{ name: "x" }] });
  assert.equal(off.verb, "从");
  assert.equal(off.verbTail, "移除");
  const on = toastFor("link", { done: [{ name: "x" }] });
  assert.equal(on.verb, "加到");
  assert.equal(on.verbTail, undefined);
});

test("全部没成：黑窗 + 否定动词 + 一句原因（失败里写「加到」会被读成已加上）", () => {
  const t = toastFor("link", {
    done: [],
    failed: [{ name: "defuddle", agent: codex, reason: "Codex 的 skills 目录写不进去" }],
  });
  assert.equal(t.tier, "notice");
  assert.equal(t.kind, "cannot");
  assert.equal(t.verb, "没加上");
  assert.equal(
    toastFor("unlink", { done: [], failed: [{ name: "x", reason: "r" }] }).verb,
    "没移除",
  );
  assert.equal(t.reason, "Codex 的 skills 目录写不进去");
  assert.deepEqual(t.names, ["defuddle"]);
});

test("部分失败：黑窗 + 肯定动词 + 读数 + 第一条原因", () => {
  const t = toastFor("write", {
    done: [{ name: "a" }, { name: "b" }],
    failed: [{ name: "c", reason: "读不出来" }],
  });
  assert.equal(t.tier, "notice");
  assert.equal(t.kind, "partial");
  assert.equal(t.verb, "写进");
  assert.deepEqual(t.tally, { done: 2, failed: 1 });
  assert.equal(t.reason, "读不出来");
  // skill 的部分失败汇总用不带方向的动词：加上 2 ✓ · 1 ⊘
  const mixed = toastFor("link", {
    done: [{ name: "a" }, { name: "b" }],
    failed: [{ name: "c", reason: "r" }],
  });
  assert.equal(mixed.verb, "加上");
  assert.equal(mixed.verbTail, undefined);
});

test("可撤销的删除与自动发生的事成功时也走黑窗；只留这份把来源拼进名字", () => {
  const keep = toastFor("keepThis", { done: [{ name: "defuddle" }], keepLabel: "通用仓库" });
  assert.equal(keep.tier, "notice");
  assert.equal(keep.verb, "只留");
  assert.deepEqual(keep.names, ["通用仓库 的 defuddle"]);
  assert.equal(toastFor("autoLink", { done: [{ name: "x" }] }).tier, "notice");
  assert.equal(toastFor("autoLink", { done: [{ name: "x" }] }).verb, "自动加到");
  assert.equal(toastFor("autoWrite", { done: [{ name: "x" }] }).verb, "自动写进");
});
