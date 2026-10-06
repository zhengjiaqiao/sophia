// MCP「N 份不一样」改成行优先的表（issue #114，画板 #105 第七稿第 2 节）：一行一份，行首位置名，第一列「原件」，
// 右边是不一样的字段列，行尾「保留这份」自成一列
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { render } from "./ui-render.ts";
import { withCopy } from "./copy.ts";
import { mcpCopyName, mcpDiffTable } from "../src/mcpDiffTable.ts";
import type { McpDiff, McpLocation } from "../src/types.ts";

const plain = (text: string) => ({ kind: "plain" as const, text });
const secret = (last4: string) => ({ kind: "secret" as const, last4 });
const blockedByCursor = { locationId: "cursor", name: "docs", message: "Cursor 不支持 SSE 传输" };

const diff = (extra: Partial<McpDiff> = {}): McpDiff => ({
  name: "docs",
  locationIds: ["claude", "codex", "cursor"],
  fields: [
    {
      field: "url",
      values: [
        plain("https://docs.test/mcp"),
        plain("https://docs.test/v2/mcp"),
        plain("https://docs.test/mcp"),
      ],
    },
    { field: "headers.Authorization", values: [secret("7f3a"), secret("91c0"), secret("7f3a")] },
  ],
  dynamicAuth: false,
  unreadable: [],
  keepBlocked: [blockedByCursor, null, null],
  revision: "r1",
  ...extra,
});

test("表的行列：一行一份（与位置同序），列是不一样的字段，「保留这份」带着挡住它的那一处", () => {
  const table = mcpDiffTable(diff());
  assert.deepEqual(table.fields, ["url", "headers.Authorization"]);
  assert.deepEqual(
    table.rows.map((row) => row.id),
    ["claude", "codex", "cursor"],
  );
  assert.deepEqual(table.rows[1].values, [plain("https://docs.test/v2/mcp"), secret("91c0")]);
  assert.deepEqual(table.rows[0].blocked, blockedByCursor);
  assert.equal(table.rows[1].blocked, null);
  assert.equal(table.keep, true);
});

test("「保留这份」出现条件：读得出来的至少两份；读不出来的不成行", () => {
  const two = mcpDiffTable(diff({ unreadable: ["cursor"] }));
  assert.deepEqual(
    two.rows.map((row) => row.id),
    ["claude", "codex"],
  );
  assert.equal(two.keep, true);
  const one = mcpDiffTable(diff({ unreadable: ["codex", "cursor"] }));
  assert.equal(one.rows.length, 1);
  assert.equal(one.keep, false);
  // 老的后端没给 keepBlocked：当作做得成
  const old = mcpDiffTable(diff({ keepBlocked: undefined as unknown as McpDiff["keepBlocked"] }));
  assert.ok(old.rows.every((row) => row.blocked === null));
});

const at = (id: string, label: string, harnessId: string, domain: string): McpLocation => ({
  id,
  label,
  harnessId,
  domain,
  path: `/${id}`,
});

test("一份叫什么：位置 · agent；用户级的 Claude Code 不写仅自己，项目里两格分开说", () => {
  const P = "project:/w/sophia";
  assert.equal(
    mcpCopyName("用户级", at("claude-code", "Claude Code · User MCPs", "claude-code", "global")),
    "用户级 · Claude Code",
  );
  assert.equal(mcpCopyName("用户级", at("codex", "Codex", "codex", "global")), "用户级 · Codex");
  assert.equal(
    mcpCopyName(
      "sophia",
      at(`${P}::claude-code:local`, "Claude Code · Local MCPs", "claude-code", P),
    ),
    "sophia · Claude Code 仅自己",
  );
  assert.equal(
    mcpCopyName("sophia", at(`${P}::claude-code`, "Claude Code · Project MCPs", "claude-code", P)),
    "sophia · Claude Code 团队共享",
  );
  assert.equal(mcpCopyName("sophia", at(`${P}::cursor`, "Cursor", "cursor", P)), "sophia · Cursor");
});

const { McpDiffPanel } = await import("../src/McpDiffPanel.tsx");
const names: Record<string, string> = {
  claude: "用户级 · Claude Code",
  codex: "用户级 · Codex",
  cursor: "sophia · Cursor",
};
const paths: Record<string, string> = {
  claude: "/u/.claude.json",
  codex: "/u/.codex/config.toml",
  cursor: "/w/sophia/.cursor/mcp.json",
};
const panel = (extra: Partial<McpDiff> = {}, keep = true) =>
  render(McpDiffPanel, {
    diff: diff(extra),
    labelOf: (id: string) => names[id],
    pathOf: (id: string) => paths[id],
    onReveal: () => undefined,
    onKeep: keep ? () => undefined : undefined,
  });

test("面板画成行优先的表：列头「原件」在最前，行首位置名，原件路径等宽，密钥只给末 4 位，行尾一颗「保留这份」", () => {
  const html = panel();
  assert.match(html, /class="ss-difftable" role="table"/);
  // 列头：空的一格（位置名那一列）、原件、各字段、空的一格（键那一列）
  const heads = [...html.matchAll(/role="columnheader">([^]*?)<\/span>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, ""),
  );
  assert.deepEqual(heads, ["", "原件", "url", "headers.Authorization", ""]);
  const places = [...html.matchAll(/role="rowheader">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(places, ["用户级 · Claude Code", "用户级 · Codex", "sophia · Cursor"]);
  assert.match(html, /\/w\/sophia\/\.cursor\/mcp\.json/);
  assert.match(html, /…7f3a/);
  assert.equal(html.match(/>保留这份</g)?.length, 3);
  // 挡住的那一份：键禁用，原因说是哪一处、为什么
  assert.match(html, /title="sophia · Cursor 改不成这份：Cursor 不支持 SSE 传输"/);
  // 列：位置名 + 原件 + 两个字段 + 键（吃掉剩下的宽度，右对齐）
  assert.match(
    html,
    /grid-template-columns:max-content repeat\(3, minmax\(0, max-content\)\) minmax\(max-content, 1fr\)/,
  );
});

test("不给 onKeep、或读得出来的只剩一份：没有「保留这份」那一列", () => {
  assert.doesNotMatch(panel({}, false), /保留这份/);
  const one = panel({ unreadable: ["codex", "cursor"] });
  assert.doesNotMatch(one, /保留这份/);
  assert.match(one, /用户级 · Codex、sophia · Cursor 这次无法读取/);
});

test("MCP 抽屉：有差异时「原件」一行不单列（路径进了表），没有差异照旧；「保留这份」先确认、走 keepMcpCopy、右下提示条给撤销", () => {
  const tab = withCopy(readFileSync(new URL("../src/McpTab.tsx", import.meta.url), "utf8"));
  assert.match(
    tab,
    /differing\.length === 0 \? \(\s*<>\s*<span className="mx-kv__key">原件<\/span>/,
  );
  assert.match(tab, /<McpDiffSection[^]*onKeep=\{/);
  assert.match(tab, /api\.keepMcpCopy\(/);
  assert.match(tab, /title=\{t\("保留 \{place\} 的 \{name\}？", \{/);
  assert.match(tab, /<UndoToast[^]*sentence="保留 \{place\} 的 \{names\}"/);
  const api = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
  assert.match(
    api,
    // 密钥提醒（issue #147）多带一个勾没勾「同时加进 .gitignore」
    /invoke<McpReport>\("keep_mcp_copy", \{ name, keepId, locationIds, revision, addToGitignore \}\)/,
  );
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(lib, /fn keep_mcp_copy\(/);
  assert.match(lib, /\n\s+keep_mcp_copy,\n/);
});

test("DESIGN 有差异表的条目", () => {
  const spec = readFileSync(new URL("../docs/DESIGN-components.md", import.meta.url), "utf8");
  assert.match(spec, /### 差异表 `DiffTable`/);
});
