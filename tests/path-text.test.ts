import { test } from "node:test";
import assert from "node:assert/strict";
import { displayPath, setHome, shortPath } from "../src/pathText.ts";

test("displayPath：主目录写成 ~，按分量比较，未知主目录时原样", () => {
  setHome(null);
  assert.equal(displayPath("/Users/jia/.agents/skills/x"), "/Users/jia/.agents/skills/x");
  setHome("/Users/jia/");
  assert.equal(displayPath("/Users/jia/.agents/skills/x"), "~/.agents/skills/x");
  assert.equal(displayPath("/Users/jia"), "~");
  assert.equal(displayPath("/Users/jiaqiao/.claude.json"), "/Users/jiaqiao/.claude.json");
  assert.equal(displayPath("/opt/other"), "/opt/other");
  setHome("C:\\Users\\jia");
  assert.equal(displayPath("C:\\Users\\jia\\.codex\\config.toml"), "~\\.codex\\config.toml");
  setHome(null);
});

test("shortPath：主目录写成 ~；超过四级留开头两级与末两级、中段 …", () => {
  setHome("/Users/jia");
  assert.equal(shortPath("/Users/jia/code/agents-kit/skills"), "~/code/agents-kit/skills");
  assert.equal(
    shortPath("/Users/jia/Library/Application Support/WeiboAP/agent_1/skills"),
    "~/Library/…/agent_1/skills",
  );
  assert.equal(shortPath("C:\\Users\\x\\a\\b\\c\\d"), "C:\\Users\\…\\c\\d");
  setHome(null);
});
