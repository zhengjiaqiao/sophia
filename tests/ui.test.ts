/// 展示组件的渲染断言：每个组件的每个状态一条。
/// 渲染方式见 ui-render.ts（node:test + typescript 转 JSX + react-dom/server）。
import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";

const noop = () => {};

const { StateDot } = await import("../src/ui/StateDot.tsx");
const { Button } = await import("../src/ui/Button.tsx");
const { Chip } = await import("../src/ui/Chip.tsx");
const { Toast, TOAST_DWELL_MS } = await import("../src/ui/Toast.tsx");
const { ErrorBanner } = await import("../src/ui/ErrorBanner.tsx");
const { Confirm } = await import("../src/ui/Confirm.tsx");
const { SubPage } = await import("../src/ui/SubPage.tsx");
const { RowNotice } = await import("../src/ui/RowNotice.tsx");
const { AgentIcon, AgentMark, agentInitial, hasAgentIcon } =
  await import("../src/ui/AgentMark.tsx");
const { Busy, Empty } = await import("../src/ui/Empty.tsx");

test("index 把组件和样式一起交出去，用的人不必自己 import css", async () => {
  const ui = await import("../src/ui/index.ts");
  const exported = [
    "StateDot",
    "Button",
    "Chip",
    "Toast",
    "ErrorBanner",
    "Confirm",
    "SubPage",
    "RowNotice",
    "AgentMark",
    "AgentIcon",
    "Empty",
    "Busy",
  ];
  for (const name of exported) {
    assert.equal(typeof (ui as Record<string, unknown>)[name], "function", name);
  }
});

// ===== §2 状态点 =====

test("StateDot linked：9px 实心，点一下关闭这条链接", () => {
  const html = render(StateDot, { dot: "linked", onClick: noop, title: "关掉这条链接" });
  assert.match(html, /class="ss-dot ss-dot--linked"/);
  assert.match(html, /<button type="button" class="ss-dot-btn"/);
  assert.match(html, /title="关掉这条链接"/);
});

test("StateDot missing：9px 空心", () => {
  const html = render(StateDot, { dot: "missing", onClick: noop });
  assert.match(html, /class="ss-dot ss-dot--missing"/);
});

test("StateDot own：本体环，关不掉所以不渲染成按钮", () => {
  const html = render(StateDot, { dot: "own", title: "本体就在这儿，不是链接" });
  assert.match(html, /class="ss-dot ss-dot--own"/);
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /title="本体就在这儿，不是链接"/);
});

test("StateDot 无格态：短横，不可点，title 说明这个 agent 不在当前域", () => {
  const html = render(StateDot, { dot: "none", title: "这个 agent 不在当前域" });
  assert.match(html, /class="ss-dot ss-dot--none"/);
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /title="这个 agent 不在当前域"/);
});

test("StateDot 选中行反色：三种形都带 is-inverse", () => {
  for (const dot of ["linked", "missing", "own"] as const) {
    const html = render(StateDot, { dot, inverse: true });
    assert.match(html, new RegExp(`class="ss-dot ss-dot--${dot} is-inverse"`));
  }
});

// ===== §3 按钮 =====

test("Button 默认 · 常规：ghost pill，可点", () => {
  const html = render(Button, { children: "导入 skill", onClick: noop });
  assert.match(html, /class="ss-btn"/);
  assert.match(html, /导入 skill/);
  assert.doesNotMatch(html, /disabled/);
});

test("Button 默认 · 紧凑", () => {
  const html = render(Button, { children: "清除", size: "compact", onClick: noop });
  assert.match(html, /class="ss-btn ss-btn--compact"/);
});

test("Button 禁用 · 常规：必须同时给 title 说明原因，不可只置灰", () => {
  const html = render(Button, {
    children: "删到废纸篓",
    disabled: true,
    disabledReason: "本体在 git 仓库里，请在仓库里删掉并提交",
  });
  assert.match(html, /disabled=""/);
  assert.match(html, /title="本体在 git 仓库里，请在仓库里删掉并提交"/);
});

test("Button 禁用 · 紧凑：同样带 title", () => {
  const html = render(Button, {
    children: "再试一次",
    size: "compact",
    disabled: true,
    disabledReason: "这个 agent 的 skills 目录只读",
  });
  assert.match(html, /class="ss-btn ss-btn--compact"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /title="这个 agent 的 skills 目录只读"/);
});

test("Button 破坏性 · 常规：边框同默认，不涂红", () => {
  const html = render(Button, { children: "删到废纸篓", variant: "destructive", onClick: noop });
  assert.match(html, /class="ss-btn ss-btn--destructive"/);
});

test("Button 破坏性 · 紧凑", () => {
  const html = render(Button, {
    children: "删通用仓库的",
    variant: "destructive",
    size: "compact",
    onClick: noop,
  });
  assert.match(html, /class="ss-btn ss-btn--compact ss-btn--destructive"/);
});

test("Button 文字链 · 常规：无边框、次要文字加下划线", () => {
  const html = render(Button, { children: "取消", variant: "link", onClick: noop });
  assert.match(html, /class="ss-btn ss-btn--link"/);
});

test("Button 文字链 · 紧凑", () => {
  const html = render(Button, {
    children: "稍后",
    variant: "link",
    size: "compact",
    onClick: noop,
  });
  assert.match(html, /class="ss-btn ss-btn--compact ss-btn--link"/);
});

// ===== §3.0 选择片 =====

test("Chip 未选中：描边 pill，agent 名原样不大写", () => {
  const html = render(Chip, { children: "Claude Code", onClick: noop });
  assert.match(html, /class="ss-chip"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /Claude Code/);
});

test("Chip 选中：反色，不是填充色", () => {
  const html = render(Chip, { children: "Codex", selected: true, onClick: noop });
  assert.match(html, /class="ss-chip is-selected"/);
  assert.match(html, /aria-pressed="true"/);
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

test("Chip 带 16px 图标", () => {
  const html = render(Chip, {
    children: "Gemini CLI",
    icon: AgentIcon({ id: "gemini-cli", name: "Gemini CLI" }),
    onClick: noop,
  });
  assert.match(html, /class="ss-chip__icon"/);
  assert.match(html, /<svg/);
});

// ===== 选择操作条：每片＝「已选的 skill × 这个 agent」（AC23）=====
// SkillsTab 里的聚合算法进不来（src/ 用的是无扩展名 import，node:test 的解析器认不了），
// 这三条钉的是三种片态各自该长什么样、说什么话

test("选择片 全开着：反色，点一下把这些链接全关掉", () => {
  const html = render(Chip, {
    children: "Claude Code",
    icon: AgentIcon({ id: "claude-code", name: "Claude Code" }),
    selected: true,
    title: "关掉选中的 skill 在 Claude Code 下的链接",
    onClick: noop,
  });
  assert.match(html, /class="ss-chip is-selected"/);
  assert.match(html, /class="ss-chip__icon"/);
  assert.match(html, /title="关掉选中的 skill 在 Claude Code 下的链接"/);
});

test("选择片 有没开的：hairline 描边，片上写「开启 N」", () => {
  const html = render(Chip, {
    children: "Codex 开启 2",
    icon: AgentIcon({ id: "codex", name: "Codex" }),
    title: "在 Codex 下开启还没开的那几个",
    onClick: noop,
  });
  assert.match(html, /class="ss-chip"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /开启 2/);
});

test("选择片 整目录链走：灰描边不可选，并说清为什么", () => {
  const html = render(Chip, {
    children: "Cursor",
    icon: AgentIcon({ id: "cursor", name: "Cursor" }),
    disabled: true,
    disabledReason: "Cursor 的 skills 目录整个链到了别处，要逐条开关得先拆开",
  });
  assert.match(html, /disabled=""/);
  assert.match(html, /要逐条开关得先拆开/);
  assert.doesNotMatch(html, /is-selected/);
});

// ===== §4.1 提示条 =====

test("Toast 成功：一句话 + 副行等宽统计 + 撤销，停 6 秒", () => {
  const html = render(Toast, {
    kind: "success",
    message: "Cline 下还没有 skills 目录，已经建出来，并把 defuddle 链了进去。",
    stats: "新建了 1 个目录 · 1 条链接",
    action: { label: "撤销", onClick: noop },
  });
  assert.match(html, /data-kind="success"/);
  assert.match(html, /class="ss-toast__stats">新建了 1 个目录 · 1 条链接</);
  assert.match(html, /撤销/);
  assert.equal(TOAST_DWELL_MS.success, 6000);
});

test("Toast 成功·多项：汇总成一句，不带副行统计", () => {
  const html = render(Toast, {
    kind: "success",
    message: "在 3 个 agent 下开启了 obsidian-cli。",
    action: { label: "撤销", onClick: noop },
  });
  assert.doesNotMatch(html, /ss-toast__stats/);
  assert.match(html, /撤销/);
});

test("Toast 做不成：说原因，不给撤销，停 8 秒", () => {
  const html = render(Toast, {
    kind: "cannot",
    message: "Codex 下已经有同名的 defuddle，没有覆盖它。",
  });
  assert.match(html, /data-kind="cannot"/);
  assert.doesNotMatch(html, /ss-toast__foot/);
  assert.equal(TOAST_DWELL_MS.cannot, 8000);
});

test("Toast 部分失败：带「查看」跳待处理栏，停 8 秒", () => {
  const html = render(Toast, {
    kind: "partial",
    message: "开启了 2 个，1 个没成——Cline 的目录只读。",
    action: { label: "查看", onClick: noop },
  });
  assert.match(html, /data-kind="partial"/);
  assert.match(html, /查看/);
  assert.equal(TOAST_DWELL_MS.partial, 8000);
});

test("Toast 关闭：busy 期间也要能关，所以它是独立的动作", () => {
  const html = render(Toast, { kind: "success", message: "正在开启…", onClose: noop });
  assert.match(html, /关闭/);
});

// ===== §4.2 错误横幅 =====

test("ErrorBanner：反色通栏 + 关闭，不自动消失", () => {
  const html = render(ErrorBanner, {
    message: "读不到 ~/.claude/settings.json：权限不足",
    onClose: noop,
  });
  assert.match(html, /class="ss-banner"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /class="ss-btn ss-btn--link is-inverse"/);
  assert.match(html, /关闭/);
});

// ===== §5 确认弹窗 =====

test("Confirm：标题 + 正文 + 条件性警告段 + 取消/主动作", () => {
  const html = render(Confirm, {
    title: "删掉 defuddle 在 WeiboAP 下的本体",
    body: "这不是关掉一条链接，是把下面这个目录本身移走。",
    warning: "2 条链接会因此失效，删完改指向通用仓库的那个",
    confirmLabel: "删到废纸篓",
    destructive: true,
    onConfirm: noop,
    onCancel: noop,
  });
  assert.match(html, /class="ss-confirm__title">删掉 defuddle 在 WeiboAP 下的本体</);
  assert.match(html, /class="ss-confirm__body"/);
  assert.match(html, /class="ss-confirm__warning"/);
  assert.match(html, /class="ss-btn ss-btn--link">取消</);
  assert.match(html, /class="ss-btn ss-btn--destructive">删到废纸篓</);
});

test("Confirm：警告段没有就不出现", () => {
  const html = render(Confirm, {
    title: "开启自动同步",
    body: "通用仓库 → Claude Code · Codex，会立刻建 12 条链接。",
    confirmLabel: "开启",
    onConfirm: noop,
    onCancel: noop,
  });
  assert.doesNotMatch(html, /ss-confirm__warning/);
});

test("Confirm：主动作禁用时带上原因，取消文案可换", () => {
  const html = render(Confirm, {
    title: "这个 defuddle 在 git 仓库里，不代删",
    confirmLabel: "删到废纸篓",
    confirmDisabledReason: "本体在 git 仓库里，请在仓库里删掉并提交",
    cancelLabel: "知道了",
    onCancel: noop,
  });
  assert.match(html, /disabled=""/);
  assert.match(html, /title="本体在 git 仓库里，请在仓库里删掉并提交"/);
  assert.match(html, /知道了/);
});

test("Confirm：背景铺满一层，点它等同取消（Esc 同）", () => {
  const html = render(Confirm, { title: "开启自动同步", confirmLabel: "开启", onCancel: noop });
  assert.match(html, /class="ss-confirm-layer"/);
  assert.match(html, /class="ss-confirm-veil"/);
  assert.match(html, /role="dialog" aria-modal="true"/);
});

// ===== §4.6 二级页面 =====

test("SubPage：← + 页面名 + 内容，占满整窗", () => {
  const html = render(SubPage, {
    title: "导入 skill",
    onBack: noop,
    children: "内容",
  });
  assert.match(html, /class="ss-subpage"/);
  assert.match(html, /aria-label="返回"/);
  assert.match(html, /<svg width="24" height="24"/);
  assert.match(html, /class="ss-subpage__title">导入 skill</);
  assert.match(html, /class="ss-subpage__body">内容</);
});

test("SubPage：顶栏右侧可以挂一句副标题", () => {
  const html = render(SubPage, {
    title: "设置",
    onBack: noop,
    aside: "让这些 skill 出现在「全局」的列表里",
    children: "内容",
  });
  assert.match(html, /class="ss-subpage__aside"/);
});

// ===== §4.4 行内待办条 =====

test("RowNotice：一句话 + 紧凑 pill + 稍后", () => {
  const html = render(RowNotice, {
    message: "Codex 升到 0.43.0 之后，模型列表要重新生成一次才对得上。",
    actions: [{ label: "重新生成", onClick: noop }],
    onLater: noop,
  });
  assert.match(html, /class="ss-rownotice"/);
  assert.match(html, /class="ss-btn ss-btn--compact">重新生成</);
  assert.match(html, /class="ss-btn ss-btn--link">稍后</);
});

test("RowNotice：动作做不了时置灰并给原因", () => {
  const html = render(RowNotice, {
    message: "这条链接指向一个不存在的地方。",
    actions: [{ label: "清除", onClick: noop, disabledReason: "这个 agent 的目录只读" }],
    onLater: noop,
  });
  assert.match(html, /disabled=""/);
  assert.match(html, /title="这个 agent 的目录只读"/);
});

// ===== §9 / §9.1 agent 图标与 agent 灯 =====

test("AgentMark：四个画得出的用真图标，单色 currentColor", () => {
  for (const id of ["claude-code", "codex", "cursor", "gemini-cli"]) {
    assert.equal(hasAgentIcon(id), true, id);
    const html = render(AgentMark, { id, name: id });
    assert.match(html, /<svg/, id);
    assert.match(html, /currentColor/, id);
    assert.doesNotMatch(html, /ss-mark__box/, id);
  }
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
  assert.match(html, /Claude Code/);
});

/// AC22：列头＝图标 + 名字，**没有灯**。那盏 6px 的灯用户看不懂，已经撤掉
test("AgentMark stacked：矩阵列头只有图标和名字，没有灯", () => {
  const html = render(AgentMark, {
    id: "claude-code",
    name: "Claude Code",
    layout: "stacked",
  });
  assert.match(html, /class="ss-mark ss-mark--stacked"/);
  assert.match(html, /class="ss-mark__name">Claude Code</);
  assert.doesNotMatch(html, /ss-lamp/);
});

test("AgentMark 禁用取色：形状不变，整体退到弱文字色", () => {
  const html = render(AgentMark, { id: "cursor", name: "Cursor", dim: true });
  assert.match(html, /class="ss-mark ss-mark--inline is-dim"/);
});

/// skill 矩阵的列头已经不放灯了（AC22），这一套现在只剩 MCP 页在用；
/// MCP 页收口时这个组件连同断言一起删

// ===== §6 空态与忙碌态 =====

test("Empty 首次扫描中：一行次要文字，不上 spinner", () => {
  const html = render(Empty, { kind: "scanning" });
  assert.match(html, /class="ss-empty ss-empty--scanning"/);
  assert.match(html, /扫描中…/);
  assert.doesNotMatch(html, /ss-empty__actions/);
});

test("Empty 这个域没有 agent 目录：说明 + 一个 pill", () => {
  const html = render(Empty, {
    kind: "noAgentDirs",
    primary: { label: "导入 skill", onClick: noop },
  });
  assert.match(html, /data-kind="noAgentDirs"/);
  assert.match(html, /导入时会顺手建出来/);
  assert.match(html, /class="ss-btn">导入 skill</);
});

test("Empty 筛选无结果：没有匹配的 skill + 清除筛选文字链", () => {
  const html = render(Empty, {
    kind: "noMatch",
    secondary: { label: "清除筛选", onClick: noop },
  });
  assert.match(html, /没有匹配的 skill/);
  assert.match(html, /class="ss-btn ss-btn--link">清除筛选</);
});

test("Empty 一个 skill 都没有：两个动作里只有一个是 pill", () => {
  const html = render(Empty, {
    kind: "noSkills",
    description: "通用仓库（~/repos/common-skills）里还没有 skill。",
    hint: "把 skill 目录放进去，或者从别的地方导入一个。",
    primary: { label: "导入 skill", onClick: noop },
    secondary: { label: "打开目录", onClick: noop },
  });
  assert.match(html, /~\/repos\/common-skills/);
  assert.match(html, /class="ss-empty__hint"/);
  assert.equal(html.match(/class="ss-btn"/g)?.length, 1);
  assert.match(html, /class="ss-btn ss-btn--link">打开目录</);
});

test("Busy 操作进行中：受影响的部分置灰，不忙时不加类", () => {
  assert.match(render(Busy, { busy: true, children: "表格" }), /class="ss-busy" aria-busy="true"/);
  const idle = render(Busy, { busy: false, children: "表格" });
  assert.doesNotMatch(idle, /ss-busy/);
  assert.doesNotMatch(idle, /aria-busy/);
});

test("Button inverse：反色表示「现在开着」，模型页与托盘共用一份", async () => {
  const { Button } = await import("../src/ui/Button.tsx");
  const html = render(Button, { variant: "inverse", children: "已启用", onClick: () => {} });
  assert.match(html, /ss-btn--inverse/);
});
