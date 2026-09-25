import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { render } from "./ui-render.ts";
import {
  ADD_GATEWAY_BLOCKED,
  MODELS_TOOLS,
  gatewayFacts,
  protocolText,
  switchNeedsConfirm,
  unsavedText,
} from "../src/modelsView.ts";
import type { GatewayProvider, GatewayProviderModel, GatewayState } from "../src/types.ts";

// 网关小区块（DESIGN「agent 页 › 网关」，D5：网关二级页并进 Codex 页「第三方模型」一节）：
// 小标 `网关` + `+ 网关`、一家一行（两列 内容 ｜ 行尾动作）、点整行拉开抽屉挑模型、表单在行的抽屉里就地展开

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

const { GatewayBlock, GatewayForm, displayUrl } = await import("../src/ModelsGateways.tsx");

const noop = () => {};

const block = (overrides: Partial<GatewayState> = {}, extra: Record<string, unknown> = {}) =>
  render(GatewayBlock, {
    tool: MODELS_TOOLS[0],
    state: state(overrides),
    busy: false,
    expanded: new Set<string>(),
    onToggleRow: noop,
    onExpand: noop,
    onSave: async () => "x",
    onFetchModels: async () => {},
    onRetry: async () => {},
    onRemove: async () => {},
    onToggleModel: noop,
    ...extra,
  });

const ap = (models: GatewayProviderModel[] = []) =>
  provider({ id: "ap", name: "ap-gateway", baseUrl: "https://ap-gateway.example.com/v1", models });
const or = (unreachable?: string) =>
  provider({
    id: "or",
    name: "",
    shortName: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    unreachable,
  });

/// 每一行的 HTML 片段，按出现顺序
const rows = (html: string) => html.split(/(?=<div class="gw-row[" ])/).slice(1);

test("骨架：小标 `网关` + 右端 `+ 网关`（默认键），一家一行；没有二级页的 ← 与页头", () => {
  const html = block({ providers: [ap(), or()] });
  assert.match(
    html,
    /gw-block__head"><span class="gw-block__label">网关<\/span>[^]*ss-btn--add[^]*网关/,
  );
  assert.equal(rows(html).length, 2);
  assert.doesNotMatch(html, /ss-subpage|Codex 的网关|src-row/);
});

test("行：拉手（常显，在名字前）+ 短名；第二行 `地址 · 已连接 · 已选 1 / 2`（地址去掉协议头，截断才提示）；行尾铅笔 + 垃圾桶（一对图标键）", () => {
  const html = block({
    providers: [
      ap([model({ id: "azure/gpt-4.1", selected: true }), model({ id: "azure/o3" })]),
      provider({ id: "ds", name: "", shortName: "deepseek", baseUrl: "https://api.deepseek.com" }),
    ],
  });
  const [first, second] = rows(html);
  // 点整行拉开抽屉；前面没有勾选框：拉手常显、在名字前（收着朝右）；进这一页时每行都收着
  assert.match(first, /<div class="gw-row__main" data-drawer-row="">/);
  assert.match(
    first,
    /gw-row__title"><button type="button" class="ss-drawerhandle is-lead" aria-label="ap-gateway 的模型" aria-expanded="false" aria-controls="gw-drawer-ap">[^]*?<\/button><span class="gw-row__label">ap-gateway<\/span>/,
  );
  assert.doesNotMatch(html, /gw-row__body|is-open|gw-row__caret|gw-row__name/);
  assert.match(first, /gw-row__url">ap-gateway\.example\.com\/v1</);
  assert.match(first, /gw-row__fact"> · 已连接 · 已选 1 \/ 2</);
  assert.doesNotMatch(first, /gw-row__url[^]*aria-describedby/);
  assert.match(
    first,
    /gw-row__actions">(<span[^>]*>)?<button type="button" class="ss-iconbtn" title="编辑" aria-label="编辑">[^]*aria-label="删掉 ap-gateway"/,
  );
  assert.doesNotMatch(html, /ss-btn--quiet/);
  // 没拉到模型时不写「已选」
  assert.match(second, /gw-row__label">deepseek</);
  assert.match(second, /gw-row__fact"> · 已连接<\/span>/);
  assert.doesNotMatch(html, /再试一次/);
  assert.equal(displayUrl("https://openrouter.ai/api/v1/"), "openrouter.ai/api/v1");
});

test("抽屉＝从这家挑模型：限制说明（全文）→ 勾选列表（不再列这一家的 `已选` 片：与节头 `在用` 重复）；勾选没写成的灰面板在这一段里", () => {
  const html = block(
    {
      enabled: true,
      providers: [
        ap([
          model({ id: "azure/gpt-4.1", displayName: "azure/gpt-4.1", selected: true }),
          model({ id: "zhipu/glm-4.6", displayName: "zhipu/glm-4.6", selected: true }),
          model({ id: "azure/o3", displayName: "azure/o3" }),
        ]),
        or(),
      ],
    },
    {
      expanded: new Set(["ap"]),
      notice: { providerId: "ap", message: "没加上 o3", reason: "无法写入" },
    },
  );
  const [first, second] = rows(html);
  assert.match(first, /^<div class="gw-row is-open"/);
  assert.match(first, /class="ss-drawer is-open gw-row__drawer" id="gw-drawer-ap"/);
  assert.match(first, /ss-drawerhandle is-lead is-open"[^>]*aria-expanded="true"/);
  const note = first.indexOf("gw-row__note");
  const notice = first.indexOf("没加上 o3");
  const list = first.indexOf("gw-row__list");
  assert.ok(note > 0 && note < notice && notice < list);
  assert.match(
    first,
    /gw-row__note">只支持文本与工具调用，不支持图片 · 会话标题仍由官方模型生成，第一条消息会发给官方 · 网页搜索用不了</,
  );
  // 抽屉里没有 `已选` 片（节头的 `在用` 已经列了）
  assert.doesNotMatch(first, /gw-row__chosen|ss-modelchip/);
  assert.equal((first.match(/role="option"/g) ?? []).length, 3);
  assert.equal((first.match(/data-checkrow=""/g) ?? []).length, 3, "勾选框行挂悬停钩子");
  assert.doesNotMatch(first, /models-option__gateway/);
  // ap 是最后一家还在供模型的：垃圾桶禁用，按下即出原因
  assert.match(first, /role="tooltip"[^>]*>Codex 还在用它的 2 个模型，先关掉第三方模型再删</);
  // 各自独立：没展开的那一行收着
  assert.match(second, /aria-expanded="false"/);
  assert.doesNotMatch(second, /gw-row__body/);
});

test("无法连接：`地址 · 无法连接 · 原因`（原因写全，不藏进悬停），行尾动作列出 `再试一次`；展开区说还没拉到模型", () => {
  const reason = "密钥无效，请到 DeepSeek 控制台换一个密钥";
  const html = block({ providers: [ap(), or(reason)] }, { expanded: new Set(["or"]) });
  const [, down] = rows(html);
  assert.match(down, /gw-row__label">openrouter</);
  assert.match(down, /gw-row__down">无法连接</);
  assert.match(down, new RegExp(`gw-row__reason">${reason}<`));
  assert.doesNotMatch(down, /已连接/);
  assert.match(
    down,
    /gw-row__actions">(<span[^>]*>)?<button[^>]*class="ss-btn ss-btn--compact"[^>]*>再试一次<[^]*class="ss-iconbtn" title="编辑"/,
  );
  assert.match(down, /gw-row__none">无法连接，还没拉到模型</);
  assert.deepEqual(gatewayFacts(or(reason)), {
    url: "https://openrouter.ai/api/v1",
    status: "无法连接",
    reason,
    picked: null,
  });
});

test("没有网关：小标下一句「还没有网关，先加一家」，不重复按钮；`+ 网关` 可按", () => {
  const html = block({ providers: [] });
  assert.match(html, /gw-block__empty">还没有网关，先加一家</);
  assert.doesNotMatch(html, /ss-empty|gw-list/);
  assert.match(html, /ss-btn--add"[^>]*aria-label="添加 网关">/);
  assert.doesNotMatch(html, /ss-btn--add"[^>]*disabled/);
  assert.equal(ADD_GATEWAY_BLOCKED, "先保存或取消正在添加的网关");
});

test("表单：`地址` `密钥` + `保存`（主动作墨键）+ `取消`（默认键，抽屉里紧凑）；只读 `本机端口 47328` `协议 拉取模型时识别`", () => {
  const html = render(GatewayForm, {
    state: state(),
    provider: null,
    busy: false,
    onSave: async () => "x",
    onFetchModels: async () => {},
    onSaved: noop,
    onCancel: noop,
    onDirtyChange: noop,
    ask: null,
  });
  assert.match(html, /gw-form__label">地址<[^]*placeholder="https:\/\/example.com\/openai\/v1"/);
  assert.match(html, /gw-form__label">密钥<[^]*placeholder="粘贴密钥，存进钥匙串"/);
  assert.match(html, /title="先填地址" disabled=""/);
  assert.match(html, /class="ss-btn ss-btn--primary ss-btn--compact"[^>]*>保存</);
  assert.match(html, /class="ss-btn ss-btn--compact"[^>]*>取消</);
  assert.doesNotMatch(html, /ss-btn--quiet/);
  assert.match(html, /本机端口 <span class="gw-form__value">47328<\/span>/);
  assert.match(html, /协议 <span class="gw-form__value">拉取模型时识别<\/span>/);
  assert.equal(protocolText("chat"), "Responses → Chat Completions");
  // 离开 / 换一行时有没保存的改动：就地一句 + 保存 / 丢弃
  const ask = render(GatewayForm, {
    state: state(),
    provider: ap(),
    busy: false,
    onSave: async () => "x",
    onFetchModels: async () => {},
    onSaved: noop,
    onCancel: noop,
    onDirtyChange: noop,
    ask: { text: "地址改动没保存", onDone: noop },
  });
  assert.match(
    ask,
    /gw-form__ask" role="status">地址改动没保存<[^]*>保存<[^]*class="ss-btn ss-btn--compact"[^>]*>丢弃</,
  );
  assert.doesNotMatch(ask, />取消</);
});

test("换一行编辑 / 离开前：表单有没保存的改动才拦下问；新网关与改地址说法不同", () => {
  assert.equal(switchNeedsConfirm("new", "ap", true), true);
  assert.equal(switchNeedsConfirm("new", "ap", false), false, "空草稿没东西可丢");
  assert.equal(switchNeedsConfirm("ap", "ap", true), false);
  assert.equal(switchNeedsConfirm("ap", "new", true), true, "改了地址也不能静默丢掉");
  assert.equal(unsavedText("new"), "新网关没保存");
  assert.equal(unsavedText("ap"), "地址改动没保存");
});

test("网关行右键（D18）与离开拦截：用外壳的 contextMenuHandler 与 useLeaveGuard；样式不再依赖来源管理页", () => {
  const tsx = readFileSync(new URL("../src/ModelsGateways.tsx", import.meta.url), "utf8");
  assert.match(tsx, /onContextMenu=\{contextMenuHandler\(/);
  assert.match(tsx, /\{ label: "编辑", run: \(\) => choose\(p\.id\) \}/);
  assert.match(tsx, /\{ label: "删掉…", run: \(\) => askRemove\(p\) \}/);
  // 离开前询问走外壳的统一接口（tests/shell-leave.test.ts 测接口本身与壳里的各条路）
  assert.match(tsx, /useLeaveGuard\(formDirty && editing !== null/);
  assert.doesNotMatch(tsx, /src-row/);
  const css = readFileSync(new URL("../src/ModelsTab.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /cubic-bezier|cursor:\s*pointer/);
  assert.match(css, /\.gw-row\.is-menu \.gw-row__main \{\s*background: var\(--surface\);/);
});
