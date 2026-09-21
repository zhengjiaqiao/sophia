import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";
import {
  MODELS_TOOLS,
  canRestore,
  emptyModelsText,
  enableDisabledReason,
  factsLine,
  modelLabel,
  parseBackendError,
  providerCatalogHint,
  providerLabel,
  removeProviderBlockedReason,
  routerUnavailable,
  selectedModels,
  sortAndFilterModels,
  statusSentence,
  takeoverOfferText,
  totalSelected,
} from "../src/modelsView.ts";
import type { ModelsTool } from "../src/modelsView.ts";
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

const { ToolIntro, GatewayCard, MODELS_TAB_FULL_BLEED } = await import("../src/ModelsTab.tsx");

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

test("providerCatalogHint 只说「还有多少可挑」，不重复数已选的那几个", () => {
  assert.equal(providerCatalogHint(provider()), "");
  assert.equal(
    providerCatalogHint(
      provider({ models: [model({ id: "m1", selected: true }), model({ id: "m2" })] }),
    ),
    "2 个可选",
  );
});

test("emptyModelsText：三种空是三件事，各说各的下一步", () => {
  assert.match(emptyModelsText(provider({ hasKey: false })), /还没有密钥/);
  assert.match(emptyModelsText(provider({ hasKey: true })), /还没拉到模型列表/);
  assert.equal(emptyModelsText(provider({ models: [model({ id: "m1" })] })), "还没选模型");
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

test("MODELS_TAB_FULL_BLEED：模型页不分域，壳在这一页不渲染侧栏", () => {
  assert.equal(MODELS_TAB_FULL_BLEED, true);
});

test("MODELS_TOOLS：版面按工具分块；今天只有 Codex，但名字一律从表里取", () => {
  assert.ok(MODELS_TOOLS.length >= 1);
  const codex = MODELS_TOOLS[0];
  assert.equal(codex.id, "codex");
  assert.equal(codex.name, "Codex");
  assert.match(codex.limitations, /会话标题/);
});

test("工具名可换：statusSentence / factsLine 不把工具写死在句子里", () => {
  const other: ModelsTool = { id: "other", name: "别的工具", limitations: "…" };
  assert.equal(
    statusSentence(state({ enabled: true }), 2, other),
    "2 个模型已经在 别的工具 的模型列表里",
  );
  assert.equal(
    factsLine(
      state({ codex: { version: "1.2", running: true, catalogVersion: "1.2", drift: false } }),
      other,
    ),
    "别的工具 1.2 · 路由未安装",
  );
  // 菜单栏面板调的是两参数的老形，仍然说 Codex，两边一句话
  assert.equal(statusSentence(state({ enabled: true }), 2), "2 个模型已经在 Codex 的模型列表里");
});

// ===== 渲染：一个工具的抬头 =====

const introProps = (overrides: Partial<GatewayState> = {}, selectedCount = 0) => ({
  tool: MODELS_TOOLS[0],
  state: state(overrides),
  selectedCount,
  busy: false,
  onEnable: noop,
  onDisable: noop,
  onRestart: noop,
});

test("ToolIntro：图标和名字一起出现，名字走 28px display 档且不大写", () => {
  const html = render(ToolIntro, introProps({ enabled: true }, 3));
  // 图标是补充不是替代——名字必须在（DESIGN §9.1）
  assert.match(html, /<svg width="24" height="24"/);
  assert.match(html, /class="models-tool__name">Codex</);
  // 名字原样，不做大小写转换
  assert.doesNotMatch(html, /CODEX/);
});

test("ToolIntro 已启用：一句人话、一行等宽事实，开关是反色 pill，重启按钮带工具名", () => {
  const html = render(
    ToolIntro,
    introProps(
      {
        enabled: true,
        needsCodexRestart: true,
        codex: { version: "0.43.0", running: true, catalogVersion: "0.43.0", drift: false },
        router: { installed: true, running: true, port: 8765, protocol: "chat", error: "" },
      },
      3,
    ),
  );
  assert.match(
    html,
    /class="models-tool__sentence">3 个模型已经在 Codex 的模型列表里，改动要重启 Codex 才生效</,
  );
  assert.match(html, /class="models-tool__facts">Codex 0\.43\.0 · 路由 127\.0\.0\.1:8765 运行中</);
  // 反色＝现在开着（DESIGN components.button-inverse）
  assert.match(html, /class="ss-btn ss-btn--inverse"[^>]*>已启用</);
  // 重启是这个工具的动作，按钮上带着它的名字；button-cap 是大写档，
  // 但专名原样不转大写（§1.2），所以名字裹在 .models-plain 里
  assert.match(html, /重启 <span class="models-plain">Codex<\/span>/);
  // 三组状态词合成一句，不并排三个徽标（AC2）
  assert.doesNotMatch(html, /models-tool__badge/);
});

test("ToolIntro 未启用且没网关：启用按钮禁用，并把原因挂在 title 上", () => {
  const html = render(ToolIntro, introProps({ providers: [] }, 0));
  assert.match(html, /title="先添加一个网关" disabled=""/);
  assert.match(html, /先添加一个网关——填上地址和密钥就能拉到它的模型列表/);
});

// ===== 渲染：一家网关一块 =====

const cardProps = (p: GatewayProvider) => ({
  provider: p,
  tool: MODELS_TOOLS[0],
  busy: false,
  onOpenPicker: noop,
  onRemoveModel: noop,
  onConfigure: noop,
  onRemove: noop,
});

test("GatewayCard 有密钥：实心圆点、地址并进身份行、已选模型是带 × 的紧凑片", () => {
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
  assert.match(html, /class="models-card__url"[^>]*>https:\/\/example\.com\/openai</);
  // 已选的摆在片上，就不再数第二遍；右端只说还有多少可挑
  assert.doesNotMatch(html, /已选 2 个/);
  assert.match(html, /class="models-card__catalog">3 个可选</);
  // 片不反色：它们是事实，不是正在选的东西
  assert.match(html, /class="ss-model-chip"><span class="ss-model-chip__label">GPT 5</);
  assert.match(html, /title="把 Claude 从 Codex 的模型列表里去掉"/);
  // 已选模型就在主页面上改，整块区域可点，不另给链接、也不进二级页（与 cc-switch 的差异点）
  assert.match(
    html,
    /class="models-card__models" role="button" tabindex="0" title="点一下改选模型"/,
  );
  assert.doesNotMatch(html, /改选模型<\/button>/);
});

test("GatewayCard 没密钥：空心圆点 + 零圆角方标签，空态说清为什么空", () => {
  const html = render(GatewayCard, cardProps(provider({ hasKey: false })));
  assert.match(html, /class="ss-dot ss-dot--missing"/);
  assert.match(html, /class="models-tag">还没有密钥</);
  assert.match(html, /class="models-card__empty">还没有密钥——到「配置」里填上就能拉到模型列表</);
  // 一个都没拉到时右端那句不出现，左边的空态已经把话说了
  assert.doesNotMatch(html, /models-card__catalog/);
});

test("GatewayCard 拉到了模型但一个都没选：空态说的是「还没选模型」", () => {
  const html = render(GatewayCard, cardProps(provider({ models: [model({ id: "m1" })] })));
  assert.match(html, /class="models-card__empty">还没选模型</);
  assert.match(html, /class="models-card__catalog">1 个可选</);
});
