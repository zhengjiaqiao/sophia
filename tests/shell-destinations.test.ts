import assert from "node:assert/strict";
import test from "node:test";
import {
  DESTINATIONS,
  destinationMenuItems,
  destinationOfCommand,
  isScoped,
} from "../src/shell/destinations.ts";

/// 目的地表（spec 2026-09-26-object-first-navigation R1 R2）：侧栏、快捷键、应用菜单「显示」同源

test("AC4 目的地依次是 SKILLS ⌘1、MCP ⌘2、模型 ⌘3；快捷键写死在表里，不按顺序推算", () => {
  assert.deepEqual(
    DESTINATIONS.map((d) => [d.id, d.shortcut]),
    [
      ["skills", "CmdOrCtrl+1"],
      ["mcp", "CmdOrCtrl+2"],
      ["models", "CmdOrCtrl+3"],
    ],
  );
  assert.deepEqual(destinationMenuItems(), [
    { command: "dest-skills", label: "SKILLS", accelerator: "CmdOrCtrl+1" },
    { command: "dest-mcp", label: "MCP", accelerator: "CmdOrCtrl+2" },
    { command: "dest-models", label: "模型", accelerator: "CmdOrCtrl+3" },
  ]);
});

test("R2 以后插一项（例如会话 ⌘5）不动已有项的快捷键", () => {
  const withSessions = [
    DESTINATIONS[0],
    DESTINATIONS[1],
    { id: "sessions", label: "sessions", shortcut: "CmdOrCtrl+5", scoped: true },
    DESTINATIONS[2],
  ];
  const items = destinationMenuItems(withSessions);
  assert.equal(items.find((i) => i.command === "dest-models")?.accelerator, "CmdOrCtrl+3");
  assert.equal(items.find((i) => i.command === "dest-sessions")?.accelerator, "CmdOrCtrl+5");
});

test("R3 只有 SKILLS 与 MCP 带范围；设置不在表里", () => {
  assert.equal(isScoped("skills"), true);
  assert.equal(isScoped("mcp"), true);
  assert.equal(isScoped("models"), false);
  assert.equal(isScoped("settings"), false);
  assert.equal(destinationOfCommand("dest-mcp"), "mcp");
  assert.equal(destinationOfCommand("dest-settings"), null);
  assert.equal(destinationOfCommand("tab-mcp"), null, "旧的页签命令不再认");
});
