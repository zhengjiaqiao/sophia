import { test } from "node:test";
import assert from "node:assert/strict";
import { t as say } from "../src/i18n.ts";

import {
  addFailureToast,
  addLabel,
  addedParts,
  addSourceTitle,
  alreadySubscribedText,
  checkedEntries,
  countText,
  folderWithoutSkills,
  noSkillCandidates,
  nothingChecked,
  pickHint,
  pickedBlocked,
  pickedHead,
  pickedLine,
  pickedRef,
  rowMeta,
  sameNameItems,
  sameNameTip,
  suggestedLabel,
  type CandidateEntry,
  type PickedState,
} from "../src/pages/addSourceView.ts";

const cardbox = { key: "project:/Users/me/CardBox", label: "CardBox" };
const global = { key: "global", label: "用户级" };

const entry = (ref: string, count = 1): CandidateEntry => ({
  ref,
  name: ref,
  sub: "~/x",
  count,
  items: Array.from({ length: count }, (_, i) => ({ name: `s${i}` })),
});

test("页名与固定文案：skill 与 MCP 两种，用户级写「用户级」", () => {
  assert.equal(addSourceTitle(cardbox, "skill"), "添加原件位置到 CardBox");
  assert.equal(addSourceTitle(global, "skill"), "添加原件位置到用户级");
  assert.equal(addSourceTitle(cardbox, "mcp"), "添加 MCP 来源到 CardBox");
  assert.equal(alreadySubscribedText(cardbox), "它已经在 CardBox 的原件位置里");
  assert.equal(pickHint(), "选 skill 所在的文件夹，只认带 SKILL.md 的子目录");
  assert.equal(pickedHead(), "你选的文件夹");
  assert.equal(suggestedLabel("skill"), "建议的原件位置");
  assert.equal(suggestedLabel("MCP"), "建议的配置文件");
  assert.equal(noSkillCandidates(), "别处还没有可加的原件位置");
  assert.equal(folderWithoutSkills(), "这个文件夹里没有 skill，只认带 SKILL.md 的子目录");
});

test("数量带单位：`39 个 skill`、`3 个 MCP`", () => {
  assert.equal(countText(39, "skill"), "39 个 skill");
  assert.equal(countText(3, "MCP"), "3 个 MCP");
  assert.equal(countText(0, "skill"), "0 个 skill");
});

test("同名：与任一已订阅来源里的 skill 同名的挂 `同名` 并带悬停说明，其余不挂", () => {
  assert.deepEqual(sameNameItems(["docx", "figma", "notion"], [["docx"], ["figma", "x"]]), [
    { name: "docx", tag: { text: "同名", tip: sameNameTip() } },
    { name: "figma", tag: { text: "同名", tip: sameNameTip() } },
    { name: "notion" },
  ]);
  assert.deepEqual(sameNameItems(["a"], []), [{ name: "a" }]);
});

test("第二行：前半段与来源管理页一字不差（出处 · N 个 skill），尾部接外露的名字；没有名字只写前半段", () => {
  const items = sameNameItems(["excalidraw", "notion", "pdf"], [["notion"]]);
  assert.equal(
    rowMeta("~/.agents/skills", 3, "skill", items),
    "~/.agents/skills · 3 个 skill · excalidraw、notion、pdf",
  );
  assert.equal(
    rowMeta("weibo_assistant 在用", 0, "skill", []),
    "weibo_assistant 在用 · 0 个 skill",
  );
  assert.equal(
    rowMeta("other", 2, "MCP", [{ name: "figma" }, { name: "notion" }]),
    "other · 2 个 MCP · figma、notion",
  );
});

test("选的文件夹那一行：读的时候转圈；读不到 / 已订阅 / 没有 skill 时方框禁用、第二行与提示框同一句", () => {
  const loading: PickedState = { status: "loading", ref: "/p", name: "p", sub: "~/p" };
  assert.equal(pickedRef(loading), "/p");
  assert.deepEqual(pickedLine(loading, cardbox, "skill"), { kind: "loading" });
  assert.equal(pickedBlocked(loading, cardbox), "正在读文件夹");

  const failed: PickedState = {
    status: "failed",
    ref: "/p",
    name: "p",
    sub: "~/p",
    reason: "没有权限",
  };
  assert.equal(pickedBlocked(failed, cardbox), "无法读取这个文件夹：没有权限");
  assert.deepEqual(pickedLine(failed, cardbox, "skill"), {
    kind: "message",
    text: "无法读取这个文件夹：没有权限",
  });

  const already: PickedState = { status: "ready", entry: entry("/p", 2), already: true };
  assert.equal(pickedRef(already), "/p");
  assert.equal(pickedBlocked(already, cardbox), "它已经在 CardBox 的原件位置里");

  const empty: PickedState = { status: "ready", entry: entry("/p", 0), already: false };
  assert.equal(pickedBlocked(empty, cardbox), folderWithoutSkills());
  assert.deepEqual(pickedLine(empty, cardbox, "skill"), {
    kind: "message",
    text: folderWithoutSkills(),
  });

  const ok: PickedState = { status: "ready", entry: entry("/p", 2), already: false };
  assert.equal(pickedBlocked(ok, cardbox), null);
  assert.deepEqual(pickedLine(ok, cardbox, "skill"), {
    kind: "meta",
    text: "~/x · 2 个 skill · s0、s1",
  });
});

test("要加的：按列表先后，选的文件夹在前；不能勾的选的文件夹不算；没勾的不算", () => {
  const a = entry("/a");
  const b = entry("/b");
  const p = entry("/p", 2);
  const ok: PickedState = { status: "ready", entry: p, already: false };
  assert.deepEqual(checkedEntries(new Set(["/b", "/p", "/a"]), ok, [a, b], cardbox), [p, a, b]);
  assert.deepEqual(checkedEntries(new Set(["/b"]), ok, [a, b], cardbox), [b]);
  assert.deepEqual(checkedEntries(new Set(), ok, [a, b], cardbox), []);
  const empty: PickedState = { status: "ready", entry: entry("/p", 0), already: false };
  assert.deepEqual(checkedEntries(new Set(["/p", "/a"]), empty, [a, b], cardbox), [a]);
  const loading: PickedState = { status: "loading", ref: "/p", name: "p", sub: "~/p" };
  assert.deepEqual(checkedEntries(new Set(["/p"]), loading, [a], cardbox), []);
  // 空来源照样能加：以后新出现的 skill 还能自动加
  const zero = entry("/z", 0);
  assert.deepEqual(checkedEntries(new Set(["/z"]), null, [zero], cardbox), [zero]);
});

test("底部主动作：skill `添加 N 个原件位置`（MCP 是 `个配置文件`），一个没勾时写 `添加原件位置`、禁用原因「先勾选要加的原件位置」", () => {
  assert.equal(addLabel(0, "skill"), "添加原件位置");
  assert.equal(addLabel(1, "skill"), "添加 1 个原件位置");
  assert.equal(addLabel(3, "MCP"), "添加 3 个配置文件");
  assert.equal(nothingChecked("skill"), "先勾选要加的原件位置");
  assert.equal(nothingChecked("MCP"), "先勾选要加的配置文件");
});

test("加完的提示：全成不出；全没成＝做不成；部分成＝部分失败带读数；名字只写没加上的（名字在前、接「失败」）", () => {
  assert.equal(addFailureToast(["/a"], []), null);
  assert.deepEqual(addFailureToast([], [{ name: "A", reason: "没有权限" }]), {
    kind: "cannot",
    sentence: "sources.add.cannot",
    names: ["A"],
    reason: "没有权限",
  });
  // 名字在前、句尾「失败」：整句自己写好，不靠 Toast 接
  assert.equal(say("sources.add.cannot", { names: "A" }), "A 添加失败");
  assert.deepEqual(
    addFailureToast(
      ["/a", "/b"],
      [
        { name: "C", reason: "目录不见了" },
        { name: "D", reason: "没有权限" },
      ],
    ),
    {
      kind: "partial",
      sentence: "sources.add.partial",
      names: ["C", "D"],
      tally: { done: 2, failed: 2 },
      reason: "目录不见了",
    },
  );
});

test("全加上滑回主视图的那一窗：说清楚列表为什么变少了——已筛选出它 / 它们的 N 个，数量带名词", () => {
  const line = (parts: string[]) => ["已添加", parts.join(" · ")].join(" ");
  assert.equal(
    line(addedParts(["WeiboAP"], 39, "skill", true)),
    "已添加 WeiboAP · 已筛选出它的 39 个 skill",
  );
  assert.equal(
    line(addedParts(["WeiboAP", "通用仓库"], 41, "skill", true)),
    "已添加 2 个原件位置 · 已筛选出它们的 41 个 skill",
  );
  assert.deepEqual(addedParts(["Claude Code · User"], 3, "MCP", true), [
    "Claude Code · User",
    "已筛选出它的 3 个 MCP",
  ]);
  // 新来源在这个位置下一行都没有：没筛，只交代加上了
  assert.equal(line(addedParts(["WeiboAP"], 39, "skill", false)), "已添加 WeiboAP · 39 个 skill");
});
