import assert from "node:assert/strict";
import test from "node:test";
import { createSkillLoader, type SkillLoadState } from "../src/market/popularRefresh.ts";
import type { SkillList } from "../src/types.ts";

const listing = (name: string, stale = false): SkillList => ({
  items: [
    { name, repo: "test/repo", path: null, installs: 1, skillId: name, installedIn: ["global"] },
  ],
  fallback: null,
  popular: {
    source: stale ? "bundled" : "online",
    updatedAt: stale ? null : 123,
    refreshNeeded: stale,
  },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("AC1 缓存先发布，再启动在线刷新；在线替换保留条目安装信息", async () => {
  const online = deferred<SkillList>();
  const calls: boolean[] = [];
  const states: SkillLoadState[] = [];
  const loader = createSkillLoader(
    async (refresh = false) => {
      calls.push(refresh);
      if (refresh) {
        assert.equal(states.at(-1)?.data?.items[0].name, "cached");
        return online.promise;
      }
      return listing("cached", true);
    },
    async () => listing("searched"),
    (state) => states.push(state),
  );
  loader.load("");
  await settle();
  assert.deepEqual(calls, [false, true]);
  // 过期后的后台刷新不显示忙碌（DESIGN-components「后台例行读取不显示任何忙碌」）
  assert.equal(states.at(-1)?.refreshing, false);
  online.resolve(listing("online"));
  await settle();
  assert.equal(states.at(-1)?.data?.items[0].name, "online");
  assert.deepEqual(states.at(-1)?.data?.items[0].installedIn, ["global"]);
  assert.equal(states.at(-1)?.refreshing, false);
});

test("AC2 新鲜缓存不自动联网；手动刷新传 force 并合并前端并发", async () => {
  const online = deferred<SkillList>();
  const calls: [boolean, boolean][] = [];
  const loader = createSkillLoader(
    async (refresh = false, force = false) => {
      calls.push([refresh, force]);
      return refresh ? online.promise : listing("cached");
    },
    async () => listing("searched"),
    () => {},
  );
  loader.load("");
  await settle();
  assert.deepEqual(calls, [[false, false]]);
  loader.refresh(true);
  loader.refresh(true);
  assert.deepEqual(calls, [
    [false, false],
    [true, true],
  ]);
  online.resolve(listing("online"));
  await settle();
});

test("AC3 刷新抛错保留成功列表并显示错误，允许重试", async () => {
  const states: SkillLoadState[] = [];
  const loader = createSkillLoader(
    async (refresh = false) => {
      if (refresh) throw new Error("榜单暂时取不到");
      return listing("cached");
    },
    async () => listing("searched"),
    (state) => states.push(state),
  );
  loader.load("");
  await settle();
  loader.refresh(true);
  await settle();
  assert.equal(states.at(-1)?.data?.items[0].name, "cached");
  assert.equal(states.at(-1)?.error, "榜单暂时取不到");
  assert.equal(states.at(-1)?.refreshing, false);
});

test("AC5 搜索开始后丢弃晚到热门；失效和卸载后不发布", async () => {
  const online = deferred<SkillList>();
  const states: SkillLoadState[] = [];
  const loader = createSkillLoader(
    async (refresh = false) => (refresh ? online.promise : listing("cached", true)),
    async () => listing("searched"),
    (state) => states.push(state),
  );
  loader.load("");
  await settle();
  loader.invalidate();
  loader.load("ppt");
  await settle();
  online.resolve(listing("late"));
  await settle();
  assert.equal(states.at(-1)?.query, "ppt");
  assert.equal(states.at(-1)?.data?.items[0].name, "searched");
  const count = states.length;
  loader.dispose();
  loader.load("");
  loader.refresh(true);
  await settle();
  assert.equal(states.length, count);
});

test("AC3 热门重读失败仍保留现有列表，搜索失败不冒充旧结果", async () => {
  const states: SkillLoadState[] = [];
  const loader = createSkillLoader(
    async () => {
      throw new Error("缓存暂时无法读取");
    },
    async () => {
      throw new Error("搜索暂时不可用");
    },
    (state) => states.push(state),
    { query: "", data: listing("cached"), error: null, loading: false, refreshing: false },
  );
  loader.load("");
  await settle();
  assert.equal(states.at(-1)?.data?.items[0].name, "cached");
  assert.equal(states.at(-1)?.loading, false);
  loader.load("ppt");
  await settle();
  assert.equal(states.at(-1)?.data, null);
  assert.equal(states.at(-1)?.query, "ppt");
});

test("AC5 页面离开后，未完成的缓存读取不触发在线刷新或发布", async () => {
  const cached = deferred<SkillList>();
  let calls = 0;
  const states: SkillLoadState[] = [];
  const loader = createSkillLoader(
    async () => {
      calls++;
      return cached.promise;
    },
    async () => listing("searched"),
    (state) => states.push(state),
  );
  loader.load("");
  const before = states.length;
  loader.dispose();
  cached.resolve(listing("late", true));
  await settle();
  assert.equal(states.length, before);
  assert.equal(calls, 1);
});

test("AC3 后端降级结果保留榜单和失败信息，刷新结束后仍可再次请求", async () => {
  const fallback = { service: "skills.sh", cachedAt: 123, rateLimited: false };
  const states: SkillLoadState[] = [];
  let refreshes = 0;
  const loader = createSkillLoader(
    async (refresh = false) => {
      if (refresh) {
        refreshes++;
        return { ...listing("cached"), fallback };
      }
      return listing("cached");
    },
    async () => listing("searched"),
    (state) => states.push(state),
  );
  loader.load("");
  await settle();
  loader.refresh(true);
  await settle();
  assert.equal(states.at(-1)?.data?.fallback, fallback);
  assert.equal(states.at(-1)?.data?.items[0].name, "cached");
  assert.equal(states.at(-1)?.refreshing, false);
  loader.refresh();
  await settle();
  assert.equal(refreshes, 2);
});

test("AC5 卸载后忽略已发出的请求响应", async () => {
  const pending = deferred<SkillList>();
  const states: SkillLoadState[] = [];
  const loader = createSkillLoader(
    async () => pending.promise,
    async () => pending.promise,
    (state) => states.push(state),
  );
  loader.load("");
  const count = states.length;
  loader.dispose();
  pending.resolve(listing("late"));
  await settle();
  assert.equal(states.length, count);
});
