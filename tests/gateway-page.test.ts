import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { render } from "./ui-render.ts";
import { MODELS_TOOLS, switchNeedsConfirm, unsavedText } from "../src/modelsView.ts";
import type { GatewayProvider, GatewayProviderModel, GatewayState } from "../src/types.ts";

// 网关页（DESIGN「网关配置是二级页」2026-09-24 改版）：与来源管理页同一套骨架——
// 一家一行、点整行展开选模型、表单在行里就地展开、`+ 网关` 在页头右端

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

const { GatewayPage, ADD_GATEWAY_BLOCKED } = await import("../src/pages/GatewayPage.tsx");

const noop = () => {};

const page = (overrides: Partial<GatewayState> = {}, extra: Record<string, unknown> = {}) =>
  render(GatewayPage, {
    tool: MODELS_TOOLS[0],
    state: state(overrides),
    busy: false,
    initial: null,
    onSave: async () => "x",
    onFetchModels: async () => {},
    onRetry: async () => {},
    onRemove: async () => {},
    onToggleModel: noop,
    leaving: false,
    onLeave: noop,
    ...extra,
  });

const ap = (models: GatewayProviderModel[] = []) =>
  provider({ id: "ap", name: "ap-gateway", baseUrl: "https://ap-gateway.example.com/v1", models });
const or = (unreachable?: string) =>
  provider({ id: "or", name: "", baseUrl: "https://openrouter.ai/api/v1", unreachable });

/// 每一行（src-row）的 HTML 片段，按出现顺序
const rows = (html: string) => html.split(/(?=<div class="src-row gw-row)/).slice(1);

test("骨架：← Codex 的网关 + 标题后的页头动作 + 右端 `+ 网关`；表头 `网关`，一家一行，不再有分段片", () => {
  const html = page({ providers: [ap(), or()] }, { headerAction: "RESTART-SLOT" });
  assert.match(html, /class="ss-subpage gw-page-sub"/);
  assert.match(html, /gw-page__title">Codex 的网关(<!-- -->)?RESTART-SLOT/);
  assert.match(html, /aria-label="返回"/);
  // 页头右端 `+ 网关`：与来源管理页 `+ 来源` 同一个组件（AddButton），可点
  assert.match(
    html,
    /ss-subpage__aside">(<span[^>]*>)?<button type="button" class="ss-btn ss-btn--add"[^>]*aria-label="添加 网关">/,
  );
  assert.doesNotMatch(html, /ss-btn--add"[^>]*disabled/);
  // 与来源管理页同一套表头、行
  assert.match(html, /class="src-panel"><div class="src-panel__head"><span>网关<\/span><\/div>/);
  assert.equal(rows(html).length, 2);
  assert.doesNotMatch(html, /ss-chip|gw-panel/);
  assert.match(
    render(GatewayPage, {
      tool: MODELS_TOOLS[0],
      state: state(),
      busy: false,
      initial: null,
      onSave: async () => "x",
      onFetchModels: async () => {},
      onRetry: async () => {},
      onRemove: async () => {},
      onToggleModel: noop,
      leaving: true,
      onLeave: noop,
    }),
    /class="ss-subpage gw-page-sub is-leaving"/,
  );
});

test("行：▸ + 短名；第二行 `地址 · 已连 · 已选 1 / 2 个模型`（地址截断才提示）；行尾 `编辑` + 垃圾桶", () => {
  const html = page({
    providers: [
      ap([model({ id: "azure/gpt-4.1", selected: true }), model({ id: "azure/o3" })]),
      provider({ id: "ds", name: "", baseUrl: "https://api.deepseek.com" }),
    ],
  });
  const [first, second] = rows(html);
  // 名字格整块是展开键（点整行展开）；进来时每行都收着（同来源管理页）
  assert.match(
    first,
    /<button type="button" class="src-row__name gw-row__name" aria-expanded="false">/,
  );
  assert.doesNotMatch(html, /gw-row__body|is-open/);
  assert.match(first, /src-row__label">ap-gateway</);
  assert.match(first, /gw-row__url">https:\/\/ap-gateway\.example\.com\/v1</);
  assert.match(first, /gw-row__fact"> · 已连 · 已选 1 \/ 2 个模型</);
  // 地址是 TruncTip：完整显示着就不出提示框，读屏不重复挂描述
  assert.doesNotMatch(first, /gw-row__url[^]*aria-describedby/);
  assert.match(
    first,
    /gw-row__actions">(<span[^>]*>)?<button[^>]*class="ss-btn ss-btn--quiet"[^>]*>编辑</,
  );
  assert.match(first, /aria-label="删掉 ap-gateway"/);
  // 没拉到模型时不写「已选」
  assert.match(second, /src-row__label">deepseek</);
  assert.match(second, /gw-row__fact"> · 已连<\/span>/);
  assert.doesNotMatch(html, /再试一次/);
});

test("展开区＝从这个网关选模型：限制说明 → 已选模型片（× 可移除）→ 勾选列表；勾选没写成的灰面板在这一段里", () => {
  const html = page(
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
    { initial: "ap", notice: { message: "没勾上 o3", reason: "配置写不进" } },
  );
  const [first] = rows(html);
  const note = first.indexOf("gw-row__note");
  const chosen = first.indexOf("gw-row__chosen");
  const notice = first.indexOf("没勾上 o3");
  const list = first.indexOf("gw-row__list");
  assert.ok(note > 0 && note < chosen && chosen < notice && notice < list);
  assert.match(first, /gw-row__note">只支持文本与工具调用，不支持图片</);
  assert.match(first, /ss-modelchip__name">azure\/gpt-4\.1</);
  assert.match(first, /aria-label="移除 zhipu\/glm-4\.6"/);
  assert.doesNotMatch(first, /ss-modelchip__name">azure\/o3</);
  assert.equal((first.match(/role="option"/g) ?? []).length, 3);
  // 网关页只列本网关：行尾不写网关短名
  assert.doesNotMatch(first, /models-option__gateway/);
  // ap 是最后一家还在供模型的：垃圾桶禁用，提示框说原因
  assert.match(first, /role="tooltip"[^>]*>Codex 还在用它的 2 个模型，先取消勾选再删</);
  // 一个都没选时模型片那一行不出
  const none = page({ providers: [ap([model({ id: "azure/o3" })])] }, { initial: "ap" });
  assert.doesNotMatch(none, /gw-row__chosen/);
});

test("连不上：`地址 · 连不上 · 原因`（原因写全，不藏进悬停），行尾动作列出 `再试一次`", () => {
  const reason = "鉴权失败：密钥不对，或者这个密钥没有列模型的权限";
  const html = page({ providers: [ap(), or(reason)] });
  const [, down] = rows(html);
  assert.match(down, /src-row__label">openrouter</);
  assert.match(down, /gw-row__down">连不上</);
  assert.match(down, new RegExp(`gw-row__reason">${reason}<`));
  assert.doesNotMatch(down, /已连/);
  assert.match(
    down,
    /gw-row__actions">(<span[^>]*>)*<button[^>]*class="ss-btn ss-btn--compact"[^>]*>再试一次<[^]*>编辑</,
  );
});

test("新网关：插在最上面，名字位是普通字 `新网关`（不是反色片），表单开着；页头 `+ 网关` 禁用并说原因", () => {
  const html = page({ providers: [ap(), or()] }, { initial: "new" });
  const [draft, ...rest] = rows(html);
  assert.equal(rest.length, 2);
  assert.match(draft, /src-row__label gw-row__draft">新网关</);
  assert.doesNotMatch(html, /ss-chip/);
  assert.match(draft, /class="gw-form"/);
  assert.match(draft, /placeholder="https:\/\/example.com\/openai\/v1"/);
  assert.match(draft, /role="tooltip"[^>]*>先填地址</);
  assert.match(draft, /title="先填地址" disabled=""/);
  assert.match(draft, />取消</);
  assert.match(draft, /<dd>47328<\/dd>/);
  assert.match(draft, /拉模型时探明/);
  // 草稿在时 `+ 网关` 禁用（从源头防止两个草稿），提示框说原因
  assert.equal(ADD_GATEWAY_BLOCKED, "先保存或取消正在添加的网关");
  assert.match(html, new RegExp(`ss-btn--add" title="${ADD_GATEWAY_BLOCKED}"[^>]*disabled=""`));
  // 一家都没有时从「还没有网关 · + 网关 ›」进来：直接是新网关那一行，不是空态
  const fresh = page({ providers: [] }, { initial: "new" });
  assert.equal(rows(fresh).length, 1);
  assert.match(fresh, /新网关/);
  assert.doesNotMatch(fresh, /还没有网关/);
});

test("没有网关：列表位置是空态一句「还没有网关」，不重复按钮；动作是页头的 `+ 网关`", () => {
  const html = page({ providers: [] });
  assert.match(html, /ss-empty__description">还没有网关</);
  assert.doesNotMatch(html, /ss-empty__actions/);
  assert.doesNotMatch(html, /src-panel/);
  assert.match(html, /ss-btn--add"[^>]*aria-label="添加 网关">/);
  assert.doesNotMatch(html, /ss-btn--add"[^>]*disabled/);
});

test("跳回定位：那一行带来源管理页同一种跳转闪（src-row is-jump），并且展开", () => {
  const html = page(
    { providers: [ap(), or("地址连不上")] },
    { initial: "or", flashProviderId: "or" },
  );
  assert.equal((html.match(/is-jump/g) ?? []).length, 1);
  const [first, second] = rows(html);
  assert.match(second, /^<div class="src-row gw-row is-open is-jump"/);
  assert.match(first, /aria-expanded="false"/);
});

test("换一行编辑 / 离开前：表单有没保存的改动才拦下问；新网关与改地址说法不同", () => {
  assert.equal(switchNeedsConfirm("new", "ap", true), true);
  assert.equal(switchNeedsConfirm("new", "ap", false), false, "空草稿没东西可丢");
  assert.equal(switchNeedsConfirm("ap", "ap", true), false);
  assert.equal(switchNeedsConfirm("ap", "new", true), true, "改了地址也不能静默丢掉");
  assert.equal(unsavedText("new"), "新网关没保存");
  assert.equal(unsavedText("ap"), "地址改动没保存");
});

test("样式与来源管理页同一套：GatewayPage 引入 SourcesPage.css，自己不再有分段片与三段式的规则", () => {
  const tsx = readFileSync(new URL("../src/pages/GatewayPage.tsx", import.meta.url), "utf8");
  assert.match(tsx, /import "\.\/SourcesPage\.css";/);
  const css = readFileSync(new URL("../src/pages/GatewayPage.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /gw-panel|chipwrap|gw-jump/);
  assert.match(css, /\.gw-row \.src-row__main \{\s*grid-template-columns: minmax\(0, 1fr\) auto;/);
});
