import assert from "node:assert/strict";
import test from "node:test";
import { differingFields, mcpDomains, mcpGroupOf } from "../src/mcpView.ts";
import type { McpCell, McpEntry, McpLocation, McpOverview } from "../src/types.ts";

const loc = (id: string, domain = "global"): McpLocation => ({
  id,
  domain,
  label: id.toUpperCase(),
  harnessId: id,
  path: `/${id}.json`,
});
const entry = (sourceId: string, name: string, cells: McpCell[]): McpEntry => ({
  sourceId,
  name,
  transport: "http",
  reason: null,
  cells,
});
const cell = (
  targetId: string,
  state: McpCell["state"],
  reason: string | null = null,
): McpCell => ({
  targetId,
  state,
  reason,
});

const overview = (): McpOverview => ({
  locations: [loc("cc"), loc("cline"), loc("codex", "project:/p")],
  entries: [
    entry("cc", "notion", [cell("cc", "own"), cell("cline", "conflict", "URL 不同")]),
    entry("cline", "notion", [cell("cline", "own"), cell("cc", "conflict", "URL 不同")]),
    entry("cc", "figma", [cell("cc", "own"), cell("cline", "missing")]),
  ],
  issues: [
    { locationId: "codex", name: null, message: "坏了" },
    { locationId: "cline", name: "x", message: "不是对象" },
  ],
});

test("differingFields：只认得出 url；有一处说不清就不报字段（调用方写「配置不一样」）", () => {
  const page = mcpDomains(overview())[0];
  const ids = new Set(page.targets.map((t) => t.id));
  const notion = page.rows.find((r) => r.name === "notion");
  assert.ok(notion);
  assert.deepEqual(differingFields(notion, ids), ["url"]);
  const vague = {
    name: "n",
    entries: [entry("cc", "n", [cell("cline", "conflict", "同名配置不同")])],
  };
  assert.deepEqual(differingFields(vague, ids), []);
  assert.equal(mcpGroupOf(notion), "cc");
});
