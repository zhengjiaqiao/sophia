import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";
import { mergeSkillPages } from "../src/skillsView.ts";
import type { DomainPage, Target } from "../src/types.ts";

/// 多位置的表里，这一行的位置没有这一列的 agent（产品负责人 2026-09-27：多出一种短横、悬停也没说明）：
/// 空着、悬停说原因（spec 2026-09-26-object-first-navigation AC16「空格且不可点」）

const { default: DomainView } = await import("../src/DomainView.tsx");

const target = (key: string, h: string, label: string): Target => ({
  id: key === "global" ? h : `${key}::${h}`,
  label,
  path: `/x/${h}`,
  scope:
    key === "global"
      ? { type: "global", harnessId: h }
      : { type: "project", project: "/p/CardBox", projectLabel: null, harnessId: h },
  exists: true,
  linkedWholeTo: null,
});
const CB = "project:/p/CardBox";
const page = (key: string, label: string, targets: Target[]): DomainPage => ({
  key,
  label,
  targets,
  rows: [
    {
      sourceId: "/u",
      skill: "pdf",
      own: false,
      cells: targets.map((t) => ({
        sourceId: "/u",
        skill: "pdf",
        targetId: t.id,
        path: `${t.path}/pdf`,
        state: "missing" as const,
        pointsTo: null,
      })),
    },
  ],
  broken: [],
});
const view = mergeSkillPages([
  page("global", "用户级", [
    target("global", "claude-code", "Claude Code"),
    target("global", "codex", "Codex"),
  ]),
  page(CB, "CardBox", [target(CB, "codex", "Codex")]),
]);

test("CardBox 没有 Claude Code 目标：那一格空着，读屏与提示框说「CardBox 里没有 Claude Code 的 skill 目录」", () => {
  const html = render(DomainView, {
    overview: { domains: [], sources: [] },
    view,
    rows: view.rows,
    placeLabel: "这几个位置",
    stateOf: (_r: unknown, a: string) => a,
    hiddenRows: new Set<string>(),
    dupReadout: new Map<string, string>(),
    onDupHover: () => undefined,
    onKeepThis: () => undefined,
    orphans: [],
    onClearOrphan: () => undefined,
    filterText: "",
    onFilterText: () => undefined,
    onClearFilter: () => undefined,
    onReveal: () => undefined,
    onCopyPath: () => undefined,
    onAddSource: () => undefined,
    selected: new Set<string>(),
    onSelectionChange: () => undefined,
    onCell: () => undefined,
    onBatch: () => undefined,
    onUndo: () => undefined,
    canUndo: false,
    shortcuts: false,
  });
  assert.match(html, /aria-label="pdf · Claude Code：CardBox 里没有 Claude Code 的 skill 目录"/);
  assert.doesNotMatch(html, /ss-dot--none/);
});
