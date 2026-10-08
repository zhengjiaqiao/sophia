import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { render } from "./ui-render.ts";
import {
  claudeAccountCost,
  claudeModelsName,
  claudeLaunchTip,
  claudeLimitations,
  claudeRestartTip,
  claudeTradeoff,
  claudeHeadIssue,
  claudeRestartConsequence,
  claudeShouldPoll,
  claudeSwitchReason,
  claudeSwitchText,
  claudeSwitchTip,
  claudeTodos,
  claudeViaRestart,
} from "../src/claudeView.ts";
import { enableNeedsModels } from "../src/modelsView.ts";
import type { AgentState } from "../src/shell/agentRegistry.ts";
import { claudeGateway } from "../src/types.ts";
import type { AgentGatewayView, GatewayClaudeDesktop, GatewayState } from "../src/types.ts";
import { CLAUDE_OFF, NO_MODELS, gatewayFixture, picked } from "./gateway-fixture.ts";

// Claude 桌面应用那一行（spec 2026-09-29 R41 R42 Claude 部分、AC43；#259 起没有 Claude 的页，都在模型页那一行上）

const controls = await import("../src/claudeControls.tsx");

const noop = () => undefined;

/// Claude 那一份：默认装着、没在跑、关着、选了 Kimi 的 kimi-k2.5
const claude = (
  overrides: Partial<AgentGatewayView> = {},
  desktop: Partial<GatewayClaudeDesktop> = {},
): AgentGatewayView => ({
  ...CLAUDE_OFF,
  installed: true,
  models: picked("Kimi/kimi-k2.5"),
  ...overrides,
  claude: {
    ...CLAUDE_OFF.claude!,
    desktop: { ...CLAUDE_OFF.claude!.desktop, version: "1.2.0", ...desktop },
  },
});

const stateWith = (
  view: AgentGatewayView,
  router = { running: true, port: 47328, error: "" },
): GatewayState =>
  gatewayFixture({
    supported: true,
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

// ===== 开关的禁用原因：两处（模型页那一行、托盘）各说各的下一步 =====

test("R41 开关按不动：没装 / 受管 / 太旧说「怎么办」；别家配置在生效——行上 `接管后才能打开`（接管条就在行下）、托盘 `在模型页里接管后才能打开`；没选模型", () => {
  const reason = (view: AgentGatewayView, place?: "list" | "tray") =>
    claudeSwitchReason(viewOf(view), place);
  assert.equal(reason(claude({ installed: false })), "装好 Claude 桌面应用后再来打开");
  assert.equal(
    reason(claude({}, { managed: true })),
    "这台电脑上的 Claude 由组织统一配置，不能在这里切换",
  );
  assert.equal(reason(claude({}, { tooOld: true })), "先把 Claude 更新到最新版");
  const foreign = claude({}, { foreign: { id: "x" } });
  assert.equal(reason(foreign), "接管后才能打开");
  assert.equal(reason(foreign, "tray"), "在模型页里接管后才能打开");
  assert.equal(reason(claude({ models: NO_MODELS })), enableNeedsModels());
  assert.equal(reason(claude({ models: NO_MODELS }), "tray"), enableNeedsModels());
  assert.equal(enableNeedsModels(), "先在「选模型」里选一个模型");
  // 能按；开着时永远能关
  assert.equal(reason(claude()), null);
  assert.equal(reason(claude({ enabled: true, installed: false, models: NO_MODELS })), null);
});

// ===== 几句 DESIGN 原话：行与托盘说同一句（定义只在 claudeView） =====

test("R42 R44 文案只有一份：开关提示框（没接时连同切过去后的限制）、重启确认正文按方向、键的提示框、拨开关的忙碌与没成，都在 claudeView", () => {
  assert.equal(
    claudeSwitchTip(false),
    "打开后，Claude 桌面应用改用这里选的模型，不再登录 Claude 账号；账号里的对话暂时看不到，切回即恢复。要重启 Claude 才生效；Sophia 需要保持运行，退出时自动改回官方，下次打开再接上\n切过去后没有语音、手机端和 claude.ai 的连接器 · 联网搜索要看模型提供商",
  );
  assert.equal(
    claudeSwitchTip(true),
    "关掉后，Claude 桌面应用回到 Claude 账号；要重启 Claude 才生效；Sophia 需要保持运行，退出时自动改回官方，下次打开再接上",
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
  assert.equal(
    claudeLimitations(),
    "切过去后没有语音、手机端和 claude.ai 的连接器 · 联网搜索要看模型提供商",
  );
  assert.equal(claudeAccountCost(), "账号里的对话暂时看不到");
  const tray = readFileSync(new URL("../src/trayView.ts", import.meta.url), "utf8");
  assert.doesNotMatch(tray, /要重启 Claude 才生效|会退出再打开|它会用上现在的模型设置/);
  const row = readFileSync(new URL("../src/TrayClaudeRow.tsx", import.meta.url), "utf8");
  assert.match(row, /from "\.\/claudeView\.ts"/);
  assert.match(row, /claudeSwitchTip|claudeRestartConsequence/);
});

test("R42 代价句（DESIGN 原话）是行上开着时的灰字；模型页里的名字只在 claudeView 一处", () => {
  assert.equal(claudeTradeoff(), "切换期间不登录 Claude 账号，账号里的对话暂时看不到，切回即恢复");
  assert.equal(claudeModelsName(), "Claude 桌面应用");
  const agents = readFileSync(new URL("../src/shell/agents.tsx", import.meta.url), "utf8");
  assert.match(agents, /view\.enabled \? claudeTradeoff\(\) : null/);
  for (const file of [
    "../src/shell/ModelsPage.tsx",
    "../src/TrayClaudeRow.tsx",
    "../src/claudeControls.tsx",
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(src, /桌面应用 · 第三方模型|"Claude Desktop"/, file);
  }
});

// ===== 行下待办条、走不走重启 =====

test("AC43 行下待办条：别家配置在生效 + `接管`（只说主句，不写是谁的配置）/ 被改掉了 + `重新写入`；路由那一条在页面头下、不在这里", () => {
  const kinds = (view: AgentGatewayView, running = true) =>
    claudeTodos(stateWith(view, { running, port: 1, error: "" })).map((t) => [
      t.kind,
      t.message,
      t.reason,
      t.label,
    ]);
  assert.deepEqual(kinds(claude()), []);
  assert.deepEqual(kinds(claude({ enabled: true }), false), []);
  assert.deepEqual(kinds(claude({}, { foreign: { id: "x" } })), [
    ["takeover", "Claude 桌面应用正在用别的第三方配置", null, "接管"],
  ]);
  assert.deepEqual(kinds(claude({ enabled: true }, { drift: true })), [
    ["rewrite", "Sophia 写进去的设置被改掉了", null, "重新写入"],
  ]);
});

test("R34 R36 切回没做完：行下灰面板 `切回 Claude 账号失败 · 上次没做完`；重新写入与再试一次在桌面应用运行时走重启生效（先确认）", () => {
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

test("AC43 开关旁那一位：在运行且待生效 `重启生效`，开着没在运行 `打开 Claude`，都没有时不画；重启 / 打开时原位忙碌", () => {
  const slot = (view: AgentGatewayView, phase: { kind: string } = { kind: "idle" }) =>
    render(controls.ClaudeKeySlot, {
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

test("AC43 行下待办条渲染：别家配置只说主句 + `接管`；切回没做完 `切回 Claude 账号失败 · 上次没做完` + `再试一次`；没事什么都不画", () => {
  const todos = (g: GatewayState) =>
    render(controls.ClaudeRowTodos, {
      agent: "claude-code",
      state: agentState(g),
      onNotice: noop,
      onError: noop,
      onGatewayState: noop,
    });
  const html = todos(stateWith(claude({}, { foreign: { id: "x" } })));
  assert.match(html, /ss-noticepanel__message">Claude 桌面应用正在用别的第三方配置<\/span>/);
  assert.match(html, />接管</);
  assert.match(
    todos(stateWith(claude({}, { restoreUnfinished: true }))),
    /切回 Claude 账号失败[^]*上次没做完[^]*>再试一次</,
  );
  assert.equal(todos(stateWith(claude())), "");
  const src = readFileSync(new URL("../src/claudeControls.tsx", import.meta.url), "utf8");
  assert.match(src, /api\.gatewayTakeover\("claude"\)/);
  assert.match(src, /api\.gatewayRestartClaude\(\)/);
  assert.doesNotMatch(src, /登录页/);
});

test("R41 Claude 那一行的右端控件：条件键 · 选模型键 · 开关；按不动时说行上那一句；状态没读回来什么都不画", () => {
  const rowControls = (g: GatewayState | null) =>
    render(controls.ClaudeListControls, {
      agent: "claude-code",
      state: agentState(g),
      pick: "[选模型键]",
      onNotice: noop,
      onError: noop,
      onGatewayState: noop,
    });
  const on = rowControls(
    stateWith(claude({ enabled: true }, { running: true, pending: true, needsRestart: true })),
  );
  assert.match(on, /role="switch" aria-checked="true"/);
  assert.ok(on.indexOf("重启生效") > -1 && on.indexOf("重启生效") < on.indexOf("[选模型键]"));
  assert.ok(on.indexOf("[选模型键]") < on.indexOf('role="switch"'));
  assert.match(rowControls(stateWith(claude({ enabled: true }))), />打开 Claude</);
  const missing = rowControls(stateWith(claude({ installed: false })));
  assert.match(missing, /role="switch" aria-checked="false"[^]*disabled/);
  assert.match(missing, /装好 Claude 桌面应用后再来打开/);
  assert.match(rowControls(stateWith(claude({}, { foreign: { id: "x" } }))), /接管后才能打开/);
  assert.match(rowControls(stateWith(claude({ models: NO_MODELS }))), /先在「选模型」里选一个模型/);
  assert.equal(rowControls(null), "");
});

test("R41 托盘跳到模型页：回到模型页（经离开前询问）", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const tray = app.slice(app.indexOf('"tray-navigate"'), app.indexOf("兜底：在 Finder 里"));
  assert.match(tray, /requestLeave\(/);
  assert.match(tray, /setModelsVisit\(/);
  assert.match(app, /<ModelsPage\s+key=\{modelsVisit\}/);
});
