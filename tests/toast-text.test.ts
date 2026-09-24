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

test("单格例行一行省名字：行里已写着对象，只写动词 + agent 图标", () => {
  const on = toastFor("link", { done: [{ name: "docx", agent: codex }], omitNames: true });
  assert.deepEqual(on.names, []);
  assert.equal(on.verb, "加到");
  assert.deepEqual(on.agents, [codex]);
  const off = toastFor("unlink", { done: [{ name: "docx", agent: codex }], omitNames: true });
  assert.equal(off.verb, "从");
  assert.equal(off.verbTail, "移除");
  assert.deepEqual(off.names, []);
  assert.deepEqual(
    toastFor("write", { done: [{ name: "notion", agent: cc }], omitNames: true }).names,
    [],
  );
});

test("全部没成：黑窗 + 否定动词 + 一句原因（失败里写「加到」会被读成已加上）", () => {
  const t = toastFor("link", {
    done: [],
    failed: [{ name: "defuddle", agent: codex, reason: "无法写入 Codex 的 skills 目录" }],
  });
  assert.equal(t.tier, "notice");
  assert.equal(t.kind, "cannot");
  assert.equal(t.verb, "没加上");
  assert.equal(
    toastFor("unlink", { done: [], failed: [{ name: "x", reason: "r" }] }).verb,
    "没移除",
  );
  assert.equal(t.reason, "无法写入 Codex 的 skills 目录");
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

test("所有成功都是例行一行（含只留这份、自动规则）；黑窗只给失败。只留这份把来源拼进名字", () => {
  const keep = toastFor("keepThis", { done: [{ name: "defuddle" }], keepLabel: "通用仓库" });
  assert.equal(keep.tier, "routine");
  assert.equal(keep.verb, "只留");
  assert.deepEqual(keep.names, ["通用仓库 的 defuddle"]);
  assert.equal(toastFor("autoLink", { done: [{ name: "x" }] }).tier, "routine");
  assert.equal(toastFor("autoWrite", { done: [{ name: "x" }] }).tier, "routine");
  // 失败照旧黑窗
  const failed = [{ name: "x", reason: "r" }];
  assert.equal(toastFor("keepThis", { done: [], failed }).tier, "notice");
  assert.equal(toastFor("autoLink", { done: [{ name: "y" }], failed }).tier, "notice");
  assert.equal(toastFor("autoLink", { done: [{ name: "x" }] }).verb, "自动加到");
  assert.equal(toastFor("autoWrite", { done: [{ name: "x" }] }).verb, "自动写进");
});

test("只留这份的确认框：标题问留哪份；正文写哪份进废纸篓、几条链接改指，没有就不写后半句", async () => {
  const { keepThisConfirm } = await import("../src/toastText.ts");
  const base = {
    kept: { name: "通用仓库", seg: "", path: "/Users/jia/.agents/skills/defuddle" },
    other: { name: "WeiboAP", seg: "", path: "/Users/jia/WeiboAP/skills/defuddle" },
    skill: "defuddle",
  };
  const t = keepThisConfirm({ ...base, relinked: 3 });
  assert.equal(t.title, "只留 通用仓库 的 defuddle？");
  assert.equal(t.body, "WeiboAP 那份移到废纸篓，3 条链接改指到这一份");
  assert.equal(keepThisConfirm({ ...base, relinked: 0 }).body, "WeiboAP 那份移到废纸篓");
});

test("只留这份的确认框：标题下两行写两份的完整路径，主目录写 ~，不截断", async () => {
  const { keepThisConfirm } = await import("../src/toastText.ts");
  const { setHome } = await import("../src/pathText.ts");
  setHome("/Users/jia");
  const long = `/Users/jia/${"very-long-folder/".repeat(8)}skills/defuddle`;
  const t = keepThisConfirm({
    kept: { name: "通用仓库", seg: "", path: "/Users/jia/.agents/skills/defuddle" },
    other: { name: "WeiboAP", seg: "", path: long },
    skill: "defuddle",
    relinked: 0,
  });
  assert.deepEqual(t.paths, [
    { label: "留下", path: "~/.agents/skills/defuddle" },
    { label: "移到废纸篓", path: `~/${"very-long-folder/".repeat(8)}skills/defuddle` },
  ]);
  setHome(null);
});

test("只留这份的确认框：同名来源在标题和后果句里用区分片段", async () => {
  const { keepThisConfirm } = await import("../src/toastText.ts");
  const t = keepThisConfirm({
    kept: { name: "ego lite", seg: "0.5.1.11", path: "/e/0.5.1.11/skills/ego-browser" },
    other: { name: "ego lite", seg: "0.5.0.32", path: "/e/0.5.0.32/skills/ego-browser" },
    skill: "ego-browser",
    relinked: 2,
  });
  assert.equal(t.title, "只留 ego lite · 0.5.1.11 的 ego-browser？");
  assert.equal(t.body, "ego lite · 0.5.0.32 那份移到废纸篓，2 条链接改指到这一份");
});

test("拆开的确认框：标题问拆哪个 agent 的 skills 文件夹，正文说后果", async () => {
  const { splitConfirm } = await import("../src/toastText.ts");
  assert.deepEqual(splitConfirm("Codex"), {
    title: "拆开 Codex 的 skills 文件夹？",
    body: "把链接换成真文件夹，里面的内容原样复制过来",
  });
});

test("拆开成功：例行一行 `拆开 [Codex] 的 skills 文件夹`，走 routine，不带撤销（拆开不是可逆的开关）", () => {
  const t = toastFor("split", { done: [{ name: "的 skills 文件夹", agent: codex }] });
  assert.equal(t.tier, "routine");
  assert.equal(t.kind, "success");
  assert.equal(t.verb, "拆开");
  assert.deepEqual(t.names, ["的 skills 文件夹"]);
  assert.deepEqual(
    t.agents.map((a) => a.id),
    ["codex"],
  );
  // 全部没成时否定动词：没拆开
  assert.equal(
    toastFor("split", { done: [], failed: [{ name: "x", reason: "r" }] }).verb,
    "没拆开",
  );
});
