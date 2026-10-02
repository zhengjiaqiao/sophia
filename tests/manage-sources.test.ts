/// 来源管理页（DESIGN「位置页 › 来源管理页（按下 `管理来源` 时）」；2026-09-30 起位置在页里选）：二级页，
/// 页面头下一行位置胶囊，列头一次说规则句；每个来源一行＝位置 ｜ 来源（悬停出 `打开 ↗`）｜ 数 ｜ 开关 ｜ 目标框 ｜ ×
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { render } from "./ui-render.ts";

const { SourcesPage, sourcesPageText } = await import("../src/pages/SourcesPage.tsx");
const { SourceLine } = await import("../src/SourceRow.tsx");

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

const model = (noun: "skill" | "MCP" = "skill") => ({
  noun,
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

/// 一个来源一行（页面里每个位置各读各的，这里直接画行）
const page = (state: ReturnType<typeof stubState>, place = "CardBox") =>
  (state.data?.rows ?? [])
    .map((r) =>
      render(SourceLine, {
        state: state as never,
        row: r as never,
        place,
        onReveal: () => undefined,
      }),
    )
    .join("");

const places = { recent: [], sorted: [], sort: "active" as const, onSort: () => undefined };
const fullModel = (title: string, noun: "skill" | "MCP" = "skill") => ({
  ...model(noun),
  title,
  emptyText: `${title.replace(/的( MCP)? 来源$|的来源$/, "")}还没有来源`,
  load: async () => ({ rows: [], groups: [] }),
});
/// 整页（服务端渲染不跑 effect：各位置还没读回来，只看页面头、胶囊、列头）
const fullPage = (kind: "skills" | "mcp", initial: string) =>
  render(SourcesPage, {
    // MCP 的自动同步页不给 `+`（spec 2026-09-30-mcp-config-scope R5）
    domain: kind,
    places,
    initial,
    placeName: (k: string) => (k === "global" ? "用户级" : "CardBox"),
    modelOf: (k: string) =>
      kind === "mcp"
        ? fullModel(k === "global" ? "用户级的 MCP 来源" : "CardBox 的 MCP 来源", "MCP")
        : fullModel(k === "global" ? "用户级的来源" : "CardBox 的来源"),
    version: 0,
    onChange: async () => undefined,
    onClose: () => undefined,
    onAdd: kind === "mcp" ? undefined : () => undefined,
  });

test("页面头：← 返回 + 页名跟着位置胶囊（全部 → `所有生效范围的原件位置`），右端 `+ 原件位置`；下面一行范围胶囊（R8）", () => {
  const all = fullPage("skills", "all");
  assert.match(all, /role="region" aria-label="所有生效范围的原件位置"/);
  assert.match(all, /aria-label="返回"/);
  assert.match(all, /page-head__title[^>]*>所有生效范围的原件位置<\/h1>/);
  assert.match(all, /ss-btn--add[\s\S]*?原件位置<\/button>/);
  // 位置胶囊就是表格页的筛选行：有 全部、用户级，默认选在进来时的位置
  assert.match(all, /aria-label="按生效范围筛选"/);
  assert.match(all, />全部</);
  const user = fullPage("skills", "user");
  assert.match(user, /role="region" aria-label="用户级的来源"/);
  // MCP：页名一律「自动同步」，没有 `+`
  const mcp = fullPage("mcp", "all");
  assert.match(mcp, /role="region" aria-label="自动同步"/);
  assert.doesNotMatch(mcp, /ss-btn--add/);
});

test("页名、空态、列头文字：一个位置用它的模型，不止一个说「所有生效范围」；数那一列 skill 数 / 服务数", () => {
  const one = { title: "CardBox 的来源", emptyText: "CardBox 还没有来源" };
  assert.deepEqual(sourcesPageText("skills", one, { noun: "skill" }), {
    title: "CardBox 的来源",
    emptyText: "CardBox 还没有来源",
    countHead: "skill 数",
    ruleHead: "以后新出现的自动加到",
  });
  assert.deepEqual(sourcesPageText("mcp", null, { noun: "MCP" }), {
    title: "自动同步",
    emptyText: "还没有写了 MCP 的配置文件",
    countHead: "服务数",
    ruleHead: "以后新出现的自动写进",
  });
  assert.equal(sourcesPageText("skills", null, { noun: "skill" }).emptyText, "还没有原件位置");
});

test("列头一行 位置 ｜ 来源 ｜ skill 数 ｜ 以后新出现的自动加到（位置列一直在）；规则句只在列头说一次，行上不重复", () => {
  const html = fullPage("skills", "project:/Users/me/code/CardBox");
  const heads = [...html.matchAll(/role="columnheader">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(heads, ["生效范围", "原件位置", "skill 数", "以后新出现的自动加到"]);
  const mcp = fullPage("mcp", "all");
  const mcpHeads = [...mcp.matchAll(/role="columnheader">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(mcpHeads, ["生效范围", "配置文件", "服务数", "以后新出现的自动写进"]);
  const rows = page(stubState([row("u", "通用仓库", false, 26), row("w", "WeiboAP", false, 27)]));
  assert.doesNotMatch(rows, />以后新出现的自动加到</);
  assert.equal(rows.match(/class="srcline"/g)?.length, 2);
});

test("每行：位置 ｜ 来源名（悬停出 `打开 ↗`，同表格页来源格）｜ 数 ｜ 紧凑开关 ｜ 目标框 ｜ ×；没有路径列", () => {
  const html = page(stubState([row("w", "WeiboAP", false, 27)]));
  assert.match(html, /srcline__placelabel">CardBox<\/span>/);
  // 来源格与表格页同一个组件：名字 + 完整路径的提示框；`打开 ↗` 只在悬停这一格（或键盘焦点在这一行）时出
  assert.match(html, /class="mx-origin"[^>]*>WeiboAP<\/span>/);
  // 不悬停时 `打开 ↗` 看不见，但占着位置（列宽不随悬停变，右边的列不挪；2026-09-30「提前预留位置」）
  assert.match(html, /class="mx-reveal is-reserved" aria-hidden="true" inert/);
  assert.equal(html.match(/class="mx-reveal"/g)?.length, 1);
  const src = readFileSync(new URL("../src/SourceRow.tsx", import.meta.url), "utf8");
  assert.match(src, /<OriginLabel/);
  assert.match(src, /const openShown = !leaving && \(hovered \|\| keyFocus\);/);
  // 键盘焦点看 inputModality，不看 :focus-visible（CLAUDE.md）
  assert.match(src, /setKeyFocus\(keyboardModality\(\)\)/);
  assert.match(html, /srcline__count"[^>]*>27<\/span>/);
  // 路径列去掉了（2026-09-30）：完整路径只在来源名的提示框里
  assert.doesNotMatch(html, /srcrow__path|srcline__where/);
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

test("一个来源都没有：空态（`CardBox 还没有来源` / `还没有来源`）+ 猫，不画列头；`+ 来源` 在页面头，空态不重复", () => {
  const src = readFileSync(new URL("../src/pages/SourcesPage.tsx", import.meta.url), "utf8");
  // 各位置一直挂着读数据；一行都没有时表格藏起来（连列头），换成空态
  assert.match(src, /hidden=\{total === 0\}/);
  assert.match(src, /<Empty description=\{emptyText\} art="emptyFolder" \/>/);
  const css = readFileSync(new URL("../src/pages/SourcesPage.css", import.meta.url), "utf8");
  assert.match(css, /\.srcpage__table\[hidden\] \{[^}]*display: none/);
});

test("样式：各行 subgrid 对齐列头；位置至多 120、来源至多 220；行高 40、行间 row-line；列头 hairline", () => {
  const rowCss = readFileSync(new URL("../src/SourceRow.css", import.meta.url), "utf8");
  const pageCss = readFileSync(new URL("../src/pages/SourcesPage.css", import.meta.url), "utf8");
  assert.match(
    rowCss,
    /\.srcline \{[^}]*grid-template-columns: subgrid;[^}]*height: 40px;[^}]*border-bottom: var\(--border-row\);/,
  );
  // 上限：位置至多 120、来源至多 220
  assert.match(rowCss, /\.srcline__placelabel \{[^}]*max-width: 120px;/);
  assert.match(rowCss, /\.srcline__name \{[^}]*max-width: 220px;/);
  assert.doesNotMatch(rowCss, /srcline__fit/);
  assert.match(pageCss, /\.srcpage__head \{[^}]*border-bottom: var\(--border-structure\);/);
  // 目标浮层是组件库的多选菜单：页面不再写一套浮层项，也不覆盖组件的内部类
  assert.doesNotMatch(rowCss, /\.srcrow-target/);
  assert.doesNotMatch(rowCss, /\.ss-[a-z]/);
  const rowTsx = readFileSync(new URL("../src/SourceRow.tsx", import.meta.url), "utf8");
  assert.match(rowTsx, /<Menu maxWidth=\{280\}>/);
  assert.match(rowTsx, /<MenuItem[^>]*kind="check"/);
});
