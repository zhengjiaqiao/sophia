/// 设置 `Skills 和 MCP` 一节的 `生效范围` 一块（spec 2026-10-05-skill-mcp-batch2「项目来源」，画板第七稿；2026-10-06 并节）：
/// 一条设置行（名字 + 灰字，右端 `+ 项目` 紧凑键）连同下面的名单是一块；名单照 `显示的 agent`——三列勾选行，
/// 第一格用户级勾着且禁用；项目格没有图标，停上去提示框给路径；没勾的折进「不显示的 N 个 ›」，能勾回来。没有「移除」
import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";
import { scopeGroups } from "../src/pages/scopeSettings.ts";
import { routeMenuCommand, routeUnderModal } from "../src/shell/menuCommands.ts";
import { DEFAULT_NAV, goDestination } from "../src/shell/nav.ts";

const { ScopeSection } = await import("../src/pages/ScopeSection.tsx");

const p = (name: string, shown: boolean) => ({ path: `/w/${name}`, name, shown });
const noop = () => {};
const base = {
  kept: new Set<string>(),
  open: false,
  onOpen: noop,
  onToggle: noop,
  onAdd: noop,
  unchecked: null,
  onDismissUnchecked: noop,
  addNotice: null,
  onDismissAddNotice: noop,
};

test("格子：勾着的在上面一格一个，没勾的折进「不显示的」；这一程刚取消勾的留在原处", () => {
  const all = [p("sophia", true), p("jp-he", false), p("CardBox", true), p("docs", false)];
  assert.deepEqual(scopeGroups(all, new Set()), {
    grid: [all[0], all[2]],
    folded: [all[1], all[3]],
  });
  // 刚取消勾的 jp-he 不跳走：格子留着（没勾），不算进「不显示的 N 个」
  assert.deepEqual(scopeGroups(all, new Set(["/w/jp-he"])), {
    grid: [all[0], all[1], all[2]],
    folded: [all[3]],
  });
  assert.deepEqual(scopeGroups([], new Set()), { grid: [], folded: [] });
});

test("一块：设置行 生效范围 + 灰字，右端紧凑键 + 项目，名单紧跟在行下；第一格用户级勾着、禁用并说明原因", () => {
  const html = render(ScopeSection, { ...base, projects: [p("sophia", true)] });
  assert.match(
    html,
    /^<div class="settings-page__block"><div class="settings-page__row"><div class="settings-page__text"><div class="settings-page__label">生效范围<\/div><div class="settings-page__note">用户级一直在 · 项目来自 Claude Code、Codex 打开过的文件夹和「\+ 项目」选的<\/div><\/div><div class="settings-page__controls">/,
  );
  assert.doesNotMatch(html, /文件夹没了|ss-sectionlabel/);
  assert.match(
    html,
    /settings-page__controls">[\s\S]*class="ss-btn ss-btn--compact"[^>]*>[\s\S]*项目<\/button>/,
  );
  // 名单在设置行之后、同一块里
  assert.ok(html.indexOf("settings-page__controls") < html.indexOf("settings-page__grid"));
  assert.match(
    html,
    /role="checkbox" aria-checked="true"[^>]*disabled=""[^>]*>[\s\S]*?用户级[\s\S]*?role="tooltip"[^>]*>一直在，不能取消</,
  );
  // 没有「移除」，不分手动 / 自动
  assert.doesNotMatch(html, /移除|手动/);
});

test("项目格：没有图标，名字是文件夹名，提示框给完整路径；勾着的可以取消", () => {
  const html = render(ScopeSection, { ...base, projects: [p("sophia", true), p("CardBox", true)] });
  assert.doesNotMatch(html, /ss-checkrow__icon/);
  assert.match(html, /role="checkbox" aria-checked="true"[^>]*>[\s\S]*?sophia/);
  assert.match(html, /\/w\/sophia/);
  assert.match(html, /\/w\/CardBox/);
  // 三格：用户级 + 两个项目
  assert.equal(html.match(/role="checkbox"/g)?.length, 3);
});

test("不显示的 N 个 ›：字在前、拉手在后；收着时只有一行展开，不画里面的格子；拉开后是没勾的格子，能勾回来", () => {
  const projects = [p("sophia", true), p("jp-he", false), p("docs", false)];
  const closed = render(ScopeSection, { ...base, projects });
  assert.match(
    closed,
    /<div class="settings-page__more"><span class="settings-page__more-label">不显示的 2 个<\/span><button type="button" class="ss-drawerhandle is-always" aria-label="不显示的 2 个" aria-expanded="false" aria-controls="settings-scope-hidden">/,
  );
  assert.doesNotMatch(closed, /jp-he/);
  assert.equal(closed.match(/role="checkbox"/g)?.length, 2);
  const open = render(ScopeSection, { ...base, projects, open: true });
  assert.match(open, /role="checkbox" aria-checked="false"[^>]*>[\s\S]*?jp-he/);
  assert.match(open, /role="checkbox" aria-checked="false"[^>]*>[\s\S]*?docs/);
  assert.equal(open.match(/role="checkbox"/g)?.length, 4);
});

test("一个项目都不勾：上面只剩用户级一格；没有项目时没有「不显示的」那一行", () => {
  const none = render(ScopeSection, { ...base, projects: [p("a", false)] });
  assert.equal(none.match(/role="checkbox"/g)?.length, 1);
  assert.match(none, /不显示的 1 个/);
  const empty = render(ScopeSection, { ...base, projects: [] });
  assert.equal(empty.match(/role="checkbox"/g)?.length, 1);
  assert.doesNotMatch(empty, /不显示的/);
  // 读回来之前：用户级与 + 项目照画，项目格不画
  const loading = render(ScopeSection, { ...base, projects: null });
  assert.equal(loading.match(/role="checkbox"/g)?.length, 1);
});

test("取消勾那一刻：格子下浮起「Skills 和 MCP 不再管理它了 · 已建好的链接原样留着」", () => {
  const html = render(ScopeSection, {
    ...base,
    projects: [p("sophia", false)],
    kept: new Set(["/w/sophia"]),
    unchecked: { path: "/w/sophia", at: 1 },
  });
  assert.match(html, /Skills 和 MCP 不再管理它了/);
  assert.match(html, /已建好的链接原样留着/);
  assert.doesNotMatch(html, /不显示的/);
});

test("应用菜单「添加项目…」：不换页，直接弹文件夹选择器；反馈小窗开着时不做", () => {
  const at = goDestination(DEFAULT_NAV, "mcp");
  const r = routeMenuCommand("add-project", at, false);
  assert.equal(r.nav, at);
  assert.equal(r.addProject, true);
  assert.equal(r.page, undefined);
  assert.equal(routeUnderModal(r, at).addProject, undefined);
});
