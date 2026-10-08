import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { render } from "./ui-render.ts";
import { visibleAgents } from "../src/shell/agentRegistry.ts";
import type { AgentEntry, AgentState } from "../src/shell/agentRegistry.ts";
import type { AgentGatewayView, GatewayState } from "../src/types.ts";
import type { SidebarItem } from "../src/shell/Sidebar.tsx";
import { NO_MODELS, picked } from "./gateway-fixture.ts";

/// 两个扩展点（DESIGN「扩展预留：用量与会话」；spec 2026-09-26-object-first-navigation R1 R11）：
/// 目的地表决定侧栏（tests/shell-destinations.test.ts），agent 能力注册表决定模型页的节——往表里加一项，不改外壳

const { AGENTS } = await import("../src/shell/agents.tsx");
const { Sidebar } = await import("../src/shell/Sidebar.tsx");
const { ModelsPage } = await import("../src/shell/ModelsPage.tsx");

const macState: AgentState = { gateway: null, modelsSupported: true, usage: null };

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

// ===== R41 R45、#259：模型页一行的现状句、侧栏橙点＝任一家开着 =====

const desktop = {
  version: "2.9939.4",
  tooOld: false,
  managed: false,
  running: false,
  applied: false,
  pending: false,
  needsRestart: false,
  drift: false,
  restoreUnfinished: false,
  foreign: null,
};
const gatewayState = (
  codex: Partial<AgentGatewayView> = {},
  claude: Partial<AgentGatewayView> & { desktop?: Partial<typeof desktop> } = {},
): GatewayState => {
  const { desktop: extra, ...claudeView } = claude;
  return {
    supported: true,
    router: { running: false, port: 47328, error: "" },
    portNotice: null,
    agents: [
      {
        agent: "codex",
        installed: true,
        models: NO_MODELS,
        enabled: false,
        conflict: "",
        codex: {
          wanted: false,
          needsRestart: false,
          app: { version: "26.0", running: false, catalogVersion: "", drift: false, appName: "" },
          takeover: null,
          mode: "builtin",
          modeReason: null,
        },
        ...codex,
      },
      {
        agent: "claude",
        installed: true,
        models: NO_MODELS,
        enabled: false,
        conflict: "",
        claude: {
          profileModels: [],
          desktop: { ...desktop, ...extra },
        },
        ...claudeView,
      },
    ],
  };
};

// spec 2026-09-29 R45；#259 起模型页只列装了的、能接第三方模型的 agent（不看设置），没有二级页
test("agent 注册表：Codex、Claude 是用量 + 第三方模型，WorkBuddy 只有第三方模型（#266）；模型页只列装了的（用量只进托盘，spec 2026-09-26-menubar-usage 第 7 节）", () => {
  assert.deepEqual(
    AGENTS.map((a) => [a.id, a.gateway, a.sections.map((s) => s.title)]),
    [
      ["codex", "codex", ["用量", "第三方模型"]],
      ["claude-code", "claude", ["用量", "第三方模型"]],
      ["workbuddy", "workbuddy", ["第三方模型"]],
    ],
  );
  // 第三方模型那一节：模型页一行（现状句 + 右端控件 + 行下待办条）、托盘行；没有推入页
  for (const agent of AGENTS) {
    const models = agent.sections.find((s) => s.id === "third-party-models")!;
    assert.equal(models.Component, undefined, agent.id);
    assert.equal(typeof models.listRow?.status, "function", agent.id);
    assert.equal(typeof models.listRow?.Controls, "function", agent.id);
    assert.equal(typeof models.listRow?.Todos, "function", agent.id);
    // WorkBuddy 没有托盘行（#266）
    if (agent.id !== "workbuddy") assert.equal(typeof models.trayRow, "function", agent.id);
  }
  const both = { gateway: gatewayState(), modelsSupported: true, usage: null };
  assert.deepEqual(
    visibleAgents(AGENTS, both).agents.map((a) => a.id),
    ["codex", "claude-code"],
  );
  assert.equal(visibleAgents(AGENTS, both).known, true);
  // 没装的不列（不再列出灰开关）
  const codexOnly = {
    gateway: gatewayState({}, { installed: false }),
    modelsSupported: true,
    usage: null,
  };
  assert.deepEqual(
    visibleAgents(AGENTS, codexOnly).agents.map((a) => a.id),
    ["codex"],
  );
  assert.deepEqual(
    visibleAgents(AGENTS, { gateway: null, modelsSupported: false, usage: null }).agents,
    [],
  );
  // 还没问出支不支持、状态还没读回来：先不列，也不算「知道了」（落点不据此退回）
  for (const s of [
    { gateway: null, modelsSupported: null, usage: null },
    macState,
  ] as AgentState[]) {
    const unknown = visibleAgents(AGENTS, s);
    assert.deepEqual(unknown.agents, []);
    assert.equal(unknown.known, false);
  }
});

const agentState = (gateway: GatewayState): AgentState => ({
  gateway,
  modelsSupported: true,
  usage: null,
});
const statusOf = (agent: string, gateway: GatewayState) =>
  AGENTS.find((a) => a.id === agent)!
    .sections.find((s) => s.id === "third-party-models")!
    .listRow!.status(agentState(gateway));

// 画板第 1、1′ 屏：第二行按提供商计数（官方算一组），关着说没接，一个没选另说
test("#259 行的第二行：Codex 开着按提供商计数 `官方 2 · Kimi 2 · DeepSeek 1`；关着 `没接第三方模型`；没选第三方 / 被 agents-manager 管着各一句", () => {
  const five = picked("官方/gpt-6", "Kimi/kimi-k2.6", "官方/gpt-6-mini", "Kimi/kfc", "DeepSeek/v4");
  assert.equal(
    statusOf("codex", gatewayState({ models: five, enabled: true })),
    "官方 2 · Kimi 2 · DeepSeek 1",
  );
  assert.equal(statusOf("codex", gatewayState({ models: five })), "没接第三方模型");
  assert.equal(
    statusOf("codex", gatewayState({ models: picked("官方/gpt-6") })),
    "还没选第三方模型",
  );
  assert.equal(statusOf("codex", gatewayState()), "还没选第三方模型");
  const managed = gatewayState({
    models: five,
    codex: {
      wanted: false,
      needsRestart: false,
      app: { version: "26.0", running: false, catalogVersion: "", drift: false, appName: "" },
      takeover: { baseUrl: "https://wecode.example", selectedCount: 1 },
      mode: "builtin",
      modeReason: null,
    },
  });
  assert.equal(statusOf("codex", managed), "正由 agents-manager 管理");
});

test("#259 行的第二行：Claude 开着按提供商计数；关着 `没接第三方模型`；别家配置、受管、版本太旧各一句", () => {
  const three = picked("PackyCode/sonnet", "Kimi/kimi-k2.6", "DeepSeek/v4");
  assert.equal(
    statusOf("claude-code", gatewayState({}, { models: three, enabled: true })),
    "PackyCode 1 · Kimi 1 · DeepSeek 1",
  );
  assert.equal(statusOf("claude-code", gatewayState({}, { models: three })), "没接第三方模型");
  assert.equal(statusOf("claude-code", gatewayState()), "还没选模型");
  assert.equal(
    statusOf("claude-code", gatewayState({}, { models: three, desktop: { foreign: { id: "x" } } })),
    "正在用别的第三方配置",
  );
  assert.equal(
    statusOf("claude-code", gatewayState({}, { desktop: { managed: true } })),
    "由组织统一配置",
  );
  assert.equal(
    statusOf("claude-code", gatewayState({}, { desktop: { tooOld: true } })),
    "Claude 版本太旧",
  );
});

test("R45 侧栏橙点：任一家开着就亮，各读各的那一家", () => {
  const [codex, claude] = AGENTS;
  const lit = (gateway: GatewayState) =>
    AGENTS.filter((a) => a.indicator(agentState(gateway))).map((a) => a.id);
  assert.deepEqual(lit(gatewayState()), []);
  assert.deepEqual(lit(gatewayState({ enabled: true })), ["codex"]);
  assert.deepEqual(lit(gatewayState({}, { enabled: true })), ["claude-code"]);
  assert.equal(codex.indicator({ ...macState }), false, "状态还没读回来不亮");
  assert.equal(claude.indicator({ ...macState }), false);
});

test("R45 节级可用：Claude 用量已登录或本机支持第三方模型才列；不支持的机器上模型页不列它", () => {
  const claude = AGENTS[1];
  const notMac: AgentState = { gateway: null, modelsSupported: false, usage: null };
  assert.equal(claude.available(macState), true);
  assert.equal(claude.available(notMac), false);
  assert.deepEqual(visibleAgents(AGENTS, notMac).agents, []);
  // 节级可用为假的页内节不算：只剩它的 agent 不进模型页
  const gated: AgentEntry = {
    ...fake,
    sections: [{ ...fake.sections[0], available: () => false }],
  };
  assert.deepEqual(visibleAgents([gated], macState).agents, []);
  const unknown = visibleAgents(
    [{ ...gated, sections: [{ ...fake.sections[0], available: () => null }] }],
    macState,
  );
  assert.deepEqual(unknown.agents, []);
  assert.equal(unknown.known, false, "节级还不知道：落点不据此退回");
});

test("只进托盘的节（没有 Component）不进模型页；只有这种节的 agent 不让侧栏出现「模型」", () => {
  const trayOnly: AgentEntry = {
    ...fake,
    sections: [{ id: "usage", title: "用量", trayRow: () => createElement("p", null, "托盘行") }],
  };
  assert.deepEqual(visibleAgents([trayOnly], macState).agents, []);
  const mixed: AgentEntry = {
    ...fake,
    sections: [
      ...trayOnly.sections,
      ...fake.sections.map((s) => ({ ...s, id: "tpm", title: "第三方模型" })),
    ],
  };
  const page = render(ModelsPage, {
    entries: visibleAgents([mixed], macState).agents,
    state: macState,
    onError: () => undefined,
    onGatewayState: () => undefined,
  });
  assert.doesNotMatch(page, /托盘行|· 用量/);
  assert.match(page, /aria-label="Claude Code · 第三方模型"/);
});

test("AC1 侧栏平铺：SKILLS / MCP 经 Cap 大写、模型原样，设置贴底；没有项目、没有组小标，全栏只有一项选中", () => {
  const side = sidebar(ITEMS);
  const names = [...side.matchAll(/class="side-item__name">(.*?)<\/span><\/button>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, ""),
  );
  // 2026-09-30 侧栏仍叫「模型」（产品负责人取代同日改名「第三方模型」）
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

test("AC21 模型页：页面头只写「模型」（与侧栏同名，2026-09-30 取代改名「第三方模型」）；往注册表加一个只有一节的假 agent，模型页多出它那一节", () => {
  const { agents } = visibleAgents([fake], macState);
  const page = render(ModelsPage, {
    entries: agents,
    state: macState,
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

test("模型页整页（页面头连同各节）限宽同各页（--panel-w，2026-09-30 起随窗口变宽）：外框包住页面头", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  assert.match(css, /\.agent-page \{[^}]*max-width: var\(--panel-w\);/);
  const page = render(ModelsPage, {
    entries: [fake],
    state: macState,
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
    state: macState,
    onError: () => undefined,
    onGatewayState: () => undefined,
  });
  assert.match(page, /page-head__title[^>]*>模型</);
  assert.match(page, /正在读模型设置/);
});
