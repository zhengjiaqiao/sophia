import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CHIPS,
  chipProjects,
  fitChips,
  matchProject,
  measuredProjects,
  resolveSource,
  sourceOptions,
  type ChipMetrics,
  type ScopeProject,
} from "../src/scopeView.ts";

/// 筛选行的 `位置` 胶囊与 `来源` 下拉（spec 2026-09-26-object-first-navigation R4 R5；2026-09-27-skill-mcp-market R2）

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

/// 量出来的一行：776 宽的面板，右端 `来源：全部 ˅` 约 90 + 16；`位置` + 8 + `全部` + 6 + `用户级` 约 130；
/// 胶囊间 6；`更多 ˅` 60；项目片按名字长短
const metrics = (widths: Record<string, number>, width = 776 - 90 - 16): ChipMetrics => ({
  width,
  fixed: 130,
  gap: 6,
  more: 60,
  widthOf: (key) => widths[key] ?? 0,
});
const even = (count: number, each: number) =>
  Object.fromEntries(list(count).map((p) => [p.key, each]));

test("AC2 8 个项目：露出 6 个 + 更多（放得下时至多 6 个）", () => {
  const eight = list(8);
  const n = fitChips(eight, null, metrics(even(8, 60)));
  assert.equal(n, 6);
  const r = chipProjects(eight, null, n);
  assert.equal(r.chips.length, 6);
  assert.deepEqual(
    r.more.map((p) => p.label),
    ["p7", "p8"],
  );
});

test("AC2 项目名很长时收得更早，这一行不折行（露出的连同 更多 放得下）", () => {
  const eight = list(8);
  const m = metrics(even(8, 180));
  const n = fitChips(eight, null, m);
  assert.ok(n < 6, `收进更多：${n}`);
  const { chips, more } = chipProjects(eight, null, n);
  const used = m.fixed + chips.reduce((s, p) => s + m.gap + m.widthOf(p.key), 0) + m.gap + m.more;
  assert.ok(more.length > 0);
  assert.ok(used <= m.width, `${used} ≤ ${m.width}`);
  const oneMore = chipProjects(eight, null, n + 1).chips;
  const over = m.fixed + oneMore.reduce((s, p) => s + m.gap + m.widthOf(p.key), 0) + m.gap + m.more;
  assert.ok(over > m.width, "再多一个就放不下了");
});

test("AC2 项目都放得下时没有 更多，最后一格不用给 更多 留位", () => {
  const six = list(6);
  // 6 个各 70：130 + 6×76 = 586 ≤ 600；要是还给 更多 留 66 就超了
  assert.equal(fitChips(six, null, metrics(even(6, 70), 600)), 6);
  assert.deepEqual(chipProjects(six, null, 6).more, []);
});

test("AC2 选中的项目在 更多 里：替换能放下的最后一格，并按它自己的宽来算", () => {
  const ten = list(10);
  const widths = { ...even(10, 60), "project:/w/p9": 200 };
  const m = metrics(widths, 600);
  const n = fitChips(ten, "project:/w/p9", m);
  const { chips } = chipProjects(ten, "project:/w/p9", n);
  assert.equal(chips[chips.length - 1].label, "p9", "选中项始终看得见");
  const used = m.fixed + chips.reduce((s, p) => s + m.gap + m.widthOf(p.key), 0) + m.gap + m.more;
  assert.ok(used <= m.width);
  assert.deepEqual(
    measuredProjects(ten, "project:/w/p9").map((p) => p.label),
    ["p1", "p2", "p3", "p4", "p5", "p6", "p9"],
    "量尺里量前 6 个与选中的那一个",
  );
});

test("一个项目片都放不下：选中的项目仍露出；没选项目时一个都不露", () => {
  const eight = list(8);
  const m = metrics(even(8, 60), 150);
  assert.equal(fitChips(eight, null, m), 0);
  assert.deepEqual(chipProjects(eight, null, 0).chips, []);
  assert.deepEqual(
    chipProjects(eight, "project:/w/p8", 0).chips.map((p) => p.label),
    ["p8"],
  );
});

test("R2 来源下拉：只列当前位置里有的来源，按行数从多到少，右侧带条数", () => {
  const opts = sourceOptions([
    "通用仓库",
    "WeiboAP",
    "通用仓库",
    "ego lite",
    "通用仓库",
    "WeiboAP",
  ]);
  assert.deepEqual(opts, [
    { label: "通用仓库", count: 3 },
    { label: "WeiboAP", count: 2 },
    { label: "ego lite", count: 1 },
  ]);
  assert.deepEqual(sourceOptions([]), []);
});

test("AC3 选了来源 WeiboAP，换到一个没有它的项目：回到 全部（表不为空）", () => {
  const cardbox = sourceOptions(["WeiboAP", "通用仓库"]);
  assert.equal(resolveSource("WeiboAP", cardbox), "WeiboAP");
  const other = sourceOptions(["通用仓库", "通用仓库"]);
  assert.equal(resolveSource("WeiboAP", other), null, "不在了回到全部");
  assert.equal(resolveSource(null, other), null);
  const rows = ["通用仓库", "通用仓库"];
  const value = resolveSource("WeiboAP", other);
  assert.equal(
    rows.filter((label) => value === null || label === value).length,
    2,
    "回到全部后表不为空",
  );
});

test("AC11 「更多」里的搜索：名字或路径里有就算，不分大小写", () => {
  const w: ScopeProject = { key: "project:/c/WeiboAP", label: "WeiboAP", path: "/c/WeiboAP" };
  assert.equal(matchProject(w, "weibo"), true);
  assert.equal(matchProject(w, "/c/"), true);
  assert.equal(matchProject(w, "cardbox"), false);
  assert.equal(matchProject(w, "  "), true, "空查询全留");
});
