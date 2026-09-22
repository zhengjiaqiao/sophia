import assert from "node:assert/strict";
import test from "node:test";
import { trayRow, RESTART_CONSEQUENCE, RESTART_TIP } from "../src/trayView.ts";
import type { GatewayProviderModel, GatewayState } from "../src/types.ts";

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

test("AC2 没保存密钥：开关禁用并说原因", () => {
  const row = trayRow(state({ provider: { baseUrl: "", hasKey: false, models: [] } }));
  assert.equal(row.toggle.on, false);
  assert.equal(row.toggle.disabledReason, "请先保存网关密钥");
});

test("没选模型：开关禁用并说原因", () => {
  const row = trayRow(withModels(0));
  assert.equal(row.toggle.disabledReason, "请先勾选至少一个模型");
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

test("这台机器不支持：整行不出现", () => {
  assert.equal(trayRow(state({ supported: false })).visible, false);
  assert.equal(trayRow(state()).visible, true);
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
