/// 矩阵演示的格子状态机（AC7）：四种格子各自的点击结果与提示文字，读屏说法（「pr-review，Codex：点一下加上」）。
/// 期望值是画板里的原句（独立于代码的字面量），三语各验一遍关键句。
import assert from "node:assert/strict";
import test from "node:test";
import { AGENTS, ROWS, cellLabel, press, rowName, toastText } from "../src/demos/skills-matrix.ts";
import { fillTemplate } from "../src/lib/template.ts";

const ctx = { name: "sql-explain", agent: "Codex" };

test("点「点一下加上」的格子：变成已加上，提示「已加到 X」", () => {
  const r = press("open", ctx);
  assert.equal(r.next, "added");
  assert.equal(toastText("zh-Hans", r.toast), "已加到 Codex");
  assert.equal(toastText("en", r.toast), "Added to Codex");
  assert.match(toastText("zh-Hant", r.toast), /Codex/);
});

test("点已加上的格子：退回点一下加上，提示「已从 X 移除 · ⌘Z 撤回」", () => {
  const r = press("added", ctx);
  assert.equal(r.next, "open");
  assert.equal(toastText("zh-Hans", r.toast), "已从 Codex 移除 · ⌘Z 撤回");
});

test("点链接断了的格子：修好变成已加上，提示「修好了：… 在 X 里能用了」", () => {
  const r = press("broken", ctx);
  assert.equal(r.next, "added");
  assert.equal(toastText("zh-Hans", r.toast), "修好了：sql-explain 在 Codex 里能用了");
});

test("点原件所在的格子：状态不变，只提示原件在这里", () => {
  const r = press("original", ctx);
  assert.equal(r.next, "original");
  assert.equal(toastText("zh-Hans", r.toast), "sql-explain 的原件在 Codex 这里");
});

test("读屏说法：名字，agent：状态", () => {
  assert.equal(cellLabel("zh-Hans", "pr-review", "Codex", "open"), "pr-review，Codex：点一下加上");
  assert.equal(cellLabel("zh-Hans", "pr-review", "Claude Code", "added"), "pr-review，Claude Code：已加上");
  assert.equal(cellLabel("zh-Hans", "pr-review", "Cursor", "broken"), "pr-review，Cursor：链接断了");
  assert.equal(cellLabel("zh-Hans", "brand-voice", "Claude Code", "original"), "brand-voice，Claude Code：原件在这里");
});

test("表是 5 行 × 4 个 agent，3 个 skill + 2 个 MCP，四种格子都出现", () => {
  assert.equal(AGENTS.length, 4);
  assert.deepEqual(
    ROWS.map((r) => r.kind),
    ["skill", "skill", "skill", "mcp", "mcp"],
  );
  for (const r of ROWS) assert.equal(r.cells.length, 4);
  const seen = new Set(ROWS.flatMap((r) => r.cells));
  assert.deepEqual([...seen].sort(), ["added", "broken", "open", "original"]);
});

test("浏览器里没有整本目录：模板由服务端放进页面，填参数的结果与 t 取到的一致", () => {
  const templates = {
    "skills.added": "已加到 [[agent]]",
    "skills.removed": "已从 [[agent]] 移除 · ⌘Z 撤回",
    "skills.fixed": "修好了：[[name]] 在 [[agent]] 里能用了",
    "skills.original": "[[name]] 的原件在 [[agent]] 这里",
  } as const;
  for (const state of ["open", "added", "broken", "original"] as const) {
    const { toast } = press(state, ctx);
    assert.equal(fillTemplate(templates[toast.key], toast.params), toastText("zh-Hans", toast));
  }
});

test("MCP 行的名字带「（MCP）」，skill 行原样", () => {
  assert.equal(rowName("zh-Hans", ROWS[0]), "pr-review");
  assert.equal(rowName("zh-Hans", ROWS[3]), "github（MCP）");
  assert.equal(rowName("en", ROWS[3]), "github (MCP)");
});
