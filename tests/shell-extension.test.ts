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
    { command: "tab-skills", label: "skills", accelerator: "CmdOrCtrl+1" },
    { command: "tab-mcp", label: "mcp", accelerator: "CmdOrCtrl+2" },
    { command: "tab-sessions", label: "sessions", accelerator: "CmdOrCtrl+3" },
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
    /aria-current="page"[^>]*><span class="ss-tabs__label" data-label="sessions">/,
  );
});
