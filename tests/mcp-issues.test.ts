import assert from "node:assert/strict";
import test from "node:test";
import { collectMcpIssues, differingFields, mcpDomains, mcpGroupOf } from "../src/mcpView.ts";
import { issueKey } from "../src/pages/pendingIssues.ts";
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
const cell = (targetId: string, state: McpCell["state"], reason: string | null = null): McpCell => ({
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

test("collectMcpIssues：两份不一样与读不出来，形状稳定、key 与 core 同公式", () => {
  const items = collectMcpIssues(overview());
  const diff = items.find((i) => i.kind === "differentCopies");
  assert.ok(diff);
  assert.equal(diff.name, "notion");
  assert.equal(diff.domain, "global");
  assert.deepEqual(diff.detailFields, ["url"]);
  assert.deepEqual(
    diff.locations.map((l) => l.id),
    ["cc", "cline"],
  );
  assert.deepEqual(diff.paths, ["/cc.json", "/cline.json", "#notion"]);
  assert.equal(diff.key, issueKey("differentCopies", diff.paths));

  const whole = items.find((i) => i.kind === "invalidLocation" && i.name === null);
  assert.ok(whole);
  assert.equal(whole.key, issueKey("invalidLocation", ["/codex.json"]));
  assert.equal(whole.domain, "project:/p");
  const one = items.find((i) => i.kind === "invalidLocation" && i.name === "x");
  assert.ok(one);
  assert.deepEqual(one.paths, ["/cline.json#x"]);
  assert.match(one.title, /CLINE 里的 x 这次读不出来/);
});

test("collectMcpIssues：按域收、滤掉已忽略的", () => {
  const all = collectMcpIssues(overview());
  assert.equal(collectMcpIssues(overview(), { domains: ["project:/p"] }).length, 1);
  const ignored = new Set([all[0].key]);
  assert.equal(collectMcpIssues(overview(), { ignored }).length, all.length - 1);
  assert.deepEqual(collectMcpIssues(null), []);
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
