/// Cap 的切 run（DESIGN「Typography › 字距：汉字永远 0」）：只有含拉丁字母的 run 套
/// Condensed + 大写 + 字距，汉字 run 原样。渲染与样式的断言在 ui.test.ts。
import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";

const { Cap, capRuns } = await import("../src/ui/Cap.tsx");

test("纯拉丁结构词整段是一个拉丁 run", () => {
  assert.deepEqual(capRuns("skills"), [["skills", true]]);
  assert.deepEqual(capRuns("Claude Code"), [["Claude Code", true]]);
});

test("纯汉字不成拉丁 run：不大写、不加字距", () => {
  assert.deepEqual(capRuns("项目"), [["项目", false]]);
  assert.deepEqual(capRuns("名称"), [["名称", false]]);
});

test("中文与拉丁混排：只有拉丁 run 标记，空白跟着相邻的拉丁段走", () => {
  assert.deepEqual(capRuns("位置 Codex"), [
    ["位置", false],
    [" Codex", true],
  ]);
  assert.deepEqual(capRuns("Claude Code 用户"), [
    ["Claude Code ", true],
    ["用户", false],
  ]);
  assert.deepEqual(capRuns("在 agent 开启"), [
    ["在", false],
    [" agent ", true],
    ["开启", false],
  ]);
});

test("全角标点与 CJK 标点算汉字一侧，不被大写也不加字距", () => {
  assert.deepEqual(capRuns("GitHub（Copilot）"), [
    ["GitHub", true],
    ["（", false],
    ["Copilot", true],
    ["）", false],
  ]);
  assert.deepEqual(capRuns("MCP、skills"), [
    ["MCP", true],
    ["、", false],
    ["skills", true],
  ]);
});

test("不含字母的段（数字、空白、半角符号）不算拉丁 run", () => {
  assert.deepEqual(capRuns("×2"), [["×2", false]]);
  assert.deepEqual(capRuns("第 3 个"), [
    ["第", false],
    [" 3 ", false],
    ["个", false],
  ]);
  assert.deepEqual(capRuns(""), []);
});

test("渲染：拉丁 run 进 .ss-cap，汉字 run 是包层里的裸文本（字距 0、不变换）", () => {
  assert.equal(
    render(Cap, { children: "位置 Codex", tone: "nav" }),
    '<span class="ss-cap-wrap ss-cap-wrap--nav">位置<span class="ss-cap"> Codex</span></span>',
  );
  assert.equal(
    render(Cap, { children: "项目" }),
    '<span class="ss-cap-wrap ss-cap-wrap--label">项目</span>',
  );
});
