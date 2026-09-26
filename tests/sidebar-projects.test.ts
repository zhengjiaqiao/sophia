import assert from "node:assert/strict";
import test from "node:test";
import { sortProjects, unionProjects } from "../src/sidebarProjects.ts";
import type { ProjectTimes } from "../src/types.ts";

test("unionProjects：skill ∪ MCP 两边自动发现的，去重，用户级不进列表，名字优先取 skill 那边；没有手动添加的一路", () => {
  const list = unionProjects(
    [
      { key: "global", label: "用户级" },
      { key: "project:/w/a", label: "a" },
      { key: "project:/w/agent", label: "WeiboAP · agent" },
    ],
    [
      { key: "global", label: "用户级" },
      { key: "project:/w/agent", label: "别的名字" },
      { key: "project:/w/mcp-only", label: "mcp-only" },
    ],
  );
  assert.deepEqual(
    list.map((p) => [p.key, p.label, p.path]),
    [
      ["project:/w/a", "a", "/w/a"],
      ["project:/w/agent", "WeiboAP · agent", "/w/agent"],
      ["project:/w/mcp-only", "mcp-only", "/w/mcp-only"],
    ],
  );
});

test("sortProjects：按所选时间从新到旧，没有时间的排最后，同一时间保持原序", () => {
  const list = unionProjects(
    ["/w/a", "/w/b", "/w/c", "/w/d"].map((p) => ({ key: `project:${p}`, label: p })),
    [],
  );
  const times = new Map<string, ProjectTimes>([
    ["/w/a", { path: "/w/a", lastActive: 100, created: 400 }],
    ["/w/b", { path: "/w/b", lastActive: 300, created: 100 }],
    ["/w/c", { path: "/w/c", lastActive: null, created: 200 }],
  ]);
  assert.deepEqual(
    sortProjects(list, times, "active").map((p) => p.path),
    ["/w/b", "/w/a", "/w/c", "/w/d"],
  );
  assert.deepEqual(
    sortProjects(list, times, "created").map((p) => p.path),
    ["/w/a", "/w/c", "/w/b", "/w/d"],
  );
});
