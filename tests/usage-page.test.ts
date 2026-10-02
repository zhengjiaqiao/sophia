import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MENU_BAR_AGENTS,
  agentChoices,
  menuBarAgents,
  primaryOptions,
  secondaryOptions,
  choosePrimary,
  setAgentDisplay,
  toggleMenuBarAgent,
} from "../src/usage/usageView.ts";
import type { UsageView, UsageWindow } from "../src/types.ts";

/// 用量页（spec 2026-09-26-menubar-usage R11 R12）的纯逻辑

const win = (key: string, label: string): UsageWindow => ({
  key,
  label,
  usedPercent: 10,
  resetsAt: null,
  windowMinutes: null,
  severity: "normal",
  active: false,
});

const view = (overrides: Partial<UsageView> = {}): UsageView => ({
  state: {
    agents: [
      {
        agent: "claude-code",
        status: { kind: "ok" },
        reading: {
          agent: "claude-code",
          source: "getUsage",
          observedAt: 0,
          windows: [
            win("session", "5 小时"),
            win("weekly", "本周"),
            win("model:Fable", "本周 · Fable"),
          ],
          plan: "max",
        },
        attemptedAt: 0,
      },
      { agent: "codex", status: { kind: "ok" }, reading: null, attemptedAt: null },
    ],
  },
  settings: {
    menuBarEnabled: true,
    displayMode: "remaining",
    agents: null,
    perAgent: {},
    refresh: "auto",
  },
  signedIn: ["claude-code", "codex"],
  tray: [],
  menuBar: { segments: [] },
  ...overrides,
});

test("R12 显示哪些 agent：没配过取已登录的（注册表顺序，最多 3 个）；配过就用配的", () => {
  assert.deepEqual(menuBarAgents(view()), ["claude-code", "codex"]);
  assert.deepEqual(menuBarAgents(view({ settings: { ...view().settings, agents: ["codex"] } })), [
    "codex",
  ]);
  assert.equal(MAX_MENU_BAR_AGENTS, 3);
});

test("R11 选 agent 的片：已登录的与配过的都列出；点了切换，按注册表顺序存", () => {
  const v = view({ settings: { ...view().settings, agents: ["codex"] } });
  assert.deepEqual(
    agentChoices(v).map((c) => [c.id, c.name, c.selected, c.disabledReason]),
    [
      ["claude-code", "Claude", false, null],
      ["codex", "Codex", true, null],
    ],
  );
  assert.deepEqual(toggleMenuBarAgent(v.settings, v.signedIn, "claude-code").agents, [
    "claude-code",
    "codex",
  ]);
  assert.deepEqual(toggleMenuBarAgent(v.settings, v.signedIn, "codex").agents, []);
  // 没配过时第一次点：从默认名单（已登录的）起算，而不是从空起算
  assert.deepEqual(toggleMenuBarAgent(view().settings, view().signedIn, "codex").agents, [
    "claude-code",
  ]);
});

test("R11 选满 3 个后，其余的点不了并写明原因", () => {
  const full = agentChoices(view(), 1);
  assert.deepEqual(
    full.map((c) => [c.id, c.selected, c.disabledReason]),
    [
      ["claude-code", true, null],
      ["codex", true, null],
    ],
  );
  const one = view({ settings: { ...view().settings, agents: ["claude-code"] } });
  assert.deepEqual(
    agentChoices(one, 1).map((c) => c.disabledReason),
    [null, "最多显示 1 个，先取消一个"],
  );
});

test("R11 窗口选项按这个 agent 实际拿到的窗口生成：主窗口「自动」在前，第二窗口「无」在前", () => {
  assert.deepEqual(
    primaryOptions(view(), "claude-code").map((o) => [o.id, o.label]),
    [
      ["auto", "自动"],
      ["session", "5 小时"],
      ["weekly", "本周"],
      ["model:Fable", "本周 · Fable"],
    ],
  );
  assert.deepEqual(
    secondaryOptions(view(), "claude-code").map((o) => o.id),
    ["none", "session", "weekly", "model:Fable"],
  );
  // 还没有读数：只有自动 / 无；配过但此刻拿不到的窗口也保留，免得选中项凭空消失
  const codex = view({
    settings: {
      ...view().settings,
      perAgent: {
        codex: { primary: "weekly", secondary: null, stacked: false, stackedSize: "small" },
      },
    },
  });
  assert.deepEqual(
    primaryOptions(codex, "codex").map((o) => [o.id, o.label]),
    [
      ["auto", "自动"],
      ["weekly", "weekly"],
    ],
  );
  assert.deepEqual(
    secondaryOptions(codex, "codex").map((o) => o.id),
    ["none"],
  );
});

test("第二窗口的选项里不列主窗口；主窗口改成和第二窗口同一个时，第二窗口清成「无」", () => {
  const v = view({
    settings: {
      ...view().settings,
      perAgent: {
        "claude-code": {
          primary: "session",
          secondary: "weekly",
          stacked: true,
          stackedSize: "small",
        },
      },
    },
  });
  assert.deepEqual(
    secondaryOptions(v, "claude-code").map((o) => o.id),
    ["none", "weekly", "model:Fable"],
  );
  const next = choosePrimary(v.settings, "claude-code", "weekly");
  assert.equal(next.perAgent["claude-code"]?.primary, "weekly");
  assert.equal(next.perAgent["claude-code"]?.secondary, null);
  assert.equal(
    choosePrimary(v.settings, "claude-code", null).perAgent["claude-code"]?.secondary,
    "weekly",
  );
});

test("R12 改一个 agent 的显示：没配过的从默认值起，别的 agent 不动", () => {
  const next = setAgentDisplay(view().settings, "codex", { secondary: "weekly" });
  assert.deepEqual(next.perAgent.codex, {
    primary: null,
    secondary: "weekly",
    stacked: false,
    stackedSize: "small",
  });
  assert.equal(next.perAgent["claude-code"], undefined);
});

// ===== 渲染（线框 5A） =====

const { render } = await import("./ui-render.ts");
const { UsageBody, MenuBarPreview } = await import("../src/usage/UsagePage.tsx");

test("5A 总开关关着：节头下写「菜单栏没显示用量」，节里的预览、数字、刷新调淡、点不了（inert）；下面各组照常", () => {
  const off = view({ settings: { ...view().settings, menuBarEnabled: false } });
  const html = render(UsageBody, { view: off, onChange: () => undefined });
  assert.match(html, /ss-section__title">菜单栏显示用量</);
  assert.match(html, /usage-page__off">菜单栏没显示用量</);
  assert.match(html, /class="usage-page__menubar is-off" inert=""[^]*?>数字<[^]*?>刷新</);
  assert.equal(html.match(/inert=""/g)?.length, 1, "只有菜单栏那一节");
  const on = render(UsageBody, { view: view(), onChange: () => undefined });
  assert.doesNotMatch(on, /菜单栏没显示用量|inert/);
});

test("5A 菜单栏一节：预览 +「这就是菜单栏上会显示的样子」；数字（剩余 ｜ 已用）、刷新都是紧凑滑槽，下面各一行说明", () => {
  const html = render(UsageBody, { view: view(), onChange: () => undefined });
  assert.match(html, /usage-preview[^]*这就是菜单栏上会显示的样子/);
  assert.match(html, /usage-page__label">数字<[^]*?ss-tabs ss-tabs--compact[^]*>剩余<[^]*>已用</);
  assert.match(html, /用尽时菜单栏自动改显示倒计时/);
  assert.match(
    html,
    /usage-page__label">刷新<[^]*?ss-tabs ss-tabs--compact[^]*>自动<[^]*>关<[^]*>1 分钟<[^]*>15 分钟</,
  );
  assert.match(html, /手动档最快一分钟一次/);
});

test("5A 显示哪些 agent：区块小标下一排选择片（agent 标志 + 名字），下一行「最多 3 个」", () => {
  const html = render(UsageBody, { view: view(), onChange: () => undefined });
  assert.match(html, /ss-sectionlabel[^"]*"><span class="ss-sectionlabel__text">显示哪些 agent</);
  assert.match(
    html,
    /ss-chip is-selected"[^]*?ss-mark[^]*?Claude[^]*?ss-chip is-selected"[^]*?ss-mark[^]*?Codex/,
  );
  assert.match(html, /usage-page__hint">最多 3 个</);
});

test("5A 每个选中的 agent 一栏、左右并排：小标（标志 + 名字）下主窗口、第二窗口（紧凑滑槽，窗口名原样不转大写）", () => {
  const html = render(UsageBody, { view: view(), onChange: () => undefined });
  assert.match(
    html,
    /class="usage-page__agents"><div class="usage-page__agent-col" aria-label="Claude">[^]*<div class="usage-page__agent-col" aria-label="Codex">/,
  );
  const claude = html.slice(
    html.indexOf('aria-label="Claude"'),
    html.indexOf('aria-label="Codex"'),
  );
  assert.match(claude, /ss-mark[^]*Claude/);
  assert.match(
    claude,
    /usage-page__label">主窗口<[^]*?ss-tabs ss-tabs--compact[^]*>自动<[^]*>5 小时<[^]*>本周<[^]*>本周 · Fable</,
  );
  assert.doesNotMatch(claude, /FABLE|ss-cap">Fable/);
  assert.match(claude, /usage-page__label">第二窗口<[^]*?>无</);
  // Codex 只有一个窗口（这里还没有读数）：不出「第二窗口」一行
  const codex = html.slice(html.indexOf('aria-label="Codex"'));
  assert.doesNotMatch(codex, /第二窗口/);
});

test("叠放跟着每个 agent 走：选了第二窗口才出「两行叠放」，打开叠放才出「字号」；菜单栏一节里没有叠放", () => {
  const html = render(UsageBody, { view: view(), onChange: () => undefined });
  assert.doesNotMatch(html.slice(0, html.indexOf("显示哪些 agent")), /两行叠放|字号/);
  const claude = (h: string) =>
    h.slice(h.indexOf('aria-label="Claude"'), h.indexOf('aria-label="Codex"'));
  assert.doesNotMatch(claude(html), /两行叠放/, "第二窗口是「无」时不出叠放");
  const withSecond = view({
    settings: {
      ...view().settings,
      perAgent: {
        "claude-code": {
          primary: "session",
          secondary: "weekly",
          stacked: false,
          stackedSize: "small",
        },
      },
    },
  });
  const a = claude(render(UsageBody, { view: withSecond, onChange: () => undefined }));
  assert.match(a, /usage-page__label">两行叠放<[^]*两个窗口上下两行，占的宽度减半/);
  assert.doesNotMatch(a, /usage-page__label">字号</);
  const stacked = view({
    settings: {
      ...view().settings,
      perAgent: {
        "claude-code": {
          primary: "session",
          secondary: "weekly",
          stacked: true,
          stackedSize: "medium",
        },
      },
    },
  });
  assert.match(
    claude(render(UsageBody, { view: stacked, onChange: () => undefined })),
    /usage-page__label">字号<[^]*>小<[^]*>中<[^]*>大</,
  );
});

test("页面最上方「当前用量」：每个已登录的 agent 一栏（标志 + 名字，右边「N 分钟前更新」），一个窗口一行，与托盘同一种画法；在菜单栏配置之上", () => {
  const withTray = view({
    tray: [
      {
        agent: "claude-code",
        updatedText: "3 分钟前更新",
        windows: [
          {
            label: "5 小时",
            percentText: "剩 93%",
            gaugePercent: 93,
            emphasize: false,
            resetText: "2:58 后重置",
          },
        ],
        note: null,
      },
      {
        agent: "codex",
        updatedText: null,
        windows: [],
        note: "还没有读数",
      },
    ],
  });
  const html = render(UsageBody, { view: withTray, onChange: () => undefined });
  assert.ok(html.indexOf("当前用量") < html.indexOf("菜单栏显示用量"), "当前用量在最上面");
  const now = html.slice(html.indexOf("当前用量"), html.indexOf("菜单栏显示用量"));
  assert.match(
    now,
    /usage-page__now-col" aria-label="Claude 的用量">[^]*?ss-mark[^]*?Claude<[^]*?usage-page__updated">3 分钟前更新<[^]*?class="usage-win">[^]*?>5 小时<[^]*?width:93%[^]*?>剩 93%<[^]*?>2:58 后重置</,
  );
  assert.match(now, /aria-label="Codex 的用量">[^]*?usage-note">还没有读数</);
  // 一个都没登录：说一句，不画空栏
  const none = render(UsageBody, {
    view: view({ signedIn: [], tray: [] }),
    onChange: () => undefined,
  });
  assert.match(
    none.slice(0, none.indexOf("菜单栏显示用量")),
    /还没有检测到登录了的 Claude Code 或 Codex/,
  );
});

test("R9 预览与菜单栏同一份文字：两行叠放上下两行、按档位取字号，过期的那段变淡", () => {
  const html = render(MenuBarPreview, {
    menuBar: {
      segments: [
        { agent: "claude-code", lines: ["95%", "98%"], stale: true, stackedSize: "small" },
        { agent: "codex", lines: ["72%"], stale: false, stackedSize: "small" },
      ],
    },
  });
  assert.match(
    html,
    /usage-preview__seg is-stale"[^]*is-stacked is-small"><span>95%<\/span><span>98%<\/span>/,
  );
  assert.match(html, /class="usage-preview__seg"[^]*usage-preview__nums"><span>72%<\/span>/);
  assert.doesNotMatch(html, /title=/, "没有悬停提示（点一下就出面板）");
});

test("第三批 3A：数字、刷新、字号这几组设置分段是内容、原样显示（plain）——English 不被 Cap 整段转大写；简体只少一层没有样式的包裹", async () => {
  const { readFileSync } = await import("node:fs");
  const { setLocale } = await import("../src/i18n.ts");
  const { capRuns } = await import("../src/ui/Cap.tsx");
  const stacked = view({
    settings: {
      ...view().settings,
      perAgent: {
        "claude-code": {
          primary: "session",
          secondary: "weekly",
          stacked: true,
          stackedSize: "medium",
        },
      },
    },
  });
  const tabs = (html: string) =>
    [...html.matchAll(/<nav class="ss-tabs[^]*?<\/nav>/g)].map((m) => m[0]);
  // 简体：各组页签里没有 Cap（整页的页签都是 plain）
  const zh = render(UsageBody, { view: stacked, onChange: () => undefined });
  const zhTabs = tabs(zh);
  assert.ok(zhTabs.length >= 5, "数字、刷新，每个 agent 的主窗口、第二窗口、字号");
  for (const nav of zhTabs) assert.doesNotMatch(nav, /ss-cap/);
  assert.match(zhTabs[0], /aria-current="page">剩余<\/button>/);
  // 简体为什么逐像素不变：这几组的简体标签里没有拉丁字母，经 Cap 时只多一层 `ss-cap-wrap`，
  // 没有 `ss-cap` run；而 `ss-cap-wrap` 本身没有任何样式（样式只挂在它里面的 `.ss-cap` 上）
  for (const label of [
    "剩余",
    "已用",
    "自动",
    "关",
    "1 分钟",
    "5 分钟",
    "10 分钟",
    "15 分钟",
    "小",
    "中",
    "大",
  ])
    assert.ok(
      capRuns(label).every(([, latin]) => !latin),
      label,
    );
  const css = readFileSync(new URL("../src/ui/ui.css", import.meta.url), "utf8");
  for (const m of css.matchAll(/([^{}]*)\{/g))
    for (const sel of m[1].split(","))
      if (/ss-cap-wrap/.test(sel)) assert.match(sel.trim(), /\.ss-cap-wrap--\w+ \.ss-cap$/, sel);
  // English：原样大小写
  setLocale("en");
  try {
    const enTabs = tabs(render(UsageBody, { view: stacked, onChange: () => undefined }));
    assert.match(enTabs[0], />Remaining<\/button>/);
    assert.ok(enTabs.some((nav) => />Small<\/button>[^]*>Medium<\/button>/.test(nav)));
    for (const nav of enTabs) assert.doesNotMatch(nav, /ss-cap/);
  } finally {
    setLocale("zh-Hans");
  }
});
