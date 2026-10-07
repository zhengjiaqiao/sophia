/// MCP 页两句说明（issue #115，spec 2026-10-05-skill-mcp-batch2「MCP 页（S4）」）：
/// 项目里 Claude Code 团队共享格的提示框末尾接「要在 Claude Code 里启用才生效」；设置里勾了 OpenCode 时
/// 筛选行下一块没有「!」、能关的灰面板，关掉后不再出
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setLocale, t } from "../src/i18n.ts";
import { CLAUDE_SELF, CLAUDE_TEAM, openCodeNoticeWanted, withEnableNote } from "../src/mcpView.ts";
import { HINTS, createHintStore } from "../src/hints.ts";

const PROJECT = "project:/Users/me/sophia";
const NOTE = "加上后需在 Claude Code 中启用才生效";
const WHERE = "写在sophia的 .mcp.json，随仓库分享给团队";

// ---- 启用那一句 ----

test("项目里 Claude Code 团队共享格、点了会写进：提示框第二行末尾接启用那一句", () => {
  assert.equal(withEnableNote(WHERE, CLAUDE_TEAM, PROJECT, true), `${WHERE} · ${NOTE}`);
  // 没有第二行时它自己成一行
  assert.equal(withEnableNote(null, CLAUDE_TEAM, PROJECT, true), NOTE);
  // 说「启用」，不说「批准」（产品负责人 2026-10-06）
  assert.doesNotMatch(t("mcp.claude.enableNote"), /批准/);
});

test("仅自己、用户级、Codex、Cursor、已经有（点了是删）：不接", () => {
  const self = "只在sophia、只给你（本地配置）";
  assert.equal(withEnableNote(self, CLAUDE_SELF, PROJECT, true), self);
  assert.equal(withEnableNote(null, CLAUDE_SELF, "global", true), null);
  assert.equal(withEnableNote(null, CLAUDE_TEAM, "global", true), null);
  assert.equal(withEnableNote(null, "codex", PROJECT, true), null);
  assert.equal(withEnableNote(null, "cursor", PROJECT, true), null);
  assert.equal(withEnableNote(WHERE, CLAUDE_TEAM, PROJECT, false), WHERE);
});

test("启用那一句三种语言都有、说的是启用", () => {
  try {
    setLocale("zh-Hant");
    assert.equal(t("mcp.claude.enableNote"), "加上後需在 Claude Code 中啟用才生效");
    setLocale("en");
    assert.match(t("mcp.claude.enableNote"), /enable it in Claude Code/);
  } finally {
    setLocale("zh-Hans");
  }
  assert.equal(t("mcp.claude.enableNote"), NOTE);
});

// ---- OpenCode 灰面板 ----

test("设置里勾了 OpenCode 才出；没勾、勾了又取消不出", () => {
  assert.equal(openCodeNoticeWanted(["claude-code", "codex", "opencode"]), true);
  assert.equal(openCodeNoticeWanted(["claude-code", "codex"]), false);
  assert.equal(openCodeNoticeWanted([]), false);
});

test("OpenCode 灰面板的句子三种语言", () => {
  const ctx = { agents: [], skills: 0 };
  assert.equal(HINTS["mcp-opencode"](ctx), "MCP 暂不支持 OpenCode，这一页没有它的列");
  try {
    setLocale("zh-Hant");
    assert.equal(HINTS["mcp-opencode"](ctx), "MCP 暫不支援 OpenCode，這一頁沒有它的欄");
    setLocale("en");
    assert.match(HINTS["mcp-opencode"](ctx), /OpenCode/);
  } finally {
    setLocale("zh-Hans");
  }
});

/// 假的 core 看过表
function fakePersist(initial: string[] = []) {
  let stored = [...initial];
  return {
    persist: {
      list: async () => [...stored],
      mark: async (id: string) => {
        if (!stored.includes(id)) stored.push(id);
      },
    },
    stored: () => stored,
  };
}

test("OpenCode 灰面板：× 关掉记看过，这次和下次启动都不再出", async () => {
  const f = fakePersist();
  const store = createHintStore(f.persist);
  await store.load();
  const release = store.claim("mcp-opencode");
  assert.equal(store.getSnapshot().visible, "mcp-opencode");
  store.dismiss("mcp-opencode");
  assert.equal(store.getSnapshot().visible, null);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(f.stored(), ["mcp-opencode"]);
  release();
  // 勾掉再勾上（重新争）也不出
  store.claim("mcp-opencode");
  assert.equal(store.getSnapshot().visible, null);
  // 下次启动：看过表里有它
  const next = createHintStore(fakePersist(f.stored()).persist);
  await next.load();
  next.claim("mcp-opencode");
  assert.equal(next.getSnapshot().visible, null);
});

test("McpTab：OpenCode 灰面板是没有「!」、能关的 section，表格上方与两种空态上方都接；格子提示框走 withEnableNote", () => {
  const src = readFileSync(new URL("../src/McpTab.tsx", import.meta.url), "utf8");
  assert.match(src, /useHint\("mcp-opencode"/);
  assert.match(src, /openCodeNoticeWanted\(/);
  assert.match(
    src,
    /<NoticePanel\s+scope="section"\s+mark=\{false\}\s+open=\{openCodeHint\.visible\}\s+onClose=\{openCodeHint\.dismiss\}/,
  );
  // 表格（Matrix）一处 flush；只勾了 OpenCode 时没有配置位置、选中的项目没有 MCP 位置，两种空态各一处
  assert.equal(src.match(/hint=\{openCodePanel\(true\)\}/g)?.length, 1);
  assert.equal(src.match(/hint=\{openCodePanel\(false\)\}/g)?.length, 2);
  assert.match(src, /withEnableNote\(/);
});
