// issue #153：「去处理」落到 agent 自己目录里的同名 skill。那一格因「那里已有同名的」被挡住、占着它的是
// agent 自己目录里不在任何原件位置里的一份（例：项目里的 `.claude/skills/canvas-design`）——表格里没有它那一行，
// 同名行抽屉的差异表也要列它：行首「Claude Code 自己的」、原件路径，行尾「只留这份」，两份都能选
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  agentCopiesOf,
  agentCopyKey,
  keepSideKey,
  mergeSkillPages,
  skillRowKey,
  type KeepSide,
} from "../src/skillsView.ts";
import { agentCopyRow, skillDiffTable } from "../src/skillDiffTable.ts";
import { keepThisConfirm, toastFor } from "../src/toastText.ts";
import type { DomainPage } from "../src/types.ts";

const PROJECT = "project:/Users/you/Project/CardBox";
const target = (harness: string, label: string, path: string) => ({
  id: `${PROJECT}::${harness}`,
  label,
  path,
  scope: { kind: "project", project: "/Users/you/Project/CardBox", harnessId: harness },
  exists: true,
  linkedWholeTo: null,
});
const page = {
  key: PROJECT,
  label: "CardBox",
  targets: [
    target("claude-code", "Claude Code", "/Users/you/Project/CardBox/.claude/skills"),
    target("codex", "Codex", "/Users/you/Project/CardBox/.codex/skills"),
  ],
  rows: [
    {
      sourceId: "/Users/you/Project/CardBox/.agents/skills",
      skill: "canvas-design",
      own: true,
      cells: [
        {
          sourceId: "/Users/you/Project/CardBox/.agents/skills",
          skill: "canvas-design",
          targetId: `${PROJECT}::claude-code`,
          path: "/Users/you/Project/CardBox/.claude/skills/canvas-design",
          state: "duplicate",
          pointsTo: null,
        },
        {
          sourceId: "/Users/you/Project/CardBox/.agents/skills",
          skill: "canvas-design",
          targetId: `${PROJECT}::codex`,
          path: "/Users/you/Project/CardBox/.codex/skills/canvas-design",
          state: "linked",
          pointsTo: "/Users/you/Project/CardBox/.agents/skills/canvas-design",
        },
      ],
    },
  ],
  broken: [],
  agentCopies: [
    {
      skill: "canvas-design",
      targetId: `${PROJECT}::claude-code`,
      path: "/Users/you/Project/CardBox/.claude/skills/canvas-design",
    },
  ],
} as unknown as DomainPage;

test("扫描交来的 agent 自己那一份带上位置与 agent 名；按位置 + 名字取，「只留这份」挂起时藏起来的不算", () => {
  const view = mergeSkillPages([page]);
  assert.deepEqual(view.agentCopies, [
    {
      skill: "canvas-design",
      targetId: `${PROJECT}::claude-code`,
      path: "/Users/you/Project/CardBox/.claude/skills/canvas-design",
      domainKey: PROJECT,
      agent: "Claude Code",
    },
  ]);
  const row = view.rows[0];
  assert.equal(agentCopiesOf(view, row).length, 1);
  assert.equal(agentCopiesOf(view, { domainKey: "global", skill: "canvas-design" }).length, 0);
  assert.equal(agentCopiesOf(view, { domainKey: PROJECT, skill: "pdf" }).length, 0);
  const hidden = new Set([agentCopyKey(view.agentCopies[0])]);
  assert.equal(agentCopiesOf(view, row, hidden).length, 0);
  // 没有这一项的页（老数据）照旧
  const { agentCopies: _, ...old } = page;
  assert.deepEqual(mergeSkillPages([old as DomainPage]).agentCopies, []);
});

test("只有一行、agent 自己目录里还有一份：抽屉表两行，行首「Claude Code 自己的」，两份都能「只留这份」", () => {
  const view = mergeSkillPages([page]);
  const row = view.rows[0];
  const sides: KeepSide[] = [{ row }, ...agentCopiesOf(view, row).map((copy) => ({ copy }))];
  const table = skillDiffTable([
    { id: skillRowKey(row), place: "CardBox · .agents", path: `${row.sourceId}/canvas-design` },
    agentCopyRow(view.agentCopies[0]),
  ]);
  assert.equal(table.keep, true, "恰好两份：行尾有「只留这份」");
  assert.deepEqual(
    table.rows.map((r) => [r.place, r.path, r.keepBlocked]),
    [
      ["CardBox · .agents", "/Users/you/Project/CardBox/.agents/skills/canvas-design", null],
      ["Claude Code 自己的", "/Users/you/Project/CardBox/.claude/skills/canvas-design", null],
    ],
  );
  // 表里的行键对得回「只留这份」的两方：留哪一份，另一份就是对家
  assert.deepEqual(
    table.rows.map((r) => r.id),
    sides.map(keepSideKey),
  );
  assert.equal(table.rows[0].otherId, keepSideKey(sides[1]));
  assert.equal(table.rows[1].otherId, keepSideKey(sides[0]));
  // agent 自己那一份在应用包里：留表格里那一行要挪走它，按不了并说原因；留它照常
  const app = skillDiffTable([
    { id: "a", place: "~/.agents", path: "/Users/you/.agents/skills/ego" },
    agentCopyRow({
      ...view.agentCopies[0],
      path: "/Applications/ego lite.app/Contents/skills/ego",
    }),
  ]);
  assert.match(app.rows[0].keepBlocked ?? "", /ego lite\.app/);
  assert.equal(app.rows[1].keepBlocked, null);
});

test("抽屉表接上 agent 自己那一份；「只留这份」两方走同一个确认、删除与撤销（一方是它时明确改指到留下的那份）", () => {
  const dv = readFileSync(new URL("../src/DomainView.tsx", import.meta.url), "utf8");
  assert.match(dv, /agentCopiesOf\(view, row, props\.hiddenRows\)/);
  assert.match(dv, /agentCopyRow\(side\.copy\)/);
  const tab = readFileSync(new URL("../src/SkillsTab.tsx", import.meta.url), "utf8");
  // 两份都是表格里的行时照旧；有一方是 agent 自己那一份时走 planKeepCopy
  assert.match(tab, /api\.planKeepCopy\(skill, refOf\(kept\), refOf\(other\)\)/);
  // 删除与撤销同现有的「只留这份」：deleteSource → undoDeleteOriginal
  const confirm = tab.slice(tab.indexOf("const confirmKeep = async"));
  assert.match(confirm, /api\.deleteSource\(pane\.planId\)/);
  assert.match(confirm, /offerDeleteUndo\(undoId, skill, keptKey, pane\.at\)/);
  const api = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
  assert.match(api, /invoke<PlannedDeletion>\("plan_keep_copy", \{ skill, keep, drop \}\)/);
});

test("确认框与结果：指 agent 自己那一份时说「Claude Code 自己那份」，不再接「的」；另一方向照旧", () => {
  const own = {
    name: "Claude Code 自己那份",
    seg: "",
    own: true,
    path: "/p/.claude/skills/canvas-design",
  };
  const repo = { name: "通用仓库", seg: "", path: "/p/.agents/skills/canvas-design" };
  const keepOwn = keepThisConfirm({ kept: own, other: repo, skill: "canvas-design", relinked: 1 });
  assert.equal(keepOwn.title, "只留 Claude Code 自己那份 canvas-design？");
  assert.equal(keepOwn.body, "通用仓库 那份移到废纸篓，1 条链接改指到这一份");
  const keepRepo = keepThisConfirm({ kept: repo, other: own, skill: "canvas-design", relinked: 0 });
  assert.equal(keepRepo.title, "只留 通用仓库 的 canvas-design？");
  assert.equal(keepRepo.body, "Claude Code 自己那份移到废纸篓");
  assert.equal(
    keepThisConfirm({ kept: repo, other: own, skill: "canvas-design", relinked: 2 }).body,
    "Claude Code 自己那份移到废纸篓，2 条链接改指到这一份",
  );
  for (const text of [keepOwn.title, keepOwn.body, keepRepo.title, keepRepo.body])
    assert.doesNotMatch(text, /那份 的|那份 那份|那份那份/);
  // 结果：`✓ 只留 Claude Code 自己那份 canvas-design`；留通用仓库的照旧 `通用仓库 的 canvas-design`
  const done = [{ name: "canvas-design" }];
  assert.deepEqual(
    toastFor("keepThis", { done, keepLabel: "Claude Code 自己那份", keepOwn: true }).names,
    ["Claude Code 自己那份 canvas-design"],
  );
  assert.deepEqual(toastFor("keepThis", { done, keepLabel: "通用仓库" }).names, [
    "通用仓库 的 canvas-design",
  ]);
});

test("文案三种语言同一套键：Claude Code 自己的（行首）/ 自己那份（句子里）", () => {
  const want: Record<string, [string, string]> = {
    "zh-Hans": ["{agent} 自己的", "{agent} 自己那份"],
    "zh-Hant": ["{agent} 自己的", "{agent} 自己那份"],
    en: ["{agent}'s own", "{agent}'s own copy"],
  };
  const toastKeys = [
    "toast.keepThis.nameOfOwn",
    "toast.keepThisConfirm.titleOwn",
    "toast.keepThisConfirm.trashOwn",
    "toast.keepThisConfirm.trashRelinkedOwn",
  ];
  for (const [lang, [own, copy]] of Object.entries(want)) {
    const skills = JSON.parse(
      readFileSync(new URL(`../locales/${lang}/skills.json`, import.meta.url), "utf8"),
    );
    assert.equal(skills["skills.dup.agentOwn"], own, `${lang} skills.dup.agentOwn`);
    assert.equal(skills["skills.dup.agentOwnCopy"], copy, `${lang} skills.dup.agentOwnCopy`);
    assert.equal(skills["skills.dup.agentOwnFolder"], undefined, `${lang} 旧键已去掉`);
    const toast = JSON.parse(
      readFileSync(new URL(`../locales/${lang}/toast.json`, import.meta.url), "utf8"),
    );
    for (const key of toastKeys) assert.ok(toast[key], `${lang} ${key}`);
  }
});
