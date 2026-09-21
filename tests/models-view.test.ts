import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";
import {
  canRestore,
  enableDisabledReason,
  factsLine,
  headline,
  modelLabel,
  parseBackendError,
  providerFacts,
  providerLabel,
  removeProviderBlockedReason,
  routerUnavailable,
  selectedModels,
  sortAndFilterModels,
  statusSentence,
  takeoverOfferText,
  totalSelected,
} from "../src/modelsView.ts";
import type { GatewayProvider, GatewayProviderModel, GatewayState } from "../src/types.ts";

const model = (overrides: Partial<GatewayProviderModel> = {}): GatewayProviderModel => ({
  id: "gpt-x",
  slug: "gpt-x",
  displayName: "GPT X",
  selected: false,
  ...overrides,
});

const provider = (overrides: Partial<GatewayProvider> = {}): GatewayProvider => ({
  id: "wecode",
  name: "wecode",
  baseUrl: "https://example.com/openai",
  protocol: "chat",
  hasKey: true,
  models: [],
  ...overrides,
});

const state = (overrides: Partial<GatewayState> = {}): GatewayState => {
  const providers = overrides.providers ?? [provider()];
  return {
    supported: true,
    providers,
    // 兼容字段，页面不读它（只剩 trayView.ts 在读）；这里跟着 providers 走，
    // 免得测试里两份事实对不上
    provider: providers[0] ?? provider({ id: "", name: "", baseUrl: "", hasKey: false }),
    enabled: false,
    needsCodexRestart: false,
    router: { installed: false, running: false, port: 47328, protocol: "chat", error: "" },
    codex: { version: "26.0", running: false, catalogVersion: "1", drift: false },
    conflict: "",
    takeover: null,
    ...overrides,
  };
};

const { ModelsHero, GatewayCard, MODELS_TAB_FULL_BLEED } = await import("../src/ModelsTab.tsx");

const noop = () => {};

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

test("enableDisabledReason 按优先级返回原因：待接管 > 冲突 > 没网关 > 未选模型 > 缺密钥", () => {
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
  assert.equal(enableDisabledReason(state({ providers: [] }), 1), "先添加一个网关");
  assert.equal(enableDisabledReason(state(), 0), "请先勾选至少一个模型");
  // 缺密钥只挡着「有模型要发布」的那几家，所以要点名是哪一家
  assert.equal(
    enableDisabledReason(
      state({
        providers: [
          provider({ id: "a", name: "有钥匙的", models: [model({ id: "m1", selected: true })] }),
          provider({
            id: "b",
            name: "缺钥匙的",
            hasKey: false,
            models: [model({ id: "m2", selected: true })],
          }),
        ],
      }),
      2,
    ),
    "缺钥匙的 还没有密钥",
  );
  // 没勾模型的那一家没有密钥也不挡路
  assert.equal(
    enableDisabledReason(
      state({
        providers: [
          provider({ id: "a", models: [model({ id: "m1", selected: true })] }),
          provider({ id: "b", name: "闲着的", hasKey: false, models: [model({ id: "m2" })] }),
        ],
      }),
      1,
    ),
    null,
  );
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
  assert.match(statusSentence(state({ providers: [] }), 0), /先添加一个网关/);
  assert.match(statusSentence(state({ providers: [provider({ hasKey: false })] }), 0), /密钥/);
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

// ===== 多家网关：页面只读 providers，不读兼容字段 provider =====

test("providerLabel：没起名就退到地址里的主机名，地址也读不出才用 id", () => {
  assert.equal(providerLabel(provider({ name: "公司网关" })), "公司网关");
  assert.equal(
    providerLabel(provider({ name: "", baseUrl: "https://gw.example.com/v1" })),
    "gw.example.com",
  );
  assert.equal(providerLabel(provider({ id: "x1", name: "", baseUrl: "" })), "x1");
});

test("modelLabel：用户改过的显示名 > slug > 原始 id", () => {
  assert.equal(modelLabel(model({ displayName: "我的 GPT" })), "我的 GPT");
  assert.equal(modelLabel(model({ displayName: "", slug: "wecode-gpt" })), "wecode-gpt");
  assert.equal(modelLabel(model({ displayName: "", slug: "", id: "raw" })), "raw");
});

test("totalSelected 把几家网关的已选数加起来，selectedModels 保持网关给的顺序", () => {
  const two = state({
    providers: [
      provider({
        id: "a",
        models: [model({ id: "m1", selected: true }), model({ id: "m2" })],
      }),
      provider({
        id: "b",
        models: [model({ id: "m3", selected: true }), model({ id: "m4", selected: true })],
      }),
    ],
  });
  assert.equal(totalSelected(two), 3);
  assert.equal(totalSelected(state({ providers: [] })), 0);
  assert.deepEqual(
    selectedModels(two.providers[1]).map((m) => m.id),
    ["m3", "m4"],
  );
});

test("providerFacts：数字带单位，已选与共有各占各的位置；一个都没拉到时直说", () => {
  assert.equal(providerFacts(provider()), "还没拉到模型列表");
  assert.equal(
    providerFacts(provider({ models: [model({ id: "m1", selected: true }), model({ id: "m2" })] })),
    "已选 1 个 · 共 2 个",
  );
});

test("removeProviderBlockedReason：已启用时删不掉最后一家还在发布模型的网关", () => {
  const a = provider({ id: "a", models: [model({ id: "m1", selected: true })] });
  const b = provider({ id: "b", name: "闲着的", models: [model({ id: "m2" })] });
  const c = provider({ id: "c", name: "另一家", models: [model({ id: "m3", selected: true })] });

  // 没启用：随便删
  assert.equal(removeProviderBlockedReason(state({ providers: [a, b] }), a), null);
  // 已启用、它没在发模型：删它不影响 Codex
  assert.equal(removeProviderBlockedReason(state({ enabled: true, providers: [a, b] }), b), null);
  // 已启用、还有别家在发模型：能删
  assert.equal(removeProviderBlockedReason(state({ enabled: true, providers: [a, c] }), a), null);
  // 已启用、它是最后一家在发模型的：后端会拒，界面提前说清下一步
  assert.match(
    removeProviderBlockedReason(state({ enabled: true, providers: [a, b] }), a) ?? "",
    /先点「已启用」停用/,
  );
});

test("headline 一行大字只给结论", () => {
  assert.equal(headline(state({ enabled: true })), "已经在用");
  assert.equal(headline(state()), "还没启用");
});

test("MODELS_TAB_FULL_BLEED：模型页不分域，壳在这一页不渲染侧栏", () => {
  assert.equal(MODELS_TAB_FULL_BLEED, true);
});

// ===== 渲染：启动页那一屏（AC1 / AC2 的代理验证）=====

const heroProps = (overrides: Partial<GatewayState> = {}, selectedCount = 0) => ({
  state: state(overrides),
  selectedCount,
  busy: false,
  onEnable: noop,
  onDisable: noop,
  onRestartCodex: noop,
});

test("ModelsHero 已启用：28px 大字给结论、一句人话、一行等宽事实，开关是反色 pill", () => {
  const html = render(
    ModelsHero,
    heroProps(
      {
        enabled: true,
        needsCodexRestart: true,
        codex: { version: "0.43.0", running: true, catalogVersion: "0.43.0", drift: false },
        router: { installed: true, running: true, port: 8765, protocol: "chat", error: "" },
      },
      3,
    ),
  );
  assert.match(html, /class="models-hero__state">已经在用</);
  assert.match(
    html,
    /class="models-hero__sentence">3 个模型已经在 Codex 的模型列表里，改动要重启 Codex 才生效</,
  );
  assert.match(html, /class="models-hero__facts">Codex 0\.43\.0 · 路由 127\.0\.0\.1:8765 运行中</);
  // 反色＝现在开着（DESIGN components.button-inverse）
  assert.match(html, /class="ss-btn ss-btn--inverse"[^>]*>已启用</);
  assert.match(html, />重启 Codex</);
  // 三组状态词合成一句，不并排三个徽标（AC2）
  assert.doesNotMatch(html, /models-hero__badge/);
});

test("ModelsHero 未启用且没网关：启用按钮禁用，并把原因挂在 title 上", () => {
  const html = render(ModelsHero, heroProps({ providers: [] }, 0));
  assert.match(html, /class="models-hero__state">还没启用</);
  assert.match(html, /title="先添加一个网关" disabled=""/);
  assert.match(html, /先添加一个网关——填上地址和密钥就能拉到它的模型列表/);
});

// ===== 渲染：一家网关一块 =====

const cardProps = (p: GatewayProvider) => ({
  provider: p,
  busy: false,
  onOpenPicker: noop,
  onRemoveModel: noop,
  onConfigure: noop,
  onRemove: noop,
});

test("GatewayCard 有密钥：实心圆点、已选模型是带 × 的紧凑片、计数走等宽", () => {
  const html = render(
    GatewayCard,
    cardProps(
      provider({
        models: [
          model({ id: "m1", displayName: "GPT 5", selected: true }),
          model({ id: "m2", displayName: "Claude", selected: true }),
          model({ id: "m3" }),
        ],
      }),
    ),
  );
  // 圆＝只读状态（钥匙串里有没有这家的密钥）
  assert.match(html, /class="ss-dot ss-dot--linked"/);
  assert.doesNotMatch(html, /models-tag/);
  assert.match(html, /class="models-card__name">wecode</);
  assert.match(html, /class="models-card__count">已选 2 个 · 共 3 个</);
  // 片不反色：它们是事实，不是正在选的东西
  assert.match(html, /class="ss-model-chip"><span class="ss-model-chip__label">GPT 5</);
  assert.match(html, /title="把 Claude 从 Codex 的模型列表里去掉"/);
  // 整块区域可点，不另给「改选模型」链接（R1 修订 v2）
  assert.match(
    html,
    /class="models-card__models" role="button" tabindex="0" title="点一下改选模型"/,
  );
  assert.doesNotMatch(html, /改选模型<\/button>/);
});

test("GatewayCard 没密钥：空心圆点 + 零圆角方标签，模型区写「还没选模型」", () => {
  const html = render(GatewayCard, cardProps(provider({ hasKey: false })));
  assert.match(html, /class="ss-dot ss-dot--missing"/);
  assert.match(html, /class="models-tag">还没有密钥</);
  assert.match(html, /class="models-card__count">还没拉到模型列表</);
  assert.match(html, /class="models-card__empty">还没选模型</);
});
