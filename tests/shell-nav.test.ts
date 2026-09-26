import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NAV,
  GLOBAL_KEY,
  goDestination,
  goLevel,
  goProject,
  locationsOf,
  migrateFromPlace,
  parseNav,
  resolveNav,
  serializeNav,
} from "../src/shell/nav.ts";

/// 导航状态（spec 2026-09-26-object-first-navigation R3 R4 R12）：目的地与范围分开记

const A = "project:/w/a";
const B = "project:/w/b";

test("AC23 首次打开（没有记录、记录坏了）：落在 SKILLS · 全部", () => {
  for (const raw of [null, "", "{不是 json", "42", "[]"]) {
    assert.deepEqual(parseNav(raw), DEFAULT_NAV, String(raw));
  }
  assert.equal(DEFAULT_NAV.destination, "skills");
  assert.deepEqual(DEFAULT_NAV.scope, { level: "all", project: null });
});

test("R12 目的地与范围分开记：从模型页回到 SKILLS，范围仍是上次的", () => {
  const n = goDestination(goProject(goLevel(DEFAULT_NAV, "project"), A), "models");
  const back = parseNav(serializeNav(n));
  assert.deepEqual(back, n);
  assert.deepEqual(goDestination(back, "skills").scope, { level: "project", project: A });
});

test("认不得的字段逐项回到默认；用户级不带项目", () => {
  const n = parseNav(
    JSON.stringify({ destination: "用量", scope: { level: "everything", project: "/etc" } }),
  );
  assert.deepEqual(n, DEFAULT_NAV);
  const u = parseNav(JSON.stringify({ destination: "mcp", scope: { level: "user", project: A } }));
  assert.deepEqual(u, { destination: "mcp", scope: { level: "user", project: null } });
});

test("AC24 升级：旧记忆按规则换算，读不懂的落默认、不报错", () => {
  const old = (o: unknown) => migrateFromPlace(JSON.stringify(o));
  assert.deepEqual(old({ view: "location", locationKey: "global", tab: "mcp", agentId: "codex" }), {
    destination: "mcp",
    scope: { level: "user", project: null },
  });
  assert.deepEqual(old({ view: "location", locationKey: A, tab: "skills", agentId: "codex" }), {
    destination: "skills",
    scope: { level: "project", project: A },
  });
  assert.deepEqual(old({ view: "agent", locationKey: "global", tab: "skills", agentId: "codex" }), {
    destination: "models",
    scope: { level: "user", project: null },
  });
  assert.deepEqual(old({ view: "settings", locationKey: A, tab: "mcp" }).destination, "settings");
  assert.deepEqual(migrateFromPlace("一段读不懂的字符串"), DEFAULT_NAV);
  assert.equal(migrateFromPlace(null), null, "没有旧记忆就不迁移");
});

test("AC25 记着的项目不在了：回到同一档的全部；项目列表没读回来之前不动", () => {
  const proj = goProject(goLevel(DEFAULT_NAV, "project"), A);
  assert.equal(resolveNav(proj, null, null), proj);
  assert.equal(resolveNav(proj, [A, B], null), proj, "还在就原样返回同一个对象");
  assert.deepEqual(resolveNav(proj, [B], null).scope, { level: "project", project: null });
  const all = goProject(DEFAULT_NAV, A);
  assert.deepEqual(resolveNav(all, [B], null).scope, { level: "all", project: null });
});

test("AC3 模型页不可用（非 macOS）：落到 SKILLS；还不知道时不动", () => {
  const m = goDestination(DEFAULT_NAV, "models");
  assert.equal(resolveNav(m, [], null), m);
  assert.equal(resolveNav(m, [], true), m);
  assert.equal(resolveNav(m, [], false).destination, "skills");
});

test("切档：用户级不带项目；全部与项目级之间保留选中的项目", () => {
  const all = goProject(DEFAULT_NAV, A);
  assert.deepEqual(goLevel(all, "user").scope, { level: "user", project: null });
  assert.deepEqual(goLevel(all, "project").scope, { level: "project", project: A });
  assert.deepEqual(goLevel(goLevel(all, "project"), "all").scope, { level: "all", project: A });
});

test("R4 范围算出这一屏涉及的位置", () => {
  const projects = [A, B];
  const s = (level: "all" | "user" | "project", project: string | null = null) => ({
    level,
    project,
  });
  assert.deepEqual(locationsOf(s("all"), projects), [GLOBAL_KEY, A, B]);
  assert.deepEqual(
    locationsOf(s("all", B), projects),
    [GLOBAL_KEY, B],
    "全部下点项目＝用户级 + 它",
  );
  assert.deepEqual(locationsOf(s("user"), projects), [GLOBAL_KEY]);
  assert.deepEqual(locationsOf(s("project"), projects), [A, B]);
  assert.deepEqual(locationsOf(s("project", A), projects), [A]);
  assert.deepEqual(locationsOf(s("project"), []), [], "没有项目时项目级是空的");
});

test("范围的键：档或选中的项目变了才变（两页据此清空勾选、收起来源页）", async () => {
  const { scopeKeyOf } = await import("../src/shell/nav.ts");
  const a = scopeKeyOf({ level: "all", project: null });
  assert.equal(a, scopeKeyOf({ level: "all", project: null }));
  assert.notEqual(a, scopeKeyOf({ level: "user", project: null }));
  assert.notEqual(a, scopeKeyOf({ level: "all", project: "project:/p/CardBox" }));
  assert.notEqual(
    scopeKeyOf({ level: "all", project: "project:/p/CardBox" }),
    scopeKeyOf({ level: "project", project: "project:/p/CardBox" }),
  );
});
