import assert from "node:assert/strict";
import test from "node:test";
import { createMcpLoader, type McpLoadState } from "../src/market/mcpRefresh.ts";
import type { McpList, McpRow } from "../src/types.ts";
const row = (name: string) =>
  ({
    name,
    id: name,
    publisher: "test",
    description: name,
    installedIn: [],
    fields: [],
    definition: { name, transport: "stdio", command: "uvx", args: [name] },
  }) as unknown as McpRow;
const list = (name: string, stale = false): McpList => ({
  curated: [],
  registry: [row(name)],
  fallback: null,
  searchCache: { updatedAt: 100, refreshNeeded: stale },
});
const local = (): McpList => ({ curated: [row("git")], registry: [], fallback: null });
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const immediate = (f: () => void) => {
  f();
  return () => {};
};
test("AC1 精选独立于未完成的官方请求出现", async () => {
  const remote = deferred<McpList>();
  const states: McpLoadState[] = [];
  const loader = createMcpLoader(
    async () => local(),
    async () => ({
      ...list(""),
      registry: [],
      searchCache: { updatedAt: null, refreshNeeded: true },
    }),
    () => remote.promise,
    (s) => states.push(s),
    immediate,
  );
  loader.load("git");
  await settle();
  assert.equal(states.at(-1)?.data?.curated[0].name, "git");
  assert.equal(states.at(-1)?.refreshing, true);
  remote.resolve(list("online"));
  await settle();
  assert.equal(states.at(-1)?.data?.curated[0].name, "git");
  assert.equal(states.at(-1)?.data?.registry[0].name, "online");
  loader.dispose();
});
test("AC2 新鲜缓存不联网；过期缓存先显示再替换", async () => {
  let calls = 0;
  const states: McpLoadState[] = [];
  const remote = deferred<McpList>();
  const loader = createMcpLoader(
    async () => local(),
    async (q) => list("cached", q === "stale"),
    () => {
      calls++;
      return remote.promise;
    },
    (s) => states.push(s),
    immediate,
  );
  loader.load("fresh");
  await settle();
  assert.equal(states.at(-1)?.data?.registry[0].name, "cached");
  assert.equal(calls, 0);
  loader.load("stale");
  await settle();
  assert.equal(states.at(-1)?.data?.registry[0].name, "cached");
  assert.equal(calls, 1);
  remote.resolve(list("new"));
  await settle();
  assert.equal(states.at(-1)?.data?.registry[0].name, "new");
  loader.dispose();
});
test("AC3 更新失败保留缓存与精选", async () => {
  const states: McpLoadState[] = [];
  const loader = createMcpLoader(
    async () => local(),
    async () => list("old", true),
    async () => {
      throw new Error("目录离线 offline");
    },
    (s) => states.push(s),
    immediate,
  );
  loader.load("git");
  await settle();
  assert.equal(states.at(-1)?.data?.registry[0].name, "old");
  assert.equal(states.at(-1)?.data?.curated[0].name, "git");
  assert.equal(states.at(-1)?.refreshing, false);
  assert.match(states.at(-1)?.error ?? "", /offline/);
  loader.dispose();
});
test("AC3 旧在线响应与卸载后的响应不能覆盖新查询", async () => {
  const old = deferred<McpList>();
  const states: McpLoadState[] = [];
  const loader = createMcpLoader(
    async () => local(),
    async (q) => list(q, q === "old"),
    () => old.promise,
    (s) => states.push(s),
    immediate,
  );
  loader.load("old");
  await settle();
  loader.load("new");
  await settle();
  old.resolve(list("late"));
  await settle();
  assert.equal(states.at(-1)?.query, "new");
  assert.equal(states.at(-1)?.data?.registry[0].name, "new");
  loader.dispose();
  const n = states.length;
  loader.load("gone");
  await settle();
  assert.equal(states.length, n);
});

test("AC2 空的有效缓存也不联网；空查询只读取精选", async () => {
  let calls = 0;
  const states: McpLoadState[] = [];
  const loader = createMcpLoader(
    async () => local(),
    async () => ({ ...list("unused"), registry: [] }),
    async () => {
      calls++;
      return list("network");
    },
    (s) => states.push(s),
    immediate,
  );
  loader.load("none");
  await settle();
  assert.equal(states.at(-1)?.loading, false);
  assert.equal(states.at(-1)?.data?.registry.length, 0);
  loader.load("");
  await settle();
  assert.equal(calls, 0);
  assert.equal(states.at(-1)?.data?.curated[0].name, "git");
  loader.dispose();
});

test("AC3 离开页面时未完成的缓存读取不能触发后台请求", async () => {
  const cache = deferred<McpList>();
  const states: McpLoadState[] = [];
  let requests = 0;
  const loader = createMcpLoader(
    async () => local(),
    () => cache.promise,
    async () => {
      requests++;
      return list("network");
    },
    (s) => states.push(s),
    immediate,
  );
  loader.load("git");
  await settle();
  loader.dispose();
  const before = states.length;
  cache.resolve(list("old", true));
  await settle();
  assert.equal(requests, 0);
  assert.equal(states.length, before);
});
