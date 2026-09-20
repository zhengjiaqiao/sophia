import assert from "node:assert/strict";
import test from "node:test";
import {
  canRestore,
  enableDisabledReason,
  parseBackendError,
  routerUnavailable,
  sortAndFilterModels,
  takeoverOfferText,
} from "../src/modelsView.ts";
import type { GatewayProviderModel, GatewayState } from "../src/types.ts";

const model = (overrides: Partial<GatewayProviderModel> = {}): GatewayProviderModel => ({
  id: "gpt-x",
  slug: "gpt-x",
  displayName: "GPT X",
  selected: false,
  ...overrides,
});

const state = (overrides: Partial<GatewayState> = {}): GatewayState => ({
  supported: true,
  provider: { baseUrl: "https://example.com/openai", hasKey: true, models: [] },
  enabled: false,
  needsCodexRestart: false,
  router: { installed: false, running: false, port: 47328, error: "" },
  codex: { version: "26.0", running: false, catalogVersion: "1", drift: false },
  conflict: "",
  takeover: null,
  ...overrides,
});

test("parseBackendError 剥离 [code] 前缀，读不出前缀时整段当作 internal", () => {
  assert.deepEqual(parseBackendError("[auth] 鉴权失败"), { code: "auth", message: "鉴权失败" });
  assert.deepEqual(parseBackendError("[changed] 配置已变化，请重试"), {
    code: "changed",
    message: "配置已变化，请重试",
  });
  assert.deepEqual(parseBackendError("网络错误，无法解析"), {
    code: "internal",
    message: "网络错误，无法解析",
  });
});

test("routerUnavailable 只在已启用且路由没跑时为真", () => {
  assert.equal(routerUnavailable(state({ enabled: false, router: { installed: true, running: false, port: 1, error: "" } })), false);
  assert.equal(routerUnavailable(state({ enabled: true, router: { installed: true, running: true, port: 1, error: "" } })), false);
  assert.equal(routerUnavailable(state({ enabled: true, router: { installed: true, running: false, port: 1, error: "占用" } })), true);
});

test("takeoverOfferText 带上网关地址与已选模型数", () => {
  assert.equal(
    takeoverOfferText({ baseUrl: "https://gw.example.com", selectedCount: 3 }),
    "本机当前由 agents-manager 启用（网关 https://gw.example.com，已选 3 个模型），可以由 SymSync 接管",
  );
});

test("enableDisabledReason 按优先级返回原因：待接管 > 冲突 > 无密钥 > 未选模型", () => {
  assert.equal(
    enableDisabledReason(state({ takeover: { baseUrl: "x", selectedCount: 1 }, conflict: "别的工具" }), 1),
    "本机当前由 agents-manager 启用，请先接管",
  );
  assert.equal(enableDisabledReason(state({ conflict: "已有 model_provider = custom" }), 1), "已有 model_provider = custom");
  assert.equal(
    enableDisabledReason(state({ provider: { baseUrl: "u", hasKey: false, models: [] } }), 1),
    "请先保存网关密钥",
  );
  assert.equal(enableDisabledReason(state(), 0), "请先勾选至少一个模型");
  assert.equal(enableDisabledReason(state(), 1), null);
});

test("canRestore：已启用，或后台服务还装着", () => {
  assert.equal(canRestore(state({ enabled: false, router: { installed: false, running: false, port: 1, error: "" } })), false);
  assert.equal(canRestore(state({ enabled: true })), true);
  assert.equal(canRestore(state({ router: { installed: true, running: false, port: 1, error: "" } })), true);
});

test("sortAndFilterModels 按 id/slug/displayName 大小写不敏感过滤，已选模型排前面且各自保持原顺序", () => {
  const models = [
    model({ id: "a", slug: "alpha", displayName: "Alpha", selected: false }),
    model({ id: "b", slug: "beta", displayName: "Beta", selected: true }),
    model({ id: "c", slug: "gamma", displayName: "Gamma Model", selected: false }),
    model({ id: "d", slug: "delta", displayName: "Delta", selected: true }),
  ];

  assert.deepEqual(
    sortAndFilterModels(models, "").map((m) => m.id),
    ["b", "d", "a", "c"],
  );
  assert.deepEqual(
    sortAndFilterModels(models, "GAMMA").map((m) => m.id),
    ["c"],
  );
  assert.deepEqual(
    sortAndFilterModels(models, "delta").map((m) => m.id),
    ["d"],
  );
});

test("sortAndFilterModels 空筛选词返回全部；无匹配返回空数组", () => {
  const models = [model({ id: "a" }), model({ id: "b", selected: true })];
  assert.equal(sortAndFilterModels(models, "   ").length, 2);
  assert.deepEqual(sortAndFilterModels(models, "找不到"), []);
});
