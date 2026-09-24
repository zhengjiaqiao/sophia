import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
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
  showLaunchKey,
  selectModel,
  LAUNCH_TIP,
  showRouterTodo,
  snapshotOrder,
  showGatewayNames,
  gatewayShortName,
  gatewaySelectedChips,
  frozenGroups,
  serviceLeftover,
  UNINSTALL_TIP,
  RESTART_TIP,
  predictEnabled,
  settleAfterRestart,
  RESTART_STILL_STALE,
  gatewayConfirmText,
  gatewaySwitchText,
  switchGateway,
  SWITCH_ROLLBACK_FAILED,
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

test("启动 Codex：网关开着、Codex 没在跑、空闲时才出键；键显示着也轮询，用户自己打开了键就消失", () => {
  const codex = (running: boolean) => ({
    version: "26.0",
    running,
    catalogVersion: "1",
    drift: false,
  });
  const idle = { kind: "idle" } as const;
  const down = state({ enabled: true, codex: codex(false) });
  assert.equal(showLaunchKey(down, idle), true);
  assert.equal(showLaunchKey(down, { kind: "launching" }), false);
  assert.equal(showLaunchKey(down, { kind: "launched" }), false);
  assert.equal(
    showLaunchKey(state({ enabled: false, codex: codex(false) }), idle),
    false,
    "网关关着不出",
  );
  assert.equal(showLaunchKey(state({ enabled: true, codex: codex(true) }), idle), false);
  // 与重启生效不同时出现：要重启说明它在跑
  assert.equal(showLaunchKey(state({ enabled: true, needsCodexRestart: true }), idle), false);
  assert.equal(shouldPollRestart(down, idle), true);
  assert.equal(shouldPollRestart(down, { kind: "launching" }), false, "启动中由自己轮询");
  assert.equal(shouldPollRestart(state({ enabled: true, codex: codex(true) }), idle), false);
  assert.equal(LAUNCH_TIP, "打开 Codex 桌面应用，它会用上现在的模型设置");
});

test("selectModel：只翻这一家这一个模型；网关开着时去掉最后一个生效模型 → 开关随之画成关", () => {
  const two = state({
    enabled: true,
    providers: [
      provider({ id: "a", models: [model({ id: "m1", selected: true }), model({ id: "m2" })] }),
      provider({ id: "b", models: [model({ id: "m1", selected: true })] }),
    ],
  });
  const added = selectModel(two, "a", "m2", true);
  assert.equal(added.turnsOff, false);
  assert.deepEqual(
    added.next.providers.map((p) => p.models.map((m) => m.selected)),
    [[true, true], [true]],
  );
  assert.equal(added.next.provider.models[1].selected, true, "兼容字段跟着换");
  assert.equal(two.providers[0].models[1].selected, false, "不改原状态");

  // 另一家还有生效模型：不是最后一个，开关不动
  const partial = selectModel(two, "a", "m1", false);
  assert.equal(partial.turnsOff, false);
  assert.equal(partial.next.enabled, true);

  // 全部网关加起来一个不剩：等同关掉开关
  const last = selectModel(partial.next, "b", "m1", false);
  assert.equal(last.turnsOff, true);
  assert.equal(last.next.enabled, false);
  assert.equal(totalSelected(last.next), 0);
  // 关掉的预测连路由一起：否则等结果那一下 `卸下后台服务` 会闪出来
  assert.equal(serviceLeftover(last.next), false);

  // 网关本来就关着：去掉最后一个只是去掉
  const off = selectModel({ ...partial.next, enabled: false }, "b", "m1", false);
  assert.equal(off.turnsOff, false);
});

test("路由没在跑：先自愈，自愈过仍没起来才出横幅", () => {
  const down = state({
    enabled: true,
    router: { installed: true, running: false, port: 1, protocol: "chat", error: "x" },
  });
  assert.equal(showRouterTodo(down, false), false);
  assert.equal(showRouterTodo(down, true), true);
  assert.equal(showRouterTodo(state({ enabled: false }), true), false);
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

test("AgentRow：图标 + 名字（不大写）+ regular 开关 + 配置网关，一组；生效模型在第二格", () => {
  const html = render(AgentRow, rowProps(withSelected({ enabled: true })));
  assert.match(html, /<svg[^>]*width="24" height="24"/);
  assert.match(html, /class="models-row__name">Codex</);
  assert.doesNotMatch(html, /CODEX/);
  assert.match(
    html,
    /role="switch" aria-checked="true"[^>]*class="ss-switch ss-switch--regular is-on"/,
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

test("AgentRow 重启中：0.3 秒门槛之前键照旧、点不动（过了门槛原位换成辐条转圈 +「正在重启 Codex」）；已生效：键的原位下方浮起白窗", () => {
  const busyHtml = render(AgentRow, {
    ...rowProps(withSelected({ enabled: true, needsCodexRestart: true })),
    phase: { kind: "restarting" },
  });
  // 首帧（门槛之前）：键锁住、不闪忙碌；门槛之后的转圈 + 一句由 useBusyShown 把关
  assert.match(
    busyHtml,
    /class="models-restart-tip ss-locked" aria-busy="true"[^]*重启生效<\/button>/,
  );
  assert.doesNotMatch(busyHtml, /ss-spinner/);
  const src = readFileSync(new URL("../src/ModelsTab.tsx", import.meta.url), "utf8");
  assert.match(src, /const shown = useBusyShown\(waiting\);\s*if \(waiting && shown\)/);
  const doneHtml = render(AgentRow, {
    ...rowProps(withSelected({ enabled: true })),
    phase: { kind: "done" },
  });
  // 键消失，原位留一个不占宽的锚，`✓ 已生效` 是浮起的白窗（FloatingToast），不是行内一行字
  assert.match(
    doneHtml,
    /class="models-restart models-restart--done"><span class="ss-floattoast__probe" hidden=""><\/span><div class="ss-floattoast"/,
  );
  assert.match(doneHtml, /ss-toast--routine[^]*已生效/);
  const css = readFileSync(new URL("../src/ModelsTab.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /models-done-fade|animation/);
});

test("AgentRow 重启失败：行下灰面板「没重启 Codex」+ 原因 + 再试一次 + ×，不用黑块", () => {
  const html = render(AgentRow, {
    ...rowProps(withSelected({ enabled: true, needsCodexRestart: true })),
    notice: {
      message: "没重启 Codex",
      reason: "Codex 还在用旧配置",
      action: { label: "再试一次", onClick: noop },
    },
    onCloseNotice: noop,
  });
  assert.match(
    html,
    /models-row__notice[^]*ss-noticepanel[^]*没重启 Codex[^]*Codex 还在用旧配置[^]*再试一次[^]*关闭/,
  );
  // 大面积不用黑（DESIGN「提示条分两档」）
  assert.doesNotMatch(html, /ss-toast--notice|ss-toast--cannot/);
});

test("AgentRow 启动 Codex：网关开着、Codex 没在跑才出紧凑键，提示框写结果；网关关着不出", () => {
  const html = render(AgentRow, {
    ...rowProps(withSelected({ enabled: true })),
    onLaunch: noop,
  });
  assert.match(html, /配置网关<\/button>.*启动 Codex<\/button>/s);
  assert.match(html, /role="tooltip"[^>]*>打开 Codex 桌面应用，它会用上现在的模型设置</);
  assert.doesNotMatch(html, /重启生效/);
  const off = render(AgentRow, { ...rowProps(withSelected({ enabled: false })), onLaunch: noop });
  assert.doesNotMatch(off, /启动 Codex/);
  const launching = render(AgentRow, {
    ...rowProps(withSelected({ enabled: true })),
    onLaunch: noop,
    phase: { kind: "launching" },
  });
  // 首帧（门槛之前）：键照旧、点不动
  assert.match(launching, /ss-locked" aria-busy="true"[^]*启动 Codex<\/button>/);
  assert.doesNotMatch(launching, /ss-spinner/);
  const launched = render(AgentRow, {
    ...rowProps(
      withSelected({
        enabled: true,
        codex: { version: "26.0", running: true, catalogVersion: "1", drift: false },
      }),
    ),
    onLaunch: noop,
    phase: { kind: "launched" },
  });
  assert.match(launched, /models-restart--done[^]*ss-floattoast[^]*ss-toast--routine[^]*已启动/);
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

test("ModelList：超过 8 行出筛选框；新拉到的模型整批出现不逐个闪；行尾 id 只在明显不同时出现", () => {
  const p = provider({ id: "g", models: [] });
  const entries = Array.from({ length: 9 }, (_, i) => ({
    provider: p,
    model: model({ id: `azure/m${i}`, slug: `g-azure/m${i}`, displayName: `azure/m${i}` }),
  }));
  entries.push({
    provider: p,
    model: model({ id: "deepseek/deepseek-chat", slug: "g-ds", displayName: "DeepSeek V3.2" }),
  });
  const html = render(ModelList, { entries, onToggle: noop });
  assert.match(html, /model-list__search/);
  // 批量不闪、不依次点亮（DESIGN 2026-09-24）：行上没有逐个闪的动画
  assert.doesNotMatch(html, /is-flash|animation-delay/);
  assert.equal((html.match(/models-option__id"/g) ?? []).length, 1);
  assert.match(html, /models-option__id">deepseek-chat</);
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

test("AgentRow 停用后服务仍在：出紧凑键「卸下后台服务」（与重启生效同形），提示框写结果；正在卸下时键先锁住（过了门槛换成忙碌指示 + 文字）", () => {
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
  assert.match(busyHtml, /class="ss-locked" aria-busy="true"[^]*卸下后台服务<\/button>/);
  assert.doesNotMatch(busyHtml, /ss-spinner/);
  assert.doesNotMatch(
    render(AgentRow, { ...rowProps(withSelected({ enabled: true })), onUninstall: noop }),
    /卸下后台服务/,
  );
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
  const html = render(ModelList, { entries: seven, onToggle: noop });
  assert.doesNotMatch(html, /model-list__group--pinned|>已选<|model-list__more/);
  assert.equal((html.match(/role="option"/g) ?? []).length, 9);
});

test("ModelList 不整体变暗：不再有 busy 能加上的 ss-busy（DESIGN「忙碌」只锁触发它的那个控件，不把整页/整块变暗）", () => {
  const entries = [pe("azure/a", true), pe("azure/b", false)];
  const html = render(ModelList, { entries, onToggle: noop });
  assert.doesNotMatch(html, /ss-busy/);
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
  const html = render(ModelList, { entries: two, onToggle: noop });
  // 已选组已删，每行只在服务商分组里出现一次
  assert.equal((html.match(/models-option__gateway">openrouter</g) ?? []).length, 1);
  assert.match(html, /models-option__gateway">ap-gateway</);
  assert.match(
    html,
    /models-option__id">deepseek-chat<\/span><span class="models-option__gateway">openrouter</,
  );
  assert.match(html, /aria-label="gpt-4\.1，ap-gateway"/);
  const one = render(ModelList, { entries: two.slice(1), onToggle: noop });
  assert.doesNotMatch(one, /models-option__gateway/);
});

test("模型列表：底部不再有「已选 N 个模型」；滚动区的容器是纵向 flex，外层压矮时滚动区跟着变矮", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/ModelList.css", import.meta.url), "utf8");
  const rule = (sel: string) =>
    new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  const html = render(ModelList, { entries: [pe("azure/a", true)], onToggle: noop });
  assert.doesNotMatch(html, /model-list__foot/);
  assert.doesNotMatch(css, /model-list__foot/);
  const viewport = rule(".model-list__viewport");
  assert.match(viewport, /display:\s*flex/);
  assert.match(viewport, /flex-direction:\s*column/);
  assert.match(viewport, /min-height:\s*0/);
  assert.match(rule(".model-list__scroll"), /min-height:\s*0/);
  assert.match(rule(".models-option__gateway"), /color:\s*var\(--ink-faint\)/);
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

test("predictEnabled：先画做成之后的样子（Codex 没在跑时删掉最后一个模型那一支）——开时路由在跑、关时服务已卸，提示不闪", () => {
  const base = state();
  const on = predictEnabled(
    { ...base, enabled: false, router: { ...base.router, installed: false, running: false } },
    true,
  );
  assert.equal(on.enabled, true);
  assert.equal(routerUnavailable(on), false);
  const off = predictEnabled(
    { ...base, enabled: true, router: { ...base.router, installed: true, running: true } },
    false,
  );
  assert.equal(off.enabled, false);
  assert.equal(serviceLeftover(off), false);
});

test("settleAfterRestart：发完结束信号等旧进程退——先读到旧配置不算失败，等到换上才算成；等满才说没换上", async () => {
  const stale = { ...state(), needsCodexRestart: true };
  const fresh = { ...state(), needsCodexRestart: false };
  const timing = { timeoutMs: 1000, pollMs: 1 };
  const seen: boolean[] = [];
  const reads = [stale, stale, fresh];
  const ok = await settleAfterRestart(
    async () => reads.shift() ?? fresh,
    (s) => seen.push(s.needsCodexRestart),
    () => true,
    timing,
  );
  assert.equal(ok, null);
  assert.deepEqual(seen, [true, true, false]);

  const never = await settleAfterRestart(
    async () => stale,
    () => undefined,
    () => true,
    {
      timeoutMs: 5,
      pollMs: 1,
    },
  );
  assert.equal(never, RESTART_STILL_STALE);

  const gone = await settleAfterRestart(
    async () => stale,
    () => undefined,
    () => false,
    timing,
  );
  assert.equal(gone, undefined);
});

// ===== 开关的状态＝Codex 正在用的状态（DESIGN 同名一条） =====

test("gatewayConfirmText：打开写出数量与「添加」，关掉写「移除」；正文说要重启、对话会中断；主动作「重启并…」", () => {
  const three = state({
    providers: [
      provider({
        id: "a",
        models: [model({ id: "m1", selected: true }), model({ id: "m2", selected: true })],
      }),
      provider({ id: "b", models: [model({ id: "m1", selected: true }), model({ id: "m3" })] }),
    ],
  });
  assert.deepEqual(gatewayConfirmText(three, true), {
    title: "把 3 个第三方模型添加到 Codex？",
    body: "要重启 Codex 才生效，进行中的对话会中断",
    confirmLabel: "重启并添加",
  });
  assert.deepEqual(gatewayConfirmText({ ...three, enabled: true }, false), {
    title: "从 Codex 移除第三方模型？",
    body: "要重启 Codex 才生效，进行中的对话会中断",
    confirmLabel: "重启并移除",
  });
});

test("gatewaySwitchText：忙碌「正在添加 / 正在移除」；成了 ✓ 已添加到 / 已从 Codex 移除，没在跑补一句；没成的主句", () => {
  assert.deepEqual(gatewaySwitchText(true, true), {
    busy: "正在添加",
    done: "已添加到 Codex",
    failed: "没添加到 Codex",
  });
  assert.equal(gatewaySwitchText(true, false).done, "已添加到 Codex，下次打开就能用");
  assert.deepEqual(gatewaySwitchText(false, true), {
    busy: "正在移除",
    done: "已从 Codex 移除",
    failed: "没从 Codex 移除",
  });
  assert.equal(gatewaySwitchText(false, false).done, "已从 Codex 移除");
});

/// switchGateway 的假依赖：记下调用顺序；`writes` 按次序给每次写的结果（Error 即抛出）
const switchIo = (opts: {
  writes: Array<GatewayState | Error>;
  reads: GatewayState[];
  restartError?: Error;
  alive?: () => boolean;
}) => {
  const calls: string[] = [];
  const painted: GatewayState[] = [];
  const io = {
    write: async (on: boolean) => {
      calls.push(on ? "enable" : "restore");
      const next = opts.writes.shift();
      if (next === undefined) throw new Error("没有预设的写结果");
      if (next instanceof Error) throw next;
      return next;
    },
    restartCodex: async () => {
      calls.push("restartCodex");
      if (opts.restartError) throw opts.restartError;
    },
    read: async () => {
      calls.push("read");
      return opts.reads.shift() ?? opts.reads[opts.reads.length - 1] ?? state();
    },
    onState: (s: GatewayState) => painted.push(s),
    alive: opts.alive ?? (() => true),
    describe: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  };
  return { io, calls, painted };
};
const fastSettle = { timeoutMs: 5, pollMs: 1 };

test("switchGateway 在跑时：写配置 → 重启 Codex → 等到换上，成了返回 null、不回滚", async () => {
  const on = state({ enabled: true, needsCodexRestart: true });
  const settled = state({ enabled: true, needsCodexRestart: false });
  const h = switchIo({ writes: [on], reads: [on, settled] });
  const result = await switchGateway(true, true, h.io, { timeoutMs: 1000, pollMs: 1 });
  assert.equal(result, null);
  assert.deepEqual(h.calls, ["enable", "restartCodex", "read", "read"]);
  assert.equal(h.painted.at(-1), settled, "开关落到新状态");
});

test("switchGateway 没在跑：直接写，不重启、不等", async () => {
  const off = state({ enabled: false });
  const h = switchIo({ writes: [off], reads: [] });
  assert.equal(await switchGateway(false, false, h.io), null);
  assert.deepEqual(h.calls, ["restore"]);
  assert.deepEqual(h.painted, [off]);
});

test("switchGateway 15 秒内没换上：撤回刚写的（打开的反向是恢复），再重读一次画真实状态，返回原因", async () => {
  const stale = state({ enabled: true, needsCodexRestart: true });
  const back = state({ enabled: false });
  const actual = state({ enabled: false, needsCodexRestart: false });
  const h = switchIo({ writes: [stale, back], reads: [stale, stale, stale, stale, stale, stale] });
  // 等待里一直读到旧配置：最后一次读（回滚后的重读）换成真实状态
  h.io.read = (() => {
    const inner = h.io.read;
    return async () => {
      const last = h.calls.at(-1);
      if (last === "restore") {
        h.calls.push("read");
        return actual;
      }
      return inner();
    };
  })();
  const result = await switchGateway(true, true, h.io, fastSettle);
  assert.equal(result, RESTART_STILL_STALE);
  const afterRestart = h.calls.slice(h.calls.indexOf("restartCodex") + 1);
  assert.deepEqual(afterRestart.slice(-2), ["restore", "read"], "先撤回、再重读");
  assert.equal(h.calls[0], "enable");
  assert.equal(h.painted.at(-1), actual, "开关画成真实状态");
});

test("switchGateway 写不进：原因原样返回，并尽力撤回（关掉的反向是再启用）；撤回也没成就在原因后说一声", async () => {
  const enabled = state({ enabled: true });
  const h = switchIo({ writes: [new Error("配置文件被改过"), enabled], reads: [enabled] });
  assert.equal(await switchGateway(false, true, h.io, fastSettle), "配置文件被改过");
  assert.deepEqual(h.calls, ["restore", "enable", "read"], "写不进就不重启");

  const both = switchIo({
    writes: [new Error("路由起不来"), new Error("还是起不来")],
    reads: [state()],
  });
  assert.equal(
    await switchGateway(true, true, both.io, fastSettle),
    `路由起不来${SWITCH_ROLLBACK_FAILED}`,
  );
  assert.equal(SWITCH_ROLLBACK_FAILED, "；回滚也没成");
  assert.deepEqual(both.calls, ["enable", "restore", "read"]);
});

test("switchGateway 重启发不出：同样撤回；页面没了返回 undefined（调用方什么都别做）", async () => {
  const on = state({ enabled: true, needsCodexRestart: true });
  const h = switchIo({
    writes: [on, state()],
    reads: [state()],
    restartError: new Error("结束不了进程"),
  });
  assert.equal(await switchGateway(true, true, h.io, fastSettle), "结束不了进程");
  assert.deepEqual(h.calls, ["enable", "restartCodex", "restore", "read"]);

  const gone = switchIo({ writes: [on], reads: [on], alive: () => false });
  assert.equal(await switchGateway(true, true, gone.io, fastSettle), undefined);
  assert.deepEqual(gone.painted, [], "页面没了不再画");
});

test("AgentRow 拨开关之后：开关原位锁住（过了 0.3 秒门槛换成转圈 +「正在添加」），这一格的重启键不跟着闪出来", () => {
  const html = render(AgentRow, {
    ...rowProps(withSelected({ enabled: true, needsCodexRestart: true })),
    busy: true,
    phase: { kind: "switching", next: true },
  });
  // 首帧（门槛之前）：开关照旧、点不动，不画成禁用
  assert.match(
    html,
    /class="models-switch"><span class="ss-locked" aria-busy="true">[^]*role="switch"/,
  );
  assert.doesNotMatch(html, /title="正在处理上一步"/);
  assert.doesNotMatch(html, /重启生效/);
  assert.doesNotMatch(html, /ss-spinner/);
});

test("AgentRow 拨开关成了：开关原位下方浮起白窗 `✓ 已添加到 Codex`（同 ✓ 已生效）", () => {
  const html = render(AgentRow, {
    ...rowProps(withSelected({ enabled: true })),
    switchDone: "已添加到 Codex",
    onSwitchDoneDismiss: noop,
  });
  assert.match(
    html,
    /class="models-switch">[^]*role="switch"[^]*<span class="ss-floattoast__probe" hidden=""><\/span><div class="ss-floattoast"[^]*ss-toast--routine[^]*已添加到 Codex/,
  );
});

test("开关不再乐观翻转：模型页拨开关走确认 / switchGateway，不经勾选的写队列", () => {
  const src = readFileSync(new URL("../src/ModelsTab.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /predictEnabled|toggleGateway/);
  assert.match(src, /gatewayConfirmText\(state, confirmSwitch\.next\)/);
  assert.match(src, /switchGateway\(next, restart,/);
});
