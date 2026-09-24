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
const { Switch, Checkbox, Indicator } = await import("../src/ui/Switch.tsx");
const { Tabs } = await import("../src/ui/Tabs.tsx");
const { Cap } = await import("../src/ui/Cap.tsx");
const { Chip, ModelChip } = await import("../src/ui/Chip.tsx");
const { Tag } = await import("../src/ui/Tag.tsx");
const { Tooltip, TruncTip, isClipped, TIP_DELAY_MS, PINNED_TIP_MS, TIP_IDLE, nextTip } =
  await import("../src/ui/Tooltip.tsx");
const { Spinner, BusySlot, BUSY_DELAY_MS } = await import("../src/ui/Spinner.tsx");
const { Toast, TOAST_DWELL_MS, CELL_TOAST_DWELL_MS } = await import("../src/ui/Toast.tsx");
const { ErrorBanner, NoticePanel } = await import("../src/ui/ErrorBanner.tsx");
const { Confirm } = await import("../src/ui/Confirm.tsx");
const { SubPage, holdInert, pickTrigger, triggerKey } = await import("../src/ui/SubPage.tsx");
const { AgentIcon, AgentMark, agentInitial, hasAgentIcon } =
  await import("../src/ui/AgentMark.tsx");
const { Empty } = await import("../src/ui/Empty.tsx");
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
    "Tabs",
    "Indicator",
    "CheckboxGlyph",
    "AgentMark",
    "AgentIcon",
    "Empty",
    "Cap",
  ];
  for (const name of exported) {
    assert.equal(typeof (ui as Record<string, unknown>)[name], "function", name);
  }
  // 已删：方标签（有框的都能点）与左下贴底待处理窗（定稿增量取消）
  assert.equal((ui as Record<string, unknown>).TagSquare, undefined);
  assert.equal((ui as Record<string, unknown>).PendingWindow, undefined);
  // 已删：整块变暗的 Busy（单一对象的操作不许整片变暗，忙碌只落在按下的那颗键上，见 BusySlot）
  assert.equal((ui as Record<string, unknown>).Busy, undefined);
  // Cap 已恢复（2026-09-24 字体回到原设计）；它的出口 Plain 不恢复（大写只经 Cap 这一条路）
  assert.equal((ui as Record<string, unknown>).Plain, undefined);
});

// ===== 设计变量 =====

test("tokens：V4 的 14 个色、六档字号、V4 圆角、层次 token、28/24/32 控件高、行高 34、机械缓动", () => {
  for (const [name, value] of [
    ["shell", "#f4f4f2"],
    ["face", "#fcfcfb"],
    ["paper", "#ffffff"],
    ["recess", "#f2f2ef"],
    ["surface", "#efefec"],
    ["hairline", "#e3e3df"],
    ["row-line", "#ededea"],
    ["ctl-border", "#d4d4cf"],
    ["ctl-edge", "#bdbdb7"],
    ["track", "#dcdcd7"],
    ["ink", "#1c1c1a"],
    ["ink-mute", "#4e4e4a"],
    ["ink-faint", "#6f6f6a"],
    ["accent", "#e0652a"],
  ]) {
    assert.match(tokensCss, new RegExp(`--${name}:\\s*${value};`), name);
  }
  // 已删的：画布白、禁用灰、大字的正字距与负字距、V4 一度换上的字族、旧圆角与旧阴影
  for (const gone of [
    /--canvas\b/,
    /--disabled\b/,
    /--track-(display|title)\b/,
    /--tracking-/,
    /\bInter\b/,
    /@fontsource\/inter/,
    /--radius-(layer|dialog)\b/,
    /--elev-(layer|tip)\b/,
    /--size-(wordmark|micro|nav)\b/,
    /--leading-micro\b/,
    // 2026-09-24 物性：墨键底边色、1px 底边式行程与按下内凹，由抬起投影取代
    /--ink-edge\b/,
    /#000000/,
    /--key-edge/,
    /--recess-pressed\b/,
  ]) {
    assert.doesNotMatch(tokensCss, gone, String(gone));
  }
  // 六档字号，没有 14px；行高没有 2.0
  for (const [name, value] of [
    ["display", "28px"],
    ["title", "20px"],
    ["head", "16px"],
    ["body", "15px"],
    ["caption", "13px"],
    ["label", "12px"],
  ]) {
    assert.match(tokensCss, new RegExp(`--size-${name}:\\s*${value};`), name);
  }
  assert.doesNotMatch(tokensCss, /\b14px/);
  assert.doesNotMatch(tokensCss, /--leading-[a-z]+:\s*2;/);
  // 字族：Barlow + Barlow Condensed + 苹方，等宽只给 id（2026-09-24 回到原设计）
  assert.match(tokensCss, /--font-ui: Barlow, "PingFang SC", "Microsoft YaHei", sans-serif;/);
  assert.match(
    tokensCss,
    /--font-cond: "Barlow Condensed", "PingFang SC", "Microsoft YaHei", sans-serif;/,
  );
  assert.match(tokensCss, /--font-mono: "IBM Plex Mono", ui-monospace, "PingFang SC", monospace;/);
  // 字体包只收 latin 子集与用到的字重：Barlow 400/500/600、Condensed 600/700、Plex Mono 400/500
  const imports = [
    ...tokensCss.matchAll(/@import "@fontsource\/([a-z-]+)\/latin-(\d+)\.css";/g),
  ].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(imports, [
    "barlow 400",
    "barlow 500",
    "barlow 600",
    "barlow-condensed 600",
    "barlow-condensed 700",
    "ibm-plex-mono 400",
    "ibm-plex-mono 500",
  ]);
  // 正字距只留三个，只给经 Cap 的拉丁 run
  for (const [name, value] of [
    ["nav", "1.17px"],
    ["label", "0.96px"],
    ["head", "1.1px"],
  ]) {
    assert.match(tokensCss, new RegExp(`--track-${name}:\\s*${value};`), name);
  }
  assert.deepEqual(
    [...tokensCss.matchAll(/--track-([a-z]+):/g)].map((m) => m[1]),
    ["nav", "label", "head"],
  );
  // 圆角：刻条 2 / 记号 4 / 滑块 4 / 槽 5 / 控件 7 / 页签槽 10 / 面 12 / 浮层 12 / 胶囊 999
  for (const [name, value] of [
    ["scribe", "2px"],
    ["mark", "4px"],
    ["knob", "4px"],
    ["track", "5px"],
    ["control", "7px"],
    ["tab-track", "10px"],
    ["face", "12px"],
    ["float", "12px"],
    ["pill", "999px"],
  ]) {
    assert.match(tokensCss, new RegExp(`--radius-${name}:\\s*${value};`), name);
  }
  // 层次：投影只说离机面多高，四档九个值，逐字（凹 / 抬起 / 浮；平无投影）；遮罩 ink 16%
  for (const [name, value] of [
    ["recess-input", "inset 0 1px 0 rgba(28,28,26,.06)"],
    ["recess-tabs", "inset 0 1px 2px rgba(28,28,26,.06), inset 0 0 0 1px rgba(28,28,26,.04)"],
    ["recess-track", "inset 0 1px 2px rgba(28,28,26,.06), inset 0 0 0 1px rgba(28,28,26,.04)"],
    [
      "raise",
      "0 0 0 1px rgba(28,28,26,.07), 0 1px 2px rgba(28,28,26,.10), 0 2px 6px rgba(28,28,26,.05)",
    ],
    [
      "raise-hover",
      "0 0 0 1px rgba(28,28,26,.09), 0 1px 2px rgba(28,28,26,.12), 0 3px 8px rgba(28,28,26,.07)",
    ],
    ["raise-pressed", "0 0 0 1px rgba(28,28,26,.09), 0 0.5px 1px rgba(28,28,26,.10)"],
    ["raise-ink", "0 1px 2px rgba(28,28,26,.28), 0 2px 6px rgba(28,28,26,.14)"],
    ["raise-ink-pressed", "0 0.5px 1px rgba(28,28,26,.30)"],
    ["elev-float", "0 12px 32px rgba(28,28,26,.12)"],
  ]) {
    const esc = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(tokensCss, new RegExp(`--${name}: ${esc};`), name);
  }
  assert.match(tokensCss, /--veil-opacity:\s*0\.16;/);
  // 禁用边：实线 hairline（D20）
  assert.match(tokensCss, /--border-disabled: 1px solid var\(--hairline\);/);
  assert.match(tokensCss, /--control-h:\s*28px;/);
  assert.match(tokensCss, /--control-h-compact:\s*24px;/);
  assert.match(tokensCss, /--control-h-row:\s*32px;/);
  assert.match(tokensCss, /--row-h:\s*34px;/);
  assert.match(tokensCss, /--motion-fast:\s*120ms;/);
  assert.match(tokensCss, /--ease-mech:\s*cubic-bezier\(0\.2, 0\.8, 0\.2, 1\);/);
  // 重量与惯性：按下 70ms、松开 180ms、页签滑块 260ms、开关滑块 200ms；阻尼比 0.8 的弹簧（front-matter
  // motion.spring-slide 原样）；按压变形下沉 0.5px 并微缩
  assert.match(tokensCss, /--dur-press:\s*70ms;/);
  assert.match(tokensCss, /--dur-release:\s*180ms;/);
  assert.match(tokensCss, /--dur-slide-tab:\s*260ms;/);
  assert.match(tokensCss, /--dur-slide-knob:\s*200ms;/);
  assert.match(
    tokensCss,
    /--spring-slide: linear\(0, 0\.018 2\.5%, 0\.065 5%, 0\.131 7\.5%, 0\.209 10%, 0\.293 12\.5%, 0\.378 15%, 0\.461 17\.5%, 0\.54 20%, 0\.613 22\.5%, 0\.679 25%, 0\.749 28%, 0\.809 31%, 0\.859 34%, 0\.899 37%, 0\.941 41%, 0\.97 45%, 0\.994 50%, 1\.008 55%, 1\.014 61%, 1\.015 68%, 1\.012 76%, 1\.007 86%, 1\);/,
  );
  assert.match(tokensCss, /--press-transform: translateY\(0\.5px\) scale\(0\.985\);/);
  // 弹簧停稳不弹：曲线单调爬到峰值、过冲 ≤ 3%，末端落回 1
  const stops = [...tokensCss.match(/--spring-slide: linear\(([^;]+)\);/)![1].split(",")].map((p) =>
    Number(p.trim().split(" ")[0]),
  );
  assert.equal(stops[0], 0);
  assert.equal(stops.at(-1), 1);
  assert.ok(Math.max(...stops) <= 1.03, "过冲超过 3%");
  // 减少动效：按下、松开、滑块位移全部即时，没有按压变形
  const reducedTokens = tokensCss.slice(
    tokensCss.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  for (const name of ["dur-press", "dur-release", "dur-slide-tab", "dur-slide-knob"]) {
    assert.match(reducedTokens, new RegExp(`--${name}: 0ms;`), name);
  }
  assert.match(reducedTokens, /--press-transform: none;/);
  assert.match(tokensCss, /--motion-spinner:\s*1s;/);
  assert.match(tokensCss, /--motion-dots:\s*500ms;/);
  // 自创转盘已删，它的时长 token 不该回来
  assert.doesNotMatch(tokensCss, /--motion-rotor/);
  // 窗体是机壳；界面文字不可拖选（D23）
  assert.match(tokensCss, /background: var\(--shell\);/);
  assert.match(tokensCss, /user-select: none;/);
  assert.match(uiCss, /\.ss-selectable,\s*input,\s*textarea,[^{]*\{\s*user-select: text;/);
});

test("光标：控件一律箭头，手形只给离开应用的链接（D23）", () => {
  const css = uiCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const pointers = [...css.matchAll(/([^{}]+)\{[^}]*cursor:\s*pointer/g)].map((m) => m[1].trim());
  assert.deepEqual(pointers, [".ss-btn--external"]);
});

test("动效：颜色与影子走 120ms 机械缓动，按下 70ms，位移与回位走弹簧；不退化成默认 transition；减少动效时关掉", async () => {
  // 每一段 transition 都必须是这几种之一（默认 ease 是 300ms 淡入淡出的那种手感）：
  // 颜色、底色、透明度、影子 120ms --ease-mech；按下 70ms --ease-mech；
  // 会移动的实物（滑块位移、松开回位）--spring-slide 配 260 / 200 / 180ms
  const allowed =
    /var\(--(motion-fast|dur-press)\) var\(--ease-mech\)|var\(--(dur-slide-tab|dur-slide-knob|dur-release)\) var\(--spring-slide\)/;
  for (const m of uiCss.matchAll(/transition:([^;]+);/g)) {
    const decl = m[1].trim();
    if (decl === "none") continue;
    for (const part of decl.split(/,(?![^(]*\))/)) {
      assert.match(part, allowed, `transition 没用规定的缓动：${part}`);
      // 颜色、透明度不用弹簧
      if (/^\s*(color|background-color|opacity|border-color)\b/.test(part)) {
        assert.doesNotMatch(part, /spring-slide/, part);
      }
    }
  }
  // 缓动曲线只在 tokens.css 里定义：组件样式引用 token，不写 cubic-bezier / linear()
  assert.doesNotMatch(uiCss, /cubic-bezier\(|[^-]linear\(/);
  assert.match(uiCss, /@media \(prefers-reduced-motion: reduce\)/);
  // 辐条转圈：1 圈 / 1s，8 步阶跃（关键帧 ss-spin，整颗 svg 绕中心转）；自创转盘的样式已删
  assert.match(
    cssRule(uiCss, ".ss-spinner"),
    /ss-spin var\(--motion-spinner\) steps\(8\) infinite/,
  );
  // 减少动效：不转（渐变静止），文字后的三点每 500ms 增减一点
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

test("StateDot 异常：失效＝4 段虚线环、放不进去＝斜杠环 ⊘（无法写入与同名占位同一个，D22）、整个文件夹是链接＝环内箭头", () => {
  assert.match(render(StateDot, { dot: "broken" }), /stroke-dasharray="5\.2 1\.5"/);
  assert.match(render(StateDot, { dot: "readOnly" }), /d="M2 8 L8 2"/);
  // ⊝ 删了：同名占位画 ⊘，读屏名说「受阻」（D22，与 Matrix 同一处）
  const blocked = render(StateDot, { dot: "blocked" });
  assert.match(blocked, /d="M2 8 L8 2"/);
  assert.doesNotMatch(blocked, /d="M3 5 H7"/);
  assert.match(blocked, /aria-label="受阻"/);
  assert.match(render(StateDot, { dot: "blocked", size: 16 }), /d="M3\.6 12\.4 L12\.4 3\.6"/);
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

test("StateDot 反色闪与禁用：inverse 转 face、muted 退到 ink-faint", () => {
  assert.match(
    render(StateDot, { dot: "linked", inverse: true }),
    /class="ss-dot ss-dot--linked is-inverse"/,
  );
  assert.match(
    render(StateDot, { dot: "own", muted: true }),
    /class="ss-dot ss-dot--own is-muted"/,
  );
  assert.match(cssRule(uiCss, ".ss-dot.is-inverse"), /color:\s*var\(--face\)/);
  assert.match(cssRule(uiCss, ".ss-dot.is-muted"), /color:\s*var\(--ink-faint\)/);
});

test("DupMark：名字后 ×2", () => {
  const row = render(DupMark, {});
  assert.match(row, /class="ss-dup ss-dup--row"/);
  assert.match(row, />×2</);
  assert.match(row, /aria-label="同名：有 2 份"/);
  assert.match(render(DupMark, { count: 3 }), />×3</);
  // 计数：12 tabular，不换等宽字族
  const rule = cssRule(uiCss, ".ss-dup");
  assert.match(rule, /font-family:\s*var\(--font-ui\)/);
  assert.match(rule, /font-variant-numeric:\s*tabular-nums/);
});

// ===== 按钮 =====

test("Button 默认键：paper 面 + raise 抬起（不画描边），原样大小写、字距 0、Barlow 13/600；四态", () => {
  const html = render(Button, { children: "配置网关", onClick: noop });
  assert.match(html, /class="ss-btn"/);
  const rule = cssRule(uiCss, ".ss-btn");
  // 边由投影的 1px 环给，不另画 ctl-border 描边
  assert.match(rule, /border:\s*0/);
  assert.match(rule, /background:\s*var\(--paper\)/);
  assert.match(rule, /box-shadow:\s*var\(--raise\)/);
  assert.match(rule, /border-radius:\s*var\(--radius-control\)/);
  assert.match(rule, /font-family:\s*var\(--font-ui\)/);
  assert.match(rule, /font-weight:\s*600/);
  assert.match(rule, /letter-spacing:\s*0/);
  assert.doesNotMatch(rule, /text-transform/);
  assert.match(rule, /height:\s*var\(--control-h\)/);
  // 松开：按压变形 180ms 弹簧回位；影子与底色 120ms 机械缓动
  assert.match(rule, /transform var\(--dur-release\) var\(--spring-slide\)/);
  assert.match(rule, /box-shadow var\(--motion-fast\) var\(--ease-mech\)/);
  assert.match(rule, /background-color var\(--motion-fast\) var\(--ease-mech\)/);
  // 悬停：手靠近，影子略重、不位移，底色不变
  const hover = cssRule(uiCss, ".ss-btn:hover:not(:disabled)");
  assert.match(hover, /box-shadow:\s*var\(--raise-hover\)/);
  assert.doesNotMatch(hover, /background|transform/);
  // 按下：贴近机面——键面 surface、影子收紧、下沉 0.5px 并微缩，70ms（不压扁高度）
  const pressed = cssRule(uiCss, ".ss-btn:active:not(:disabled)");
  assert.match(pressed, /background:\s*var\(--surface\)/);
  assert.match(pressed, /box-shadow:\s*var\(--raise-pressed\)/);
  assert.match(pressed, /transform:\s*var\(--press-transform\)/);
  assert.match(pressed, /transform var\(--dur-press\) var\(--ease-mech\)/);
  assert.doesNotMatch(pressed, /height/);
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

test("Button 墨键：ink 底 face 字 + raise-ink 抬起；hover 内沿 1px ink-mute、影子不变；按下影子收紧、底色不变", () => {
  const html = render(Button, { children: "保存", variant: "primary", onClick: noop });
  assert.match(html, /class="ss-btn ss-btn--primary"/);
  const rule = cssRule(uiCss, ".ss-btn--primary");
  assert.match(rule, /background:\s*var\(--ink\)/);
  assert.match(rule, /color:\s*var\(--face\)/);
  assert.match(rule, /box-shadow:\s*var\(--raise-ink\)/);
  const hover = cssRule(uiCss, ".ss-btn--primary:hover:not(:disabled)");
  assert.match(hover, /box-shadow:\s*var\(--raise-ink\)/);
  assert.match(hover, /outline:\s*1px solid var\(--ink-mute\)/);
  assert.match(hover, /outline-offset:\s*-2px/);
  const pressed = cssRule(uiCss, ".ss-btn--primary:active:not(:disabled)");
  assert.match(pressed, /box-shadow:\s*var\(--raise-ink-pressed\)/);
  assert.match(pressed, /background:\s*var\(--ink\)/);
});

test("Button 禁用：必须同时给原因，挂在 title 上；平贴、实线 hairline、ink-faint 字、无投影（D20）", () => {
  const html = render(Button, {
    children: "添加 0 个",
    variant: "primary",
    disabled: true,
    disabledReason: "先点亮一个 agent",
  });
  assert.match(html, /disabled=""/);
  assert.match(html, /title="先点亮一个 agent"/);
  const rule = cssRule(uiCss, ".ss-btn:disabled");
  // 线画在键的外沿（与抬起键的投影环同位）：启用 ↔ 禁用时键不变宽
  assert.match(rule, /outline:\s*var\(--border-disabled\)/);
  assert.match(rule, /outline-offset:\s*0/);
  assert.match(rule, /background:\s*transparent/);
  assert.match(rule, /box-shadow:\s*none/);
  assert.match(rule, /color:\s*var\(--ink-faint\)/);
  assert.doesNotMatch(uiCss, /dashed/);
  // 按不下的东西不离开机面：悬停与按下的规则都排除了禁用
  for (const m of uiCss.matchAll(/\n(\.ss-btn[^{\n]*:(?:hover|active)[^{\n]*)\{/g)) {
    assert.match(m[1], /:not\(:disabled\)/, m[1]);
  }
});

test("Button 安静键（D14）：无底无边、ink-mute 13；悬停 surface 圆角带、按下按压变形不抬起；命中区高 24、左右各 6", () => {
  const html = render(Button, { children: "撤销", variant: "quiet", onClick: noop });
  assert.match(html, /class="ss-btn ss-btn--quiet">撤销</);
  const rule = cssRule(uiCss, ".ss-btn--quiet");
  assert.match(rule, /height:\s*var\(--hit-min\)/);
  assert.match(rule, /margin:\s*0 -6px/);
  assert.match(rule, /padding:\s*0 6px/);
  assert.match(rule, /border:\s*0/);
  assert.match(rule, /background:\s*transparent/);
  assert.match(rule, /box-shadow:\s*none/);
  assert.match(rule, /color:\s*var\(--ink-mute\)/);
  // 静止时与纯文字无异：没有下划线
  assert.doesNotMatch(rule, /text-decoration/);
  const hover = cssRule(uiCss, ".ss-btn--quiet:hover:not(:disabled)");
  assert.match(hover, /background:\s*var\(--surface\)/);
  // 圆角带沿用键的 control 7（基础规则给的），安静键不另改圆角
  assert.doesNotMatch(rule, /border-radius/);
  // 按下：按压变形由基础规则给（--press-transform），安静键不抬起、按下也无投影
  assert.match(hover, /box-shadow:\s*none/);
  const quietPressed = cssRule(uiCss, ".ss-btn--quiet:active:not(:disabled)");
  assert.match(quietPressed, /box-shadow:\s*none/);
  assert.doesNotMatch(quietPressed, /transform/);
  // 不可用的安静键：只剩 ink-faint 字，没有悬停带
  const off = render(Button, {
    children: "撤销",
    variant: "quiet",
    disabled: true,
    disabledReason: "写入之后文件又被改过",
  });
  assert.match(off, /class="ss-btn ss-btn--quiet" title="写入之后文件又被改过"[^>]*disabled=""/);
  const disabled = cssRule(uiCss, ".ss-btn--quiet:disabled");
  assert.match(disabled, /color:\s*var\(--ink-faint\)/);
  assert.match(disabled, /background:\s*transparent/);
  // 文字链变体已删：应用内只剩安静键，下划线只给外链
  assert.doesNotMatch(uiCss, /ss-btn--link/);
});

test("Button 外链（button-link）：只给离开 Sophia 的链接——下划线 + 10px ↗、手形光标", () => {
  const ext = render(Button, { children: "打开目录", variant: "external", onClick: noop });
  assert.match(ext, /class="ss-btn ss-btn--external"/);
  assert.match(
    ext,
    /<span class="ss-btn__text">打开目录<\/span><svg class="ss-btn__external" width="10" height="10"/,
  );
  assert.match(cssRule(uiCss, ".ss-btn--external .ss-btn__text"), /text-decoration:\s*underline/);
  assert.match(uiCss, /\n\.ss-btn--external \{[^}]*cursor:\s*pointer/);
  // 全应用只有外链带下划线
  const underlines = [...uiCss.matchAll(/([^{}]+)\{[^}]*text-decoration:\s*underline/g)].map((m) =>
    m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim(),
  );
  assert.deepEqual(underlines, [".ss-btn--external .ss-btn__text"]);
});

test("Button 墨窗上：浅描边键——1px face 边与字、透明底、不抬起", () => {
  const html = render(Button, { children: "撤销", size: "compact", onDark: true, onClick: noop });
  assert.match(html, /class="ss-btn ss-btn--compact is-on-dark"/);
  const rule = cssRule(uiCss, ".ss-btn.is-on-dark");
  assert.match(rule, /border:\s*1px solid var\(--face\)/);
  assert.match(rule, /color:\s*var\(--face\)/);
  assert.match(rule, /box-shadow:\s*none/);
  assert.match(cssRule(uiCss, ".ss-btn.is-on-dark:hover:not(:disabled)"), /box-shadow:\s*none/);
  // 安静键、外链在墨面上仍然没有框
  assert.match(cssRule(uiCss, ".ss-btn--quiet.is-on-dark"), /border:\s*0/);
});

test("IconButton：28×28，title 必填且同时作 aria-label；不带计数", () => {
  const html = render(IconButton, { icon: IconCheck({}), title: "设置", onClick: noop });
  assert.match(html, /class="ss-iconbtn"/);
  assert.match(html, /title="设置"/);
  assert.match(html, /aria-label="设置"/);
  // 顶栏只剩设置；页签上、图标上都不挂计数（常驻的数字会一直催处理不了的事）
  assert.doesNotMatch(html, /ss-iconbtn__count/);
  assert.doesNotMatch(uiCss, /\.ss-iconbtn__count|\.ss-iconbtn\.has-count/);
  // 工具不是键：图形 ink-mute，悬停 surface 底 + 图形 ink，没有行程
  const rule = cssRule(uiCss, ".ss-iconbtn");
  assert.match(rule, /color:\s*var\(--ink-mute\)/);
  assert.match(rule, /border-radius:\s*var\(--radius-control\)/);
  assert.doesNotMatch(rule, /box-shadow/);
  const hover = cssRule(uiCss, ".ss-iconbtn:hover:not(:disabled)");
  assert.match(hover, /background:\s*var\(--surface\)/);
  assert.match(hover, /color:\s*var\(--ink\)/);
  assert.doesNotMatch(uiCss, /\.ss-iconbtn:active/);
});

test("AddButton：开始一个添加流程只有「+ 名词」这一种长相", () => {
  const html = render(AddButton, { noun: "skill", onClick: noop });
  assert.match(html, /class="ss-btn ss-btn--add"/);
  assert.match(html, /title="添加 skill"/);
  assert.match(html, /<path d="M6 1\.5v9M1\.5 6h9"><\/path><\/svg>skill</);
});

// ===== 开关与复选框 =====

test("Switch regular 40×20 / compact 32×16：role=switch，读屏名必填；指示点 + 槽 + 两条刻条 + 抬起的滑块（三道平的防滑纹）", () => {
  const regular = render(Switch, {
    checked: true,
    onChange: noop,
    label: "启用 Codex 的第三方模型",
  });
  assert.match(
    regular,
    /role="switch" aria-checked="true" aria-label="启用 Codex 的第三方模型" class="ss-switch ss-switch--regular is-on"/,
  );
  assert.match(regular, /<span class="ss-indicator is-on" aria-hidden="true"><\/span>/);
  assert.match(
    regular,
    /<span class="ss-switch__track" aria-hidden="true"><span class="ss-switch__scribe ss-switch__scribe--on"><\/span><span class="ss-switch__scribe ss-switch__scribe--off"><\/span><span class="ss-switch__knob"><\/span><\/span>/,
  );
  const compact = render(Switch, {
    checked: false,
    onChange: noop,
    size: "compact",
    label: "以后新出现的自动加到",
  });
  assert.match(compact, /aria-checked="false"/);
  assert.match(compact, /class="ss-switch ss-switch--compact"/);
  assert.match(compact, /class="ss-indicator ss-indicator--compact"/);
  const base = cssRule(uiCss, ".ss-switch");
  assert.match(base, /--groove-w:\s*40px/);
  assert.match(base, /--groove-h:\s*20px/);
  assert.match(base, /--knob-w:\s*19px/);
  assert.match(base, /--knob-h:\s*16px/);
  assert.match(base, /--scribe-w:\s*12px/);
  assert.match(base, /--scribe-h:\s*6px/);
  assert.match(base, /gap:\s*7px/);
  const small = cssRule(uiCss, ".ss-switch--compact");
  assert.match(small, /--groove-w:\s*32px/);
  assert.match(small, /--groove-h:\s*16px/);
  assert.match(small, /--knob-w:\s*15px/);
  assert.match(small, /--knob-h:\s*12px/);
  assert.match(small, /--scribe-w:\s*9px/);
  assert.match(small, /--scribe-h:\s*4px/);
  // 槽：track 底、5 圆角、内凹；滑块：paper、4 圆角、raise 抬起（边由投影的环给，不画描边）
  const track = cssRule(uiCss, ".ss-switch__track");
  assert.match(track, /background:\s*var\(--track\)/);
  assert.match(track, /border-radius:\s*var\(--radius-track\)/);
  assert.match(track, /box-shadow:\s*var\(--recess-track\)/);
  const knob = cssRule(uiCss, ".ss-switch__knob");
  assert.match(knob, /background:\s*var\(--paper\)/);
  assert.doesNotMatch(knob, /border:/);
  assert.match(knob, /border-radius:\s*var\(--radius-knob\)/);
  assert.match(knob, /box-shadow:\s*var\(--raise\)/);
  // 滑块面上不画纹（产品负责人：竖线去掉）——一块干净的白滑块，可拖靠抬起的投影与位置说明
  assert.doesNotMatch(uiCss, /ss-switch__grip|--grip-h/);
  // 刻条：开＝橙露在左，关＝灰露在右
  assert.match(cssRule(uiCss, ".ss-switch__scribe--on"), /background:\s*var\(--accent\)/);
  assert.match(cssRule(uiCss, ".ss-switch__scribe--off"), /background:\s*var\(--ctl-edge\)/);
  assert.match(cssRule(uiCss, ".ss-switch__scribe"), /border-radius:\s*var\(--radius-scribe\)/);
  // 旧的胶囊开关尺寸不该回来
  assert.doesNotMatch(uiCss, /ss-switch--(page|inline)/);
});

test("Indicator：6px 圆，开＝橙、关＝ctl-border，不可用空心；橙只出现在开关与指示点", () => {
  assert.equal(
    render(Indicator, { on: false }),
    '<span class="ss-indicator" aria-hidden="true"></span>',
  );
  assert.match(
    render(Indicator, { on: true, label: "第三方模型开着" }),
    /class="ss-indicator is-on" role="img" aria-label="第三方模型开着"/,
  );
  assert.match(
    render(Indicator, { on: false, disabled: true }),
    /class="ss-indicator is-disabled"/,
  );
  const rule = cssRule(uiCss, ".ss-indicator");
  assert.match(rule, /width:\s*6px/);
  assert.match(rule, /height:\s*6px/);
  assert.match(rule, /background:\s*var\(--ctl-border\)/);
  assert.match(cssRule(uiCss, ".ss-indicator.is-on"), /background:\s*var\(--accent\)/);
  assert.match(
    cssRule(uiCss, ".ss-indicator.is-disabled"),
    /border:\s*1px solid var\(--hairline\)/,
  );
  // 橙的规则只在开关与指示点的选择器里
  const css = uiCss.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*var\(--accent\)[^{}]*)\}/g)) {
    for (const sel of m[1].split(",")) assert.match(sel, /\.ss-switch|\.ss-indicator/, sel);
  }
});

test("Switch 重量：位置 translate 200ms 弹簧停靠；悬停影子略重；按住 / 拖动中贴近槽底；刻条判定后 120ms 换色", () => {
  const knob = cssRule(uiCss, ".ss-switch__knob");
  assert.match(knob, /translate var\(--dur-slide-knob\) var\(--spring-slide\)/);
  assert.match(knob, /transform var\(--dur-release\) var\(--spring-slide\)/);
  assert.match(knob, /box-shadow var\(--motion-fast\) var\(--ease-mech\)/);
  assert.match(cssRule(uiCss, ".ss-switch.is-on .ss-switch__knob"), /translate:\s*var\(--travel\)/);
  // 旧的 120ms 过冲关键帧已由弹簧取代
  assert.doesNotMatch(uiCss, /ss-knob-(on|off)|is-moved/);
  assert.match(
    cssRule(uiCss, ".ss-switch:hover:not(:disabled) .ss-switch__knob"),
    /box-shadow:\s*var\(--raise-hover\)/,
  );
  const pressed = cssRule(uiCss, ".ss-switch:active:not(:disabled) .ss-switch__knob");
  assert.match(pressed, /box-shadow:\s*var\(--raise-pressed\)/);
  assert.match(pressed, /transform:\s*var\(--press-transform\)/);
  assert.match(pressed, /transform var\(--dur-press\) var\(--ease-mech\)/);
  assert.match(
    uiCss,
    /\.ss-switch:active:not\(:disabled\) \.ss-switch__knob,\s*\.ss-switch\.is-dragging \.ss-switch__knob \{/,
  );
  // 拖动中滑块跟手，位移不走弹簧
  // 取最后一条：前一条是与 :active 分组的那条，后一条才是拖动单独的过渡
  const dragging = [
    ...uiCss.matchAll(/\n\.ss-switch\.is-dragging \.ss-switch__knob \{([^}]*)\}/g),
  ].at(-1)?.[1];
  assert.ok(dragging);
  assert.doesNotMatch(dragging, /translate/);
  // 刻条只露当前状态那一条，换色 120ms 机械缓动（颜色不用弹簧）
  const scribe = cssRule(uiCss, ".ss-switch__scribe");
  assert.match(scribe, /opacity:\s*0/);
  assert.match(scribe, /transition:\s*opacity var\(--motion-fast\) var\(--ease-mech\)/);
  assert.match(
    uiCss,
    /\.ss-switch\.is-on \.ss-switch__scribe--on,\s*\.ss-switch:not\(\.is-on\) \.ss-switch__scribe--off \{\s*opacity: 1;/,
  );
  // 槽上可拖：触控不让浏览器拿去滚动
  assert.match(cssRule(uiCss, ".ss-switch__track"), /touch-action:\s*none/);
  // 静态渲染：没在拖，不带 is-dragging、没有内联位移
  const html = render(Switch, { checked: true, onChange: noop, label: "x" });
  assert.doesNotMatch(html, /is-dragging|style=/);
});

test("Switch 禁用：带原因；平贴、无投影、不响应悬停按住与拖", () => {
  const html = render(Switch, {
    checked: false,
    onChange: noop,
    label: "x",
    disabledReason: "Codex 还没装",
  });
  assert.match(html, /disabled=""/);
  assert.match(html, /title="Codex 还没装"/);
  // 不可用：槽透明 + hairline 环；滑块 recess、无底边；指示点空心
  assert.match(html, /class="ss-indicator is-disabled"/);
  const track = cssRule(uiCss, ".ss-switch:disabled .ss-switch__track");
  assert.match(track, /background:\s*transparent/);
  assert.match(track, /outline:\s*1px solid var\(--hairline\)/);
  const knob = cssRule(uiCss, ".ss-switch:disabled .ss-switch__knob");
  assert.match(knob, /background:\s*var\(--recess\)/);
  assert.match(knob, /border:\s*var\(--border-disabled\)/);
  // 平贴：无投影；不响应悬停、按住（规则都排除了 :disabled）
  assert.match(knob, /box-shadow:\s*none/);
  // 拖不动：槽上不挂指针处理（静态渲染看不到事件，这里看规则：悬停与按住都带 :not(:disabled)）
  for (const m of uiCss.matchAll(/\n(\.ss-switch:(?:hover|active)[^{\n]*)[{,]/g)) {
    assert.match(m[1], /:not\(:disabled\)/, m[1]);
  }
});

test("Checkbox 13px：未选 / 已选 / 半选 / 不可选；与 CheckMark 同一个记号", async () => {
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
  assert.match(rule, /width:\s*13px/);
  assert.match(rule, /height:\s*13px/);
  // 复选框是记号：mark 4 圆角；关＝paper 底 + ink-faint 边
  assert.match(rule, /border-radius:\s*var\(--radius-mark\)/);
  assert.match(rule, /border:\s*1px solid var\(--ink-faint\)/);
  assert.match(rule, /background:\s*var\(--paper\)/);
  assert.match(cssRule(uiCss, ".ss-checkbox.is-on"), /background:\s*var\(--ink\)/);
  // 整行是按钮的列表画出来的方框与 Checkbox 同一个记号
  const { CheckMark } = await import("../src/pages/CheckMark.tsx");
  const on = render(Checkbox, { checked: true, label: "x" });
  const drawn = render(CheckMark, { on: true });
  const glyph = (html: string) => html.match(/<svg[\s\S]*<\/svg>/)?.[0];
  assert.ok(glyph(on));
  assert.equal(glyph(drawn), glyph(on));
  assert.equal(
    glyph(render(CheckMark, { on: "mixed" })),
    glyph(render(Checkbox, { checked: "mixed", label: "x" })),
  );
  // 命中区用伪元素撑到 24，不动 border
  assert.match(cssRule(uiCss, ".ss-checkbox::before"), /inset:\s*-6px/);
});

// ===== 页签滑槽 =====

test("Tabs：surface 槽 + recess-tabs 内凹 + 10 圆角、内边距 3；页签高 28、左右 16、Condensed 15/700 ink-mute、经 Cap 大写、选中同重", () => {
  const html = render(Tabs, {
    items: [
      { id: "skills", label: "skills" },
      { id: "mcp", label: "MCP" },
    ],
    value: "skills",
    onChange: noop,
    label: "功能",
  });
  // 导航语义：nav + 当前页 aria-current；首帧（静态渲染）还没量到滑块位置
  assert.match(html, /^<nav class="ss-tabs" aria-label="功能">/);
  assert.match(html, /<span class="ss-tabs__thumb" aria-hidden="true"><\/span>/);
  assert.match(
    html,
    /<button type="button" class="ss-tabs__tab is-on" aria-current="page"><span class="ss-cap-wrap ss-cap-wrap--nav"><span class="ss-cap">skills<\/span><\/span><\/button>/,
  );
  assert.match(
    html,
    /<button type="button" class="ss-tabs__tab"><span class="ss-cap-wrap ss-cap-wrap--nav"><span class="ss-cap">MCP<\/span>/,
  );
  const track = cssRule(uiCss, ".ss-tabs");
  assert.match(track, /background:\s*var\(--surface\)/);
  assert.match(track, /box-shadow:\s*var\(--recess-tabs\)/);
  assert.match(track, /border-radius:\s*var\(--radius-tab-track\)/);
  assert.match(track, /padding:\s*3px/);
  const tab = cssRule(uiCss, ".ss-tabs__tab");
  assert.match(tab, /height:\s*var\(--control-h\)/);
  assert.match(tab, /padding:\s*0 16px/);
  assert.match(tab, /font-size:\s*var\(--size-body\)/);
  assert.match(tab, /font-family:\s*var\(--font-cond\)/);
  assert.match(tab, /font-weight:\s*700/);
  assert.match(tab, /color:\s*var\(--ink-mute\)/);
  // 大写与字距不写在页签上：经 Cap 只作用于拉丁 run（`skills` 显示为 `SKILLS`），数据本身不改
  assert.doesNotMatch(tab, /text-transform/);
  assert.match(tab, /letter-spacing:\s*0;/);
  assert.match(cssRule(uiCss, ".ss-tabs__tab:hover:not(.is-on)"), /color:\s*var\(--ink\)/);
  const on = cssRule(uiCss, ".ss-tabs__tab.is-on");
  assert.match(on, /color:\s*var\(--ink\)/);
  // 选中同重 700：靠滑块与墨色区分，切换前后字宽不变
  assert.doesNotMatch(on, /font-weight/);
});

test("Tabs 滑块：paper + raise 抬起、7 圆角；位移与变宽 260ms 弹簧；悬停影子略重；按住贴近槽底；量到之前由选中页签自己画", () => {
  const thumb = cssRule(uiCss, ".ss-tabs__thumb");
  assert.match(thumb, /background:\s*var\(--paper\)/);
  assert.doesNotMatch(thumb, /border:/);
  assert.match(thumb, /border-radius:\s*var\(--radius-control\)/);
  assert.match(thumb, /box-shadow:\s*var\(--raise\)/);
  // 位置用 translate，按压用 transform，互不打架
  assert.match(thumb, /translate:\s*var\(--thumb-x, 0\)/);
  assert.match(thumb, /translate var\(--dur-slide-tab\) var\(--spring-slide\)/);
  assert.match(thumb, /width var\(--dur-slide-tab\) var\(--spring-slide\)/);
  assert.match(thumb, /transform var\(--dur-release\) var\(--spring-slide\)/);
  assert.match(
    cssRule(uiCss, ".ss-tabs:has(.ss-tabs__tab.is-on:hover) .ss-tabs__thumb"),
    /box-shadow:\s*var\(--raise-hover\)/,
  );
  const pressed = cssRule(uiCss, ".ss-tabs:has(.ss-tabs__tab:active) .ss-tabs__thumb");
  assert.match(pressed, /box-shadow:\s*var\(--raise-pressed\)/);
  assert.match(pressed, /transform:\s*var\(--press-transform\)/);
  assert.match(pressed, /transform var\(--dur-press\) var\(--ease-mech\)/);
  // 没量到：不画滑块，选中页签自己带纸面 + 抬起——首帧不闪
  assert.match(cssRule(uiCss, ".ss-tabs:not(.has-thumb) .ss-tabs__thumb"), /display:\s*none/);
  const fallback = cssRule(uiCss, ".ss-tabs:not(.has-thumb) .ss-tabs__tab.is-on");
  assert.match(fallback, /background:\s*var\(--paper\)/);
  assert.match(fallback, /box-shadow:\s*var\(--raise\)/);
  // 页签之间没有竖线、没有下划线
  assert.doesNotMatch(tab(), /border-(left|right|bottom):/);
  // 减少动效：滑块即时到位
  const reduced = uiCss.slice(uiCss.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.ss-tabs__thumb,/);
  function tab() {
    return cssRule(uiCss, ".ss-tabs__tab");
  }
});

// ===== 片与标签 =====

test("Chip：胶囊 28，名字 13 原样，计数 12 tabular；未选透明底 + ctl-border，选中＝墨片（计数 ctl-border），无底边", () => {
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
  assert.match(rule, /border:\s*var\(--border-control\)/);
  assert.match(rule, /background:\s*transparent/);
  // 片是切换状态，不是键：没有底边、不投影
  assert.doesNotMatch(uiCss.replace(/\/\*[\s\S]*?\*\//g, ""), /\.ss-chip[^{]*\{[^}]*box-shadow/);
  const selected = cssRule(uiCss, ".ss-chip.is-selected");
  assert.match(selected, /background:\s*var\(--ink\)/);
  assert.match(selected, /color:\s*var\(--face\)/);
  assert.match(
    cssRule(uiCss, ".ss-chip.is-selected .ss-chip__count"),
    /color:\s*var\(--ctl-border\)/,
  );
  const count = cssRule(uiCss, ".ss-chip__count");
  assert.match(count, /font-family:\s*var\(--font-ui\)/);
  assert.match(count, /font-variant-numeric:\s*tabular-nums/);
});

test("Chip 不可选：置灰并给出原因", () => {
  const html = render(Chip, {
    children: "Cline",
    disabled: true,
    disabledReason: "这个 agent 还没装",
  });
  assert.match(html, /disabled=""/);
  assert.match(html, /title="这个 agent 还没装"/);
  const rule = cssRule(uiCss, ".ss-chip:disabled");
  assert.match(rule, /border:\s*var\(--border-disabled\)/);
  assert.match(rule, /color:\s*var\(--ink-faint\)/);
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
  const rule = cssRule(uiCss, ".ss-modelchip");
  assert.match(rule, /height:\s*var\(--control-h-compact\)/);
  // paper 面 + 1px hairline 环：与筛选片形状一样、材质不同
  assert.match(rule, /background:\s*var\(--paper\)/);
  assert.match(rule, /border:\s*1px solid var\(--hairline\)/);
  assert.match(rule, /padding:\s*0 7px 0 10px/);
});

test("Tag：不可点的标识没有框——强 ink 600 / 弱 ink-mute 400", () => {
  assert.match(render(Tag, { children: "同名" }), /class="ss-tag ss-tag--strong"/);
  assert.match(render(Tag, { children: "已添加", tone: "weak" }), /class="ss-tag ss-tag--weak"/);
  assert.doesNotMatch(cssRule(uiCss, ".ss-tag"), /(^|\s)border(-[a-z]+)?:/);
  assert.match(cssRule(uiCss, ".ss-tag--weak"), /color:\s*var\(--ink-mute\)/);
});

test("Tag 可悬停不可点：提示框（aria-describedby），不加点状下划线（D21）", () => {
  const html = render(Tag, { children: "2 份不一样", tip: "url 不同" });
  assert.match(html, /class="ss-tag ss-tag--strong has-tip"/);
  assert.match(html, /tabindex="0" aria-describedby="[^"]+"/);
  assert.match(html, /role="tooltip"[^>]*>url 不同</);
  assert.doesNotMatch(cssRule(uiCss, ".ss-tag.has-tip"), /text-decoration/);
  assert.doesNotMatch(uiCss, /dotted/);
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
  // 快捷键只给键盘：默认不显示；打开那一刻触发控件 :focus-visible（键盘焦点）就挂 is-keyed 才显示
  assert.match(cssRule(uiCss, ".ss-tip__keyhint"), /display:\s*none/);
  assert.match(cssRule(uiCss, ".ss-tip.is-keyed .ss-tip__keyhint"), /display:\s*inline/);
  // 静止时不显示；原生 title 不作唯一说明
  assert.doesNotMatch(html, /is-open/);
  const rule = cssRule(uiCss, ".ss-tip");
  assert.match(rule, /padding:\s*6px 8px/);
  assert.match(rule, /max-width:\s*240px/);
  assert.match(rule, /background:\s*var\(--ink\)/);
  assert.match(rule, /font-size:\s*var\(--size-label\)/);
  assert.match(cssRule(uiCss, ".ss-tip--top"), /bottom:\s*calc\(100% \+ 6px\)/);
});

test("Tooltip 图层：打开的气泡浮在 body 上（fixed），盖过侧栏、吸顶区与确认弹窗；收着时留在包层里", () => {
  // 服务端渲染（收着）：气泡就在包层里，aria-describedby 指得到它
  const html = render(Tooltip, {
    content: "computer-use 在这里没有能写进或移除的",
    children: createElement("button", { type: "button" }, "框"),
  });
  const id = html.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(id);
  assert.match(html, new RegExp(`<span id="${id}" role="tooltip" class="ss-tip ss-tip--top">`));
  // 打开时：fixed、位置由 placeTip 写进 top / left，侧位类不再起作用；最大宽让窗口四边各 16
  const floating = cssRule(uiCss, ".ss-tip.is-floating");
  assert.match(floating, /position:\s*fixed/);
  assert.match(floating, /inset:\s*auto/);
  assert.match(floating, /transform:\s*none/);
  assert.match(floating, /max-width:\s*min\(240px, calc\(100vw - 32px\)\)/);
  // z：确认弹窗（40）、浮起小窗（36）、二级页（30）之上
  const z = (sel: string) => Number(cssRule(uiCss, sel).match(/z-index:\s*(\d+)/)?.[1]);
  assert.ok(z(".ss-tip") > z(".ss-confirm-layer"));
  assert.ok(z(".ss-tip") > z(".ss-floattoast"));
  assert.ok(z(".ss-tip") > z(".ss-subpage"));
  // 单行的那几句：不受 240 上限，窗口放不下才折行
  assert.match(
    render(Tooltip, {
      content: "重启 Codex 桌面应用让改动生效，进行中的对话会中断",
      nowrap: true,
      align: "end",
      children: createElement("button", { type: "button" }, "重启生效"),
    }),
    /class="ss-tip ss-tip--top ss-tip--nowrap"/,
  );
  assert.match(
    cssRule(uiCss, ".ss-tip.ss-tip--nowrap.is-floating"),
    /max-width:\s*calc\(100vw - 32px\)/,
  );
});

test("Tooltip 时机：表格内 700ms、表格外 400ms", () => {
  assert.equal(TIP_DELAY_MS.table, 700);
  assert.equal(TIP_DELAY_MS.default, 400);
});

// ===== 点了做不了的控件，按下当即说明原因（DESIGN「提示框」） =====

/// 禁用控件自带的原因包层：接住焦点、挂 aria-describedby、气泡里是原因
function assertReasonWrap(html: string, reason: string) {
  const id = html.match(
    /^<span class="ss-tipwrap is-explain" tabindex="0" aria-describedby="([^"]+)">/,
  )?.[1];
  assert.ok(id, `禁用控件要自带可聚焦的原因包层：${html}`);
  assert.match(
    html,
    new RegExp(`id="${id}" role="tooltip" class="ss-tip [^"]*">${reason}</span></span>$`),
  );
}

test("禁用的 Switch / Button / IconButton / AddButton / Checkbox 自带原因提示框包层", () => {
  assertReasonWrap(
    render(Switch, { checked: false, onChange: noop, label: "x", disabledReason: "先勾选模型" }),
    "先勾选模型",
  );
  assertReasonWrap(
    render(Button, { children: "保存", disabled: true, disabledReason: "先填地址" }),
    "先填地址",
  );
  assertReasonWrap(
    render(IconButton, { icon: IconCheck({}), title: "删掉", disabledReason: "还在用" }),
    "还在用",
  );
  assertReasonWrap(render(AddButton, { noun: "项目", disabledReason: "正在读取" }), "正在读取");
  assertReasonWrap(
    render(Checkbox, { checked: false, label: "全选", disabledReason: "没有可以勾选的行" }),
    "没有可以勾选的行",
  );
  // 方向可选：来源管理页行尾的 × 放下方
  assert.match(
    render(IconButton, {
      icon: IconCheck({}),
      title: "删掉",
      disabledReason: "还在用",
      tipPlacement: "bottom",
    }),
    /class="ss-tip ss-tip--bottom/,
  );
  // 来源管理页行尾的 ×：原因一句单行
  assert.match(
    render(IconButton, {
      icon: IconCheck({}),
      title: "删掉",
      disabledReason: "它的原件就在 CardBox 里，删掉原件才会消失",
      tipPlacement: "bottom",
      tipNowrap: true,
    }),
    /class="ss-tip ss-tip--bottom ss-tip--nowrap"/,
  );
});

test("能点的控件：包层不占盒、不出提示框、不抢焦点（禁用 / 解禁是同一棵树，控件不重挂）", () => {
  const html = render(Switch, { checked: true, onChange: noop, label: "x" });
  assert.match(html, /^<span class="ss-tipwrap is-idle"><button [^>]*role="switch"/);
  assert.doesNotMatch(html, /role="tooltip"|tabindex|aria-describedby/);
  assert.match(cssRule(uiCss, ".ss-tipwrap.is-idle"), /display:\s*contents !important/);
});

test("禁用的控件不吃指针，悬停与按下落在包层上；复选框的命中区挪到包层", () => {
  assert.match(cssRule(uiCss, ".ss-tipwrap.is-explain > :disabled"), /pointer-events:\s*none/);
  assert.match(
    cssRule(uiCss, ".ss-tipwrap.is-explain:has(> .ss-checkbox)::before"),
    /inset:\s*-6px/,
  );
  // 安静键与外链的负外边距挪到包层上：包层与键同宽，版面不变
  assert.match(cssRule(uiCss, ".ss-tipwrap.is-explain:has(> .ss-btn--quiet)"), /margin:\s*0 -6px/);
  assert.match(cssRule(uiCss, ".ss-tipwrap.is-explain > .ss-btn--quiet"), /margin:\s*0/);
});

test("按下做不了的控件：当即弹出、不等延时，再按收起；钉出的停约 3 秒", () => {
  const opt = { explain: true, yielded: false };
  const pinned = nextTip(TIP_IDLE, "press", opt);
  assert.deepEqual(pinned, { open: true, pinned: true, pressed: false });
  // 再按一下：收起，移开再进来之前不再出
  const closed = nextTip(pinned, "press", opt);
  assert.equal(closed.open, false);
  assert.equal(nextTip(closed, "delay", opt).open, false);
  // 悬停已出的，按下是钉住，不是收起（用户报的：悬停出了、一点就没了）
  const hovered = nextTip(TIP_IDLE, "delay", opt);
  assert.equal(hovered.open, true);
  assert.deepEqual(nextTip(hovered, "press", opt), { open: true, pinned: true, pressed: false });
  // 停够了收起，同样移开前不再出；移开复位
  const expired = nextTip(pinned, "expire", opt);
  assert.equal(expired.open, false);
  assert.equal(nextTip(expired, "delay", opt).open, false);
  assert.equal(nextTip(nextTip(expired, "leave", opt), "delay", opt).open, true);
  // 与格子同一个停留时长
  assert.equal(PINNED_TIP_MS, 3000);
});

test("按下能点的控件：提示框即收起，移开再进来之前不再出", () => {
  const opt = { explain: false, yielded: false };
  const open = nextTip(TIP_IDLE, "delay", opt);
  const pressed = nextTip(open, "press", opt);
  assert.equal(pressed.open, false);
  assert.equal(nextTip(pressed, "delay", opt).open, false);
  assert.equal(nextTip(pressed, "press", opt).open, false);
  assert.equal(nextTip(nextTip(pressed, "leave", opt), "delay", opt).open, true);
});

test("嵌套：里层是禁用原因时外层让位，同时只出一个", () => {
  // 外层（「重启生效」的说明、「打开：…」）被里层占住：悬停到点、按下都不出，已开的收起
  const opt = { explain: false, yielded: true };
  assert.equal(nextTip(TIP_IDLE, "delay", opt).open, false);
  assert.equal(nextTip(TIP_IDLE, "press", opt).open, false);
  const outerOpen = nextTip(TIP_IDLE, "delay", { explain: false, yielded: false });
  assert.equal(nextTip(outerOpen, "yield", { explain: false, yielded: true }).open, false);
  // 结构：外层包层里是禁用开关自带的原因包层；外层的 aria-describedby 转到 <button> 上
  const html = render(Tooltip, {
    content: "打开后，选好的模型会出现在 Codex 的模型列表里",
    children: createElement(Switch, {
      checked: false,
      onChange: noop,
      label: "x",
      disabledReason: "正在处理上一步",
    }),
  });
  const outerId = html.match(/id="([^"]+)" role="tooltip" class="[^"]*">打开/)?.[1];
  assert.ok(outerId);
  assert.match(html, /^<span class="ss-tipwrap"><span class="ss-tipwrap is-explain" tabindex="0"/);
  assert.match(html, new RegExp(`<button [^>]*aria-describedby="${outerId}"[^>]*disabled=""`));
  assert.equal(html.match(/role="tooltip"/g)?.length, 2);
  // 里层没有原因（控件能点）：外层的描述照样转到 <button> 上，里层不把它清掉
  const enabled = render(Tooltip, {
    content: "重启 Codex 桌面应用让改动生效",
    children: createElement(Button, { size: "compact", onClick: noop }, "重启生效"),
  });
  const enabledId = enabled.match(/id="([^"]+)" role="tooltip"/)?.[1];
  assert.ok(enabledId);
  assert.match(enabled, new RegExp(`<button [^>]*aria-describedby="${enabledId}"`));
});

test("Spinner：macOS 式辐条，8 根、逐根变淡、ink-mute、必带读屏文本；14 / 24 两档", () => {
  const small = render(Spinner, { label: "正在重启 Codex" });
  assert.match(small, /class="ss-spinner"/);
  assert.match(small, /width="14"/);
  assert.match(small, /aria-label="正在重启 Codex"/);
  const spokes = small.match(/<line [^>]*>/g) ?? [];
  assert.equal(spokes.length, 8);
  // 14：内径 3、外端 6.25、粗 1.5；第 0 根在 12 点钟最实，最后一根 0.2
  assert.match(spokes[0], /x1="7" y1="4" x2="7" y2="0.75"/);
  assert.match(spokes[0], /stroke-width="1.5"/);
  assert.match(spokes[0], /stroke-linecap="round"/);
  assert.match(spokes[0], /opacity="1"/);
  assert.match(spokes[7], /opacity="0.2"/);
  assert.match(cssRule(uiCss, ".ss-spinner"), /color:\s*var\(--ink-mute\);/);
  // 没有太阳、地球、轨道了
  assert.doesNotMatch(small, /ss-spinner__/);
  const large = render(Spinner, { size: 24, label: "正在读 3 个位置" });
  assert.match(large, /width="24"/);
  assert.match(large, /x1="12" y1="7" x2="12" y2="1"/);
  assert.match(large, /stroke-width="2"/);
});

test("TruncTip：内容只是触发文字的完整值，文字真被截断才出；读屏不重复挂描述", () => {
  // 量法：包层里任一段文字横向溢出（行内元素量不出宽度，不算）
  const el = (clientWidth: number, scrollWidth: number, kids: unknown[] = []) =>
    ({ clientWidth, scrollWidth, querySelectorAll: () => kids }) as unknown as Element;
  assert.equal(isClipped(null), false);
  assert.equal(isClipped(el(0, 0, [el(200, 200)])), false);
  assert.equal(isClipped(el(0, 0, [el(0, 0), el(120, 260)])), true);
  assert.equal(isClipped(el(120, 121)), false);
  // 完整值就是文字本身：不挂 aria-describedby（视觉截断，文字读得全）
  const html = render(TruncTip, {
    content: "https://example.com/openai/v1",
    children: createElement(
      "span",
      { className: "gw-panel__url" },
      "https://example.com/openai/v1",
    ),
  });
  assert.doesNotMatch(html, /aria-describedby/);
  assert.match(html, /role="tooltip"/);
});

// ===== 提示条 =====

test("Toast notice：墨窗，40px 指示窗 + 动词 + 图标 + 名字 + 浅描边键 + ×", () => {
  // 成功是纸、需要注意是墨（DESIGN「反馈的两种形态」）：墨窗的形制用明确要了 notice 档的来验
  const html = render(Toast, {
    tier: "notice",
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
  assert.match(rule, /color:\s*var\(--face\)/);
  // 墨窗无外框；float 12 圆角 + 唯一的浮层投影
  assert.doesNotMatch(rule, /(^|\s)border(-(?!radius)[a-z]+)?:/);
  assert.match(rule, /border-radius:\s*var\(--radius-float\)/);
  assert.match(rule, /box-shadow:\s*var\(--elev-float\)/);
  // 墨面上的次字 ctl-border，分隔线 ink-mute
  assert.match(cssRule(uiCss, ".ss-toast--notice .ss-toast__sep"), /color:\s*var\(--ctl-border\)/);
  assert.match(
    cssRule(uiCss, ".ss-toast__indicator"),
    /border-right:\s*1px solid var\(--ink-mute\)/,
  );
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
  // 副行是路径：等宽、可拖选（D23）
  assert.match(html, /class="ss-toast__stats ss-selectable">~\/\.codex\/skills\/defuddle</);
  assert.equal(TOAST_DWELL_MS.cannot, 8000);
});

test("Toast 部分失败：! + 2 ✓ · 1 ⊘ 读数 + 查看，停 8 秒", () => {
  const html = render(Toast, {
    kind: "partial",
    verb: "开启",
    tally: { done: 2, failed: 1 },
    reason: "无法写入 Cline",
    action: { label: "查看", onClick: noop },
  });
  assert.match(html, /title="部分失败"/);
  assert.match(html, /aria-label="2 个成功，1 个没成"/);
  assert.match(html, />查看</);
  assert.equal(TOAST_DWELL_MS.partial, 8000);
});

test("Toast 展开态：删原件的后果与路径放在副行之下", () => {
  const html = render(Toast, {
    tier: "notice",
    kind: "success",
    verb: "删到废纸篓",
    names: ["docx"],
    detail: "示意图",
  });
  assert.match(html, /class="ss-toast ss-toast--notice has-detail"/);
  assert.match(html, /class="ss-toast__detail">示意图</);
});

test("Toast 成功：不给档位也是纸窗（paper + hairline 边 + float 12 圆角 + 浮层投影，高 32），撤销是安静键；成功不用墨窗", () => {
  const html = render(Toast, {
    kind: "success",
    verb: "写进",
    agents: [{ id: "codex", name: "Codex" }],
    names: ["excalidraw"],
    action: { label: "撤销", onClick: noop },
  });
  assert.match(html, /class="ss-toast ss-toast--routine"/);
  assert.match(html, /class="ss-toast__verb">写进</);
  assert.match(html, /class="ss-btn ss-btn--quiet">撤销</);
  assert.doesNotMatch(html, /ss-toast__indicator/);
  const rule = cssRule(uiCss, ".ss-toast--routine");
  assert.match(rule, /background:\s*var\(--paper\)/);
  assert.match(rule, /border:\s*var\(--border-float\)/);
  assert.match(rule, /border-radius:\s*var\(--radius-float\)/);
  assert.match(rule, /box-shadow:\s*var\(--elev-float\)/);
  assert.match(rule, /height:\s*var\(--control-h-row\)/);
  // 做不成 / 部分失败不给档位时是墨窗
  assert.match(render(Toast, { kind: "cannot", verb: "没加上" }), /ss-toast--notice/);
});

test("Toast 文字一律 13：动词 600、名字 400、数字 12 tabular（不换等宽字族）——比表格正文 15 低一档", async () => {
  assert.match(cssRule(uiCss, ".ss-toast"), /font-size:\s*var\(--size-caption\)/);
  assert.match(cssRule(uiCss, ".ss-toast__verb"), /font-weight:\s*600/);
  const num = cssRule(uiCss, ".ss-toast__num");
  assert.match(num, /font-family:\s*var\(--font-ui\)/);
  assert.match(num, /font-variant-numeric:\s*tabular-nums/);
  assert.match(num, /font-size:\s*var\(--size-label\)/);
  const { ToastCount } = await import("../src/ui/Toast.tsx");
  // 数量是一整段：flex 的 gap 拆不开「3 个」
  assert.equal(
    render(ToastCount, { n: 3 }),
    '<span class="ss-toast__count"><span class="ss-toast__num">3</span>\u00a0个</span>',
  );
  // 单格失败的原因本身是一整句：写在动词的位置，可折行
  const cell = render(Toast, { kind: "cannot", message: "无法写入 Codex 的 skills 目录" });
  assert.match(cell, /class="ss-toast__message">无法写入 Codex 的 skills 目录</);
  assert.doesNotMatch(cell, /ss-toast__verb/);
});

test("Toast 停留：成功无动作约 4 秒、带撤销 6 秒、做不成 8 秒；两档都悬停停表，到点末尾 120ms 同一个淡出", () => {
  assert.equal(CELL_TOAST_DWELL_MS, 4000);
  assert.ok(CELL_TOAST_DWELL_MS < TOAST_DWELL_MS.success);
  const html = render(Toast, {
    kind: "success",
    verb: "加到",
    names: ["excalidraw"],
    onDismiss: noop,
  });
  // 刚出现时不在淡出
  assert.match(html, /class="ss-toast ss-toast--routine" data-kind="success" role="status"/);
  const leaving = cssRule(uiCss, ".ss-toast.is-leaving");
  assert.match(leaving, /opacity:\s*0/);
  assert.match(leaving, /transition:\s*opacity var\(--motion-fast\) var\(--ease-mech\)/);
  const reduced = uiCss.slice(uiCss.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.ss-toast\.is-leaving \{\s*transition: none;/);
  // 淡出与悬停停表不再是两个可选开关：两档同一套（旧的 fadeOut / holdOnHover 已撤）
  const src = readFileSync(new URL("../src/ui/Toast.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /fadeOut|holdOnHover/);
});

test("忙碌门槛 0.3 秒：触发键先锁住、外观不变，过了门槛才原位换成转圈 + 一句", () => {
  assert.equal(BUSY_DELAY_MS, 300);
  const button = createElement("button", { type: "button" }, "检查更新");
  // 首帧（门槛之前）：键照旧，只是点不动
  const early = render(BusySlot, { busy: true, label: "正在检查", children: button });
  assert.match(
    early,
    /^<span class="ss-locked" aria-busy="true"><button type="button">检查更新<\/button>/,
  );
  assert.doesNotMatch(early, /ss-spinner/);
  assert.match(cssRule(uiCss, ".ss-locked"), /pointer-events:\s*none/);
  assert.match(cssRule(uiCss, ".ss-locked"), /display:\s*contents/);
  // 不忙：原样
  assert.equal(
    render(BusySlot, { busy: false, label: "正在检查", children: button }),
    '<button type="button">检查更新</button>',
  );
});

test("提示小窗的动作在等（MCP 撤销）：只锁那颗安静键，门槛前外观不变", () => {
  const onClick = () => undefined;
  const busy = render(Toast, {
    kind: "success",
    verb: "写进",
    action: { label: "撤销", onClick, busy: "正在撤销" },
  });
  assert.match(
    busy,
    /<span class="ss-locked" aria-busy="true">(<span[^>]*>)?<button[^>]*>撤销<\/button>/,
  );
  assert.doesNotMatch(busy, /ss-spinner/);
  // 不在等：原样，不包一层
  const idle = render(Toast, { kind: "success", verb: "写进", action: { label: "撤销", onClick } });
  assert.doesNotMatch(idle, /ss-locked/);
});

// ===== 错误横幅与行内待办条：大面积的提示用 surface 灰面板，不用黑 =====

test("ErrorBanner：surface 灰面板（face 12 圆角、无边无投影）+ 墨色 !，不自动消失；默认键紧凑 24 与 ×", () => {
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
  assert.match(rule, /border-radius:\s*var\(--radius-face\)/);
  assert.doesNotMatch(rule, /(^|\s)border:|box-shadow/);
  assert.match(cssRule(uiCss, ".ss-banner__detail"), /color:\s*var\(--ink-mute\)/);
  // 页级「路由没在跑」不可关
  assert.doesNotMatch(render(ErrorBanner, { message: "路由没在跑" }), /关闭/);
});

test("NoticePanel：surface 灰面板，! + 一句 + 默认键（纸面）+ 可选安静键；忙碌指示用墨色", () => {
  const html = render(NoticePanel, {
    message: "改动要重启 Codex 才生效",
    action: { label: "重启", onClick: noop },
    link: { label: "稍后", onClick: noop },
  });
  assert.match(html, /class="ss-noticepanel"/);
  assert.match(html, /aria-label="要你动手"/);
  assert.match(html, /class="ss-btn ss-btn--compact">重启</);
  assert.match(html, /class="ss-btn ss-btn--quiet">稍后</);
  assert.doesNotMatch(html, /is-on-dark/);
  const rule = cssRule(uiCss, ".ss-noticepanel");
  assert.match(rule, /background:\s*var\(--surface\)/);
  assert.match(rule, /color:\s*var\(--ink\)/);
  assert.match(rule, /border-radius:\s*var\(--radius-face\)/);
  assert.match(rule, /padding:\s*8px 12px/);
  assert.doesNotMatch(rule, /(^|\s)border:|box-shadow/);
  // 灰面上的默认键本来就是纸面，不再单独改底；安静键的悬停带在灰上退一档到 hairline
  assert.doesNotMatch(uiCss, /\.ss-noticepanel \.ss-btn:not/);
  assert.match(
    cssRule(uiCss, ".ss-noticepanel .ss-btn--quiet:hover:not(:disabled)"),
    /background:\s*var\(--hairline\)/,
  );
  assert.doesNotMatch(uiCss, /ss-noticepanel[^{]*\.ss-spinner/);
  // 正在执行：门槛之前键照旧、点不动（不闪一下忙碌），过了 0.3 秒才换成忙碌指示 + 一句
  const busy = render(NoticePanel, {
    message: "x",
    busy: "正在接管",
    action: { label: "接管", onClick: noop },
  });
  assert.match(busy, /class="ss-noticepanel__actions is-locked"/);
  assert.match(busy, />接管</);
  assert.doesNotMatch(busy, /ss-spinner/);
  assert.match(cssRule(uiCss, ".ss-noticepanel__actions.is-locked"), /pointer-events:\s*none/);
});

test("NoticePanel 行下失败：原因写全、可折行，给了 onClose 才有右端 ×", () => {
  const reason = "已启用时至少要保留一个模型；如需全部移除请先恢复";
  const html = render(NoticePanel, {
    message: "没重启 Codex",
    reason,
    action: { label: "再试一次", onClick: noop },
    onClose: noop,
  });
  assert.match(
    html,
    new RegExp(`没重启 Codex<span class="ss-noticepanel__reason"> · ${reason}</span>`),
  );
  assert.match(html, /再试一次<\/button>[^]*class="ss-noticepanel__close"[^]*aria-label="关闭"/);
  // 原因折行、不截断：不省略号、不 nowrap
  const reasonRule = cssRule(uiCss, ".ss-noticepanel__reason");
  assert.match(reasonRule, /white-space:\s*normal/);
  assert.doesNotMatch(reasonRule, /ellipsis|overflow:\s*hidden/);
  // 待办条（不可关）没有 ×
  assert.doesNotMatch(render(NoticePanel, { message: "x" }), /关闭/);
});

// ===== 确认弹窗 =====

test("Confirm：纸浮层 384（paper + hairline 边 + float 12 + 浮层投影），ink 16% 遮罩；取消是默认键、主动作墨键，键高 32", () => {
  const html = render(Confirm, {
    title: "重启 Codex？",
    children: "会结束 Codex 正在运行的进程，进行中的对话会中断",
    confirmLabel: "重启",
    onConfirm: noop,
    onCancel: noop,
  });
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /class="ss-confirm__title">重启 Codex？</);
  // 取消在左、主动作在右，两颗都有底边，主次靠墨与纸分开（D14）
  assert.match(
    html,
    /class="ss-btn ss-btn--row">取消<\/button>.*class="ss-btn ss-btn--primary ss-btn--row">重启</,
  );
  assert.match(html, /class="ss-confirm-veil ss-confirm-veil--full"/);
  const board = cssRule(uiCss, ".ss-confirm");
  assert.match(board, /border:\s*var\(--border-float\)/);
  assert.match(board, /background:\s*var\(--paper\)/);
  assert.match(board, /border-radius:\s*var\(--radius-float\)/);
  assert.match(board, /box-shadow:\s*var\(--elev-float\)/);
  assert.match(board, /width:\s*384px/);
  assert.match(board, /padding:\s*20px 20px 16px/);
  // 标题 head Condensed 16/600、原样字距 0，正文 body 15 ink-mute（不是 14）
  const title = cssRule(uiCss, ".ss-confirm__title");
  assert.match(title, /font-family:\s*var\(--font-cond\)/);
  assert.match(title, /font-size:\s*var\(--size-head\)/);
  assert.match(title, /font-weight:\s*600/);
  assert.match(title, /letter-spacing:\s*0;/);
  const body = cssRule(uiCss, ".ss-confirm__body");
  assert.match(body, /font-size:\s*var\(--size-body\)/);
  assert.match(body, /color:\s*var\(--ink-mute\)/);
  const foot = cssRule(uiCss, ".ss-confirm__foot");
  assert.match(foot, /gap:\s*var\(--space-xs\)/);
  assert.match(foot, /padding-top:\s*var\(--space-lg\)/);
  const veil = cssRule(uiCss, ".ss-confirm-veil");
  // 遮罩 ink 16%
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

test("Confirm 铭牌：凹面等宽 ink 字、路径可拖选；主动作禁用时带原因", () => {
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
    /class="ss-confirm__path ss-selectable">~\/Library\/Application Support\/WeiboAP\/skills\/docx</,
  );
  assert.match(html, /class="ss-confirm__meta">3 个文件/);
  assert.match(html, /disabled=""/);
  assert.match(html, /title="原件在 git 仓库里，请在仓库里删掉并提交"/);
  const plate = cssRule(uiCss, ".ss-confirm__nameplate");
  // V4 不再用墨底铭牌：墨面只有两义
  assert.match(plate, /background:\s*var\(--recess\)/);
  assert.match(plate, /box-shadow:\s*var\(--recess-input\)/);
  assert.match(plate, /color:\s*var\(--ink\)/);
  assert.match(plate, /padding:\s*10px 12px/);
  assert.match(plate, /font-family:\s*var\(--font-mono\)/);
});

// ===== 二级页面 =====

test("SubPage：头落在机壳上（← + 页面名 display Condensed 28/700、字距 0、无分隔线），内容进机面，头 84 = 28 + 56", () => {
  const html = render(SubPage, { title: "添加 skill 到「全局」", onBack: noop, children: "内容" });
  assert.match(html, /class="ss-subpage"/);
  assert.match(html, /class="ss-iconbtn" title="返回" aria-label="返回"/);
  // 页标题可被程序聚焦（打开时焦点移过去），但不进 Tab 序列
  assert.match(html, /class="ss-subpage__title" tabindex="-1">添加 skill 到「全局」</);
  assert.match(html, /class="ss-subpage__body">内容</);
  const title = cssRule(uiCss, ".ss-subpage__title");
  assert.match(title, /font-family:\s*var\(--font-cond\)/);
  assert.match(title, /font-size:\s*var\(--size-display\)/);
  assert.match(title, /font-weight:\s*700/);
  assert.match(title, /letter-spacing:\s*0/);
  assert.doesNotMatch(title, /text-transform/);
  const bar = cssRule(uiCss, ".ss-subpage__bar");
  assert.match(bar, /height:\s*calc\(var\(--titlestrip\) \+ var\(--topbar\)\)/);
  assert.doesNotMatch(bar, /border(-bottom)?:/);
  assert.match(cssRule(uiCss, ".ss-subpage"), /background:\s*var\(--shell\)/);
  const body = cssRule(uiCss, ".ss-subpage__body");
  assert.match(body, /background:\s*var\(--face\)/);
  assert.match(body, /border:\s*var\(--border-face\)/);
  assert.match(body, /border-radius:\s*var\(--radius-face\)/);
  assert.doesNotMatch(body, /box-shadow/);
});

// ===== 大小写：大写与正字距只经 Cap =====

test("Cap：按脚本切 run，只给含字母的拉丁 run 套 Condensed 大写 + 字距，汉字 run 原样、字距 0", () => {
  const html = render(Cap, { children: "Claude Code 用户" });
  assert.equal(
    html,
    '<span class="ss-cap-wrap ss-cap-wrap--label"><span class="ss-cap">Claude Code </span>用户</span>',
  );
  // 四档：nav / label（默认）/ head / mark
  for (const tone of ["nav", "label", "head", "mark"]) {
    assert.match(render(Cap, { children: "AGENT", tone }), new RegExp(`ss-cap-wrap--${tone}`));
  }
  const cap = cssRule(uiCss, ".ss-cap");
  assert.match(cap, /font-family:\s*var\(--font-cond\)/);
  assert.match(cap, /text-transform:\s*uppercase/);
  assert.match(cap, /letter-spacing:\s*var\(--track-label\)/);
  assert.match(cssRule(uiCss, ".ss-cap-wrap--nav .ss-cap"), /letter-spacing:\s*var\(--track-nav\)/);
  assert.match(
    cssRule(uiCss, ".ss-cap-wrap--head .ss-cap"),
    /letter-spacing:\s*var\(--track-head\)/,
  );
  // 首字母方块里单个字母只大写：字距会把它挤出方块中线
  assert.match(cssRule(uiCss, ".ss-cap-wrap--mark .ss-cap"), /letter-spacing:\s*0;/);
  // 包层自己不变换、不加字距：汉字 run 落在包层里，只继承位置给的字号字重
  assert.throws(() => cssRule(uiCss, ".ss-cap-wrap"));
});

test("全应用的大写变换与正字距只在 Cap 的样式里，没有小写变换；--track-* 只被 Cap 引用", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (dir: URL): URL[] =>
    readdirSync(dir).flatMap((name) => {
      const u = new URL(name, dir.href.endsWith("/") ? dir : new URL(dir.href + "/"));
      return statSync(u).isDirectory() ? walk(new URL(u.href + "/")) : [u];
    });
  const upperRules: string[] = [];
  const trackRules: string[] = [];
  for (const u of walk(new URL("../src/", import.meta.url))) {
    if (!/\.(css|tsx?|html)$/.test(u.pathname)) continue;
    const src = readFileSync(u, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
    assert.doesNotMatch(src, /text-?[Tt]ransform\s*[:=]\s*["']?lower/, u.pathname);
    assert.doesNotMatch(src, /ss-plain/, u.pathname);
    if (!u.pathname.endsWith(".css")) {
      assert.doesNotMatch(src, /uppercase|letterSpacing|--track-/, u.pathname);
      continue;
    }
    if (u.pathname.endsWith("/tokens.css")) continue;
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim();
      if (/uppercase/.test(m[2])) upperRules.push(sel);
      const spacing = m[2].match(/letter-spacing:\s*([^;]+);/);
      if (spacing && !/^(0|0px|normal)$/.test(spacing[1].trim())) trackRules.push(sel);
      else if (/--track-/.test(m[2])) trackRules.push(sel);
    }
  }
  assert.deepEqual(upperRules, [".ss-cap"]);
  assert.deepEqual(trackRules, [
    ".ss-cap",
    ".ss-cap-wrap--nav .ss-cap",
    ".ss-cap-wrap--head .ss-cap",
  ]);
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
  // 首字母经 Cap（mark 档：Condensed 大写、字距 0）
  assert.match(
    html,
    /class="ss-mark__box"[^>]*><span class="ss-cap-wrap ss-cap-wrap--mark"><span class="ss-cap">W<\/span><\/span>/,
  );
  assert.match(html, /class="ss-mark__name">Windsurf</);
  assert.equal(agentInitial("amp"), "A");
});

test("AgentMark inline：agent 名不大写，原样渲染", () => {
  const html = render(AgentMark, { id: "claude-code", name: "Claude Code" });
  assert.match(html, /class="ss-mark ss-mark--inline"/);
  assert.match(html, /class="ss-mark__name">Claude Code</);
});

test("AgentMark header：列头三层——图标 / 名字（label Condensed 12/600，经 Cap 大写）/ 12 tabular 计数，没有灯", () => {
  const html = render(AgentMark, {
    id: "claude-code",
    name: "Claude Code",
    layout: "header",
    count: 41,
  });
  assert.match(html, /class="ss-mark ss-mark--header"/);
  // 列头是 agent 身份：名字经 Cap（`CLAUDE CODE`），数据本身不改
  assert.match(
    html,
    /class="ss-mark__name"><span class="ss-cap-wrap ss-cap-wrap--label"><span class="ss-cap">Claude Code<\/span><\/span></,
  );
  assert.match(html, /class="ss-mark__count">41</);
  assert.doesNotMatch(html, /ss-lamp/);
  const name = cssRule(uiCss, ".ss-mark--header .ss-mark__name");
  assert.match(name, /font-family:\s*var\(--font-cond\)/);
  assert.match(name, /font-size:\s*var\(--size-label\)/);
  assert.match(name, /font-weight:\s*600/);
  assert.doesNotMatch(name, /text-transform/);
  const count = cssRule(uiCss, ".ss-mark__count");
  assert.match(count, /font-family:\s*var\(--font-ui\)/);
  assert.match(count, /color:\s*var\(--ink-faint\)/);
  // 首字母方块：14 方、mark 4 圆角、ctl-border 边、Condensed 11/600
  const box = cssRule(uiCss, ".ss-mark__box");
  assert.match(box, /font-family:\s*var\(--font-cond\)/);
  assert.match(box, /font-size:\s*11px/);
  assert.match(box, /font-weight:\s*600/);
  assert.match(box, /border:\s*1px solid var\(--ctl-border\)/);
  assert.match(box, /border-radius:\s*var\(--radius-mark\)/);
});

test("AgentMark 禁用取色：形状不变，整体退到 ink-mute", () => {
  assert.match(
    render(AgentMark, { id: "cursor", name: "Cursor", dim: true }),
    /class="ss-mark ss-mark--inline is-dim"/,
  );
  assert.match(cssRule(uiCss, ".ss-mark.is-dim"), /color:\s*var\(--ink-mute\)/);
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
  assert.match(html, /添加时会自动创建/);
  assert.doesNotMatch(html, /导入/);
  assert.match(html, /class="ss-btn">添加 skill</);
});

test("Empty 两个动作里只有一个是按钮，另一个降安静键", () => {
  const html = render(Empty, {
    kind: "noSkills",
    description: "通用仓库（~/repos/common-skills）里还没有 skill。",
    hint: "把 skill 目录放进去，或者从别的地方添加一个。",
    primary: { label: "添加 skill", onClick: noop },
    secondary: { label: "打开目录", onClick: noop },
  });
  assert.match(html, /class="ss-empty__hint"/);
  assert.equal(html.match(/class="ss-btn"/g)?.length, 1);
  assert.match(html, /class="ss-btn ss-btn--quiet">打开目录</);
});

test("Empty 空态图像：图在上、装饰（alt 空 + aria-hidden）；首次扫描有图时忙碌指示跟在句子前", () => {
  const folders = render(Empty, {
    kind: "noAgentDirs",
    art: "noDirs",
    primary: { label: "添加 skill", onClick: noop },
  });
  assert.match(folders, /class="ss-empty ss-empty--noAgentDirs has-art"/);
  assert.match(
    folders,
    /<img class="ss-empty__art ss-empty__art--noDirs" src="empty-no-dirs\.png" alt="" aria-hidden="true"\/>/,
  );
  // 顺序：图 → 一句现状 → 动作
  assert.ok(folders.indexOf("ss-empty__art") < folders.indexOf("ss-empty__description"));
  assert.ok(folders.indexOf("ss-empty__description") < folders.indexOf("ss-empty__actions"));

  const scanning = render(Empty, {
    kind: "scanning",
    art: "scanning",
    description: "正在读 3 个位置",
  });
  assert.match(scanning, /src="empty-scanning\.png"/);
  assert.match(scanning, /class="ss-empty__busy"><svg class="ss-spinner" width="14"/);

  // 不给 art 就不放图（筛选无结果）
  assert.doesNotMatch(render(Empty, { kind: "noMatch" }), /<img/);
  assert.match(render(Empty, { kind: "noSkills", art: "emptyFolder" }), /src="empty-folder\.png"/);
  // 小黑猫三张都按显示尺寸原样画（2x 资源），不裁切
  const scanRule = cssRule(uiCss, ".ss-empty__art--scanning");
  assert.match(scanRule, /width:\s*472px/);
  assert.match(scanRule, /height:\s*150px/);
  assert.doesNotMatch(uiCss, /ss-empty__art[^{]*\{[^}]*object-fit/);
  const smallRule = cssRule(uiCss, ".ss-empty__art--emptyFolder");
  assert.match(smallRule, /width:\s*250px/);
  assert.match(smallRule, /height:\s*110px/);
});

test("刚变化的格子闪一下：120ms 反色再回落，减少动效时退化为无", () => {
  assert.match(
    cssRule(uiCss, ".ss-flash"),
    /animation:\s*ss-flash var\(--motion-fast\) var\(--ease-mech\)/,
  );
});

// ===== 内容区的滚动容器（DESIGN「Layout」）=====
//
// 样式断言：吸顶的选择操作条落点全由 App.css 的滚动容器决定，组件层看不见。
// V4 起滚动容器是机面里的 .face__scroll（D1 删顶栏，内容进一块机面）。
// 在 WebKit 里量过：sticky 的落点按滚动容器的**内容盒**算，它上下内边距是多少，
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
  const content = ruleOf(".face__scroll");
  assert.match(content, /overflow:\s*auto/);
  const padding = content.match(/\bpadding:\s*([^;]+);/);
  assert.ok(padding, ".face__scroll 要显式写 padding");
  const sides = padding[1].trim().split(/\s+(?![^(]*\))/);
  assert.equal(sides.length, 3, ".face__scroll 的 padding 写成「上 左右 下」三段，好看出上下是 0");
  assert.equal(sides[0], "0", ".face__scroll 的上内边距必须是 0");
  assert.equal(sides[2], "0", ".face__scroll 的下内边距必须是 0");
  // 贴底待处理窗已取消，它的样式不该回来
  assert.doesNotMatch(appCss, /\.pending-bar\b/);
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
  // 宽 384：776 − 384 = 392；窗口不够宽时贴右留 16（384 + 16 = 400）
  assert.match(end, /left:max\(16px, min\(392px, calc\(100vw - 400px\)\)\)/);
  const start = render(Confirm, {
    title: "删掉 x？",
    confirmLabel: "删掉",
    onCancel: noop,
    anchor,
  });
  assert.match(start, /left:min\(32px, calc\(100vw - 400px\)\)/);
});

test("提示框：墨窗 face 字、control 7 圆角 + 浮层投影；平铺在页面流里的灰面板不浮起、无阴影", () => {
  const tip = cssRule(uiCss, ".ss-tip");
  assert.match(tip, /background:\s*var\(--ink\)/);
  assert.match(tip, /color:\s*var\(--face\)/);
  assert.match(tip, /border-radius:\s*var\(--radius-control\)/);
  assert.match(tip, /box-shadow:\s*var\(--elev-float\)/);
  const banner = cssRule(uiCss, ".ss-banner");
  assert.doesNotMatch(banner, /box-shadow/);
});

test("层次只用 token：src 里凡是 box-shadow 都是凹 / 抬起 / 浮 token（或它们的组合）/ none", async () => {
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
      const allowed =
        /^var\(--(elev-float|recess-(input|tabs|track)|raise(-hover|-pressed|-ink|-ink-pressed)?)\)$/;
      assert.ok(
        m[1].trim() === "none" || m[1].split(",").every((part) => allowed.test(part.trim())),
        `${u.pathname}: box-shadow: ${m[1]}`,
      );
    }
  }
});
