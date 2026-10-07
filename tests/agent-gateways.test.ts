import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { withCopy } from "./copy.ts";
import { render } from "./ui-render.ts";
import {
  MODELS_TOOLS,
  addGatewayBlocked,
  gatewayFacts,
  switchNeedsConfirm,
  unsavedText,
} from "../src/modelsView.ts";
import type {
  GatewayProvider,
  GatewayProviderModel,
  GatewayState,
  ProviderPreset,
} from "../src/types.ts";
import { CLAUDE_OFF, gatewayFixture, type CodexFixture } from "./gateway-fixture.ts";

// 网关小区块（DESIGN「agent 页 › 网关」，D5：网关二级页并进 Codex 页「第三方模型」一节）：
// 小标 `网关` + `+ 网关`（SectionLabel）、一家一行（列表行 ListRow：拉手 ｜ 名字 + 副行 ｜ 行尾动作）、
// 点整行拉开抽屉挑模型、表单在行的抽屉里就地展开

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

const { GatewayBlock, GatewayForm, RemoveGatewayConfirm, displayUrl } =
  await import("../src/ModelsGateways.tsx");

const noop = () => {};

const block = (overrides: Partial<CodexFixture> = {}, extra: Record<string, unknown> = {}) =>
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
/// 页面上的网关行按添加先后倒着显示（新的在上，2026-10-06）；用例按添加先后列网关，这里倒回来对上
const rows = (html: string) =>
  html
    .split(/(?=<div class="ss-listrow[" ])/)
    .slice(1)
    .reverse();

test("骨架：小标 `网关` + 右端 `+ 网关`（默认键），一家一行；没有二级页的 ← 与页头", () => {
  const html = block({ providers: [ap(), or()] });
  assert.match(
    html,
    /class="ss-sectionlabel has-rule has-action"><span class="ss-sectionlabel__text">网关<span class="gw-block__port">本机端口 47328<\/span><\/span>[^]*ss-btn--add[^]*网关/,
  );
  assert.equal(rows(html).length, 2);
  assert.doesNotMatch(html, /ss-subpage|Codex 的网关|src-row/);
});

test("网关列表按添加先后倒着显示：后加的在最上面（2026-10-06 产品负责人：新加的保存后不能跑到末尾不见）", () => {
  const html = block({
    providers: [
      ap(),
      provider({ id: "ds", name: "", shortName: "deepseek", baseUrl: "https://api.deepseek.com" }),
    ],
  });
  assert.ok(html.indexOf(">deepseek<") < html.indexOf(">ap-gateway<"), "后加的 deepseek 在上");
});

test("行：拉手（常显，在名字前）+ 短名；第二行 `地址 · 已连接 · 已选 1 / 2`（地址去掉协议头，截断才提示）；行尾 ↻（刷新模型列表，2026-09-30）+ 铅笔 + 垃圾桶", () => {
  const html = block({
    providers: [
      ap([model({ id: "azure/gpt-4.1", selected: true }), model({ id: "azure/o3" })]),
      provider({ id: "ds", name: "", shortName: "deepseek", baseUrl: "https://api.deepseek.com" }),
    ],
  });
  const [first, second] = rows(html);
  // 点整行拉开抽屉；前面没有勾选框：拉手常显、在名字前（收着朝右）；进这一页时每行都收着
  assert.match(first, /<div class="ss-listrow__main" data-drawer-row="">/);
  assert.match(
    first,
    /ss-listrow__handle"><button type="button" class="ss-drawerhandle is-always" aria-label="ap-gateway 的模型" aria-expanded="false" aria-controls="gw-drawer-ap">[^]*?<\/button><\/span><span class="ss-listrow__content"><span class="ss-listrow__title">ap-gateway<\/span>/,
  );
  assert.doesNotMatch(html, /gw-row__body|is-open|gw-row__caret|gw-row__name/);
  assert.match(first, /gw-row__url">ap-gateway\.example\.com\/v1</);
  assert.match(first, /gw-row__fact"> · 已连接 · 已选 1 \/ 2</);
  assert.doesNotMatch(
    first,
    /aria-describedby[^>]*><span class="gw-row__url"|class="gw-row__url"[^>]*aria-describedby/,
  );
  // 图标键的名字经提示框出，不写原生 title
  assert.match(
    first,
    /ss-listrow__actions"><span class="gw-row__refetch">(<span[^>]*>)?<button type="button" class="ss-iconbtn" aria-label="刷新模型列表"[^]*role="tooltip"[^>]*>刷新模型列表<[^]*aria-label="编辑"[^]*role="tooltip"[^>]*>编辑<[^]*aria-label="删掉 ap-gateway"/,
  );
  assert.doesNotMatch(first, / title=/);
  assert.doesNotMatch(html, /ss-btn--quiet/);
  // 没拉到模型时不写「已选」
  assert.match(second, /ss-listrow__title">deepseek</);
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
      notice: { providerId: "ap", message: "o3 添加失败", reason: "无法写入" },
    },
  );
  const [first, second] = rows(html);
  assert.match(first, /^<div class="ss-listrow is-open"/);
  // 抽屉左沿对齐网关名：ListRow 让出拉手列 24，页面不再覆盖抽屉的内部类
  assert.match(first, /class="ss-drawer is-open is-bare is-flush" id="gw-drawer-ap"/);
  assert.match(first, /class="ss-drawer__well" style="margin-inline-start:24px"/);
  assert.match(first, /ss-drawerhandle is-always is-open"[^>]*aria-expanded="true"/);
  const note = first.indexOf("gw-row__note");
  const notice = first.indexOf("o3 添加失败");
  const list = first.indexOf("gw-row__list");
  assert.ok(note > 0 && note < notice && notice < list);
  assert.match(first, /gw-row__note">网页搜索用不了 · 图片要看模型</);
  // 抽屉里没有 `已选` 片（节头的 `在用` 已经列了）
  assert.doesNotMatch(first, /gw-row__chosen|ss-modelchip/);
  assert.equal((first.match(/role="checkbox"/g) ?? []).length, 3);
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
  assert.match(down, /ss-listrow__title">openrouter</);
  assert.match(down, /gw-row__down">无法连接</);
  assert.match(down, new RegExp(`gw-row__reason">${reason}<`));
  assert.doesNotMatch(down, /已连接/);
  // 连不上时 ↻ 让位给 `再试一次`（同一个动作）
  assert.doesNotMatch(down, /刷新模型列表/);
  assert.match(
    down,
    /ss-listrow__actions">(<span[^>]*>)?<button[^>]*class="ss-btn ss-btn--compact"[^>]*>再试一次<[^]*class="ss-iconbtn" aria-label="编辑"/,
  );
  assert.match(
    down,
    /gw-row__none"><p class="ss-note"><span class="ss-note__text">无法连接，还没拉到模型</,
  );
  assert.deepEqual(gatewayFacts(or(reason)), {
    url: "https://openrouter.ai/api/v1",
    statusKind: "unreachable",
    status: "无法连接",
    reason,
    picked: null,
  });
});

// spec 2026-10-04-local-diagnostics R13；2026-10-06 起（画板 5703fb83 方案 D）没有 `详情` 键：第二行状态前一个小 `!`
// 是入口，停上去或点一下浮起悬浮卡；行尾 `再试一次` · 编辑 · 删除，原文不进行里
test("无法连接且有技术原文：`无法连接` 前一个小 `!`（入口），行尾没有 `详情`、照旧 `再试一次`；原文不在行里；没有原文就没有 `!`", () => {
  const reason = "服务商限流了，约 30 秒后再试";
  const detail =
    "GET https://openrouter.ai/api/v1/models → 429 Too Many Requests · Retry-After: 30";
  const html = block({ providers: [ap(), { ...or(reason), unreachableDetail: detail }] });
  const [, down] = rows(html);
  assert.match(
    down,
    /<button type="button" class="ss-hovercard ss-markbtn ss-markbtn--row" aria-label="查看错误详情"[^>]*>[^]*?<\/button><span class="gw-row__down">无法连接<\/span>/,
  );
  assert.match(down, new RegExp(`<span class="gw-row__reason">${reason}</span>`));
  assert.match(down, /ss-listrow__actions">[^]*>再试一次<[^]*aria-label="编辑"/);
  assert.doesNotMatch(down, />详情</);
  assert.doesNotMatch(down, /Retry-After/);
  const [, plain] = rows(block({ providers: [ap(), or(reason)] }));
  assert.match(plain, new RegExp(`<span class="gw-row__reason">${reason}</span>`));
  assert.doesNotMatch(plain, /ss-markbtn/);
});

test("密钥读不出（R4 / AC2）：`地址 · 密钥不可用 · 原因`（红字，原因写全），不说「还没有密钥」；表单不说「已保存」", () => {
  const reason = "读不出密钥文件：没有读取权限";
  const locked = provider({
    id: "wecode",
    name: "wecode",
    key: "unreadable",
    keyProblem: reason,
    models: [model({ selected: true })],
  });
  const [row] = rows(block({ providers: [locked] }));
  assert.match(row, /gw-row__down">密钥不可用</);
  assert.match(row, new RegExp(`gw-row__reason">${reason}<`));
  assert.doesNotMatch(row, /还没有密钥|已连接/);
  assert.deepEqual(gatewayFacts(locked), {
    url: "https://example.com/openai",
    statusKind: "keyUnreadable",
    status: "密钥不可用",
    reason,
    picked: "已选 1 / 1",
  });
  const form = render(GatewayForm, {
    state: state({ providers: [locked] }),
    provider: locked,
    busy: false,
    onSave: async () => "x",
    onFetchModels: async () => {},
    onSaved: noop,
    onCancel: noop,
    onDirtyChange: noop,
    ask: null,
  });
  assert.match(form, /placeholder="粘贴密钥"/);
  assert.doesNotMatch(form, /已保存，留空则不改/);
});

test("没有网关：小标下一句「还没有网关，先加一家」，不重复按钮；`+ 网关` 可按", () => {
  const html = block({ providers: [] });
  assert.match(
    html,
    /gw-block__empty"><p class="ss-note"><span class="ss-note__text">还没有网关，先加一家</,
  );
  assert.doesNotMatch(html, /ss-empty|gw-list/);
  assert.match(html, /ss-btn--add"[^>]*aria-label="添加 网关">/);
  assert.doesNotMatch(html, /ss-btn--add"[^>]*disabled/);
  assert.equal(addGatewayBlocked(), "先保存或取消正在添加的网关");
});

test("表单：`地址` `密钥` + `保存`（主动作墨键）+ `取消`（默认键，抽屉里紧凑）；只读 `本机端口 47328` `协议 拉取模型时识别`", () => {
  const html = render(GatewayForm, {
    provider: null,
    busy: false,
    onSave: async () => "x",
    onFetchModels: async () => {},
    onSaved: noop,
    onCancel: noop,
    onDirtyChange: noop,
    ask: null,
    // 新网关先选服务商（spec S1，下面单测）；这里直接从「自定义地址」看地址与密钥
    initialPreset: "custom",
  });
  // 自定义地址：服务商一行写 `自定义地址` + `换一家`，没有 `预设` 记号
  assert.match(html, /gw-preset__picked"><span>自定义地址<\/span>/);
  assert.match(html, /gw-preset__change">[^]*?>换一家<\/button>/);
  assert.doesNotMatch(html, />预设</);
  // 输入框是组件库的 TextField（凹面、聚焦只转边色）；可见标签 12 ink-mute 定宽 44，与输入框关联：
  // 读屏名就是看得见的那个字（aria-labelledby），点标签聚焦输入框（htmlFor → id）
  const url = html.match(
    /<label class="gw-form__label" id="([^"]+)" for="([^"]+)">地址<\/label>[^]*?<input id="([^"]+)" class="ss-textfield__input" type="text" placeholder="https:\/\/example.com\/openai\/v1" aria-labelledby="([^"]+)"/,
  );
  assert.ok(url, "地址标签与输入框没有关联上");
  assert.equal(url[2], url[3]);
  assert.equal(url[1], url[4]);
  const key = html.match(
    /<label class="gw-form__label" id="([^"]+)" for="([^"]+)">密钥<\/label>[^]*?<input id="([^"]+)" class="ss-textfield__input" type="password" placeholder="粘贴密钥" aria-labelledby="([^"]+)"/,
  );
  assert.ok(key, "密钥标签与输入框没有关联上");
  assert.equal(key[2], key[3]);
  assert.equal(key[1], key[4]);
  assert.doesNotMatch(html, /aria-label="地址"|aria-label="密钥"/);
  assert.match(html, /disabled=""[^>]*>保存<\/button><span[^>]*role="tooltip"[^>]*>先填地址</);
  assert.match(html, /class="ss-btn ss-btn--primary ss-btn--compact"[^>]*>保存</);
  assert.match(html, /class="ss-btn ss-btn--compact"[^>]*>取消</);
  assert.doesNotMatch(html, /ss-btn--quiet/);
  // 表单底下不再有端口与协议那一行（2026-10-06）：端口挪到「网关」小标旁
  assert.doesNotMatch(html, /本机端口|协议 /);
  // 离开 / 换一行时有没保存的改动：就地一句 + 保存 / 丢弃
  const ask = render(GatewayForm, {
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
  const tsx = withCopy(readFileSync(new URL("../src/ModelsGateways.tsx", import.meta.url), "utf8"));
  assert.match(tsx, /onContextMenu=\{contextMenuHandler\(/);
  assert.match(tsx, /\{ label: t\("编辑"\), run: \(\) => choose\(p\.id\) \}/);
  assert.match(tsx, /\{ label: t\("删掉…"\), run: \(\) => askRemove\(p\) \}/);
  // 离开前询问走外壳的统一接口（tests/shell-leave.test.ts 测接口本身与壳里的各条路）
  assert.match(tsx, /useLeaveGuard\(formDirty && editing !== null/);
  assert.doesNotMatch(tsx, /src-row/);
  const css = readFileSync(new URL("../src/ModelsTab.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /cubic-bezier|cursor:\s*pointer/);
  // 右键菜单开着时行带亮着：交给 ListRow 的 highlighted，页面不再自写行与悬停带
  assert.match(tsx, /highlighted=\{menuRow === p\.id\}/);
  assert.doesNotMatch(css, /gw-row__main|gw-row[^{]*:hover/);
});

// ===== 两家各管自己的网关，配置时可以顺手同步（spec 2026-09-29 R43；DESIGN「同步由用户选」） =====

const claudeWith = (providers: GatewayProvider[]) => ({
  ...CLAUDE_OFF,
  installed: true,
  providers,
});

const formProps = (extra: Record<string, unknown> = {}) => ({
  provider: null,
  busy: false,
  onSave: async () => "x",
  onFetchModels: async () => {},
  onSaved: noop,
  onCancel: noop,
  onDirtyChange: noop,
  ask: null,
  ...extra,
});

// ===== 新网关第一步：选服务商（spec S1，sophia-dev#95；画板 SvjEZCgBMgWqe666nJGXR7） =====

const PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    website: "https://platform.deepseek.com",
    keysUrl: "https://platform.deepseek.com/api_keys",
    region: "cn",
    openai: { apiBase: "https://api.deepseek.com", protocol: "responses" },
    anthropic: { apiBase: "https://api.deepseek.com/anthropic" },
  },
  {
    id: "mimo",
    name: "Xiaomi MiMo",
    website: "https://mimo.xiaomi.com",
    region: "cn",
    openai: null,
    anthropic: { apiBase: "https://api.xiaomimimo.com/anthropic" },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    website: "https://openrouter.ai",
    region: "global",
    openai: { apiBase: "https://openrouter.ai/api/v1", protocol: "responses" },
    anthropic: null,
  },
];

test("新网关第一步：`服务商` 搜索框 + 名单（暂不支持的灰显带记号、原因在提示框里、最下面自定义地址）；只有 `取消`，没有常驻说明（2026-10-06）", async () => {
  const presets = await import("../src/presets.ts");
  presets.seedPresetsForTest(PRESETS);
  const html = render(GatewayForm, formProps());
  assert.match(html, /gw-form__label gw-form__label--top"[^>]*>服务商</);
  assert.match(html, /class="ss-textfield__input"[^>]*placeholder="搜索服务商"/);
  // 一列到底、不分国内海外（2026-10-05 产品负责人）；`自定义地址…` 在滚动区之外的框底
  const ds = html.indexOf("DeepSeek");
  const mimo = html.indexOf("Xiaomi MiMo");
  const or = html.indexOf("OpenRouter");
  const custom = html.indexOf("自定义地址…");
  assert.ok(ds > 0 && ds < mimo && mimo < or && or < custom, "顺序不对");
  assert.doesNotMatch(html, />国内<|>海外</);
  assert.match(
    html,
    /gw-preset__scroll"[^>]*>[^]*OpenRouter[^]*<\/div><div class="gw-preset__foot">[^]*自定义地址…/,
  );
  assert.match(html, /gw-preset__item gw-preset__item--off"[^>]*>[^]*?Xiaomi MiMo[^]*?暂不支持/);
  assert.match(html, /api\.deepseek\.com/);
  assert.match(html, /这家只给 Anthropic 协议的地址，Sophia 暂时接不上/);
  // 不言自明的都不写：名单下没有说明句，键行只有 `取消`，自定义地址后没有副句
  assert.doesNotMatch(html, />保存</);
  assert.doesNotMatch(html, /gw-form__hint|不在名单里的服务商/);
  assert.doesNotMatch(html, />地址<\/label>|>密钥<\/label>/);
  // 选了 DeepSeek：服务商一行 `DeepSeek` + `换一家`（不再带 `预设` 记号），地址已填、密钥框等着、取密钥的链接、协议按预设
  const picked = render(GatewayForm, formProps({ initialPreset: PRESETS[0] }));
  assert.match(picked, /gw-preset__picked"><span>DeepSeek<\/span><span class="gw-preset__change">/);
  assert.doesNotMatch(picked, />预设</);
  assert.match(picked, /value="https:\/\/api\.deepseek\.com"/);
  assert.match(picked, /gw-preset__keys"[^>]*>去 DeepSeek 取密钥 ↗<\/a>/);
  presets.seedPresetsForTest(null);
});

test("选的预设这一家已经加过（地址撞上现有网关）：不进表单，交给 onPickExisting 跳到那一行", async () => {
  const presets = await import("../src/presets.ts");
  presets.seedPresetsForTest(PRESETS);
  const { addressTakenBy } = await import("../src/modelsView.ts");
  const mine = provider({ id: "ds", name: "DeepSeek", baseUrl: "https://api.deepseek.com/" });
  // 纯逻辑：同一地址（末尾斜杠不算差别）认出是哪一行；表单的 pick 按这个结果调 onPickExisting
  assert.equal(addressTakenBy([mine], PRESETS[0].openai!.apiBase, undefined)?.id, "ds");
  assert.equal(addressTakenBy([mine], PRESETS[2].openai!.apiBase, undefined), null);
  presets.seedPresetsForTest(null);
});

test("新建表单：`地址` `密钥` 下一行勾选 `也加到 Claude`（CheckRow，默认勾上），在 `保存` 之前；不给另一家就不出", () => {
  const html = render(
    GatewayForm,
    formProps({ other: { name: "Claude", providers: [] }, initialPreset: "custom" }),
  );
  const key = html.indexOf(">密钥<");
  const sync = html.indexOf("也加到 Claude");
  const save = html.indexOf(">保存<");
  assert.ok(key > 0 && key < sync && sync < save);
  assert.match(
    html,
    /gw-form__sync">(<span[^>]*>)?<button type="button" role="checkbox" aria-checked="true"[^>]*>[^]*也加到 Claude/,
  );
  // 表单里附加的一个选项：勾选行小档，名字跟着 12 号的标签与说明走（DESIGN-components「勾选行 › 字号随场景」）
  assert.match(
    html,
    /gw-form__sync">(<span[^>]*>)?<button[^>]*class="ss-checkrow ss-checkrow--small"/,
  );
  assert.doesNotMatch(
    render(GatewayForm, formProps({ initialPreset: "custom" })),
    /也加到|role="checkbox"/,
  );
});

test("编辑表单：另一家有同一地址的网关时 `Claude 里的 ap-gateway 一起改`（默认勾上）；没有就不出", () => {
  const mine = ap();
  const theirs = provider({
    id: "c1",
    name: "ap-gateway",
    shortName: "ap-gateway",
    baseUrl: "https://ap-gateway.example.com/v1/",
  });
  const html = render(
    GatewayForm,
    formProps({ provider: mine, other: { name: "Claude", providers: [theirs] } }),
  );
  assert.match(html, /role="checkbox" aria-checked="true"[^]*Claude 里的 ap-gateway 一起改/);
  const none = render(
    GatewayForm,
    formProps({ provider: mine, other: { name: "Claude", providers: [] } }),
  );
  assert.doesNotMatch(none, /一起改|role="checkbox"/);
});

test("网关区块按家：agent=claude 只列 Claude 的网关；Claude 还没有、Codex 有时空态 `还没有网关 · Codex 里有 ap-gateway、openrouter` + `带过来`（默认键紧凑）", () => {
  const codexOnes = [ap(), or()];
  const empty = block(
    { providers: codexOnes, claude: claudeWith([]) },
    { agent: "claude", otherName: "Codex", onCopy: async () => {} },
  );
  assert.match(
    empty,
    /gw-block__empty">[^]*还没有网关 · Codex 里有 ap-gateway、openrouter[^]*class="ss-btn ss-btn--compact"[^>]*>带过来</,
  );
  assert.doesNotMatch(empty, /先加一家|ss-listrow/);
  // Claude 自己有网关：只列它自己的
  const mine = provider({ id: "ds", name: "deepseek", shortName: "deepseek" });
  const listed = block(
    { providers: codexOnes, claude: claudeWith([mine]) },
    { agent: "claude", otherName: "Codex", onCopy: async () => {} },
  );
  assert.equal(rows(listed).length, 1);
  assert.match(listed, /ss-listrow__title">deepseek</);
  assert.doesNotMatch(listed, /带过来|ap-gateway/);
  // 两家都没有：照旧一句
  const none = block(
    { providers: [], claude: claudeWith([]) },
    { agent: "claude", otherName: "Codex", onCopy: async () => {} },
  );
  assert.match(none, /还没有网关，先加一家/);
  assert.doesNotMatch(none, /带过来/);
});

test("删网关的确认：另一家有同一地址时正文下一行 `同时删掉 Claude 里的 ap-gateway`（默认不勾），正文随勾选变；没有时照原来一句、不出勾选", () => {
  const theirs = provider({
    id: "c1",
    name: "ap-gateway",
    shortName: "ap-gateway",
    baseUrl: "https://ap-gateway.example.com/v1",
    models: [model({ selected: true })],
  });
  const other = { name: "Claude", providers: [theirs] };
  const props = { provider: ap(), other, onConfirm: noop, onCancel: noop, onAlsoOther: noop };
  const off = render(RemoveGatewayConfirm, { ...props, alsoOther: false });
  assert.match(off, /删掉 ap-gateway？/);
  assert.match(off, /地址和这里的密钥一起删掉，删除后无法恢复；Claude 里的 ap-gateway 不受影响/);
  assert.match(off, /role="checkbox" aria-checked="false"[^]*同时删掉 Claude 里的 ap-gateway/);
  const on = render(RemoveGatewayConfirm, { ...props, alsoOther: true });
  assert.match(on, /两家的地址和密钥都删掉，删除后无法恢复；Claude 选的 1 个模型会一起移除/);
  assert.match(on, /role="checkbox" aria-checked="true"/);
  const plain = render(RemoveGatewayConfirm, {
    ...props,
    other: { name: "Claude", providers: [] },
    alsoOther: false,
  });
  assert.match(plain, /地址和密钥一起删掉，删除后无法恢复/);
  assert.doesNotMatch(plain, /role="checkbox"|同时删掉/);
});

test("还没有密钥（画板 1PxHo6ZoEe8pFCYbU1pAud）：第二行 `还没有密钥` 加粗；行尾不出 ↻ 也不另加键，只留编辑与删掉；没勾的模型勾选框不可用、按下说原因；编辑时光标落在密钥框", () => {
  const bare = (key: "missing" | "unreadable") =>
    provider({
      id: "or",
      name: "",
      shortName: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      key,
      models: [
        model({ id: "a/one", displayName: "a/one", selected: true }),
        model({ id: "b/two", displayName: "b/two" }),
      ],
    });
  for (const key of ["missing", "unreadable"] as const) {
    const [row] = rows(block({ providers: [bare(key)] }, { expanded: new Set(["or"]) }));
    assert.match(
      row,
      key === "missing" ? /gw-row__down">还没有密钥</ : /gw-row__down">密钥不可用</,
    );
    // 拉不了模型列表：↻ 不出，也没有「填写密钥」——填密钥就是编辑
    assert.doesNotMatch(row, /刷新模型列表|>填写密钥<|再试一次/, key);
    assert.match(row, /aria-label="编辑"/);
    // 已勾的那一个照常（取消勾选不用密钥）；没勾的不可用，原因写清下一步
    assert.equal((row.match(/data-checkrow=""/g) ?? []).length, 1, key);
    assert.match(row, /先点右边的铅笔填写密钥，才能勾选这一家的模型/);
  }
  // 有密钥照旧：↻ 在，勾选框都可用
  const [ok] = rows(
    block({ providers: [{ ...bare("missing"), key: "set" }] }, { expanded: new Set(["or"]) }),
  );
  assert.match(ok, /刷新模型列表/);
  assert.equal((ok.match(/data-checkrow=""/g) ?? []).length, 2);
  // 编辑一家还没有密钥的：光标在密钥框（地址已经有了）；新建与有密钥时仍在地址框
  const form = (p: GatewayProvider | null) =>
    render(GatewayForm, {
      state: state({ providers: p ? [p] : [] }),
      provider: p,
      busy: false,
      onSave: async () => "x",
      onFetchModels: async () => {},
      onSaved: noop,
      onCancel: noop,
      onDirtyChange: noop,
      ask: null,
    });
  const focused = (html: string) => html.match(/<input[^>]*autofocus[^>]*>/gi) ?? [];
  assert.match(focused(form(bare("missing"))).join(""), /type="password"/);
  assert.doesNotMatch(
    focused(form({ ...bare("missing"), key: "set" })).join(""),
    /type="password"/,
  );
  assert.doesNotMatch(focused(form(null)).join(""), /type="password"/);
});
// #144：拉列表的接口不一定验密钥（OpenRouter），真发请求被拒了密钥才知道。那一家照「无法连接」画（红字、原因写全），
// 原因是「密钥无效」；重拉列表清不掉它，所以行尾只有铅笔，不出 `再试一次`；原文从红字前的 `!` 看
test("真实调用被拒了密钥：`地址 · 密钥无效…`（红字前 `!` 是入口，不写「无法连接」）；不出 `再试一次`", () => {
  const reason = "密钥无效，请换一个密钥";
  const detail = "POST https://openrouter.ai/api/v1/chat/completions → 401 Unauthorized";
  const rejected: GatewayProvider = {
    ...or(reason),
    unreachableDetail: detail,
    keyRejectedOnCall: true,
    keyInvalid: true,
    models: [model({ selected: true }), model({ id: "b", slug: "b" })],
  };
  // 密钥被拒时网络是通的：红字直接是原因，不写「无法连接」（2026-10-06）
  assert.deepEqual(gatewayFacts(rejected), {
    url: "https://openrouter.ai/api/v1",
    statusKind: "unreachable",
    status: reason,
    reason: null,
    picked: null,
  });
  const [, row] = rows(block({ providers: [ap(), rejected] }));
  assert.match(
    row,
    new RegExp(`ss-markbtn--row"[^>]*>[^]*?</button><span class="gw-row__down">${reason}<`),
  );
  assert.doesNotMatch(row, /无法连接/);
  assert.doesNotMatch(row, /gw-row__reason/);
  assert.doesNotMatch(row, /已连接/);
  assert.doesNotMatch(row, />详情</);
  assert.match(row, /aria-label="编辑"/);
  assert.doesNotMatch(row, />再试一次</);
  assert.doesNotMatch(row, /刷新模型列表/);
  // 拉列表记下的「密钥无效」照旧给 `再试一次`，同样不写「无法连接」；没拉到模型时空态也不说「无法连接」
  const fetchedRejected: GatewayProvider = { ...or(reason), keyInvalid: true };
  const [, fetched] = rows(
    block({ providers: [ap(), fetchedRejected] }, { expanded: new Set(["or"]) }),
  );
  assert.match(fetched, />再试一次</);
  assert.match(fetched, new RegExp(`gw-row__down">${reason}<`));
  assert.doesNotMatch(fetched, /无法连接/);
  assert.match(
    fetched,
    /gw-row__none"><p class="ss-note"><span class="ss-note__text">还没拉到模型</,
  );
});
