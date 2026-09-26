import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CHIPS,
  chipProjects,
  matchProject,
  showsProjectChips,
  type ScopeProject,
} from "../src/scopeView.ts";

/// 项目筛选片（spec 2026-09-26-object-first-navigation R4 R5）

const proj = (n: number): ScopeProject => ({
  key: `project:/w/p${n}`,
  label: `p${n}`,
  path: `/w/p${n}`,
});
const list = (count: number) => Array.from({ length: count }, (_, i) => proj(i + 1));

test("AC7 恰好 6 个项目：全部露出，没有「更多」", () => {
  assert.equal(MAX_CHIPS, 6);
  const r = chipProjects(list(6), null);
  assert.deepEqual(
    r.chips.map((p) => p.label),
    ["p1", "p2", "p3", "p4", "p5", "p6"],
  );
  assert.deepEqual(r.more, []);
});

test("AC7 7 个项目：前 6 个 + 「更多」里是第 7 个", () => {
  const r = chipProjects(list(7), null);
  assert.equal(r.chips.length, 6);
  assert.deepEqual(
    r.more.map((p) => p.label),
    ["p7"],
  );
});

test("AC8 从「更多」里选了第 9 个：它替换第 6 个位置显示，被挤下去的进「更多」", () => {
  const r = chipProjects(list(10), "project:/w/p9");
  assert.deepEqual(
    r.chips.map((p) => p.label),
    ["p1", "p2", "p3", "p4", "p5", "p9"],
  );
  assert.deepEqual(
    r.more.map((p) => p.label),
    ["p6", "p7", "p8", "p10"],
  );
});

test("选中的就在前 6 个里、或选中的已经不在列表里：照常取前 6 个", () => {
  assert.deepEqual(
    chipProjects(list(8), "project:/w/p2").chips.map((p) => p.label),
    ["p1", "p2", "p3", "p4", "p5", "p6"],
  );
  assert.deepEqual(
    chipProjects(list(8), "project:/w/gone").chips.map((p) => p.label),
    ["p1", "p2", "p3", "p4", "p5", "p6"],
  );
});

test("AC10 用户级下没有项目筛选片；全部与项目级下有", () => {
  assert.equal(showsProjectChips("user"), false);
  assert.equal(showsProjectChips("all"), true);
  assert.equal(showsProjectChips("project"), true);
});

test("AC11 「更多」里的搜索：名字或路径里有就算，不分大小写", () => {
  const w: ScopeProject = { key: "project:/c/WeiboAP", label: "WeiboAP", path: "/c/WeiboAP" };
  assert.equal(matchProject(w, "weibo"), true);
  assert.equal(matchProject(w, "/c/"), true);
  assert.equal(matchProject(w, "cardbox"), false);
  assert.equal(matchProject(w, "  "), true, "空查询全留");
});

test("R8 来源管理作用于哪个位置：选过的还在就用它；选过的不在了就没有（不悄悄换到别处）；没选过用第一个；一个位置都没有就没有", async () => {
  const { sourceLocation } = await import("../src/scopeView.ts");
  const G = "global";
  const CB = "project:/p/CardBox";
  assert.equal(sourceLocation([G, CB], null), G);
  assert.equal(sourceLocation([G, CB], CB), CB);
  assert.equal(sourceLocation([G], CB), null, "选过的项目不在范围里了：不换成用户级");
  assert.equal(sourceLocation([], null), null, "项目级下一个项目都没有：不落到用户级");
});
