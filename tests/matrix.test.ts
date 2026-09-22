import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";

const { default: Matrix } = await import("../src/Matrix.tsx");

const base = {
  columns: [
    {
      id: "cc",
      agentId: "claude-code",
      name: "Claude Code",
      count: 2,
      tip: "Claude Code · 2 个已开启",
    },
    {
      id: "cx",
      agentId: "codex",
      name: "Codex",
      count: 1,
      tip: "Codex · 1 个已开启",
      missing: true,
    },
  ],
  groups: [
    {
      key: "u",
      label: "通用仓库",
      count: 2,
      rule: {
        on: false,
        agents: [{ id: "codex", name: "Codex", columnId: "cx" }],
        onToggle: () => undefined,
      },
    },
    { key: "w", label: "WeiboAP", count: 1 },
  ],
  rows: [
    {
      key: "u|docx",
      group: "u",
      name: "docx",
      cells: {
        cc: { dot: "linked" as const, clickable: true, tip: "点一下关闭" },
        cx: { dot: "missing" as const, clickable: true, tip: "点一下开启" },
      },
    },
    {
      key: "w|pdf",
      group: "w",
      name: "pdf",
      cells: { cc: { dot: "own" as const, clickable: false, tip: "原件就在这儿" }, cx: null },
      busy: "正在开启 2 个",
    },
  ],
  nameLabel: "名称",
  filterText: "",
  onFilterText: () => undefined,
  selected: new Set<string>(),
  onSelectionChange: () => undefined,
  selectionKeys: [],
  busy: false,
  onCell: () => undefined,
};

test("Matrix：通道条表头、按来源分组、组头规则图式，没有「原件位置」列", () => {
  const html = render(Matrix, base);
  assert.match(html, /class="mx-grid mx-head"/);
  assert.match(html, /通用仓库/);
  assert.match(html, /以后新出现的/);
  // 规则关着：整段退到 ink-faint，开关还在
  assert.match(html, /mx-rule is-off/);
  assert.match(html, /role="switch"/);
  // 没有规则的来源只有名字 + 计数
  assert.equal((html.match(/class="mx-rule__text"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /原件位置|本体位置/);
  // 目录还不存在的列：虚线列头
  assert.match(html, /mx-colbtn is-missing/);
  // 行高与列宽写进网格模板：勾选 34 + 名字 246 + 88 × 2 + 尾 24
  assert.match(html, /grid-template-columns:34px 246px 88px 88px 24px/);
  // 行内转盘，句子进读屏
  assert.match(html, /aria-label="正在开启 2 个"/);
});

test("Matrix：MCP 多一列 72 的传输；选中后选择操作条顶替工具行", () => {
  const html = render(Matrix, {
    ...base,
    transportLabel: "传输",
    selected: new Set(["u|docx"]),
    selectionKeys: [
      {
        id: "cx",
        agentId: "codex",
        name: "Codex",
        dot: "missing" as const,
        delta: 1,
        onPress: () => undefined,
      },
      {
        id: "cc",
        agentId: "claude-code",
        name: "Claude Code",
        dot: "own" as const,
        delta: 0,
        disabledReason: "Claude Code · 已选的原件都在这里",
        onPress: () => undefined,
      },
    ],
  });
  assert.match(html, /grid-template-columns:34px 246px 72px 88px 88px 24px/);
  assert.match(html, /已选 <span class="mx-mono">1<\/span> 个/);
  assert.match(html, /\+1/);
  assert.match(html, /取消选择/);
  // 已选的都是原件：键禁用，画灰色原件环
  assert.match(html, /disabled=""[^>]*aria-label="Claude Code：Claude Code · 已选的原件都在这里"/);
  assert.match(html, /ss-dot--own is-muted/);
  // 工具行（筛选框）让位
  assert.doesNotMatch(html, /placeholder="筛选"/);
});
