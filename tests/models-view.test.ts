import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";
import {
  MODELS_TOOLS,
  canRestore,
  effectiveModels,
  emptyEffectiveText,
  enableDisabledReason,
  modelLabel,
  parseBackendError,
  providerCatalogHint,
  providerLabel,
  removeProviderBlockedReason,
  routerUnavailable,
  selectedModels,
  sortAndFilterModels,
  totalSelected,
  availableCount,
  modelIssues,
  modelKeys,
  newModelIds,
  showRestartKey,
  shouldPollRestart,
  showRouterBanner,
  RESTART_TIP,
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

const { AgentRow, ModelBox, ModelPicker, MODELS_TAB_FULL_BLEED } =
  await import("../src/ModelsTab.tsx");

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

test("emptyEffectiveText：三种空是三件事，各说各的下一步", () => {
  assert.match(emptyEffectiveText(state({ providers: [provider({ hasKey: false })] })), /密钥/);
  assert.match(
    emptyEffectiveText(state({ providers: [provider({ hasKey: true })] })),
    /还没拉到模型列表/,
  );
  assert.equal(
    emptyEffectiveText(state({ providers: [provider({ models: [model({ id: "m1" })] })] })),
    "还没选模型",
  );
});

test("effectiveModels 摊平全部网关的已选模型；两家撞名时照抄后端的「 · 网关名」", () => {
  const one = provider({
    id: "a",
    name: "甲",
    models: [model({ id: "m1", displayName: "GPT-5", selected: true })],
  });
  const two = provider({
    id: "b",
    name: "乙",
    models: [
      model({ id: "m2", displayName: "GPT-5", selected: true }),
      model({ id: "m3", displayName: "只此一家", selected: true }),
    ],
  });
  const rows = effectiveModels(state({ providers: [one, two] }));
  assert.deepEqual(
    rows.map((r) => r.label),
    ["GPT-5 · 甲", "GPT-5 · 乙", "只此一家"],
  );
  // 归属不能丢：片上的 title 和去掉某一个时都要知道它是哪家的
  assert.deepEqual(
    rows.map((r) => r.provider.id),
    ["a", "b", "b"],
  );
  assert.deepEqual(effectiveModels(state({ providers: [] })), []);
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

// ===== 重启生效、选择器导航、路由自愈（纯逻辑） =====

test("重启生效：按钮即状态——只在 needsCodexRestart 且空闲时显示；键显示着才轮询", () => {
  const stale = state({ enabled: true, needsCodexRestart: true });
  assert.equal(showRestartKey(stale, { kind: "idle" }), true);
  assert.equal(showRestartKey(stale, { kind: "restarting", spinning: true }), false);
  assert.equal(showRestartKey(stale, { kind: "done" }), false);
  assert.equal(showRestartKey(state({ enabled: true }), { kind: "idle" }), false);
  assert.equal(shouldPollRestart(stale, { kind: "idle" }), true);
  assert.equal(shouldPollRestart(state(), { kind: "idle" }), false, "键消失即停");
  assert.equal(shouldPollRestart(null, { kind: "idle" }), false);
  assert.equal(shouldPollRestart(stale, { kind: "restarting", spinning: true }), false);
  // 提示框只写点击的后果与代价；检测只认桌面应用，写明
  assert.equal(RESTART_TIP, "重启 Codex 桌面应用让改动生效，进行中的对话会中断");
});

test("路由没在跑：先自愈，自愈过仍没起来才出横幅", () => {
  const down = state({
    enabled: true,
    router: { installed: true, running: false, port: 1, protocol: "chat", error: "x" },
  });
  assert.equal(showRouterBanner(down, false), false);
  assert.equal(showRouterBanner(down, true), true);
  assert.equal(showRouterBanner(state({ enabled: false }), true), false);
});

test("从网关页 `选模型 ›` 回来：差出这一家新拉到的模型；新加的一家全算新的", () => {
  const before = state({
    providers: [provider({ id: "a", models: [model({ id: "m1" })] })],
  });
  const keys = modelKeys(before);
  const after = state({
    providers: [
      provider({ id: "a", models: [model({ id: "m1" }), model({ id: "m2" })] }),
      provider({ id: "b", models: [model({ id: "x" }), model({ id: "y" })] }),
    ],
  });
  assert.deepEqual(newModelIds(after, keys, "a"), ["m2"]);
  assert.deepEqual(newModelIds(after, keys, "b"), ["x", "y"]);
  assert.deepEqual(newModelIds(after, keys, "gone"), []);
  assert.equal(availableCount(after), 4);
});

test("modelIssues：接管 / 配置被外部改过 / 网关连不上三类，key 随状况变", () => {
  assert.deepEqual(modelIssues(null), []);
  assert.deepEqual(modelIssues(state()), [], "平时没有待处理");
  // 「改动要重启」「路由没在跑」都不进收件箱
  assert.deepEqual(
    modelIssues(
      state({
        enabled: true,
        needsCodexRestart: true,
        router: { installed: true, running: false, port: 1, protocol: "chat", error: "x" },
      }),
    ),
    [],
  );
  const issues = modelIssues(
    state({
      takeover: { baseUrl: "https://am.example", selectedCount: 2 },
      codex: { version: "0.50.0", running: true, catalogVersion: "0.43.0", drift: true },
      providers: [
        provider({ id: "a", name: "甲", unreachable: "地址连不上" }),
        provider({ id: "b", name: "乙" }),
      ],
    }),
  );
  assert.deepEqual(
    issues.map((i) => [i.kind, i.action.kind, i.action.label]),
    [
      ["takeover", "takeover", "接管"],
      ["configChanged", "rewrite", "重新写入"],
      ["unreachable", "retry", "再试一次"],
    ],
  );
  const [takeover, config, down] = issues;
  assert.equal(takeover.key, "model:takeover:https://am.example");
  assert.equal(config.key, "model:config:0.50.0");
  assert.equal(down.key, "model:unreachable:a:地址连不上");
  assert.equal(down.providerId, "a");
  assert.equal(down.sentence, "甲 连不上：地址连不上");
  // 对象名墨色、连接词灰：句子拆段，subject 标出对象
  assert.deepEqual(
    down.parts.filter((p) => p.subject).map((p) => p.text),
    ["甲"],
  );
  assert.equal(takeover.parts.map((p) => p.text).join(""), takeover.sentence);
  // 不支持的机器上整段为空
  assert.deepEqual(
    modelIssues(
      state({
        supported: false,
        codex: { version: "1", running: false, catalogVersion: "0", drift: true },
      }),
    ),
    [],
  );
});

// ===== 渲染：agent 行 =====

const rowProps = (overrides: Partial<GatewayState> = {}) => ({
  tool: MODELS_TOOLS[0],
  state: state(overrides),
  busy: false,
  phase: { kind: "idle" } as const,
  onToggle: noop,
  onConfigure: noop,
  onRestart: noop,
  models: "MODELS-SLOT",
});

const withSelected = (overrides: Partial<GatewayState> = {}) => ({
  providers: [provider({ models: [model({ id: "m1", selected: true })] })],
  ...overrides,
});

test("AgentRow：图标 + 名字（不大写）+ page 开关 + 配置网关，一组；生效模型在第二格", () => {
  const html = render(AgentRow, rowProps(withSelected({ enabled: true })));
  assert.match(html, /<svg[^>]*width="24" height="24"/);
  assert.match(html, /class="models-row__name">Codex</);
  assert.doesNotMatch(html, /CODEX/);
  assert.match(
    html,
    /role="switch" aria-checked="true"[^>]*class="ss-switch ss-switch--page is-on"/,
  );
  assert.match(html, />配置网关</);
  const agent = html.indexOf("models-row__agent");
  const slot = html.indexOf("MODELS-SLOT");
  assert.ok(agent < slot);
  // 没有状态句、版本、路由这些内部事实（DESIGN「模型页」）
  assert.doesNotMatch(html, /路由|models-tool__sentence|已启用 ·/);
  // 不需要重启时没有重启键
  assert.doesNotMatch(html, /重启生效/);
});

test("AgentRow 待重启：配置网关之后出紧凑键「重启生效」，提示框写后果与代价（不用原生 title）", () => {
  const html = render(AgentRow, rowProps(withSelected({ enabled: true, needsCodexRestart: true })));
  assert.match(html, /配置网关<\/button>.*重启生效<\/button>/s);
  assert.match(html, /role="tooltip"[^>]*>重启 Codex 桌面应用让改动生效，进行中的对话会中断</);
  assert.match(html, /class="ss-btn ss-btn--compact"[^>]*>重启生效</);
});

test("AgentRow 重启中：键位原地换成 14px 转盘 +「正在重启 Codex」；已生效：一行例行成功", () => {
  const busyHtml = render(AgentRow, {
    ...rowProps(withSelected({ enabled: true, needsCodexRestart: true })),
    phase: { kind: "restarting", spinning: true },
  });
  assert.match(busyHtml, /class="ss-rotor is-spinning" width="14"/);
  assert.match(busyHtml, /正在重启 Codex/);
  assert.doesNotMatch(busyHtml, /重启生效<\/button>/);
  const doneHtml = render(AgentRow, {
    ...rowProps(withSelected({ enabled: true })),
    phase: { kind: "done" },
  });
  assert.match(doneHtml, /models-restart--done/);
  assert.match(doneHtml, /ss-toast--routine[^]*已生效/);
});

test("AgentRow 重启失败：黑块「没重启 Codex」+ 原因 + 再试一次，挂在整行下面", () => {
  const html = render(AgentRow, {
    ...rowProps(withSelected({ enabled: true, needsCodexRestart: true })),
    notice: {
      verb: "没重启",
      reason: "Codex 还在用旧配置",
      action: { label: "再试一次", onClick: noop },
    },
  });
  assert.match(
    html,
    /models-row__notice[^]*ss-toast--notice[^]*没重启[^]*Codex 还在用旧配置[^]*再试一次/,
  );
});

test("AgentRow 启用不了：开关禁用，原因作为悬停说明", () => {
  const html = render(AgentRow, rowProps({ providers: [] }));
  assert.match(html, /role="switch" aria-checked="false"[^>]*title="先添加一个网关" disabled=""/);
});

// ===== 渲染：模型框与选择器 =====

const boxProps = (overrides: Partial<GatewayState> = {}, open = false) => ({
  tool: MODELS_TOOLS[0],
  state: state(overrides),
  open,
  busy: false,
  onToggleOpen: noop,
  onRemoveModel: noop,
});

test("ModelBox：模型片友好名（id 进 title）+ 尾端等宽可选数 + 展开记号；整框可点", () => {
  const html = render(
    ModelBox,
    boxProps({
      providers: [
        provider({
          models: [
            model({ id: "m1", slug: "wecode-gpt-5", displayName: "GPT 5", selected: true }),
            model({ id: "m2", displayName: "Claude", selected: true }),
            model({ id: "m3" }),
          ],
        }),
      ],
    }),
  );
  assert.match(
    html,
    /class="ss-modelchip" title="wecode-gpt-5"><span class="ss-modelchip__name">GPT 5</,
  );
  assert.match(html, /aria-label="移除 Claude"/);
  assert.match(html, /class="models-box" role="button" tabindex="0" aria-expanded="false"/);
  assert.match(html, /class="models-box__count"[^>]*>3</);
  assert.match(html, /role="tooltip"[^>]*>3 个可用模型</);
  // 网关本身（地址、密钥）不在主页面上
  assert.doesNotMatch(html, /https:\/\/example\.com/);
});

test("ModelBox 两家网关撞名：片上照抄后端会加的「 · 网关名」", () => {
  const html = render(
    ModelBox,
    boxProps({
      providers: [
        provider({
          id: "a",
          name: "甲",
          models: [model({ id: "m1", displayName: "GPT-5", selected: true })],
        }),
        provider({
          id: "b",
          name: "乙",
          models: [model({ id: "m2", displayName: "GPT-5", selected: true })],
        }),
      ],
    }),
  );
  assert.match(html, /GPT-5 · 甲/);
  assert.match(html, /GPT-5 · 乙/);
});

test("ModelBox 空：没有网关说「还没有网关」；有网关没选说清为什么空", () => {
  assert.match(
    render(ModelBox, boxProps({ providers: [] })),
    /class="models-box__hint">还没有网关</,
  );
  assert.match(
    render(ModelBox, boxProps({ providers: [provider({ models: [model({ id: "m1" })] })] })),
    /class="models-box__hint">还没选模型</,
  );
});

const pickerProps = (overrides: Partial<GatewayState> = {}) => ({
  tool: MODELS_TOOLS[0],
  state: state(overrides),
  busy: false,
  query: "",
  onQuery: noop,
  onToggleModel: noop,
  onManageGateways: noop,
});

test("ModelPicker：第三方分组头带限制说明与「管理网关 ›」；已选置顶；底部「已选 N 个」", () => {
  const html = render(
    ModelPicker,
    pickerProps({
      providers: [
        provider({
          models: [
            model({ id: "a", displayName: "Alpha" }),
            model({ id: "b", displayName: "Beta", selected: true }),
          ],
        }),
      ],
    }),
  );
  assert.match(html, /models-picker__group-name">第三方</);
  assert.match(html, /只支持文本与工具调用，不支持图片/);
  assert.match(html, /管理网关<\/span>/);
  assert.ok(html.indexOf(">Beta<") < html.indexOf(">Alpha<"), "已选置顶");
  assert.match(
    html,
    /已选&nbsp;<span class="models-picker__count">1<\/span>&nbsp;个模型|已选 <span class="models-picker__count">1<\/span> 个模型/,
  );
  // 只有一家时不画每家的小抬头
  assert.doesNotMatch(html, /models-picker__provider-head/);
});

test("ModelPicker 没有网关：分组头是「还没有网关 · + 网关 ›」", () => {
  const html = render(ModelPicker, pickerProps({ providers: [] }));
  assert.match(html, /还没有网关/);
  assert.match(html, /\+ 网关<\/span>/);
  assert.doesNotMatch(html, /管理网关/);
});

test("ModelPicker 从网关页回来：分组带 data-provider 供滚动定位，新模型各闪一次", () => {
  const html = render(ModelPicker, {
    ...pickerProps({
      providers: [
        provider({ id: "a", name: "甲", models: [model({ id: "m1" })] }),
        provider({ id: "b", name: "乙", models: [model({ id: "n1" }), model({ id: "n2" })] }),
      ],
    }),
    focusProviderId: "b",
    flashIds: ["n2"],
  });
  assert.match(html, /data-provider="b"/);
  assert.match(html, /models-picker__provider-head/);
  assert.equal((html.match(/is-flash/g) ?? []).length, 1);
});

test("面板宽度：模型页右沿对齐 MCP 面板（280 + 72 + 88×N + 24）；生效模型列最少 360", async () => {
  const { mcpPanelWidth, modelsBoxWidth, MODELS_AGENT_W } = await import("../src/modelsView.ts");
  assert.equal(mcpPanelWidth(4), 728);
  assert.equal(mcpPanelWidth(6), 904);
  // 6 列：904 − 324 − 24 − 24 = 532，模型页总宽 = 324 + 24 + 532 + 24 = 904
  assert.equal(modelsBoxWidth(6), 532);
  assert.equal(MODELS_AGENT_W + 24 + modelsBoxWidth(6) + 24, mcpPanelWidth(6));
  // 4 列时算出 356 < 360，取最小值
  assert.equal(modelsBoxWidth(4), 360);
  assert.equal(modelsBoxWidth(0), 360);
});
