import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FOLDER_WITHOUT_SKILLS,
  NOTHING_CHECKED,
  NO_SKILL_CANDIDATES,
  PICK_HINT,
  PICKED_HEAD,
  SAME_NAME_TIP,
  SUGGESTED_LABEL,
  addFailureToast,
  addLabel,
  addedParts,
  addSourceTitle,
  alreadySubscribedText,
  checkedEntries,
  countText,
  pickedBlocked,
  pickedLine,
  pickedRef,
  rowMeta,
  sameNameItems,
  type CandidateEntry,
  type PickedState,
} from "../src/pages/addSourceView.ts";

const cardbox = { key: "project:/Users/me/CardBox", label: "CardBox" };
const global = { key: "global", label: "全局" };

const entry = (ref: string, count = 1): CandidateEntry => ({
  ref,
  name: ref,
  sub: "~/x",
  count,
  items: Array.from({ length: count }, (_, i) => ({ name: `s${i}` })),
});

test("页名与固定文案：skill 与 MCP 两种，全局写「全局」", () => {
  assert.equal(addSourceTitle(cardbox, "skill"), "添加来源到「CardBox」");
  assert.equal(addSourceTitle(global, "skill"), "添加来源到「全局」");
  assert.equal(addSourceTitle(cardbox, "mcp"), "添加 MCP 来源到「CardBox」");
  assert.equal(alreadySubscribedText(cardbox), "它已经在 CardBox 的来源里");
  assert.equal(PICK_HINT, "选 skill 所在的文件夹，只认带 SKILL.md 的子目录");
  assert.equal(PICKED_HEAD, "你选的文件夹");
  assert.equal(SUGGESTED_LABEL, "建议的来源");
  assert.equal(NO_SKILL_CANDIDATES, "别处还没有可加的来源");
  assert.equal(FOLDER_WITHOUT_SKILLS, "这个文件夹里没有 skill，只认带 SKILL.md 的子目录");
});

test("数量带单位：`39 个 skill`、`3 个 MCP`", () => {
  assert.equal(countText(39, "skill"), "39 个 skill");
  assert.equal(countText(3, "MCP"), "3 个 MCP");
  assert.equal(countText(0, "skill"), "0 个 skill");
});

test("同名：与任一已订阅来源里的 skill 同名的挂 `同名` 并带悬停说明，其余不挂", () => {
  assert.deepEqual(sameNameItems(["docx", "figma", "notion"], [["docx"], ["figma", "x"]]), [
    { name: "docx", tag: { text: "同名", tip: SAME_NAME_TIP } },
    { name: "figma", tag: { text: "同名", tip: SAME_NAME_TIP } },
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
  assert.equal(pickedBlocked(failed, cardbox), "读不到这个文件夹：没有权限");
  assert.deepEqual(pickedLine(failed, cardbox, "skill"), {
    kind: "message",
    text: "读不到这个文件夹：没有权限",
  });

  const already: PickedState = { status: "ready", entry: entry("/p", 2), already: true };
  assert.equal(pickedRef(already), "/p");
  assert.equal(pickedBlocked(already, cardbox), "它已经在 CardBox 的来源里");

  const empty: PickedState = { status: "ready", entry: entry("/p", 0), already: false };
  assert.equal(pickedBlocked(empty, cardbox), FOLDER_WITHOUT_SKILLS);
  assert.deepEqual(pickedLine(empty, cardbox, "skill"), {
    kind: "message",
    text: FOLDER_WITHOUT_SKILLS,
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

test("底部主动作：`添加 N 个来源`，一个没勾时写 `添加来源`、禁用原因「先勾选要加的来源」", () => {
  assert.equal(addLabel(0), "添加来源");
  assert.equal(addLabel(1), "添加 1 个来源");
  assert.equal(addLabel(3), "添加 3 个来源");
  assert.equal(NOTHING_CHECKED, "先勾选要加的来源");
});

test("加完的提示：全成不出；全没成＝做不成；部分成＝部分失败带读数；名字只写没加上的", () => {
  assert.equal(addFailureToast(["/a"], []), null);
  assert.deepEqual(addFailureToast([], [{ name: "A", reason: "没有权限" }]), {
    kind: "cannot",
    verb: "没添加",
    names: ["A"],
    reason: "没有权限",
  });
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
      verb: "没添加",
      names: ["C", "D"],
      tally: { done: 2, failed: 2 },
      reason: "目录不见了",
    },
  );
});

test("全加上滑回主视图的例行一行：一个来源写名字，几个写「N 个来源」，数量带名词", () => {
  const line = (parts: string[]) => ["已添加", parts.join(" · ")].join(" ");
  assert.equal(line(addedParts(["WeiboAP"], 39, "skill")), "已添加 WeiboAP · 39 个 skill");
  assert.equal(
    line(addedParts(["WeiboAP", "通用仓库"], 41, "skill")),
    "已添加 2 个来源 · 41 个 skill",
  );
  assert.deepEqual(addedParts(["Claude Code · User"], 3, "MCP"), [
    "Claude Code · User",
    "3 个 MCP",
  ]);
});
