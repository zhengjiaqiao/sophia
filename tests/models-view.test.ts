import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { copy, withCopy } from "./copy.ts";
import { render } from "./ui-render.ts";
import {
  MODELS_TOOLS,
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
  resolveManual,
  prefixExample,
  launchTip,
  showRouterTodo,
  snapshotOrder,
  gatewayShortName,
  frozenGroups,
  restartTip,
  predictEnabled,
  settleAfterRestart,
  restartStillStale,
  codexAppName,
  restartConsequence,
  gatewaySwitchText,
  switchGateway,
  switchRollbackFailed,
  codexKeyKind,
  anyGatewayOn,
  codexListSwitchReason,
  addressTakenBy,
  contextLabel,
  refetchSummary,
  likelyNonChat,
  nonChatGroup,
  addressTakenText,
  copyEmptyText,
  otherAgent,
  removeConfirmText,
  sameAddress,
  syncCheckLabel,
} from "../src/modelsView.ts";
import type { ModelsTool } from "../src/modelsView.ts";
import { codexGateway, withAgentGateway } from "../src/types.ts";
import type { GatewayProvider, GatewayProviderModel, GatewayState } from "../src/types.ts";
import { CLAUDE_OFF, gatewayFixture, type CodexFixture } from "./gateway-fixture.ts";

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
  key: "set",
  models: [],
  ...overrides,
});

// 用例按 Codex 的平铺字段写，夹具拼成按家拆开的 GatewayState（tests/gateway-fixture.ts）
const state = (overrides: Partial<CodexFixture> = {}): GatewayState =>
  gatewayFixture({
    supported: true,
    providers: [provider()],
    enabled: false,
    needsCodexRestart: false,
    router: { running: false, port: 47328, error: "" },
    codex: { version: "26.0", running: false, catalogVersion: "1", drift: false },
    conflict: "",
    takeover: null,
    ...overrides,
  });

const { ModelList } = await import("../src/ModelList.tsx");
const { InUseRow, sectionTodos } = await import("../src/ModelsTab.tsx");
const { CodexKeySlot, CodexSwitch } = await import("../src/codexControls.tsx");

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

// spec 2026-10-04-local-diagnostics R13：技术原文跟在一句话之后另起一行 `[detail] `，拆进 detail，只把一句话给人看
test("parseBackendError：`\\n[detail] ` 之后是技术原文，拆进 detail（可以多行）；没有就不带 detail", () => {
  assert.deepEqual(
    parseBackendError(
      "[network] 服务商限流了，约 30 秒后再试\n[detail] GET https://x/models → 429 Too Many Requests\n{\"error\":1}",
    ),
    {
      code: "network",
      message: "服务商限流了，约 30 秒后再试",
      detail: "GET https://x/models → 429 Too Many Requests\n{\"error\":1}",
    },
  );
  assert.equal("detail" in parseBackendError("[auth] 鉴权失败"), false);
});

test("routerUnavailable 只在已启用且路由没跑时为真", () => {
  assert.equal(
    routerUnavailable(
      state({
        enabled: false,
        router: { running: false, port: 1, error: "" },
      }),
    ),
    false,
  );
  assert.equal(
    routerUnavailable(
      state({
        enabled: true,
        router: { running: true, port: 1, error: "" },
      }),
    ),
    false,
  );
  assert.equal(
    routerUnavailable(
      state({
        enabled: true,
        router: { running: false, port: 1, protocol: "chat", error: "占用" },
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
            key: "missing",
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
          provider({ id: "b", name: "闲着的", key: "missing", models: [model({ id: "m2" })] }),
        ],
      }),
      1,
    ),
    null,
  );
  assert.equal(enableDisabledReason(state(), 1), null);
});

test("开关禁用原因（R4）：密钥读不出不说「还没有密钥」，点名「X 的密钥不可用」", () => {
  const selected = [model({ id: "m1", selected: true })];
  // 一个能用的都没有、其中有读不出的：先说那几家不可用
  assert.equal(
    enableDisabledReason(
      state({
        providers: [
          provider({ id: "a", name: "锁着的", key: "unreadable", models: selected }),
          provider({ id: "b", name: "空的", key: "missing" }),
        ],
      }),
      1,
    ),
    "锁着的 的密钥不可用",
  );
  // 选了模型的那几家里有读不出的：先说读不出的，不说「还没有密钥」
  assert.equal(
    enableDisabledReason(
      state({
        providers: [
          provider({ id: "a", name: "好的", models: selected }),
          provider({ id: "b", name: "锁着的", key: "unreadable", models: selected }),
          provider({ id: "c", name: "空的", key: "missing", models: selected }),
        ],
      }),
      3,
    ),
    "锁着的 的密钥不可用",
  );
  // 读不出的那家没选模型：不挡路
  assert.equal(
    enableDisabledReason(
      state({
        providers: [
          provider({ id: "a", models: selected }),
          provider({ id: "b", name: "锁着的", key: "unreadable" }),
        ],
      }),
      1,
    ),
    null,
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

// ===== 多家网关：页面读 Codex 那一份的 providers =====

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
    selectedModels(codexGateway(two).providers[1]).map((m) => m.id),
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
    "网页搜索用不了 · 图片要看模型",
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
  assert.equal(restartTip("Codex"), "重启 Codex 桌面应用让改动生效，进行中的对话会中断");
});

test("重启、启动写桌面应用本身的名字（2026-09-30 起 Codex 桌面应用叫 ChatGPT）：重启＝整个应用退出再打开；读不到名字写 Codex", () => {
  const renamed = state({
    codex: {
      version: "0.159.2",
      running: true,
      catalogVersion: "0.159.2",
      drift: false,
      appName: "ChatGPT",
    },
  });
  assert.equal(codexAppName(renamed), "ChatGPT");
  assert.equal(codexAppName(state()), "Codex");
  assert.equal(codexAppName(null), "Codex");
  assert.equal(restartTip("ChatGPT"), "重启 ChatGPT 桌面应用让改动生效，进行中的对话会中断");
  assert.equal(restartConsequence("ChatGPT"), "ChatGPT 会退出再打开，它和终端里 Codex 进行中的对话都会中断");
  assert.equal(restartStillStale("ChatGPT"), "ChatGPT 15 秒内没换上新配置，稍后再试一次");
  assert.equal(launchTip("ChatGPT"), "打开 ChatGPT 桌面应用，它会用上现在的模型设置");
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
  assert.equal(launchTip("Codex"), "打开 Codex 桌面应用，它会用上现在的模型设置");
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
    codexGateway(added.next).providers.map((p) => p.models.map((m) => m.selected)),
    [[true, true], [true]],
  );
  assert.equal(codexGateway(two).providers[0].models[1].selected, false, "不改原状态");

  // 另一家还有生效模型：不是最后一个，开关不动
  const partial = selectModel(two, "a", "m1", false);
  assert.equal(partial.turnsOff, false);
  assert.equal(codexGateway(partial.next).enabled, true);

  // 全部网关加起来一个不剩：等同关掉开关
  const last = selectModel(partial.next, "b", "m1", false);
  assert.equal(last.turnsOff, true);
  assert.equal(codexGateway(last.next).enabled, false);
  assert.equal(totalSelected(last.next), 0);
  // 关掉的预测连路由一起：另一家没开着，路由跟着停
  assert.equal(last.next.router.running, false);
  assert.equal(codexGateway(last.next).codex.wanted, false);

  // 网关本来就关着：去掉最后一个只是去掉
  const closed = withAgentGateway(partial.next, { ...codexGateway(partial.next), enabled: false });
  const off = selectModel(closed, "b", "m1", false);
  assert.equal(off.turnsOff, false);
});

test("路由没在跑：先自愈，自愈过仍没起来才出横幅", () => {
  const down = state({
    enabled: true,
    router: { running: false, port: 1, protocol: "chat", error: "x" },
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
        router: { running: false, port: 1, protocol: "chat", error: "x" },
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

const withSelected = (overrides: Partial<CodexFixture> = {}) => ({
  providers: [provider({ models: [model({ id: "m1", selected: true })] })],
  ...overrides,
});

// Codex 页节头的开关与键位（codexControls：与托盘共用同一份）
const switchProps = (overrides: Partial<CodexFixture> = {}) => ({
  tool: MODELS_TOOLS[0],
  state: state(overrides),
  switching: null as boolean | null,
  busy: false,
  label: "Codex 的第三方模型",
  withFile: true,
  onToggle: noop,
});

const slotProps = (overrides: Partial<CodexFixture> = {}) => ({
  tool: MODELS_TOOLS[0],
  state: state(overrides),
  busy: false,
  phase: { kind: "idle" } as const,
  onRestart: noop,
  onLaunch: noop,
  onDoneDismiss: noop,
  place: "section" as const,
});

test("CodexSwitch：标准开关（旁边不点指示点，开着由刻线说）；开关＝配置里开没开；关着时提示框写打开的结果与改的是哪个文件", () => {
  const on = render(CodexSwitch, switchProps(withSelected({ enabled: true })));
  assert.match(
    on,
    /role="switch" aria-checked="true"[^>]*class="ss-switch ss-switch--regular is-on"/,
  );
  assert.doesNotMatch(on, /ss-indicator/);
  const off = render(CodexSwitch, switchProps(withSelected()));
  assert.match(off, /role="switch" aria-checked="false"/);
  assert.match(
    off,
    /role="tooltip"[^>]*>打开后，选好的模型会出现在 Codex 的模型列表里；会改 ~\/\.codex\/config\.toml 里的一处设置；Sophia 需要保持运行，退出时自动改回官方，下次打开再接上</,
  );
});

test("CodexSwitch 乐观翻转：拨下去写配置期间滑块已在拨过去的那一侧、亮橙；没有待定位置、没有拨开关的确认", () => {
  const on = render(CodexSwitch, {
    ...switchProps(withSelected({ enabled: false })),
    busy: true,
    switching: true,
  });
  assert.match(
    on,
    /role="switch" aria-checked="true"[^>]*class="ss-switch ss-switch--regular is-on"/,
  );
  assert.match(
    on,
    /role="tooltip"[^>]*>关掉后，Codex 只保留官方模型；~\/\.codex\/config\.toml 会恢复原样；Sophia 需要保持运行，退出时自动改回官方，下次打开再接上</,
  );
  const off = render(CodexSwitch, {
    ...switchProps(withSelected({ enabled: true })),
    busy: true,
    switching: false,
  });
  assert.match(off, /role="switch" aria-checked="false"/);
  assert.doesNotMatch(on + off, /data-pending|ss-pending-switch/);
  const src = withCopy(readFileSync(new URL("../src/ModelsTab.tsx", import.meta.url), "utf8"));
  assert.doesNotMatch(src, /PendingSwitch|pending=\{|confirmSwitch|gatewayConfirmText|重启并/);
});

test("CodexSwitch 没有网关 / 没选模型：开关禁用，按下即出「先加一家网关、选好模型再打开」", () => {
  const html = render(CodexSwitch, switchProps({ providers: [] }));
  assert.match(
    html,
    /role="switch" aria-checked="false"[^>]*title="先加一家网关、选好模型再打开" disabled=""/,
  );
  assert.match(
    render(CodexSwitch, switchProps()),
    /title="先加一家网关、选好模型再打开" disabled=""/,
  );
});

test("CodexSwitch 拨开关之后：开关原位锁住（过了 0.3 秒门槛换成转圈 +「正在添加」），不画成禁用", () => {
  const html = render(CodexSwitch, {
    ...switchProps(withSelected({ enabled: false })),
    busy: true,
    switching: true,
  });
  assert.match(
    html,
    /class="codex-switch"><span class="ss-locked" aria-busy="true">[^]*role="switch" aria-checked="true"/,
  );
  assert.doesNotMatch(html, /title="正在处理上一步"/);
  assert.doesNotMatch(html, /ss-spinner/);
});

test("CodexKeySlot（节头里开关右边 12）：待重启出紧凑键「重启生效」（与 卸下后台服务 同位同高），提示框写后果与代价、左对齐键", () => {
  const html = render(
    CodexKeySlot,
    slotProps(withSelected({ enabled: true, needsCodexRestart: true })),
  );
  assert.match(html, /class="ss-btn ss-btn--compact"[^>]*>重启生效</);
  assert.match(html, /role="tooltip"[^>]*>重启 Codex 桌面应用让改动生效，进行中的对话会中断</);
  assert.equal(
    render(
      CodexKeySlot,
      slotProps(
        withSelected({
          enabled: true,
          codex: { version: "26.0", running: true, catalogVersion: "1", drift: false },
        }),
      ),
    ),
    "",
    "没有要生效的改动、Codex 在跑：这一位空着",
  );
  // 键紧跟开关：节头里提示框左对齐键、✓ 已生效浮在键原位下方左对齐（托盘里右沿对齐开关）
  assert.match(html, /class="ss-tip ss-tip--bottom ss-tip--nowrap"/);
  const src = withCopy(readFileSync(new URL("../src/codexControls.tsx", import.meta.url), "utf8"));
  assert.match(
    src,
    /<FloatingToast align=\{place === "section" \? "start" : "end"\} anchor=\{doneAnchor\}>/,
  );
});

test("第三方模型节头：开关紧跟节名，开关右边 12 是 重启生效 / 启动 Codex / 卸下后台服务（同一位）；重启确认在窗口正中", () => {
  const src = withCopy(readFileSync(new URL("../src/ModelsTab.tsx", import.meta.url), "utf8"));
  assert.doesNotMatch(src, /PageHeadActions|models-headctl|uninstallKey/);
  assert.match(src, /control=\{[^]*<CodexSwitch[^]*actions=\{[^]*<CodexKeySlot[^]*place="section"/);
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

test("CodexKeySlot 重启中：0.3 秒门槛之前键照旧、点不动；已生效：键的原位下方浮起白窗", () => {
  const busyHtml = render(CodexKeySlot, {
    ...slotProps(withSelected({ enabled: true, needsCodexRestart: true })),
    phase: { kind: "restarting" },
  });
  assert.match(busyHtml, /^<span class="ss-locked" aria-busy="true">[^]*重启生效<\/button>/);
  assert.doesNotMatch(busyHtml, /ss-spinner/);
  // 忙碌走组件库唯一的 0.3 秒门槛（BusySlot），不再自拼刻度 + 文字
  const src = withCopy(readFileSync(new URL("../src/codexControls.tsx", import.meta.url), "utf8"));
  assert.match(
    src,
    /<BusySlot\s+busy\s+label=\{\s*restarting\s*\?\s*t\("正在重启 \{app\}", \{ app \}\)\s*:\s*t\("正在启动 \{app\}", \{ app \}\)\s*\}/,
  );
  assert.doesNotMatch(src, /useBusyShown|Spinner/);
  const doneHtml = render(CodexKeySlot, {
    ...slotProps(withSelected({ enabled: true })),
    phase: { kind: "done" },
  });
  assert.match(
    doneHtml,
    /class="codex-key__spot"><span class="ss-floattoast__probe" hidden=""><\/span><div class="ss-floattoast"/,
  );
  assert.match(doneHtml, /ss-toast--routine[^]*已生效/);
});

test("CodexKeySlot 启动 Codex：开着、Codex 没在跑才出键，提示框写结果；关着不出", () => {
  const html = render(CodexKeySlot, {
    ...slotProps(withSelected({ enabled: true })),
    onLaunch: noop,
  });
  assert.match(html, />启动 Codex<\/button>/);
  assert.match(html, /role="tooltip"[^>]*>打开 Codex 桌面应用，它会用上现在的模型设置</);
  assert.doesNotMatch(
    render(CodexKeySlot, { ...slotProps(withSelected()), onLaunch: noop }),
    /启动 Codex/,
  );
  const launching = render(CodexKeySlot, {
    ...slotProps(withSelected({ enabled: true })),
    onLaunch: noop,
    phase: { kind: "launching" },
  });
  assert.match(launching, /ss-locked" aria-busy="true"[^]*启动 Codex<\/button>/);
  const launched = render(CodexKeySlot, {
    ...slotProps(withSelected({ enabled: true })),
    onLaunch: noop,
    phase: { kind: "launched" },
  });
  assert.match(launched, /codex-key__spot[^]*ss-toast--routine[^]*已启动/);
});

test("InUseRow：开着写「在用」、关着写「已选」；片可 ×；一个都没选时整行不出", () => {
  const sel = withSelected();
  const on = render(InUseRow, { state: state({ ...sel, enabled: true }), onRemove: noop });
  assert.match(on, /ss-chiprow__label">在用</);
  assert.match(on, /class="ss-modelchip" title="gpt-x"[^]*ss-modelchip__remove/);
  const off = render(InUseRow, { state: state(sel), onRemove: noop });
  assert.match(off, /ss-chiprow__label">已选</);
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

test("行名与行尾 id：有友好名写友好名；没有就写完整 id（和手动填的一致，2026-10-06）；网关把 id 填进显示名不算友好名", () => {
  const named = model({
    id: "deepseek/deepseek-chat",
    slug: "g-deepseek/deepseek-chat",
    displayName: "DeepSeek V3.2",
  });
  assert.equal(modelRowLabel(named), "DeepSeek V3.2");
  assert.equal(modelRowId(named), "deepseek/deepseek-chat");
  const kimi = model({ id: "moonshotai/kimi-k2-0905", slug: "g-x", displayName: "Kimi K2" });
  assert.equal(modelRowId(kimi), null);
  const bare = model({
    id: "default-azure-gpt-4.1",
    slug: "g-default-azure-gpt-4.1",
    displayName: "default-azure-gpt-4.1",
  });
  assert.equal(modelRowLabel(bare), "default-azure-gpt-4.1");
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
  assert.match(html, /model-list__search"><label class="ss-textfield ss-textfield--search"/);
  // 批量不闪、不依次点亮（DESIGN 2026-09-24）：行上没有逐个闪的动画
  assert.doesNotMatch(html, /is-flash|animation-delay/);
  assert.equal((html.match(/ss-checkrow__trailing"><span class="ss-mono/g) ?? []).length, 1);
  // 模型 id 能选中拷走（D23）：等宽读数 Mono，放不下截断
  assert.match(html, /class="ss-mono ss-selectable ss-mono--truncate">deepseek\/deepseek-chat</);
  // 筛选框写出这一家有几个模型；每行是勾选行（14 方框，全应用同一个记号），行尾不写网关短名
  assert.match(html, /placeholder="筛选 10 个模型"/);
  assert.equal((html.match(/class="ss-checkrow ss-checkrow--list"/g) ?? []).length, 10);
  assert.match(html, /role="checkbox" aria-checked="false" aria-label="DeepSeek V3\.2"/);
  // 放大镜是组件库那一枚，页面里不再自画
  const tsx = withCopy(readFileSync(new URL("../src/ModelList.tsx", import.meta.url), "utf8"));
  assert.doesNotMatch(tsx, /<svg|ss-checkbox|CheckboxGlyph/);
  assert.doesNotMatch(html, /models-option__gateway/);
});

test("resolveManual（#117）：手动填的 id 先按完整 id 对、再按去掉前缀的那一截对；撞上几家交回完整 id；对不上为 none", () => {
  const p = provider({ id: "g", name: "g" });
  const entries = [
    { provider: p, model: model({ id: "weibo/glm-5.3", displayName: "weibo/glm-5.3" }) },
    { provider: p, model: model({ id: "thudm/glm-5", displayName: "thudm/glm-5" }) },
    { provider: p, model: model({ id: "weibo/glm-5", displayName: "weibo/glm-5" }) },
  ];
  const one = (typed: string) => {
    const m = resolveManual(entries, typed);
    return m.kind === "one" ? m.entry.model.id : m.kind;
  };
  assert.equal(one("glm-5.3"), "weibo/glm-5.3");
  assert.equal(one("WEIBO/GLM-5.3"), "weibo/glm-5.3");
  assert.equal(one("thudm/glm-5"), "thudm/glm-5");
  assert.deepEqual(resolveManual(entries, "glm-5"), { kind: "many", ids: ["thudm/glm-5", "weibo/glm-5"] });
  assert.equal(one("glm-9"), "none");
  assert.equal(one("  "), "none");
});

test("prefixExample：没带前缀、这家过半带前缀时挑去前缀后最像的一个当例子；否则为 null", () => {
  const p = provider({ id: "g", name: "g" });
  const e = (id: string) => ({ provider: p, model: model({ id, displayName: id }) });
  const list = [e("azure/gpt-4.1"), e("weibo/glm-5"), e("thudm/glm-4.7"), e("weibo/kimi-k2.5")];
  assert.equal(prefixExample(list, "glm-5.3"), "weibo/glm-5");
  assert.equal(prefixExample(list, "weibo/glm-5.3"), null, "带了前缀就不是格式问题");
  assert.equal(prefixExample([e("glm-5"), e("kimi-k2"), e("a/b")], "glm-5.3"), null, "这家多半不带前缀");
  assert.equal(prefixExample([], "glm-5.3"), null);
});

test("ModelList 手动添加（#117）：给了 onAddManual 框底出一行输入 + `试一下再加`（没填 id 时不可用、按下说原因）；手动的行尾带 `手动`；取消勾选手动的就从列表移除", () => {
  const p = provider({ id: "g", name: "g" });
  const html = render(ModelList, {
    entries: [
      { provider: p, model: model({ id: "a/x", displayName: "a/x", selected: true, manual: true }) },
      { provider: p, model: model({ id: "a/y", displayName: "a/y" }) },
    ],
    onToggle: noop,
    onAddManual: async () => {},
  });
  assert.match(html, /model-list__manual-row"><label class="ss-textfield[^>]*>[^]*?placeholder="手动添加模型：填模型 id"/);
  assert.match(html, /title="先填模型 id" disabled=""[^>]*>试一下再加</);
  assert.match(html, /model-list__trail"><span class="ss-tag ss-tag--weak">手动<\/span>/);
  assert.equal((html.match(/>手动</g) ?? []).length, 1);
  // 不给 onAddManual 就没有这一行
  assert.doesNotMatch(render(ModelList, { entries: [], onToggle: noop }), /model-list__manual/);

  const st = state({
    providers: [
      provider({
        id: "g",
        models: [model({ id: "a/x", selected: true, manual: true }), model({ id: "a/y", selected: true })],
      }),
    ],
  });
  const { next } = selectModel(st, "g", "a/x", false);
  assert.deepEqual(
    codexGateway(next).providers[0].models.map((m) => m.id),
    ["a/y"],
    "手动的取消勾选就移除",
  );
  const { next: kept } = selectModel(st, "g", "a/y", false);
  assert.equal(codexGateway(kept).providers[0].models.length, 2, "网关列表里的照旧留着");
});

test("ModelList：网关给了上下文长度就在行尾写读数（`1M`），在 id 前、不截；没给就不写", () => {
  const p = provider({ id: "g", models: [] });
  const html = render(ModelList, {
    entries: [
      {
        provider: p,
        model: model({ id: "a/long", displayName: "a/long", contextWindow: 1048576 }),
      },
      { provider: p, model: model({ id: "a/plain", displayName: "a/plain" }) },
    ],
    onToggle: noop,
  });
  assert.match(html, /model-list__trail"><span class="model-list__context">1M<\/span>/);
  assert.equal((html.match(/model-list__context/g) ?? []).length, 1);
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
  assert.equal((html.match(/role="checkbox"/g) ?? []).length, 9);
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
  const src = withCopy(readFileSync(new URL("../src/modelsView.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(src, /HOST_LIKE|function hostOf/, "界面不再自己从主机名取短名");
});

test("模型列表：底部不再有「已选 N 个模型」；滚动区包在组件库的渐隐外层里（纵向 flex，外层压矮时滚动区跟着变矮）", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/ModelList.css", import.meta.url), "utf8");
  const rule = (sel: string) =>
    new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  const html = render(ModelList, { entries: [pe("azure/a", true)], onToggle: noop });
  assert.doesNotMatch(html, /model-list__foot/);
  assert.doesNotMatch(css, /model-list__foot/);
  // 渐隐：量用 useEdgeFades、画用 FadeViewport（ss-layer__viewport 是纵向 flex、min-height 0），页面不再自写
  assert.match(
    html,
    /<div class="ss-layer__viewport"><div class="model-list__scroll" role="group"/,
  );
  assert.doesNotMatch(css, /::before|::after|linear-gradient/);
  const tsx = withCopy(readFileSync(new URL("../src/ModelList.tsx", import.meta.url), "utf8"));
  assert.match(tsx, /const fade = useEdgeFades\(scrollRef\);/);
  assert.match(rule(".model-list__scroll"), /min-height:\s*0/);
  // 行尾网关短名随汇总下拉删掉（每个列表只列一家）；组头计数 tabular、不用等宽（一种数字）
  assert.doesNotMatch(css, /models-option__gateway/);
  assert.match(rule(".model-list__count"), /font-variant-numeric:\s*tabular-nums/);
  assert.doesNotMatch(rule(".model-list__count"), /font-mono/);
});

test("predictEnabled：先画做成之后的样子（Codex 没在跑时删掉最后一个模型那一支）——开时路由在跑、关时路由停了，提示不闪", () => {
  const router = state().router;
  const on = predictEnabled(state({ enabled: false, router: { ...router, running: false } }), true);
  assert.equal(codexGateway(on).enabled, true);
  assert.equal(codexGateway(on).codex.wanted, true);
  assert.equal(routerUnavailable(on), false);
  const off = predictEnabled(state({ enabled: true, router: { ...router, running: true } }), false);
  assert.equal(codexGateway(off).enabled, false);
  assert.equal(off.router.running, false);
});

test("settleAfterRestart：发完结束信号等旧进程退——先读到旧配置不算失败，等到换上才算成；等满才说没换上", async () => {
  const stale = state({ needsCodexRestart: true });
  const fresh = state({ needsCodexRestart: false });
  const timing = { timeoutMs: 1000, pollMs: 1 };
  const seen: boolean[] = [];
  const reads = [stale, stale, fresh];
  const ok = await settleAfterRestart(
    async () => reads.shift() ?? fresh,
    (s) => seen.push(codexGateway(s).codex.needsRestart),
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
  assert.equal(never, restartStillStale("Codex"), "状态里没写应用名时写 Codex");

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
  assert.deepEqual(gatewaySwitchText(true), { busy: "正在添加", failed: "添加到 Codex 失败" });
  assert.deepEqual(gatewaySwitchText(false), { busy: "正在移除", failed: "从 Codex 移除失败" });
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

test("switchGateway 没写成：原因原样返回；打开没成尽力撤回（恢复），关掉没成不反向再启用，都再重读一次画真实状态；撤回也没成就在原因后说一声", async () => {
  const enabled = state({ enabled: true });
  const h = switchIo({ writes: [new Error("配置文件被改过")], reads: [enabled] });
  assert.equal(await switchGateway(false, h.io), "配置文件被改过");
  assert.deepEqual(
    h.calls,
    ["restore", "read"],
    "关掉没成不再启用：那会重启路由、重写设置，看起来就是关不掉",
  );
  assert.equal(h.painted.at(-1), enabled, "开关画成真实状态");

  const both = switchIo({
    writes: [new Error("路由起不来"), new Error("还是起不来")],
    reads: [state()],
  });
  assert.equal(await switchGateway(true, both.io), `路由起不来${switchRollbackFailed()}`);
  assert.equal(switchRollbackFailed(), "；回滚也失败了");
  assert.deepEqual(both.calls, ["enable", "restore", "read"]);
});

test("switchGateway 页面没了：返回 undefined，不再画（调用方什么都别做）", async () => {
  const on = state({ enabled: true });
  const gone = switchIo({ writes: [on], reads: [on], alive: () => false });
  assert.equal(await switchGateway(true, gone.io), undefined);
  assert.deepEqual(gone.painted, [], "页面没了不再画");
});

test("开关拨了就写：第三方模型节拨开关直接走 switchGateway（不确认、不重启），不经勾选的写队列；去掉最后一个模型也直接关", () => {
  const src = withCopy(readFileSync(new URL("../src/ModelsTab.tsx", import.meta.url), "utf8"));
  assert.doesNotMatch(src, /predictEnabled|toggleGateway|requestSwitch|runSwitch/);
  assert.match(src, /onToggle=\{\(next\) => void toggleSwitch\(next\)\}/);
  assert.match(src, /failure = await switchGateway\(next, \{/);
  assert.doesNotMatch(src, /turnsOff && base\.codex\.running/);
  assert.doesNotMatch(src, /const pending =/);
  // D5：不再有网关二级页、配置网关、汇总下拉
  assert.doesNotMatch(src, /GatewayPage|配置网关|ModelPicker|ModelBox/);
});

test("codexKeyKind：开关旁那一位一次只放一颗——等重启 > Codex 没在跑（开着）；关着不出键（没有后台服务可卸）；忙的时候不出键", () => {
  const idle = { kind: "idle" } as const;
  const router = { running: true, port: 1, error: "" };
  const running = { version: "26.0", running: true, catalogVersion: "1", drift: false };
  assert.equal(codexKeyKind(state({ enabled: true, needsCodexRestart: true }), idle), "restart");
  assert.equal(codexKeyKind(state({ enabled: true }), idle), "launch");
  assert.equal(codexKeyKind(state({ enabled: false, router }), idle), null);
  // 关着、等着重启：出重启
  assert.equal(
    codexKeyKind(state({ enabled: false, router, needsCodexRestart: true }), idle),
    "restart",
  );
  assert.equal(codexKeyKind(state({ enabled: true, codex: running }), idle), null);
  assert.equal(
    codexKeyKind(state({ enabled: false, router }), { kind: "switching", next: true }),
    null,
    "拨开关写配置期间：写完才知道要不要重启",
  );
  assert.equal(
    codexKeyKind(state({ enabled: true, needsCodexRestart: true }), { kind: "restarting" }),
    null,
  );
});

test("Codex 能力控件只有一份：Codex 页节头与托盘能力行都用 codexControls，不再各写开关三态与键位", () => {
  const page = withCopy(readFileSync(new URL("../src/ModelsTab.tsx", import.meta.url), "utf8"));
  const tray = withCopy(readFileSync(new URL("../src/TrayModelsRow.tsx", import.meta.url), "utf8"));
  for (const src of [page, tray]) {
    assert.match(src, /from "\.\/codexControls\.tsx"/);
    assert.match(src, /<CodexSwitch/);
    assert.match(src, /<CodexKeySlot/);
    assert.doesNotMatch(src, /<Switch\b|uninstall|launchTip|restartTip|useBusyShown/);
  }
  // 页面文件里不再写组件库的内部类
  for (const file of [
    "ModelsTab.tsx",
    "ModelsTab.css",
    "ModelsGateways.tsx",
    "ModelList.tsx",
    "ModelList.css",
  ]) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\bss-[a-z]/, file);
    assert.doesNotMatch(src, /<svg/, file);
  }
});

// ===== 两家（spec 2026-09-29 R40 R41 R43 R46）=====

/// Claude 那一份：开着 / 关着，带几家网关
const claude = (enabled: boolean, providers: GatewayProvider[] = []) => ({
  ...CLAUDE_OFF,
  installed: true,
  enabled,
  providers,
});

test("R46 路由两家共用：只有 Claude 开着时路由没在跑也要说；关掉 Codex 而 Claude 开着时不把路由画成停了", () => {
  const down = { running: false, port: 1, error: "" };
  const up = { running: true, port: 1, error: "" };
  const claudeOn = state({ enabled: false, router: down, claude: claude(true) });
  assert.equal(anyGatewayOn(claudeOn), true);
  assert.equal(routerUnavailable(claudeOn), true);
  assert.equal(showRouterTodo(claudeOn, true), true);
  assert.equal(anyGatewayOn(state({ enabled: false })), false);
  // 关掉 Codex、Claude 还开着：路由留着（R8），预测不把它画成停了
  const off = predictEnabled(state({ enabled: true, router: up, claude: claude(true) }), false);
  assert.equal(codexGateway(off).enabled, false);
  assert.equal(off.router.running, true);
  assert.equal(
    codexKeyKind(state({ enabled: false, router: up, claude: claude(true) }), { kind: "idle" }),
    null,
  );
  // Claude 拨关了、等重启生效（桌面应用里还写着 Sophia）：仍在用路由，路由停了照样提醒
  const pendingOff = {
    ...claude(false),
    claude: {
      ...CLAUDE_OFF.claude!,
      desktop: { ...CLAUDE_OFF.claude!.desktop, applied: true, pending: true, needsRestart: true },
    },
  };
  assert.equal(
    routerUnavailable(state({ enabled: false, router: down, claude: pendingOff })),
    true,
  );
  // 打开 Codex 的预测不动 Claude 那一份
  const on = predictEnabled(state({ enabled: false, claude: claude(true) }), true);
  assert.equal(on.agents.find((a) => a.agent === "claude")?.enabled, true);
});

test("列表行上 Codex 开关按不动的原因：说「怎么办」——没选模型 `先进去选好模型再打开`，被 agents-manager 管着 `进去接管后才能打开`；开着永远能关", () => {
  assert.equal(codexListSwitchReason(state({ providers: [] })), "先进去选好模型再打开");
  assert.equal(codexListSwitchReason(state()), "先进去选好模型再打开");
  assert.equal(
    codexListSwitchReason(state({ takeover: { baseUrl: "https://x", selectedCount: 1 } })),
    "进去接管后才能打开",
  );
  const picked = [provider({ models: [model({ selected: true })] })];
  assert.equal(codexListSwitchReason(state({ providers: picked })), null);
  assert.equal(codexListSwitchReason(state({ providers: [], enabled: true })), null);
  // 别的原因（冲突、缺密钥）照原话
  assert.equal(
    codexListSwitchReason(
      state({ providers: [provider({ key: "missing", models: [model({ selected: true })] })] }),
    ),
    "请先保存网关密钥",
  );
});

test("同一地址（R40）：scheme、host（小写）、port、path 相同；末尾斜杠、默认端口不算不同；读不出的地址不算同一处", () => {
  assert.equal(sameAddress("https://AP.example.com/v1/", "https://ap.example.com/v1"), true);
  assert.equal(sameAddress("https://ap.example.com:443/v1", "https://ap.example.com/v1"), true);
  assert.equal(sameAddress("https://ap.example.com/v1", "https://ap.example.com/v2"), false);
  assert.equal(sameAddress("https://ap.example.com/v1", "http://ap.example.com/v1"), false);
  assert.equal(sameAddress("https://ap.example.com:8443/v1", "https://ap.example.com/v1"), false);
  assert.equal(sameAddress("", ""), false);
  assert.equal(sameAddress("ap.example.com", "ap.example.com"), false);
  assert.equal(otherAgent("codex"), "claude");
  assert.equal(otherAgent("claude"), "codex");
});

const apC = provider({
  id: "ap",
  name: "ap-gateway",
  shortName: "ap-gateway",
  baseUrl: "https://ap.example.com/v1",
});

test("表单里同步那一行（R43）：新建 `也加到 Claude`（另一家已有同一地址时不出）；编辑按改之前的地址找另一家 `Claude 里的 ap-gateway 一起改`（没有就不出）", () => {
  const other = { name: "Claude", providers: [apC] };
  assert.equal(syncCheckLabel(null, "", other), "也加到 Claude");
  assert.equal(syncCheckLabel(null, "https://api.deepseek.com", other), "也加到 Claude");
  assert.equal(syncCheckLabel(null, "https://ap.example.com/v1/", other), null);
  const mine = provider({ id: "x", baseUrl: "https://ap.example.com/v1" });
  // 编辑：按改之前的地址（表单里正在改成别的也照样找得到）
  assert.equal(
    syncCheckLabel(mine, "https://new.example.com", other),
    "Claude 里的 ap-gateway 一起改",
  );
  assert.equal(syncCheckLabel(provider({ baseUrl: "https://z.example.com" }), "", other), null);
  // 另一家不在（没有 Claude 这一项）：不出
  assert.equal(syncCheckLabel(null, "", null), null);
  assert.equal(syncCheckLabel(null, "", { name: "Codex", providers: [] }), "也加到 Codex");
});

test("删网关确认的正文随勾选变（R43）：不勾说另一家不受影响；勾上两家都删，另一家还选着它的模型时接一句；另一家没有同一地址时照原来一句、不出勾选", () => {
  const mine = provider({ id: "ap", name: "ap-gateway", baseUrl: "https://ap.example.com/v1" });
  const pickedC = { ...apC, models: [model({ selected: true }), model({ id: "b" })] };
  const other = { name: "Claude", providers: [pickedC] };
  assert.deepEqual(removeConfirmText(mine, other, false), {
    body: "地址和这里的密钥一起删掉，删除后无法恢复；Claude 里的 ap-gateway 不受影响",
    also: "同时删掉 Claude 里的 ap-gateway",
  });
  assert.deepEqual(removeConfirmText(mine, other, true), {
    body: "两家的地址和密钥都删掉，删除后无法恢复；Claude 选的 1 个模型会一起移除",
    also: "同时删掉 Claude 里的 ap-gateway",
  });
  assert.equal(
    removeConfirmText(mine, { name: "Claude", providers: [apC] }, true).body,
    "两家的地址和密钥都删掉，删除后无法恢复",
  );
  const plain = { body: "地址和密钥一起删掉，删除后无法恢复", also: null };
  assert.deepEqual(removeConfirmText(mine, { name: "Claude", providers: [] }, false), plain);
  assert.deepEqual(removeConfirmText(mine, null, true), plain);
});

test("手动重新拉取后键下那一句：有变化写新增 / 少了几个，没变化写没有变化", () => {
  const m = (id: string) => model({ id });
  // 主句是提示条的整句键（`sentence`），读数接在 `trail`
  const said = (r: { sentence: string; trail: string[] }) => ({
    verb: copy(r.sentence),
    trail: r.trail,
  });
  assert.deepEqual(said(refetchSummary(["a", "b"], [m("a"), m("b")])), {
    verb: "已拉取",
    trail: ["没有变化"],
  });
  assert.deepEqual(said(refetchSummary(["a", "b"], [m("a"), m("c"), m("d")])), {
    verb: "已更新",
    trail: ["新增 2 个", "少了 1 个"],
  });
  assert.deepEqual(said(refetchSummary([], [m("a")])), { verb: "已更新", trail: ["新增 1 个"] });
});

test("上下文长度读数：整除 1024 按二进制写、否则按十进制；网关没给不写", () => {
  assert.equal(contextLabel(1048576), "1M");
  assert.equal(contextLabel(1_000_000), "1M");
  assert.equal(contextLabel(2_000_000), "2M");
  assert.equal(contextLabel(131072), "128K");
  assert.equal(contextLabel(200_000), "200K");
  assert.equal(contextLabel(163840), "160K");
  assert.equal(contextLabel(128_000), "128K", "整千按十进制，不因整除 1024 写成 125K");
  assert.equal(contextLabel(256_000), "256K");
  assert.equal(contextLabel(999_999), "1M");
  assert.equal(contextLabel(null), null);
  assert.equal(contextLabel(undefined), null);
  assert.equal(contextLabel(0), null);
});

test("按名字猜不能对话的模型（向量、重排、语音、审核、画图）挪到列表最后一组「可能不是对话模型」，不藏", () => {
  for (const id of [
    "chatglm/chatglm-embedding",
    "openai/text-embedding-3-large",
    "bge-reranker-v2",
    "openai/gpt-4o-mini-tts",
    "openai/whisper-1",
    "omni-moderation-latest",
    "openai/dall-e-3",
  ]) {
    assert.equal(likelyNonChat(id), true, id);
  }
  for (const id of [
    "weibo/glm-5",
    "moonshot/kimi-k2.5",
    "deepseek/deepseek-chat",
    "openai/gpt-4.1",
  ]) {
    assert.equal(likelyNonChat(id), false, id);
  }
  const p = provider({ id: "ap" });
  const entries = ["chatglm/chatglm-embedding", "weibo/glm-5", "chatglm/glm-4-9b-chat"].map(
    (id) => ({
      provider: p,
      model: model({ id, displayName: id }),
    }),
  );
  const groups = frozenGroups(entries, snapshotOrder(entries));
  assert.deepEqual(
    groups.map((g) => [g.vendor, g.entries.map((e) => e.model.id)]),
    [
      ["chatglm", ["chatglm/glm-4-9b-chat"]],
      ["weibo", ["weibo/glm-5"]],
      [nonChatGroup(), ["chatglm/chatglm-embedding"]],
    ],
  );
});

test("同一家里同一地址只能有一个网关：地址撞上别的网关（末尾斜杠、默认端口、主机大小写不算不同）就是它；改自己不算、地址不同不算", () => {
  const or = provider({
    id: "or",
    baseUrl: "https://openrouter.ai/api/v1",
    shortName: "openrouter",
  });
  const ap = provider({
    id: "ap",
    baseUrl: "https://ap-gateway.example/openai",
    shortName: "ap-gateway",
  });
  assert.equal(addressTakenBy([ap, or], "https://OpenRouter.ai:443/api/v1/", undefined), or);
  assert.equal(addressTakenBy([ap, or], "https://openrouter.ai/api/v1", "or"), null, "改自己不算");
  assert.equal(
    addressTakenBy([ap, or], "https://ap-gateway.example/openai", "or"),
    ap,
    "改成别的网关的地址",
  );
  assert.equal(addressTakenBy([ap, or], "https://openrouter.ai/api/v2", undefined), null);
  const dup = provider({
    id: "or-2",
    baseUrl: "https://openrouter.ai/api/v1",
    shortName: "openrouter",
  });
  assert.equal(
    addressTakenBy([or, dup], "https://openrouter.ai/api/v1", "or-2"),
    null,
    "已有的重复：地址不改照常能存",
  );
  assert.equal(addressTakenBy([ap, or], "openrouter", undefined), null, "读不出的地址不算");
  assert.equal(addressTakenText(or), "这个地址已经加过了 · openrouter");
});

test("带过来的空态（R43）：这一家没有网关、另一家有时 `还没有网关 · Codex 里有 ap-gateway、openrouter`；另一家也没有时为 null（照旧「还没有网关，先加一家」）", () => {
  const or = provider({ id: "or", name: "", shortName: "openrouter" });
  assert.equal(
    copyEmptyText({ name: "Codex", providers: [apC, or] }),
    "还没有网关 · Codex 里有 ap-gateway、openrouter",
  );
  const or2 = provider({ id: "or-2", name: "", shortName: "openrouter" });
  assert.equal(
    copyEmptyText({ name: "Codex", providers: [apC, or, or2] }),
    "还没有网关 · Codex 里有 ap-gateway、openrouter",
    "同名的两家只写一次",
  );
  assert.equal(copyEmptyText({ name: "Codex", providers: [] }), null);
  assert.equal(copyEmptyText(null), null);
});

test("删不得的网关按这一家算（R43：每家各管自己的网关）：Claude 开着、这是它最后一家供模型的，原因写 Claude 的名字；Codex 那边不受影响", () => {
  const picked = provider({ id: "ap", models: [model({ selected: true })] });
  const s = state({ enabled: false, claude: claude(true, [picked]) });
  const tool = { ...MODELS_TOOLS[0], id: "claude-code", name: "Claude" };
  assert.equal(
    removeProviderBlockedReason(s, picked, tool, "claude"),
    "Claude 还在用它的 1 个模型，先关掉第三方模型再删",
  );
  assert.equal(removeProviderBlockedReason(s, picked, MODELS_TOOLS[0], "codex"), null);
});
