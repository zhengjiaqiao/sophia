import { test } from "node:test";
import assert from "node:assert/strict";

import {
  columnOfTarget,
  columnPress,
  domainOfTarget,
  mergeSkillPages,
  refAt,
  refRowKey,
  skillRowKey,
} from "../src/skillsView.ts";
import type { Cell, CellState, DomainPage, Target } from "../src/types.ts";

/// 多位置的 Skills 表（spec 2026-09-26-object-first-navigation R6 R7，AC13–AC15）：
/// 目标 id 与 core 同一写法——用户级 `<harness>`，项目 `project:<路径>::<harness>`

const CARD = "project:/p/CardBox";

const gTarget = (h: string, label: string): Target => ({
  id: h,
  label,
  path: `/h/.${h}/skills`,
  scope: { type: "global", harnessId: h },
  exists: true,
  linkedWholeTo: null,
});
const pTarget = (key: string, h: string, label: string, exists = true): Target => ({
  id: `${key}::${h}`,
  label,
  path: `${key.slice("project:".length)}/.${h}/skills`,
  scope: {
    type: "project",
    project: key.slice("project:".length),
    projectLabel: null,
    harnessId: h,
  },
  exists,
  linkedWholeTo: null,
});
const cell = (t: Target, sourceId: string, skill: string, state: CellState): Cell => ({
  sourceId,
  skill,
  targetId: t.id,
  path: `${t.path}/${skill}`,
  state,
  pointsTo: null,
});

const gCC = gTarget("claude-code", "Claude Code");
const gCX = gTarget("codex", "Codex");
const pCX = pTarget(CARD, "codex", "Codex");
const pCU = pTarget(CARD, "cursor", "Cursor", false);

const user: DomainPage = {
  key: "global",
  label: "用户级",
  targets: [gCC, gCX],
  rows: [
    {
      sourceId: "/u",
      skill: "defuddle",
      own: false,
      cells: [cell(gCC, "/u", "defuddle", "linked"), cell(gCX, "/u", "defuddle", "missing")],
    },
    {
      sourceId: "/u",
      skill: "pdf",
      own: false,
      cells: [cell(gCC, "/u", "pdf", "missing"), cell(gCX, "/u", "pdf", "linked")],
    },
  ],
  broken: [],
};
const card: DomainPage = {
  key: CARD,
  label: "CardBox",
  targets: [pCX, pCU],
  rows: [
    {
      sourceId: "/u",
      skill: "defuddle",
      own: false,
      cells: [cell(pCX, "/u", "defuddle", "missing"), cell(pCU, "/u", "defuddle", "missing")],
    },
  ],
  broken: [],
};

test("目标 id 里读出位置与 agent 列：与 core 的写法一致", () => {
  assert.equal(domainOfTarget("codex"), "global");
  assert.equal(columnOfTarget("codex"), "codex");
  assert.equal(domainOfTarget(pCX.id), CARD);
  assert.equal(columnOfTarget(pCX.id), "codex");
  // Windows 盘符的单冒号不算分隔
  assert.equal(domainOfTarget("project:C:\\w\\Card::cursor"), "project:C:\\w\\Card");
  assert.equal(columnOfTarget("project:C:\\w\\Card::cursor"), "cursor");
});

test("AC13 同一个 skill 装在用户级与 CardBox：两行，行键带位置前缀、不重复；位置名写在每行上", () => {
  const view = mergeSkillPages([user, card]);
  const keys = view.rows.map(skillRowKey);
  assert.equal(new Set(keys).size, keys.length);
  const defuddle = view.rows.filter((r) => r.skill === "defuddle");
  assert.deepEqual(
    defuddle.map((r) => [r.domainKey, view.places.get(r.domainKey)]),
    [
      ["global", "用户级"],
      [CARD, "CardBox"],
    ],
  );
  assert.equal(skillRowKey(defuddle[1]), `${CARD}|/u|defuddle`);
});

test("AC13 列按 agent 归并：Codex 两个位置合成一列，只在一处有的 agent 各成一列；首现次序", () => {
  const view = mergeSkillPages([user, card]);
  assert.deepEqual(
    view.columns.map((c) => [c.id, c.label, [...c.targets.keys()]]),
    [
      ["claude-code", "Claude Code", ["global"]],
      ["codex", "Codex", ["global", CARD]],
      ["cursor", "Cursor", [CARD]],
    ],
  );
});

test("AC14 （行，列）找到这一行自己位置的目标：CardBox 行的 Codex 格指向 CardBox 的 Codex；没有目标就没有格", () => {
  const view = mergeSkillPages([user, card]);
  const codex = view.columns.find((c) => c.id === "codex")!;
  const cursor = view.columns.find((c) => c.id === "cursor")!;
  const [userRow, cardRow] = view.rows.filter((r) => r.skill === "defuddle");
  assert.deepEqual(refAt(cardRow, codex), { sourceId: "/u", skill: "defuddle", targetId: pCX.id });
  assert.deepEqual(refAt(userRow, codex), { sourceId: "/u", skill: "defuddle", targetId: "codex" });
  assert.equal(refAt(userRow, cursor), null, "用户级没有 Cursor 目标");
  // 由格反查回行键：落在 CardBox 那一行，不会落到用户级那一行
  assert.equal(refRowKey(refAt(cardRow, codex)!), skillRowKey(cardRow));
});

test("AC15 选中分属两个位置的 3 行，按 Codex 那一点：各行按自己的位置出格，一个不漏", () => {
  const view = mergeSkillPages([user, card]);
  const codex = view.columns.find((c) => c.id === "codex")!;
  const press = columnPress(view.rows, codex, (_ref, actual) => actual);
  assert.deepEqual(
    press.missing.map((c) => c.targetId).sort(),
    ["codex", pCX.id].sort(),
    "用户级 defuddle 与 CardBox defuddle 各自缺",
  );
  assert.deepEqual(
    press.linked.map((c) => [c.skill, c.targetId]),
    [["pdf", "codex"]],
  );
  assert.equal(press.targets.length, 2, "按到了两个位置的目标");
});

test("AC17 只有一个位置：没有位置名（不出位置列），列与行和那一页一一对应", () => {
  const view = mergeSkillPages([user]);
  assert.equal(view.places.size, 0);
  assert.deepEqual(
    view.columns.map((c) => c.id),
    user.targets.map((t) => t.id),
  );
  assert.equal(view.rows.length, user.rows.length);
});

test("同名项目的位置名带短路径区分", () => {
  const other: DomainPage = { ...card, key: "project:/q/CardBox", targets: [], rows: [] };
  const view = mergeSkillPages([user, card, other]);
  assert.equal(view.places.get("global"), "用户级");
  assert.equal(view.places.get(CARD), "CardBox · /p/CardBox");
  assert.equal(view.places.get("project:/q/CardBox"), "CardBox · /q/CardBox");
});

test("孤链行按位置分开：行键带位置前缀，格落在自己位置的列", () => {
  const brokenAt = (t: Target, name: string) => ({
    kind: "brokenLink" as const,
    itemName: name,
    sourcePath: `/gone/${name}`,
    targetPath: `${t.path}/${name}`,
    target: t.path,
  });
  const view = mergeSkillPages([
    { ...user, broken: [brokenAt(gCX, "old")] },
    { ...card, broken: [brokenAt(pCX, "old")] },
  ]);
  assert.deepEqual(
    view.orphans.map((o) => [o.key, o.domainKey, o.links.map((l) => l.targetId)]),
    [
      ["orphan|global|old", "global", ["codex"]],
      [`orphan|${CARD}|old`, CARD, [pCX.id]],
    ],
  );
});
