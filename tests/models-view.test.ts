import assert from "node:assert/strict";
import test from "node:test";
import {
  canRestore,
  enableDisabledReason,
  factsLine,
  parseBackendError,
  routerUnavailable,
  sortAndFilterModels,
  statusSentence,
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
  router: { installed: false, running: false, port: 47328, protocol: "chat", error: "" },
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
  assert.equal(
    routerUnavailable(
      state({
        enabled: false,
        router: { installed: true, running: false, port: 1, protocol: "chat", error: "" },
      }),
    ),
    false,
  );
  assert.equal(
    routerUnavailable(
      state({
        enabled: true,
        router: { installed: true, running: true, port: 1, protocol: "chat", error: "" },
      }),
    ),
    false,
  );
  assert.equal(
    routerUnavailable(
      state({
        enabled: true,
        router: { installed: true, running: false, port: 1, protocol: "chat", error: "占用" },
      }),
    ),
    true,
  );
});

test("takeoverOfferText 带上网关地址与已选模型数", () => {
  assert.equal(
    takeoverOfferText({ baseUrl: "https://gw.example.com", selectedCount: 3 }),
    "本机当前由 agents-manager 启用（网关 https://gw.example.com，已选 3 个模型），可以由 Sophia 接管",
  );
});

test("enableDisabledReason 按优先级返回原因：待接管 > 冲突 > 无密钥 > 未选模型", () => {
  assert.equal(
    enableDisabledReason(
      state({ takeover: { baseUrl: "x", selectedCount: 1 }, conflict: "别的工具" }),
      1,
    ),
    "本机当前由 agents-manager 启用，请先接管",
  );
  assert.equal(
    enableDisabledReason(state({ conflict: "已有 model_provider = custom" }), 1),
    "已有 model_provider = custom",
  );
  assert.equal(
    enableDisabledReason(state({ provider: { baseUrl: "u", hasKey: false, models: [] } }), 1),
    "请先保存网关密钥",
  );
  assert.equal(enableDisabledReason(state(), 0), "请先勾选至少一个模型");
  assert.equal(enableDisabledReason(state(), 1), null);
});

test("canRestore：已启用，或后台服务还装着", () => {
  assert.equal(
    canRestore(
      state({
        enabled: false,
        router: { installed: false, running: false, port: 1, protocol: "chat", error: "" },
      }),
    ),
    false,
  );
  assert.equal(canRestore(state({ enabled: true })), true);
  assert.equal(
    canRestore(
      state({ router: { installed: true, running: false, port: 1, protocol: "chat", error: "" } }),
    ),
    true,
  );
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

test("statusSentence 把三组正交的状态词合成一句人话，不并排三个徽标", () => {
  // 已启用：说清有几个模型在 Codex 的列表里；needsCodexRestart 并进同一句
  assert.equal(statusSentence(state({ enabled: true }), 3), "3 个模型已经在 Codex 的模型列表里");
  assert.equal(
    statusSentence(state({ enabled: true, needsCodexRestart: true }), 3),
    "3 个模型已经在 Codex 的模型列表里，改动要重启 Codex 才生效",
  );
  // 未启用：按「为什么还不能启用」的优先级给出下一步
  assert.match(
    statusSentence(state({ takeover: { baseUrl: "x", selectedCount: 2 } }), 0),
    /接过来/,
  );
  assert.equal(
    statusSentence(state({ conflict: "已有 model_provider" }), 1),
    "还没启用：已有 model_provider",
  );
  assert.match(
    statusSentence(state({ provider: { baseUrl: "u", hasKey: false, models: [] } }), 0),
    /配置/,
  );
  assert.equal(statusSentence(state(), 0), "还没启用，先选几个模型");
  assert.equal(
    statusSentence(state(), 2),
    "还没启用，选好的 2 个模型点「启用」就会进 Codex 的模型列表",
  );
});

test("factsLine 只说查得到的事实：读不出 Codex 版本就不编一个", () => {
  assert.equal(
    factsLine(
      state({
        codex: { version: "0.43.0", running: true, catalogVersion: "0.43.0", drift: false },
        router: { installed: true, running: true, port: 8765, protocol: "chat", error: "" },
      }),
    ),
    "Codex 0.43.0 · 路由 127.0.0.1:8765 运行中",
  );
  assert.equal(
    factsLine(
      state({
        router: { installed: true, running: false, port: 8765, protocol: "chat", error: "" },
      }),
    ),
    "Codex 26.0 · 路由 127.0.0.1:8765 没在跑",
  );
  assert.equal(
    factsLine(state({ codex: { version: "", running: false, catalogVersion: "", drift: false } })),
    "路由未安装",
  );
});
