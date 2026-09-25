/// 来源管理页（DESIGN「位置页 › 来源管理页（按下 `管理来源` 时）」，画板 03B）：二级页，列头一次说规则句，
/// 每个来源一行＝来源名 + 数 ｜ 短路径 ｜ 打开 ↗ ｜ 目标框 ｜ 开关 ｜ ×
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { render } from "./ui-render.ts";

const { SourcesPage } = await import("../src/pages/SourcesPage.tsx");

const row = (id: string, name: string, own = false, items = 0) => ({
  id,
  name,
  sub: { where: "", count: "" },
  path: `/Users/me/Library/Application Support/${id}/skills`,
  own,
  items: Array.from({ length: items }, (_, i) => ({ name: `s${i}` })),
  targets: [] as string[],
  switchTitle: "只管以后新出现的，现有的不变",
  ruleRef: id,
  crossDomain: false,
});

const model = (ruleOn = "自动加到", noun = "skill") => ({
  ruleOn,
  noun,
  targetsTitle: "改自动加到的 agent",
  targetUnit: "个 agent",
  noTargetsReason: "这里还没有能加到的 agent",
  targetsLabel: "自动加到的 agent",
  ownRemoveReason: "它的原件就在 CardBox 里，删掉原件才会消失",
  memoryKey: (id: string) => `test:${id}`,
  targetsFor: () => [],
  pickable: () => ["claude"],
});

const domain = { key: "project:/Users/me/code/CardBox", label: "CardBox" };

const stubState = (rows: ReturnType<typeof row>[] | null, m = model()) => ({
  data: rows === null ? null : { rows, groups: [] },
  model: m,
  domain,
  targetsOf: (r: { targets: string[] }) => r.targets,
  rowOf: (id: string) => rows?.find((r) => r.id === id),
  setRule: () => undefined,
  askRemove: async () => undefined,
  removeBusy: null,
  host: null,
  pageHost: null,
  claimHost: () => () => undefined,
  confirming: false,
  say: () => undefined,
});

const page = (state: ReturnType<typeof stubState>, kind: "skills" | "mcp" = "skills") =>
  render(SourcesPage, {
    sources: state as never,
    domain: kind,
    placeName: "CardBox",
    onClose: () => undefined,
    onAdd: () => undefined,
  });

test("页面头：← 返回 + `CardBox 的来源`（MCP：`CardBox 的 MCP 来源`），右端 `+ 来源`；整页 region、名同标题", () => {
  const html = page(stubState([row("u", "通用仓库", false, 26)]));
  assert.match(html, /role="region" aria-label="CardBox 的来源"/);
  assert.match(html, /aria-label="返回"/);
  assert.match(html, /page-head__title[^>]*>CardBox 的来源<\/h1>/);
  assert.match(html, /ss-btn--add[\s\S]*?来源<\/button>/);
  const mcp = page(stubState([row("c", "Claude Code · User")], model("自动写进", "MCP")), "mcp");
  assert.match(mcp, /role="region" aria-label="CardBox 的 MCP 来源"/);
  assert.match(mcp, /role="columnheader">以后新出现的自动写进</);
});

test("列头一行 来源 ｜ 位置 ｜ 以后新出现的自动加到；规则句只在列头说一次，行上不重复", () => {
  const html = page(stubState([row("u", "通用仓库", false, 26), row("w", "WeiboAP", false, 27)]));
  const heads = [...html.matchAll(/role="columnheader">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(heads, ["来源", "位置", "以后新出现的自动加到"]);
  // 看得见的字只在列头一次（开关的读屏名里另带着它，读屏逐行听得到）
  assert.equal(html.match(/>以后新出现的自动加到</g)?.length, 1);
  assert.doesNotMatch(html, /srcrow__label/);
  assert.equal(html.match(/class="srcline"/g)?.length, 2);
});

test("每行：来源名 + skill 数 ｜ 中段省略的短路径 ｜ 浅键 `打开`（↗ 组件画，悬停这一行才出）｜ 目标框 ｜ 紧凑开关 ｜ ×", () => {
  const html = page(stubState([row("w", "WeiboAP", false, 27)]));
  // `打开 ↗` 悬停这一行（或键盘焦点在这一行）才出：静止时键仍在（占着列、各行对齐，Tab 走得到），只是看不见
  assert.match(html, /class="srcline__open" role="cell"/);
  assert.doesNotMatch(html, /srcline__open is-shown/);
  const css = readFileSync(new URL("../src/SourceRow.css", import.meta.url), "utf8");
  // 藏的是这一格（页面不碰键的内部类）
  assert.match(css, /\.srcline__open \{[^}]*opacity: 0;/);
  assert.match(css, /\.srcline__open\.is-shown \{[^}]*opacity: 1;/);
  assert.doesNotMatch(css, /\.ss-[a-z]/);
  const src = readFileSync(new URL("../src/SourceRow.tsx", import.meta.url), "utf8");
  // 与表格来源格同一条规则：鼠标悬停，或键盘焦点（鼠标点过留下的焦点不算）
  assert.match(src, /const openShown = !leaving && \(hovered \|\| keyFocus\);/);
  assert.match(src, /setKeyFocus\(\(e\.target as HTMLElement\)\.matches\(":focus-visible"\)\)/);
  assert.match(html, /srcline__label">WeiboAP<\/span>/);
  assert.match(html, /srcline__count"[^>]*>27<\/span>/);
  // 末两级完整，前段可截（路径用组件库的等宽 Mono：前段 truncate，末两级不截）
  assert.match(
    html,
    /srcrow__path"><span class="ss-mono ss-selectable ss-mono--truncate">[^<]*<\/span><span class="srcrow__tail"><span class="ss-mono ss-selectable">w\/skills<\/span>/,
  );
  assert.match(html, /ss-btn--quiet[^>]*>[\s\S]*?打开[\s\S]*?ss-btn__external/);
  assert.doesNotMatch(html, /打开 ↗|打开↗/);
  assert.match(html, /srcrow__pick">选目标</);
  assert.match(html, /role="switch"/);
  assert.match(html, /从 CardBox 移除 WeiboAP（不动原件）/);
  // 开关旁不点指示点
  assert.doesNotMatch(html, /ss-indicator/);
});

test("规则关着：目标框 `选目标 ▾` 禁用、按下即说「先打开规则」（在那里选目标不会顺带打开规则）；开着时能点", () => {
  const off = page(stubState([row("w", "WeiboAP", false, 27)]));
  assert.match(
    off,
    /<button type="button" class="srcrow__targets is-off" disabled="" aria-label="WeiboAP 改自动加到的 agent"[^>]*>/,
  );
  assert.match(off, /role="tooltip"[^>]*>先打开规则</);
  const on = page(stubState([{ ...row("w", "WeiboAP", false, 27), targets: ["claude"] }]));
  assert.match(on, /<button type="button" class="srcrow__targets" aria-haspopup="menu"/);
  assert.doesNotMatch(on, /先打开规则/);
  const css = readFileSync(new URL("../src/SourceRow.css", import.meta.url), "utf8");
  assert.match(css, /\.srcrow__targets:disabled \{[^}]*border: var\(--border-disabled\);/);
});

test("原件在这个位置的来源：× 禁用并说原因", () => {
  const html = page(stubState([row("own", "CardBox · 通用仓库", true, 3)]));
  assert.match(html, /它的原件就在 CardBox 里，删掉原件才会消失/);
});

test("一个来源都没有：空态「CardBox 还没有来源」+ 猫；`+ 来源` 在页面头，空态不重复；没有列头", () => {
  const html = page(stubState([]));
  assert.match(html, /CardBox 还没有来源/);
  assert.match(html, /empty-folder\.png/);
  assert.doesNotMatch(html, /role="columnheader"/);
  assert.equal(html.match(/ss-btn--add/g)?.length, 1);
  const mcp = page(stubState([], model("自动写进", "MCP")), "mcp");
  assert.match(mcp, /CardBox 还没有 MCP 来源/);
});

test("样式：各行 subgrid 对齐列头；名字至多 160、路径至多 240；行高 40、行间 row-line；列头 hairline", () => {
  const rowCss = readFileSync(new URL("../src/SourceRow.css", import.meta.url), "utf8");
  const pageCss = readFileSync(new URL("../src/pages/SourcesPage.css", import.meta.url), "utf8");
  assert.match(
    rowCss,
    /\.srcline \{[^}]*grid-template-columns: subgrid;[^}]*height: 40px;[^}]*border-bottom: var\(--border-row\);/,
  );
  assert.match(rowCss, /\.srcline__fit--name \{[^}]*max-width: 160px;/);
  assert.match(rowCss, /\.srcline__fit--where \{[^}]*max-width: 240px;/);
  assert.match(pageCss, /\.srcpage__head \{[^}]*border-bottom: var\(--border-structure\);/);
  // 目标浮层是组件库的多选菜单：页面不再写一套浮层项，也不覆盖组件的内部类
  assert.doesNotMatch(rowCss, /\.srcrow-target/);
  assert.doesNotMatch(rowCss, /\.ss-[a-z]/);
  const rowTsx = readFileSync(new URL("../src/SourceRow.tsx", import.meta.url), "utf8");
  assert.match(rowTsx, /<Menu maxWidth=\{280\}>/);
  assert.match(rowTsx, /<MenuItem[^>]*kind="check"/);
});
