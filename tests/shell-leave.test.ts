import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { changesPage, createLeaveGuards } from "../src/shell/leaveGuard.ts";
import { DEFAULT_PLACE, goAgent, goLocation, goSettings, goTab } from "../src/shell/place.ts";

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

test("changesPage：目的地、agent、位置、页签变了才算离开；只改记着的字段不算", () => {
  const codex = goAgent(DEFAULT_PLACE, "codex");
  assert.equal(changesPage(DEFAULT_PLACE, codex), true);
  assert.equal(changesPage(codex, goSettings(codex)), true);
  assert.equal(changesPage(codex, goAgent(codex, "codex")), false, "再点一下 Codex 不问");
  assert.equal(changesPage(codex, goAgent(codex, "claude-code")), true);
  assert.equal(changesPage(DEFAULT_PLACE, goLocation(DEFAULT_PLACE, "project:/a")), true);
  assert.equal(changesPage(DEFAULT_PLACE, goTab(DEFAULT_PLACE, "mcp")), true);
  const settings = goSettings(DEFAULT_PLACE);
  assert.equal(changesPage(settings, goSettings(settings)), false);
});

test("壳里所有换页的路都经 navigate / requestLeave：侧栏、页签、托盘跳转、应用菜单（含 ⌘[）", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(
    app,
    /if \(changesPage\(placeRef\.current, to\(placeRef\.current\)\)\) requestLeave\(go\);/,
  );
  assert.match(app, /onSelectLocation=\{\(key\) => navigate\(/);
  assert.match(app, /onSelectAgent=\{\(id\) => navigate\(/);
  assert.match(app, /onSelectSettings=\{\(\) => navigate\(goSettings\)\}/);
  assert.match(app, /onChange=\{\(tab\) => navigate\(/);
  assert.match(app, /payload\.page === "settings"\) navigate\(goSettings\)/);
  assert.match(app, /payload\.page === "models"\) navigate\(/);
  assert.match(
    app,
    /if \(route\.place !== placeRef\.current\) navigate\(\(\) => route\.place, act\);/,
  );
  assert.match(app, /else if \(route\.page === "back"\) requestLeave\(act\);/);
  // 用户换页不再直接 setPlace（只剩 navigate 自己、落点纠正与移除 / 撤销项目这几处壳内部的）
  const direct = [...app.matchAll(/setPlace\(/g)].length;
  assert.equal(direct, 4, "新的直接 setPlace 要先想清楚它是不是用户换页");
});

test("Codex 页网关表单接上外壳的离开前询问，不再自己在 document 上拦侧栏点击", () => {
  const tsx = readFileSync(new URL("../src/ModelsGateways.tsx", import.meta.url), "utf8");
  assert.match(tsx, /useLeaveGuard\(formDirty && editing !== null, \(proceed\) => \{/);
  assert.doesNotMatch(tsx, /LEAVE_TARGET|addEventListener\("click"|target\.click\(\)/);
});
