import assert from "node:assert/strict";
import test from "node:test";
import {
  canSupplement,
  importedInDomain,
  mcpDomains,
  sourceForMissing,
  sourceForMissingTarget,
  supplementSourcesForTarget,
} from "../src/mcpView.ts";
import type { McpCellState, McpEntry, McpLocation, McpOverview } from "../src/types.ts";

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
  assert.equal(result[0].label, "全局");
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

  assert.equal(importedInDomain(page.rows[0].entries[0], page), true);
  assert.equal(sourceForMissingTarget(page.rows[0], "c"), null);
  assert.equal(canSupplement(page.rows[0].entries[0], new Set(["b"])), false);
});

test("导入状态由本域 own/equal 判定：部分引入已出现、冲突不算引入", () => {
  const [global, project] = mcpDomains(
    overview(
      [location("global-a"), location("project-a", "project:/work/a")],
      [entry("project-a", "arrived", { "global-a": "missing", "project-a": "own" })],
    ),
  );
  const external = entry("outside", "new-service", {
    "global-a": "equal",
    "project-a": "conflict",
  });
  const absent = entry("outside", "absent", { "global-a": "missing", "project-a": "missing" });

  assert.equal(importedInDomain(project.rows[0].entries[0], project), true);
  assert.equal(importedInDomain(external, global), true);
  assert.equal(importedInDomain(external, project), false);
  assert.equal(importedInDomain(absent, global), false);
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

  assert.equal(importedInDomain(source, result[0]), true);
  assert.equal(canSupplement(source, new Set(["cursor"])), true);
  assert.equal(canSupplement(source, new Set(["claude", "codex"])), false);
});

test("共享 agents.db 的 WeiboAP agent 仍是独立域，导入按目标 id 判定", () => {
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
  const onlyFirst = entry("outside", "same-service", {
    [agentOne.id]: "equal",
    [agentTwo.id]: "missing",
  });

  assert.equal(agentOne.path, agentTwo.path);
  assert.deepEqual([first.key, second.key], [agentOne.domain, agentTwo.domain]);
  assert.deepEqual([first.label, second.label], ["WeiboAP · agent-1", "WeiboAP · agent-2"]);
  assert.deepEqual(
    [first.rows[0].entries[0].sourceId, second.rows[0].entries[0].sourceId],
    [agentOne.id, agentTwo.id],
  );
  assert.equal(importedInDomain(onlyFirst, first), true);
  assert.equal(importedInDomain(onlyFirst, second), false);
});
