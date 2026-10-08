import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { render } from "./ui-render.ts";
import type { AgentEntry, AgentListRowProps, AgentState } from "../src/shell/agentRegistry.ts";
import type { AgentModels, GatewayState } from "../src/types.ts";
import { NO_MODELS, gatewayFixture, picked, type CodexFixture } from "./gateway-fixture.ts";

// 模型页一层（#259，画板 9UGdeLt4rvg2dm8SpStvHo 第 1、1′、2 屏；DESIGN「### 模型」）：一个 agent 一行、没有二级页，
// 行尾 `已选 N 个模型 ▾` 打开选模型浮层

const { ModelsPage } = await import("../src/shell/ModelsPage.tsx");
const { PickModels } = await import("../src/PickModels.tsx");
const { CodexListControls } = await import("../src/codexControls.tsx");
const PICK = await import("../src/pickView.ts");

const noop = () => undefined;

const gateway = (overrides: Partial<CodexFixture> = {}): GatewayState =>
  gatewayFixture({
    supported: true,
    models: picked("官方/gpt-6", "Kimi/kimi-k2.6", "DeepSeek/v4"),
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

/// 右端控件列的替身：画出它拿到的 agent 与行尾的选模型键，断言控件列落在哪、选模型键夹在中间
const Stub = ({ agent, pick }: AgentListRowProps) =>
  createElement("i", null, `键-${agent}`, pick, `开关-${agent}`);
const Todo = ({ agent }: AgentListRowProps) => createElement("b", null, `待办-${agent}`);

const entry = (
  id: string,
  name: string,
  gatewayAgent: "codex" | "claude",
  status: string,
  note: string | null = null,
): AgentEntry => ({
  id,
  name,
  gateway: gatewayAgent,
  available: () => true,
  indicator: () => false,
  sections: [
    { id: "usage", title: "用量", trayRow: () => createElement("p", null, "托盘行") },
    {
      id: "third-party-models",
      title: "第三方模型",
      listRow: { status: () => status, note: () => note, Controls: Stub, Todos: Todo },
    },
  ],
});

const page = (entries: AgentEntry[], g: GatewayState | null = gateway()) =>
  render(ModelsPage, { entries, state: stateOf(g), onError: noop, onGatewayState: noop });

/// 列表里每一行的 HTML，按出现顺序
const rows = (html: string) => html.split(/(?=<div class="models-row[" ])/).slice(1);

test("一层：页面头 `模型` + `模型提供商`；一个 agent 一行——图标 + 名字，第二行按提供商计数后接灰字；右端 [条件键 · 已选 N 个模型 ▾ · 开关]；行下待办条；没有推入页", () => {
  const html = page([
    entry("codex", "Codex", "codex", "官方 1 · Kimi 1 · DeepSeek 1"),
    entry(
      "claude-code",
      "Claude Desktop",
      "claude",
      "没接第三方模型",
      "切换期间不登录 Claude 账号",
    ),
  ]);
  assert.match(html, /page-head__title[^>]*>模型</);
  assert.match(html, />模型提供商</);
  assert.doesNotMatch(html, /aria-label="返回"|models-row__open/);
  const [codex, claude] = rows(html);
  assert.equal(rows(html).length, 2);
  assert.match(codex, /class="models-row__name">Codex</);
  assert.match(codex, /models-row__sub">官方 1 · Kimi 1 · DeepSeek 1</);
  assert.match(
    codex,
    /models-row__end"><i>键-codex<span class="models-row__pick">[^]*aria-haspopup="dialog"[^]*>已选 3 个模型[^]*<\/span>开关-codex<\/i>/,
  );
  assert.match(codex, /models-row__todos"><b>待办-codex<\/b>/);
  // Claude 那一份没选：按钮写 `选模型`；灰字接在第二行后面
  assert.match(claude, />选模型</);
  assert.match(
    claude,
    /models-row__sub">没接第三方模型<span class="models-row__note">切换期间不登录 Claude 账号<\/span>/,
  );
  // 图标在名字前
  assert.ok(codex.indexOf("<svg") < codex.indexOf("models-row__name"));
  assert.doesNotMatch(html, /drawerhandle|›|托盘行/);
});

test("没装、或本机没有能接第三方模型的 agent：一行都没有时说一句（装好 Codex 或 Claude 桌面应用后再来）", () => {
  const html = page([]);
  assert.match(html, /这台电脑上还没有能接第三方模型的 agent/);
  assert.equal(rows(html).length, 0);
});

test("行的样式：不推入任何页，整行不悬停；行间 row-line、表头位置一条 hairline；没有推入页的接线", () => {
  const css = readFileSync(new URL("../src/shell/ModelsPage.css", import.meta.url), "utf8");
  assert.match(css, /\.models-list \{[^}]*border-top: var\(--border-structure\)/);
  assert.match(css, /\.models-row \{[^}]*border-bottom: var\(--border-row\)/);
  assert.doesNotMatch(css, /models-row__main:hover|cursor:\s*pointer|models-agent/);
  const tsx = readFileSync(new URL("../src/shell/ModelsPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(tsx, /usePushedPage\(|AgentPage|PushedAgent|navigate\(|goDestination/);
  // 勾选先画成做成之后的样子，再写；没成重读、行下说原因
  assert.match(tsx, /pickOptimistic\(/);
  assert.match(tsx, /api\.gatewayPick\(agent, ref, on\)/);
});

// ===== 选模型浮层（画板第 1、1′、2 屏） =====

const trigger = { closest: () => null } as unknown as HTMLElement;
const models = (over: Partial<AgentModels> = {}): AgentModels => ({
  picked: [
    {
      ref: { provider: "kimi", model: "kimi-k2.6" },
      displayName: "kimi-k2.6",
      providerName: "Kimi",
    },
    { ref: { provider: "@official", model: "gpt-6" }, displayName: "GPT-6", providerName: "" },
  ],
  groups: [
    {
      provider: "@official",
      name: "",
      blocked: null,
      models: [
        {
          ref: { provider: "@official", model: "gpt-6" },
          displayName: "GPT-6",
          contextWindow: null,
          picked: true,
        },
        {
          ref: { provider: "@official", model: "gpt-6-mini" },
          displayName: "GPT-6 mini",
          contextWindow: null,
          picked: false,
        },
      ],
    },
    {
      provider: "kimi",
      name: "Kimi",
      blocked: null,
      models: [
        {
          ref: { provider: "kimi", model: "kimi-k2.6" },
          displayName: "kimi-k2.6",
          contextWindow: 262144,
          picked: true,
        },
      ],
    },
    {
      provider: "packy",
      name: "PackyCode",
      blocked: "protocol",
      models: [
        {
          ref: { provider: "packy", model: "claude-opus-5" },
          displayName: "claude-opus-5",
          contextWindow: null,
          picked: false,
        },
      ],
    },
  ],
  providers: 2,
  ...over,
});
const layer = (m: AgentModels, agent: "codex" | "claude" = "codex", name = "Codex") =>
  render(PickModels, {
    agent,
    name,
    models: m,
    trigger,
    onPick: noop,
    onManage: noop,
    onClose: noop,
  });

test("浮层：标题 `Codex 的模型`、搜索框常显、紧凑页签 `全部 / 已选 2`；「全部」按提供商分组、官方一组在前，用不了的组照样列出、置灰，原因在组头说一次", () => {
  const html = layer(models());
  assert.match(html, /role="dialog" aria-label="Codex 的模型"/);
  assert.match(html, /pick-layer__title">Codex 的模型</);
  // 名字以汉字收尾时不再空一格（走查 2026-10-08：「Claude 桌面应用 的模型」）
  const desktop = layer(models(), "claude", "Claude 桌面应用");
  assert.match(desktop, /pick-layer__title">Claude 桌面应用的模型</);
  assert.match(html, /placeholder="搜索模型"/);
  assert.match(
    html,
    /ss-tabs ss-tabs--compact[^]*>全部<[^]*>已选<span class="ss-tabs__count">2<\/span>/,
  );
  // 页签与搜索框同一行（画板第 1、2 屏；走查 2026-10-07 第 12 条）：搜索框占满余下的宽，页签在右
  assert.match(
    html,
    /class="pick-layer__bar"><label class="ss-textfield ss-textfield--search"[^]*?<\/label><div class="pick-layer__tabs"/,
  );
  const pickCss = readFileSync(new URL("../src/PickModels.css", import.meta.url), "utf8");
  assert.match(
    pickCss,
    /\.pick-layer__bar\s*\{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/,
  );
  const order = [
    'pick-layer__group-name">官方<',
    'pick-layer__group-name">Kimi<',
    'pick-layer__group-name">PackyCode<',
  ].map((s) => html.indexOf(s));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], String(order));
  assert.match(
    html,
    /PackyCode<\/span><span class="pick-layer__group-why">Codex 用不了：这家的接口它接不上</,
  );
  // 置灰组里的模型不可选，按下说原因
  assert.match(html, /claude-opus-5[^]*?disabled|disabled[^]*claude-opus-5/);
  assert.match(html, /256K/);
});

// 产品负责人 2026-10-08：启用与选分成两步——在提供商那里启用只进它的已启用名单，不再默认选进各 agent；
// 浮层底部那句「新启用的模型默认选上」随之删掉，「全部」的底部只留「管理模型提供商」
test("浮层「全部」的底部只有「管理模型提供商」，不再说新启用的默认选上", () => {
  const html = layer(models());
  assert.match(
    html,
    /class="pick-layer__foot"><span class="ss-tipwrap[^"]*"><button[^>]*>管理模型提供商/,
  );
  assert.doesNotMatch(html, /默认选上/);
  assert.doesNotMatch(html, /pick-layer__foot"><span class="pick-layer__note"/);
});

test("浮层：Codex 没登录 OpenAI 时官方组置灰并说明；Claude 的官方组接第三方时用不了；WorkBuddy 那种它自己管的只能看", () => {
  const signedOut = models();
  signedOut.groups[0] = { ...signedOut.groups[0], blocked: "signedOut" };
  assert.match(
    layer(signedOut),
    /官方<\/span><span class="pick-layer__group-why">Codex 没登录 OpenAI，官方模型用不了</,
  );
  const claude = models();
  claude.groups[0] = { ...claude.groups[0], blocked: "officialUnavailable" };
  assert.match(
    layer(claude, "claude", "Claude Desktop"),
    /官方<\/span><span class="pick-layer__group-why">接第三方模型时用不了，关掉这一行的开关就回来</,
  );
});

test("浮层：一家提供商都没有——官方组下说一句、给 `添加模型提供商`", () => {
  const html = layer(models({ groups: [models().groups[0]], providers: 0 }));
  assert.match(html, /还没有模型提供商，加一家才有第三方模型可选[^]*>添加模型提供商</);
});

test("浮层的空态与「已选」：搜不到说可能还没启用；「已选」空着说去「全部」里选；按顺序列出、× 拿掉；Claude 的说第一个是切过去时先用的", () => {
  const { pickEmptyText, pickedFootnote, filterGroups } = PICK;
  assert.equal(
    pickEmptyText(models(), "all", "glm-5.3"),
    "没有找到「glm-5.3」，它可能还没在提供商那里启用",
  );
  assert.equal(pickEmptyText(models(), "all", "KIMI"), null);
  assert.equal(
    filterGroups(models().groups, "mini")
      .map((g) => g.provider)
      .join(),
    "@official",
  );
  assert.equal(
    pickEmptyText(models({ picked: [] }), "picked", ""),
    "还没选模型，去「全部」里选几个",
  );
  assert.equal(pickedFootnote("codex"), "新选的排在最后");
  assert.equal(pickedFootnote("claude"), "第一个是切过去时先用的模型；新选的排在最后");
  // 渲染「已选」页签：浮层由 useState 控制页签，这里看源码里的落点
  const tsx = readFileSync(new URL("../src/PickModels.tsx", import.meta.url), "utf8");
  assert.match(tsx, /<ol[^]*className="pick-layer__picked"[^]*data-slot="order"[^]*IconClose/);
});

// CODING_STANDARDS「页面 CSS 不写行与悬停带」：可拖的「已选」行走 ui 的 `data-rowband` 钩子，拖着那一行给 "lit"
test("「已选」行的悬停带交给 ui 的 data-rowband 钩子，PickModels.css 不自写行带", () => {
  const tsx = readFileSync(new URL("../src/PickModels.tsx", import.meta.url), "utf8");
  assert.match(tsx, /data-rowband=\{held \? "lit" : ""\}/);
  const css = readFileSync(new URL("../src/PickModels.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /pick-layer__item[^{]*:hover\s*\{[^}]*background/);
  assert.doesNotMatch(css, /\.pick-layer__item[^{]*\{[^}]*(background|border-radius)/);
  const ui = readFileSync(new URL("../src/ui/ui.css", import.meta.url), "utf8");
  assert.match(
    ui,
    /\[data-rowband\]:hover,\s*\[data-rowband="lit"\]\s*\{[^}]*background: var\(--surface\)/,
  );
});

test("Codex 那一行的右端控件：条件键 · 选模型键 · 开关；没选第三方模型时开关按下说「先在「选模型」里选一个模型」", () => {
  const html = render(CodexListControls, {
    agent: "codex",
    state: stateOf(gateway({ models: picked("官方/gpt-6") })),
    pick: createElement("span", { className: "pick-here" }, "已选 1 个模型"),
    onNotice: noop,
    onError: noop,
    onGatewayState: noop,
  });
  assert.match(html, /pick-here[^]*role="switch"/);
  assert.match(html, /role="tooltip"[^>]*>先在「选模型」里选一个模型</);
  assert.equal(NO_MODELS.picked.length, 0);
});

// ===== 读不到第三方模型的状态（spec 2026-10-04-local-diagnostics R11 / AC10，画板 AuPbAQHePv3L1U3g1PAtH8）=====
// 入口不消失；页面顶上一块灰面板说是哪个文件、为什么，按种类给往前走的路；原文从左端的 `!` 看（停上去出悬浮卡）

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

test("读不到状态 · 没权限：灰面板「读不到第三方模型的状态 · <文件> 不归你的账户所有…」（左端 `!` 是入口）+ `修复权限`；列表照常", () => {
  const reason = "~/.codex/config.toml 不归你的账户所有，读不了（多半是用 sudo 运行过 Codex）";
  const html = page([entry("codex", "Codex", "codex", "Kimi 1")], unreadable("permission", reason));
  assert.match(
    html,
    new RegExp(
      `ss-noticepanel--section[^]*ss-markbtn[^]*<span class="ss-noticepanel__message">读不到第三方模型的状态<span class="ss-noticepanel__reason"> · ${reason.replace(/[()]/g, "\\$&")}</span>`,
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
    [entry("codex", "Codex", "codex", "")],
    unreadable("format", "~/.codex/config.toml 第 3 行格式有误"),
  );
  assert.match(html, /第 3 行格式有误/);
  assert.match(
    html,
    /ss-noticepanel__actions">[^]*class="ss-btn ss-btn--quiet"[^>]*>打开文件<[^]*>再试一次</,
  );
});

test("读不到状态 · 别的：`再试一次`（原文从 `!` 看）；状态整个读不回来（IPC 失败）也照样出这块，入口不消失", () => {
  const html = page(
    [entry("codex", "Codex", "codex", "")],
    unreadable("other", "~/.codex/config.toml 读不了"),
  );
  assert.match(html, /ss-markbtn[^]*>再试一次</);
  assert.doesNotMatch(html, /修复权限|打开文件|>详情</);
  const lost = render(ModelsPage, {
    entries: [entry("codex", "Codex", "codex", "")],
    state: {
      ...stateOf(null),
      gatewayError: { kind: "other", path: "", line: null, reason: "", detail: "[internal] boom" },
    },
    onError: noop,
    onGatewayState: noop,
  });
  assert.match(lost, /读不到第三方模型的状态/);
  assert.match(lost, /ss-markbtn[^]*>再试一次</);
});

// 走查 2026-10-07 第 11 条：提供商页与两种模型浮层的左线。提供商行没有抽屉，不留拉手列，名字落在页头分隔线那条左线上；
// 浮层里标题、搜索框、勾选框、底部手填框同一条左线（浮层内边距 16）——勾选行左右各 8 的悬停带由放它的容器让出
test("左线对齐：提供商行不留拉手列；浮层里勾选行由容器让出悬停带的 8，手填框不另缩进", async () => {
  const { ListRow } = await import("../src/ui/ListRow.tsx");
  const bare = render(ListRow, { title: "DeepSeek", sub: "api.deepseek.com", drawerColumn: false });
  assert.doesNotMatch(bare, /ss-listrow__handle/);
  assert.match(render(ListRow, { title: "DeepSeek" }), /ss-listrow__handle/, "默认照旧留拉手列");
  const page = readFileSync(new URL("../src/ProvidersPage.tsx", import.meta.url), "utf8");
  assert.match(page, /<ListRow[^>]*?\n\s*drawerColumn=\{false\}/);
  assert.match(page, /className="providers-layer__checks"/);
  const pageCss = readFileSync(new URL("../src/ProvidersPage.css", import.meta.url), "utf8");
  assert.match(
    pageCss,
    /\.providers-layer__checks\s*\{[^}]*margin-inline: calc\(var\(--space-xs\) \* -1\)/,
  );
  const pick = readFileSync(new URL("../src/PickModels.tsx", import.meta.url), "utf8");
  assert.match(pick, /className="pick-layer__check"/);
  const pickCss = readFileSync(new URL("../src/PickModels.css", import.meta.url), "utf8");
  assert.match(
    pickCss,
    /\.pick-layer__check\s*\{[^}]*margin-inline: calc\(var\(--space-xs\) \* -1\)/,
  );
  const manual = readFileSync(new URL("../src/ManualModelRow.css", import.meta.url), "utf8");
  assert.doesNotMatch(manual, /\.model-list__manual\s*\{[^}]*(padding|border-top)/);
});
