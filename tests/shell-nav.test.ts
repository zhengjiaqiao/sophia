import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NAV,
  GLOBAL_KEY,
  faceOf,
  goDestination,
  goFace,
  goLocation,
  locationOf,
  locationsOf,
  migrateFromPlace,
  migrateScope,
  parseNav,
  resolveNav,
  serializeNav,
} from "../src/shell/nav.ts";

/// 导航状态（spec 2026-09-26-object-first-navigation R3 R12；2026-09-27-skill-mcp-market R1–R3）：
/// 目的地、位置、两页各自的面分开记

const A = "project:/w/a";
const B = "project:/w/b";
const CB = "project:/p/CardBox";

test("AC23 首次打开（没有记录、记录坏了）：落在 SKILLS · 我的 · 全部", () => {
  for (const raw of [null, "", "{不是 json", "42", "[]"]) {
    assert.deepEqual(parseNav(raw), DEFAULT_NAV, String(raw));
  }
  assert.equal(DEFAULT_NAV.destination, "skills");
  assert.deepEqual(DEFAULT_NAV.location, { skills: "all", mcp: "all" });
  assert.deepEqual(DEFAULT_NAV.face, { skills: "mine", mcp: "mine" });
});

test("R12 目的地与位置分开记：从模型页回到 SKILLS，位置仍是上次的", () => {
  const n = goDestination(goLocation(DEFAULT_NAV, A), "models");
  const back = parseNav(serializeNav(n));
  assert.deepEqual(back, n);
  assert.equal(locationOf(goDestination(back, "skills")), A);
});

test("认不得的字段逐项回到默认", () => {
  const n = parseNav(
    JSON.stringify({ destination: "用量", location: "/etc", face: { skills: "市场", mcp: 1 } }),
  );
  assert.deepEqual(n, DEFAULT_NAV);
  const u = parseNav(JSON.stringify({ destination: "mcp", location: "user" }));
  assert.deepEqual(
    u,
    { ...DEFAULT_NAV, destination: "mcp", location: { skills: "user", mcp: "user" } },
    "旧形状（两页共用一个位置）：两页都从它起步",
  );
});

test("位置两页各记各的（产品负责人：skill 和 mcp 的筛选项不绑定）", () => {
  const skillsOnA = goLocation(DEFAULT_NAV, A);
  assert.equal(locationOf(skillsOnA), A);
  const onMcp = goDestination(skillsOnA, "mcp");
  assert.equal(locationOf(onMcp), "all", "MCP 页没选过，仍是 全部");
  const mcpOnB = goLocation(onMcp, B);
  assert.equal(locationOf(goDestination(mcpOnB, "skills")), A, "回到 SKILLS 仍是 A");
  assert.deepEqual(parseNav(serializeNav(mcpOnB)), mcpOnB);
  const models = goDestination(DEFAULT_NAV, "models");
  assert.equal(goLocation(models, A), models, "模型页没有位置");
  const bad = parseNav(
    JSON.stringify({ destination: "skills", location: { skills: "/etc", mcp: A } }),
  );
  assert.deepEqual(bad.location, { skills: "all", mcp: A }, "逐页认");
});

test("AC1 R1 我的 ｜ 发现：两页各记各的；切到别的页再回来仍在上次那一面；存下来再读回来一样", () => {
  const skillsDiscover = goFace(DEFAULT_NAV, "discover");
  assert.equal(faceOf(skillsDiscover), "discover");
  const onMcp = goDestination(skillsDiscover, "mcp");
  assert.equal(faceOf(onMcp), "mine", "MCP 页没切过，仍是 我的");
  const back = goDestination(onMcp, "skills");
  assert.equal(faceOf(back), "discover", "回到 SKILLS 停在 发现");
  assert.deepEqual(parseNav(serializeNav(back)), back);
  assert.equal(goFace(back, "discover"), back, "已经在那一面：原样返回同一个对象");
  const models = goDestination(DEFAULT_NAV, "models");
  assert.equal(goFace(models, "discover"), models, "模型页没有面");
  assert.equal(faceOf(models), "mine");
});

test("AC4 R3 旧范围换算成位置：全部 / 项目级（未选）→ 全部；选了项目 → 它；用户级 → 用户级", () => {
  assert.equal(migrateScope({ level: "all", project: null }), "all");
  assert.equal(migrateScope({ level: "all", project: CB }), CB, "全部 + 项目 X → X");
  assert.equal(migrateScope({ level: "user", project: null }), "user");
  assert.equal(migrateScope({ level: "project", project: null }), "all", "项目级（未选）→ 全部");
  assert.equal(migrateScope({ level: "project", project: CB }), CB, "项目级 + CardBox → CardBox");
  assert.equal(migrateScope({ level: "everything" }), "all");
  assert.equal(migrateScope(null), "all");
});

test("AC4 R3 升级后打开：存着的旧形状（带 scope）直接换算；面默认 我的", () => {
  const old = (scope: unknown, destination = "mcp") =>
    parseNav(JSON.stringify({ destination, scope }));
  assert.deepEqual(old({ level: "project", project: CB }), {
    ...DEFAULT_NAV,
    destination: "mcp",
    location: { skills: CB, mcp: CB },
  });
  assert.equal(old({ level: "project", project: null }).location.mcp, "all");
  assert.equal(old({ level: "all", project: A }).location.skills, A);
  assert.equal(old({ level: "user", project: A }).location.mcp, "user");
  assert.equal(old({ level: "all", project: null }, "models").destination, "models");
});

test("AC4 R3 旧项目已经不在：项目列表读回来之后落回 全部", () => {
  const n = parseNav(
    JSON.stringify({ destination: "skills", scope: { level: "project", project: CB } }),
  );
  assert.equal(resolveNav(n, null, null), n, "还没读回来之前不动");
  assert.deepEqual(resolveNav(n, [A], null).location, { skills: "all", mcp: "all" });
});

test("AC24 更早的落点（sophia.shell.place）照样换算，读不懂的落默认、不报错", () => {
  const old = (o: unknown) => migrateFromPlace(JSON.stringify(o));
  assert.deepEqual(old({ view: "location", locationKey: "global", tab: "mcp", agentId: "codex" }), {
    ...DEFAULT_NAV,
    destination: "mcp",
    location: { skills: "user", mcp: "user" },
  });
  assert.deepEqual(old({ view: "location", locationKey: A, tab: "skills", agentId: "codex" }), {
    ...DEFAULT_NAV,
    destination: "skills",
    location: { skills: A, mcp: A },
  });
  assert.deepEqual(old({ view: "agent", locationKey: "global", tab: "skills", agentId: "codex" }), {
    ...DEFAULT_NAV,
    destination: "models",
    location: { skills: "user", mcp: "user" },
  });
  assert.deepEqual(old({ view: "settings", locationKey: A, tab: "mcp" })?.destination, "settings");
  assert.deepEqual(migrateFromPlace("一段读不懂的字符串"), DEFAULT_NAV);
  assert.equal(migrateFromPlace(null), null, "没有旧记忆就不迁移");
});

test("AC25 记着的项目不在了：回到全部；项目列表没读回来之前不动", () => {
  const proj = goLocation(DEFAULT_NAV, A);
  assert.equal(resolveNav(proj, null, null), proj);
  assert.equal(resolveNav(proj, [A, B], null), proj, "还在就原样返回同一个对象");
  assert.deepEqual(resolveNav(proj, [B], null).location, { skills: "all", mcp: "all" });
  const mcpOnA = goLocation(goDestination(DEFAULT_NAV, "mcp"), A);
  assert.deepEqual(
    resolveNav(goLocation(goDestination(mcpOnA, "skills"), B), [B], null).location,
    { skills: B, mcp: "all" },
    "只落回不在了的那一页",
  );
  const user = goLocation(DEFAULT_NAV, "user");
  assert.equal(resolveNav(user, [], null), user, "用户级、全部不看项目列表");
});

test("AC3 模型页不可用（非 macOS）：落到 SKILLS；还不知道时不动", () => {
  const m = goDestination(DEFAULT_NAV, "models");
  assert.equal(resolveNav(m, [], null), m);
  assert.equal(resolveNav(m, [], true), m);
  assert.equal(resolveNav(m, [], false).destination, "skills");
});

test("R11 用量页（⌘4）：落点记得住；这台机器没有用量（非 macOS）时落到 SKILLS，还不知道时不动", () => {
  const u = goDestination(DEFAULT_NAV, "usage");
  assert.equal(parseNav(serializeNav(u)).destination, "usage");
  assert.equal(resolveNav(u, [], null, null), u);
  assert.equal(resolveNav(u, [], null, true), u);
  assert.equal(resolveNav(u, [], null, false).destination, "skills");
  // 模型不可用不影响停在用量页
  assert.equal(resolveNav(u, [], false, true), u);
});

test("R2 位置算出这一屏涉及的位置：全部＝用户级 + 全部项目；用户级＝只有它；某个项目＝只有它", () => {
  const projects = [A, B];
  assert.deepEqual(locationsOf("all", projects), [GLOBAL_KEY, A, B]);
  assert.deepEqual(locationsOf("all", []), [GLOBAL_KEY], "没有项目时全部就是用户级");
  assert.deepEqual(locationsOf("user", projects), [GLOBAL_KEY]);
  assert.deepEqual(locationsOf(B, projects), [B], "某个项目不带用户级");
});
