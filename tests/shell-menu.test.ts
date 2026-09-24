import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  FIXED_COMMANDS,
  isMenuCommand,
  MENU_COMMANDS,
  menuState,
  routeMenuCommand,
} from "../src/shell/menuCommands.ts";
import { DEFAULT_PLACE, goAgent, goLocation, goSettings } from "../src/shell/place.ts";
import { tidyItems } from "../src/contextMenu.ts";

/// 应用菜单（D15）：每一项都是界面上已有入口的另一条路

test("前端的命令表与 src-tauri/src/menu.rs 一一对应；页签项两边读同一个 domain 文件", () => {
  const rs = readFileSync(new URL("../src-tauri/src/menu.rs", import.meta.url), "utf8");
  const ids = [...rs.matchAll(/= item\("([a-z-]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(ids, [...FIXED_COMMANDS].sort());
  assert.match(rs, /include_str!\("\.\.\/\.\.\/src\/shell\/locationDomains\.json"\)/);
  assert.ok(MENU_COMMANDS.includes("tab-skills") && MENU_COMMANDS.includes("tab-mcp"));
  assert.ok(isMenuCommand("settings"));
  assert.ok(isMenuCommand("tab-mcp"));
  assert.ok(!isMenuCommand("tab-sessions"), "表里没有的 domain 不认");
  assert.ok(!isMenuCommand("quit"));
});

test("设置… / 关于 / 检查更新…都落到侧栏的设置目的地；后两项停在「关于」", () => {
  const at = goAgent(DEFAULT_PLACE, "codex");
  assert.equal(routeMenuCommand("settings", at, false).place.view, "settings");
  assert.equal(routeMenuCommand("settings", at, false).settings, undefined);
  assert.deepEqual(routeMenuCommand("about", at, false).settings, { check: false });
  assert.deepEqual(routeMenuCommand("check-update", at, false).settings, { check: true });
});

test("⌘1 / ⌘2：不在位置页时先回到上次停的位置", () => {
  const p = goSettings(goLocation(DEFAULT_PLACE, "project:/w/a"));
  const r = routeMenuCommand("tab-mcp", p, false).place;
  assert.equal(r.view, "location");
  assert.equal(r.locationKey, "project:/w/a");
  assert.equal(r.tab, "mcp");
});

test("添加来源…：加到当前位置，不在位置页时加到上次停的位置，交给位置页", () => {
  const p = goAgent(goLocation(DEFAULT_PLACE, "project:/w/a"), "codex");
  const r = routeMenuCommand("add-source", p, false);
  assert.equal(r.place.view, "location");
  assert.equal(r.place.locationKey, "project:/w/a");
  assert.equal(r.page, "add-source");
});

test("撤销 / 全选：输入框聚焦时作用于文字，否则交给当前页", () => {
  assert.equal(routeMenuCommand("undo", DEFAULT_PLACE, true).text, "undo");
  assert.equal(routeMenuCommand("undo", DEFAULT_PLACE, false).page, "undo");
  assert.equal(routeMenuCommand("select-all", DEFAULT_PLACE, true).text, "select-all");
  assert.equal(routeMenuCommand("select-all", DEFAULT_PLACE, false).page, "select-all");
  assert.equal(routeMenuCommand("add-project", DEFAULT_PLACE, false).shell, "add-project");
  assert.equal(routeMenuCommand("filter", DEFAULT_PLACE, false).place, DEFAULT_PLACE);
});

test("做不了的项灰着：筛选只在位置页；撤销看页面或输入框；返回看页面", () => {
  const none = { undo: false, back: false };
  assert.deepEqual(menuState(DEFAULT_PLACE, none, false), {
    undo: false,
    filter: true,
    back: false,
  });
  assert.equal(menuState(goSettings(DEFAULT_PLACE), none, false).filter, false);
  assert.equal(menuState(goAgent(DEFAULT_PLACE, "codex"), none, false).filter, false);
  assert.equal(menuState(DEFAULT_PLACE, none, true).undo, true);
  assert.equal(menuState(DEFAULT_PLACE, { undo: true, back: true }, false).back, true);
});

test("右键菜单：条件项拿掉之后不留空段", () => {
  const run = () => undefined;
  assert.deepEqual(tidyItems(["separator", "separator"]), []);
  const a = { label: "展开详情", run };
  const b = { label: "拷贝路径", run };
  assert.deepEqual(tidyItems(["separator", a, "separator", "separator", b, "separator"]), [
    a,
    "separator",
    b,
  ]);
});
