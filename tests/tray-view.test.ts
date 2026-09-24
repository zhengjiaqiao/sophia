import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import {
  fitModelCount,
  trayAgentState,
  trayBlocks,
  trayModels,
  trayRow,
  RESTART_CONSEQUENCE,
  RESTART_TIP,
} from "../src/trayView.ts";
import { enableDisabledReason } from "../src/modelsView.ts";
import type { AgentEntry } from "../src/shell/agentRegistry.ts";
import type { GatewayProvider, GatewayProviderModel, GatewayState } from "../src/types.ts";
import "./ui-render.ts";

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

const DRAWABLE = new Set(["third-party-models"]);

test("块从注册表生成：今天 Codex 一块、一行 `第三方模型`；这台机器不支持时整块不出现", () => {
  assert.deepEqual(trayBlocks(AGENTS, trayAgentState(state()), DRAWABLE), [
    { id: "codex", name: "Codex", rows: [{ id: "third-party-models", title: "第三方模型" }] },
  ]);
  assert.deepEqual(trayBlocks(AGENTS, trayAgentState(state({ supported: false })), DRAWABLE), []);
  // 状态还没读回来：先不出块（只剩菜单）
  assert.deepEqual(trayBlocks(AGENTS, trayAgentState(null), DRAWABLE), []);
});

test("往注册表加一个 agent、给 Codex 加一节 `用量`：面板按表的先后成块成行，不改面板的生成逻辑", () => {
  const Section = () => createElement("p");
  const codex = AGENTS[0];
  const registry: AgentEntry[] = [
    { ...codex, sections: [{ id: "usage", title: "用量", Component: Section }, ...codex.sections] },
    {
      id: "claude-code",
      name: "Claude Code",
      available: () => true,
      indicator: () => false,
      sections: [{ id: "usage", title: "用量", Component: Section }],
    },
  ];
  const drawable = new Set(["usage", "third-party-models"]);
  assert.deepEqual(
    trayBlocks(registry, trayAgentState(state()), drawable).map((b) => [
      b.name,
      b.rows.map((r) => r.title),
    ]),
    [
      ["Codex", ["用量", "第三方模型"]],
      ["Claude Code", ["用量"]],
    ],
  );
  // 面板还不会画的节不出行；一行都画不出的 agent 不成块（不留空块头）
  assert.deepEqual(
    trayBlocks(registry, trayAgentState(state()), DRAWABLE).map((b) => b.name),
    ["Codex"],
  );
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

// ===== 在用的模型一行 =====

/// `shortName` 是 core 算好给过来的网关短名（settings.rs `short_name`）；不给就等于显示名
const gw = (
  id: string,
  name: string,
  baseUrl: string,
  models: GatewayProviderModel[],
  shortName = name,
) => ({ id, name, shortName, baseUrl, hasKey: true, models }) as unknown as GatewayProvider;

const named = (id: string, displayName: string): GatewayProviderModel => ({
  id,
  slug: id,
  displayName,
  selected: true,
});

test("在用的模型：开着时按网关顺序列已选的；关着是空（这一行不出）", () => {
  const p = gw("a", "openrouter", "https://openrouter.ai/api/v1", [
    named("moonshotai/kimi-k2", "Kimi K2"),
    named("z-ai/glm-4.6", "GLM-4.6"),
    { ...named("x/off", "Off"), selected: false },
  ]);
  const on = state({ enabled: true, provider: p, providers: [p] });
  assert.deepEqual(
    trayModels(on).map((m) => [m.name, m.gateway]),
    [
      ["Kimi K2", null],
      ["GLM-4.6", null],
    ],
  );
  assert.deepEqual(trayModels({ ...on, enabled: false }), []);
});

test("同名才加网关短名：两家都选了 GLM-4.6，只那两个名字后写短名，其余不写", () => {
  const a = gw(
    "a",
    "openrouter.ai",
    "https://openrouter.ai/api/v1",
    [named("z-ai/glm-4.6", "GLM-4.6"), named("moonshotai/kimi-k2", "Kimi K2")],
    "openrouter",
  );
  const b = gw("b", "", "https://api.zhipu.example.com/v1", [named("glm-4.6", "GLM-4.6")], "zhipu");
  const on = state({ enabled: true, provider: a, providers: [a, b] });
  assert.deepEqual(
    trayModels(on).map((m) => [m.name, m.gateway]),
    [
      ["GLM-4.6", "openrouter"],
      ["Kimi K2", null],
      ["GLM-4.6", "zhipu"],
    ],
  );
});

test("一行放不下：尽量多放，末尾留 +N 的位置", () => {
  const more = (n: number) => (n < 10 ? 20 : 26);
  // 全放得下：三个
  assert.equal(fitModelCount([60, 60, 60], 12, more, 204), 3);
  // 放不下第三个：前两个 + `+1`（60 + 12 + 60 + 20 = 152 ≤ 160）
  assert.equal(fitModelCount([60, 60, 60], 12, more, 160), 2);
  // 第二个后面留不下 `+N`：只放一个
  assert.equal(fitModelCount([60, 60, 60], 12, more, 140), 1);
  // 一个都放不下也放一个（由 CSS 截断）
  assert.equal(fitModelCount([300, 60], 12, more, 100), 1);
});
