import assert from "node:assert/strict";
import test from "node:test";
import { viewOf } from "../src/cellState.ts";
import type { Cell, CellState, Target } from "../src/types.ts";

const cell = (state: CellState, pointsTo: string | null = null): Cell => ({
  sourceId: "/Users/me/skills",
  skill: "obsidian-cli",
  targetId: "codex",
  path: "/Users/me/.codex/skills/obsidian-cli",
  state,
  pointsTo,
});

const target = (linkedWholeTo: string | null = null): Target => ({
  id: "codex",
  label: "Codex",
  path: "/Users/me/.codex/skills",
  scope: { type: "global", harnessId: "codex" },
  exists: true,
  linkedWholeTo,
});

const view = (state: CellState, t: Target = target(), pointsTo: string | null = null) =>
  viewOf(cell(state, pointsTo), t, "Codex", "obsidian-cli");

test("own：原件环，关不掉，点了只说明它不是链接", () => {
  assert.deepEqual(view("own"), {
    dot: "own",
    clickable: false,
    reason: "原件就在这儿，不是链接",
  });
});

/// §8.1：可点的两种不带 reason——成功句由调用方汇总，一次批量操作只出一句
test("linked：实心，可点，不自带成功文案", () => {
  const v = view("linked", target(), "/Users/me/skills/obsidian-cli");
  assert.deepEqual(v, { dot: "linked", clickable: true });
  assert.equal(v.reason, undefined);
});

test("missing：空心，可点，不自带成功文案", () => {
  const v = view("missing");
  assert.deepEqual(v, { dot: "missing", clickable: true });
  assert.equal(v.reason, undefined);
});

test("broken：格里画虚线环，不可点，算要拿主意的问题", () => {
  assert.deepEqual(view("broken"), {
    dot: "broken",
    clickable: false,
    reason: "Codex 下这条链接指向一个不存在的地方，先清掉它",
    issue: "brokenLink",
  });
});

test("foreign：说出同名的那条指向哪个本体，算要拿主意的问题", () => {
  assert.deepEqual(view("foreign", target(), "/Users/me/other/obsidian-cli"), {
    dot: "blocked",
    clickable: false,
    reason: "Codex 下同名的 obsidian-cli 指向 /Users/me/other/obsidian-cli，没有覆盖它",
    issue: "duplicateSource",
  });
});

/// core 判 foreign 时手里就是 real_path 的结果，pointsTo 不该为空；真空了也要成句
test("foreign：pointsTo 为空时退回含糊的说法，不说半句话", () => {
  assert.deepEqual(view("foreign"), {
    dot: "blocked",
    clickable: false,
    reason: "Codex 下同名的 obsidian-cli 指向别处，没有覆盖它",
    issue: "duplicateSource",
  });
});

test("duplicate：是用户自己放的东西，只在点击时说一次，不算要拿主意的问题", () => {
  const v = view("duplicate");
  assert.deepEqual(v, {
    dot: "blocked",
    clickable: false,
    reason: "Codex 下已经有同名的 obsidian-cli，没有覆盖它",
  });
  assert.equal(v.issue, undefined);
});

test("wholeLinked：整个文件夹是链接，画环内箭头，文案里必须有「拆开」这条出路", () => {
  assert.deepEqual(view("wholeLinked", target("/Users/me/skills")), {
    dot: "wholeLinked",
    clickable: false,
    reason: "Codex 的 skills 文件夹整个链接到了 /Users/me/skills，拆开后才能逐个开关",
    issue: "wholeLinkedTarget",
  });
});

test("wholeLinked：不知道链到哪儿时也要成句", () => {
  assert.equal(
    view("wholeLinked").reason,
    "Codex 的 skills 文件夹整个链接到了别处，拆开后才能逐个开关",
  );
});

test("readOnly：只有写失败后才会构造出来", () => {
  assert.deepEqual(view("readOnly"), {
    dot: "readOnly",
    clickable: false,
    reason: "无法写入 Codex 的 skills 目录，obsidian-cli 没加上",
    issue: "readOnlyTarget",
  });
});

/// 这个映射存在的理由：四种异常态都不是「还没开启」。
/// 旧实现凭 propose_links 返回空动作数组就对它们统一说一句话，对四种全是错的。
test("四种异常态各说各的，都不再说那句统一文案", () => {
  const states: CellState[] = ["broken", "foreign", "duplicate", "wholeLinked"];
  const reasons = states.map(
    (s) => view(s, target("/Users/me/skills"), "/Users/me/other/obsidian-cli").reason ?? "",
  );
  for (const r of reasons) {
    assert.ok(r.length > 0);
    assert.ok(!r.includes("没有需要建立的链接"), `不该出现统一文案：${r}`);
  }
  assert.equal(new Set(reasons).size, states.length, "四种异常态的文案必须各不相同");
});

/// UI v4：异常在它发生的那一格看得见（DESIGN「视觉优先」），不再一律画成空心。
/// 同名被挡的两种（foreign / duplicate）对用户是同一件事，画同一个记号
test("异常态各有自己的格内记号，没有一种退回空心", () => {
  const dots = (["broken", "foreign", "duplicate", "wholeLinked", "readOnly"] as const).map(
    (s) => view(s).dot,
  );
  assert.deepEqual(dots, ["broken", "blocked", "blocked", "wholeLinked", "readOnly"]);
});
