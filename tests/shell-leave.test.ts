import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { changesPage, createLeaveGuards } from "../src/shell/leaveGuard.ts";
import { DEFAULT_NAV, goDestination, goLevel, goProject } from "../src/shell/nav.ts";

// 离开前询问（DESIGN「agent 页 › 离开时有没保存的表单」）：外壳一个接口，所有换页的路都经它

test("没人登记：当场走；登记了：交给它问，它调 proceed 才走、不调就不走", () => {
  const guards = createLeaveGuards();
  let went = 0;
  guards.request(() => went++);
  assert.equal(went, 1);

  let asked: (() => void) | null = null;
  const unregister = guards.register((proceed) => {
    asked = proceed;
  });
  guards.request(() => went++);
  assert.equal(went, 1, "问的时候还没走");
  assert.ok(asked);
  (asked as () => void)();
  assert.equal(went, 2, "问完（保存 / 丢弃）才走");

  unregister();
  guards.request(() => went++);
  assert.equal(went, 3, "撤销登记之后不再拦");
});

test("几个同时登记时最上面（最后登记）的那个问；撤销中间的一个不影响别的", () => {
  const guards = createLeaveGuards();
  const who: string[] = [];
  const offA = guards.register(() => who.push("a"));
  const offB = guards.register(() => who.push("b"));
  guards.request(() => who.push("went"));
  assert.deepEqual(who, ["b"]);
  offA();
  guards.request(() => who.push("went"));
  assert.deepEqual(who, ["b", "b"]);
  offB();
  guards.request(() => who.push("went"));
  assert.deepEqual(who, ["b", "b", "went"]);
});

test("changesPage：目的地变了、或 SKILLS / MCP 上换了范围才算离开；只改记着的范围不算", () => {
  const models = goDestination(DEFAULT_NAV, "models");
  assert.equal(changesPage(DEFAULT_NAV, models), true);
  assert.equal(changesPage(models, goDestination(models, "settings")), true);
  assert.equal(changesPage(models, goDestination(models, "models")), false, "再点一下模型不问");
  assert.equal(changesPage(DEFAULT_NAV, goLevel(DEFAULT_NAV, "user")), true);
  assert.equal(changesPage(DEFAULT_NAV, goProject(DEFAULT_NAV, "project:/a")), true);
  assert.equal(changesPage(DEFAULT_NAV, goDestination(DEFAULT_NAV, "mcp")), true);
  assert.equal(
    changesPage(models, goProject(models, "project:/a")),
    false,
    "停在模型页时改的是记着的范围，这一页没换",
  );
  const settings = goDestination(DEFAULT_NAV, "settings");
  assert.equal(changesPage(settings, goDestination(settings, "settings")), false);
});

test("壳里所有换页的路都经 navigate / requestLeave：侧栏、范围滑槽、项目筛选片、托盘跳转、应用菜单（含 ⌘[ ⌘P）", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(
    app,
    /if \(changesPage\(navRef\.current, to\(navRef\.current\)\)\) requestLeave\(go\);/,
  );
  assert.match(app, /onSelect=\{\(d\) => navigate\(\(n\) => goDestination\(n, d\)\)\}/);
  assert.match(app, /onChange=\{\(level\) => navigate\(\(n\) => goLevel\(n, level\)\)\}/);
  assert.match(app, /onSelect=\{\(project\) => navigate\(\(n\) => goProject\(n, project\)\)\}/);
  assert.match(app, /payload\.page === "settings"\) navigate\(/);
  assert.match(app, /payload\.page === "models"\) navigate\(/);
  assert.match(app, /if \(route\.nav !== navRef\.current\) navigate\(\(\) => route\.nav, act\);/);
  assert.match(app, /else if \(route\.page === "back"\) requestLeave\(act\);/);
  // 用户换页不直接 setNav（只剩 navigate 自己与落点纠正这两处壳内部的）
  const direct = [...app.matchAll(/setNav\(/g)].length;
  assert.equal(direct, 2, "新的直接 setNav 要先想清楚它是不是用户换页");
});

test("Codex 页网关表单接上外壳的离开前询问，不再自己在 document 上拦侧栏点击", () => {
  const tsx = readFileSync(new URL("../src/ModelsGateways.tsx", import.meta.url), "utf8");
  assert.match(tsx, /useLeaveGuard\(formDirty && editing !== null, \(proceed\) => \{/);
  assert.doesNotMatch(tsx, /LEAVE_TARGET|addEventListener\("click"|target\.click\(\)/);
});
