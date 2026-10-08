/// 添加 / 编辑模型提供商的弹窗（画板 9UGdeLt4rvg2dm8SpStvHo 第 9 屏；DESIGN「模型提供商页 › 加一家」）。
/// 服务端渲染只看初始态：编辑弹窗只有名称、地址、密钥；添加弹窗第一步是预设名单；「启用的模型」那一块拆成纯展示的
/// `DialogModels` 各态断言。勾选、拉列表、问丢弃的纯逻辑在 providers-view.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { render } from "./ui-render.ts";
import type { ProviderRow } from "../src/types.ts";

const { ProviderDialog, DialogModels } = await import("../src/ProviderDialog.tsx");
const noop = () => {};

const row: ProviderRow = {
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  protocol: "chat",
  preset: "deepseek",
  key: "set",
  keyProblem: null,
  models: [],
  enabled: 2,
  total: 6,
  defaultRule: "recommended",
  agents: [],
  unreachable: null,
  unreachableDetail: null,
  keyInvalid: false,
};

test("编辑弹窗：确认框的层、宽档 480；标题「编辑 DeepSeek」；只有名称、地址、密钥（留空不改），没有模型列表", () => {
  const html = render(ProviderDialog, { row, rows: [row], onClose: noop, onSaved: noop });
  assert.match(html, /class="ss-confirm-veil ss-confirm-veil--full"/);
  assert.match(
    html,
    /<div class="ss-confirm ss-confirm--wide"[^>]*role="dialog"[^>]*aria-modal="true"/,
  );
  assert.match(html, /class="ss-confirm__title"[^>]*>编辑 DeepSeek</);
  for (const label of ["名称", "地址", "密钥"]) {
    assert.match(html, new RegExp(`<label class="gw-form__label"[^>]*>${label}</label>`));
  }
  assert.match(html, /placeholder="已保存，留空则不改"/);
  assert.doesNotMatch(html, /启用的模型/);
  assert.doesNotMatch(html, /换一家/);
  // 键区：取消（默认键）、保存（墨键），高 32 的那一档
  assert.match(
    html,
    /class="ss-confirm__foot".*<button[^>]*class="ss-btn ss-btn--row"[^>]*>取消<\/button>.*<button[^>]*class="ss-btn ss-btn--primary ss-btn--row"[^>]*>保存<\/button>/,
  );
});

test("添加弹窗第一步：标题「添加模型提供商」，预设名单在弹窗里选；还没有保存键", () => {
  const html = render(ProviderDialog, { row: null, rows: [], onClose: noop, onSaved: noop });
  assert.match(html, /class="ss-confirm__title"[^>]*>添加模型提供商</);
  assert.match(html, /class="gw-preset"/);
  assert.match(html, /自定义地址…/);
  assert.doesNotMatch(html, />保存</);
});

const models = [
  { id: "deepseek-v4-pro" },
  { id: "deepseek-flash" },
  { id: "deepseek-chat", contextWindow: 131072 },
];

test("启用的模型 · 拉到列表：区块小标、规则一句、搜索、勾选行照勾选画，框底填 id", () => {
  const html = render(DialogModels, {
    name: "DeepSeek",
    state: {
      status: "ok",
      preview: {
        models,
        enabled: ["deepseek-v4-pro", "deepseek-flash"],
        rule: "recommended",
        apiBase: "x",
      },
    },
    chosen: ["deepseek-v4-pro", "deepseek-flash"],
    extra: [],
    query: "",
    onQuery: noop,
    onToggle: noop,
    onTyped: async () => "x",
  });
  assert.match(html, /class="ss-sectionlabel[^"]*"[^>]*>.*启用的模型/);
  assert.match(html, /按推荐启用了 2 个/);
  assert.match(html, /placeholder="搜索 DeepSeek 的 3 个对话模型"/);
  assert.match(html, /role="checkbox" aria-checked="true"[^>]*>.*deepseek-v4-pro/);
  assert.match(html, /role="checkbox" aria-checked="false"[^>]*>.*deepseek-chat/);
  assert.match(html, /placeholder="列表里没有？填模型 id"/);
  assert.match(html, />试一下再启用</);
});

test("启用的模型 · 正在拉：刻度 + 正在拉模型", () => {
  const html = render(DialogModels, {
    name: "DeepSeek",
    state: { status: "loading" },
    chosen: [],
    extra: [],
    query: "",
    onQuery: noop,
    onToggle: noop,
    onTyped: async () => "x",
  });
  assert.match(html, /class="ss-spinner/);
  assert.match(html, /正在拉模型/);
  assert.doesNotMatch(html, /role="checkbox"/);
});

test("启用的模型 · 拉不到：灰面板「拉不到模型列表 · 原因」带 ! 原文，下面一句仍可保存；没有键", () => {
  const html = render(DialogModels, {
    name: "DeepSeek",
    state: {
      status: "failed",
      message: "密钥无效，请换一个密钥",
      detail: "GET https://api.deepseek.com/models · 401",
    },
    chosen: [],
    extra: [],
    query: "",
    onQuery: noop,
    onToggle: noop,
    onTyped: async () => "x",
  });
  assert.match(html, /class="ss-noticepanel[^"]*"/);
  assert.match(html, /拉不到模型列表/);
  assert.match(html, /密钥无效，请换一个密钥/);
  assert.match(html, /aria-label="查看错误详情"/);
  assert.match(html, /也可以先保存，模型以后在提供商列表那一行的「启用模型」里挑/);
  assert.doesNotMatch(html, /试一下再启用/);
});

test("弹窗的排版：标签在上（12 ink-mute，下 4 是输入框）；勾选行容器向左让出 8；页面 CSS 不写行与悬停带", () => {
  const css = readFileSync(new URL("../src/ProvidersPage.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.provider-dialog__field\s*\{[^}]*flex-direction: column;[^}]*gap: var\(--space-xxs\)/,
  );
  assert.match(
    css,
    /\.provider-dialog__list\s*\{[^}]*margin-inline: calc\(var\(--space-xs\) \* -1\)/,
  );
  assert.doesNotMatch(css, /provider-dialog[^{]*:hover/);
});

// 走查 2026-10-08（产品负责人截图「这个页面问题太多了」）
test("弹窗不高过窗口：标题与键区钉住，中间一层在弹窗里滚动（带边缘渐隐）", () => {
  const html = render(ProviderDialog, { row, rows: [row], onClose: noop, onSaved: noop });
  assert.match(
    html,
    /class="ss-confirm__title"[^>]*>编辑 DeepSeek<\/div><div class="ss-layer__viewport ss-formdialog__viewport"[^>]*><div class="ss-formdialog__body"[^>]*>/,
  );
  // 键区在滚动层外面（滚动层之后）
  assert.match(html, /ss-formdialog__body.*<\/div><\/div><div class="ss-confirm__foot">/);
  const ui = readFileSync(new URL("../src/ui/ui.css", import.meta.url), "utf8");
  const block = (sel: string) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = ui.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
    assert.ok(m, `找不到规则 ${sel}`);
    return m[1];
  };
  // 最高＝窗口高减上下各 24（遮罩层的内边距）
  assert.match(block(".ss-confirm--wide"), /max-height:\s*calc\(100vh - 2 \* var\(--space-xl\)\)/);
  assert.match(block(".ss-confirm--wide"), /flex-direction:\s*column/);
  assert.match(block(".ss-formdialog__viewport"), /flex:\s*1 1 auto/);
  assert.match(block(".ss-formdialog__body"), /overflow-y:\s*auto/);
});

test("编辑弹窗：名称下不再复述「会显示在哪」；密钥框空着时下面没有话", () => {
  const html = render(ProviderDialog, { row, rows: [row], onClose: noop, onSaved: noop });
  assert.doesNotMatch(html, /会显示在模型提供商列表/);
  assert.doesNotMatch(html, /这看起来不是密钥/);
});

// 产品负责人 2026-10-08：弹窗里只留一层滚动——勾选列表不再限高 156、不自己滚、不渐隐，全部展开，跟着弹窗内容一起滚
test("启用的模型 · 列表不限高：全部展开、跟着弹窗一起滚（没有自己的滚动层与渐隐）；搜索框在列表上方", () => {
  const html = render(DialogModels, {
    name: "DeepSeek",
    state: {
      status: "ok",
      preview: { models, enabled: [], rule: "all", apiBase: "x" },
    },
    chosen: [],
    extra: [],
    query: "",
    onQuery: noop,
    onToggle: noop,
    onTyped: async () => "x",
  });
  assert.doesNotMatch(html, /ss-layer__viewport/);
  assert.match(
    html,
    /placeholder="搜索 DeepSeek 的 3 个对话模型".*class="provider-dialog__list".*deepseek-v4-pro/,
  );
  const css = readFileSync(new URL("../src/ProvidersPage.css", import.meta.url), "utf8");
  const list = css.match(/\.provider-dialog__list\s*\{([^}]*)\}/);
  assert.ok(list, "找不到 .provider-dialog__list");
  assert.doesNotMatch(list[1], /max-height|overflow/);
  assert.doesNotMatch(css, /provider-dialog__scroll|provider-dialog__viewport/);
});

// 走查 2026-10-08 第 13 张：保存失败的灰面板文字列只占约 2/3 宽就折、「请检 / 查」从词中间断开。
// 节档的主句贪心折行（不用根上的 pretty，它会为了各行齐整提前折），中文只在标点处折，没有标点放不下才在任意处折
test("灰面板节档：主句占满再折、只在标点处折（keep-all + 贪心折行）", () => {
  const ui = readFileSync(new URL("../src/ui/ui.css", import.meta.url), "utf8");
  const m = ui.match(/\n\.ss-noticepanel--section \.ss-noticepanel__message\s*\{([^}]*)\}/);
  assert.ok(m, "找不到 .ss-noticepanel--section .ss-noticepanel__message");
  assert.match(m[1], /word-break: keep-all;/);
  assert.match(m[1], /overflow-wrap: anywhere;/);
  assert.match(m[1], /text-wrap: wrap;/);
});

// 走查 2026-10-08 第 01 张：560 高里预设名单的框底与「自定义地址…」被弹窗下沿的渐隐切掉，名单框自己滚、弹窗也滚，
// 两层滚动。预设那一步弹窗中间不滚（`stretch`），名单框随弹窗余下的高收矮、只在名单里滚，「自定义地址…」钉在框底
test("添加弹窗第一步只有一层滚动：弹窗中间不滚、名单框随余下的高收矮，名单在框里滚", () => {
  const html = render(ProviderDialog, { row: null, rows: [], onClose: noop, onSaved: noop });
  assert.match(html, /class="ss-formdialog__body ss-formdialog__body--stretch"/);
  const ui = readFileSync(new URL("../src/ui/ui.css", import.meta.url), "utf8");
  const fill = ui.match(/\n\.ss-formdialog__body--stretch\s*\{([^}]*)\}/);
  assert.ok(fill, "找不到 .ss-formdialog__body--stretch");
  assert.match(fill[1], /display: flex;/);
  assert.match(fill[1], /overflow-y: hidden;/);
  const page = readFileSync(new URL("../src/ProvidersPage.css", import.meta.url), "utf8");
  assert.match(page, /\.provider-dialog--stretch[^{]*\{[^}]*flex: 1 1 auto;[^}]*min-height: 0;/);
  const form = readFileSync(new URL("../src/gatewayForm.css", import.meta.url), "utf8");
  for (const sel of [".gw-preset", ".gw-preset__box", ".gw-preset__scroll"]) {
    const esc = sel.replace(/[.]/g, "\\.");
    const m = form.match(new RegExp(`\\n${esc}\\s*\\{([^}]*)\\}`));
    assert.ok(m, sel);
    assert.match(m[1], /min-height: 0;/, sel);
  }
  // 填表那一步照旧在弹窗里滚
  const edit = render(ProviderDialog, { row, rows: [row], onClose: noop, onSaved: noop });
  assert.doesNotMatch(edit, /ss-formdialog__body--stretch/);
});
