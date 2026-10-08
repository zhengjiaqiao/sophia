/// WorkBuddy 那一行（#266）：第二行的计数、开关按不动的原因、提示框、行下的「重新写入」；注册表里它只进模型页、不进托盘
import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";
import { pageSections } from "../src/shell/agentRegistry.ts";
import type { AgentState } from "../src/shell/agentRegistry.ts";
import { trayBlocks } from "../src/trayView.ts";
import { workbuddyGateway } from "../src/types.ts";
import type { AgentGatewayView, GatewayState } from "../src/types.ts";
import {
  workbuddyAllowListNote,
  workbuddyListStatus,
  workbuddySwitchReason,
  workbuddySwitchTip,
  workbuddyTodo,
} from "../src/workbuddyView.ts";
import { NO_MODELS, gatewayFixture, picked } from "./gateway-fixture.ts";

const { AGENTS } = await import("../src/shell/agents.tsx");
const controls = await import("../src/workbuddyControls.tsx");
const noop = () => undefined;

/// WorkBuddy 那一份：默认装着、关着、选了 Kimi 两个、文件里没写着
const workbuddy = (
  overrides: Partial<AgentGatewayView> = {},
  extra: { written?: boolean; fileIssue?: string; hiddenByAllowList?: boolean } = {},
): AgentGatewayView => ({
  agent: "workbuddy",
  installed: true,
  models: picked("Kimi/kimi-k2.6", "Kimi/kimi-for-coding"),
  enabled: false,
  conflict: "",
  ...overrides,
  workbuddy: { written: false, fileIssue: "", hiddenByAllowList: false, ...extra },
});

const stateWith = (view: AgentGatewayView): GatewayState =>
  gatewayFixture({
    supported: true,
    enabled: false,
    needsCodexRestart: false,
    router: { running: true, port: 47328, error: "" },
    codex: { version: "26.0", running: true, catalogVersion: "1", drift: false },
    conflict: "",
    takeover: null,
    workbuddy: view,
  });

const agentState = (g: GatewayState | null): AgentState => ({
  gateway: g,
  modelsSupported: true,
  usage: null,
});

const entry = AGENTS.find((a) => a.id === "workbuddy")!;

test("装了才在模型页出一行（第三方模型），不进托盘；没装不列", () => {
  const on = agentState(stateWith(workbuddy()));
  assert.equal(entry.available(on), true);
  assert.deepEqual(
    pageSections(entry, on).map((s) => s.id),
    ["third-party-models"],
  );
  assert.ok(!trayBlocks(AGENTS, on).some((b) => b.id === "workbuddy"));
  assert.equal(entry.available(agentState(stateWith(workbuddy({ installed: false })))), false);
});

test("第二行：没选 `还没选模型`；关着 `没接第三方模型`；开着按提供商计数", () => {
  assert.equal(
    workbuddyListStatus(agentState(stateWith(workbuddy({ models: NO_MODELS })))),
    "还没选模型",
  );
  assert.equal(workbuddyListStatus(agentState(stateWith(workbuddy()))), "没接第三方模型");
  assert.equal(
    workbuddyListStatus(agentState(stateWith(workbuddy({ enabled: true }, { written: true })))),
    "Kimi 2",
  );
  assert.equal(workbuddyListStatus(agentState(null)), "");
});

test("开关：开着永远能关；关着时 models.json 读不懂说原话、没选模型说去选；提示框说不用重启 WorkBuddy、Sophia 要开着", () => {
  const view = (v: AgentGatewayView) => workbuddyGateway(stateWith(v))!;
  assert.equal(workbuddySwitchReason(view(workbuddy({ enabled: true }))), null);
  assert.equal(workbuddySwitchReason(view(workbuddy())), null);
  assert.equal(
    workbuddySwitchReason(view(workbuddy({ conflict: "models.json 读不懂" }))),
    "models.json 读不懂",
  );
  assert.equal(
    workbuddySwitchReason(view(workbuddy({ models: NO_MODELS }))),
    "先在「选模型」里选一个模型",
  );
  assert.match(
    workbuddySwitchTip(false),
    /排在它自己的模型后面，不用重启 WorkBuddy；Sophia 需要保持运行/,
  );
  assert.match(workbuddySwitchTip(true), /^关掉后/);
});

test("行下待办：开着、文件里却没有 Sophia 的条目了 → `重新写入`；读不懂时主句换成那一种、原话跟着", () => {
  const view = (v: AgentGatewayView) => workbuddyGateway(stateWith(v))!;
  assert.equal(workbuddyTodo(view(workbuddy({ enabled: true }, { written: true }))), null);
  assert.equal(workbuddyTodo(view(workbuddy())), null);
  assert.deepEqual(workbuddyTodo(view(workbuddy({ enabled: true }))), {
    message: "Sophia 写进去的设置被改掉了",
    reason: null,
    label: "重新写入",
    busy: "正在重新写入",
  });
  assert.equal(
    workbuddyTodo(view(workbuddy({ enabled: true }, { fileIssue: "第 3 行不对" })))?.message,
    "读不懂 WorkBuddy 的模型配置",
  );
});

test("右端控件：选模型键 · 开关，没有重启键；按不动时开关禁用并说原因；状态没读回来什么都不画", () => {
  const rowControls = (g: GatewayState | null) =>
    render(controls.WorkBuddyListControls, {
      agent: "workbuddy",
      state: agentState(g),
      pick: "[选模型键]",
      onNotice: noop,
      onError: noop,
      onGatewayState: noop,
    });
  const on = rowControls(stateWith(workbuddy({ enabled: true }, { written: true })));
  assert.match(on, /role="switch" aria-checked="true"/);
  assert.ok(on.indexOf("[选模型键]") < on.indexOf('role="switch"'));
  assert.doesNotMatch(on, /重启生效/);
  const none = rowControls(stateWith(workbuddy({ models: NO_MODELS })));
  assert.match(none, /role="switch" aria-checked="false"[^]*disabled/);
  assert.match(none, /先在「选模型」里选一个模型/);
  assert.equal(rowControls(null), "");
});

// 评审 #19（#266）：用户的 models.json 自带可用模型名单、挡住了 Sophia 加的模型：行下说一声（不替用户改名单、没有键），
// 第二层原样给出文件名与字段名
test("可用模型名单挡住了 Sophia 加的模型：行下灰面板说看不到、原因里给 models.json 与 availableModels；没挡住、关着都不说", () => {
  const view = (v: AgentGatewayView) => workbuddyGateway(stateWith(v))!;
  const hidden = view(workbuddy({ enabled: true }, { written: true, hiddenByAllowList: true }));
  assert.deepEqual(workbuddyAllowListNote(hidden), {
    message: "Sophia 加的模型被 WorkBuddy 的可用模型名单挡住了，在它的模型列表里看不到",
    reason:
      "WorkBuddy 的 models.json 里的 availableModels 只放行名单里的模型；要用就把它们加进名单",
  });
  assert.equal(workbuddyAllowListNote(view(workbuddy({ enabled: true }, { written: true }))), null);
  assert.equal(workbuddyAllowListNote(view(workbuddy({}, { hiddenByAllowList: true }))), null);
  const html = render(controls.WorkBuddyRowTodos, {
    agent: "workbuddy",
    state: agentState(
      stateWith(workbuddy({ enabled: true }, { written: true, hiddenByAllowList: true })),
    ),
    pick: null,
    onNotice: noop,
    onError: noop,
    onGatewayState: noop,
  });
  assert.match(html, /被 WorkBuddy 的可用模型名单挡住了/);
  assert.doesNotMatch(html, /重新写入/);
});
