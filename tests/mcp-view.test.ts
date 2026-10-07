import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  canSupplement,
  mcpDomains,
  pickChoices,
  pickDiffText,
  pickTip,
  pickTitle,
  sourceForMissing,
  sourceForMissingTarget,
  supplementSourcesForTarget,
} from "../src/mcpView.ts";
import type { McpCellState, McpDiff, McpEntry, McpLocation, McpOverview } from "../src/types.ts";

const location = (id: string, domain = "global"): McpLocation => ({
  id,
  domain,
  label: id,
  harnessId: id,
  path: `/${id}`,
});

const entry = (
  sourceId: string,
  name: string,
  states: Record<string, McpCellState>,
  transport: McpEntry["transport"] = "stdio",
): McpEntry => ({
  sourceId,
  name,
  transport,
  reason: transport === "unsupported" ? "不支持" : null,
  cells: Object.entries(states).map(([targetId, state]) => ({ targetId, state, reason: null })),
});

const overview = (locations: McpLocation[], entries: McpEntry[] = []): McpOverview => ({
  locations,
  entries,
  issues: [],
});

test("域保留空项目、全局在前，并且项目绝不显示外域来源", () => {
  const result = mcpDomains(
    overview(
      [
        location("project-a", "project:/work/a"),
        location("global-a"),
        location("project-b", "project:/work/b"),
      ],
      [
        entry("global-a", "global-service", {
          "global-a": "own",
          "project-a": "missing",
          "project-b": "missing",
        }),
        entry("project-a", "a-service", {
          "global-a": "missing",
          "project-a": "own",
          "project-b": "missing",
        }),
      ],
    ),
  );

  assert.deepEqual(
    result.map((page) => page.key),
    ["global", "project:/work/a", "project:/work/b"],
  );
  assert.equal(result[0].label, "用户级");
  assert.equal(result[1].label, "项目 · a");
  assert.deepEqual(
    result[0].rows.map((row) => row.name),
    ["global-service"],
  );
  assert.deepEqual(
    result[1].rows.map((row) => row.name),
    ["a-service"],
  );
  assert.equal(result[2].rows.length, 0);
  assert.deepEqual(
    result[1].rows[0].entries[0].cells.map((cell) => cell.targetId),
    ["project-a"],
  );
});

test("隐藏的 Claude Project 位置不进入矩阵目标", () => {
  const result = mcpDomains(
    overview([
      location("claude-local"),
      { ...location("claude-project", "project:/work/a"), matrixHidden: true },
    ]),
  );

  assert.deepEqual(
    result.map((page) => page.targets.map((target) => target.id)),
    [["claude-local"], []],
  );
});

test("同名的域内等价副本合并为一行，保留两份来源并可补齐", () => {
  const result = mcpDomains(
    overview(
      [location("a"), location("b"), location("c")],
      [
        entry("a", "service", { a: "own", b: "equal", c: "missing" }),
        entry("b", "service", { a: "equal", b: "own", c: "missing" }),
      ],
    ),
  );

  assert.equal(result[0].rows.length, 1);
  assert.deepEqual(
    result[0].rows[0].entries.map((entry) => entry.sourceId),
    ["a", "b"],
  );
  assert.deepEqual(
    result[0].rows[0].entries[0].cells.map((cell) => cell.state),
    ["own", "equal", "missing"],
  );
  assert.equal(sourceForMissing(result[0].rows[0], result[0].targets)?.sourceId, "a");
});

test("同名冲突和多个可迁移的非等价来源保留在同一行且不擅自选来源", () => {
  const result = mcpDomains(
    overview(
      [location("a"), location("b"), location("c")],
      [
        entry("a", "conflict", { a: "own", b: "conflict", c: "missing" }),
        entry("b", "conflict", { a: "conflict", b: "own", c: "missing" }),
        entry("a", "uncertain", { a: "own", b: "unsupported", c: "missing" }),
        entry("b", "uncertain", { a: "unsupported", b: "own", c: "missing" }),
        entry("a", "unsupported", { a: "own", b: "unsupported", c: "missing" }, "unsupported"),
        entry("b", "unsupported", { a: "unsupported", b: "own", c: "missing" }, "unsupported"),
        entry("a", "mixed", { a: "own", b: "unsupported", c: "missing" }),
        entry("b", "mixed", { a: "unsupported", b: "own", c: "missing" }, "unsupported"),
      ],
    ),
  );

  assert.deepEqual(
    result[0].rows.map(
      (row) => `${row.name}:${row.entries.map((entry) => entry.sourceId).join(",")}`,
    ),
    ["conflict:a,b", "uncertain:a,b", "unsupported:a,b", "mixed:a,b"],
  );
  assert.equal(sourceForMissing(result[0].rows[0], result[0].targets), null);
  assert.equal(sourceForMissing(result[0].rows[1], result[0].targets), null);
  assert.equal(sourceForMissing(result[0].rows[3], result[0].targets)?.sourceId, "a");
});

test("动态或不支持的同名副本不阻止静态来源向缺失目标补齐", () => {
  const [page] = mcpDomains(
    overview(
      [location("claude"), location("codex"), location("cursor")],
      [
        entry(
          "claude",
          "comments",
          {
            claude: "own",
            codex: "unsupported",
            cursor: "missing",
          },
          "http",
        ),
        entry(
          "codex",
          "comments",
          {
            claude: "unsupported",
            codex: "own",
            cursor: "missing",
          },
          "unsupported",
        ),
      ],
    ),
  );
  const row = page.rows[0];

  assert.deepEqual(
    supplementSourcesForTarget(row, "cursor").map((candidate) => candidate.sourceId),
    ["claude"],
  );
  assert.equal(sourceForMissing(row, page.targets)?.sourceId, "claude");
  assert.equal(sourceForMissingTarget(row, "cursor")?.sourceId, "claude");
});

test("一个缺失格有多个非等价可迁移来源时必须明确选源", () => {
  const [page] = mcpDomains(
    overview(
      [location("claude"), location("codex"), location("cursor")],
      [
        entry("claude", "search", { claude: "own", codex: "conflict", cursor: "missing" }),
        entry("codex", "search", { claude: "conflict", codex: "own", cursor: "missing" }),
      ],
    ),
  );

  assert.equal(sourceForMissingTarget(page.rows[0], "cursor"), null);
});

test("同一端点请求头待核对属于已定义，但绝不当作 equal 自动选源", () => {
  const [page] = mcpDomains(
    overview(
      [location("a"), location("b"), location("c")],
      [
        entry("a", "service", { a: "own", b: "sameEndpoint", c: "missing" }),
        entry("b", "service", { a: "sameEndpoint", b: "own", c: "missing" }),
      ],
    ),
  );

  assert.equal(sourceForMissingTarget(page.rows[0], "c"), null);
  assert.equal(canSupplement(page.rows[0].entries[0], new Set(["b"])), false);
});

test("部分已引入的来源仍可向选中的缺失目标补齐", () => {
  const result = mcpDomains(
    overview(
      [location("claude"), location("codex"), location("cursor")],
      [
        entry("claude", "comments", {
          claude: "own",
          codex: "equal",
          cursor: "missing",
        }),
      ],
    ),
  );
  const source = result[0].rows[0].entries[0];

  assert.equal(canSupplement(source, new Set(["cursor"])), true);
  assert.equal(canSupplement(source, new Set(["claude", "codex"])), false);
});

test("共享 agents.db 的 WeiboAP agent 仍是独立域", () => {
  const agentsDb = "/Users/me/Library/Application Support/WeiboAP/Data/agents.db";
  const agentOne = {
    id: "project:/Users/me/Library/Application Support/WeiboAP/Data/agents/agent-1::weiboap",
    label: "WeiboAP",
    harnessId: "weiboap",
    domain: "project:/Users/me/Library/Application Support/WeiboAP/Data/agents/agent-1",
    path: agentsDb,
  };
  const agentTwo = {
    id: "project:/Users/me/Library/Application Support/WeiboAP/Data/agents/agent-2::weiboap",
    label: "WeiboAP",
    harnessId: "weiboap",
    domain: "project:/Users/me/Library/Application Support/WeiboAP/Data/agents/agent-2",
    path: agentsDb,
  };
  const [first, second] = mcpDomains(
    overview(
      [agentOne, agentTwo],
      [
        entry(agentOne.id, "same-service", { [agentOne.id]: "own", [agentTwo.id]: "conflict" }),
        entry(agentTwo.id, "same-service", { [agentOne.id]: "conflict", [agentTwo.id]: "own" }),
      ],
    ),
  );

  assert.equal(agentOne.path, agentTwo.path);
  assert.deepEqual([first.key, second.key], [agentOne.domain, agentTwo.domain]);
  assert.deepEqual([first.label, second.label], ["WeiboAP · agent-1", "WeiboAP · agent-2"]);
  assert.deepEqual(
    [first.rows[0].entries[0].sourceId, second.rows[0].entries[0].sourceId],
    [agentOne.id, agentTwo.id],
  );
});

test("订阅着的别处来源：它的全部服务进本域列表，没写进的是 missing；同名时自己的那份在前", () => {
  const [global, project, other] = mcpDomains({
    ...overview(
      [location("user"), location("proj", "project:/work/a"), location("far", "project:/work/b")],
      [
        entry("user", "docs", { user: "own", proj: "equal", far: "missing" }),
        entry("user", "search", { user: "own", proj: "missing", far: "missing" }),
        entry("proj", "docs", { user: "equal", proj: "own", far: "missing" }),
        entry("far", "x", { user: "missing", proj: "missing", far: "own" }),
      ],
    ),
    subscribed: { "project:/work/a": ["user"] },
  });

  assert.deepEqual(
    project.rows.map((row) => [row.name, row.entries.map((e) => e.sourceId)]),
    [
      ["docs", ["proj", "user"]],
      ["search", ["user"]],
    ],
  );
  // 格只留本域的列
  assert.deepEqual(project.rows[1].entries[0].cells, [
    { targetId: "proj", state: "missing", reason: null },
  ]);
  // 没订阅的位置照旧只列自己的
  assert.deepEqual(
    global.rows.map((row) => row.name),
    ["docs", "search"],
  );
  assert.deepEqual(
    other.rows.map((row) => row.name),
    ["x"],
  );
});

test("同名多份：只列互不等价的几份，等价的并成一份", () => {
  const [page] = mcpDomains(
    overview(
      [location("a"), location("b"), location("c"), location("d")],
      [
        entry("a", "notion", { a: "own", b: "equal", c: "conflict", d: "missing" }),
        entry("b", "notion", { a: "equal", b: "own", c: "conflict", d: "missing" }),
        entry("c", "notion", { a: "conflict", b: "conflict", c: "own", d: "missing" }),
      ],
    ),
  );
  const row = page.rows[0];
  assert.equal(sourceForMissingTarget(row, "d"), null);
  assert.deepEqual(
    pickChoices(row, "d").map((e) => e.sourceId),
    ["a", "c"],
  );
  // 只有一份可写（或都等价）时不用挑
  const [single] = mcpDomains(
    overview([location("a"), location("b")], [entry("a", "x", { a: "own", b: "missing" })]),
  );
  assert.equal(pickChoices(single.rows[0], "b").length, 1);
});

test("挑选浮层的标题与格子提示框", () => {
  assert.equal(pickTitle("notion", 2), "notion 有 2 份不一样的，加哪一份？");
  assert.equal(pickTip("notion", 3), "有 3 份不一样的同名 notion · 点一下挑一份");
});

const diff = (
  locationIds: string[],
  fields: McpDiff["fields"],
  extra: Partial<McpDiff> = {},
): McpDiff => ({
  name: "notion",
  locationIds,
  fields,
  dynamicAuth: false,
  unreadable: [],
  ...extra,
});
const plain = (text: string) => ({ kind: "plain" as const, text });

test("差异摘要：两份时列出全部不同的字段，凭据只给字段名", () => {
  const d = diff(
    ["a", "b"],
    [
      { field: "url", values: [plain("https://a"), plain("https://b")] },
      {
        field: "headers.Authorization",
        values: [
          { kind: "secret", last4: "abcd" },
          { kind: "secret", last4: "wxyz" },
        ],
      },
    ],
  );
  assert.equal(pickDiffText(d, "a"), "url、headers.Authorization 不同");
  assert.equal(pickDiffText(d, "b"), "url、headers.Authorization 不同");
  assert.ok(!pickDiffText(d, "a").includes("abcd"));
});

test("差异摘要：三份时只列这一份独有的，没有独有的退回全部", () => {
  const d = diff(
    ["a", "b", "c"],
    [
      { field: "url", values: [plain("x"), plain("x"), plain("y")] },
      { field: "command", values: [plain("1"), plain("2"), plain("1")] },
    ],
  );
  assert.equal(pickDiffText(d, "c"), "url 不同");
  assert.equal(pickDiffText(d, "b"), "command 不同");
  assert.equal(pickDiffText(d, "a"), "url、command 不同");
});

test("差异摘要：取不到、读不出来或比不了时说清楚", () => {
  assert.equal(pickDiffText(null, "a"), "配置不一样");
  assert.equal(pickDiffText(diff(["a", "b"], [], { unreadable: ["a"] }), "a"), "配置不一样");
  assert.equal(
    pickDiffText(diff(["a", "b"], [], { dynamicAuth: true }), "a"),
    "认证头要到运行时才生成，无法逐字比对",
  );
});

// ===== 多位置（spec 2026-09-26-object-first-navigation R6 AC16）：位置 id 与 core 同一写法 =====

const { mergeMcpDomains, mcpColumnOf, mcpRowKey } = await import("../src/mcpView.ts");

const CB = "project:/w/CardBox";
const real = (id: string, label: string, harnessId: string, domain: string): McpLocation => ({
  id,
  label,
  harnessId,
  domain,
  path: `/${id}`,
});
const userCC = real("claude-code", "Claude Code · User MCPs", "claude-code", "global");
const userCX = real("codex", "Codex", "codex", "global");
const cbLocal = real(`${CB}::claude-code:local`, "Claude Code · Local MCPs", "claude-code", CB);
const cbProject = real(`${CB}::claude-code`, "Claude Code · Project MCPs", "claude-code", CB);
const cbCX = real(`${CB}::codex`, "Codex", "codex", CB);
const both = mcpDomains(
  overview(
    [userCC, userCX, cbLocal, cbProject, cbCX],
    [
      entry("claude-code", "notion", {
        "claude-code": "own",
        codex: "missing",
        [cbLocal.id]: "missing",
        [cbProject.id]: "missing",
        [cbCX.id]: "missing",
      }),
      entry(cbProject.id, "notion", {
        "claude-code": "equal",
        codex: "missing",
        [cbLocal.id]: "missing",
        [cbProject.id]: "own",
        [cbCX.id]: "missing",
      }),
    ],
  ),
);

test("位置 id → 列：用户级的 User 与项目的 Local 是仅自己，项目的 .mcp.json 是团队共享（spec 2026-09-30-mcp-claude-self-team R1）", () => {
  assert.equal(mcpColumnOf("claude-code"), "claude-code");
  assert.equal(mcpColumnOf(cbLocal.id), "claude-code");
  assert.equal(mcpColumnOf(cbProject.id), "claude-code:team");
  assert.equal(mcpColumnOf(cbCX.id), "codex");
});

test("AC16 全部：Claude Code 仅自己（用户级行是 User、项目行是 Local）+ 只有项目才有的团队共享", () => {
  const table = mergeMcpDomains(both);
  assert.deepEqual(
    table.columns.map((c) => [c.id, c.name, c.scope ?? null, [...c.targets.keys()]]),
    [
      ["claude-code", "Claude Code", "仅自己", ["global", CB]],
      ["claude-code:team", "Claude Code", "团队共享", [CB]],
      ["codex", "Codex", null, ["global", CB]],
    ],
  );
  const self = table.columns.find((c) => c.id === "claude-code")!;
  const team = table.columns.find((c) => c.id === "claude-code:team")!;
  const userRow = table.rows.find((r) => r.domainKey === "global")!;
  const cbRow = table.rows.find((r) => r.domainKey === CB)!;
  assert.equal(
    team.targets.get(userRow.domainKey),
    undefined,
    "用户级行在团队共享列上没有位置：画 ⊘ 说原因",
  );
  assert.equal(self.targets.get(userRow.domainKey)?.id, userCC.id);
  assert.equal(self.targets.get(cbRow.domainKey)?.id, cbLocal.id);
  assert.equal(team.targets.get(cbRow.domainKey)?.id, cbProject.id);
});

test("AC13 同一个服务在用户级与 CardBox：两行，行键带位置、不重复；位置名写在每行上", () => {
  const table = mergeMcpDomains(both);
  const keys = table.rows.map((r) => mcpRowKey(r.domainKey, r.name));
  assert.deepEqual(keys, ["global|notion", `${CB}|notion`]);
  assert.deepEqual(
    table.rows.map((r) => table.places.get(r.domainKey)),
    ["用户级", "CardBox"],
  );
});

test("AC17 只有一个项目：Claude Code 两格与 全部 一模一样（仅自己 / 团队共享），照样有位置名（位置列一直在，2026-09-30）", () => {
  const table = mergeMcpDomains(both.filter((d) => d.key === CB));
  assert.deepEqual([...table.places], [[CB, "CardBox"]]);
  assert.deepEqual(
    table.columns.map((c) => [c.name, c.scope ?? null, c.label]),
    [
      ["Claude Code", "仅自己", "Claude Code · 仅自己"],
      ["Claude Code", "团队共享", "Claude Code · 团队共享"],
      ["Codex", null, "Codex"],
    ],
  );
  // 只有用户级：一行一列，没有第二行
  const user = mergeMcpDomains(both.filter((d) => d.key === "global"));
  assert.deepEqual(
    user.columns.map((c) => [c.name, c.scope ?? null]),
    [
      ["Claude Code", null],
      ["Codex", null],
    ],
  );
});

test("修改生效范围：每个亮着的 agent 放到目标同一列；没有那一级的留下；Claude Code 到项目按选的一格、到用户级落到仅自己", async () => {
  const {
    scopeMovePlan,
    scopeMoveBlocked,
    scopeMovedTrail,
    scopeChangeText,
    scopeAgentOptions,
    effectiveScopeMode,
    mergeScopePlans,
  } = await import("../src/mcpView.ts");
  const loc = (id: string, domain: string, harnessId: string, label = id): McpLocation => ({
    id,
    domain,
    label,
    harnessId,
    path: `/${id}`,
  });
  const P = "project:/p/CardBox";
  const Q = "project:/p/weibo";
  const user = [
    loc("claude-code", "global", "claude-code", "Claude Code · User MCPs"),
    loc("claude-desktop", "global", "claude-desktop", "Claude Desktop"),
    loc("codex", "global", "codex", "Codex"),
  ];
  const proj = (d: string) => [
    loc(`${d}::claude-code:local`, d, "claude-code", "Claude Code · Local MCPs"),
    loc(`${d}::claude-code`, d, "claude-code", "Claude Code · Project MCPs"),
    loc(`${d}::codex`, d, "codex", "Codex"),
  ];
  const all = [...user, ...proj(P), ...proj(Q)];
  const locationOf = (id: string) => all.find((l) => l.id === id);
  const states = (own: string[]) =>
    Object.fromEntries(all.map((l) => [l.id, own.includes(l.id) ? "own" : "missing"])) as Record<
      string,
      McpCellState
    >;
  const ov = overview(all, [
    ...["claude-code", "claude-desktop", "codex"].map((id) =>
      entry(id, "filesystem", states(["claude-code", "claude-desktop", "codex"])),
    ),
    ...[`${P}::claude-code:local`, `${P}::claude-code`].map((id) =>
      entry(id, "both", states([`${P}::claude-code:local`, `${P}::claude-code`])),
    ),
    entry(`${Q}::codex`, "filesystem", states([`${Q}::codex`])),
  ]);
  const [g, p, q] = mcpDomains(ov);
  const labelOf = (id: string) => id;
  const nameOf = (l: McpLocation) => (l.harnessId === "claude-desktop" ? "Claude Desktop" : l.id);
  const fs = g.rows.find((r) => r.name === "filesystem")!;
  const toP = scopeMovePlan(fs, g, p, labelOf, nameOf);
  assert.deepEqual(toP.selections, [
    { sourceId: "claude-code", name: "filesystem", targetId: `${P}::claude-code:local` },
    { sourceId: "codex", name: "filesystem", targetId: `${P}::codex` },
  ]);
  assert.deepEqual(toP.stays, ["Claude Desktop"]);
  assert.equal(scopeMoveBlocked(fs, toP, g, p, "CardBox", labelOf), null);
  // 确认框里选了团队共享：Claude Code 写进项目的 .mcp.json
  const toTeam = scopeMovePlan(fs, g, p, labelOf, nameOf, "team");
  assert.equal(toTeam.selections[0].targetId, `${P}::claude-code`);
  // 后果：移动 / 复制各一句，留下的一句，写进团队共享说队友
  assert.deepEqual(scopeChangeText("move", toP, locationOf, "CardBox", "用户级"), [
    "Claude Code、Codex 加到 CardBox，用户级这边的删掉。",
    "Claude Desktop 那份留在用户级。",
  ]);
  assert.deepEqual(scopeChangeText("copy", toTeam, locationOf, "CardBox", "用户级"), [
    "Claude Code、Codex 各加一份到 CardBox，用户级这边的不动。",
    "Claude Desktop 那份不加过去。",
    "Claude Code 加到 CardBox 的 .mcp.json，提交后队友也能用。",
  ]);
  // 目标已有同名、就是当前所在：选不了
  assert.equal(
    scopeMoveBlocked(fs, scopeMovePlan(fs, g, q, labelOf, nameOf), g, q, "weibo", labelOf),
    "weibo 里已有同名的 filesystem",
  );
  assert.equal(scopeMoveBlocked(fs, toP, g, g, "用户级", labelOf), "已经在用户级了");
  // 项目里仅自己、团队共享都有，改到用户级：两份都落到仅自己——只动仅自己那份，团队共享那份留着
  const both = p.rows.find((r) => r.name === "both")!;
  const toG = scopeMovePlan(both, p, g, labelOf, nameOf);
  assert.deepEqual(toG.selections, [
    { sourceId: `${P}::claude-code:local`, name: "both", targetId: "claude-code" },
  ]);
  assert.deepEqual(toG.stays, [`${P}::claude-code`]);
  // 团队共享挪到另一个项目：不选就跟着原来那一格；从团队共享移走说队友那边
  const teamRow = {
    name: "t",
    entries: [entry(`${P}::claude-code`, "t", states([`${P}::claude-code`]))],
  };
  const onlyTeam = scopeMovePlan(teamRow, p, q, labelOf, nameOf);
  assert.deepEqual(
    onlyTeam.selections.map((sel) => sel.targetId),
    [`${Q}::claude-code`],
  );
  assert.deepEqual(
    scopeChangeText(
      "move",
      scopeMovePlan(teamRow, p, g, labelOf, nameOf),
      locationOf,
      "用户级",
      "CardBox",
    ),
    [
      "Claude Code 加到用户级，CardBox 这边的删掉。",
      "Claude Code 从 CardBox 的 .mcp.json 里删掉，提交后队友那边就没有了。",
    ],
  );
  // 只有没有那一级的 agent 亮着：说清为什么
  const desk = { name: "d", entries: [entry("claude-desktop", "d", states(["claude-desktop"]))] };
  assert.equal(
    scopeMoveBlocked(desk, scopeMovePlan(desk, g, p, labelOf, nameOf), g, p, "CardBox", labelOf),
    "Claude Desktop 没有项目级的配置",
  );
  // 扫描已经知道写不过去的（Codex 不支持迁移字段 cwd）：不进写入，确认框先说；一份都写不过去时选不了
  // core 在条目上给出搬不了的字段名（`unsupportedField`），界面那一句按它说，不从原因句里抠
  const cellAt = (sourceId: string, _name: string, targetId: string) =>
    sourceId === "codex" && targetId === `${P}::codex`
      ? {
          cell: {
            targetId,
            state: "unsupported" as const,
            reason: "来源条目无法无损转换",
            reasonKind: "sourceLossy" as const,
          },
          unsupportedField: "cwd",
        }
      : { cell: { targetId, state: "missing" as const, reason: null }, unsupportedField: null };
  const withCant = scopeMovePlan(fs, g, p, labelOf, nameOf, undefined, cellAt);
  assert.deepEqual(
    withCant.selections.map((sel) => sel.targetId),
    [`${P}::claude-code:local`],
  );
  // 与表格里那一格同一句（「里外提示对不上」）：说是哪个字段、是 Sophia 还搬不了
  const why = "filesystem 带着 cwd 字段，Sophia 还搬不了它，写过去就不是原来那个了";
  assert.deepEqual(withCant.cant, [{ agent: "codex", reason: why }]);
  assert.deepEqual(scopeChangeText("move", withCant, locationOf, "CardBox", "用户级"), [
    "Claude Code 加到 CardBox，用户级这边的删掉。",
    "Claude Desktop 那份留在用户级。",
    `codex 移不过去：${why}；那份留在用户级。`,
  ]);
  const onlyCodex = { name: "c", entries: [entry("codex", "c", states(["codex"]))] };
  const codexPlan = scopeMovePlan(onlyCodex, g, p, labelOf, nameOf, undefined, cellAt);
  assert.equal(
    scopeMoveBlocked(onlyCodex, codexPlan, g, p, "CardBox", labelOf),
    "c 带着 cwd 字段，Sophia 还搬不了它，写过去就不是原来那个了",
  );
  // 写进哪些 agent：勾着的列；去掉的留在原处
  const onlyCodex2 = scopeMovePlan(
    fs,
    g,
    p,
    labelOf,
    nameOf,
    undefined,
    undefined,
    new Set(["codex"]),
  );
  assert.deepEqual(
    onlyCodex2.selections.map((sel) => sel.targetId),
    [`${P}::codex`],
  );
  assert.deepEqual(scopeChangeText("move", onlyCodex2, locationOf, "CardBox", "用户级"), [
    "Codex 加到 CardBox，用户级这边的删掉。",
    "claude-code、Claude Desktop 那份留在用户级。",
  ]);
  // 多勾一个这一行在这边没有的（团队共享）：从现有的一份转写，是新加的一份（keep），移动时不删那一份
  const plusTeam = scopeMovePlan(
    fs,
    g,
    p,
    labelOf,
    nameOf,
    undefined,
    undefined,
    new Set(["codex", "claude-code:team"]),
  );
  assert.deepEqual(plusTeam.selections, [
    { sourceId: "codex", name: "filesystem", targetId: `${P}::codex` },
    { sourceId: "claude-code", name: "filesystem", targetId: `${P}::claude-code`, keep: true },
  ]);
  assert.deepEqual(plusTeam.stays, ["claude-code", "Claude Desktop"]);
  // 只勾了这一行在这边没有的：一份都不从这边挪，按加一份说
  const onlyNew = scopeMovePlan(
    fs,
    g,
    p,
    labelOf,
    nameOf,
    undefined,
    undefined,
    new Set(["claude-code:team"]),
  );
  assert.equal(effectiveScopeMode("move", onlyNew), "copy");
  assert.equal(effectiveScopeMode("move", plusTeam), "move");
  // 菜单：去处能写的每个位置一项（同自动同步页），这一行在用却去不了的也列上灰着；默认勾着和现在一致的
  const menu = scopeAgentOptions(fs, g, [p], labelOf, nameOf, cellAt);
  assert.deepEqual(
    menu.options.map((o) => [o.id, o.blocked]),
    [
      ["claude-code", null],
      ["claude-code:team", null],
      ["codex", why],
      ["claude-desktop", "没有项目级的配置"],
    ],
  );
  assert.deepEqual(menu.defaults, ["claude-code"]);
  assert.deepEqual(
    menu.options.map((o) => o.iconId),
    ["claude-code", "claude-code", "codex", "claude-desktop"],
  );
  // 还没选去处：按现在所在的生效范围列出能写的每个位置，勾着的是在用的
  const none = scopeAgentOptions(both, p, [], labelOf, nameOf);
  assert.deepEqual(
    none.options.map((o) => [o.id, o.blocked]),
    [
      ["claude-code", null],
      ["claude-code:team", null],
      ["codex", null],
    ],
  );
  assert.deepEqual(none.defaults, ["claude-code", "claude-code:team"]);
  // 项目改到用户级：团队共享只在项目里；两份都落到仅自己
  const toUser = scopeAgentOptions(both, p, [g], labelOf, nameOf);
  assert.deepEqual(
    toUser.options.map((o) => [o.id, o.blocked]),
    [
      ["claude-code", null],
      ["claude-desktop", null],
      ["codex", null],
      ["claude-code:team", "团队共享只在项目中可用"],
    ],
  );
  assert.deepEqual(toUser.defaults, ["claude-code"]);
  // 合并几个去处时，新加的一份用的底子不算「去了」：它自己那一格没勾时照样留在原处
  const merged2 = mergeScopePlans([plusTeam], (id) => id);
  assert.ok(merged2.stays.includes("claude-code"));
  assert.deepEqual(scopeMovedTrail("move", P, "CardBox", "用户级", ["Claude Desktop"]), [
    "只在 CardBox 里能用了",
    "Claude Desktop 那份留在用户级",
  ]);
  assert.deepEqual(scopeMovedTrail("copy", P, "CardBox", "用户级", []), ["CardBox 里也能用了"]);
  assert.deepEqual(scopeMovedTrail("move", "global", "用户级", "CardBox", []), [
    "所有项目都能用了",
  ]);
});

test("搬不过去的那一句：认得出字段说字段；认不出说只有来源支持的写法", async () => {
  const { unportableText, viewOf } = await import("../src/mcpCellState.ts");
  assert.equal(
    unportableText("computer-use", "Codex", "cwd"),
    "computer-use 带着 cwd 字段，Sophia 还搬不了它，写过去就不是原来那个了",
  );
  assert.equal(
    unportableText("x", "Codex", null),
    "x 用了只有 Codex 支持的写法，写到别处就不是原来那个了",
  );
  // 格子上同一句
  assert.equal(
    viewOf("unsupported", {
      service: "computer-use",
      location: "Claude Code",
      source: "Codex",
      unsupportedField: "cwd",
    }).reason,
    "computer-use 带着 cwd 字段，Sophia 还搬不了它，写过去就不是原来那个了",
  );
});

test("生效范围：所有项目 ｜ 只在这些项目 + 勾选；几个去处的写法；计划并成一份（去成任何一处就不算留下）", async () => {
  const { scopeIntent, scopeTargetsLabel, mergeScopePlans } = await import("../src/mcpView.ts");
  // 所有项目：用户级的行没改；项目的行移到用户级
  assert.deepEqual(scopeIntent("global", true, []), { blocked: "没有改动" });
  assert.deepEqual(scopeIntent("p:a", true, ["p:a"]), { mode: "move", targets: ["global"] });
  // 只在这些项目：没勾它自己＝移过去；勾着它自己＝在别处加一份；只勾它自己＝没改；一个都没勾＝不能确认
  assert.deepEqual(scopeIntent("global", false, ["p:a", "p:b"]), {
    mode: "move",
    targets: ["p:a", "p:b"],
  });
  assert.deepEqual(scopeIntent("p:a", false, ["p:b"]), { mode: "move", targets: ["p:b"] });
  assert.deepEqual(scopeIntent("p:a", false, ["p:a", "p:b"]), { mode: "copy", targets: ["p:b"] });
  assert.deepEqual(scopeIntent("p:a", false, ["p:a"]), { blocked: "没有改动" });
  assert.deepEqual(scopeIntent("global", false, []), { blocked: "勾上至少一个项目" });
  assert.equal(scopeTargetsLabel(["CardBox"]), "CardBox");
  assert.equal(scopeTargetsLabel(["CardBox", "weibo"]), "CardBox、weibo");
  assert.equal(scopeTargetsLabel(["a", "b", "c"]), "3 个项目");
  const nameOf = (id: string) => (id === "codex" ? "Codex" : id === "cc" ? "Claude Code" : id);
  const merged = mergeScopePlans(
    [
      {
        selections: [{ sourceId: "cc", name: "x", targetId: "A::cc" }],
        stays: ["Claude Desktop"],
        cant: [{ agent: "Codex", reason: "r" }],
      },
      {
        selections: [
          { sourceId: "cc", name: "x", targetId: "B::cc" },
          { sourceId: "codex", name: "x", targetId: "B::codex" },
        ],
        stays: ["Claude Desktop"],
        cant: [],
      },
    ],
    nameOf,
  );
  assert.equal(merged.selections.length, 3);
  assert.deepEqual(merged.stays, ["Claude Desktop"]);
  // Codex 去 A 不行、去 B 行：不算留下
  assert.deepEqual(merged.cant, []);
});
// ===== 界面说人话（spec #239 第 41–44 条，#277）=====

/// core 给的位置（`discover_locations`）：Claude Code 的 label 带英文作用域
const core = {
  user: {
    id: "claude-code",
    domain: "global",
    label: "Claude Code · User MCPs",
    harnessId: "claude-code",
    path: "/Users/me/.claude.json",
  },
  local: {
    id: "project:/Users/me/CardBox::claude-code:local",
    domain: "project:/Users/me/CardBox",
    label: "Claude Code · Local MCPs",
    harnessId: "claude-code",
    path: "/Users/me/.claude.json",
  },
  team: {
    id: "project:/Users/me/CardBox::claude-code",
    domain: "project:/Users/me/CardBox",
    label: "Claude Code · Project MCPs",
    harnessId: "claude-code",
    path: "/Users/me/CardBox/.mcp.json",
  },
  codex: {
    id: "project:/Users/me/CardBox::codex",
    domain: "project:/Users/me/CardBox",
    label: "Codex",
    harnessId: "codex",
    path: "/Users/me/CardBox/.codex/config.toml",
  },
} satisfies Record<string, McpLocation>;

test("「配置文件」列写位置名、不写路径：用户级只写 agent，项目里写 项目 · agent（与确认框同一套）", async () => {
  const { mcpOriginName } = await import("../src/mcpDiffTable.ts");
  const names = [
    mcpOriginName("用户级", core.user),
    mcpOriginName("CardBox", core.local),
    mcpOriginName("CardBox", core.team),
    mcpOriginName("CardBox", core.codex),
  ];
  assert.deepEqual(names, [
    "Claude Code",
    "CardBox · Claude Code 仅自己",
    "CardBox · Claude Code 团队共享",
    "CardBox · Codex",
  ]);
  for (const name of names) {
    assert.doesNotMatch(name, /MCPs|User|Local|Project|\//);
  }
});

test("确认框清单与挑选浮层：中文位置名，不出现 `Claude Code · User MCPs`", async () => {
  const { mcpCopyName } = await import("../src/mcpDiffTable.ts");
  const { mcpAgentName } = await import("../src/mcpView.ts");
  const names = Object.values(core).map((l) =>
    mcpCopyName(l.domain === "global" ? "用户级" : "CardBox", l),
  );
  assert.deepEqual(names, [
    "用户级 · Claude Code",
    "CardBox · Claude Code 仅自己",
    "CardBox · Claude Code 团队共享",
    "CardBox · Codex",
  ]);
  for (const name of names) assert.doesNotMatch(name, /MCPs/);
  // 原因句与提示条里的 agent：只写 agent 名
  assert.equal(mcpAgentName(core.user), "Claude Code");
  // 确认框清单、跳过的那几句与挑选浮层都取同一个名字（不是 core 的 label、也不是来源页的 `Claude Code · User`）
  const tab = readFileSync(new URL("../src/McpTab.tsx", import.meta.url), "utf8");
  assert.match(tab, /\{action\.name\} → \{copyNameOf\(action\.targetId\)\}/);
  assert.match(tab, /name: issue\.name \?\? copyNameOf\(issue\.locationId\)/);
  assert.match(tab, /<McpPickLayer[^]*?labelOf=\{copyNameOf\}/);
  assert.doesNotMatch(tab, /mcpLocationName/);
});

test("⊘ 格悬停：第一行说人话，第二行写具体原因；联网的 MCP 进不了 Claude Desktop 时直接说去哪加", async () => {
  const { mcpBlockedTip } = await import("../src/mcpView.ts");
  assert.deepEqual(
    mcpBlockedTip(
      {
        reason: "Claude Desktop 的远程服务器要在它自己的「连接器」里添加",
        reasonKind: "desktopRemote",
      },
      "Claude Desktop",
    ),
    { tip: "联网的 MCP 需在 Claude 桌面应用的「设置 › 连接器」中添加" },
  );
  assert.deepEqual(
    mcpBlockedTip({ reason: "Cursor 不支持 SSE 传输", reasonKind: "sseUnsupported" }, "Cursor"),
    { tip: "无法加到 Cursor", detail: "Cursor 不支持 SSE 传输" },
  );
  assert.deepEqual(
    mcpBlockedTip(
      {
        reason: "带有 ${…} 这类变量，只在 Codex 之间复制",
        reasonKind: "crossAgentVariables",
      },
      "Cursor",
    ),
    {
      tip: "无法加到 Cursor",
      detail: "带有 ${…} 这类变量，只在 Codex 之间复制",
    },
  );
});

test("写入失败：分不出原因的（core 给了原文）提示条只写失败句；分得出的接人话原因", async () => {
  const { mcpEntryReason, mcpFailedAt } = await import("../src/mcpView.ts");
  const told = { message: "没有写入权限，没动" };
  const raw = {
    message: "原子写入失败",
    detail: "Input/output error (os error 5)",
  };
  assert.equal(mcpEntryReason(told), "没有写入权限，没动");
  assert.equal(mcpEntryReason(raw), undefined);
  assert.equal(mcpFailedAt("Codex", told), "加到 Codex 失败 · 没有写入权限，没动");
  assert.equal(mcpFailedAt("Codex", raw), "加到 Codex 失败");
  assert.doesNotMatch(mcpFailedAt("Codex", raw), /原子写入|os error/);
});

test("写入的命令本身出错：横幅一句是「加到 X 失败」，原文与文件完整路径进「!」", async () => {
  const { mcpWriteFault } = await import("../src/mcpView.ts");
  const { appFaultView } = await import("../src/backendError.ts");
  const fault = mcpWriteFault("Permission denied (os error 13)", "加到 Codex 失败", [
    "~/CardBox/.codex/config.toml",
  ]);
  assert.deepEqual(appFaultView(fault), {
    message: "加到 Codex 失败",
    technical: "Permission denied (os error 13)\n~/CardBox/.codex/config.toml",
  });
  // 后端已经分好两层的（`[invalid] 一句`）原样交给横幅
  assert.deepEqual(
    appFaultView(mcpWriteFault("[invalid] 配置已变化，请重试", "加到 Codex 失败", ["~/a"])),
    { message: "配置已变化，请重试" },
  );
});
