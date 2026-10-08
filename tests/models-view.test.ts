import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { withCopy } from "./copy.ts";
import { render } from "./ui-render.ts";
import {
  enableDisabledReason,
  routerUnavailable,
  showRestartKey,
  shouldPollRestart,
  showLaunchKey,
  launchTip,
  showRouterTodo,
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
  contextLabel,
} from "../src/modelsView.ts";
import { CODEX } from "../src/modelsView.ts";
import { codexGateway } from "../src/types.ts";
import type { GatewayState } from "../src/types.ts";
import {
  CLAUDE_OFF,
  NO_MODELS,
  gatewayFixture,
  picked,
  type CodexFixture,
} from "./gateway-fixture.ts";

// 用例按 Codex 的平铺字段写，夹具拼成按家拆开的 GatewayState（tests/gateway-fixture.ts）；
// 默认 Codex 选了一个第三方模型（Kimi 的 m1）
const state = (overrides: Partial<CodexFixture> = {}): GatewayState =>
  gatewayFixture({
    supported: true,
    models: picked("Kimi/m1"),
    enabled: false,
    needsCodexRestart: false,
    router: { running: false, port: 47328, error: "" },
    codex: { version: "26.0", running: false, catalogVersion: "1", drift: false },
    conflict: "",
    takeover: null,
    ...overrides,
  });

const { CodexKeySlot, CodexSwitch } = await import("../src/codexControls.tsx");

const noop = () => {};

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

test("enableDisabledReason 按优先级返回原因：待接管 > 冲突 > 一个第三方模型都没选（只选了官方模型也算没选）", () => {
  assert.equal(
    enableDisabledReason(
      state({ takeover: { baseUrl: "x", selectedCount: 1 }, conflict: "别的工具" }),
    ),
    "本机当前由 agents-manager 启用，请先接管",
  );
  assert.equal(
    enableDisabledReason(state({ conflict: "已有 model_provider = custom" })),
    "已有 model_provider = custom",
  );
  assert.equal(enableDisabledReason(state({ models: NO_MODELS })), "先在「选模型」里选一个模型");
  assert.equal(
    enableDisabledReason(state({ models: picked("官方/gpt-6") })),
    "先在「选模型」里选一个模型",
  );
  assert.equal(enableDisabledReason(state()), null);
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
  assert.equal(
    restartConsequence("ChatGPT"),
    "ChatGPT 会退出再打开，它和终端里 Codex 进行中的对话都会中断",
  );
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

test("路由没在跑：先自愈，自愈过仍没起来才出横幅", () => {
  const down = state({
    enabled: true,
    router: { running: false, port: 1, protocol: "chat", error: "x" },
  });
  assert.equal(showRouterTodo(down, false), false);
  assert.equal(showRouterTodo(down, true), true);
  assert.equal(showRouterTodo(state({ enabled: false }), true), false);
});

// Codex 页节头的开关与键位（codexControls：与托盘共用同一份）
const switchProps = (overrides: Partial<CodexFixture> = {}) => ({
  tool: CODEX,
  state: state(overrides),
  switching: null as boolean | null,
  busy: false,
  label: "Codex 的第三方模型",
  withFile: true,
  onToggle: noop,
});

const slotProps = (overrides: Partial<CodexFixture> = {}) => ({
  tool: CODEX,
  state: state(overrides),
  busy: false,
  phase: { kind: "idle" } as const,
  onRestart: noop,
  onLaunch: noop,
  onDoneDismiss: noop,
  place: "section" as const,
});

test("CodexSwitch：标准开关（旁边不点指示点，开着由刻线说）；开关＝配置里开没开；关着时提示框写打开的结果与改的是哪个文件", () => {
  const on = render(CodexSwitch, switchProps({ enabled: true }));
  assert.match(
    on,
    /role="switch" aria-checked="true"[^>]*class="ss-switch ss-switch--regular is-on"/,
  );
  assert.doesNotMatch(on, /ss-indicator/);
  const off = render(CodexSwitch, switchProps({}));
  assert.match(off, /role="switch" aria-checked="false"/);
  assert.match(
    off,
    /role="tooltip"[^>]*>打开后，选好的模型会出现在 Codex 的模型列表里；会改 ~\/\.codex\/config\.toml 里的一处设置；Sophia 需要保持运行，退出时自动改回官方，下次打开再接上</,
  );
});

test("CodexSwitch 乐观翻转：拨下去写配置期间滑块已在拨过去的那一侧、亮橙；没有待定位置、没有拨开关的确认", () => {
  const on = render(CodexSwitch, {
    ...switchProps({ enabled: false }),
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
    ...switchProps({ enabled: true }),
    busy: true,
    switching: false,
  });
  assert.match(off, /role="switch" aria-checked="false"/);
  assert.doesNotMatch(on + off, /data-pending|ss-pending-switch/);
  const src = withCopy(readFileSync(new URL("../src/codexControls.tsx", import.meta.url), "utf8"));
  assert.doesNotMatch(src, /PendingSwitch|pending=\{|confirmSwitch|gatewayConfirmText|重启并/);
});

test("CodexSwitch 一个第三方模型都没选：开关禁用，按下即出「先在「选模型」里选一个模型」", () => {
  const html = render(CodexSwitch, switchProps({ models: NO_MODELS }));
  assert.match(
    html,
    /role="switch" aria-checked="false"[^>]*disabled=""[^]*?role="tooltip"[^>]*>先在「选模型」里选一个模型</,
  );
});

test("CodexSwitch 拨开关之后：开关原位锁住（过了 0.3 秒门槛换成转圈 +「正在添加」），不画成禁用", () => {
  const html = render(CodexSwitch, {
    ...switchProps({ enabled: false }),
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
  const html = render(CodexKeySlot, slotProps({ enabled: true, needsCodexRestart: true }));
  assert.match(html, /class="ss-btn ss-btn--compact"[^>]*>重启生效</);
  assert.match(html, /role="tooltip"[^>]*>重启 Codex 桌面应用让改动生效，进行中的对话会中断</);
  assert.equal(
    render(
      CodexKeySlot,
      slotProps({
        enabled: true,
        codex: { version: "26.0", running: true, catalogVersion: "1", drift: false },
      }),
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

test("CodexKeySlot 重启中：0.3 秒门槛之前键照旧、点不动；已生效：键的原位下方浮起白窗", () => {
  const busyHtml = render(CodexKeySlot, {
    ...slotProps({ enabled: true, needsCodexRestart: true }),
    phase: { kind: "restarting" },
  });
  assert.match(busyHtml, /^<span class="ss-locked" aria-busy="true">[^]*重启生效<\/button>/);
  assert.doesNotMatch(busyHtml, /ss-spinner/);
  // 忙碌走组件库唯一的 0.3 秒门槛（BusySlot），不再自拼刻度 + 文字
  const src = withCopy(readFileSync(new URL("../src/codexControls.tsx", import.meta.url), "utf8"));
  assert.match(
    src,
    /<BusySlot\s+busy\s+label=\{\s*restarting\s*\?\s*t\("正在重启\{app\}", \{ app \}\)\s*:\s*t\("正在启动\{app\}", \{ app \}\)\s*\}/,
  );
  assert.doesNotMatch(src, /useBusyShown|Spinner/);
  const doneHtml = render(CodexKeySlot, {
    ...slotProps({ enabled: true }),
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
    ...slotProps({ enabled: true }),
    onLaunch: noop,
  });
  assert.match(html, />启动 Codex<\/button>/);
  assert.match(html, /role="tooltip"[^>]*>打开 Codex 桌面应用，它会用上现在的模型设置</);
  assert.doesNotMatch(render(CodexKeySlot, { ...slotProps({}), onLaunch: noop }), /启动 Codex/);
  const launching = render(CodexKeySlot, {
    ...slotProps({ enabled: true }),
    onLaunch: noop,
    phase: { kind: "launching" },
  });
  assert.match(launching, /ss-locked" aria-busy="true"[^]*启动 Codex<\/button>/);
  const launched = render(CodexKeySlot, {
    ...slotProps({ enabled: true }),
    onLaunch: noop,
    phase: { kind: "launched" },
  });
  assert.match(launched, /codex-key__spot[^]*ss-toast--routine[^]*已启动/);
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

test("Codex 能力控件只有一份：模型页那一行与托盘能力行都用 codexControls，不再各写开关三态与键位", () => {
  const row = withCopy(readFileSync(new URL("../src/codexControls.tsx", import.meta.url), "utf8"));
  const tray = withCopy(readFileSync(new URL("../src/TrayModelsRow.tsx", import.meta.url), "utf8"));
  assert.match(
    row,
    /export function CodexListControls[^]*<CodexKeySlot[^]*\{pick\}[^]*<CodexSwitch/,
  );
  assert.match(tray, /from "\.\/codexControls\.tsx"/);
  for (const src of [tray]) {
    assert.match(src, /<CodexSwitch/);
    assert.match(src, /<CodexKeySlot/);
    assert.doesNotMatch(src, /<Switch\b|uninstall|launchTip|restartTip|useBusyShown/);
  }
  // 页面文件里不再写组件库的内部类
  for (const file of [
    "shell/ModelsPage.tsx",
    "shell/ModelsPage.css",
    "PickModels.tsx",
    "PickModels.css",
  ]) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\bss-[a-z]/, file);
    assert.doesNotMatch(src, /<svg/, file);
  }
});

// ===== 两家（spec 2026-09-29 R40 R41 R43 R46）=====

/// Claude 那一份：开着 / 关着
const claude = (enabled: boolean) => ({
  ...CLAUDE_OFF,
  installed: true,
  enabled,
  models: picked("Kimi/kimi"),
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

test("行上 Codex 开关按不动的原因（选模型、接管都在这一行上，同托盘那一句）；开着永远能关", () => {
  assert.equal(codexListSwitchReason(state({ models: NO_MODELS })), "先在「选模型」里选一个模型");
  assert.equal(
    codexListSwitchReason(state({ takeover: { baseUrl: "https://x", selectedCount: 1 } })),
    "本机当前由 agents-manager 启用，请先接管",
  );
  assert.equal(codexListSwitchReason(state()), null);
  assert.equal(codexListSwitchReason(state({ models: NO_MODELS, enabled: true })), null);
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
