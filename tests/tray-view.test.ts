import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { withCopy } from "./copy.ts";
import { createElement } from "react";
import {
  trayAgentState,
  trayBlocks,
  trayClaudeRow,
  trayRow,
  restartConsequence,
  restartTip,
} from "../src/trayView.ts";
// Claude 行的文案定义在 claudeView（Claude 的页、列表行、托盘说同一句，P5c 挪过去），托盘从那里取
import {
  claudeRestartConsequence,
  claudeSwitchTip,
  claudeAccountCost,
  claudeLaunchTip,
} from "../src/claudeView.ts";
import { enableDisabledReason, enableNeedsModels } from "../src/modelsView.ts";
import type { AgentEntry } from "../src/shell/agentRegistry.ts";
import { claudeGateway } from "../src/types.ts";
import type {
  AgentGatewayView,
  GatewayProvider,
  GatewayProviderModel,
  GatewayState,
  UsageView,
} from "../src/types.ts";
import { CLAUDE_OFF, gatewayFixture, type CodexFixture } from "./gateway-fixture.ts";
import { render } from "./ui-render.ts";

const { AGENTS } = await import("../src/shell/agents.tsx");

const model = (id: string, selected: boolean): GatewayProviderModel => ({
  id,
  slug: id,
  displayName: id,
  selected,
});

// 用例按 Codex 的平铺字段写，夹具拼成按家拆开的 GatewayState（tests/gateway-fixture.ts）；
// `provider` 是只有一家网关时的简写
type Fixture = Partial<CodexFixture> & { provider?: Partial<GatewayProvider> };
const state = ({ provider: one, ...overrides }: Fixture = {}): GatewayState => {
  // 只给面板判断用得到的几项（与原夹具一样）；名字取不到时 providerLabel 退回主机名
  const provider = {
    baseUrl: "https://example.com/openai",
    key: "set",
    models: [],
    ...one,
  } as GatewayProvider;
  return gatewayFixture({
    supported: true,
    providers: [provider],
    enabled: false,
    needsCodexRestart: false,
    router: { running: false, port: 47328, error: "" },
    codex: { version: "26.0", running: false, catalogVersion: "1", drift: false },
    conflict: "",
    takeover: null,
    ...overrides,
  });
};

const withModels = (n: number, overrides: Fixture = {}) =>
  state({
    ...overrides,
    provider: {
      baseUrl: "https://example.com/openai",
      key: "set",
      models: [...Array(n)].map((_, i) => model(`m${i}`, true)).concat(model("off", false)),
      ...(overrides.provider ?? {}),
    },
  });

// UI v4：托盘与模型页同一行的缩小版——开关是 page Switch（不再是「启用 / 已启用」pill），
// 没有状态句（DESIGN「托盘面板」）。原先钉 label / status / needsSetup 的断言属于被推翻的行为，按新规范改写
test("AC1 已启用：开关开着、可点", () => {
  const row = trayRow(
    withModels(3, {
      enabled: true,
      router: { running: true, port: 47328, error: "" },
    }),
  );
  assert.equal(row.toggle.on, true);
  assert.equal(row.toggle.disabledReason, null);
  assert.equal("status" in row, false, "托盘没有状态句");
});

test("可以启用：开关关着、可点", () => {
  const row = trayRow(withModels(2));
  assert.equal(row.toggle.on, false);
  assert.equal(row.toggle.disabledReason, null);
});

// 原因的文案归 modelsView（与 Codex 页同一句），这里只钉「禁用、且说的是同一句」
test("AC2 没保存密钥：开关禁用并说原因（与 Codex 页同一句）", () => {
  const s = state({ provider: { baseUrl: "", key: "missing", models: [] } });
  const row = trayRow(s);
  assert.equal(row.toggle.on, false);
  assert.notEqual(row.toggle.disabledReason, null);
  assert.equal(row.toggle.disabledReason, enableDisabledReason(s, 0));
});

test("没选模型：开关禁用并说原因（与 Codex 页同一句）", () => {
  const s = withModels(0);
  const row = trayRow(s);
  assert.notEqual(row.toggle.disabledReason, null);
  assert.equal(row.toggle.disabledReason, enableDisabledReason(s, 0));
});

test("AC3 由 agents-manager 启用：开关禁用，原因是先接管", () => {
  const row = trayRow(withModels(2, { takeover: { baseUrl: "https://x", selectedCount: 2 } }));
  assert.match(row.toggle.disabledReason ?? "", /接管/);
});

test("已启用时永远能关：哪怕密钥没了、模型清空了", () => {
  const row = trayRow(
    state({ enabled: true, provider: { baseUrl: "", key: "missing", models: [] } }),
  );
  assert.equal(row.toggle.on, true);
  assert.equal(row.toggle.disabledReason, null);
});

// ===== 块与行从 agent 注册表生成（DESIGN「托盘面板」「扩展预留：用量与会话」） =====

// ===== 用量（spec 2026-09-26-menubar-usage R10） =====

const usageView = (overrides: Partial<UsageView> = {}): UsageView => ({
  state: { agents: [] },
  settings: {
    menuBarEnabled: false,
    displayMode: "remaining",
    agents: null,
    perAgent: {},
    refresh: "auto",
  },
  signedIn: ["claude-code", "codex"],
  tray: [
    {
      agent: "claude-code",
      updatedText: "2 小时前更新",
      windows: [
        {
          label: "5 小时",
          percentText: "剩 93%",
          gaugePercent: 93,
          emphasize: false,
          resetText: "2:58 后重置",
        },
        {
          label: "本周",
          percentText: "剩 10%",
          gaugePercent: 10,
          emphasize: true,
          resetText: "3 天后重置",
        },
      ],
      note: null,
      retry: false,
    },
    {
      agent: "codex",
      updatedText: "1 分钟前更新",
      windows: [
        {
          label: "本周",
          percentText: "剩 100%",
          gaugePercent: 100,
          emphasize: false,
          resetText: "7 天后重置",
        },
      ],
      note: null,
      retry: false,
    },
  ],
  menuBar: { segments: [] },
  ...overrides,
});

// spec 2026-09-29 R44 R45：Claude 那一块在 `用量` 之后加 `第三方模型`（桌面应用）；用量按节级可用，没登录时这一块只有第三方模型一行。
// 原「Claude 只有用量一行、没登录不成块」随之改为下面的名单
test("块从注册表生成：Codex 一块两行（用量在前、第三方模型在后），Claude 一块（块名 `Claude`：额度属于 Claude 账号，命令行、桌面应用、claude.ai 共用）用量已登录才有用量行、本机支持就有第三方模型行；这台机器不支持时 Codex 整块不出现", () => {
  const blocks = trayBlocks(AGENTS, trayAgentState(state(), usageView()));
  assert.deepEqual(
    blocks.map((b) => [b.id, b.name, b.rows.map((r) => [r.id, r.title])]),
    [
      [
        "codex",
        "Codex",
        [
          ["usage", "用量"],
          ["third-party-models", "第三方模型"],
        ],
      ],
      [
        "claude-code",
        "Claude",
        [
          ["usage", "用量"],
          ["third-party-models", "第三方模型"],
        ],
      ],
    ],
  );
  assert.equal(blocks[0].rows[1].Row, AGENTS[0].sections[1].trayRow);
  assert.equal(blocks[1].rows[1].Row, AGENTS[1].sections[1].trayRow);
  const rowsOf = (b: { id: string; rows: { id: string }[] }) => [b.id, b.rows.map((r) => r.id)];
  // Claude 没登录（用量视图里没有它）：Claude 块只有第三方模型一行（AC42）
  const codexOnly = usageView({ signedIn: ["codex"], tray: usageView().tray.slice(1) });
  assert.deepEqual(trayBlocks(AGENTS, trayAgentState(state(), codexOnly)).map(rowsOf), [
    ["codex", ["usage", "third-party-models"]],
    ["claude-code", ["third-party-models"]],
  ]);
  // 用量还没读回来：用量行先不出，第三方模型照常
  assert.deepEqual(trayBlocks(AGENTS, trayAgentState(state(), null)).map(rowsOf), [
    ["codex", ["usage", "third-party-models"]],
    ["claude-code", ["third-party-models"]],
  ]);
  assert.deepEqual(trayBlocks(AGENTS, trayAgentState(state({ supported: false }), null)), []);
  // 不支持第三方模型的机器上 Claude 登录了：只剩用量一行
  assert.deepEqual(
    trayBlocks(AGENTS, trayAgentState(state({ supported: false }), usageView())).map(rowsOf),
    [["claude-code", ["usage"]]],
  );
  // 状态还没读回来：先不出块（只剩菜单）
  assert.deepEqual(trayBlocks(AGENTS, trayAgentState(null)), []);
});

test("R10 块头名字后总写「N 分钟前更新」（弱字，不是控件）；重置时间跟着各自的窗口", () => {
  const blocks = trayBlocks(AGENTS, trayAgentState(state(), usageView()));
  assert.deepEqual(
    blocks.map((b) => [b.id, b.note]),
    [
      ["codex", "1 分钟前更新"],
      ["claude-code", "2 小时前更新"],
    ],
  );
  assert.equal(trayBlocks(AGENTS, trayAgentState(state(), null))[0].note, null);
});

const trayHost = {
  applyGateway: () => undefined,
  idle: async () => undefined,
  alive: () => true,
  openedAt: 0,
  failOver: () => undefined,
  rereadUsage: async () => undefined,
};

test("用量行：能再试的原因行右端一颗托盘小按键「再试一次」（同 `重启生效` 那种键），上一次的读数照画；被限流的不给", async () => {
  const { TrayAgents } = await import("../src/TrayPanel.tsx");
  const [claude, codex] = usageView().tray;
  const view = usageView({
    tray: [
      { ...claude, note: "Claude Code 版本可能太旧，更新后再试", retry: true },
      { ...codex, windows: [], note: "被限流，约 5 分钟后再试", retry: false },
    ],
  });
  const agentState = trayAgentState(state(), view);
  const html = render(TrayAgents, {
    blocks: trayBlocks(AGENTS, agentState),
    state: agentState,
    host: trayHost,
  });
  const claudeHtml = html.slice(html.indexOf('aria-label="Claude"'));
  assert.match(claudeHtml, /usage-wins--stacked[^]*>剩 93%</, "上一次的读数照画");
  assert.match(
    claudeHtml,
    /<p class="usage-note usage-note--retry"><span class="usage-note__text">Claude Code 版本可能太旧，更新后再试<\/span><span class="ss-tipwrap is-idle"><button type="button" class="ss-btn ss-btn--compact">再试一次<\/button><\/span><\/p>/,
  );
  const codexHtml = html.slice(0, html.indexOf('aria-label="Claude"'));
  assert.match(codexHtml, /<p class="usage-note">被限流，约 5 分钟后再试<\/p>/);
  assert.doesNotMatch(codexHtml, /再试一次/);
});

test("用量行（两行版式）正在读取：键锁住、aria-busy，过了忙碌门槛换成刻度 +「正在读取」", async () => {
  const { UsageWindows } = await import("../src/usage/UsageWindows.tsx");
  const [claude] = usageView().tray;
  const usage = { ...claude, note: "Claude Code 没有回应", retry: true };
  const html = render(UsageWindows, {
    usage,
    stacked: true,
    retrying: true,
    onRetry: () => undefined,
  });
  assert.match(
    html,
    /<span class="ss-locked" aria-busy="true"><span class="ss-tipwrap is-idle"><button[^>]*>再试一次<\/button><\/span><\/span><\/p>/,
  );
  // 没给 onRetry（不在托盘或用量页里）：只有原因，不出键
  assert.doesNotMatch(render(UsageWindows, { usage, stacked: true }), /再试一次/);
});

test("R10 用量：托盘里一个窗口两行（2026-09-30 系统菜单风格：上一行名字 ……「剩 93% · 2:58 后重置」，下一行满宽的条），紧张的那个加粗；条与文字同一刻度", async () => {
  const { TrayAgents } = await import("../src/TrayPanel.tsx");
  const agentState = trayAgentState(state(), usageView());
  const html = render(TrayAgents, {
    blocks: trayBlocks(AGENTS, agentState),
    state: agentState,
    host: trayHost,
  });
  const claude = html.slice(html.indexOf('aria-label="Claude"'));
  assert.match(claude, /tray__head-note">2 小时前更新</);
  assert.match(
    claude,
    /usage-wins--stacked[^]*?class="usage-win">[^]*?>5 小时<[^]*?>剩 93%<[^]*?>2:58 后重置<[^]*?width:93%[^]*?class="usage-win is-tight">[^]*?>本周<[^]*?>剩 10%<[^]*?>3 天后重置<[^]*?width:10%/,
  );
  // Codex 块：用量行在第三方模型那一行之前
  const codex = html.slice(0, html.indexOf('aria-label="Claude"'));
  assert.match(codex, /tray__usage[^]*剩 100%[^]*tray__cap-title">第三方模型</);
});

test("R7 用量行下一句状态：被限流、失败原因、没有订阅额度；Codex 没登录时 Codex 块里没有用量行", async () => {
  const { TrayAgents } = await import("../src/TrayPanel.tsx");
  const [claude] = usageView().tray;
  const view = usageView({
    signedIn: ["claude-code"],
    tray: [{ ...claude, windows: [], note: "被限流，约 5 分钟后再试" }],
  });
  const agentState = trayAgentState(state(), view);
  const html = render(TrayAgents, {
    blocks: trayBlocks(AGENTS, agentState),
    state: agentState,
    host: trayHost,
  });
  assert.match(html, /usage-note">被限流，约 5 分钟后再试</);
  assert.doesNotMatch(html, /usage-wins/, "没有窗口就不画空的一排");
  const codex = html.slice(0, html.indexOf('aria-label="Claude"'));
  assert.doesNotMatch(codex, /tray__usage/);
});

test("往注册表加一个 agent、给 Codex 加一节带 trayRow 的 `用量`：面板按表的先后成块成行、画出那一行，面板代码不改", async () => {
  const { TrayAgents } = await import("../src/TrayPanel.tsx");
  const Section = () => createElement("p");
  const UsageRow = ({ title }: { title: string }) =>
    createElement("div", { className: "fake-usage" }, `${title} 42%`);
  // 从真表里的 Codex 出发，先去掉它真的用量节，换成一节假的：测的是「加一节，面板不改」
  const codex = AGENTS[0];
  const usage = { id: "usage", title: "用量", Component: Section, trayRow: UsageRow };
  const registry: AgentEntry[] = [
    { ...codex, sections: [usage, ...codex.sections.filter((s) => s.id !== "usage")] },
    {
      id: "claude-code",
      name: "Claude Code",
      available: () => true,
      indicator: () => false,
      sections: [usage],
    },
    // 有节、但没有一节带托盘画法：不成块（不留空块头）
    {
      id: "cursor",
      name: "Cursor",
      available: () => true,
      indicator: () => false,
      sections: [{ id: "usage", title: "用量", Component: Section }],
    },
  ];
  const agentState = trayAgentState(state());
  const blocks = trayBlocks(registry, agentState);
  assert.deepEqual(
    blocks.map((b) => [b.name, b.rows.map((r) => r.title)]),
    [
      ["Codex", ["用量", "第三方模型"]],
      ["Claude Code", ["用量"]],
    ],
  );
  // 真的画出来：TrayPanel 的块渲染按注册表把假节的 trayRow 画进 Codex 与 Claude Code 两块
  const host = {
    applyGateway: () => undefined,
    idle: async () => undefined,
    alive: () => true,
    openedAt: 0,
    failOver: () => undefined,
  };
  const html = render(TrayAgents, { blocks, state: agentState, host });
  assert.equal((html.match(/class="fake-usage">用量 42%</g) ?? []).length, 2);
  assert.match(html, /aria-label="Codex"[^]*fake-usage[^]*tray__cap-title">第三方模型</);
  assert.match(html, /aria-label="Claude Code"[^]*fake-usage/);
  assert.doesNotMatch(html, /Cursor/);
});

test("AC4 重启 Codex 的后果句：说会发生什么，不写「确定吗」；提示框写明只管桌面应用", () => {
  assert.match(restartConsequence("Codex"), /中断/);
  assert.doesNotMatch(restartConsequence("Codex"), /确定|是否/);
  assert.equal(restartTip("Codex"), "重启 Codex 桌面应用让改动生效，进行中的对话会中断");
});

// 「重启生效」只在有改动等着生效时出现：平时摆着是噪音，还多一个误触的机会
test("R4 没有改动等着生效：不出现「重启生效」", () => {
  assert.equal(trayRow(withModels(2)).showRestart, false);
  assert.equal(trayRow(withModels(2, { enabled: true })).showRestart, false);
});

test("R4 刚启用、Codex 还开着旧配置：出现「重启生效」", () => {
  const row = trayRow(
    withModels(2, {
      enabled: true,
      needsCodexRestart: true,
      router: { running: true, port: 47328, error: "" },
    }),
  );
  assert.equal(row.showRestart, true);
});

test("R4 刚停用也一样：Codex 的列表要重启才会变回去", () => {
  const row = trayRow(withModels(2, { enabled: false, needsCodexRestart: true }));
  assert.equal(row.showRestart, true);
});

test("托盘拨开关：拨了就写（switchGateway，不确认、不重启），滑块当即过去；确认只在「重启生效」上（同 Codex 页）", () => {
  const src = withCopy(readFileSync(new URL("../src/TrayModelsRow.tsx", import.meta.url), "utf8"));
  assert.doesNotMatch(src, /confirmSwitch|gatewayConfirmText|重启并|switched/);
  assert.match(src, /reason = await switchGateway\(next, \{/);
  // 开关与 Codex 页同一份（codexControls）：写配置期间滑块已在拨过去的那一侧
  assert.match(
    src,
    /<CodexSwitch[^>]*switching=\{phase\.kind === "switching" \? phase\.next : null\}/,
  );
  const shared = withCopy(
    readFileSync(new URL("../src/codexControls.tsx", import.meta.url), "utf8"),
  );
  // 状态按家拆开（spec R39）：开关读 Codex 那一份
  assert.match(shared, /const on = switching \?\? codexGateway\(state\)\.enabled;/);
  assert.match(shared, /checked=\{on\}/);
  // 面板里只剩一种确认：重启 Codex，用组件库确认框的窄面板形态
  assert.equal(src.match(/<Confirm\b/g)?.length, 1);
  assert.match(
    src,
    /<Confirm\s+inline\s+id=\{confirmId\}\s+title=\{t\("重启 \{app\}？", \{ app: codexAppName\(current\) \}\)\}/,
  );
  assert.match(src, /\{restartConsequence\(codexAppName\(current\)\)\}\s*<\/Confirm>/);
  assert.doesNotMatch(src, /confirmPanel|tray__confirm-/);
});

test("托盘没有「卸下后台服务」（路由在 Sophia 进程里，没有要卸的后台服务）：关着时键位空着", () => {
  const router = { running: false, port: 47328, error: "" };
  const row = trayRow(withModels(2, { enabled: false, router }));
  assert.equal(row.showRestart, false);
  assert.equal(row.showLaunch, false);
  assert.ok(!("showUninstall" in row));
});

test("「启动 Codex」：开着、Codex 没在跑、不等重启时出现；关着不出现（与 Codex 页同一规则）", () => {
  assert.equal(trayRow(withModels(2, { enabled: true })).showLaunch, true);
  assert.equal(trayRow(withModels(2, { enabled: false })).showLaunch, false);
  const running = { version: "26.0", running: true, catalogVersion: "1", drift: false };
  assert.equal(trayRow(withModels(2, { enabled: true, codex: running })).showLaunch, false);
  assert.equal(
    trayRow(withModels(2, { enabled: true, needsCodexRestart: true })).showLaunch,
    false,
  );
});

// 2026-09-25 简化（DESIGN「托盘面板」）：不列在用的模型；键位在能力行里、开关左边，不另起一行
test("能力行一行说完：`重启生效` 在同一行、开关左边；不列在用的模型", async () => {
  const { TrayAgents } = await import("../src/TrayPanel.tsx");
  const running = { version: "26.0", running: true, catalogVersion: "1", drift: false };
  const agentState = trayAgentState(
    withModels(2, { enabled: true, needsCodexRestart: true, codex: running }),
  );
  const host = {
    applyGateway: () => undefined,
    idle: async () => undefined,
    alive: () => true,
    openedAt: 0,
    failOver: () => undefined,
  };
  const html = render(TrayAgents, {
    blocks: trayBlocks(AGENTS, agentState),
    state: agentState,
    host,
  });
  const cap = html.match(/<div class="tray__cap">[^]*<\/div>/)?.[0] ?? "";
  assert.match(cap, /tray__end">[^]*重启生效[^]*codex-switch/);
  assert.doesNotMatch(html, /tray__models|tray__keys/);
  assert.doesNotMatch(html, />m0|m0、m1/, "模型名不进托盘");
});

test("第三批 4A：能力行标题一行，放不下省略、悬停出全名（截断才提示 TruncTip，撑满键位左边的宽）；简体放得下，照旧整名", async () => {
  const { TrayAgents } = await import("../src/TrayPanel.tsx");
  const running = { version: "26.0", running: true, catalogVersion: "1", drift: false };
  const agentState = trayAgentState(
    withModels(2, { enabled: true, needsCodexRestart: true, codex: running }),
  );
  const host = {
    applyGateway: () => undefined,
    idle: async () => undefined,
    alive: () => true,
    openedAt: 0,
    failOver: () => undefined,
  };
  const html = render(TrayAgents, {
    blocks: trayBlocks(AGENTS, agentState),
    state: agentState,
    host,
  });
  assert.match(
    html,
    /<div class="tray__cap"><span class="ss-tipwrap ss-tipwrap--grow[^"]*"[^>]*><span class="tray__cap-title">第三方模型<\/span>/,
  );
  const css = readFileSync(new URL("../src/TrayPanel.css", import.meta.url), "utf8");
  const rule = css.match(/\.tray__cap-title \{([^}]*)\}/)?.[1] ?? "";
  for (const decl of ["white-space: nowrap;", "overflow: hidden;", "text-overflow: ellipsis;"])
    assert.ok(rule.includes(decl), decl);
});

test("托盘面板只用组件库：菜单两项是 Menu（面板形态），确认是 Confirm 窄面板，失败是 NoticePanel section；不再覆盖内部类", async () => {
  const { default: TrayPanel } = await import("../src/TrayPanel.tsx");
  const html = render(TrayPanel, {});
  assert.match(
    html,
    /class="ss-menulist ss-menulist--panel" role="menu" aria-label="Sophia"[^]*role="menuitem"[^]*>打开 Sophia<[^]*role="menuitem"[^]*>退出</,
  );
  assert.doesNotMatch(html, /⌘Q/);
  for (const file of ["TrayPanel.tsx", "TrayPanel.css", "TrayModelsRow.tsx"]) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\bss-[a-z]/, file);
    assert.doesNotMatch(src, /<svg/, file);
  }
  const row = withCopy(readFileSync(new URL("../src/TrayModelsRow.tsx", import.meta.url), "utf8"));
  assert.match(row, /<NoticePanel\s+scope="section"/);
});

// AC16：面板窗口在应用启动时就建好、藏着（tray.rs），它加载不等于「打开托盘」。
// 加载时只读现有的用量视图，不让后端补取；真正弹出（拿到焦点）才算打开（2026-09-29 真机发现启动即取数）
test("AC16 面板加载时不触发取数，弹出时才触发", () => {
  const src = withCopy(readFileSync(new URL("../src/TrayPanel.tsx", import.meta.url), "utf8"));
  const mount = src.slice(src.indexOf("mounted.current = true;"), src.indexOf("onFocusChanged"));
  assert.match(mount, /readUsage\(false\)/);
  assert.doesNotMatch(mount, /readUsage\(true\)/);
  const focus = src.slice(
    src.indexOf("onFocusChanged"),
    src.indexOf("return () => {", src.indexOf("onFocusChanged")),
  );
  assert.match(focus, /if \(!focused\) return;[^]*readUsage\(true\)/);
});

// ===== Claude 块的「第三方模型」一行（spec 2026-09-29 R44、AC45；DESIGN「托盘面板」「Claude 的页：桌面应用」） =====

const claudeDesktop = (
  overrides: Partial<NonNullable<AgentGatewayView["claude"]>["desktop"]> = {},
) => ({ ...CLAUDE_OFF.claude!.desktop, version: "1.2.0", ...overrides });

/// Claude 那一份：默认装着、没在跑、关着、一家网关选了 1 个模型
const claudeView = (
  overrides: Partial<AgentGatewayView> = {},
  desktop: Parameters<typeof claudeDesktop>[0] = {},
): AgentGatewayView => ({
  ...CLAUDE_OFF,
  installed: true,
  providers: [
    {
      baseUrl: "https://example.com/openai",
      key: "set",
      models: [model("kimi", true), model("glm", false)],
    } as GatewayProvider,
  ],
  ...overrides,
  claude: { ...CLAUDE_OFF.claude!, desktop: claudeDesktop(desktop) },
});

const withClaude = (view: AgentGatewayView) => withModels(2, { claude: view });
const claudeRowOf = (view: AgentGatewayView) => trayClaudeRow(claudeGateway(withClaude(view))!);

test("R44 Claude 行：关着、装好、选了模型——开关关着可拨，没有键位、没有代价那句", () => {
  const row = claudeRowOf(claudeView());
  assert.deepEqual(row, { toggle: { on: false, disabledReason: null }, key: null, cost: false });
});

test("R44 Claude 行：开着时下一行说代价；在运行且待生效出 `重启生效`，没在运行出 `打开 Claude`（同 Claude 的页）", () => {
  const running = claudeRowOf(
    claudeView({ enabled: true }, { running: true, pending: true, needsRestart: true }),
  );
  assert.equal(running.toggle.on, true);
  assert.equal(running.key, "restart");
  assert.equal(running.cost, true);
  assert.equal(claudeAccountCost(), "账号里的对话暂时看不到");
  assert.equal(claudeRowOf(claudeView({ enabled: true })).key, "launch");
  assert.equal(claudeRowOf(claudeView({ enabled: true }, { running: true })).key, null);
  // 关着但在运行、还没切回（切回记为待生效）：同样是 `重启生效`
  assert.equal(
    claudeRowOf(claudeView({}, { running: true, pending: true, needsRestart: true })).key,
    "restart",
  );
});

test("R41 R44 Claude 开关按不动时说「怎么办」（与列表行同一句）；开着时永远能关", () => {
  const reason = (view: AgentGatewayView) => claudeRowOf(view).toggle.disabledReason;
  assert.equal(reason(claudeView({ installed: false })), "装好 Claude 桌面应用后再来打开");
  assert.equal(
    reason(claudeView({}, { managed: true })),
    "这台电脑上的 Claude 由组织统一配置，不能在这里切换",
  );
  assert.equal(reason(claudeView({}, { tooOld: true })), "先把 Claude 更新到最新版");
  assert.equal(
    reason(claudeView({}, { foreign: { id: "x" } })),
    // P5c：托盘里「进去」指代不清，改说去哪里接管（列表行上仍是 `进去接管后才能打开`）；
    // 2026-09-30 侧栏仍叫「模型」，托盘说的那一页也叫模型页
    "在模型页里接管后才能打开",
  );
  assert.equal(reason(claudeView({ providers: [] })), enableNeedsModels());
  assert.equal(
    reason(
      claudeView({
        providers: [
          { baseUrl: "https://a.example.com", key: "set", models: [model("x", false)] },
        ] as GatewayProvider[],
      }),
    ),
    enableNeedsModels(),
  );
  assert.equal(reason(claudeView({ enabled: true, installed: false, providers: [] })), null);
});

test("R44 Claude 行的几句话：开关提示框两段、重启确认正文按方向、`打开 Claude` 的提示框（DESIGN 原话）", () => {
  assert.equal(
    claudeSwitchTip(false),
    "打开后，Claude 桌面应用改用这里选的模型，不再登录 Claude 账号；账号里的对话暂时看不到，切回即恢复。要重开 Claude 才生效；Sophia 需要保持运行，退出时自动改回官方，下次打开再接上",
  );
  assert.equal(
    claudeSwitchTip(true),
    "关掉后，Claude 桌面应用回到 Claude 账号；要重开 Claude 才生效；Sophia 需要保持运行，退出时自动改回官方，下次打开再接上",
  );
  assert.equal(
    claudeRestartConsequence(true),
    "Claude 桌面应用会退出再打开，之后改用这里选的模型、不登录 Claude 账号；账号里的对话暂时看不到，切回即恢复。切换期间的对话只存在这台电脑上",
  );
  assert.equal(
    claudeRestartConsequence(false),
    "Claude 桌面应用会退出再打开，回到 Claude 账号；切换期间的对话留在这台电脑上，下次切过来还在",
  );
  assert.equal(claudeLaunchTip(), "打开 Claude 桌面应用，它会用上现在的模型设置");
  assert.doesNotMatch(claudeRestartConsequence(true), /确定|是否/);
});

const renderTray = async (s: GatewayState, usage: UsageView | null = usageView()) => {
  const { TrayAgents } = await import("../src/TrayPanel.tsx");
  const agentState = trayAgentState(s, usage);
  return render(TrayAgents, {
    blocks: trayBlocks(AGENTS, agentState),
    state: agentState,
    host: trayHost,
  });
};
const claudeBlock = (html: string) => html.slice(html.indexOf('aria-label="Claude"'));

// 2026-09-30 产品负责人：模型页里第二家叫 `Claude Desktop`（这一行只改桌面应用），托盘块装的是 Claude 账号的用量，仍叫 `Claude`；
// 注册表里的 name 不动（托盘与用量用它），模型页的名字由 `modelsName` 单给
test("模型页里第二家叫 `Claude Desktop`（列表行、说到这一家的地方），托盘块头仍是 `Claude`", async () => {
  const { ModelsPage, useAgentName } = await import("../src/shell/ModelsPage.tsx");
  const { modelsNameOf } = await import("../src/shell/agentRegistry.ts");
  const claude = AGENTS.find((a) => a.id === "claude-code")!;
  const codex = AGENTS.find((a) => a.id === "codex")!;
  assert.equal(claude.name, "Claude");
  assert.equal(modelsNameOf(claude), "Claude Desktop");
  assert.equal(modelsNameOf(codex), "Codex");
  assert.equal(typeof useAgentName, "function");
  const gateway = withClaude(claudeView());
  const list = render(ModelsPage, {
    entries: AGENTS,
    state: { gateway, modelsSupported: true, usage: null },
    onError: () => undefined,
    onGatewayState: () => undefined,
  });
  assert.match(list, /<button type="button" class="models-row__open"[^>]*>Codex<\/button>/);
  assert.match(
    list,
    /<button type="button" class="models-row__open"[^>]*>Claude Desktop<\/button>/,
  );
  assert.doesNotMatch(list, /models-row__open"[^>]*>Claude<\/button>/);
  assert.match(list, /aria-label="Claude Desktop · 第三方模型"/);
  const tray = await renderTray(gateway);
  assert.match(tray, /class="tray__name">Claude</);
  assert.doesNotMatch(tray, /Claude Desktop/);
});

test("AC45 托盘：Claude 块在用量之后是 `第三方模型` + [重启生效 12 开关]，开着时下一行 `账号里的对话暂时看不到`", async () => {
  const html = claudeBlock(
    await renderTray(
      withClaude(
        claudeView({ enabled: true }, { running: true, pending: true, needsRestart: true }),
      ),
    ),
  );
  assert.match(
    html,
    /tray__usage[^]*剩 10%[^]*<div class="tray__cap">[^]*?<span class="tray__cap-title">第三方模型<\/span>[^]*?<span class="tray__end">[^]*重启生效[^]*role="switch"[^]*<\/div><p class="tray__cost">账号里的对话暂时看不到<\/p>/,
  );
  assert.match(html, /aria-label="启用 Claude 的第三方模型"/);
  assert.doesNotMatch(html, />kimi</, "模型名不进托盘");
  // Codex 开着也不写这一句：代价只属于 Claude（切过去不登录 Claude 账号）
  const both = await renderTray(
    withModels(2, { enabled: true, claude: claudeView({ enabled: true }) }),
  );
  assert.equal(both.split("tray__cost").length - 1, 1, "只有 Claude 那一块有");
});

test("AC45 托盘：Claude 开着、桌面应用没在跑——键位是 `打开 Claude`；关着——键位与灰字都不出（画板右图）", async () => {
  const on = claudeBlock(await renderTray(withClaude(claudeView({ enabled: true }))));
  assert.match(on, /tray__end">[^]*打开 Claude[^]*role="switch"/);
  assert.doesNotMatch(on, /重启生效/);
  const off = claudeBlock(await renderTray(withClaude(claudeView())));
  // 提示框（悬停才出）里说代价是另一回事：这里只看画出来的键与灰字那一行
  assert.doesNotMatch(off, />重启生效<|>打开 Claude<|tray__cost/);
  assert.match(off, /tray__cap-title">第三方模型<[^]*role="switch"[^]*aria-checked="false"/);
});

test("AC42 不成空块：本机支持、Claude 用量没登录、桌面应用也没装——Claude 块照样有第三方模型一行（开关禁用、说原因），每一块都有画出来的行", async () => {
  const codexOnly = usageView({ signedIn: ["codex"], tray: usageView().tray.slice(1) });
  for (const view of [claudeView({ installed: false, providers: [] }), CLAUDE_OFF]) {
    const html = await renderTray(withClaude(view), codexOnly);
    const claude = claudeBlock(html);
    assert.match(claude, /tray__head">[^]*>Claude<[^]*tray__cap-title">第三方模型</);
    assert.match(claude, /role="switch"[^]*disabled|disabled[^]*role="switch"/);
    const sections = html.split('<section class="tray__agent"').slice(1);
    assert.equal(sections.length, 2);
    for (const section of sections) assert.match(section, /tray__cap|tray__usage/);
  }
});

test("R44 托盘的 Claude 行：拨了就写（gatewayEnable / gatewayRestore 带 claude）、不确认；`重启生效` 在面板里当场展开 `重启 Claude？`；`打开 Claude` 不确认；失败灰面板 + `再试一次`", () => {
  const src = readFileSync(new URL("../src/TrayClaudeRow.tsx", import.meta.url), "utf8");
  assert.match(src, /api\.gatewayEnable\("claude"\)/);
  assert.match(src, /api\.gatewayRestore\("claude"\)/);
  assert.match(src, /api\.gatewayRestartClaude\(\)/);
  assert.match(src, /api\.gatewayLaunchClaude\(\)/);
  // 只有一种确认：重启，窄面板形态，正文按方向
  assert.equal(src.match(/<Confirm\b/g)?.length, 1);
  assert.match(
    src,
    /<Confirm\s+inline\s+id=\{confirmId\}\s+title=\{t\("models\.restart\.confirmTitle", \{ app: "Claude" \}\)\}/,
  );
  assert.match(src, /\{claudeRestartConsequence\(view\.enabled\)\}\s*<\/Confirm>/);
  // 乐观翻转：写的时候滑块已经在拨过去的那一侧
  assert.match(src, /const on = phase\.kind === "switching" \? phase\.next : view\.enabled;/);
  assert.match(src, /<NoticePanel\s+scope="section"/);
  assert.match(src, /label: t\("models\.notice\.retry"\)/);
  // Esc 先收回那一问（捕获阶段）；面板每次弹出上次没答的确认作废
  assert.match(src, /addEventListener\("keydown", onKeyDown, true\)/);
  assert.match(src, /\[tray\.openedAt\]/);
  // 注册表经 TrayModelsRow 取这一行
  const row = readFileSync(new URL("../src/TrayModelsRow.tsx", import.meta.url), "utf8");
  assert.match(row, /export \{ TrayClaudeModels \} from "\.\/TrayClaudeRow\.tsx";/);
  assert.equal(AGENTS[1].sections[1].trayRow?.name, "TrayClaudeModels");
  assert.doesNotMatch(src, /\bss-[a-z]/);
  assert.doesNotMatch(src, /<svg/);
});

test("托盘两家的能力行同一骨架：名字撑满键位左边（TruncTip grow），开关贴右沿", () => {
  for (const file of ["TrayModelsRow.tsx", "TrayClaudeRow.tsx"]) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.match(
      src,
      /<TruncTip content=\{title\} fit="grow">\s*<span className="tray__cap-title">\{title\}<\/span>/,
      file,
    );
  }
});
