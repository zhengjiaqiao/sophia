// MCP 第一批（spec 2026-09-27-mcp-batch1）：写进之后什么时候生效（R8）、Copilot 列头多一行（R6）、
// Claude Desktop 在项目行上空着（R5）、Claude Desktop 用 Claude 的标志
import assert from "node:assert/strict";
import test from "node:test";
import { mcpEffectTrail, toastFor } from "../src/toastText.ts";
import { mcpBlankTip, mcpColumnNote, mcpDomains, mergeMcpDomains } from "../src/mcpView.ts";
import type { McpLocation, McpOverview } from "../src/types.ts";

const agent = (id: string, name: string) => ({ id, name });
const desktop = agent("claude-desktop", "Claude Desktop");
const gemini = agent("gemini-cli", "Gemini CLI");
const copilot = agent("github-copilot", "GitHub Copilot");
const codex = agent("codex", "Codex");

test("AC12：写进 Claude Desktop 的例行提示条末尾说重启后生效", () => {
  const t = toastFor("write", { done: [{ name: "fs", agent: desktop }], omitNames: true });
  assert.equal(t.kind, "success");
  assert.deepEqual(t.trail, ["重启 Claude Desktop 后生效"]);
});

test("R8：Gemini、Copilot 新开会话后生效；Copilot 的项目文件还要信任文件夹；同一句只说一次", () => {
  assert.deepEqual(mcpEffectTrail([{ name: "fs", agent: gemini }]), ["新开会话后生效"]);
  assert.deepEqual(mcpEffectTrail([{ name: "fs", agent: copilot }]), ["新开会话后生效"]);
  assert.deepEqual(mcpEffectTrail([{ name: "fs", agent: copilot, project: true }]), [
    "新开会话后生效",
    "在 Copilot 里信任这个文件夹后生效",
  ]);
  assert.deepEqual(
    mcpEffectTrail([
      { name: "a", agent: gemini },
      { name: "a", agent: desktop },
      { name: "b", agent: copilot, project: true },
    ]),
    ["新开会话后生效", "重启 Claude Desktop 后生效", "在 Copilot 里信任这个文件夹后生效"],
  );
  // 自动规则在背后写进的也说
  assert.deepEqual(toastFor("autoWrite", { done: [{ name: "fs", agent: desktop }] }).trail, [
    "重启 Claude Desktop 后生效",
  ]);
});

test("R8：现有三家、失败、skill 的提示条都不接这一句", () => {
  const t = toastFor("write", { done: [{ name: "fs", agent: codex }] });
  assert.equal(t.trail, undefined);
  assert.equal("trail" in t, false, "没有就不带这个键，现有提示条一个字不变");
  const failed = toastFor("write", {
    done: [],
    failed: [{ name: "fs", agent: desktop, reason: "没写成" }],
  });
  assert.equal(failed.trail, undefined);
  assert.equal(toastFor("link", { done: [{ name: "x", agent: gemini }] }).trail, undefined);
});

const loc = (id: string, harnessId: string, label: string, domain = "global"): McpLocation => ({
  id,
  domain,
  label,
  harnessId,
  path: `/${id}`,
});

const overview = (locations: McpLocation[]): McpOverview => ({
  locations,
  entries: [],
  issues: [],
  subscribed: {},
});

test("R5 R6：多位置表里 Copilot 列头多一行 .mcp.json 的说明，Claude Desktop 在项目行上空着并说原因", () => {
  const p = "project:/w/app";
  const table = mergeMcpDomains(
    mcpDomains(
      overview([
        loc("claude-code", "claude-code", "Claude Code · User MCPs"),
        loc("claude-desktop", "claude-desktop", "Claude Desktop"),
        loc("github-copilot", "github-copilot", "GitHub Copilot"),
        loc(`${p}::claude-code`, "claude-code", "Claude Code · Project MCPs", p),
        loc(`${p}::github-copilot`, "github-copilot", "GitHub Copilot", p),
      ]),
    ),
  );
  const column = (id: string) => table.columns.find((c) => c.id === id)!;
  // Claude Code 两格（仅自己 / 团队共享）同一个名字；Claude Desktop 的名字折两行（spec 2026-09-30-mcp-claude-self-team）
  assert.deepEqual(
    table.columns.map((c) => [c.id, c.nameTail ? `${c.name} ${c.nameTail}` : c.name]),
    [
      ["claude-code", "Claude Code"],
      ["claude-code:team", "Claude Code"],
      ["claude-desktop", "Claude Desktop"],
      ["github-copilot", "GitHub Copilot"],
    ],
  );
  assert.equal(
    mcpColumnNote(column("github-copilot")),
    "Copilot 也会读这个项目的 .mcp.json（Claude Code 那一份）",
  );
  // Claude Code 两格合组时，列头提示框多一行说存在哪、所以谁能用
  assert.equal(
    mcpColumnNote(column("claude-code")),
    "存在你这台电脑的 ~/.claude.json 里，不进仓库，只有你能用",
  );
  assert.equal(
    mcpColumnNote(column("claude-code:team")),
    "存在项目里的 .mcp.json，随仓库提交，队友拉下来也能用",
  );
  // Claude Desktop 只有用户级：项目行上没有它的格
  assert.equal(column("claude-desktop").targets.has(p), false);
  assert.deepEqual(mcpBlankTip("app", column("claude-desktop")), {
    tip: "Claude Desktop 没有项目级的 MCP",
  });
  // 用户级的行在团队共享那一格：说团队共享只在项目里；写在哪个文件是第二行（spec #239 第 44 条）
  assert.deepEqual(mcpBlankTip("用户级", column("claude-code:team")), {
    tip: "团队共享只在项目中可用",
    detail: "写入项目的 .mcp.json",
  });
  // 别的列照旧
  assert.deepEqual(mcpBlankTip("用户级", { id: "codex", harnessId: "codex", sentence: "Codex" }), {
    tip: "用户级 没有 Codex 的配置位置",
  });
});

test("R6：只有用户级时 Copilot 列头不说 .mcp.json", () => {
  const table = mergeMcpDomains(
    mcpDomains(overview([loc("github-copilot", "github-copilot", "GitHub Copilot")])),
  );
  assert.equal(mcpColumnNote(table.columns[0]), undefined);
});

test("Claude Desktop 的图标就是 Claude 的标志（与 Claude Code 同一个定义）", async () => {
  const { render } = await import("./ui-render.ts");
  const { AgentIcon, hasAgentIcon } = await import("../src/ui/AgentIcon.tsx");
  assert.equal(hasAgentIcon("claude-desktop"), true);
  const mark = (id: string) =>
    render(AgentIcon, { id, name: "x" }).replace(/aria-label="[^"]*"/, "");
  assert.equal(mark("claude-desktop"), mark("claude-code"));
});

// ===== Claude 合组列头与格宽（spec 2026-09-27-mcp-batch1 R7，DESIGN「MCP 支持哪些 agent」）=====

/// 范围里的几页并成一张表（`keys` 是位置，按 McpTab 的次序：用户级在前）
const tableOf = (locations: McpLocation[], keys: string[]) => {
  const domains = mcpDomains(overview(locations));
  return mergeMcpDomains(keys.flatMap((key) => domains.find((d) => d.key === key) ?? []));
};
const heads = (table: ReturnType<typeof mergeMcpDomains>) =>
  table.columns.map((c) => [c.id, c.scope ?? "", c.group?.name ?? ""]);

const P = "project:/w/app";
/// core 的位置先后：agent 一家一家来，用户级在前、各项目在后；Claude Desktop 紧跟 Claude Code（mcp_columns）
const allLocations = (withDesktop: boolean): McpLocation[] => [
  loc("claude-code", "claude-code", "Claude Code · User MCPs"),
  loc(`${P}::claude-code:local`, "claude-code", "Claude Code · Local MCPs", P),
  loc(`${P}::claude-code`, "claude-code", "Claude Code · Project MCPs", P),
  ...(withDesktop ? [loc("claude-desktop", "claude-desktop", "Claude Desktop")] : []),
  loc("codex", "codex", "Codex"),
  loc(`${P}::codex`, "codex", "Codex", P),
  loc("cursor", "cursor", "Cursor"),
  loc(`${P}::cursor`, "cursor", "Cursor", P),
  loc("gemini-cli", "gemini-cli", "Gemini CLI"),
  loc(`${P}::gemini-cli`, "gemini-cli", "Gemini CLI", P),
];

test("用户级：Claude Code 只有一格（仅自己）不画组，列头 CLAUDE CODE；Claude Desktop 单独一列、名字折两行；5 格每格 76", async () => {
  const { agentColumnWidth } = await import("../src/Matrix.tsx");
  const table = tableOf(allLocations(true), ["global"]);
  assert.deepEqual(heads(table), [
    ["claude-code", "", ""],
    ["claude-desktop", "", ""],
    ["codex", "", ""],
    ["cursor", "", ""],
    ["gemini-cli", "", ""],
  ]);
  // 句子里的名字不带小标
  assert.deepEqual(
    table.columns.map((c) => c.sentence),
    ["Claude Code", "Claude Desktop", "Codex", "Cursor", "Gemini CLI"],
  );
  assert.equal(agentColumnWidth(table.columns.length), 76);
});

test("全部：CLAUDE CODE 合组 仅自己 / 团队共享，Claude Desktop 紧跟、单独一列；6 格每格 64", async () => {
  const { agentColumnWidth } = await import("../src/Matrix.tsx");
  const table = tableOf(allLocations(true), ["global", P]);
  assert.deepEqual(heads(table), [
    ["claude-code", "仅自己", "Claude Code"],
    ["claude-code:team", "团队共享", "Claude Code"],
    ["claude-desktop", "", ""],
    ["codex", "", ""],
    ["cursor", "", ""],
    ["gemini-cli", "", ""],
  ]);
  assert.equal(agentColumnWidth(table.columns.length), 64);
  // 仅自己＝用户级配置 + 项目的本地配置；团队共享＝项目的 .mcp.json
  const self = table.columns[0];
  const team = table.columns[1];
  assert.deepEqual(
    [...self.targets.values()].map((t) => t.id),
    ["claude-code", `${P}::claude-code:local`],
  );
  assert.deepEqual(
    [...team.targets.values()].map((t) => t.id),
    [`${P}::claude-code`],
  );
  // 读屏与提示条里的名字说清是哪一格
  assert.deepEqual(
    table.columns.slice(0, 3).map((c) => c.sentence),
    ["Claude Code 仅自己", "Claude Code 团队共享", "Claude Desktop"],
  );
  assert.deepEqual([table.columns[2].name, table.columns[2].nameTail], ["Claude", "Desktop"]);
});

test("只看某个项目：Claude Code 两格与 全部 一模一样（仅自己 / 团队共享），没有 Claude Desktop", () => {
  const table = tableOf(allLocations(true), [P]);
  assert.equal(
    table.columns.some((c) => c.harnessId === "claude-desktop"),
    false,
  );
  assert.deepEqual(heads(table), [
    ["claude-code", "仅自己", "Claude Code"],
    ["claude-code:team", "团队共享", "Claude Code"],
    ["codex", "", ""],
    ["cursor", "", ""],
    ["gemini-cli", "", ""],
  ]);
});

test("没装 Claude Desktop：全部 下 Claude Code 两格照样合组、排在最前（团队共享不落到最后）", () => {
  const table = tableOf(allLocations(false), ["global", P]);
  assert.deepEqual(
    table.columns.map((c) => c.id),
    ["claude-code", "claude-code:team", "codex", "cursor", "gemini-cli"],
  );
  assert.equal(table.columns[1].group?.name, "Claude Code");
});

test("位置 id → 列：用户级 User 与项目 Local 都是仅自己，项目的 .mcp.json 是团队共享；互斥的另一格", async () => {
  const { mcpColumnOf, claudeSibling, claudeWhereText, claudeMoveTip } =
    await import("../src/mcpView.ts");
  assert.equal(mcpColumnOf("claude-code"), "claude-code");
  assert.equal(mcpColumnOf(`${P}::claude-code:local`), "claude-code");
  assert.equal(mcpColumnOf(`${P}::claude-code`), "claude-code:team");
  assert.equal(mcpColumnOf(`${P}::codex`), "codex");
  assert.equal(claudeSibling("claude-code"), "claude-code:team");
  assert.equal(claudeSibling("claude-code:team"), "claude-code");
  assert.equal(claudeSibling("codex"), null);
  // 项目行的第二行说在哪；用户级的行不写
  assert.equal(claudeWhereText("claude-code", "CardBox", P), "只在 CardBox、只给你（本地配置）");
  assert.equal(
    claudeWhereText("claude-code:team", "CardBox", P),
    "写在 CardBox 的 .mcp.json，随仓库分享给团队",
  );
  assert.equal(claudeWhereText("claude-code", "用户级", "global"), null);
  assert.deepEqual(claudeMoveTip("claude-code:team", "CardBox"), {
    verb: "挪到团队共享",
    detail: "加到 CardBox 的 .mcp.json，从你的本地配置里删掉",
  });
});

test("合组列头：一个 Claude 图标 + CLAUDE、一条结构线横跨几格，线下每格小标 + 计数；其余列留出同高的空位", async () => {
  const { default: Matrix, headerRuns } = await import("../src/Matrix.tsx");
  const { render } = await import("./ui-render.ts");
  const claude = { id: "claude", agentId: "claude-code", name: "Claude" };
  const columns = [
    {
      id: "claude-code",
      agentId: "claude-code",
      name: "Claude Code",
      scope: "code",
      group: claude,
      count: 3,
      tip: "Claude Code · 3 个已加上",
    },
    {
      id: "claude-desktop",
      agentId: "claude-desktop",
      name: "Claude Desktop",
      scope: "desktop",
      group: claude,
      count: 1,
      tip: "Claude Desktop · 1 个已加上",
    },
    { id: "codex", agentId: "codex", name: "Codex", count: 2, tip: "Codex · 2 个已加上" },
  ];
  assert.deepEqual(
    headerRuns(columns).map((run) => [run.group?.id ?? null, run.columns.map((c) => c.id)]),
    [
      ["claude", ["claude-code", "claude-desktop"]],
      [null, ["codex"]],
    ],
  );
  const html = render(Matrix, {
    columns,
    rows: [],
    nameLabel: "名称",
    originLabel: "来源",
    filterText: "",
    onFilterText: () => undefined,
    selected: new Set<string>(),
    onSelectionChange: () => undefined,
    onCell: () => undefined,
    dotWords: "mcp" as const,
  });
  const group = html.slice(
    html.indexOf('class="mx-head__group"'),
    html.indexOf('data-col="codex"'),
  );
  assert.match(html, /class="mx-head__group" style="grid-column:span 2"/);
  // 组头只有一个图标与名字（经 Cap），下面一条结构线
  assert.equal(group.match(/mx-colbtn__icon/g)?.length, 1);
  assert.match(
    group,
    /class="mx-colbtn__name"><span class="ss-cap-wrap ss-cap-wrap--label"><span class="ss-cap">Claude</,
  );
  assert.match(group, /class="mx-headgroup__rule"/);
  // 线下每格：小标 + 计数，各自是一颗排序键（锚点仍按 data-col 找）
  assert.match(group, /data-col="claude-code" class="mx-head__col"/);
  assert.match(group, /data-col="claude-desktop" class="mx-head__col"/);
  assert.match(group, /<span class="ss-cap">code<\/span>[^]*mx-colbtn__count">3</);
  assert.match(group, /<span class="ss-cap">desktop<\/span>[^]*mx-colbtn__count">1</);
  assert.doesNotMatch(group, /Claude Code<\/span>|Claude Desktop<\/span>/);
  // 其余列照旧三层，小标位置留空（同高）
  const codex = html.slice(html.indexOf('data-col="codex"'));
  assert.match(codex, /mx-colbtn__icon[^]*>Codex<[^]*mx-colbtn__slot[^]*mx-colbtn__count">2</);
  // 合组的结构线与留空的高度都用 token
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/Matrix.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.mx-headgroup__rule \{[^}]*height: 1px;[^}]*background: var\(--ctl-border\);/,
  );
  assert.match(
    css,
    /\.mx-colbtn__slot \{[^}]*calc\(1px \+ 2 \* var\(--space-xxs\) \+ var\(--size-label\) \* var\(--leading-label\)\)/,
  );
});

test("没有合组时列头与今天相同：不留小标空位", async () => {
  const { default: Matrix } = await import("../src/Matrix.tsx");
  const { render } = await import("./ui-render.ts");
  const html = render(Matrix, {
    columns: [{ id: "codex", agentId: "codex", name: "Codex", count: 2, tip: "Codex" }],
    rows: [],
    nameLabel: "名称",
    originLabel: "来源",
    filterText: "",
    onFilterText: () => undefined,
    selected: new Set<string>(),
    onSelectionChange: () => undefined,
    onCell: () => undefined,
  });
  assert.doesNotMatch(html, /mx-head__group|mx-colbtn__slot/);
});

test("名字折两行（Claude Desktop）：第二行同名字字重、占小标的位置，其余列留出同高的空位（spec 2026-09-30 R2）", async () => {
  const { default: Matrix } = await import("../src/Matrix.tsx");
  const { render } = await import("./ui-render.ts");
  const html = render(Matrix, {
    columns: [
      {
        id: "claude-code",
        agentId: "claude-code",
        name: "Claude Code",
        count: 3,
        tip: "Claude Code",
      },
      {
        id: "claude-desktop",
        agentId: "claude-desktop",
        name: "Claude",
        nameTail: "Desktop",
        count: 1,
        tip: "Claude Desktop",
      },
    ],
    rows: [],
    nameLabel: "名称",
    originLabel: "来源",
    filterText: "",
    onFilterText: () => undefined,
    selected: new Set<string>(),
    onSelectionChange: () => undefined,
    onCell: () => undefined,
  });
  const desktop = html.slice(html.indexOf('data-col="claude-desktop"'));
  // 第二行与名字同一个类（同字重、同墨色），不是 ink-faint 的小标
  assert.match(
    desktop,
    /class="mx-colbtn__name"><span class="ss-cap-wrap ss-cap-wrap--label"><span class="ss-cap">Claude<[^]*class="mx-colbtn__name mx-colbtn__tail is-slotted"><span class="ss-cap-wrap ss-cap-wrap--label"><span class="ss-cap">Desktop</,
  );
  assert.doesNotMatch(desktop, /mx-colbtn__scope/);
  // 同一张表里没有两行名字的列留空位，计数对齐
  const code = html.slice(
    html.indexOf('data-col="claude-code"'),
    html.indexOf('data-col="claude-desktop"'),
  );
  assert.match(code, /mx-colbtn__slot/);
  // 不画组
  assert.doesNotMatch(html, /mx-head__group/);
});
