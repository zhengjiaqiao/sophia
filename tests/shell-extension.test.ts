import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { render } from "./ui-render.ts";
import { visibleAgents } from "../src/shell/agentRegistry.ts";
import type { AgentEntry, AgentState } from "../src/shell/agentRegistry.ts";
import type { SidebarItem } from "../src/shell/Sidebar.tsx";

/// 两个扩展点（DESIGN「扩展预留：用量与会话」；spec 2026-09-26-object-first-navigation R1 R11）：
/// 目的地表决定侧栏（tests/shell-destinations.test.ts），agent 能力注册表决定模型页的节——往表里加一项，不改外壳

const { AGENTS } = await import("../src/shell/agents.tsx");
const { Sidebar } = await import("../src/shell/Sidebar.tsx");
const { ModelsPage } = await import("../src/shell/ModelsPage.tsx");

const macState: AgentState = { gateway: null, modelsSupported: true };

const fake: AgentEntry = {
  id: "claude-code",
  name: "Claude Code",
  available: () => true,
  indicator: () => false,
  sections: [{ id: "usage", title: "用量", Component: () => createElement("p", null, "假用量节") }],
};

const ITEMS: SidebarItem[] = [
  { id: "skills", label: "skills", on: false },
  { id: "mcp", label: "mcp", on: false },
  { id: "models", label: "模型", on: false },
];
const sidebar = (items: SidebarItem[], selected: SidebarItem["id"] | "settings" = "skills") =>
  render(Sidebar, { items, selected, onSelect: () => undefined });

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

test("AC1 侧栏平铺：SKILLS / MCP 经 Cap 大写、模型原样，设置贴底；没有项目、没有组小标，全栏只有一项选中", () => {
  const side = sidebar(ITEMS);
  const names = [...side.matchAll(/class="side-item__name">(.*?)<\/span><\/button>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, ""),
  );
  assert.deepEqual(names, ["skills", "mcp", "模型", "设置"]);
  assert.match(side, /<span class="ss-cap-wrap ss-cap-wrap--nav"><span class="ss-cap">skills</);
  assert.doesNotMatch(side, /ss-sectionlabel|sidebar__add|用户级|全局|data-project/);
  assert.equal(side.match(/aria-current="page"/g)?.length, 1);
  assert.equal(sidebar(ITEMS, "settings").match(/aria-current="page"/g)?.length, 1);
  assert.match(side, /class="sidebar__foot"[^]*>设置</);
});

test("AC2 橙点只在开着时画，不画灰点", () => {
  assert.doesNotMatch(sidebar(ITEMS), /ss-indicator/);
  const lit = sidebar(ITEMS.map((i) => (i.id === "models" ? { ...i, on: true } : i)));
  assert.equal(lit.match(/ss-indicator is-on/g)?.length, 1);
});

test("AC21 模型页：页面头只写「模型」；往注册表加一个只有一节的假 agent，模型页多出它那一节", () => {
  const { agents } = visibleAgents([fake], macState);
  const page = render(ModelsPage, {
    entries: agents,
    onError: () => undefined,
    onGatewayState: () => undefined,
  });
  assert.match(page, /page-head__title[^>]*>模型</);
  assert.match(
    page,
    /<section[^>]*aria-label="Claude Code · 用量"[^>]*><p>假用量节<\/p><\/section>/,
  );
});

test("没有节的 agent 不列，也不灰着列", () => {
  const empty: AgentEntry = { ...fake, id: "cursor", name: "Cursor", sections: [] };
  assert.deepEqual(visibleAgents([empty], macState).agents, []);
});

test("模型页整页（页面头连同各节）限宽 776：外框包住页面头", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  assert.match(css, /\.agent-page \{[^}]*max-width: 776px;/);
  const page = render(ModelsPage, {
    entries: [fake],
    onError: () => undefined,
    onGatewayState: () => undefined,
  });
  assert.match(page, /^<div class="agent-page"><div class="page-head/);
});

test("PageHead 在组件库里：旧的 shell 转出已删，壳与模型页从 ui 取", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const ui = await import("../src/ui/index.ts");
  assert.equal(typeof ui.PageHead, "function");
  assert.equal(existsSync(new URL("../src/shell/PageHead.tsx", import.meta.url)), false);
  for (const file of [
    "../src/App.tsx",
    "../src/shell/ModelsPage.tsx",
    "../src/pages/SettingsPage.tsx",
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(src, /shell\/PageHead|from "\.\/PageHead/, file);
  }
  // 页面头的长相归组件库；壳只留它在机面里的摆法（故障下、SKILLS / MCP 吸顶）
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /^\.page-head \{|^\.page-head__title \{/m);
});

test("模型页还不知道支不支持时：出「正在读」的忙碌空态，不是只有标题的空页", () => {
  const page = render(ModelsPage, {
    entries: [],
    loading: true,
    onError: () => undefined,
    onGatewayState: () => undefined,
  });
  assert.match(page, /page-head__title[^>]*>模型</);
  assert.match(page, /正在读模型设置/);
});
