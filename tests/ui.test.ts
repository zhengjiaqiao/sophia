/// 展示组件的渲染断言（UI v4：docs/DESIGN.md「材料与工艺」及其下各节，画板 States / Marks / Feedback）。
/// 渲染方式见 ui-render.ts（node:test + typescript 转 JSX + react-dom/server）。
///
/// 旧断言里钉住 v3 设计的那几条（ghost pill 按钮、反色按钮当开关、带框方标签、
/// 「导入」文案、白底线框提示条与行内待办条、带框确认弹窗）属于被新规范推翻的行为，
/// 按新规范重写，不是放宽。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { render } from "./ui-render.ts";

const noop = () => {};
const uiCss = readFileSync(new URL("../src/ui/ui.css", import.meta.url), "utf8");
const tokensCss = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8");

/// 取 ui.css 里一条规则的声明块；找不到就让断言失败，别静默放过
function cssRule(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n|,)\\s*${esc}\\s*(?:,[^{]*)?\\{([^}]*)\\}`));
  assert.ok(match, `找不到规则 ${selector}`);
  return match[1];
}

const { StateDot, DupMark, DOT_LABEL } = await import("../src/ui/StateDot.tsx");
const { Button, IconButton, AddButton } = await import("../src/ui/Button.tsx");
const { Switch, Checkbox } = await import("../src/ui/Switch.tsx");
const { Chip, ModelChip } = await import("../src/ui/Chip.tsx");
const { Tag } = await import("../src/ui/Tag.tsx");
const { Tooltip, TIP_DELAY_MS } = await import("../src/ui/Tooltip.tsx");
const { Spinner } = await import("../src/ui/Spinner.tsx");
const { Toast, TOAST_DWELL_MS, CELL_TOAST_DWELL_MS } = await import("../src/ui/Toast.tsx");
const { ErrorBanner, NoticePanel } = await import("../src/ui/ErrorBanner.tsx");
const { Confirm } = await import("../src/ui/Confirm.tsx");
const { SubPage, holdInert, pickTrigger, triggerKey } = await import("../src/ui/SubPage.tsx");
const { Cap, capRuns } = await import("../src/ui/Cap.tsx");
const { AgentIcon, AgentKey, AgentMark, agentInitial, hasAgentIcon } =
  await import("../src/ui/AgentMark.tsx");
const { Busy, Empty } = await import("../src/ui/Empty.tsx");
const { IconCheck } = await import("../src/ui/icons.tsx");

test("index 把组件和样式一起交出去，用的人不必自己 import css", async () => {
  const ui = await import("../src/ui/index.ts");
  const exported = [
    "StateDot",
    "DupMark",
    "Button",
    "IconButton",
    "AddButton",
    "Switch",
    "Checkbox",
    "Chip",
    "ModelChip",
    "Tag",
    "Tooltip",
    "Spinner",
    "Toast",
    "ErrorBanner",
    "NoticePanel",
    "Confirm",
    "SubPage",
    "Cap",
    "AgentMark",
    "AgentIcon",
    "AgentKey",
    "Empty",
    "Busy",
  ];
  for (const name of exported) {
    assert.equal(typeof (ui as Record<string, unknown>)[name], "function", name);
  }
  // 已删：方标签（有框的都能点）与左下贴底待处理窗（定稿增量取消）
  assert.equal((ui as Record<string, unknown>).TagSquare, undefined);
  assert.equal((ui as Record<string, unknown>).PendingWindow, undefined);
});

// ===== 设计变量 =====

test("tokens：七个中性灰、2px 控件圆角、28/24/32 控件高、行高 34、机械缓动", () => {
  for (const [name, value] of [
    ["canvas", "#ffffff"],
    ["surface", "#f2f2f2"],
    ["hairline", "#e2e2e2"],
    ["ink", "#000000"],
    ["ink-mute", "#5a5a5a"],
    ["ink-faint", "#9a9a9a"],
    ["disabled", "#c8c8c8"],
  ]) {
    assert.match(tokensCss, new RegExp(`--${name}:\\s*${value};`), name);
  }
  assert.doesNotMatch(tokensCss, /--ink-faint-inverse/);
  // 圆角随尺寸：记号 3、控件 6、浮层 8、弹窗 12、胶囊 32（UI v4 视觉调整；原「控件 2px」已退役）
  assert.match(tokensCss, /--radius-mark:\s*3px;/);
  assert.match(tokensCss, /--radius-control:\s*6px;/);
  assert.match(tokensCss, /--radius-layer:\s*8px;/);
  assert.match(tokensCss, /--radius-dialog:\s*12px;/);
  assert.match(tokensCss, /--radius-pill:\s*32px;/);
  // 浮层阴影两档，逐字；遮罩黑 18%
  assert.match(
    tokensCss,
    /--elev-layer: 0 0 0 1px rgba\(0,0,0,\.08\), 0 12px 32px rgba\(0,0,0,\.14\), 0 2px 6px rgba\(0,0,0,\.06\);/,
  );
  assert.match(tokensCss, /--elev-tip: 0 4px 12px rgba\(0,0,0,\.14\);/);
  assert.match(tokensCss, /--veil-opacity:\s*0\.18;/);
  assert.match(tokensCss, /--control-h:\s*28px;/);
  assert.match(tokensCss, /--control-h-compact:\s*24px;/);
  assert.match(tokensCss, /--control-h-row:\s*32px;/);
  assert.match(tokensCss, /--row-h:\s*34px;/);
  assert.match(tokensCss, /--motion-fast:\s*120ms;/);
  assert.match(tokensCss, /--ease-mech:\s*cubic-bezier\(0\.2, 0\.8, 0\.2, 1\);/);
  assert.match(tokensCss, /--motion-spinner:\s*1\.2s;/);
  assert.match(tokensCss, /--motion-dots:\s*500ms;/);
  // 自创转盘已删，它的时长 token 不该回来
  assert.doesNotMatch(tokensCss, /--motion-rotor/);
});

test("动效：状态变化走 120ms 机械缓动，不退化成默认 transition；减少动效时关掉", () => {
  // 每一条 transition 声明都必须带 --ease-mech（默认 ease 是 300ms 淡入淡出的那种手感）
  for (const m of uiCss.matchAll(/transition:([^;]+);/g)) {
    const decl = m[1].trim();
    if (decl === "none") continue;
    for (const part of decl.split(/,(?![^(]*\))/)) {
      assert.match(
        part,
        /var\(--motion-fast\) var\(--ease-mech\)/,
        `transition 没用机械缓动：${part}`,
      );
    }
  }
  assert.match(uiCss, /@media \(prefers-reduced-motion: reduce\)/);
  // 地球绕太阳：1.2s 线性匀速（关键帧 ss-spin，整颗 svg 绕中心转）；自创转盘的样式已删
  assert.match(cssRule(uiCss, ".ss-spinner"), /ss-spin var\(--motion-spinner\) linear infinite/);
  // 减少动效：不转（地球停在 12 点钟），文字后的三点每 500ms 增减一点
  const reduced = uiCss.slice(uiCss.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.ss-spinner \{\s*animation: none;/);
  assert.match(
    reduced,
    /\.ss-spinner \+ \*::after,\s*:has\(> \.ss-spinner:last-child\)::after \{[^}]*content: "\.\.\.";[^}]*ss-dots calc\(var\(--motion-dots\) \* 4\) step-end infinite/,
  );
  assert.match(uiCss, /@keyframes ss-dots/);
  assert.doesNotMatch(uiCss, /\.ss-rotor/);
});

// ===== 状态点 =====

test("StateDot 10px 家族：八种各自一个记号，默认带读屏名与 title", () => {
  for (const dot of [
    "linked",
    "missing",
    "own",
    "none",
    "broken",
    "readOnly",
    "blocked",
    "wholeLinked",
  ] as const) {
    const html = render(StateDot, { dot });
    assert.match(html, new RegExp(`data-dot="${dot}"`), dot);
    assert.match(html, /width="10" height="10" viewBox="0 0 10 10"/, dot);
    assert.match(html, new RegExp(`aria-label="${DOT_LABEL[dot]}"`), dot);
    assert.match(html, new RegExp(`title="${DOT_LABEL[dot]}"`), dot);
    assert.match(html, /role="img"/, dot);
  }
});

test("StateDot 异常：失效＝4 段虚线环、写不进＝斜杠环、同名被挡＝环内短横、整个文件夹是链接＝环内箭头", () => {
  assert.match(render(StateDot, { dot: "broken" }), /stroke-dasharray="5\.2 1\.5"/);
  assert.match(render(StateDot, { dot: "readOnly" }), /d="M2 8 L8 2"/);
  assert.match(render(StateDot, { dot: "blocked" }), /d="M3 5 H7"/);
  assert.match(
    render(StateDot, { dot: "wholeLinked" }),
    /d="M2\.9 5 H7\.1 M5\.3 3\.2 L7\.1 5 L5\.3 6\.8"/,
  );
});

test("StateDot 16px 版：与格内同形", () => {
  const html = render(StateDot, { dot: "broken", size: 16, title: "链接失效" });
  assert.match(html, /width="16" height="16" viewBox="0 0 16 16"/);
  assert.match(html, /stroke-dasharray="8\.4 1\.5"/);
});

test("StateDot 可点：渲染成按钮；只有开 / 关两种出悬停光晕", () => {
  const linked = render(StateDot, { dot: "linked", onClick: noop, title: "点一下关闭" });
  assert.match(linked, /<button type="button" class="ss-dot-btn"/);
  assert.match(linked, /data-hoverable=""/);
  assert.match(linked, /class="ss-dot__fill"/);
  const missing = render(StateDot, { dot: "missing", onClick: noop });
  assert.match(missing, /data-hoverable=""/);
  // 光晕：直径 22 的圆，先画、压在点下层
  assert.match(missing, /data-hoverable=""[^>]*><circle class="ss-dot__halo" cx="5" cy="5" r="11"/);
  // 调用方自己渲染外层按钮：hoverable 让不带 onClick 的点也出光晕
  assert.match(render(StateDot, { dot: "missing", hoverable: true }), /class="ss-dot__halo"/);
  // 原件与异常点了不是开关：不出光晕
  for (const dot of ["own", "broken"] as const) {
    const html = render(StateDot, { dot, onClick: noop });
    assert.doesNotMatch(html, /data-hoverable|ss-dot__halo/);
  }
  // 不可点的不出光晕
  assert.doesNotMatch(render(StateDot, { dot: "missing" }), /data-hoverable|ss-dot__halo/);
});

// 悬停时改点本身的两代做法都已退役（真机反馈：点一变就被读成已经点了）——
// 先是 ● 褪成空环，后是 40% 浓度（○ 环内填 40%、● 整颗淡到 40%）
test("StateDot 悬停：点本身不变，只在下层出 hairline 光晕（surface 行带上也看得出）", () => {
  // 未加上的环内不再藏一颗预览实心
  assert.doesNotMatch(render(StateDot, { dot: "missing", onClick: noop }), /ss-dot__preview/);
  assert.doesNotMatch(uiCss, /ss-dot__preview|data-preview/);
  // 悬停 / 键盘聚焦时，选到点（.ss-dot，不含外层按钮 .ss-dot-btn）的规则只许动光晕
  const css = uiCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const hoverRules = [...css.matchAll(/([^{}]*:(?:hover|focus-visible)[^{}]*)\{([^}]*)\}/g)]
    .flatMap(([, sel, body]) => sel.split(",").map((part) => [part.trim(), body] as const))
    .filter(([sel]) => /:(?:hover|focus-visible).*\.ss-dot(?!-btn)/.test(sel));
  assert.ok(hoverRules.length >= 2);
  for (const [sel, body] of hoverRules) {
    assert.match(sel, /\.ss-dot__halo$/, sel);
    assert.match(body, /^\s*opacity:\s*1;\s*$/);
  }
  assert.match(uiCss, /\.ss-dot__halo \{\s*fill: var\(--hairline\);\s*opacity: 0;/);
  assert.doesNotMatch(uiCss, /\.ss-dot__fill[^{]*\{\s*opacity:\s*0;/);
  // 闪烁帧（黑底）上不出光晕
  const matrixCss = readFileSync(new URL("../src/Matrix.css", import.meta.url), "utf8");
  assert.doesNotMatch(matrixCss, /ss-dot__preview|data-preview/);
  assert.match(
    matrixCss,
    /\.mx-cell\.ss-flash \.ss-dot-btn \.ss-dot\[data-hoverable\] \.ss-dot__halo \{\s*opacity:\s*0;/,
  );
});

test("StateDot 反色闪与禁用灰：inverse 转白、muted 转 disabled", () => {
  assert.match(
    render(StateDot, { dot: "linked", inverse: true }),
    /class="ss-dot ss-dot--linked is-inverse"/,
  );
  assert.match(
    render(StateDot, { dot: "own", muted: true }),
    /class="ss-dot ss-dot--own is-muted"/,
  );
});

test("DupMark：名字后 ×2", () => {
  const row = render(DupMark, {});
  assert.match(row, /class="ss-dup ss-dup--row"/);
  assert.match(row, />×2</);
  assert.match(row, /aria-label="同名：有 2 份"/);
  assert.match(render(DupMark, { count: 3 }), />×3</);
});

// ===== 按钮 =====

test("Button 默认：2px 描边矩形，不大写、字距 0、Barlow 13/600", () => {
  const html = render(Button, { children: "配置网关", onClick: noop });
  assert.match(html, /class="ss-btn"/);
  const rule = cssRule(uiCss, ".ss-btn");
  assert.match(rule, /border-radius:\s*var\(--radius-control\)/);
  assert.match(rule, /font-family:\s*var\(--font-ui\)/);
  assert.match(rule, /font-weight:\s*600/);
  assert.match(rule, /letter-spacing:\s*0/);
  assert.doesNotMatch(rule, /text-transform/);
  assert.match(rule, /height:\s*var\(--control-h\)/);
});

test("Button 三个尺寸：regular 28 / compact 24 / row 32", () => {
  assert.match(
    render(Button, { children: "重启", size: "compact", onClick: noop }),
    /class="ss-btn ss-btn--compact"/,
  );
  assert.match(
    render(Button, { children: "添加 6 个", size: "row", variant: "primary", onClick: noop }),
    /class="ss-btn ss-btn--primary ss-btn--row"/,
  );
  assert.match(cssRule(uiCss, ".ss-btn--compact"), /height:\s*var\(--control-h-compact\)/);
  assert.match(cssRule(uiCss, ".ss-btn--row"), /height:\s*var\(--control-h-row\)/);
});

test("Button 主动作：实心黑；hover 键面内缩 1px 白描边；按下下移 1px 并压扁 1px", () => {
  const html = render(Button, { children: "保存", variant: "primary", onClick: noop });
  assert.match(html, /class="ss-btn ss-btn--primary"/);
  assert.match(cssRule(uiCss, ".ss-btn--primary"), /background:\s*var\(--ink\)/);
  const hover = cssRule(uiCss, ".ss-btn--primary:hover:not(:disabled)");
  assert.match(hover, /outline:\s*1px solid var\(--canvas\)/);
  assert.match(hover, /outline-offset:\s*-3px/);
  const pressed = cssRule(uiCss, ".ss-btn:active:not(:disabled)");
  assert.match(pressed, /transform:\s*translateY\(1px\)/);
  assert.match(pressed, /height:\s*calc\(var\(--control-h\) - 1px\)/);
});

test("Button 禁用：必须同时给原因，挂在 title 上", () => {
  const html = render(Button, {
    children: "添加 0 个",
    variant: "primary",
    disabled: true,
    disabledReason: "先点亮一个 agent",
  });
  assert.match(html, /disabled=""/);
  assert.match(html, /title="先点亮一个 agent"/);
});

test("Button 文字链：命中区高 24、左右各 6；离开 Sophia 的带 10px ↗", () => {
  assert.match(
    render(Button, { children: "取消", variant: "link", onClick: noop }),
    /class="ss-btn ss-btn--link"/,
  );
  const link = cssRule(uiCss, ".ss-btn--link");
  assert.match(link, /height:\s*var\(--hit-min\)/);
  assert.match(link, /margin:\s*0 -6px/);
  assert.match(link, /padding:\s*0 6px/);
  const ext = render(Button, { children: "检查更新", variant: "external", onClick: noop });
  assert.match(ext, /class="ss-btn ss-btn--link ss-btn--external"/);
  assert.match(ext, /<svg class="ss-btn__external" width="10" height="10"/);
});

test("Button 黑面上：白描边键", () => {
  const html = render(Button, { children: "撤销", size: "compact", onDark: true, onClick: noop });
  assert.match(html, /class="ss-btn ss-btn--compact is-on-dark"/);
  assert.match(cssRule(uiCss, ".ss-btn.is-on-dark"), /border-color:\s*var\(--canvas\)/);
});

test("IconButton：28×28，title 必填且同时作 aria-label；不带计数", () => {
  const html = render(IconButton, { icon: IconCheck({}), title: "设置", onClick: noop });
  assert.match(html, /class="ss-iconbtn"/);
  assert.match(html, /title="设置"/);
  assert.match(html, /aria-label="设置"/);
  // 顶栏只剩设置；页签上、图标上都不挂计数（常驻的数字会一直催处理不了的事）
  assert.doesNotMatch(html, /ss-iconbtn__count/);
  assert.doesNotMatch(uiCss, /\.ss-iconbtn__count|\.ss-iconbtn\.has-count/);
});

test("AddButton：开始一个添加流程只有「+ 名词」这一种长相", () => {
  const html = render(AddButton, { noun: "skill", onClick: noop });
  assert.match(html, /class="ss-btn ss-btn--add"/);
  assert.match(html, /title="添加 skill"/);
  assert.match(html, /<path d="M6 1\.5v9M1\.5 6h9"><\/path><\/svg>skill</);
});

// ===== 开关与复选框 =====

test("Switch page 32×18 / inline 24×14：role=switch，读屏名必填", () => {
  const page = render(Switch, { checked: true, onChange: noop, label: "启用 Codex 的第三方模型" });
  assert.match(
    page,
    /role="switch" aria-checked="true" aria-label="启用 Codex 的第三方模型" class="ss-switch ss-switch--page is-on"/,
  );
  const inline = render(Switch, {
    checked: false,
    onChange: noop,
    size: "inline",
    label: "此来源以后新出现的 skill 自动添加",
  });
  assert.match(inline, /aria-checked="false"/);
  assert.match(inline, /class="ss-switch ss-switch--inline"/);
  const pageRule = cssRule(uiCss, ".ss-switch");
  assert.match(pageRule, /width:\s*32px/);
  assert.match(pageRule, /height:\s*18px/);
  const inlineRule = cssRule(uiCss, ".ss-switch--inline");
  assert.match(inlineRule, /width:\s*24px/);
  assert.match(inlineRule, /height:\s*14px/);
});

test("Switch 行程：120ms 机械缓动 + 末端 1px 过冲，按下旋钮压扁；只在拨动后播", () => {
  assert.match(
    uiCss,
    /\.ss-switch\.is-moved \.ss-switch__knob \{\s*animation: ss-knob-off var\(--motion-fast\) var\(--ease-mech\);/,
  );
  assert.match(uiCss, /75% \{\s*transform: translateX\(calc\(var\(--travel\) \+ 1px\)\);/);
  assert.match(
    cssRule(uiCss, ".ss-switch:active:not(:disabled) .ss-switch__knob"),
    /width:\s*calc\(var\(--knob\) \+ var\(--squash\)\)/,
  );
  // 挂载时不带 is-moved：空闲时界面静止
  assert.doesNotMatch(render(Switch, { checked: true, onChange: noop, label: "x" }), /is-moved/);
});

test("Switch 禁用：带原因", () => {
  const html = render(Switch, {
    checked: false,
    onChange: noop,
    label: "x",
    disabledReason: "Codex 还没装",
  });
  assert.match(html, /disabled=""/);
  assert.match(html, /title="Codex 还没装"/);
});

test("Checkbox 12px：未选 / 已选 / 半选 / 不可选", () => {
  assert.match(
    render(Checkbox, { checked: false, label: "defuddle" }),
    /role="checkbox" aria-checked="false"/,
  );
  assert.match(render(Checkbox, { checked: true, label: "defuddle" }), /class="ss-checkbox is-on"/);
  assert.match(render(Checkbox, { checked: "mixed", label: "全选" }), /aria-checked="mixed"/);
  const off = render(Checkbox, { checked: false, label: "docx", disabledReason: "已添加" });
  assert.match(off, /disabled=""/);
  assert.match(off, /title="已添加"/);
  const rule = cssRule(uiCss, ".ss-checkbox");
  assert.match(rule, /width:\s*12px/);
  // 复选框是记号：3 圆角（原 0 圆角已退役）
  assert.match(rule, /border-radius:\s*var\(--radius-mark\)/);
  // 命中区用伪元素撑到 24，不动 border
  assert.match(cssRule(uiCss, ".ss-checkbox::before"), /inset:\s*-6px/);
});

// ===== 片与标签 =====

test("Chip：胶囊 28，名字 13 原样，计数等宽；选中反色", () => {
  const html = render(Chip, { children: "WeiboAP", count: 29, onClick: noop });
  assert.match(html, /class="ss-chip"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /class="ss-chip__count">29</);
  assert.match(
    render(Chip, { children: "全部", count: 56, selected: true, onClick: noop }),
    /class="ss-chip is-selected"/,
  );
  const rule = cssRule(uiCss, ".ss-chip");
  assert.match(rule, /border-radius:\s*var\(--radius-pill\)/);
  assert.match(rule, /font-size:\s*var\(--size-caption\)/);
});

test("Chip 不可选：置灰并给出原因", () => {
  const html = render(Chip, {
    children: "Cline",
    disabled: true,
    disabledReason: "这个 agent 还没装",
  });
  assert.match(html, /disabled=""/);
  assert.match(html, /title="这个 agent 还没装"/);
});

test("ModelChip：高 24，显示友好名、title 放完整 id，× 有读屏名", () => {
  const html = render(ModelChip, {
    name: "Opus 4.6",
    id: "anthropic/claude-opus-4-6",
    onRemove: noop,
  });
  assert.match(html, /class="ss-modelchip" title="anthropic\/claude-opus-4-6"/);
  assert.match(html, />Opus 4\.6</);
  assert.match(html, /aria-label="移除 Opus 4\.6"/);
  assert.match(cssRule(uiCss, ".ss-modelchip"), /height:\s*var\(--control-h-compact\)/);
});

test("Tag：不可点的标识没有框——强 ink 600 / 弱 ink-faint 400", () => {
  assert.match(render(Tag, { children: "同名" }), /class="ss-tag ss-tag--strong"/);
  assert.match(render(Tag, { children: "已添加", tone: "weak" }), /class="ss-tag ss-tag--weak"/);
  assert.doesNotMatch(cssRule(uiCss, ".ss-tag"), /(^|\s)border(-[a-z]+)?:/);
});

test("Tag 可悬停不可点：点状下划线 + 提示框（aria-describedby）", () => {
  const html = render(Tag, { children: "2 份不一样", tip: "url 不同" });
  assert.match(html, /class="ss-tag ss-tag--strong has-tip"/);
  assert.match(html, /tabindex="0" aria-describedby="[^"]+"/);
  assert.match(html, /role="tooltip"[^>]*>url 不同</);
  assert.match(
    cssRule(uiCss, ".ss-tag.has-tip"),
    /text-decoration:\s*underline dotted var\(--ink-faint\)/,
  );
});

// ===== 提示框 =====

test("Tooltip：黑窗白字 12，内边距 6 8，最大宽 240；内容作 aria-describedby", () => {
  const html = render(Tooltip, {
    content: "点一下开启",
    shortcut: "空格",
    context: "table",
    children: createElement("button", { type: "button" }, "格"),
  });
  const id = html.match(/role="tooltip"/) && html.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(id, "触发控件要挂 aria-describedby");
  assert.match(html, new RegExp(`id="${id}" role="tooltip"`));
  assert.match(
    html,
    /点一下开启<span class="ss-tip__keyhint"> · <span class="ss-tip__key">空格<\/span><\/span>/,
  );
  // 快捷键只给键盘：默认不显示，触发控件 :focus-visible（键盘焦点）时才显示
  assert.match(cssRule(uiCss, ".ss-tip__keyhint"), /display:\s*none/);
  assert.match(uiCss, /\.ss-tipwrap:has\(:focus-visible\) \.ss-tip__keyhint \{\s*display: inline;/);
  // 静止时不显示；原生 title 不作唯一说明
  assert.doesNotMatch(html, /is-open/);
  const rule = cssRule(uiCss, ".ss-tip");
  assert.match(rule, /padding:\s*6px 8px/);
  assert.match(rule, /max-width:\s*240px/);
  assert.match(rule, /background:\s*var\(--ink\)/);
  assert.match(rule, /font-size:\s*var\(--size-micro\)/);
  assert.match(cssRule(uiCss, ".ss-tip--top"), /bottom:\s*calc\(100% \+ 6px\)/);
});

test("Tooltip 时机：表格内 700ms、表格外 400ms", () => {
  assert.equal(TIP_DELAY_MS.table, 700);
  assert.equal(TIP_DELAY_MS.default, 400);
});

test("Spinner：地球绕太阳，太阳大地球小、不画轨道、必带读屏文本；14 / 24 两档", () => {
  const small = render(Spinner, { label: "正在重启 Codex" });
  assert.match(small, /class="ss-spinner"/);
  assert.match(small, /width="14"/);
  assert.match(small, /aria-label="正在重启 Codex"/);
  // 14：太阳直径 5.5 居中，地球直径 2.5 在 12 点钟贴上沿
  assert.match(small, /class="ss-spinner__sun" cx="7" cy="7" r="2.75" fill="currentColor"/);
  assert.match(small, /class="ss-spinner__earth" cx="7" cy="1.25" r="1.25" fill="currentColor"/);
  // 不画轨道线：没有描边（环 + 中心点会撞原件记号 ⦿）
  assert.doesNotMatch(small, /stroke/);
  const large = render(Spinner, { size: 24, label: "正在读 3 个位置" });
  assert.match(large, /width="24"/);
  assert.match(large, /class="ss-spinner__sun" cx="12" cy="12" r="4.5"/);
  assert.match(large, /class="ss-spinner__earth" cx="12" cy="2" r="2"/);
  assert.doesNotMatch(large, /stroke/);
});

// ===== 提示条 =====

test("Toast notice 成功：黑显示窗，40px 指示窗 ✓ + 动词 + 白图标 + 名字 + 白描边撤销 + ×", () => {
  const html = render(Toast, {
    kind: "success",
    verb: "写进",
    agents: [{ id: "claude-code", name: "Claude Code" }],
    names: ["excalidraw", "notion"],
    action: { label: "撤销", onClick: noop },
    onClose: noop,
  });
  assert.match(html, /class="ss-toast ss-toast--notice"/);
  assert.match(html, /class="ss-toast__indicator" title="成功" role="img" aria-label="成功"/);
  assert.match(html, /class="ss-toast__verb">写进</);
  assert.match(html, /role="img" aria-label="Claude Code"/);
  assert.match(html, /class="ss-toast__names">excalidraw、notion</);
  assert.match(html, /class="ss-btn ss-btn--compact is-on-dark">撤销</);
  assert.match(html, /aria-label="关闭"/);
  assert.equal(TOAST_DWELL_MS.success, 6000);
  const rule = cssRule(uiCss, ".ss-toast--notice");
  assert.match(rule, /background:\s*var\(--ink\)/);
  assert.match(rule, /max-width:\s*400px/);
  // 无外框；提示条 8 圆角 + 浮层阴影 tip（原「0 圆角、无阴影」已退役）
  assert.doesNotMatch(rule, /(^|\s)border(-(?!radius)[a-z]+)?:/);
  assert.match(rule, /border-radius:\s*var\(--radius-layer\)/);
  assert.match(rule, /box-shadow:\s*var\(--elev-tip\)/);
  assert.match(cssRule(uiCss, ".ss-toast__indicator"), /width:\s*40px/);
});

test("Toast 名字超过两个写 +N，不逐个列", () => {
  const html = render(Toast, { kind: "success", verb: "开启", names: ["a", "b", "c", "d", "e"] });
  assert.match(html, />\+5</);
  assert.doesNotMatch(html, />a、b/);
});

test("Toast 做不成：⊘ + 否定动词 + 一句原因 + 副行，停 8 秒", () => {
  const html = render(Toast, {
    kind: "cannot",
    verb: "没开启",
    agents: [{ id: "codex", name: "Codex" }],
    names: ["defuddle"],
    reason: "已有同名",
    stats: "~/.codex/skills/defuddle",
    onClose: noop,
  });
  assert.match(html, /title="做不成"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /class="ss-toast__verb">没开启</);
  assert.match(html, /class="ss-toast__reason">已有同名</);
  assert.match(html, /class="ss-toast__stats">~\/\.codex\/skills\/defuddle</);
  assert.equal(TOAST_DWELL_MS.cannot, 8000);
});

test("Toast 部分失败：! + 2 ✓ · 1 ⊘ 读数 + 查看，停 8 秒", () => {
  const html = render(Toast, {
    kind: "partial",
    verb: "开启",
    tally: { done: 2, failed: 1 },
    reason: "Cline 写不进",
    action: { label: "查看", onClick: noop },
  });
  assert.match(html, /title="部分失败"/);
  assert.match(html, /aria-label="2 个成功，1 个没成"/);
  assert.match(html, />查看</);
  assert.equal(TOAST_DWELL_MS.partial, 8000);
});

test("Toast 需要注意（新问题一次性提示）：! + 主语加粗 + 半句 + 查看 + ×，读屏名不是「部分失败」", () => {
  const html = render(Toast, {
    kind: "attention",
    verb: "defuddle",
    reading: "有两份",
    action: { label: "查看", onClick: noop },
    onClose: noop,
  });
  assert.match(html, /class="ss-toast ss-toast--notice" data-kind="attention" role="status"/);
  assert.match(html, /title="需要注意"/);
  assert.match(html, /class="ss-toast__verb">defuddle</);
  assert.match(html, /class="ss-toast__reading">有两份</);
  assert.match(html, />查看</);
  assert.match(html, /aria-label="关闭"/);
});

test("Toast 展开态：删原件的后果与路径放在副行之下", () => {
  const html = render(Toast, {
    kind: "success",
    verb: "删到废纸篓",
    names: ["docx"],
    detail: "示意图",
  });
  assert.match(html, /class="ss-toast ss-toast--notice has-detail"/);
  assert.match(html, /class="ss-toast__detail">示意图</);
});

test("Toast routine：一行墨字落在白底上，无框无底，撤销是文字链", () => {
  const html = render(Toast, {
    tier: "routine",
    kind: "success",
    verb: "写进",
    agents: [{ id: "codex", name: "Codex" }],
    names: ["excalidraw"],
    action: { label: "撤销", onClick: noop },
  });
  assert.match(html, /class="ss-toast ss-toast--routine"/);
  assert.match(html, /class="ss-toast__verb">写进</);
  assert.match(html, /class="ss-btn ss-btn--link">撤销</);
  assert.doesNotMatch(html, /ss-toast__indicator/);
  const rule = cssRule(uiCss, ".ss-toast--routine");
  // 无框无底（圆角随提示条一档，但没有底色，所以看不出来，也不加阴影）
  assert.doesNotMatch(rule, /(^|\s)(background|border)(-(?!radius)[a-z]+)?:/);
  assert.doesNotMatch(rule, /box-shadow/);
});

test("Toast 单格例行一行：约 4 秒（比批量的 6 秒短），悬停不计时，到点末尾 120ms 淡出、减少动效时直接消失", () => {
  assert.equal(CELL_TOAST_DWELL_MS, 4000);
  assert.ok(CELL_TOAST_DWELL_MS < TOAST_DWELL_MS.success);
  const html = render(Toast, {
    tier: "routine",
    kind: "success",
    verb: "加到",
    names: ["excalidraw"],
    dwellMs: CELL_TOAST_DWELL_MS,
    holdOnHover: true,
    onDismiss: noop,
  });
  // 刚出现时不在淡出
  assert.match(html, /class="ss-toast ss-toast--routine" data-kind="success" role="status"/);
  const leaving = cssRule(uiCss, ".ss-toast.is-leaving");
  assert.match(leaving, /opacity:\s*0/);
  assert.match(leaving, /transition:\s*opacity var\(--motion-fast\) var\(--ease-mech\)/);
  const reduced = uiCss.slice(uiCss.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.ss-toast\.is-leaving \{\s*transition: none;/);
});

// ===== 错误横幅与行内待办条：大面积的提示用 surface 灰面板，不用黑 =====

test("ErrorBanner：surface 灰面板 + 墨色 !，不自动消失；默认描边键（canvas 底）与 ×", () => {
  const html = render(ErrorBanner, {
    message: "读不到网关列表",
    detail: "配置文件没有读权限",
    action: { label: "再试一次", onClick: noop },
    onClose: noop,
  });
  assert.match(html, /class="ss-banner" role="alert"/);
  assert.match(html, /class="ss-banner__mark" title="故障" role="img" aria-label="故障"/);
  assert.match(html, /class="ss-banner__detail">配置文件没有读权限</);
  assert.match(html, /class="ss-btn ss-btn--compact">再试一次</);
  assert.match(html, /aria-label="关闭"/);
  assert.doesNotMatch(html, /is-on-dark/);
  const rule = cssRule(uiCss, ".ss-banner");
  assert.match(rule, /background:\s*var\(--surface\)/);
  assert.match(rule, /color:\s*var\(--ink\)/);
  assert.match(rule, /border-radius:\s*var\(--radius-layer\)/);
  assert.doesNotMatch(rule, /(^|\s)border:|box-shadow/);
  assert.match(cssRule(uiCss, ".ss-banner__detail"), /color:\s*var\(--ink-mute\)/);
  // 页级「路由没在跑」不可关
  assert.doesNotMatch(render(ErrorBanner, { message: "路由没在跑" }), /关闭/);
});

test("NoticePanel：surface 灰面板，! + 一句 + 默认描边键 + 可选文字链；忙碌指示用墨色", () => {
  const html = render(NoticePanel, {
    message: "改动要重启 Codex 才生效",
    action: { label: "重启", onClick: noop },
    link: { label: "稍后", onClick: noop },
  });
  assert.match(html, /class="ss-noticepanel"/);
  assert.match(html, /aria-label="要你动手"/);
  assert.match(html, /class="ss-btn ss-btn--compact">重启</);
  assert.match(html, /class="ss-btn ss-btn--link">稍后</);
  assert.doesNotMatch(html, /is-on-dark/);
  const rule = cssRule(uiCss, ".ss-noticepanel");
  assert.match(rule, /background:\s*var\(--surface\)/);
  assert.match(rule, /color:\s*var\(--ink\)/);
  assert.match(rule, /border-radius:\s*var\(--radius-layer\)/);
  assert.doesNotMatch(rule, /(^|\s)border:|box-shadow/);
  // 灰面上的键是 canvas 底；忙碌指示不再被改成 canvas（沿用 Spinner 自己的墨色）
  assert.match(
    cssRule(uiCss, ".ss-noticepanel .ss-btn:not(.ss-btn--link)"),
    /background:\s*var\(--canvas\)/,
  );
  assert.doesNotMatch(uiCss, /ss-noticepanel[^{]*\.ss-spinner/);
  assert.match(render(NoticePanel, { message: "x", busy: "正在接管" }), /正在接管/);
});

// ===== 确认弹窗 =====

test("Confirm：白板 460 + 1px 墨线描边，canvas 80% 遮罩；主动作反色、取消是文字链", () => {
  const html = render(Confirm, {
    title: "重启 Codex？",
    children: "会结束 Codex 正在运行的进程，进行中的对话会中断",
    confirmLabel: "重启",
    onConfirm: noop,
    onCancel: noop,
  });
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /class="ss-confirm__title">重启 Codex？</);
  assert.match(html, /class="ss-btn ss-btn--link">取消</);
  assert.match(html, /class="ss-btn ss-btn--primary">重启</);
  assert.match(html, /class="ss-confirm-veil ss-confirm-veil--full"/);
  const board = cssRule(uiCss, ".ss-confirm");
  // 12 圆角 + 浮层阴影 layer，不用黑框（原「1px 墨线、无阴影」已退役）
  assert.doesNotMatch(board, /(^|\s)border:/);
  assert.match(board, /border-radius:\s*var\(--radius-dialog\)/);
  assert.match(board, /box-shadow:\s*var\(--elev-layer\)/);
  assert.match(board, /width:\s*460px/);
  assert.match(board, /padding:\s*24px 28px/);
  const veil = cssRule(uiCss, ".ss-confirm-veil");
  // 遮罩黑 18%（原 canvas 80% 已退役）
  assert.match(veil, /background:\s*var\(--ink\)/);
  assert.match(veil, /opacity:\s*var\(--veil-opacity\)/);
});

test("Confirm 锚在触发行下方 6px，遮罩整面压暗、不挖触发行", () => {
  const html = render(Confirm, {
    title: "把 notion 写进 Codex · User？",
    confirmLabel: "写进去",
    safetyNote: "会把请求头和令牌一并复制过去",
    onCancel: noop,
    anchor: { top: 200, left: 40, right: 640, bottom: 234 },
  });
  assert.match(html, /class="ss-confirm-layer is-anchored"/);
  // 一整块遮罩，不挖触发行
  assert.equal(html.match(/class="ss-confirm-veil ss-confirm-veil--full"/g)?.length, 1);
  assert.doesNotMatch(html, /ss-confirm-hole/);
  assert.match(html, /style="position:absolute;top:240px;/);
  assert.match(html, /class="ss-confirm__safety">会把请求头和令牌一并复制过去</);
});

test("Confirm 铭牌：黑底等宽白字；主动作禁用时带原因", () => {
  const html = render(Confirm, {
    title: "删掉 docx 的原件？",
    nameplate: {
      path: "~/Library/Application Support/WeiboAP/skills/docx",
      meta: "3 个文件 · 24 KB · 不在 git 里",
    },
    confirmLabel: "删到废纸篓",
    confirmDisabledReason: "原件在 git 仓库里，请在仓库里删掉并提交",
    onCancel: noop,
  });
  assert.match(
    html,
    /class="ss-confirm__path">~\/Library\/Application Support\/WeiboAP\/skills\/docx</,
  );
  assert.match(html, /class="ss-confirm__meta">3 个文件/);
  assert.match(html, /disabled=""/);
  assert.match(html, /title="原件在 git 仓库里，请在仓库里删掉并提交"/);
  const plate = cssRule(uiCss, ".ss-confirm__nameplate");
  assert.match(plate, /background:\s*var\(--ink\)/);
  assert.match(plate, /padding:\s*10px 12px/);
  assert.match(plate, /font-family:\s*var\(--font-mono\)/);
});

// ===== 二级页面 =====

test("SubPage：← 图标按钮 + 页面名 28/700 不大写字距 0，头 84 = 28 + 56", () => {
  const html = render(SubPage, { title: "添加 skill 到「全局」", onBack: noop, children: "内容" });
  assert.match(html, /class="ss-subpage"/);
  assert.match(html, /class="ss-iconbtn" title="返回" aria-label="返回"/);
  // 页标题可被程序聚焦（打开时焦点移过去），但不进 Tab 序列
  assert.match(html, /class="ss-subpage__title" tabindex="-1">添加 skill 到「全局」</);
  assert.match(html, /class="ss-subpage__body">内容</);
  const title = cssRule(uiCss, ".ss-subpage__title");
  assert.match(title, /font-size:\s*var\(--size-display\)/);
  assert.match(title, /letter-spacing:\s*0/);
  assert.doesNotMatch(title, /text-transform/);
  assert.match(
    cssRule(uiCss, ".ss-subpage__bar"),
    /height:\s*calc\(var\(--titlestrip\) \+ var\(--topbar\)\)/,
  );
});

// ===== Cap =====

test("Cap：只给拉丁 run 套 Condensed 大写 + 字距，汉字原样", () => {
  assert.deepEqual(capRuns("模型"), [["模型", false]]);
  assert.deepEqual(capRuns("SKILLS"), [["SKILLS", true]]);
  assert.deepEqual(capRuns("位置 Codex"), [
    ["位置", false],
    [" Codex", true],
  ]);
  const html = render(Cap, { children: "Claude Code 用户" });
  assert.match(html, /<span class="ss-cap">Claude Code <\/span>用户/);
  const rule = cssRule(uiCss, ".ss-cap");
  assert.match(rule, /text-transform:\s*uppercase/);
  assert.match(rule, /font-family:\s*var\(--font-cond\)/);
});

// ===== agent 图标 =====

test("AgentMark：四个画得出的用真图标，单色 currentColor", () => {
  for (const id of ["claude-code", "codex", "cursor", "gemini-cli"]) {
    assert.equal(hasAgentIcon(id), true, id);
    const html = render(AgentMark, { id, name: id });
    assert.match(html, /<svg/, id);
    assert.match(html, /currentColor/, id);
    assert.doesNotMatch(html, /ss-mark__box/, id);
  }
});

test("AgentIcon：Codex 是 OpenAI 绳结（单色填充）；Claude 星形描边 1.2、小 1px", () => {
  const codex = render(AgentIcon, { id: "codex", name: "Codex" });
  assert.match(codex, /viewBox="0 0 24 24" fill="currentColor"/);
  assert.match(codex, /d="M22\.2819 9\.8211/);
  const star = render(AgentIcon, { id: "claude-code", name: "Claude Code" });
  assert.match(star, /width="15" height="15"/);
  assert.match(star, /stroke-width="1\.2"/);
});

test("AgentIcon labelled：旁边没有名字时自己带 title 与读屏名", () => {
  const html = render(AgentIcon, { id: "codex", name: "Codex", labelled: true });
  assert.match(html, /role="img" aria-label="Codex"/);
  assert.match(html, /<title>Codex<\/title>/);
  assert.match(
    render(AgentIcon, { id: "cline", name: "Cline", labelled: true }),
    /title="Cline" role="img" aria-label="Cline"/,
  );
});

test("AgentMark：没图标的降级成首字母方块，且永远和名字一起出现", () => {
  const html = render(AgentMark, { id: "windsurf", name: "Windsurf" });
  assert.equal(hasAgentIcon("windsurf"), false);
  assert.match(html, /class="ss-mark__box"[^>]*>W</);
  assert.match(html, /class="ss-mark__name">Windsurf</);
  assert.equal(agentInitial("amp"), "A");
});

test("AgentMark inline：agent 名不大写，原样渲染", () => {
  const html = render(AgentMark, { id: "claude-code", name: "Claude Code" });
  assert.match(html, /class="ss-mark ss-mark--inline"/);
  assert.match(html, /class="ss-mark__name">Claude Code</);
});

test("AgentMark header：列头三层——图标 / Condensed 大写名 / 等宽计数，没有灯", () => {
  const html = render(AgentMark, { id: "codex", name: "Codex", layout: "header", count: 41 });
  assert.match(html, /class="ss-mark ss-mark--header"/);
  assert.match(html, /<span class="ss-cap">Codex<\/span>/);
  assert.match(html, /class="ss-mark__count">41</);
  assert.doesNotMatch(html, /ss-lamp/);
});

test("AgentMark 禁用取色：形状不变，整体退到弱文字色", () => {
  assert.match(
    render(AgentMark, { id: "cursor", name: "Cursor", dim: true }),
    /class="ss-mark ss-mark--inline is-dim"/,
  );
});

test("AgentKey：高 32，图标 14 + 大写名同一行；未选 / 点亮反色 / 禁用带原因", () => {
  const off = render(AgentKey, {
    id: "claude-code",
    name: "Claude Code",
    pressed: false,
    onToggle: noop,
  });
  assert.match(off, /class="ss-agentkey" aria-pressed="false" aria-label="Claude Code"/);
  assert.match(off, /width="13" height="13"/);
  assert.match(
    render(AgentKey, { id: "codex", name: "Codex", pressed: true, onToggle: noop }),
    /class="ss-agentkey is-pressed"/,
  );
  const src = render(AgentKey, {
    id: "codex",
    name: "Codex",
    pressed: false,
    disabledReason: "这就是来源",
  });
  assert.match(src, /disabled=""/);
  assert.match(src, /title="这就是来源"/);
  assert.match(cssRule(uiCss, ".ss-agentkey"), /height:\s*var\(--control-h-row\)/);
  assert.match(cssRule(uiCss, ".ss-agentkey.is-pressed"), /background:\s*var\(--ink\)/);
});

// ===== 空态与忙碌态 =====

test("Empty 首次扫描：24px 忙碌指示 + 一句忙什么（自创转盘已删）", () => {
  const html = render(Empty, { kind: "scanning" });
  assert.match(html, /class="ss-empty ss-empty--scanning"/);
  assert.match(html, /class="ss-spinner" width="24" height="24"/);
  assert.match(html, /正在读 skill 目录</);
  assert.doesNotMatch(html, /ss-empty__actions/);
});

test("Empty 这个域没有 agent 目录：说「添加」不说「导入」+ 一个按钮", () => {
  const html = render(Empty, {
    kind: "noAgentDirs",
    primary: { label: "添加 skill", onClick: noop },
  });
  assert.match(html, /data-kind="noAgentDirs"/);
  assert.match(html, /添加时会顺手建出来/);
  assert.doesNotMatch(html, /导入/);
  assert.match(html, /class="ss-btn">添加 skill</);
});

test("Empty 两个动作里只有一个是按钮，另一个降文字链", () => {
  const html = render(Empty, {
    kind: "noSkills",
    description: "通用仓库（~/repos/common-skills）里还没有 skill。",
    hint: "把 skill 目录放进去，或者从别的地方添加一个。",
    primary: { label: "添加 skill", onClick: noop },
    secondary: { label: "打开目录", onClick: noop },
  });
  assert.match(html, /class="ss-empty__hint"/);
  assert.equal(html.match(/class="ss-btn"/g)?.length, 1);
  assert.match(html, /class="ss-btn ss-btn--link">打开目录</);
});

test("Empty 空态图像：图在上、装饰（alt 空 + aria-hidden）；首次扫描有图时忙碌指示跟在句子前", () => {
  const folders = render(Empty, {
    kind: "noAgentDirs",
    art: "folders",
    primary: { label: "添加 skill", onClick: noop },
  });
  assert.match(folders, /class="ss-empty ss-empty--noAgentDirs has-art"/);
  assert.match(
    folders,
    /<img class="ss-empty__art ss-empty__art--folders" src="type-folders\.svg" alt="" aria-hidden="true"\/>/,
  );
  // 顺序：图 → 一句现状 → 动作
  assert.ok(folders.indexOf("ss-empty__art") < folders.indexOf("ss-empty__description"));
  assert.ok(folders.indexOf("ss-empty__description") < folders.indexOf("ss-empty__actions"));

  const scanning = render(Empty, {
    kind: "scanning",
    art: "horizon",
    description: "正在读 3 个位置",
  });
  assert.match(scanning, /src="horizon\.jpg"/);
  assert.match(scanning, /class="ss-empty__busy"><svg class="ss-spinner" width="14"/);

  // 不给 art 就不放图（筛选无结果）
  assert.doesNotMatch(render(Empty, { kind: "noMatch" }), /<img/);
  assert.match(cssRule(uiCss, ".ss-empty__art--horizon"), /object-fit:\s*cover/);
});

test("Busy 操作进行中：受影响的部分置灰，不忙时不加类", () => {
  assert.match(render(Busy, { busy: true, children: "表格" }), /class="ss-busy" aria-busy="true"/);
  const idle = render(Busy, { busy: false, children: "表格" });
  assert.doesNotMatch(idle, /ss-busy/);
  assert.doesNotMatch(idle, /aria-busy/);
});

test("刚变化的格子闪一下：120ms 反色再回落，减少动效时退化为无", () => {
  assert.match(
    cssRule(uiCss, ".ss-flash"),
    /animation:\s*ss-flash var\(--motion-fast\) var\(--ease-mech\)/,
  );
});

// ===== 内容区的滚动容器（DESIGN「Layout」）=====
//
// 样式断言：吸顶的选择操作条落点全由 App.css 的 .content 决定，组件层看不见。
// 在 WebKit 里量过：sticky 的落点按滚动容器的**内容盒**算，.content 上下内边距是多少，
// 吸顶的条就离边多少，滚过去的内容从缝里漏出来。
// （UI v4 删掉了贴底待处理窗，原来钉 .skills-tab / .pending-bar 贴底的两条断言随之退役）

const appCss = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

/// 取一条规则的声明块；找不到就让断言失败，别静默放过
function ruleOf(selector: string): string {
  const match = appCss.match(
    new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`),
  );
  assert.ok(match, `App.css 里找不到规则 ${selector}`);
  return match[1];
}

test("内容区：滚动容器上下不留内边距，否则吸顶条的落点被顶开，内容从缝里漏出来", () => {
  const content = ruleOf(".content");
  assert.match(content, /overflow:\s*auto/);
  const padding = content.match(/\bpadding:\s*([^;]+);/);
  assert.ok(padding, ".content 要显式写 padding");
  const sides = padding[1].trim().split(/\s+(?![^(]*\))/);
  assert.equal(sides.length, 3, ".content 的 padding 写成「上 左右 下」三段，好看出上下是 0");
  assert.equal(sides[0], "0", ".content 的上内边距必须是 0");
  assert.equal(sides[2], "0", ".content 的下内边距必须是 0");
  // 贴底待处理窗已取消，它的样式不该回来
  assert.doesNotMatch(appCss, /\.pending-bar\b/);
});

test("Plain：旧大写档里嵌专名的出口，关掉整段的 text-transform（v4 起只剩兼容用途）", async () => {
  const { Plain } = await import("../src/ui/Plain.tsx");
  assert.match(render(Plain, { children: "Codex" }), /class="ss-plain"/);
  assert.match(uiCss, /\.ss-plain\s*\{[^}]*text-transform:\s*none/);
});

// ===== 二级页盖住主视图（真窗口走查：添加 skill 页上叠着主视图的吸顶工具行与列头） =====

test("二级页的层级高过主视图里所有吸顶元素（Matrix.css 最高的 z-index），确认框与提示框仍在它上面", () => {
  const matrixCss = readFileSync(new URL("../src/Matrix.css", import.meta.url), "utf8");
  const zs = [...matrixCss.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
  const sub = Number(/z-index:\s*(\d+)/.exec(cssRule(uiCss, ".ss-subpage"))?.[1]);
  assert.ok(
    sub > Math.max(...zs),
    `.ss-subpage 的 z-index ${sub} 要高过 Matrix 的 ${Math.max(...zs)}`,
  );
  const confirm = Number(/z-index:\s*(\d+)/.exec(cssRule(uiCss, ".ss-confirm-layer"))?.[1]);
  assert.ok(confirm > sub, "确认框要在二级页上面");
});

test("holdInert：打开二级页时主视图根节点加 inert，多个同时持有时最后一个释放才摘掉", () => {
  const attrs = new Map<string, string>();
  const root = {
    setAttribute: (n: string, v: string) => void attrs.set(n, v),
    removeAttribute: (n: string) => void attrs.delete(n),
  };
  const a = holdInert(root);
  assert.equal(attrs.get("inert"), "");
  const b = holdInert(root);
  a();
  assert.equal(attrs.has("inert"), true, "还有一个二级页开着");
  a();
  assert.equal(attrs.has("inert"), true, "同一个释放函数调两次只算一次");
  b();
  assert.equal(attrs.has("inert"), false);
});

test("返回时找回触发它的那颗键：主视图重挂过也按读屏名、再按文字认回", () => {
  const btn = (label: string | null, text: string) => ({
    getAttribute: (n: string) => (n === "aria-label" ? label : null),
    textContent: text,
  });
  const gear = btn("设置", "");
  const key = triggerKey(gear);
  const fresh = [btn("关闭", ""), btn("设置", ""), btn(null, "+ skill")];
  assert.equal(pickTrigger(fresh, key), 1);
  assert.equal(pickTrigger(fresh, triggerKey(btn(null, " + skill "))), 2);
  assert.equal(pickTrigger(fresh, triggerKey(btn(null, "配置网关"))), -1);
});

test("Confirm align=end：触发控件在行尾时对话框右沿对齐触发行（删网关的垃圾桶），默认仍左沿对齐", async () => {
  const { Confirm } = await import("../src/ui/Confirm.tsx");
  const anchor = { top: 100, bottom: 130, left: 32, right: 776 };
  const end = render(Confirm, {
    title: "删掉 x？",
    confirmLabel: "删掉",
    onCancel: noop,
    anchor,
    align: "end",
  });
  assert.match(end, /left:max\(16px, min\(316px, calc\(100vw - 476px\)\)\)/);
  const start = render(Confirm, {
    title: "删掉 x？",
    confirmLabel: "删掉",
    onCancel: noop,
    anchor,
  });
  assert.match(start, /left:min\(32px, calc\(100vw - 476px\)\)/);
});

test("提示框：6 圆角 + 浮层阴影 tip；平铺在页面流里的横幅不浮起、无阴影", () => {
  const tip = cssRule(uiCss, ".ss-tip");
  assert.match(tip, /border-radius:\s*var\(--radius-control\)/);
  assert.match(tip, /box-shadow:\s*var\(--elev-tip\)/);
  const banner = cssRule(uiCss, ".ss-banner");
  assert.doesNotMatch(banner, /box-shadow/);
});

test("阴影只有两个 token：src 里凡是 box-shadow 都是 var(--elev-layer) / var(--elev-tip) / none", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (dir: URL): URL[] =>
    readdirSync(dir).flatMap((name) => {
      const u = new URL(name, dir.href.endsWith("/") ? dir : new URL(dir.href + "/"));
      return statSync(u).isDirectory() ? walk(new URL(u.href + "/")) : [u];
    });
  const css = walk(new URL("../src/", import.meta.url)).filter((u) => u.pathname.endsWith(".css"));
  for (const u of css) {
    const src = readFileSync(u, "utf8");
    for (const m of src.matchAll(/box-shadow:\s*([^;]+);/g)) {
      assert.ok(
        ["none", "var(--elev-layer)", "var(--elev-tip)"].includes(m[1].trim()),
        `${u.pathname}: box-shadow: ${m[1]}`,
      );
    }
  }
});
