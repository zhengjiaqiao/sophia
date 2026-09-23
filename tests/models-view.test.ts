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
  splitModelId,
  shouldShowModelId,
  modelRowLabel,
  modelRowId,
  chipLabel,
  modelGroups,
  totalSelected,
  availableCount,
  modelIssues,
  showRestartKey,
  shouldPollRestart,
  showRouterBanner,
  snapshotOrder,
  showGatewayNames,
  gatewayShortName,
  gatewaySelectedChips,
  frozenGroups,
  gatewayChips,
  choiceAfterCancel,
  switchNeedsConfirm,
  unsavedText,
  serviceLeftover,
  UNINSTALL_TIP,
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

const { ModelList } = await import("../src/ModelList.tsx");
const { GatewayBody, GatewayPage } = await import("../src/pages/GatewayPage.tsx");
const GatewayPanel = GatewayBody;
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
  assert.equal(showRestartKey(stale, { kind: "restarting" }), false);
  assert.equal(showRestartKey(stale, { kind: "done" }), false);
  assert.equal(showRestartKey(state({ enabled: true }), { kind: "idle" }), false);
  assert.equal(shouldPollRestart(stale, { kind: "idle" }), true);
  assert.equal(shouldPollRestart(state(), { kind: "idle" }), false, "键消失即停");
  assert.equal(shouldPollRestart(null, { kind: "idle" }), false);
  assert.equal(shouldPollRestart(stale, { kind: "restarting" }), false);
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

test("modelIssues：接管 / 配置被外部改过 / 网关连不上三类，key 随状况变", () => {
  assert.deepEqual(modelIssues(null), []);
  assert.deepEqual(modelIssues(state()), [], "平时没有问题");
  // 「改动要重启」「路由没在跑」都不算要拿主意的问题
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
  // 看过表的 key：格式与 core `store::SeenIssue` 钉死，段间是 \u001f
  assert.equal(takeover.key, "model\u001ftakeover\u001fhttps://am.example");
  assert.equal(config.key, "model\u001fconfigChanged\u001f0.50.0");
  assert.equal(down.key, "model\u001funreachable\u001fa\u001f地址连不上");
  assert.equal(down.providerId, "a");
  // 一次性提示的句子以主语开头
  assert.equal(takeover.sentence, "Codex 正由 agents-manager 管理");
  assert.equal(config.sentence, "Codex 里 Sophia 写进去的设置被改掉了");
  assert.equal(down.subject, "甲");
  assert.equal(down.sentence, "甲 连不上");
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
  // 「配置网关」是进网关二级页的普通默认键，不带展开记号（v84）
  assert.match(html, /配置网关<\/button>.*重启生效<\/button>/s);
  assert.match(html, /role="tooltip"[^>]*>重启 Codex 桌面应用让改动生效，进行中的对话会中断</);
  assert.match(html, /class="ss-btn ss-btn--compact"[^>]*>重启生效</);
});

test("AgentRow 重启中：键位原地换成 14px 地球绕太阳 +「正在重启 Codex」；已生效：一行例行成功", () => {
  const busyHtml = render(AgentRow, {
    ...rowProps(withSelected({ enabled: true, needsCodexRestart: true })),
    phase: { kind: "restarting" },
  });
  // 重启中用忙碌指示 Spinner（UI v4 第四轮删掉了自创转盘，原来钉 ss-rotor 的断言随之改写）
  assert.match(busyHtml, /class="ss-spinner" width="14"/);
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
  onToggleModel: noop,
  onManageGateways: noop,
});

test("ModelPicker：第三方组头带限制说明与「管理网关 ›」；按服务商分小组头；不出已选组；底部不再写「已选 N 个模型」", () => {
  const html = render(
    ModelPicker,
    pickerProps({
      providers: [
        provider({
          models: [
            model({
              id: "azure/gpt-4.1",
              slug: "wecode-azure/gpt-4.1",
              displayName: "azure/gpt-4.1",
            }),
            model({
              id: "azure/o3-mini",
              slug: "wecode-azure/o3-mini",
              displayName: "azure/o3-mini",
              selected: true,
            }),
          ],
        }),
      ],
    }),
  );
  assert.match(html, /models-picker__group-name">第三方</);
  assert.match(html, /只支持文本与工具调用，不支持图片/);
  assert.match(html, /管理网关<\/span>/);
  // 组头 `azure · 2`，行内去掉重复前缀，完整 id 进提示框
  assert.match(html, /model-list__vendor">azure</);
  assert.match(html, /model-list__count">2</);
  assert.match(html, /models-option__name">o3-mini</);
  // 行上不放提示框也不设 title（真机反馈：挑模型时完整 id 没有意义，还会盖住正在看的那一行）；
  // 读屏名只写名称
  assert.doesNotMatch(html, /models-option[^>]*title=/);
  assert.doesNotMatch(html, /role="tooltip"[^>]*>wecode-azure/);
  assert.match(
    html,
    /role="option"[^>]*aria-label="gpt-4\.1"|aria-label="gpt-4\.1"[^>]*role="option"/,
  );
  // 已选由框里的模型片表达，下拉里不另列已选组（DESIGN d9d87d1）；组内仍是打开时已选在前
  assert.doesNotMatch(html, /model-list__group--pinned|>已选</);
  assert.ok(html.indexOf(">o3-mini<") < html.indexOf(">gpt-4.1<"), "组内已选在前");
  // 底部计数与已选组头重复，已删（DESIGN a4fede3）
  assert.doesNotMatch(html, /model-list__foot|个模型/);
  // 只有一个网关：行尾不写网关名
  assert.doesNotMatch(html, /models-option__gateway/);
  // 不超过 8 行不出筛选框
  assert.doesNotMatch(html, /model-list__search/);
});

test("ModelPicker 没有网关：组头是「还没有网关 · + 网关 ›」", () => {
  const html = render(ModelPicker, pickerProps({ providers: [] }));
  assert.match(html, /还没有网关/);
  assert.match(html, /\+ 网关<\/span>/);
  assert.doesNotMatch(html, /管理网关/);
});

// ===== 模型列表的写法 =====

test("splitModelId：vendor/name 与网关路由命名 default-vendor-name 都拆得出服务商", () => {
  assert.deepEqual(splitModelId("azure/gpt-4.1"), { vendor: "azure", rest: "gpt-4.1" });
  assert.deepEqual(splitModelId("default-azure-gpt-4.1"), { vendor: "azure", rest: "gpt-4.1" });
  assert.deepEqual(splitModelId("deepseek-chat"), { vendor: null, rest: "deepseek-chat" });
});

test("shouldShowModelId：友好名与 id 明显不同才显示；Opus / Kimi / azure 这类不显示", () => {
  assert.equal(shouldShowModelId("DeepSeek V3.2", "deepseek-chat"), true);
  assert.equal(shouldShowModelId("DeepSeek V3.2", "deepseek/deepseek-chat"), true);
  assert.equal(shouldShowModelId("Opus 4.6", "anthropic/claude-opus-4-6"), false);
  assert.equal(shouldShowModelId("Kimi K2", "moonshotai/kimi-k2-0905"), false);
  assert.equal(shouldShowModelId("gpt-4.1", "default-azure-gpt-4.1"), false);
  assert.equal(shouldShowModelId("GPT_4.1", "azure/gpt-4.1"), false, "分隔符与大小写不算不同");
});

test("行名与行尾 id：有友好名写友好名；没有就写去掉服务商前缀的 id；网关把 id 填进显示名不算友好名", () => {
  const named = model({
    id: "deepseek/deepseek-chat",
    slug: "g-deepseek/deepseek-chat",
    displayName: "DeepSeek V3.2",
  });
  assert.equal(modelRowLabel(named), "DeepSeek V3.2");
  assert.equal(modelRowId(named), "deepseek-chat");
  const kimi = model({ id: "moonshotai/kimi-k2-0905", slug: "g-x", displayName: "Kimi K2" });
  assert.equal(modelRowId(kimi), null);
  const bare = model({
    id: "default-azure-gpt-4.1",
    slug: "g-default-azure-gpt-4.1",
    displayName: "default-azure-gpt-4.1",
  });
  assert.equal(modelRowLabel(bare), "gpt-4.1");
  assert.equal(modelRowId(bare), null);
});

test("已选模型片：同一服务商省前缀，跨服务商保留前缀", () => {
  const a = model({ id: "azure/gpt-4.1", displayName: "azure/gpt-4.1" });
  assert.equal(chipLabel(a, false), "gpt-4.1");
  assert.equal(chipLabel(a, true), "azure/gpt-4.1");
  const same = effectiveModels(
    state({
      providers: [
        provider({
          models: [
            model({ id: "azure/gpt-4.1-mini", displayName: "azure/gpt-4.1-mini", selected: true }),
            model({ id: "azure/o3-mini", displayName: "azure/o3-mini", selected: true }),
          ],
        }),
      ],
    }),
  ).map((r) => r.label);
  assert.deepEqual(same, ["gpt-4.1-mini", "o3-mini"]);
  const mixed = effectiveModels(
    state({
      providers: [
        provider({
          models: [
            model({ id: "azure/gpt-4.1", displayName: "azure/gpt-4.1", selected: true }),
            model({ id: "zhipu/glm-4.6", displayName: "zhipu/glm-4.6", selected: true }),
          ],
        }),
      ],
    }),
  ).map((r) => r.label);
  assert.deepEqual(mixed, ["azure/gpt-4.1", "zhipu/glm-4.6"]);
});

test("modelGroups：按服务商分组，一家一个也有组头；拆不出服务商退到网关名；组内已选置顶", () => {
  const p = provider({ id: "g", name: "网关甲", models: [] });
  const groups = modelGroups([
    { provider: p, model: model({ id: "azure/a" }) },
    { provider: p, model: model({ id: "zhipu/glm-4.6" }) },
    { provider: p, model: model({ id: "azure/b", selected: true }) },
    { provider: p, model: model({ id: "plain" }) },
  ]);
  assert.deepEqual(
    groups.map((g) => [g.vendor, g.entries.map((e) => e.model.id)]),
    [
      ["azure", ["azure/b", "azure/a"]],
      ["zhipu", ["zhipu/glm-4.6"]],
      ["网关甲", ["plain"]],
    ],
  );
});

test("ModelList：超过 8 行出筛选框；新模型各闪一次；行尾 id 只在明显不同时出现", () => {
  const p = provider({ id: "g", models: [] });
  const entries = Array.from({ length: 9 }, (_, i) => ({
    provider: p,
    model: model({ id: `azure/m${i}`, slug: `g-azure/m${i}`, displayName: `azure/m${i}` }),
  }));
  entries.push({
    provider: p,
    model: model({ id: "deepseek/deepseek-chat", slug: "g-ds", displayName: "DeepSeek V3.2" }),
  });
  const html = render(ModelList, {
    entries,
    busy: false,
    onToggle: noop,
    flashKeys: ["g|azure/m3"],
  });
  assert.match(html, /model-list__search/);
  assert.equal((html.match(/is-flash/g) ?? []).length, 1);
  assert.equal((html.match(/models-option__id"/g) ?? []).length, 1);
  assert.match(html, /models-option__id">deepseek-chat</);
});

// ===== 网关展开区 =====

const panelProps = (
  overrides: Partial<GatewayState> = {},
  extra: Record<string, unknown> = {},
) => ({
  tool: MODELS_TOOLS[0],
  state: state(overrides),
  busy: false,
  initial: null,
  onSave: async () => "x",
  onFetchModels: async () => {},
  onRetry: async () => {},
  onRemove: async () => {},
  onToggleModel: noop,
  onDirtyChange: noop,
  askDiscard: false,
  onCollapse: noop,
  ...extra,
});

test("GatewayPanel 已连：分段片（选中反色、末尾 + 网关）+ 一行摘要 `地址 · 已连 · 编辑` + 垃圾桶；右半「从这个网关选模型」", () => {
  const html = render(
    GatewayPanel,
    panelProps({
      enabled: true,
      providers: [
        provider({
          id: "ap",
          name: "ap-gateway",
          models: [model({ id: "azure/gpt-4.1", displayName: "azure/gpt-4.1", selected: true })],
        }),
        provider({ id: "or", name: "openrouter", unreachable: "地址连不上" }),
      ],
    }),
  );
  assert.match(html, /class="ss-chip is-selected"[^>]*>.*?ap-gateway.*?gw-panel__chip-count">1</s);
  assert.match(html, /gw-panel__chip-down">连不上</);
  assert.match(html, />网关<\/span><\/button>/);
  assert.match(html, /gw-panel__state">已连</);
  assert.match(html, />编辑<\/button>/);
  // ap-gateway 是最后一家还在供模型的：垃圾桶禁用，提示框说原因
  assert.match(html, /role="tooltip"[^>]*>Codex 还在用它的 1 个模型，先取消勾选再删</);
  assert.match(html, /gw-panel__section">从这个网关选模型</);
  assert.match(html, /gw-panel__note">只支持文本与工具调用，不支持图片</);
  // 摘要态不出表单
  assert.doesNotMatch(html, /gw-form/);
});

test("GatewayPanel 连不上：`连不上` + 再试一次；新加网关直接出表单；收起时没保存就地问保存 / 丢弃", () => {
  const down = render(
    GatewayPanel,
    panelProps({
      providers: [provider({ id: "or", name: "openrouter", unreachable: "地址连不上" })],
    }),
  );
  assert.match(down, /gw-panel__down"[^>]*>连不上</);
  assert.match(down, />再试一次</);
  const fresh = render(GatewayPanel, panelProps({ providers: [] }));
  assert.match(fresh, /class="gw-form"/);
  assert.match(fresh, /新网关/);
  assert.doesNotMatch(fresh, />取消</, "一家都没有时没有可退的");
  const ask = render(GatewayPanel, panelProps({ providers: [] }, { askDiscard: true }));
  // 草稿没保存与改动没保存说法不同（v84 第八轮）
  assert.match(ask, /新网关没保存/);
  assert.match(ask, />丢弃</);
});

test("GatewayPanel 跳回定位：那一家的分段片外包一层 surface 闪两下（is-jump），选中它", () => {
  const html = render(
    GatewayPanel,
    panelProps(
      {
        providers: [
          provider({ id: "ap", name: "ap-gateway" }),
          provider({ id: "or", name: "openrouter", unreachable: "地址连不上" }),
        ],
      },
      { initial: "or", flashProviderId: "or" },
    ),
  );
  assert.equal((html.match(/gw-panel__chipwrap is-jump/g) ?? []).length, 1);
  assert.match(html, /gw-panel__chipwrap is-jump"><button[^>]*class="ss-chip is-selected"/);
});

test("serviceLeftover：只有停用了、后台服务却还装着才算残留（关开关本身会卸下）", () => {
  const router = (installed: boolean) => ({
    installed,
    running: installed,
    port: 1,
    protocol: "chat",
    error: "",
  });
  assert.equal(serviceLeftover(state({ enabled: false, router: router(true) })), true);
  assert.equal(serviceLeftover(state({ enabled: true, router: router(true) })), false);
  assert.equal(serviceLeftover(state({ enabled: false, router: router(false) })), false);
});

test("AgentRow 停用后服务仍在：出紧凑键「卸下后台服务」（与重启生效同形），提示框写结果；正在卸下时忙碌指示 + 文字", () => {
  const leftover = {
    enabled: false,
    router: { installed: true, running: true, port: 1, protocol: "chat", error: "" },
  };
  const html = render(AgentRow, { ...rowProps(withSelected(leftover)), onUninstall: noop });
  assert.match(html, /class="ss-btn ss-btn--compact"[^>]*>卸下后台服务</);
  assert.match(html, new RegExp(`role="tooltip"[^>]*>${UNINSTALL_TIP}<`));
  const busyHtml = render(AgentRow, {
    ...rowProps(withSelected(leftover)),
    onUninstall: noop,
    uninstalling: true,
  });
  assert.match(busyHtml, /class="ss-spinner"[^]*正在卸下后台服务/);
  assert.doesNotMatch(
    render(AgentRow, { ...rowProps(withSelected({ enabled: true })), onUninstall: noop }),
    /卸下后台服务/,
  );
});

test("GatewayPage：二级页「← Codex 的网关」，标题后放页头动作；单列，没有右栏", () => {
  const html = render(GatewayPage, {
    ...panelProps({
      providers: [provider({ id: "ap", name: "ap-gateway", models: [model({ id: "azure/a" })] })],
    }),
    headerAction: "RESTART-SLOT",
    leaving: false,
    onLeave: noop,
  });
  // 二级页挂在 body 上，转场做在 SubPage 自己身上
  assert.match(html, /class="ss-subpage gw-page-sub"/);
  assert.match(html, /gw-page__title">Codex 的网关(<!-- -->)?RESTART-SLOT/);
  assert.match(html, /aria-label="返回"/);
  assert.doesNotMatch(html, /gw-panel__right|gw-panel__left/);
  assert.match(
    render(GatewayPage, { ...panelProps({}), leaving: true, onLeave: noop }),
    /class="ss-subpage gw-page-sub is-leaving"/,
  );
});

test("网关分段片：点「+ 网关」原位变成「新网关」草稿片，草稿在时不渲染「+ 网关」；保存后换成真实那一家、「+ 网关」回来", () => {
  assert.deepEqual(gatewayChips(["ap", "or"], "ap"), [
    { kind: "provider", id: "ap" },
    { kind: "provider", id: "or" },
    { kind: "add" },
  ]);
  assert.deepEqual(gatewayChips(["ap"], "new"), [
    { kind: "provider", id: "ap" },
    { kind: "draft" },
  ]);
  // 保存成功：新的一家进了列表、选中它，末尾又是「+ 网关」
  assert.deepEqual(gatewayChips(["ap", "ds"], "ds"), [
    { kind: "provider", id: "ap" },
    { kind: "provider", id: "ds" },
    { kind: "add" },
  ]);
});

test("取消草稿回到之前选中的那一家；它不在了退到第一家；一家都没有仍是草稿", () => {
  assert.equal(choiceAfterCancel("or", ["ap", "or"]), "or");
  assert.equal(choiceAfterCancel("gone", ["ap", "or"]), "ap");
  assert.equal(choiceAfterCancel(null, ["ap"]), "ap");
  assert.equal(choiceAfterCancel("ap", []), "new");
});

test("换一家前：有没保存的改动才拦下问；点当前这一家不算换；拦截句草稿与改动说法不同", () => {
  assert.equal(switchNeedsConfirm("new", "ap", true), true);
  assert.equal(switchNeedsConfirm("new", "ap", false), false, "空草稿没东西可丢");
  assert.equal(switchNeedsConfirm("ap", "ap", true), false);
  assert.equal(switchNeedsConfirm("ap", "or", true), true, "改了地址也不能静默丢掉");
  assert.equal(unsavedText("new"), "新网关没保存");
  assert.equal(unsavedText("ap"), "地址改动没保存");
});

test("GatewayBody 草稿态：「新网关」选中反色、没有「+ 网关」；地址为空时保存禁用，提示框「先填地址」", () => {
  const html = render(
    GatewayPanel,
    panelProps({ providers: [provider({ id: "ap", name: "ap-gateway" })] }, { initial: "new" }),
  );
  assert.match(html, /class="ss-chip is-selected"[^>]*><span class="ss-chip__label">新网关</);
  assert.doesNotMatch(html, />网关<\/span><\/button>/);
  assert.match(html, /role="tooltip"[^>]*>先填地址</);
  assert.match(html, /title="先填地址" disabled=""/);
  assert.match(html, />取消</);
  assert.match(html, /拉模型时探明/);
});

// ===== 勾选不挪位置 =====

const pinProvider = provider({ id: "g", name: "网关" });
const pe = (id: string, selected = false, displayName = id) => ({
  provider: pinProvider,
  model: model({ id, slug: `g-${id}`, displayName, selected }),
});

test("snapshotOrder：打开时排一次序——按分组顺序，组内已选在前", () => {
  const entries = [pe("azure/a"), pe("zhipu/glm", true), pe("azure/b", true)];
  const snap = snapshotOrder(entries);
  assert.deepEqual(snap.order, ["g|azure/b", "g|azure/a", "g|zhipu/glm"]);
});

test("不跳位：打开之后勾选 / 取消只改状态，各组先后不变；下次打开才重排", () => {
  const before = [pe("azure/a"), pe("azure/b", true), pe("azure/c")];
  const snap = snapshotOrder(before);
  // 之后：取消 b、勾上 c
  const after = [pe("azure/a"), pe("azure/b", false), pe("azure/c", true)];
  assert.deepEqual(
    frozenGroups(after, snap).flatMap((g) => g.entries.map((e) => e.model.id)),
    ["azure/b", "azure/a", "azure/c"],
    "分组里的行留在原位",
  );
  // 下次打开：重排（已选在前）
  assert.deepEqual(snapshotOrder(after).order, ["g|azure/c", "g|azure/a", "g|azure/b"]);
});

test("按筛选词过滤各组；打开后才出现的新模型排到组尾", () => {
  const entries = [pe("azure/gpt-4.1", true), pe("zhipu/glm-4.6", true)];
  const snap = snapshotOrder(entries);
  assert.deepEqual(
    frozenGroups(entries, snap, "glm").flatMap((g) => g.entries.map((e) => e.model.id)),
    ["zhipu/glm-4.6"],
  );
  assert.deepEqual(frozenGroups(entries, snap, "claude"), []);
  const grown = [...entries, pe("azure/o3")];
  assert.deepEqual(
    frozenGroups(grown, snap)[0].entries.map((e) => e.model.id),
    ["azure/gpt-4.1", "azure/o3"],
  );
});

test("拆不出服务商时组头用网关短名（与分段片、行尾一致）", () => {
  const p = provider({ id: "or", name: "openrouter.ai" });
  const groups = modelGroups([{ provider: p, model: model({ id: "deepseek-chat" }) }]);
  assert.deepEqual(
    groups.map((g) => g.vendor),
    ["openrouter"],
  );
});

test("ModelList 不再有已选置顶组：已选只由上方模型片表达，每行只在服务商分组里出现一次", () => {
  const seven = Array.from({ length: 9 }, (_, i) => pe(`azure/m${i}`, i < 7));
  const html = render(ModelList, { entries: seven, busy: false, onToggle: noop });
  assert.doesNotMatch(html, /model-list__group--pinned|>已选<|model-list__more/);
  assert.equal((html.match(/role="option"/g) ?? []).length, 9);
});

test("模型页表宽 = 324 + 24 + 框 + 24：框随内容区弹性 360–640（CSS 实现），行线止于框右沿 + 24", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/ModelsTab.css", import.meta.url), "utf8");
  const panel = /\.models-panel[,\s][^{]*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(panel, /--models-agent-w:\s*324px/);
  assert.match(panel, /--models-box-min:\s*360px/);
  assert.match(panel, /--models-box-max:\s*640px/);
  assert.match(
    panel.replace(/\s+/g, " "),
    /width: clamp\( calc\(var\(--models-agent-w\) \+ var\(--space-xl\) \* 2 \+ var\(--models-box-min\)\), 100%, calc\(var\(--models-agent-w\) \+ var\(--space-xl\) \* 2 \+ var\(--models-box-max\)\) \)/,
  );
  const row = /\.models-panel__head,\s*\.models-row \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(row, /grid-template-columns:\s*var\(--models-agent-w\) minmax\(0, 1fr\)/);
  assert.match(row, /padding-right:\s*var\(--space-xl\)/);
});

test("删网关改为二次确认：页面上不再有「删掉 X · 撤销」提示条，垃圾桶可点时带读屏名", () => {
  const html = render(
    GatewayPanel,
    panelProps({
      providers: [
        provider({ id: "ap", name: "ap-gateway" }),
        provider({ id: "or", name: "openrouter.ai" }),
      ],
    }),
  );
  assert.doesNotMatch(html, /撤销/);
  assert.doesNotMatch(html, /ss-toast/);
  assert.match(html, /aria-label="删掉 ap-gateway"/);
});

test("网关短名：显示名优先；否则主机名去掉 api. / www. 与顶级域；localhost、IP 原样", () => {
  const gw = (name: string, baseUrl: string) => provider({ id: "x", name, baseUrl });
  assert.equal(gatewayShortName(gw("ap-gateway", "https://api.openai.com/v1")), "ap-gateway");
  assert.equal(gatewayShortName(gw("", "https://openrouter.ai/api/v1")), "openrouter");
  assert.equal(gatewayShortName(gw("", "https://api.deepseek.com")), "deepseek");
  assert.equal(gatewayShortName(gw("", "https://www.example.com/v1")), "example");
  assert.equal(gatewayShortName(gw("", "localhost:4000")), "localhost");
  assert.equal(gatewayShortName(gw("", "http://localhost:4000/v1")), "localhost");
  assert.equal(gatewayShortName(gw("", "http://192.168.1.20:8080/v1")), "192.168.1.20");
  assert.equal(gatewayShortName(gw("", "10.0.0.2:4000")), "10.0.0.2");
  assert.equal(gatewayShortName(gw("  ", "")), "x", "什么都取不到时退到 id");
});

test("网关短名：显示名像主机名时也走短名规则；多级子域取去掉 api. / www. 后的第一段", () => {
  const gw = (name: string, baseUrl = "") => provider({ id: "x", name, baseUrl });
  // core 迁移来的网关被命名为完整主机名（settings.rs legacy_name）
  assert.equal(gatewayShortName(gw("openrouter.ai")), "openrouter");
  assert.equal(gatewayShortName(gw("api.deepseek.com")), "deepseek");
  assert.equal(gatewayShortName(gw("ap-gateway.internal.example.com")), "ap-gateway");
  assert.equal(gatewayShortName(gw("127.0.0.1:8080")), "127.0.0.1");
  assert.equal(
    gatewayShortName(gw("", "https://ap-gateway.internal.example.com/v1")),
    "ap-gateway",
  );
  assert.equal(gatewayShortName(gw("", "https://api.deepseek.com")), "deepseek");
  assert.equal(gatewayShortName(gw("", "http://localhost:4000")), "localhost");
  assert.equal(gatewayShortName(gw("", "http://10.0.0.2:4000")), "10.0.0.2");
  // 不像主机名的显示名原样：含空格、不含点
  assert.equal(gatewayShortName(gw("My Gateway v1.2")), "My Gateway v1.2");
  assert.equal(gatewayShortName(gw("ap-gateway")), "ap-gateway");
});

test("行尾网关短名：entries 跨 ≥2 个网关才写，id 在前、网关名在后；单网关不写", () => {
  const a = provider({ id: "a", name: "", baseUrl: "https://openrouter.ai/api/v1" });
  const b = provider({ id: "b", name: "ap-gateway", baseUrl: "https://x.example.com" });
  const two = [
    {
      provider: a,
      model: model({
        id: "deepseek-chat",
        slug: "deepseek-chat",
        displayName: "DeepSeek V3.2",
        selected: true,
      }),
    },
    {
      provider: b,
      model: model({ id: "azure/gpt-4.1", slug: "azure/gpt-4.1", displayName: "azure/gpt-4.1" }),
    },
  ];
  assert.equal(showGatewayNames(two), true);
  assert.equal(showGatewayNames(two.slice(0, 1)), false);
  const html = render(ModelList, { entries: two, busy: false, onToggle: noop });
  // 已选组已删，每行只在服务商分组里出现一次
  assert.equal((html.match(/models-option__gateway">openrouter</g) ?? []).length, 1);
  assert.match(html, /models-option__gateway">ap-gateway</);
  assert.match(
    html,
    /models-option__id">deepseek-chat<\/span><span class="models-option__gateway">openrouter</,
  );
  assert.match(html, /aria-label="gpt-4\.1，ap-gateway"/);
  const one = render(ModelList, { entries: two.slice(1), busy: false, onToggle: noop });
  assert.doesNotMatch(one, /models-option__gateway/);
});

test("模型列表：底部不再有「已选 N 个模型」；滚动区的容器是纵向 flex，外层压矮时滚动区跟着变矮", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/ModelList.css", import.meta.url), "utf8");
  const rule = (sel: string) =>
    new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  const html = render(ModelList, { entries: [pe("azure/a", true)], busy: false, onToggle: noop });
  assert.doesNotMatch(html, /model-list__foot/);
  assert.doesNotMatch(css, /model-list__foot/);
  const viewport = rule(".model-list__viewport");
  assert.match(viewport, /display:\s*flex/);
  assert.match(viewport, /flex-direction:\s*column/);
  assert.match(viewport, /min-height:\s*0/);
  assert.match(rule(".model-list__scroll"), /min-height:\s*0/);
  assert.match(rule(".models-option__gateway"), /color:\s*var\(--ink-faint\)/);
});

test("网关页：分段片写网关短名；段头说明下一行本网关已选的模型片（× 可移除），没选时整行不出", () => {
  const html = render(
    GatewayPanel,
    panelProps({
      enabled: true,
      providers: [
        provider({
          id: "ap",
          name: "ap-gateway.intra.weibo.com",
          models: [
            model({ id: "azure/gpt-4.1", displayName: "azure/gpt-4.1", selected: true }),
            model({ id: "zhipu/glm-4.6", displayName: "zhipu/glm-4.6", selected: true }),
            model({ id: "azure/o3", displayName: "azure/o3" }),
          ],
        }),
        provider({ id: "or", name: "openrouter.ai" }),
      ],
    }),
  );
  assert.match(html, /gw-panel__chip-name">ap-gateway</);
  assert.match(html, /gw-panel__chip-name">openrouter</);
  assert.match(html, /aria-label="删掉 ap-gateway"|title="删掉 ap-gateway"/);
  // 跨服务商：片保留前缀；片在说明之后、列表框之前
  const chosen = html.indexOf("gw-panel__chosen");
  assert.ok(html.indexOf("gw-panel__note") < chosen && chosen < html.indexOf("gw-panel__list"));
  assert.match(html, /ss-modelchip__name">azure\/gpt-4\.1</);
  assert.match(html, /aria-label="移除 zhipu\/glm-4\.6"/);
  assert.doesNotMatch(html, /ss-modelchip__name">azure\/o3</);

  const none = render(
    GatewayPanel,
    panelProps({
      providers: [provider({ id: "ap", name: "ap", models: [model({ id: "azure/o3" })] })],
    }),
  );
  assert.doesNotMatch(none, /gw-panel__chosen/);
});

test("gatewaySelectedChips：只这一家已选的；同一服务商省前缀，跨服务商保留", () => {
  const one = provider({
    models: [
      model({ id: "azure/gpt-4.1", displayName: "azure/gpt-4.1", selected: true }),
      model({ id: "azure/o3", displayName: "azure/o3", selected: true }),
      model({ id: "zhipu/glm-4.6", displayName: "zhipu/glm-4.6" }),
    ],
  });
  assert.deepEqual(
    gatewaySelectedChips(one).map((c) => c.label),
    ["gpt-4.1", "o3"],
  );
  const mixed = provider({
    models: [
      model({ id: "azure/gpt-4.1", displayName: "azure/gpt-4.1", selected: true }),
      model({ id: "zhipu/glm-4.6", displayName: "zhipu/glm-4.6", selected: true }),
    ],
  });
  assert.deepEqual(
    gatewaySelectedChips(mixed).map((c) => c.label),
    ["azure/gpt-4.1", "zhipu/glm-4.6"],
  );
  assert.deepEqual(gatewaySelectedChips(provider({ models: [model({ id: "a" })] })), []);
});
