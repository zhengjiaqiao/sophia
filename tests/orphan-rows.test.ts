import { test } from "node:test";
import assert from "node:assert/strict";

import { ORPHAN_KEY_PREFIX, orphanRows } from "../src/orphanRows.ts";
import type { DomainPage, PlannedAction } from "../src/types.ts";

const target = (id: string, label: string) => ({
  id,
  label,
  path: `/t/${id}`,
  scope: { type: "global" as const, harnessId: id },
  exists: true,
  linkedWholeTo: null,
});

const broken = (targetId: string, name: string, pointedTo: string): PlannedAction => ({
  kind: "brokenLink",
  itemName: name,
  sourcePath: pointedTo,
  targetPath: `/t/${targetId}/${name}`,
  target: `/t/${targetId}`,
});

const page = (actions: PlannedAction[]): DomainPage => ({
  key: "global",
  label: "全局",
  targets: [target("codex", "Codex"), target("cursor", "Cursor")],
  rows: [
    {
      sourceId: "/u",
      skill: "docx",
      own: true,
      cells: [
        {
          sourceId: "/u",
          skill: "docx",
          targetId: "codex",
          path: "/t/codex/docx",
          state: "broken",
          pointsTo: null,
        },
        {
          sourceId: "/u",
          skill: "docx",
          targetId: "cursor",
          path: "/t/cursor/docx",
          state: "missing",
          pointsTo: null,
        },
      ],
    },
  ],
  broken: actions,
});

test("孤链：落在某一行格上的失效链接不成行（那一格自己画虚线环、点一下重新链接）", () => {
  assert.deepEqual(orphanRows(page([broken("codex", "docx", "/u/docx")])), []);
});

test("孤链：没有对应行的失效链接照样成一行，清除动作原样带着", () => {
  const gone = broken("cursor", "old-skill", "/gone/old-skill");
  const rows = orphanRows(page([broken("codex", "docx", "/u/docx"), gone]));
  assert.deepEqual(rows, [
    {
      key: `${ORPHAN_KEY_PREFIX}old-skill`,
      skill: "old-skill",
      pointedTo: "/gone/old-skill",
      links: [{ targetId: "cursor", clear: gone }],
    },
  ]);
});

test("孤链：同一个名字在几个 agent 下各有一条，合成一行、各格各清各的", () => {
  const a = broken("codex", "old-skill", "/gone/old-skill");
  const b = broken("cursor", "old-skill", "/gone/old-skill");
  const rows = orphanRows(page([a, b]));
  assert.equal(rows.length, 1);
  assert.deepEqual(
    rows[0].links.map((l) => [l.targetId, l.clear]),
    [
      ["codex", a],
      ["cursor", b],
    ],
  );
});

test("孤链：找不到所在列的不硬塞进别的列", () => {
  const stray: PlannedAction = { ...broken("codex", "x", "/gone/x"), target: "/elsewhere" };
  assert.deepEqual(orphanRows(page([stray])), []);
});
