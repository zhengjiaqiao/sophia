import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { render } from "./ui-render.ts";
import { visibleAgents, sidebarAgentsOf } from "../src/shell/agentRegistry.ts";
import type { AgentEntry, AgentState } from "../src/shell/agentRegistry.ts";
import { domainMenuItems, LOCATION_DOMAINS } from "../src/shell/domains.ts";

/// 两个扩展点（DESIGN「扩展预留：用量与会话」）：往表里加一项，外壳各处同时出现，不改别的代码

const { AGENTS } = await import("../src/shell/agents.tsx");
const { Sidebar } = await import("../src/shell/Sidebar.tsx");
const { AgentPage } = await import("../src/shell/AgentPage.tsx");
const { Tabs } = await import("../src/ui/Tabs.tsx");

const macState: AgentState = { gateway: null, modelsSupported: true };

const fake: AgentEntry = {
  id: "claude-code",
  name: "Claude Code",
  available: () => true,
  indicator: () => false,
  sections: [{ id: "usage", title: "用量", Component: () => createElement("p", null, "假用量节") }],
};

const sidebarProps = (agents: ReturnType<typeof sidebarAgentsOf>) => ({
  agents,
  projects: [],
  projectTimes: new Map(),
  selection: { kind: "agent" as const, id: "claude-code" },
  onSelectLocation: () => undefined,
  onSelectAgent: () => undefined,
  onSelectSettings: () => undefined,
  sort: "active" as const,
  onSort: () => undefined,
  projectBusy: null,
  onAddProject: () => undefined,
  onRemoveProject: () => undefined,
  removed: null,
  onUndoRemove: () => undefined,
  onRemovedGone: () => undefined,
});

test("agent 注册表：今天只有 Codex 一项、一节（第三方模型），只在支持时列出", () => {
  assert.deepEqual(
    AGENTS.map((a) => [a.id, a.sections.map((s) => s.title)]),
    [["codex", ["第三方模型"]]],
  );
  assert.deepEqual(
    visibleAgents(AGENTS, macState).agents.map((a) => a.id),
    ["codex"],
  );
  assert.deepEqual(visibleAgents(AGENTS, { gateway: null, modelsSupported: false }).agents, []);
  // 还没问出支不支持：先不列，也不算「知道了」（落点不据此退回）
  const unknown = visibleAgents(AGENTS, { gateway: null, modelsSupported: null });
  assert.deepEqual(unknown.agents, []);
  assert.equal(unknown.known, false);
});

test("往注册表加一个只有一节的假 agent：侧栏与 agent 页都出现它", () => {
  const { agents } = visibleAgents([...AGENTS, fake], macState);
  assert.deepEqual(
    agents.map((a) => a.id),
    ["codex", "claude-code"],
  );
  const side = render(Sidebar, sidebarProps(sidebarAgentsOf(agents, macState)));
  assert.match(side, />Codex</);
  assert.match(side, />Claude Code</);
  // 选中的是它：全栏只有这一项是 aria-current
  assert.equal(side.match(/aria-current="page"/g)?.length, 1);
  const page = render(AgentPage, {
    entry: agents[1],
    onError: () => undefined,
    onGatewayState: () => undefined,
  });
  assert.match(page, /page-head__title[^>]*>.*Claude Code/);
  assert.match(page, /<section[^>]*aria-label="用量"[^>]*><p>假用量节<\/p><\/section>/);
});

test("没有节的 agent 不列，也不灰着列", () => {
  const empty: AgentEntry = { ...fake, id: "cursor", name: "Cursor", sections: [] };
  assert.deepEqual(visibleAgents([empty], macState).agents, []);
});

test("指示点只在开着时画，不画灰点", () => {
  const on: AgentEntry = { ...fake, indicator: () => true };
  const off = render(Sidebar, sidebarProps(sidebarAgentsOf([fake], macState)));
  const lit = render(Sidebar, sidebarProps(sidebarAgentsOf([on], macState)));
  assert.doesNotMatch(off, /ss-indicator/);
  assert.match(lit, /ss-indicator is-on/);
});

test("domain 列表：今天 skills、mcp；加第三项，页签、⌘ 数字键、菜单「显示」的项同时出现", () => {
  assert.deepEqual(
    LOCATION_DOMAINS.map((d) => d.id),
    ["skills", "mcp"],
  );
  const more = [...LOCATION_DOMAINS, { id: "sessions", label: "sessions" }];
  assert.deepEqual(domainMenuItems(more), [
    // 菜单项与页签显示的字同写大写（原生菜单没有 Cap）；与 menu.rs 的 tab_item 同一条规则
    { command: "tab-skills", label: "SKILLS", accelerator: "CmdOrCtrl+1" },
    { command: "tab-mcp", label: "MCP", accelerator: "CmdOrCtrl+2" },
    { command: "tab-sessions", label: "SESSIONS", accelerator: "CmdOrCtrl+3" },
  ]);
  const tabs = render(Tabs, {
    items: more,
    value: "sessions",
    onChange: () => undefined,
    label: "表",
  });
  assert.equal(tabs.match(/class="ss-tabs__tab/g)?.length, 3);
  assert.match(
    tabs,
    /aria-current="page"[^>]*><span class="ss-cap-wrap ss-cap-wrap--nav"><span class="ss-cap">sessions</,
  );
});

test("`+ 项目` 在侧栏滚动区里吸底：项目少时紧跟最后一项，多到要滚时停在可见区底边；底色 shell，吸住时上沿 1px row-line（不再渐隐）", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.sidebar__add \{[^}]*position: sticky;[^}]*bottom: 0;[^}]*background: var\(--shell\);/,
  );
  // 线只在吸住（下面还有项目）时画，左右与侧栏项同宽（外距 10）
  assert.match(
    css,
    /\.sidebar__add\[data-stuck\]::before \{[^}]*right: 10px;[^}]*left: 10px;[^}]*border-top: var\(--border-row\);/,
  );
  // 2026-09-25 改用线替代渐隐：`+ 项目` 的规则里不再有渐变
  const addRules = css.match(/\.sidebar__add[^{]*\{[^}]*\}/g) ?? [];
  assert.ok(addRules.length > 0);
  for (const rule of addRules) assert.doesNotMatch(rule, /linear-gradient/);
  const tsx = readFileSync(new URL("../src/shell/Sidebar.tsx", import.meta.url), "utf8");
  // 仍在滚动区（nav）里、是项目列表的最后一项，不挪到贴底区；哨兵紧跟在它原位之后
  assert.match(
    tsx,
    /<nav\s+className="sidebar__nav"[^]*className="sidebar__add" data-stuck=[^]*ref=\{addEndRef\}[^]*<\/nav>/,
  );
  // 是否吸住由哨兵的 IntersectionObserver 判断（跨线才回调），不在滚动事件里逐帧算
  assert.match(tsx, /new IntersectionObserver\(/);
  assert.doesNotMatch(tsx, /nav\.scrollTop \+ nav\.clientHeight/);
});

test("`+ 项目` 是侧栏的一行，不是键：14px + 图标 + `项目`，同项目行的 side-item", () => {
  const side = render(Sidebar, sidebarProps([]));
  const add = side.slice(side.indexOf('class="sidebar__add"'));
  assert.match(
    add,
    /^class="sidebar__add"><div class="side-item side-item--add">(?:<span class="ss-tipwrap[^"]*">)?<button type="button" class="side-item__main"[^>]*><span class="side-item__icon"><svg width="14" height="14"[^]*?<\/svg><\/span><span class="side-item__name">项目<\/span><\/button>/,
  );
  // 没吸住时不带 data-stuck；不是键、不带省略号
  assert.doesNotMatch(add.slice(0, 40), /data-stuck/);
  assert.doesNotMatch(add.slice(0, add.indexOf("</button>")), /ss-btn/);
  assert.doesNotMatch(side, /项目…/);
});

test("`+ 项目` 忙着时禁用：正在移除时带原因", () => {
  const locked = render(Sidebar, { ...sidebarProps([]), projectBusy: "remove" as const });
  assert.match(locked, /class="side-item__main" title="正在移除项目，稍等" disabled=""/);
});

test("agent 页整页（页面头连同各节）限宽 776：外框包住页面头", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  assert.match(css, /\.agent-page \{[^}]*max-width: 776px;/);
  const page = render(AgentPage, {
    entry: fake,
    onError: () => undefined,
    onGatewayState: () => undefined,
  });
  assert.match(page, /^<div class="agent-page"><div class="page-head/);
});

test("侧栏滚动区往下滚过之后上沿 16 渐隐：滚过去的项目不在字标带下面硬切", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.sidebar__nav\[data-fade-top\]::before \{[^}]*position: sticky;[^}]*top: 0;[^}]*height: var\(--fade-edge\);[^}]*linear-gradient\(to bottom, var\(--shell\), transparent\)/,
  );
  // 量归 ui 的 useEdgeFades（全应用只有这一份监听），侧栏只取上沿
  const tsx = readFileSync(new URL("../src/shell/Sidebar.tsx", import.meta.url), "utf8");
  assert.match(tsx, /const scrolled = useEdgeFades\(navRef\)\.start;/);
  assert.doesNotMatch(tsx, /addEventListener\("scroll"/);
  assert.match(tsx, /data-fade-top=\{scrolled \? "" : undefined\}/);
});

test("侧栏区块小标与排序下拉走组件库：SectionLabel（`AGENT` 经 Cap）、排序是 FloatingLayer 里的单选 Menu，不再自写定位", async () => {
  const { readFileSync } = await import("node:fs");
  const side = render(Sidebar, sidebarProps(sidebarAgentsOf([fake], macState)));
  assert.match(
    side,
    /<div class="sidebar__head"><div class="ss-sectionlabel"><span class="ss-sectionlabel__text"><span class="ss-cap-wrap ss-cap-wrap--label"><span class="ss-cap">agent</,
  );
  assert.match(
    side,
    /<div class="ss-sectionlabel has-action"><span class="ss-sectionlabel__text">项目<\/span><span class="ss-sectionlabel__action"><button type="button" class="sidebar__sort-button" aria-haspopup="menu" aria-expanded="false">最近活跃/,
  );
  const tsx = readFileSync(new URL("../src/shell/Sidebar.tsx", import.meta.url), "utf8");
  assert.match(tsx, /<FloatingLayer trigger=\{button\.current\} onClose=\{close\} label="项目排序">/);
  assert.match(tsx, /<MenuItem\s+key=\{s\.id\}\s+kind="radio"/);
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.sidebar__sort-menu|\.sidebar__sort-item|\.sidebar__label/);
});

test("PageHead 在组件库里：旧的 shell 路径只是转出，壳与 agent 页从 ui 取", async () => {
  const { readFileSync } = await import("node:fs");
  const ui = await import("../src/ui/index.ts");
  const old = await import("../src/shell/PageHead.tsx");
  assert.equal(old.PageHead, ui.PageHead);
  assert.equal(old.PageTitle, ui.PageTitle);
  assert.equal(old.PageHeadActions, ui.PageHeadActions);
  for (const file of ["../src/App.tsx", "../src/shell/AgentPage.tsx", "../src/pages/SettingsPage.tsx"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(src, /shell\/PageHead|from "\.\/PageHead/, file);
  }
  // 页面头的长相归组件库；壳只留它在机面里的摆法（故障下、位置页吸顶）
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /^\.page-head \{|^\.page-head__title \{/m);
});
