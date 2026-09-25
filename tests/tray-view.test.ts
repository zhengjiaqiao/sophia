import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import {
  trayAgentState,
  trayBlocks,
  trayRow,
  RESTART_CONSEQUENCE,
  RESTART_TIP,
} from "../src/trayView.ts";
import { enableDisabledReason } from "../src/modelsView.ts";
import type { AgentEntry } from "../src/shell/agentRegistry.ts";
import type { GatewayProviderModel, GatewayState } from "../src/types.ts";
import { render } from "./ui-render.ts";

const { AGENTS } = await import("../src/shell/agents.tsx");

const model = (id: string, selected: boolean): GatewayProviderModel => ({
  id,
  slug: id,
  displayName: id,
  selected,
});

// `providers` 是权威来源（PR #9），这里跟着 `provider` 走：面板自己还在读兼容字段，
// 但它调的 modelsView 已经按 providers 判断了，一份夹具里两处事实不能对不上
const state = (overrides: Partial<GatewayState> = {}): GatewayState => {
  const provider = overrides.provider ?? {
    baseUrl: "https://example.com/openai",
    hasKey: true,
    models: [],
  };
  return {
    supported: true,
    provider,
    providers: overrides.providers ?? [provider],
    enabled: false,
    needsCodexRestart: false,
    router: { installed: false, running: false, port: 47328, protocol: "chat", error: "" },
    codex: { version: "26.0", running: false, catalogVersion: "1", drift: false },
    conflict: "",
    takeover: null,
    ...overrides,
  };
};

const withModels = (n: number, overrides: Partial<GatewayState> = {}) =>
  state({
    ...overrides,
    provider: {
      baseUrl: "https://example.com/openai",
      hasKey: true,
      models: [...Array(n)].map((_, i) => model(`m${i}`, true)).concat(model("off", false)),
      ...(overrides.provider ?? {}),
    },
  });

// UI v4：托盘与模型页同一行的缩小版——开关是 page Switch（不再是「启用 / 已启用」pill），
// 没有状态句（DESIGN「托盘面板」）。原先钉 label / status / needsSetup 的断言属于被推翻的行为，按新规范改写
test("AC1 已启用：开关开着、可点", () => {
  const row = trayRow(
    withModels(3, {
      enabled: true,
      router: { installed: true, running: true, port: 47328, protocol: "chat", error: "" },
    }),
  );
  assert.equal(row.toggle.on, true);
  assert.equal(row.toggle.disabledReason, null);
  assert.equal("status" in row, false, "托盘没有状态句");
});

test("可以启用：开关关着、可点", () => {
  const row = trayRow(withModels(2));
  assert.equal(row.toggle.on, false);
  assert.equal(row.toggle.disabledReason, null);
});

// 原因的文案归 modelsView（与 Codex 页同一句），这里只钉「禁用、且说的是同一句」
test("AC2 没保存密钥：开关禁用并说原因（与 Codex 页同一句）", () => {
  const s = state({ provider: { baseUrl: "", hasKey: false, models: [] } });
  const row = trayRow(s);
  assert.equal(row.toggle.on, false);
  assert.notEqual(row.toggle.disabledReason, null);
  assert.equal(row.toggle.disabledReason, enableDisabledReason(s, 0));
});

test("没选模型：开关禁用并说原因（与 Codex 页同一句）", () => {
  const s = withModels(0);
  const row = trayRow(s);
  assert.notEqual(row.toggle.disabledReason, null);
  assert.equal(row.toggle.disabledReason, enableDisabledReason(s, 0));
});

test("AC3 由 agents-manager 启用：开关禁用，原因是先接管", () => {
  const row = trayRow(withModels(2, { takeover: { baseUrl: "https://x", selectedCount: 2 } }));
  assert.match(row.toggle.disabledReason ?? "", /接管/);
});

test("已启用时永远能关：哪怕密钥没了、模型清空了", () => {
  const row = trayRow(
    state({ enabled: true, provider: { baseUrl: "", hasKey: false, models: [] } }),
  );
  assert.equal(row.toggle.on, true);
  assert.equal(row.toggle.disabledReason, null);
});

// ===== 块与行从 agent 注册表生成（DESIGN「托盘面板」「扩展预留：用量与会话」） =====

test("块从注册表生成：今天 Codex 一块、一行 `第三方模型`（画法是注册表里那一节的 trayRow）；这台机器不支持时整块不出现", () => {
  const blocks = trayBlocks(AGENTS, trayAgentState(state()));
  assert.deepEqual(
    blocks.map((b) => [b.id, b.name, b.rows.map((r) => [r.id, r.title])]),
    [["codex", "Codex", [["third-party-models", "第三方模型"]]]],
  );
  assert.equal(blocks[0].rows[0].Row, AGENTS[0].sections[0].trayRow);
  assert.deepEqual(trayBlocks(AGENTS, trayAgentState(state({ supported: false }))), []);
  // 状态还没读回来：先不出块（只剩菜单）
  assert.deepEqual(trayBlocks(AGENTS, trayAgentState(null)), []);
});

test("往注册表加一个 agent、给 Codex 加一节带 trayRow 的 `用量`：面板按表的先后成块成行、画出那一行，面板代码不改", async () => {
  const { TrayAgents } = await import("../src/TrayPanel.tsx");
  const Section = () => createElement("p");
  const UsageRow = ({ title }: { title: string }) =>
    createElement("div", { className: "fake-usage" }, `${title} 42%`);
  const codex = AGENTS[0];
  const usage = { id: "usage", title: "用量", Component: Section, trayRow: UsageRow };
  const registry: AgentEntry[] = [
    { ...codex, sections: [usage, ...codex.sections] },
    {
      id: "claude-code",
      name: "Claude Code",
      available: () => true,
      indicator: () => false,
      sections: [usage],
    },
    // 有节、但没有一节带托盘画法：不成块（不留空块头）
    {
      id: "cursor",
      name: "Cursor",
      available: () => true,
      indicator: () => false,
      sections: [{ id: "usage", title: "用量", Component: Section }],
    },
  ];
  const agentState = trayAgentState(state());
  const blocks = trayBlocks(registry, agentState);
  assert.deepEqual(
    blocks.map((b) => [b.name, b.rows.map((r) => r.title)]),
    [
      ["Codex", ["用量", "第三方模型"]],
      ["Claude Code", ["用量"]],
    ],
  );
  // 真的画出来：TrayPanel 的块渲染按注册表把假节的 trayRow 画进 Codex 与 Claude Code 两块
  const host = {
    applyGateway: () => undefined,
    idle: async () => undefined,
    alive: () => true,
    openedAt: 0,
    failOver: () => undefined,
  };
  const html = render(TrayAgents, { blocks, state: agentState, host });
  assert.equal((html.match(/class="fake-usage">用量 42%</g) ?? []).length, 2);
  assert.match(html, /aria-label="Codex"[^]*fake-usage[^]*tray__cap-title">第三方模型</);
  assert.match(html, /aria-label="Claude Code"[^]*fake-usage/);
  assert.doesNotMatch(html, /Cursor/);
});

test("AC4 重启 Codex 的后果句：说会发生什么，不写「确定吗」；提示框写明只管桌面应用", () => {
  assert.match(RESTART_CONSEQUENCE, /中断/);
  assert.doesNotMatch(RESTART_CONSEQUENCE, /确定|是否/);
  assert.equal(RESTART_TIP, "重启 Codex 桌面应用让改动生效，进行中的对话会中断");
});

// 「重启生效」只在有改动等着生效时出现：平时摆着是噪音，还多一个误触的机会
test("R4 没有改动等着生效：不出现「重启生效」", () => {
  assert.equal(trayRow(withModels(2)).showRestart, false);
  assert.equal(trayRow(withModels(2, { enabled: true })).showRestart, false);
});

test("R4 刚启用、Codex 还开着旧配置：出现「重启生效」", () => {
  const row = trayRow(
    withModels(2, {
      enabled: true,
      needsCodexRestart: true,
      router: { installed: true, running: true, port: 47328, protocol: "chat", error: "" },
    }),
  );
  assert.equal(row.showRestart, true);
});

test("R4 刚停用也一样：Codex 的列表要重启才会变回去", () => {
  const row = trayRow(withModels(2, { enabled: false, needsCodexRestart: true }));
  assert.equal(row.showRestart, true);
});

test("托盘拨开关：拨了就写（switchGateway，不确认、不重启），滑块当即过去；确认只在「重启生效」上（同 Codex 页）", () => {
  const src = readFileSync(new URL("../src/TrayModelsRow.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /confirmSwitch|gatewayConfirmText|重启并|switched/);
  assert.match(src, /reason = await switchGateway\(next, \{/);
  // 开关与 Codex 页同一份（codexControls）：写配置期间滑块已在拨过去的那一侧
  assert.match(
    src,
    /<CodexSwitch[^>]*switching=\{phase\.kind === "switching" \? phase\.next : null\}/,
  );
  const shared = readFileSync(new URL("../src/codexControls.tsx", import.meta.url), "utf8");
  assert.match(shared, /const on = switching \?\? state\.enabled;/);
  assert.match(shared, /checked=\{on\}/);
  // 面板里只剩一种确认：重启 Codex，用组件库确认框的窄面板形态
  assert.equal(src.match(/<Confirm\b/g)?.length, 1);
  assert.match(src, /<Confirm\s+inline\s+id=\{confirmId\}\s+title=\{`重启 \$\{CODEX\.name\}？`\}/);
  assert.match(src, /\{RESTART_CONSEQUENCE\}\s*<\/Confirm>/);
  assert.doesNotMatch(src, /confirmPanel|tray__confirm-/);
});

test("托盘「卸下后台服务」：停用后服务仍在才出现；和「重启生效」同时该出现时让位给重启（一行放不下两颗键）", () => {
  const router = { installed: true, running: true, port: 47328, protocol: "chat", error: "" };
  assert.equal(trayRow(withModels(2, { enabled: false, router })).showUninstall, true);
  assert.equal(trayRow(withModels(2, { enabled: true, router })).showUninstall, false);
  assert.equal(
    trayRow(withModels(2, { enabled: false, router, needsCodexRestart: true })).showUninstall,
    false,
  );
});

test("「启动 Codex」：开着、Codex 没在跑、不等重启时出现；关着不出现（与 Codex 页同一规则）", () => {
  assert.equal(trayRow(withModels(2, { enabled: true })).showLaunch, true);
  assert.equal(trayRow(withModels(2, { enabled: false })).showLaunch, false);
  const running = { version: "26.0", running: true, catalogVersion: "1", drift: false };
  assert.equal(trayRow(withModels(2, { enabled: true, codex: running })).showLaunch, false);
  assert.equal(
    trayRow(withModels(2, { enabled: true, needsCodexRestart: true })).showLaunch,
    false,
  );
});

// 2026-09-25 简化（DESIGN「托盘面板」）：不列在用的模型；键位在能力行里、开关左边，不另起一行
test("能力行一行说完：`重启生效` 在同一行、开关左边；不列在用的模型", async () => {
  const { TrayAgents } = await import("../src/TrayPanel.tsx");
  const running = { version: "26.0", running: true, catalogVersion: "1", drift: false };
  const agentState = trayAgentState(
    withModels(2, { enabled: true, needsCodexRestart: true, codex: running }),
  );
  const host = {
    applyGateway: () => undefined,
    idle: async () => undefined,
    alive: () => true,
    openedAt: 0,
    failOver: () => undefined,
  };
  const html = render(TrayAgents, {
    blocks: trayBlocks(AGENTS, agentState),
    state: agentState,
    host,
  });
  const cap = html.match(/<div class="tray__cap">[^]*<\/div>/)?.[0] ?? "";
  assert.match(cap, /tray__end">[^]*重启生效[^]*codex-switch/);
  assert.doesNotMatch(html, /tray__models|tray__keys/);
  assert.doesNotMatch(html, />m0|m0、m1/, "模型名不进托盘");
});

test("托盘面板只用组件库：菜单两项是 Menu（面板形态），确认是 Confirm 窄面板，失败是 NoticePanel section；不再覆盖内部类", async () => {
  const { default: TrayPanel } = await import("../src/TrayPanel.tsx");
  const html = render(TrayPanel, {});
  assert.match(
    html,
    /class="ss-menulist ss-menulist--panel" role="menu" aria-label="Sophia"[^]*role="menuitem"[^]*>打开 Sophia<[^]*role="menuitem"[^]*>退出</,
  );
  assert.doesNotMatch(html, /⌘Q/);
  for (const file of ["TrayPanel.tsx", "TrayPanel.css", "TrayModelsRow.tsx"]) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\bss-[a-z]/, file);
    assert.doesNotMatch(src, /<svg/, file);
  }
  const row = readFileSync(new URL("../src/TrayModelsRow.tsx", import.meta.url), "utf8");
  assert.match(row, /<NoticePanel\s+scope="section"/);
});
