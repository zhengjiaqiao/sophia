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

test("configPathText：项目里的文件只写项目里的那段；别处超过两级中段省成 …、留文件名", async () => {
  const { configPathText } = await import("../src/pathText.ts");
  setHome("/Users/jia");
  assert.equal(configPathText("/Users/jia/.claude.json"), "~/.claude.json");
  assert.equal(configPathText("/Users/jia/.codex/config.toml"), "~/.codex/config.toml");
  assert.equal(
    configPathText("/Users/jia/Library/Application Support/Claude/claude_desktop_config.json"),
    "~/…/claude_desktop_config.json",
  );
  // 项目的本地配置写在主目录的 ~/.claude.json 里，不在项目下：照别处的写
  assert.equal(
    configPathText("/Users/jia/.claude.json", "/Users/jia/code/CardBox"),
    "~/.claude.json",
  );
  assert.equal(
    configPathText("/Users/jia/code/CardBox/.mcp.json", "/Users/jia/code/CardBox/"),
    "~/…/.mcp.json",
  );
  assert.equal(
    configPathText("/Users/jia/code/CardBox/.codex/config.toml", "/Users/jia/code/CardBox"),
    "~/…/.codex/config.toml",
  );
  // 项目不在主目录下
  assert.equal(configPathText("/opt/work/a/.mcp.json", "/opt/work/a"), "/…/.mcp.json");
  assert.equal(configPathText("/etc/codex/config.toml"), "/…/config.toml");
  setHome(null);
});
