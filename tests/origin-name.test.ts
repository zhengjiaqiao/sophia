import assert from "node:assert/strict";
import test from "node:test";
import { originNames, originText } from "../src/originName.ts";

const base = "/Users/jia/Library/Application Support/ego lite";

test("原件位置显示名：不重名只写来源名，区分片段为空", () => {
  const names = originNames(
    ["a", "b", "a"],
    [
      { id: "a", label: "通用仓库", path: "/Users/jia/.agents/skills" },
      { id: "b", label: "WeiboAP", path: "/Users/jia/WeiboAP/skills" },
    ],
  );
  assert.deepEqual(names.get("a"), { name: "通用仓库", seg: "" });
  assert.equal(originText(names.get("b")!), "WeiboAP");
});

test("原件位置显示名：同名来源拆成来源名 + 区分片段两段，整段写成「名 · 片段」", () => {
  const names = originNames(
    ["x", "y"],
    [
      { id: "x", label: "ego lite", path: `${base}/0.5.0.32/skills` },
      { id: "y", label: "ego lite", path: `${base}/0.5.1.11/skills` },
    ],
  );
  assert.deepEqual(names.get("x"), { name: "ego lite", seg: "0.5.0.32" });
  assert.deepEqual(names.get("y"), { name: "ego lite", seg: "0.5.1.11" });
  assert.equal(originText(names.get("x")!), "ego lite · 0.5.0.32");
});

test("原件位置显示名：区分片段就是名字本身时不重复写；过长的片段截到 10 个字符", () => {
  const names = originNames(
    ["p", "q"],
    [
      { id: "p", label: "WeiboAP", path: "/w/WeiboAP/skills" },
      { id: "q", label: "WeiboAP", path: "/w/WeiboAP/agent_0123456789abcdef/skills" },
    ],
  );
  assert.deepEqual(names.get("p"), { name: "WeiboAP", seg: "" });
  assert.deepEqual(names.get("q"), { name: "WeiboAP", seg: "agent_0123…" });
});

test("原件位置显示名：查不到的来源 id 原样当名字", () => {
  assert.deepEqual(originNames(["ghost"], []).get("ghost"), { name: "ghost", seg: "" });
});
