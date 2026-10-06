import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { render } from "./ui-render.ts";
import type { AgentEntry, AgentListRowProps, AgentState } from "../src/shell/agentRegistry.ts";
import type { GatewayProvider, GatewayState } from "../src/types.ts";
import { CLAUDE_OFF, gatewayFixture, type CodexFixture } from "./gateway-fixture.ts";

// 模型列表页与各家的推入页（spec 2026-09-29 R41 R42；DESIGN「### 模型 › 列表页」「每家的页（推入页，共同骨架）」）

const { ModelsPage, AgentPage } = await import("../src/shell/ModelsPage.tsx");
const { listModelNames, codexListStatus } = await import("../src/modelsView.ts");
const { CodexListControls } = await import("../src/codexControls.tsx");
const ModelsTab = (await import("../src/ModelsTab.tsx")).default;

const noop = () => undefined;

const provider = (overrides: Partial<GatewayProvider> = {}): GatewayProvider => ({
  id: "ap",
  name: "ap-gateway",
  baseUrl: "https://ap.example.com/v1",
  protocol: "chat",
  key: "set",
  models: [],
  ...overrides,
});

const gateway = (overrides: Partial<CodexFixture> = {}): GatewayState =>
  gatewayFixture({
    supported: true,
    providers: [provider()],
    enabled: false,
    needsCodexRestart: false,
    router: { running: false, port: 47328, error: "" },
    codex: { version: "26.0", running: true, catalogVersion: "1", drift: false },
    conflict: "",
    takeover: null,
    ...overrides,
  });

const stateOf = (g: GatewayState | null): AgentState => ({
  gateway: g,
  modelsSupported: true,
  usage: null,
});

/// 右端控件列的替身：画出它拿到的 agent，断言控件列落在哪
const Stub = ({ agent }: AgentListRowProps) => createElement("i", null, `控件-${agent}`);

const entry = (id: string, name: string, status: string): AgentEntry => ({
  id,
  name,
  available: () => true,
  indicator: () => false,
  sections: [
    { id: "usage", title: "用量", trayRow: () => createElement("p", null, "托盘行") },
    {
      id: "third-party-models",
      title: "第三方模型",
      Component: () => createElement("p", null, `${name} 的页`),
      listRow: { status: () => status, Controls: Stub },
    },
  ],
});

const page = (entries: AgentEntry[], g: GatewayState | null = gateway()) =>
  render(ModelsPage, { entries, state: stateOf(g), onError: noop, onGatewayState: noop });

/// 列表里每一行的 HTML，按出现顺序
const rows = (html: string) => html.split(/(?=<div class="models-row[" ])/).slice(1);

// 2026-09-30：第二行改写模型名（DESIGN「列表页」）；页面名仍是 `模型`（与侧栏同名，取代同日改名 `第三方模型`）
test("列表页：页面头只有 `模型`；一家一行，按注册表先后——图标 + 名字，第二行一句现状，右端控件列；推入页此刻不画", () => {
  const html = page([
    entry("codex", "Codex", "glm-5、kimi-k2.5"),
    entry("claude-code", "Claude Desktop", "kimi-k2.5、glm-5、deepseek-v3.2"),
  ]);
  assert.match(html, /page-head__title[^>]*>模型</);
  assert.doesNotMatch(html, /aria-label="返回"/);
  const [codex, claude] = rows(html);
  assert.ok(codex && claude);
  assert.equal(rows(html).length, 2);
  // 名字是可以按的（键盘也能推入；返回时焦点还给它）
  assert.match(codex, /<button type="button" class="models-row__open"[^>]*>Codex<\/button>/);
  assert.match(codex, /models-row__sub">glm-5、kimi-k2\.5</);
  assert.match(codex, /models-row__end"><i>控件-codex<\/i>/);
  assert.match(claude, /models-row__sub">kimi-k2\.5、glm-5、deepseek-v3\.2</);
  assert.match(claude, /<i>控件-claude-code<\/i>/);
  // 图标在名字前（codex 有自己的图形）
  assert.ok(codex.indexOf("<svg") < codex.indexOf("models-row__open"));
  // 行尾不加 ›（那是网关行、表格行的拉手），也不在列表页上画各家的页、托盘行
  assert.doesNotMatch(html, /drawerhandle|›|Codex 的页|托盘行/);
});

test("列表页：状态还没读回来时现状句为空也照样出行；没有节的 agent 不列", () => {
  const html = page([entry("codex", "Codex", "")], null);
  assert.equal(rows(html).length, 1);
  assert.doesNotMatch(html, /models-row__sub/);
});

test("列表页样式：整行悬停出 surface 带、行间 row-line、表头位置一条 hairline；限宽 776；行尾没有拉手列", () => {
  const css = readFileSync(new URL("../src/shell/ModelsPage.css", import.meta.url), "utf8");
  assert.match(css, /\.models-list \{[^}]*border-top: var\(--border-structure\)/);
  assert.match(css, /\.models-row \{[^}]*border-bottom: var\(--border-row\)/);
  assert.match(css, /\.models-row__main:hover[^{]*\{[^}]*background: var\(--surface\)/);
  assert.doesNotMatch(css, /cursor:\s*pointer/);
  const tsx = readFileSync(new URL("../src/shell/ModelsPage.tsx", import.meta.url), "utf8");
  // 点整行推入、返回时焦点还给这一行；推入状态不进 Nav，返回也经「离开前询问」
  assert.match(tsx, /usePushedPage\(/);
  assert.match(tsx, /requestLeave\(/);
  assert.match(tsx, /usePageCommand\("back"/);
  assert.doesNotMatch(tsx, /navigate\(|goDestination/);
});

// 2026-09-30 产品负责人看真机（「这个排版也很奇怪，不如之前这样，但是得改下标题」）：取代「开关紧跟页面标题」——
// 页面头只写是哪一家、不放控件，开关回到下一行能力行。下面两条随之改写
test("推入页骨架 AgentPage：页面头只有 `←` + 这一家的名字、不放控件；下一行能力行＝能力名（head）+ 开关 + 条件键；提示条在能力行之上、内容在它之下", () => {
  const html = render(AgentPage, {
    title: "Codex",
    capability: "第三方模型",
    control: createElement("b", null, "开关"),
    actions: createElement("u", null, "重启生效"),
    lead: createElement("s", null, "提示条"),
    children: createElement("p", null, "内容"),
  });
  assert.match(html, /aria-label="返回"[^]*page-head__title[^>]*>Codex</);
  // 页面头右端那一格空着：开关与键不在页面头里
  assert.match(html, /class="page-head__actions"[^>]*><\/div>/);
  const head = html.slice(0, html.indexOf("models-agent"));
  assert.doesNotMatch(head, /开关|重启生效/);
  // 能力行：节头骨架（能力名 + 12 + 开关 + 12 + 键）
  assert.match(
    html,
    /models-agent"><s>提示条<\/s><div class="models-agent__cap"><div class="ss-section"><div class="ss-section__head"><h2 class="ss-section__title">第三方模型<\/h2><div class="ss-section__control"><b>开关<\/b><\/div><div class="ss-section__actions"><u>重启生效<\/u><\/div><\/div><\/div><\/div><p>内容<\/p>/,
  );
  // 读状态时不给能力名：没有能力行
  const loading = render(AgentPage, { title: "Claude", children: createElement("p", null, "读") });
  assert.doesNotMatch(loading, /models-agent__cap|ss-section/);
  const css = readFileSync(new URL("../src/shell/ModelsPage.css", import.meta.url), "utf8");
  // 能力行在页面头下 12；页面头不再把控件挪到页面名后
  assert.match(css, /\.models-agent__cap \{[^}]*margin-top: var\(--space-sm\)/);
  assert.doesNotMatch(css, /page-head__actions|models-agent__head/);
});

test("Codex 的页：页面名 `Codex`，能力行 `第三方模型`（不写 `Codex ·`）+ 开关与条件键；新手提示条在能力行之上", () => {
  // 新手提示读外部存储（useSyncExternalStore），整页渲染不了静态 HTML：骨架由上一条 AgentPage 的渲染测试管，这里查接线
  assert.equal(typeof ModelsTab, "function");
  const src = readFileSync(new URL("../src/ModelsTab.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /<Section\b|title=\{`[^`]*的第三方模型`\}/);
  assert.match(src, /modelsCapability,/);
  assert.match(
    src,
    /<AgentPage\s+title=\{tool\.name\}\s+capability=\{modelsCapability\(\)\}[^]*lead=\{hint\}[^]*control=\{[^]*<CodexSwitch[^]*actions=\{[^]*<CodexKeySlot/,
  );
  // 推入页带着 transform：确认框挂到 body 上，遮罩才整面压暗；确认开着时 Esc 只取消确认
  assert.match(src, /bodyLayer\(\s*<Confirm/);
  assert.match(src, /escape=\{!confirmRestart && !gatewayConfirming\}/);
});

test("列表行第二行的模型名规则：≤ 3 个全写、`、` 分隔；超过 3 个写前两个 + `等 N 个`；一个没选 `还没选模型`", () => {
  assert.equal(listModelNames([]), "还没选模型");
  assert.equal(listModelNames(["glm-5"]), "glm-5");
  assert.equal(listModelNames(["glm-5", "kimi-k2.5"]), "glm-5、kimi-k2.5");
  assert.equal(
    listModelNames(["kimi-k2.5", "glm-5", "deepseek-v3.2"]),
    "kimi-k2.5、glm-5、deepseek-v3.2",
  );
  assert.equal(listModelNames(["glm-5", "kimi-k2.5", "a", "b", "c"]), "glm-5、kimi-k2.5 等 5 个");
  // 名字＝模型片上的名字：两家网关撞名时带 ` · 网关短名`，与片、Codex 选择器里看到的一样
  const dup = (id: string) => ({
    id: "kimi-k2.5",
    slug: `${id}-kimi-k2.5`,
    displayName: "kimi-k2.5",
    selected: true,
  });
  const g = gateway({
    providers: [
      provider({ id: "ap", shortName: "ap-gateway", models: [dup("ap")] }),
      provider({ id: "or", name: "openrouter", shortName: "openrouter", models: [dup("or")] }),
    ],
  });
  assert.equal(codexListStatus(stateOf(g)), "kimi-k2.5 · ap-gateway、kimi-k2.5 · openrouter");
});

test("Codex 那一行的右端控件：开关（标准）+ 条件键同 Codex 的页；按不动时说怎么办", () => {
  const picked = [provider({ models: [{ id: "m", slug: "m", displayName: "M", selected: true }] })];
  const on = render(CodexListControls, {
    agent: "codex",
    state: stateOf(gateway({ providers: picked, enabled: true, needsCodexRestart: true })),
    onNotice: noop,
    onError: noop,
    onGatewayState: noop,
  });
  assert.match(on, /role="switch" aria-checked="true"/);
  assert.match(on, />重启生效</);
  // 键在开关左边 12（与托盘同一位）
  assert.ok(on.indexOf("重启生效") < on.indexOf('role="switch"'));
  const empty = render(CodexListControls, {
    agent: "codex",
    state: stateOf(gateway({ providers: [] })),
    onNotice: noop,
    onError: noop,
    onGatewayState: noop,
  });
  assert.match(empty, /role="switch" aria-checked="false"[^]*disabled/);
  assert.match(empty, /先进去选好模型再打开/);
  const managed = render(CodexListControls, {
    agent: "codex",
    state: stateOf(gateway({ takeover: { baseUrl: "https://x", selectedCount: 1 } })),
    onNotice: noop,
    onError: noop,
    onGatewayState: noop,
  });
  assert.match(managed, /进去接管后才能打开/);
  // 状态还没读回来：什么都不画
  assert.equal(
    render(CodexListControls, {
      agent: "codex",
      state: stateOf(null),
      onNotice: noop,
      onError: noop,
      onGatewayState: noop,
    }),
    "",
  );
});

test("列表页里 Claude 开着时的 R46：Codex 关着、Claude 开着，Codex 那一行不出 `卸下后台服务`", () => {
  const html = render(CodexListControls, {
    agent: "codex",
    state: stateOf(
      gateway({
        router: { running: true, port: 1, error: "" },
        claude: { ...CLAUDE_OFF, installed: true, enabled: true },
      }),
    ),
    onNotice: noop,
    onError: noop,
    onGatewayState: noop,
  });
  assert.doesNotMatch(html, /卸下后台服务/);
});

// ===== 读不到第三方模型的状态（spec 2026-10-04-local-diagnostics R11 / AC10，画板 AuPbAQHePv3L1U3g1PAtH8）=====
// 入口不消失；页面顶上一块灰面板说是哪个文件、为什么，按种类给往前走的路；原文挂在那句话上（停上去出悬浮卡）

const unreadable = (kind: "permission" | "format" | "other", reason: string): GatewayState => ({
  ...gateway(),
  unreadable: {
    kind,
    path: "/Users/me/.codex/config.toml",
    line: kind === "format" ? 3 : null,
    reason,
    detail: "open ~/.codex/config.toml\nPermission denied (os error 13)",
  },
});

test("读不到状态 · 没权限：灰面板「读不到第三方模型的状态 · <文件> 不归你的账户所有…」（句上挂悬浮卡）+ `修复权限`；列表照常", () => {
  const reason = "~/.codex/config.toml 不归你的账户所有，读不了（多半是用 sudo 运行过 Codex）";
  const html = page([entry("codex", "Codex", "glm-5")], unreadable("permission", reason));
  assert.match(
    html,
    new RegExp(
      `ss-noticepanel--section[^]*<span class="ss-hovercard"[^>]*>读不到第三方模型的状态<span class="ss-noticepanel__reason"> · ${reason.replace(/[()]/g, "\\$&")}</span></span>`,
    ),
  );
  assert.match(html, /ss-noticepanel__actions">[^]*>修复权限</);
  assert.doesNotMatch(html, />详情</);
  assert.doesNotMatch(html, /Permission denied/, "原文只在悬浮卡里");
  assert.doesNotMatch(html, />再试一次</);
  assert.equal(rows(html).length, 1);
});

test("读不到状态 · 格式有误：`打开文件 ↗`（浅键，离开 Sophia）+ `再试一次`", () => {
  const html = page(
    [entry("codex", "Codex", "")],
    unreadable("format", "~/.codex/config.toml 第 3 行格式有误"),
  );
  assert.match(html, /第 3 行格式有误/);
  assert.match(
    html,
    /ss-noticepanel__actions">[^]*class="ss-btn ss-btn--quiet"[^>]*>打开文件<[^]*>再试一次</,
  );
});

test("读不到状态 · 别的：`再试一次`（原文挂在句上）；状态整个读不回来（IPC 失败）也照样出这块，入口不消失", () => {
  const html = page(
    [entry("codex", "Codex", "")],
    unreadable("other", "~/.codex/config.toml 读不了"),
  );
  assert.match(html, /ss-hovercard[^]*>再试一次</);
  assert.doesNotMatch(html, /修复权限|打开文件|>详情</);
  const lost = render(ModelsPage, {
    entries: [entry("codex", "Codex", "")],
    state: {
      ...stateOf(null),
      gatewayError: { kind: "other", path: "", line: null, reason: "", detail: "[internal] boom" },
    },
    onError: noop,
    onGatewayState: noop,
  });
  assert.match(lost, /读不到第三方模型的状态/);
  assert.match(lost, /ss-hovercard[^]*>再试一次</);
});
