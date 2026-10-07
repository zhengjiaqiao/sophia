/// 下载区「复制」键的逻辑（spec R12、AC8）：写进剪贴板就报「已复制」；写不进（没有剪贴板接口、被拒绝）
/// 就选中命令、改说「按 ⌘C 复制」，不谎报已复制
import assert from "node:assert/strict";
import test from "node:test";
import { copyCommand } from "../src/lib/copyCommand.ts";

test("剪贴板可写：写入命令，结果是 copied，不动选区", async () => {
  const written: string[] = [];
  let selected = 0;
  const r = await copyCommand("brew install x", {
    writeText: async (t) => void written.push(t),
    select: () => void selected++,
  });
  assert.equal(r, "copied");
  assert.deepEqual(written, ["brew install x"]);
  assert.equal(selected, 0);
});

test("剪贴板被拒绝：选中命令，结果是 manual", async () => {
  let selected = 0;
  const r = await copyCommand("cmd", {
    writeText: async () => {
      throw new Error("denied");
    },
    select: () => void selected++,
  });
  assert.equal(r, "manual");
  assert.equal(selected, 1);
});

test("没有剪贴板接口（非安全上下文、旧浏览器）：选中命令，结果是 manual", async () => {
  let selected = 0;
  const r = await copyCommand("cmd", { writeText: undefined, select: () => void selected++ });
  assert.equal(r, "manual");
  assert.equal(selected, 1);
});
