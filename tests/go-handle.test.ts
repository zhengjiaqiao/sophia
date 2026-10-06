// issue #111：装完提示「去处理」直达同名那一行（画板 #105 第七稿第 2、3 节）。
// 有「没链上」时右下提示条两行（「已安装 pdf」/「Claude Code 没链上：那里已有同名的」在左，键与 × 在右侧跨两行居中），
// 紧凑键「去处理」排在「撤销」前；点了切到 SKILLS · 我的，按位置 key + skill 名找到那一行、拉开抽屉；
// 抽屉里「N 份不一样」改用差异表 DiffTable：一行一份，行首位置名，只有「原件」一列，行尾「只留这份」
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { render } from "./ui-render.ts";
import {
  skillHandleTarget,
  skillInstalledToast,
  withTakenSkipped,
} from "../src/market/installView.ts";
import { DEFAULT_NAV, goFace, goLocation, goDestination, goRow } from "../src/shell/nav.ts";
import { rowForHandle, type SkillRow } from "../src/skillsView.ts";
import { skillDiffTable } from "../src/skillDiffTable.ts";
import type { CellState, InstallOutcome } from "../src/types.ts";
import type { MarketService } from "../src/market/service.ts";

const noop = () => {};
const uiCss = readFileSync(new URL("../src/ui/ui.css", import.meta.url), "utf8");
function cssRule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `ui.css 里没有 ${selector}`);
  return css.slice(at, css.indexOf("}", at));
}

const { InstalledToast } = await import("../src/market/InstalledToast.tsx");
const { NoticeLines } = await import("../src/ui/Toast.tsx");

const PROJECT = "project:/Users/you/Project/CardBox";
const taken = "那里已有同名的";
const outcome = (unlinked: InstallOutcome["unlinked"], failed: Record<string, string> = {}) =>
  ({
    installed: ["pdf"],
    failed,
    links: { entries: [] },
    unlinked,
    records: [],
    undoId: "u1",
  }) satisfies InstallOutcome;

// ───────── 去处理去哪 ─────────

test("去处理的目标：装到的位置 + 没链上的那个 skill；没有「没链上」时没有目标", () => {
  const one = outcome([{ harnessId: "claude-code", name: "pdf", reason: taken }]);
  assert.deepEqual(skillHandleTarget(one, "global"), { domainKey: "global", skill: "pdf" });
  // 装到项目：位置 key 就是项目的域 key
  assert.deepEqual(skillHandleTarget(one, PROJECT), { domainKey: PROJECT, skill: "pdf" });
  // 几个 agent 没链上同一个 skill：同一行
  const two = outcome([
    { harnessId: "claude-code", name: "pdf", reason: taken },
    { harnessId: "cursor", name: "pdf", reason: taken },
  ]);
  assert.deepEqual(skillHandleTarget(two, "global"), { domainKey: "global", skill: "pdf" });
  // 都链上了：没有去处理
  assert.equal(skillHandleTarget(outcome([]), "global"), null);
  // 有没装上的、但没有「没链上」的：没有去处理
  assert.equal(skillHandleTarget(outcome([], { docx: "下载失败" }), "global"), null);
});

test("先在 Claude Code 放了 pdf 再装 pdf：那一行不能勾、没交给后端，装完照样说 Claude Code 没链上、给去处理", () => {
  const dirs = [
    { harnessId: "claude-code", dir: "/h/.claude/skills", chosen: false, taken: ["pdf"] },
    { harnessId: "cursor", dir: "/h/.cursor/skills", chosen: true, taken: [] },
  ];
  // 后端只拿到 cursor：它那里链上了，unlinked 是空的
  const reply = outcome([]);
  const merged = withTakenSkipped(reply, dirs, ["claude-code"]);
  assert.deepEqual(merged.unlinked, [{ harnessId: "claude-code", name: "pdf", reason: taken }]);
  const toast = skillInstalledToast(merged, [{ id: "claude-code", name: "Claude Code" }]);
  assert.equal(toast.kind, "partial");
  assert.equal(toast.reason, "Claude Code 没链上：那里已有同名的");
  assert.deepEqual(skillHandleTarget(merged, "global"), { domainKey: "global", skill: "pdf" });
  // 后端已经报过的不重复；没被拿掉的 agent 不算
  const already = outcome([{ harnessId: "claude-code", name: "pdf", reason: taken }]);
  assert.equal(withTakenSkipped(already, dirs, ["claude-code"]).unlinked.length, 1);
  assert.deepEqual(withTakenSkipped(reply, dirs, []).unlinked, []);
});

test("去处理落到 SKILLS · 我的；当前位置看不见那一行时换到它的位置，看得见就不动", () => {
  const projects = [PROJECT];
  // 在 SKILLS 的发现一面装的
  const discover = goFace(DEFAULT_NAV, "discover");
  const fromAll = goRow(discover, PROJECT, projects);
  assert.equal(fromAll.destination, "skills");
  assert.equal(fromAll.face.skills, "mine");
  assert.equal(fromAll.location.skills, "all", "全部里本来就有这个项目，不动");
  // 当前停在用户级、装到了项目：换到这个项目
  const onUser = goLocation(discover, "user");
  assert.equal(goRow(onUser, PROJECT, projects).location.skills, PROJECT);
  // 当前停在另一个项目、装到了用户级：换到用户级
  const onOther = goLocation(discover, "project:/w/other");
  assert.equal(goRow(onOther, "global", projects).location.skills, "user");
  // MCP 页的位置、面不跟着动
  const fromMcp = goDestination(goLocation(goDestination(DEFAULT_NAV, "mcp"), PROJECT), "mcp");
  const went = goRow(fromMcp, "global", projects);
  assert.equal(went.location.mcp, PROJECT);
  assert.equal(went.face.mcp, "mine");
});

const cell = (targetId: string, state: CellState) => ({
  sourceId: "",
  skill: "pdf",
  targetId,
  path: "",
  state,
  pointsTo: null,
});
const row = (domainKey: string, sourceId: string, skill: string, states: CellState[]): SkillRow =>
  ({
    domainKey,
    sourceId,
    skill,
    cells: states.map((s, i) => cell(`t${i}`, s)),
  }) as unknown as SkillRow;

test("按位置 key + skill 名找那一行：同名几份里先找没链上的那一份（装进来的），找不到时取第一份", () => {
  const agents = row("global", "/h/.agents/skills", "pdf", ["duplicate", "linked"]);
  const claude = row("global", "/h/.claude/skills", "pdf", ["own", "missing"]);
  const inProject = row(PROJECT, "/p/.agents/skills", "pdf", ["duplicate"]);
  const docx = row("global", "/h/.agents/skills", "docx", ["linked"]);
  const rows = [claude, docx, agents, inProject];
  assert.equal(rowForHandle(rows, { domainKey: "global", skill: "pdf" }), agents);
  assert.equal(rowForHandle(rows, { domainKey: PROJECT, skill: "pdf" }), inProject);
  assert.equal(rowForHandle([claude], { domainKey: "global", skill: "pdf" }), claude);
  assert.equal(rowForHandle(rows, { domainKey: "global", skill: "xlsx" }), null);
  // 正在「只留这份」、先藏起来的那一份不算
  assert.equal(
    rowForHandle(
      rows,
      { domainKey: "global", skill: "pdf" },
      new Set(["global|/h/.agents/skills|pdf"]),
    ),
    claude,
  );
});

// ───────── 抽屉里的表 ─────────

test("抽屉表：一行一份（与表格同序），行首位置名，只有「原件」一列；两份时行尾「只留这份」", () => {
  const table = skillDiffTable([
    { id: "a", place: "~/.agents", path: "/Users/you/.agents/skills/pdf" },
    { id: "b", place: "Claude Code", path: "/Users/you/.claude/skills/pdf" },
  ]);
  assert.deepEqual(
    table.rows.map((r) => [r.id, r.place, r.path, r.keepBlocked]),
    [
      ["a", "~/.agents", "/Users/you/.agents/skills/pdf", null],
      ["b", "Claude Code", "/Users/you/.claude/skills/pdf", null],
    ],
  );
  assert.equal(table.keep, true);
  // 「只留这份」的对家：两份时就是另一份
  assert.equal(table.rows[0].otherId, "b");
  assert.equal(table.rows[1].otherId, "a");
});

test("抽屉表：另一份在应用包里时这一份的「只留这份」禁用并说原因；三份以上没有键那一列", () => {
  const app = skillDiffTable([
    { id: "a", place: "~/.agents", path: "/Users/you/.agents/skills/ego" },
    { id: "b", place: "ego lite", path: "/Applications/ego lite.app/Contents/skills/ego" },
  ]);
  assert.match(app.rows[0].keepBlocked ?? "", /ego lite\.app/, "留 a 就要删 b，b 在应用包里");
  assert.equal(app.rows[1].keepBlocked, null, "留 b 删的是 a，照常能按");
  const three = skillDiffTable([
    { id: "a", place: "~/.agents", path: "/a/pdf" },
    { id: "b", place: "Claude Code", path: "/b/pdf" },
    { id: "c", place: "WeiboAP", path: "/c/pdf" },
  ]);
  assert.equal(three.rows.length, 3);
  assert.equal(three.keep, false);
  assert.equal(three.rows[0].otherId, null);
});

test("抽屉里那一段用 DiffTable（段首小标「N 份不一样」），原来的一句推荐加键去掉", () => {
  const dv = readFileSync(new URL("../src/DomainView.tsx", import.meta.url), "utf8");
  assert.match(dv, /<DiffTable/);
  assert.match(dv, /tn\("skills\.dup\.differ", /);
  assert.match(dv, /actionLabel=\{table\.keep \? t\("skills\.keep\.label"\) : undefined\}/);
  assert.doesNotMatch(dv, /skills\.dup\.advice"|skills\.dup\.adviceOther|mx-detail__keep/);
});

// ───────── 装完那一窗 ─────────

const service = {
  undoSkill: async () => ({ entries: [] }),
  undoMcp: async () => ({ outcome: "undone" }),
} as unknown as MarketService;
const partial = {
  tier: "notice" as const,
  kind: "partial" as const,
  sentence: "market.toast.installPartial" as const,
  names: ["pdf"],
  agents: [],
  reason: "Claude Code 没链上：那里已有同名的",
};

test("有「没链上」时提示条里有「去处理」，排在「撤销」前；没有时没有", () => {
  const html = render(InstalledToast, {
    notice: {
      kind: "skill",
      toast: partial,
      undoId: "u1",
      handle: { domainKey: "global", skill: "pdf" },
    },
    onDismiss: noop,
    onHandle: noop,
    service,
  });
  const go = html.indexOf(">去处理<");
  const undo = html.indexOf(">撤销<");
  assert.ok(go > 0, "有去处理");
  assert.ok(undo > go, "去处理在撤销前");
  assert.match(html, /class="ss-btn ss-btn--compact">去处理</);
  const plain = render(InstalledToast, {
    notice: { kind: "skill", toast: { ...partial, reason: undefined }, undoId: "u1", handle: null },
    onDismiss: noop,
    onHandle: noop,
    service,
  });
  assert.doesNotMatch(plain, /去处理/);
  assert.match(plain, />撤销</);
});

test("右下两行：字在左（第一行「已安装 pdf」、第二行「Claude Code 没链上：…」），键与 × 在右侧一格", () => {
  const html = render(NoticeLines, {
    wrapped: true,
    main: createElement("span", { className: "probe-main" }, "已安装 pdf"),
    reason: "Claude Code 没链上：那里已有同名的",
    go: { label: "去处理", onClick: noop },
    action: { label: "撤销", onClick: noop },
    onClose: noop,
  });
  assert.match(
    html,
    /^<div class="ss-toast__body is-two"><div class="ss-toast__text"><div class="ss-toast__main"><span class="probe-main">已安装 pdf<\/span><\/div><div class="ss-toast__sub">Claude Code 没链上：那里已有同名的<\/div><\/div><span class="ss-toast__actions">/,
  );
  assert.ok(html.indexOf(">去处理<") < html.indexOf(">撤销<"));
  assert.ok(html.indexOf(">撤销<") < html.indexOf('aria-label="关闭"'));
  // 一行时（放得下）：原因照旧接在 ` · ` 后，键与 × 在主行右端
  const flat = render(NoticeLines, {
    wrapped: false,
    main: createElement("span", null, "已安装 pdf"),
    reason: "原因",
    action: { label: "撤销", onClick: noop },
  });
  assert.match(flat, /^<div class="ss-toast__body"><div class="ss-toast__main">/);
  assert.match(flat, /class="ss-toast__reason">原因</);
  // 两行：字一格、键一格，键跨两行上下居中；第二行 12 ink-mute
  const two = cssRule(uiCss, ".ss-toast__body.is-two");
  assert.match(two, /display: grid;/);
  assert.match(two, /grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(two, /align-items: center;/);
  const sub = cssRule(uiCss, ".ss-toast__sub");
  assert.match(sub, /font-size: var\(--size-label\);/);
  assert.match(sub, /color: var\(--ink-mute\);/);
  // 一行时主行不折（折了量不出放不下），放不下由组件改两行
  assert.match(
    uiCss,
    /\.ss-toast--notice:not\(\.is-wrapped\) \.ss-toast__main \{\s*flex-wrap: nowrap;/,
  );
});

test("文案三种语言同一套键：去处理、N 份不一样", async () => {
  for (const lang of ["zh-Hans", "zh-Hant", "en"]) {
    const market = JSON.parse(
      readFileSync(new URL(`../locales/${lang}/market.json`, import.meta.url), "utf8"),
    );
    const skills = JSON.parse(
      readFileSync(new URL(`../locales/${lang}/skills.json`, import.meta.url), "utf8"),
    );
    assert.ok(market["market.action.handle"], `${lang} market.action.handle`);
    assert.ok(skills["skills.dup.differ"], `${lang} skills.dup.differ`);
  }
});
