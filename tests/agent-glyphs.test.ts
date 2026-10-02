import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/// 菜单栏用量（原生绘制）用的 agent 标志存在 src-tauri/icons/agents/*.svg，路径必须与 AgentIcon.tsx 逐字相同：
/// DESIGN 要求 agent 图标只有一个定义，原生那边画不了 React，只能复制一份，这里防它漂移
const src = readFileSync("src/ui/AgentIcon.tsx", "utf8");
const svgPath = (file: string) => {
  const m = readFileSync(`src-tauri/icons/agents/${file}`, "utf8").match(/ d="([^"]+)"/);
  assert.ok(m, `${file} 里没有 path`);
  return m[1];
};

test("菜单栏的 Codex 标志与 AgentIcon 的 OpenAI 绳结一致", () => {
  const knot = src.match(/const OPENAI_KNOT =\s*"([^"]+)"/);
  assert.ok(knot);
  assert.equal(svgPath("codex.svg"), knot[1]);
});

test("菜单栏的 Claude Code 标志与 AgentIcon 的放射星形一致", () => {
  // 表项可以直接写图形，也可以指向一个共用常量（Claude Code 与 Claude Desktop 共用 CLAUDE_MARK）
  const entry = src.match(/"claude-code": (\w+|\{)/);
  assert.ok(entry, "AgentIcon 里没有 claude-code 表项");
  const from =
    entry[1] === "{" ? src.slice(entry.index) : src.slice(src.indexOf(`const ${entry[1]}`));
  const star = from.match(/<path d="([^"]+)"/);
  assert.ok(star, "claude-code 的图形里没有 path");
  assert.equal(svgPath("claude-code.svg"), star[1]);
});
