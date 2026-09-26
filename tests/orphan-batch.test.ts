import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";
import { mergeSkillPages } from "../src/skillsView.ts";
import type { DomainPage, Target } from "../src/types.ts";

/// 孤链（原件已不在的失效链接）能勾选、能在选择行里一次清掉（产品负责人 2026-09-26：一个项目里十几行
/// 「不在了」，只能一格一格点）

const { default: DomainView } = await import("../src/DomainView.tsx");

const t = (h: string, label: string): Target => ({
  id: h,
  label,
  path: `/h/.${h}/skills`,
  scope: { type: "global", harnessId: h },
  exists: true,
  linkedWholeTo: null,
});
const cx = t("codex", "Codex");
const cc = t("claude-code", "Claude Code");
const page: DomainPage = {
  key: "global",
  label: "用户级",
  targets: [cc, cx],
  rows: [
    {
      sourceId: "/u",
      skill: "pdf",
      own: false,
      cells: [
        {
          sourceId: "/u",
          skill: "pdf",
          targetId: "claude-code",
          path: `${cc.path}/pdf`,
          state: "linked",
          pointsTo: null,
        },
        {
          sourceId: "/u",
          skill: "pdf",
          targetId: "codex",
          path: `${cx.path}/pdf`,
          state: "missing",
          pointsTo: null,
        },
      ],
    },
  ],
  broken: [
    {
      kind: "brokenLink",
      itemName: "old",
      sourcePath: "/gone/old",
      targetPath: `${cx.path}/old`,
      target: cx.path,
    },
  ],
};
const view = mergeSkillPages([page]);
const orphan = view.orphans[0];
const props = (selected: string[]) => ({
  overview: { domains: [page], sources: [] },
  view,
  rows: view.rows,
  placeLabel: "用户级",
  stateOf: (_r: unknown, a: string) => a,
  hiddenRows: new Set<string>(),
  dupReadout: new Map<string, string>(),
  onDupHover: () => undefined,
  onKeepThis: () => undefined,
  orphans: view.orphans,
  onClearOrphan: () => undefined,
  filterText: "",
  onFilterText: () => undefined,
  onClearFilter: () => undefined,
  onReveal: () => undefined,
  onCopyPath: () => undefined,
  onAddSource: () => undefined,
  selected: new Set(selected),
  onSelectionChange: () => undefined,
  onCell: () => undefined,
  onBatch: () => undefined,
  onUndo: () => undefined,
  canUndo: false,
  shortcuts: false,
});

test("孤链行能勾选：勾选框不再灰着", () => {
  const html = render(DomainView, props([]));
  assert.doesNotMatch(html, /原件不在了，没有可加上或移除的/);
});

test("只勾了孤链行：Codex 那一点是 ●「选中的都从 Codex 移除」，能按；它没有孤链的列不可按", () => {
  const html = render(DomainView, props([orphan.key]));
  assert.match(html, /aria-label="选中的都从 Codex 移除"/);
  assert.match(html, /aria-label="选中的都从所有 agent 移除"/);
  assert.match(
    html,
    /aria-label="选中的都加到 Claude Code：这几个在 Claude Code 里没有失效链接"/,
    "Claude Code 列上它没有失效链接：说这个，不说「无法加到」",
  );
});

test("孤链行与缺 Codex 的正常行一起勾：Codex 那一点是 ○（先补齐正常行）", () => {
  const html = render(DomainView, props([orphan.key, "global|/u|pdf"]));
  assert.match(html, /aria-label="选中的都加到 Codex"/);
});
