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

test("own：本体环，关不掉，点了只说明它不是链接", () => {
  assert.deepEqual(view("own"), {
    dot: "own",
    clickable: false,
    reason: "本体就在这儿，不是链接",
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

test("broken：空心但不可点，进待处理栏", () => {
  assert.deepEqual(view("broken"), {
    dot: "missing",
    clickable: false,
    reason: "Codex 下这条链接指向一个不存在的地方，先清掉它",
    issue: "brokenLink",
  });
});

test("foreign：说出同名的那条指向哪个本体，进待处理栏", () => {
  assert.deepEqual(view("foreign", target(), "/Users/me/other/obsidian-cli"), {
    dot: "missing",
    clickable: false,
    reason: "Codex 下同名的 obsidian-cli 指向 /Users/me/other/obsidian-cli，没有覆盖它",
    issue: "duplicateSource",
  });
});

/// core 判 foreign 时手里就是 real_path 的结果，pointsTo 不该为空；真空了也要成句
test("foreign：pointsTo 为空时退回含糊的说法，不说半句话", () => {
  assert.deepEqual(view("foreign"), {
    dot: "missing",
    clickable: false,
    reason: "Codex 下同名的 obsidian-cli 指向别处，没有覆盖它",
    issue: "duplicateSource",
  });
});

test("duplicate：是用户自己放的东西，只在点击时说一次，不进待处理栏", () => {
  const v = view("duplicate");
  assert.deepEqual(v, {
    dot: "missing",
    clickable: false,
    reason: "Codex 下已经有同名的 obsidian-cli，没有覆盖它",
  });
  assert.equal(v.issue, undefined);
});

test("wholeLinked：整目录链到别处，文案里必须有「拆开」这条出路", () => {
  assert.deepEqual(view("wholeLinked", target("/Users/me/skills")), {
    dot: "missing",
    clickable: false,
    reason: "Codex 的 skills 目录整个链到了 /Users/me/skills，要逐条开关得先拆开",
    issue: "wholeLinkedTarget",
  });
});

test("wholeLinked：不知道链到哪儿时也要成句", () => {
  assert.equal(
    view("wholeLinked").reason,
    "Codex 的 skills 目录整个链到了别的本体位置，要逐条开关得先拆开",
  );
});

test("readOnly：只有写失败后才会构造出来", () => {
  assert.deepEqual(view("readOnly"), {
    dot: "missing",
    clickable: false,
    reason: "Codex 的 skills 目录写不进去，obsidian-cli 没能开启",
    issue: "readOnlyTarget",
  });
});

/// 这个映射存在的理由：四种异常态画出来都是空心，但它们不是「还没开启」。
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
