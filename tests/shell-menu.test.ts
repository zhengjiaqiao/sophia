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
import {
  DEFAULT_NAV,
  faceOf,
  goDestination,
  goFace,
  goLocation,
  locationOf,
} from "../src/shell/nav.ts";
import { tidyItems } from "../src/contextMenu.ts";

/// 应用菜单（D15；spec 2026-09-26-object-first-navigation R2 R5）：每一项都是界面上已有入口的另一条路

test("AC4 前端的命令表与 src-tauri/src/menu.rs 一一对应；目的地项两边读同一个目的地表", () => {
  const rs = readFileSync(new URL("../src-tauri/src/menu.rs", import.meta.url), "utf8");
  const ids = [...rs.matchAll(/= item\(\s*"([a-z-]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(ids, [...FIXED_COMMANDS].sort());
  assert.match(rs, /include_str!\("\.\.\/\.\.\/src\/shell\/destinations\.json"\)/);
  for (const c of ["dest-skills", "dest-mcp", "dest-models", "dest-usage", "switch-project"]) {
    assert.ok(isMenuCommand(c), c);
  }
  assert.ok(!MENU_COMMANDS.includes("add-project" as never), "添加项目去掉了");
  assert.ok(!isMenuCommand("dest-sessions"), "表里没有的目的地不认（会话还没做）");
  assert.ok(!isMenuCommand("dest-settings"), "设置不进目的地表，走 settings");
  assert.ok(!isMenuCommand("quit"));
});

test("设置… / 关于 / 检查更新…都落到设置；后两项停在「关于」", () => {
  const at = goDestination(DEFAULT_NAV, "models");
  assert.equal(routeMenuCommand("settings", at, false).nav.destination, "settings");
  assert.equal(routeMenuCommand("settings", at, false).settings, undefined);
  assert.deepEqual(routeMenuCommand("about", at, false).settings, { check: false });
  assert.deepEqual(routeMenuCommand("check-update", at, false).settings, { check: true });
});

test("AC5 ⌘1 / ⌘2 / ⌘3：换目的地，各页的位置不变（两页各记各的）", () => {
  const n = goDestination(goLocation(DEFAULT_NAV, "project:/w/a"), "settings");
  const r = routeMenuCommand("dest-mcp", n, false).nav;
  assert.equal(r.destination, "mcp");
  assert.equal(locationOf(r), "all", "MCP 页没选过位置");
  assert.equal(locationOf(routeMenuCommand("dest-skills", n, false).nav), "project:/w/a");
  assert.equal(routeMenuCommand("dest-models", n, false).nav.destination, "models");
  assert.equal(routeMenuCommand("dest-skills", n, false).nav.destination, "skills");
});

test("添加来源…：在 SKILLS 时交给当前页；在别处（含 MCP，它不再添加来源）先到 SKILLS", () => {
  const onSkills = goDestination(DEFAULT_NAV, "skills");
  const r = routeMenuCommand("add-source", onSkills, false);
  assert.equal(r.nav, onSkills);
  assert.equal(r.page, "add-source");
  const fromMcp = routeMenuCommand("add-source", goDestination(DEFAULT_NAV, "mcp"), false);
  assert.equal(fromMcp.nav.destination, "skills");
  assert.equal(fromMcp.page, "add-source");
  const fromModels = routeMenuCommand("add-source", goDestination(DEFAULT_NAV, "models"), false);
  assert.equal(fromModels.nav.destination, "skills");
  assert.equal(fromModels.page, "add-source");
});

test("R4 发现 里没有管来源的键：停在 发现 时 添加来源… / 切换项目… 先回到这一页的 我的", () => {
  for (const [dest, command] of [
    ["skills", "add-source"],
    ["mcp", "switch-project"],
  ] as const) {
    const discover = goFace(goDestination(DEFAULT_NAV, dest), "discover");
    const r = routeMenuCommand(command, discover, false);
    assert.equal(r.nav.destination, dest, command);
    assert.equal(faceOf(r.nav), "mine", command);
    assert.equal(r.page, command);
  }
  // 从模型页添加来源：到 SKILLS，SKILLS 上次停在 发现 也回到 我的
  const away = goDestination(goFace(DEFAULT_NAV, "discover"), "models");
  const r = routeMenuCommand("add-source", away, false).nav;
  assert.equal(r.destination, "skills");
  assert.equal(faceOf(r), "mine");
  // ⌘F 在 发现 里交给当前页（聚焦搜索框），不换面
  const mcpDiscover = goFace(goDestination(DEFAULT_NAV, "mcp"), "discover");
  assert.equal(routeMenuCommand("filter", mcpDiscover, false).nav, mcpDiscover);
});

test("AC11 切换项目…（⌘P）交给当前页打开「更多」列表", () => {
  const r = routeMenuCommand("switch-project", DEFAULT_NAV, false);
  assert.equal(r.nav, DEFAULT_NAV);
  assert.equal(r.page, "switch-project");
});

test("撤销 / 全选：输入框聚焦时作用于文字，否则交给当前页", () => {
  assert.equal(routeMenuCommand("undo", DEFAULT_NAV, true).text, "undo");
  assert.equal(routeMenuCommand("undo", DEFAULT_NAV, false).page, "undo");
  assert.equal(routeMenuCommand("select-all", DEFAULT_NAV, true).text, "select-all");
  assert.equal(routeMenuCommand("select-all", DEFAULT_NAV, false).page, "select-all");
  assert.equal(routeMenuCommand("filter", DEFAULT_NAV, false).nav, DEFAULT_NAV);
});

test("做不了的项灰着：筛选与切换项目只在 SKILLS / MCP；撤销看页面或输入框；返回看页面", () => {
  const none = { undo: false, back: false };
  assert.deepEqual(menuState(DEFAULT_NAV, none, false), {
    undo: false,
    filter: true,
    back: false,
    switchProject: true,
  });
  for (const d of ["settings", "models"] as const) {
    const s = menuState(goDestination(DEFAULT_NAV, d), none, false);
    assert.equal(s.filter, false, d);
    assert.equal(s.switchProject, false, d);
  }
  assert.equal(menuState(goDestination(DEFAULT_NAV, "mcp"), none, false).switchProject, true);
  // 一个项目都没有：筛选行不画位置胶囊，「切换项目…」灰着
  assert.equal(menuState(DEFAULT_NAV, none, false, false).switchProject, false);
  assert.equal(menuState(DEFAULT_NAV, none, true).undo, true);
  assert.equal(menuState(DEFAULT_NAV, { undo: true, back: true }, false).back, true);
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
