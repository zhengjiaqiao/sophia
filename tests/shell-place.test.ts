import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PLACE,
  GLOBAL_KEY,
  goAgent,
  goLocation,
  goSettings,
  goTab,
  parsePlace,
  resolvePlace,
  selectionOf,
  serializePlace,
} from "../src/shell/place.ts";

/// 落点（D2）：首次全局 · skills；记住侧栏选中项与页签；记着的东西不在了就落回去

test("没有记录、记录坏了：落在全局 · skills", () => {
  assert.deepEqual(parsePlace(null), DEFAULT_PLACE);
  assert.deepEqual(parsePlace(""), DEFAULT_PLACE);
  assert.deepEqual(parsePlace("{不是 json"), DEFAULT_PLACE);
  assert.deepEqual(parsePlace("42"), DEFAULT_PLACE);
  assert.equal(DEFAULT_PLACE.view, "location");
  assert.equal(DEFAULT_PLACE.locationKey, GLOBAL_KEY);
  assert.equal(DEFAULT_PLACE.tab, "skills");
});

test("停在 Codex 页退出、再开仍在 Codex 页，且记着上次的位置与页签", () => {
  const p = goAgent(goTab(goLocation(DEFAULT_PLACE, "project:/w/a"), "mcp"), "codex");
  const back = parsePlace(serializePlace(p));
  assert.deepEqual(back, p);
  assert.deepEqual(selectionOf(back), { kind: "agent", id: "codex" });
  assert.equal(back.locationKey, "project:/w/a");
  assert.equal(back.tab, "mcp");
});

test("认不得的字段逐项回到默认", () => {
  const p = parsePlace(JSON.stringify({ view: "模型", locationKey: "/etc", tab: "models" }));
  assert.deepEqual(p, DEFAULT_PLACE);
});

test("记着的项目被移除了：落全局，页签不变；项目列表没读回来之前不动", () => {
  const p = goTab(goLocation(DEFAULT_PLACE, "project:/w/gone"), "mcp");
  assert.equal(resolvePlace(p, null, null), p);
  const r = resolvePlace(p, ["project:/w/a"], null);
  assert.equal(r.locationKey, GLOBAL_KEY);
  assert.equal(r.tab, "mcp");
  assert.equal(resolvePlace(p, ["project:/w/gone"], null), p, "还在就原样返回同一个对象");
});

test("Codex 页不存在（非 macOS）：落回位置页", () => {
  const p = goAgent(DEFAULT_PLACE, "codex");
  assert.equal(resolvePlace(p, [], null), p);
  assert.equal(resolvePlace(p, [], []).view, "location");
  assert.equal(resolvePlace(p, [], ["codex"]), p);
});

test("侧栏全栏只有一项选中：位置、agent、设置三选一", () => {
  assert.deepEqual(selectionOf(DEFAULT_PLACE), { kind: "location", key: GLOBAL_KEY });
  assert.deepEqual(selectionOf(goSettings(DEFAULT_PLACE)), { kind: "settings" });
  const back = goLocation(goSettings(DEFAULT_PLACE), "project:/w/a");
  assert.deepEqual(selectionOf(back), { kind: "location", key: "project:/w/a" });
});
