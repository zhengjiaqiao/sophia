import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { render } from "./ui-render.ts";
import {
  claudeAccountCost,
  CLAUDE_MODELS_NAME,
  claudeLaunchTip,
  claudeLimitations,
  claudeRestartTip,
  CLAUDE_TOOL,
  claudeTradeoff,
  claudeHeadIssue,
  claudePicked,
  claudeRestartConsequence,
  claudeSelectModel,
  claudeShouldPoll,
  claudeSwitchReason,
  claudeSwitchText,
  claudeSwitchTip,
  claudeTodos,
  claudeViaRestart,
} from "../src/claudeView.ts";
import {
  enableNeedsModels,
  listNeedsModels,
  listNeedsTakeover,
  modelsCapability,
} from "../src/modelsView.ts";
import type { AgentState } from "../src/shell/agentRegistry.ts";
import { claudeGateway } from "../src/types.ts";
import type {
  AgentGatewayView,
  GatewayClaudeDesktop,
  GatewayProvider,
  GatewayProviderModel,
  GatewayState,
} from "../src/types.ts";
import { CLAUDE_OFF, gatewayFixture } from "./gateway-fixture.ts";

// Claude 的页（spec 2026-09-29 R42 Claude 部分、AC43；DESIGN「Claude 的页：桌面应用」「每家的页（推入页，共同骨架）」）

const page = await import("../src/ClaudeModelsPage.tsx");

const noop = () => undefined;

const model = (id: string, selected: boolean, slug = `ap-${id}`): GatewayProviderModel => ({
  id,
  slug,
  displayName: id,
  selected,
});

const provider = (overrides: Partial<GatewayProvider> = {}): GatewayProvider => ({
  id: "ap",
  name: "ap-gateway",
  shortName: "ap-gateway",
  baseUrl: "https://ap.example.com/v1",
  protocol: "chat",
  hasKey: true,
  models: [model("kimi-k2.5", true), model("glm-5", false)],
  ...overrides,
});

/// Claude 那一份：默认装着、没在跑、关着、一家网关选了 kimi-k2.5
const claude = (
  overrides: Partial<AgentGatewayView> = {},
  desktop: Partial<GatewayClaudeDesktop> = {},
): AgentGatewayView => ({
  ...CLAUDE_OFF,
  installed: true,
  providers: [provider()],
  ...overrides,
  claude: {
    ...CLAUDE_OFF.claude!,
    desktop: { ...CLAUDE_OFF.claude!.desktop, version: "1.2.0", ...desktop },
  },
});

const stateWith = (
  view: AgentGatewayView,
  router = { installed: true, running: true, port: 47328, error: "" },
): GatewayState =>
  gatewayFixture({
    supported: true,
    providers: [],
    enabled: false,
    needsCodexRestart: false,
    router,
    codex: { version: "26.0", running: true, catalogVersion: "1", drift: false },
    conflict: "",
    takeover: null,
    claude: view,
  });

const viewOf = (view: AgentGatewayView) => claudeGateway(stateWith(view))!;
const agentState = (g: GatewayState | null): AgentState => ({
  gateway: g,
  modelsSupported: true,
  usage: null,
});

// ===== 开关的禁用原因：三处（页里、列表行、托盘）各说各的下一步 =====

// 2026-09-30 侧栏「模型」改名「第三方模型」：托盘那一句指的页随之改名
test("R41 R42 开关按不动：没装 / 受管 / 太旧说「怎么办」；别家配置在生效——页里 `接管后才能打开`、列表行 `进去接管后才能打开`、托盘 `在模型页里接管后才能打开`", () => {
  const reason = (view: AgentGatewayView, place?: "page" | "list" | "tray") =>
    claudeSwitchReason(viewOf(view), place);
  assert.equal(reason(claude({ installed: false })), "装好 Claude 桌面应用后再来打开");
  assert.equal(
    reason(claude({}, { managed: true })),
    "这台电脑上的 Claude 由组织统一配置，不能在这里切换",
  );
  assert.equal(reason(claude({}, { tooOld: true })), "先把 Claude 更新到最新版");
  const foreign = claude({}, { foreign: { id: "x" } });
  assert.equal(reason(foreign), "接管后才能打开");
  assert.equal(reason(foreign, "list"), listNeedsTakeover());
  assert.equal(listNeedsTakeover(), "进去接管后才能打开");
  assert.equal(reason(foreign, "tray"), "在模型页里接管后才能打开");
  // 没选模型：页里与托盘说 `先加一家网关、选好模型再打开`，列表行说 `先进去选好模型再打开`
  assert.equal(reason(claude({ providers: [] })), enableNeedsModels());
  assert.equal(reason(claude({ providers: [] }), "tray"), enableNeedsModels());
  assert.equal(reason(claude({ providers: [] }), "list"), listNeedsModels());
  assert.equal(
    reason(claude({ providers: [provider({ models: [model("x", false)] })] }), "list"),
    listNeedsModels(),
  );
  assert.equal(reason(claude({ providers: [provider({ hasKey: false })] })), "请先保存网关密钥");
  // 能按；开着时永远能关
  assert.equal(reason(claude()), null);
  assert.equal(reason(claude({ enabled: true, installed: false, providers: [] })), null);
});

// ===== 几句 DESIGN 原话：页、列表行、托盘说同一句（定义只在 claudeView） =====

test("R42 R44 文案只有一份：开关提示框两段、重启确认正文按方向、键的提示框、拨开关的忙碌与没成，都在 claudeView；trayView 不再自己写", () => {
  assert.equal(
    claudeSwitchTip(false),
    "打开后，Claude 桌面应用改用这里选的模型，不再登录 Claude 账号；账号里的对话暂时看不到，切回即恢复。要重开 Claude 才生效",
  );
  assert.equal(
    claudeSwitchTip(true),
    "关掉后，Claude 桌面应用回到 Claude 账号；要重开 Claude 才生效",
  );
  assert.match(
    claudeRestartConsequence(true),
    /^Claude 桌面应用会退出再打开，之后改用这里选的模型/,
  );
  assert.match(claudeRestartConsequence(false), /回到 Claude 账号；切换期间的对话留在这台电脑上/);
  assert.equal(claudeLaunchTip(), "打开 Claude 桌面应用，它会用上现在的模型设置");
  assert.equal(claudeRestartTip(), "重启 Claude 桌面应用让改动生效");
  assert.deepEqual(claudeSwitchText(true), { busy: "正在切换", failed: "切到第三方模型失败" });
  assert.deepEqual(claudeSwitchText(false), { busy: "正在切回", failed: "切回 Claude 账号失败" });
  const tray = readFileSync(new URL("../src/trayView.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    tray,
    /要重开 Claude 才生效|会退出再打开|它会用上现在的模型设置|进去接管后才能打开/,
  );
  const row = readFileSync(new URL("../src/TrayClaudeRow.tsx", import.meta.url), "utf8");
  assert.match(row, /from "\.\/claudeView\.ts"/);
  assert.match(row, /claudeSwitchTip|claudeRestartConsequence/);
});

test("R42 网关抽屉里的限制说明（DESIGN 原话）；网关区块的这一家叫模型页里的名字 `Claude Desktop`", () => {
  assert.equal(
    claudeLimitations(),
    "切过去后没有语音、手机端和 claude.ai 的连接器 · 联网搜索要看模型服务商 · 第一次用 Cowork 要下载 1GB 以上的组件",
  );
  assert.equal(CLAUDE_TOOL.name, "Claude Desktop");
  assert.equal(CLAUDE_TOOL.limitations, claudeLimitations());
  assert.equal(claudeAccountCost(), "账号里的对话暂时看不到");
});

// ===== 已选、代价句（2026-09-30 起 Sophia 不设默认模型：没有默认用 / 后台任务用、没有对应关系那一句） =====

test("R42 已选：这一家已选的模型，按网关顺序；两家网关撞名时后缀网关短名", () => {
  const view = viewOf(
    claude({
      providers: [
        provider(),
        provider({
          id: "or",
          name: "openrouter",
          shortName: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          models: [model("kimi-k2.5", true, "or-kimi-k2.5"), model("glm-5", true, "or-glm-5")],
        }),
      ],
    }),
  );
  assert.deepEqual(
    claudePicked(view).map((row) => row.label),
    ["kimi-k2.5 · ap-gateway", "kimi-k2.5 · openrouter", "glm-5"],
  );
});

// 2026-09-30：两家能力行都写 `第三方模型`，Claude 共用 modelsView 的 modelsCapability；模型页里第二家叫 `Claude Desktop` 只写在 claudeView 一处
test("R42 代价句（DESIGN 原话）；能力行两家共用一个常量、模型页里的名字只在 claudeView 一处", () => {
  assert.equal(claudeTradeoff(), "切换期间不登录 Claude 账号，账号里的对话暂时看不到，切回即恢复");
  assert.equal(modelsCapability(), "接入第三方模型");
  assert.equal(CLAUDE_MODELS_NAME, "Claude Desktop");
  for (const file of [
    "../src/ClaudeModelsPage.tsx",
    "../src/shell/ModelsPage.tsx",
    "../src/TrayClaudeRow.tsx",
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(src, /桌面应用 · 第三方模型/, file);
  }
  const page = readFileSync(new URL("../src/ClaudeModelsPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /"Claude Desktop"/);
});

// 2026-09-30 Sophia 不设默认模型：去掉「默认用指向的模型被移出已选时先画成已选的第一个」那一半
test("R42 勾选先画：只改这一家这一个模型；开着时去掉最后一个＝关掉", () => {
  const two = [provider({ models: [model("kimi-k2.5", true), model("glm-5", true)] })];
  const state = stateWith(claude({ enabled: true, providers: two }));
  const drop = claudeSelectModel(state, "ap", "glm-5", false);
  assert.equal(drop.turnsOff, false);
  const after = claudeGateway(drop.next)!;
  assert.equal(after.enabled, true);
  assert.deepEqual(
    claudePicked(after).map((row) => row.label),
    ["kimi-k2.5"],
  );
  // Codex 那一份不动；Claude 自己的 profile 清单（后端写的）不在前端先画
  assert.deepEqual(drop.next.agents[0], state.agents[0]);
  assert.deepEqual(after.claude, claudeGateway(state)!.claude);
  const last = claudeSelectModel(drop.next, "ap", "kimi-k2.5", false);
  assert.equal(last.turnsOff, true);
  assert.equal(claudeGateway(last.next)!.enabled, false);
  // 关着时去掉最后一个只是去掉
  const off = claudeSelectModel(stateWith(claude()), "ap", "kimi-k2.5", false);
  assert.equal(off.turnsOff, false);
});

// ===== 行内待办条、页面头下的灰面板、走不走重启 =====

test("R42 AC43 行内待办条：路由没在跑（自愈过一次仍没起来）/ 别家配置在生效 + `接管`（只说主句，不写是谁的配置：DESIGN ① 同一屏不重复）/ 被改掉了 + `重新写入`；没有登录页那一条", () => {
  const kinds = (view: AgentGatewayView, healed = true, running = true) =>
    claudeTodos(stateWith(view, { installed: true, running, port: 1, error: "" }), healed).map(
      (t) => [t.kind, t.message, t.reason, t.label],
    );
  assert.deepEqual(kinds(claude()), []);
  assert.deepEqual(kinds(claude({ enabled: true }), true, false), [
    ["router", "路由没在跑，第三方模型用不了", null, "重启路由"],
  ]);
  assert.deepEqual(kinds(claude({ enabled: true }), false, false), []);
  assert.deepEqual(kinds(claude({}, { foreign: { id: "x" } })), [
    ["takeover", "Claude 桌面应用正在用别的第三方配置", null, "接管"],
  ]);
  assert.deepEqual(kinds(claude({ enabled: true }, { drift: true })), [
    ["rewrite", "Sophia 写进去的设置被改掉了", null, "重新写入"],
  ]);
  const src = readFileSync(new URL("../src/ClaudeModelsPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /登录页/);
});

test("R34 R36 切回没做完：页面头下灰面板 `切回 Claude 账号失败 · 上次没做完`；重新写入与再试一次在桌面应用运行时走重启生效（先确认）", () => {
  assert.equal(claudeHeadIssue(viewOf(claude())), null);
  assert.deepEqual(claudeHeadIssue(viewOf(claude({}, { restoreUnfinished: true }))), {
    message: "切回 Claude 账号失败",
    reason: "上次没做完",
  });
  assert.equal(claudeViaRestart(viewOf(claude({}, { running: true }))), true);
  assert.equal(claudeViaRestart(viewOf(claude())), false);
});

test("R49 键显示着才轻查（用户自己开 / 重开了 Claude，键要自己消失）；忙着时不查", () => {
  assert.equal(claudeShouldPoll(viewOf(claude({ enabled: true })), true), true);
  assert.equal(
    claudeShouldPoll(
      viewOf(claude({}, { running: true, pending: true, needsRestart: true })),
      true,
    ),
    true,
  );
  assert.equal(claudeShouldPoll(viewOf(claude({ enabled: true })), false), false);
  assert.equal(claudeShouldPoll(viewOf(claude()), true), false);
  assert.equal(claudeShouldPoll(null, true), false);
});

// ===== 渲染 =====

test("R42 代价句渲染：开着时 `已选` 下一句灰字（Note），关着时不出", () => {
  assert.match(
    render(page.ClaudeCostNote, { on: true }),
    /^<div class="claude-cost"><p class="ss-note[^"]*"[^>]*>[^]*ss-note__text">切换期间不登录 Claude 账号，账号里的对话暂时看不到，切回即恢复</,
  );
  assert.equal(render(page.ClaudeCostNote, { on: false }), "");
  const css = readFileSync(new URL("../src/ClaudeModelsPage.css", import.meta.url), "utf8");
  assert.match(css, /\.claude-cost \{[^}]*margin-top: 10px/);
});

test("R42 Claude 的页没有默认用 / 后台任务用：不出那两颗单选键、菜单、反色闪、对应关系句，也不调已删的命令", () => {
  assert.equal("ClaudeRoles" in page, false);
  const src = readFileSync(new URL("../src/ClaudeModelsPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(
    src,
    /默认用|后台任务用|RolePicker|claude-role|data-flash|<Menu\b|gatewaySetClaudeModels|Sonnet|Haiku/,
  );
  const view = readFileSync(new URL("../src/claudeView.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    view,
    /defaultModel|backgroundModel|claudeRoles|claudeMappingText|withClaudeRole/,
  );
  const css = readFileSync(new URL("../src/ClaudeModelsPage.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /claude-role/);
  const api = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
  assert.doesNotMatch(api, /gateway_set_claude_models|gatewaySetClaudeModels/);
  // 已选下开着时只有代价句：不说「这些模型会出现在…」「…只有 X」
  assert.doesNotMatch(src, /会出现在|只有 \$\{/);
});

test("R42 已选：胶囊行标签 `已选`，片上有 ×；一个都没选时整行不出", () => {
  const html = render(page.ClaudePicked, { view: viewOf(claude()), onRemove: noop });
  assert.match(html, /ss-chiprow__label">已选</);
  assert.match(html, /kimi-k2\.5/);
  assert.equal(
    render(page.ClaudePicked, { view: viewOf(claude({ providers: [] })), onRemove: noop }),
    "",
  );
});

test("AC43 开关旁那一位：在运行且待生效 `重启生效`，开着没在运行 `打开 Claude`，都没有时不画；重启 / 打开时原位忙碌", () => {
  const slot = (view: AgentGatewayView, phase: { kind: string } = { kind: "idle" }) =>
    render(page.ClaudeKeySlot, {
      view: viewOf(view),
      phase: phase as never,
      busy: false,
      onRestart: noop,
      onLaunch: noop,
      onDoneDismiss: noop,
      place: "section",
    });
  assert.match(
    slot(claude({ enabled: true }, { running: true, pending: true, needsRestart: true })),
    />重启生效</,
  );
  assert.match(slot(claude({ enabled: true })), />打开 Claude</);
  assert.equal(slot(claude()), "");
  assert.equal(slot(claude({ enabled: true }, { running: true })), "");
  // 开着改了模型也是重启生效（needsRestart 由后端算）；切回待生效同样
  assert.match(
    slot(claude({}, { running: true, pending: true, needsRestart: true })),
    />重启生效</,
  );
  assert.match(slot(claude({ enabled: true }), { kind: "launching" }), /打开 Claude/);
  assert.equal(slot(claude({ enabled: true }), { kind: "switching" }), "");
});

test("AC43 行内待办条渲染：灰面板满宽、键在右端控件列；执行时键换成忙碌；别家配置只说主句、不接 ` · 另一份配置`", () => {
  const state = stateWith(claude({}, { foreign: { id: "x" } }));
  const html = render(page.ClaudeTodos, {
    state,
    healed: true,
    routerFailure: null,
    resolving: null,
    busy: false,
    onResolve: noop,
  });
  assert.match(html, /ss-noticepanel__message">Claude 桌面应用正在用别的第三方配置<\/span>/);
  assert.match(html, />接管</);
  assert.equal(
    render(page.ClaudeTodos, {
      state: stateWith(claude()),
      healed: true,
      routerFailure: null,
      resolving: null,
      busy: false,
      onResolve: noop,
    }),
    "",
  );
});

test("R41 Claude 那一行的右端控件：条件键在开关左边；按不动时说列表行那一句；状态没读回来什么都不画", () => {
  const controls = (g: GatewayState | null) =>
    render(page.ClaudeListControls, {
      agent: "claude-code",
      state: agentState(g),
      onNotice: noop,
      onError: noop,
      onGatewayState: noop,
    });
  const on = controls(
    stateWith(claude({ enabled: true }, { running: true, pending: true, needsRestart: true })),
  );
  assert.match(on, /role="switch" aria-checked="true"/);
  assert.ok(on.indexOf("重启生效") > -1 && on.indexOf("重启生效") < on.indexOf('role="switch"'));
  assert.match(controls(stateWith(claude({ enabled: true }))), />打开 Claude</);
  const missing = controls(stateWith(claude({ installed: false })));
  assert.match(missing, /role="switch" aria-checked="false"[^]*disabled/);
  assert.match(missing, /装好 Claude 桌面应用后再来打开/);
  assert.match(controls(stateWith(claude({}, { foreign: { id: "x" } }))), /进去接管后才能打开/);
  assert.match(controls(stateWith(claude({ providers: [] }))), /先进去选好模型再打开/);
  assert.equal(controls(null), "");
});

// 2026-09-30：页面头只写 `Claude Desktop`、能力行 `第三方模型`（取代标题 `Claude 桌面应用的第三方模型`）；
// `gatewaySetClaudeModels` 随默认用一起删掉
test("R42 Claude 的页接线：推入页 `Claude Desktop` + 能力行 `modelsCapability()`（开关与键在能力行）；开关拨了就写（enable / restore 带 claude）；重启确认挂到 body、窗口正中、正文按方向；网关区块是 Claude 自己的、同步给 Codex、带过来从 Codex", () => {
  const src = readFileSync(new URL("../src/ClaudeModelsPage.tsx", import.meta.url), "utf8");
  assert.match(src, /const TITLE = CLAUDE_MODELS_NAME;/);
  assert.match(
    src,
    /<AgentPage\s+title=\{TITLE\}\s+capability=\{modelsCapability\(\)\}[^]*control=\{\s*<ClaudeSwitch[^]*actions=\{\s*<ClaudeKeySlot/,
  );
  // 已选下开着时只有代价句
  assert.match(
    src,
    /<ClaudePicked view=\{view\} onRemove=\{removeModel\} \/>\s*<ClaudeCostNote on=\{on\} \/>/,
  );
  assert.match(src, /api\.gatewayEnable\("claude"\)/);
  assert.match(src, /api\.gatewayRestore\("claude"\)/);
  assert.match(src, /api\.gatewayTakeover\("claude"\)/);
  assert.match(src, /api\.gatewayRestartClaude\(\)/);
  assert.match(src, /api\.gatewayLaunchClaude\(\)/);
  assert.match(
    src,
    /bodyLayer\(\s*<Confirm[^]*title=\{t\("models\.restart\.confirmTitle", \{ app: "Claude" \}\)\}[^]*claudeRestartConsequence\(/,
  );
  assert.match(src, /escape=\{!confirmRestart && !gatewayConfirming\}/);
  assert.match(
    src,
    /<GatewayBlock[^]*tool=\{CLAUDE_TOOL\}[^]*agent="claude"[^]*otherName=\{otherName\}/,
  );
  assert.match(src, /useAgentName\("codex"\)/);
  assert.match(src, /api\.gatewayCopyProviders\("claude", "codex"\)/);
  // 编辑时勾了同步：另一家（Codex）那一份在后台重拉模型
  assert.match(src, /api\.gatewayRetryProvider\("codex", saved\.otherProviderId\)/);
  // 页面上不出现内部词
  assert.doesNotMatch(src, /["`>][^"`<]*(3P|configLibrary|配置文件)[^"`<]*["`<]/);
});

test("R41 托盘跳到模型页时停在某家的推入页：回到列表页（经离开前询问）", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const tray = app.slice(app.indexOf('"tray-navigate"'), app.indexOf("兜底：在 Finder 里"));
  assert.match(tray, /requestLeave\(/);
  assert.match(tray, /setModelsVisit\(/);
  assert.match(app, /<ModelsPage\s+key=\{modelsVisit\}/);
});
