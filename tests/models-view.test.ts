import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { render } from "./ui-render.ts";
import {
  MODELS_TOOLS,
  canRestore,
  effectiveModels,
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
  modelIssues,
  showRestartKey,
  shouldPollRestart,
  showLaunchKey,
  selectModel,
  LAUNCH_TIP,
  showRouterTodo,
  snapshotOrder,
  gatewayShortName,
  frozenGroups,
  serviceLeftover,
  UNINSTALL_TIP,
  RESTART_TIP,
  predictEnabled,
  settleAfterRestart,
  RESTART_STILL_STALE,
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
const { InUseRow, RestartSlot, SectionSwitch, sectionTodos } = await import("../src/ModelsTab.tsx");

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
  // 没有网关、一个模型都没选：同一句（DESIGN「没有网关、或一个模型都没选时开关禁用」）
  assert.equal(enableDisabledReason(state({ providers: [] }), 1), "先加一家网关、选好模型再打开");
  assert.equal(enableDisabledReason(state(), 0), "先加一家网关、选好模型再打开");
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
  // 片上分两段画：名字 + 只在撞名时有的网关短名（短名 ink-mute）
  assert.deepEqual(
    rows.map((r) => [r.name, r.suffix]),
    [
      ["GPT-5", "甲"],
      ["GPT-5", "乙"],
      ["只此一家", null],
    ],
  );
  // 后缀是 core 给的网关短名（`shortName`，与网关行、Codex 目录里同一个）：显示名像主机名时它取主体
  const host = provider({
    id: "h",
    name: "openrouter.ai",
    shortName: "openrouter",
    models: [model({ id: "m9", displayName: "GPT-5", selected: true })],
  });
  assert.deepEqual(
    effectiveModels(state({ providers: [one, host] })).map((r) => r.label),
    ["GPT-5 · 甲", "GPT-5 · openrouter"],
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
    /^Codex 还在用它的 1 个模型，先关掉第三方模型再删$/,
  );
});

test("MODELS_TOOLS：版面按工具分块；今天只有 Codex，但名字一律从表里取", () => {
  assert.ok(MODELS_TOOLS.length >= 1);
  const codex = MODELS_TOOLS[0];
  assert.equal(codex.id, "codex");
  assert.equal(codex.name, "Codex");
  // 限制说明全文（网关行展开区第一行，不截断）
  assert.equal(
    codex.limitations,
    "只支持文本与工具调用，不支持图片 · 会话标题仍由官方模型生成，第一条消息会发给官方 · 网页搜索用不了",
  );
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

test("modelIssues：接管 / 配置被外部改过 / 网关无法连接三类，key 随状况变", () => {
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
        provider({ id: "a", name: "甲", unreachable: "地址无法访问" }),
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
  // key：这一条状况的标识，段间是 \u001f
  assert.equal(takeover.key, "model\u001ftakeover\u001fhttps://am.example");
  assert.equal(config.key, "model\u001fconfigChanged\u001f0.50.0");
  assert.equal(down.key, "model\u001funreachable\u001fa\u001f地址无法访问");
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

// ===== 渲染：节头开关与紧跟它的键、在用行、行内待办条 =====

const withSelected = (overrides: Partial<GatewayState> = {}) => ({
  providers: [provider({ models: [model({ id: "m1", selected: true })] })],
  ...overrides,
});

const switchProps = (overrides: Partial<GatewayState> = {}) => ({
  tool: MODELS_TOOLS[0],
  state: state(overrides),
  busy: false,
  phase: { kind: "idle" } as const,
  onToggle: noop,
});

const slotProps = (overrides: Partial<GatewayState> = {}) => ({
  tool: MODELS_TOOLS[0],
  state: state(overrides),
  busy: false,
  phase: { kind: "idle" } as const,
  onRestart: noop,
});

test("SectionSwitch：标准开关（旁边不点指示点，开着由刻线说）；开关＝配置里开没开；关着时提示框写打开的结果与改的是哪个文件", () => {
  const on = render(SectionSwitch, switchProps(withSelected({ enabled: true })));
  assert.match(
    on,
    /role="switch" aria-checked="true"[^>]*class="ss-switch ss-switch--regular is-on"/,
  );
  assert.doesNotMatch(on, /ss-indicator/);
  const off = render(SectionSwitch, switchProps(withSelected()));
  assert.match(off, /role="switch" aria-checked="false"/);
  assert.match(
    off,
    /role="tooltip"[^>]*>打开后，选好的模型会出现在 Codex 的模型列表里；会在 ~\/\.codex\/config\.toml 里加两行</,
  );
});

test("SectionSwitch 乐观翻转：拨下去写配置期间滑块已在拨过去的那一侧、亮橙；没有待定位置、没有拨开关的确认", () => {
  const on = render(SectionSwitch, {
    ...switchProps(withSelected({ enabled: false })),
    busy: true,
    phase: { kind: "switching", next: true },
  });
  assert.match(
    on,
    /role="switch" aria-checked="true"[^>]*class="ss-switch ss-switch--regular is-on"/,
  );
  assert.match(
    on,
    /role="tooltip"[^>]*>关掉后，Codex 只保留官方模型；从 ~\/\.codex\/config\.toml 里删掉那两行</,
  );
  const off = render(SectionSwitch, {
    ...switchProps(withSelected({ enabled: true })),
    busy: true,
    phase: { kind: "switching", next: false },
  });
  assert.match(off, /role="switch" aria-checked="false"/);
  assert.doesNotMatch(on + off, /data-pending|ss-pending-switch/);
  const src = readFileSync(new URL("../src/ModelsTab.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /PendingSwitch|pending=\{|confirmSwitch|gatewayConfirmText|重启并/);
});

test("SectionSwitch 没有网关 / 没选模型：开关禁用，按下即出「先加一家网关、选好模型再打开」", () => {
  const html = render(SectionSwitch, switchProps({ providers: [] }));
  assert.match(
    html,
    /role="switch" aria-checked="false"[^>]*title="先加一家网关、选好模型再打开" disabled=""/,
  );
  assert.match(
    render(SectionSwitch, switchProps()),
    /title="先加一家网关、选好模型再打开" disabled=""/,
  );
});

test("SectionSwitch 拨开关之后：开关原位锁住（过了 0.3 秒门槛换成转圈 +「正在添加」），不画成禁用", () => {
  const html = render(SectionSwitch, {
    ...switchProps(withSelected({ enabled: false })),
    busy: true,
    phase: { kind: "switching", next: true },
  });
  assert.match(
    html,
    /class="models-switch"><span class="ss-locked" aria-busy="true">[^]*role="switch" aria-checked="true"/,
  );
  assert.doesNotMatch(html, /title="正在处理上一步"/);
  assert.doesNotMatch(html, /ss-spinner/);
});

test("RestartSlot（节头里开关右边 12）：待重启出紧凑键「重启生效」（与 卸下后台服务 同位同高），提示框写后果与代价、左对齐键", () => {
  const html = render(
    RestartSlot,
    slotProps(withSelected({ enabled: true, needsCodexRestart: true })),
  );
  assert.match(html, /class="ss-btn ss-btn--compact"[^>]*>重启生效</);
  assert.match(html, /role="tooltip"[^>]*>重启 Codex 桌面应用让改动生效，进行中的对话会中断</);
  assert.equal(render(RestartSlot, slotProps(withSelected({ enabled: true }))), "");
  const src = readFileSync(new URL("../src/ModelsTab.tsx", import.meta.url), "utf8");
  const slot = src.slice(
    src.indexOf("export function RestartSlot"),
    src.indexOf("// ===== 节头：开关"),
  );
  assert.doesNotMatch(slot, /align="end"/, "键紧跟开关：提示框、✓ 已生效都左对齐键");
  assert.match(slot, /<FloatingToast align="start">/);
});

test("第三方模型节头：开关紧跟节名，开关右边 12 是 重启生效 / 启动 Codex / 卸下后台服务（同一位）；重启确认在窗口正中", () => {
  const src = readFileSync(new URL("../src/ModelsTab.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /PageHeadActions|models-headctl/);
  assert.match(
    src,
    /control=\{[^}]*<SectionSwitch[^]*actions=\{[^]*<RestartSlot[^]*\{uninstallKey\}/,
  );
  assert.match(src, /onRestart=\{\(\) => setConfirmRestart\(true\)\}/);
  // 确认框一律在窗口正中，不再锚在键下
  assert.doesNotMatch(src, /anchor=\{confirmRestart\}/);
  // 节头骨架：节名 + 12 + 开关 + 12 + 键（开关紧跟节名，不推到右端）
  const section = readFileSync(new URL("../src/ui/Section.tsx", import.meta.url), "utf8");
  assert.match(section, /ss-section__title[^]*ss-section__control[^]*ss-section__actions/);
  assert.doesNotMatch(section, /data-section-controls/);
  const css = readFileSync(new URL("../src/ui/Section.css", import.meta.url), "utf8");
  assert.match(css, /\.ss-section__head \{[^}]*gap: var\(--space-sm\);/);
  assert.doesNotMatch(css, /margin-left: auto/);
});

test("RestartSlot 重启中：0.3 秒门槛之前键照旧、点不动；已生效：键的原位下方浮起白窗", () => {
  const busyHtml = render(RestartSlot, {
    ...slotProps(withSelected({ enabled: true, needsCodexRestart: true })),
    phase: { kind: "restarting" },
  });
  assert.match(
    busyHtml,
    /class="models-restart-tip ss-locked" aria-busy="true"[^]*重启生效<\/button>/,
  );
  assert.doesNotMatch(busyHtml, /ss-spinner/);
  const src = readFileSync(new URL("../src/ModelsTab.tsx", import.meta.url), "utf8");
  assert.match(src, /const shown = useBusyShown\(waiting\);\s*if \(waiting && shown\)/);
  const doneHtml = render(RestartSlot, {
    ...slotProps(withSelected({ enabled: true })),
    phase: { kind: "done" },
  });
  assert.match(
    doneHtml,
    /class="models-restart models-restart--done"><span class="ss-floattoast__probe" hidden=""><\/span><div class="ss-floattoast"/,
  );
  assert.match(doneHtml, /ss-toast--routine[^]*已生效/);
});

test("RestartSlot 启动 Codex：开着、Codex 没在跑才出键，提示框写结果；关着不出", () => {
  const html = render(RestartSlot, {
    ...slotProps(withSelected({ enabled: true })),
    onLaunch: noop,
  });
  assert.match(html, />启动 Codex<\/button>/);
  assert.match(html, /role="tooltip"[^>]*>打开 Codex 桌面应用，它会用上现在的模型设置</);
  assert.doesNotMatch(
    render(RestartSlot, { ...slotProps(withSelected()), onLaunch: noop }),
    /启动 Codex/,
  );
  const launching = render(RestartSlot, {
    ...slotProps(withSelected({ enabled: true })),
    onLaunch: noop,
    phase: { kind: "launching" },
  });
  assert.match(launching, /ss-locked" aria-busy="true"[^]*启动 Codex<\/button>/);
  const launched = render(RestartSlot, {
    ...slotProps(withSelected({ enabled: true })),
    onLaunch: noop,
    phase: { kind: "launched" },
  });
  assert.match(launched, /models-restart--done[^]*ss-toast--routine[^]*已启动/);
});

test("InUseRow：开着写「在用」、关着写「已选」；片可 ×；一个都没选时整行不出", () => {
  const sel = withSelected();
  const on = render(InUseRow, { state: state({ ...sel, enabled: true }), onRemove: noop });
  assert.match(on, /models-inuse__label">在用</);
  assert.match(on, /class="ss-modelchip" title="gpt-x"[^]*ss-modelchip__remove/);
  const off = render(InUseRow, { state: state(sel), onRemove: noop });
  assert.match(off, /models-inuse__label">已选</);
  assert.equal(render(InUseRow, { state: state(), onRemove: noop }), "");
  // 没有汇总下拉（原框尾 103 ▾）：这一行只管看和去掉
  assert.doesNotMatch(on, /models-box|aria-haspopup/);
});

test("InUseRow 两家网关同名：片名后加 ` · 网关短名`，短名单独一段（ink-mute）；不撞名的片不加", () => {
  const a = provider({
    id: "a",
    name: "",
    shortName: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [model({ id: "openai/gpt-4.1", displayName: "GPT-4.1", selected: true })],
  });
  const b = provider({
    id: "b",
    name: "azure",
    models: [
      model({ id: "gpt-4.1", displayName: "GPT-4.1", selected: true }),
      model({ id: "kimi", displayName: "Kimi K2", selected: true }),
    ],
  });
  const html = render(InUseRow, {
    state: state({ providers: [a, b], enabled: true }),
    onRemove: noop,
  });
  assert.match(
    html,
    /ss-modelchip__name">GPT-4\.1<span class="ss-modelchip__suffix"> · openrouter<\/span>/,
  );
  assert.match(
    html,
    /ss-modelchip__name">GPT-4\.1<span class="ss-modelchip__suffix"> · azure<\/span>/,
  );
  assert.match(html, /ss-modelchip__name">Kimi K2<\/span>/);
  assert.match(html, /aria-label="移除 GPT-4\.1 · azure"/);
  const css = readFileSync(new URL("../src/ui/ui.css", import.meta.url), "utf8");
  assert.match(css, /\.ss-modelchip__suffix \{\s*color: var\(--ink-mute\);/);
});

test("sectionTodos：路由没在跑排最前、原因同一行；接管 / 重新写入；都不给「稍后」", () => {
  const html = render(
    () =>
      sectionTodos({
        tool: MODELS_TOOLS[0],
        state: state({
          enabled: true,
          takeover: { baseUrl: "x", selectedCount: 1 },
          codex: { version: "26.0", running: true, catalogVersion: "1", drift: true },
        }),
        healed: true,
        routerFailure: "端口 47328 被别的程序占着",
        resolving: null,
        busy: false,
        onRestartRouter: noop,
        onResolve: noop,
      }),
    {},
  );
  const router = html.indexOf("路由没在跑，第三方模型用不了");
  assert.ok(router >= 0 && router < html.indexOf("Codex 正由 agents-manager 管理"));
  assert.match(
    html,
    /路由没在跑，第三方模型用不了<span class="ss-noticepanel__reason"> · 端口 47328 被别的程序占着/,
  );
  assert.match(html, /Sophia 写进去的设置被改掉了/);
  assert.match(html, />重启路由<[^]*>接管<[^]*>重新写入</);
  assert.doesNotMatch(html, /稍后/);
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
  assert.equal((html.match(/models-option__id ss-selectable"/g) ?? []).length, 1);
  // 模型 id 能选中拷走（D23）
  assert.match(html, /models-option__id ss-selectable">deepseek-chat</);
  // 筛选框写出这一家有几个模型；每行 13px 复选框（全应用同一个记号），行尾不写网关短名
  assert.match(html, /placeholder="筛选 10 个模型"/);
  assert.match(html, /ss-checkbox models-option__check/);
  assert.doesNotMatch(html, /models-option__gateway/);
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
  const p = provider({ id: "or", name: "openrouter.ai", shortName: "openrouter" });
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

test("网关短名只读 core 给的 shortName（取法与测试表在 core settings.rs `short_name`）；缺省时退到显示名、再退到 id", () => {
  assert.equal(
    gatewayShortName(provider({ name: "openrouter.ai", shortName: "openrouter" })),
    "openrouter",
  );
  assert.equal(gatewayShortName(provider({ id: "x", name: " WeCode " })), "WeCode");
  assert.equal(gatewayShortName(provider({ id: "x", name: "  " })), "x");
  const src = readFileSync(new URL("../src/modelsView.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /HOST_LIKE|function hostOf/, "界面不再自己从主机名取短名");
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
  // 行尾网关短名随汇总下拉删掉（每个列表只列一家）；组头计数 tabular、不用等宽（一种数字）
  assert.doesNotMatch(css, /models-option__gateway/);
  assert.match(rule(".model-list__count"), /font-variant-numeric:\s*tabular-nums/);
  assert.doesNotMatch(rule(".model-list__count"), /font-mono/);
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

// ===== 开关＝配置里开没开，拨了就写（DESIGN「第三方模型（一节）」） =====

test("gatewaySwitchText：忙碌「正在添加 / 正在移除」；没成的主句（成了不说话：滑块、橙与旁边的键就是结果）", () => {
  assert.deepEqual(gatewaySwitchText(true), { busy: "正在添加", failed: "没添加到 Codex" });
  assert.deepEqual(gatewaySwitchText(false), { busy: "正在移除", failed: "没从 Codex 移除" });
});

/// switchGateway 的假依赖：记下调用顺序；`writes` 按次序给每次写的结果（Error 即抛出）
const switchIo = (opts: {
  writes: Array<GatewayState | Error>;
  reads: GatewayState[];
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

test("switchGateway：只写配置、不重启不等；成了返回 null，画上写回来的状态（在跑时它说要重启，键随之出来）", async () => {
  const on = state({ enabled: true, needsCodexRestart: true });
  const h = switchIo({ writes: [on], reads: [] });
  assert.equal(await switchGateway(true, h.io), null);
  assert.deepEqual(h.calls, ["enable"]);
  assert.deepEqual(h.painted, [on]);

  const off = state({ enabled: false });
  const h2 = switchIo({ writes: [off], reads: [] });
  assert.equal(await switchGateway(false, h2.io), null);
  assert.deepEqual(h2.calls, ["restore"]);
});

test("switchGateway 没写成：原因原样返回，并尽力撤回（关掉的反向是再启用），再重读一次画真实状态；撤回也没成就在原因后说一声", async () => {
  const enabled = state({ enabled: true });
  const h = switchIo({ writes: [new Error("配置文件被改过"), enabled], reads: [enabled] });
  assert.equal(await switchGateway(false, h.io), "配置文件被改过");
  assert.deepEqual(h.calls, ["restore", "enable", "read"]);
  assert.equal(h.painted.at(-1), enabled, "开关画成真实状态");

  const both = switchIo({
    writes: [new Error("路由起不来"), new Error("还是起不来")],
    reads: [state()],
  });
  assert.equal(await switchGateway(true, both.io), `路由起不来${SWITCH_ROLLBACK_FAILED}`);
  assert.equal(SWITCH_ROLLBACK_FAILED, "；回滚也失败了");
  assert.deepEqual(both.calls, ["enable", "restore", "read"]);
});

test("switchGateway 页面没了：返回 undefined，不再画（调用方什么都别做）", async () => {
  const on = state({ enabled: true });
  const gone = switchIo({ writes: [on], reads: [on], alive: () => false });
  assert.equal(await switchGateway(true, gone.io), undefined);
  assert.deepEqual(gone.painted, [], "页面没了不再画");
});

test("开关拨了就写：第三方模型节拨开关直接走 switchGateway（不确认、不重启），不经勾选的写队列；去掉最后一个模型也直接关", () => {
  const src = readFileSync(new URL("../src/ModelsTab.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /predictEnabled|toggleGateway|requestSwitch|runSwitch/);
  assert.match(src, /onToggle=\{\(next\) => void toggleSwitch\(next\)\}/);
  assert.match(src, /failure = await switchGateway\(next, \{/);
  assert.doesNotMatch(src, /turnsOff && base\.codex\.running/);
  assert.doesNotMatch(src, /const pending =/);
  // D5：不再有网关二级页、配置网关、汇总下拉
  assert.doesNotMatch(src, /GatewayPage|配置网关|ModelPicker|ModelBox/);
});
