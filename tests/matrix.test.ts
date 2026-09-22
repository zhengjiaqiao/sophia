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
      tip: "Claude Code · 2 个已加上",
    },
    {
      id: "cx",
      agentId: "codex",
      name: "Codex",
      count: 1,
      tip: "Codex · 1 个已加上",
      missing: true,
    },
  ],
  rows: [
    {
      key: "u|docx",
      name: "docx",
      origin: {
        id: "u",
        label: "通用仓库",
        path: "/h/.agents/skills/docx",
        onReveal: () => undefined,
      },
      cells: {
        cc: { dot: "linked" as const, clickable: true, tip: "从 Claude Code 移除" },
        cx: { dot: "missing" as const, clickable: true, tip: "加到 Codex" },
      },
    },
    {
      key: "w|pdf",
      name: "pdf",
      origin: { id: "w", label: "WeiboAP", path: "/w/skills/pdf", onReveal: () => undefined },
      cells: { cc: { dot: "own" as const, clickable: false, tip: "原件就在这儿" }, cx: null },
      busy: "正在开启 2 个",
    },
  ],
  nameLabel: "名称",
  originLabel: "原件位置",
  filterText: "",
  onFilterText: () => undefined,
  selected: new Set<string>(),
  onSelectionChange: () => undefined,
  selectionKeys: [],
  busy: false,
  onCell: () => undefined,
};

test("Matrix：通道条表头 + 原件位置列（120，来源名），没有分组组头", () => {
  const html = render(Matrix, base);
  assert.match(html, /class="mx-grid mx-head"/);
  // 原件位置列恢复：点列头文字按位置排序（没有 ▾ 下拉）；格里写来源名
  assert.match(html, /class="mx-head__origin"/);
  assert.match(html, /class="mx-origin"[^>]*>通用仓库</);
  assert.match(html, /class="mx-origin"[^>]*>WeiboAP</);
  // 按来源分组已撤销（退役行为）：没有组头、没有组头上的规则开关
  assert.doesNotMatch(html, /mx-group|以后新出现的/);
  // 目录还不存在的列：虚线列头
  assert.match(html, /mx-colbtn is-missing/);
  // 列宽：勾选 34 + 名字 246 + 原件位置 120 + 88 × 2 + 尾 24
  assert.match(html, /grid-template-columns:34px 246px 120px 88px 88px 24px/);
  // 默认名称升序
  assert.ok(html.indexOf(">docx<") < html.indexOf(">pdf<"));
  // 行内细弧，句子进读屏
  assert.match(html, /aria-label="正在开启 2 个"/);
});

test("Matrix：当前排序依据列常显 ↑（默认名称升序也显示），其余列不画", () => {
  const html = render(Matrix, base);
  assert.equal((html.match(/class="mx-sort is-active"/g) ?? []).length, 1);
  assert.match(html, /名称<svg class="mx-sort is-active"[^>]*aria-label="升序"/);
});

test("Matrix：原件位置列头只排序——没有 ▾ 下拉、没有规则入口", () => {
  const html = render(Matrix, base);
  // 列头下拉（规则开关、目标图标、AgentKey 弹层、按位置筛选）属于已退役的行为
  assert.doesNotMatch(html, /aria-haspopup|以后新出现的|role="switch"|ss-agentkey/);
  assert.match(html, /class="mx-head__origin"><button type="button" class="mx-headbtn">原件位置/);
});

test("Matrix：选择态——第一行 已选 N 个 + 全部加上 / 全部移除 + 取消选择；列头上方固定成对的 ＋ / －", () => {
  const noop = () => undefined;
  const html = render(Matrix, {
    ...base,
    transportLabel: "传输",
    selected: new Set(["u|docx"]),
    selectionKeys: [
      { id: "all-add", label: "全部加上", onPress: noop },
      { id: "all-remove", label: "全部移除", disabledReason: "都还没加上", onPress: noop },
    ],
    columnKeys: {
      cc: {
        add: { tip: "加到 Claude Code · 1 个：docx", onPress: noop },
        remove: { tip: "从 Claude Code 移除", disabledReason: "只剩原件，移除不了", onPress: noop },
      },
      cx: { add: { tip: "写进 Codex", onPress: noop } },
    },
  });
  assert.match(html, /grid-template-columns:34px 246px 72px 120px 88px 88px 24px/);
  assert.match(html, /已选 <span class="mx-mono">1<\/span> 个/);
  assert.match(html, />全部加上</);
  assert.match(html, /disabled=""[^>]*aria-label="全部移除：都还没加上"/);
  assert.match(html, /取消选择/);
  // 键行：每列一对 ＋ / －，禁用的一侧提示框说原因；只给 add 的列（MCP）只画 ＋
  assert.match(html, /class="mx-grid mx-keyrow"/);
  assert.match(html, /aria-label="加到 Claude Code"/);
  assert.match(html, /disabled=""[^>]*aria-label="从 Claude Code 移除：只剩原件，移除不了"/);
  assert.equal((html.match(/class="ss-btn ss-btn--compact mx-pm"/g) ?? []).length, 3);
  // 按 agent 的动词键（「加到 ✳ CLAUDE CODE」一类）属于已退役的行为
  assert.doesNotMatch(html, /mx-keyname|mx-keycount/);
  // 名称列头的复选框部分选中时半选
  assert.match(html, /aria-checked="mixed" aria-label="全选"/);
  // 工具行第一行（筛选框）让位
  assert.doesNotMatch(html, /placeholder="筛选"/);
});

test("clampFocus：筛选让行变少、列数变了之后，焦点格夹回最近的有效格；表为空时不设", async () => {
  const { clampFocus } = await import("../src/Matrix.tsx");
  // 原来停在第 10 行，筛选后只剩 3 行：夹到最后一行，列不变
  assert.deepEqual(clampFocus({ r: 9, c: 1 }, 3, 4), { r: 2, c: 1 });
  // 列从 6 减到 4
  assert.deepEqual(clampFocus({ r: 0, c: 5 }, 3, 4), { r: 0, c: 3 });
  // 还在范围里的不动
  assert.deepEqual(clampFocus({ r: 1, c: 2 }, 3, 4), { r: 1, c: 2 });
  // 表为空：没有格可夹
  assert.equal(clampFocus({ r: 2, c: 1 }, 0, 4), null);
  assert.equal(clampFocus({ r: 2, c: 1 }, 3, 0), null);
});

test("Matrix：表里总有一个 tabIndex=0 的格，Tab 键进得来", () => {
  const html = render(Matrix, base);
  assert.equal((html.match(/data-cell="[^"]*" tabindex="0"/g) ?? []).length, 1);
});

test("Matrix：名称列头带总数，没有来源筛选片", () => {
  const html = render(Matrix, { ...base, nameCount: 12 });
  assert.match(html, /名称<span class="mx-namecount">12<\/span>/);
  // 没有来源筛选片
  assert.doesNotMatch(html, /ss-chip/);
});

test("Matrix：工具行第二行来源筛选片——全部 N 在最前默认选中；选择条只顶替第一行，来源片仍在", () => {
  const sources = {
    total: 2,
    selected: null,
    onSelect: () => undefined,
    items: [
      { id: "u", label: "通用仓库", count: 1 },
      { id: "w", label: "WeiboAP", count: 1 },
    ],
  };
  const idle = render(Matrix, { ...base, sources });
  assert.match(idle, /class="mx-sources"/);
  assert.match(
    idle,
    /aria-pressed="true"><span class="ss-chip__label">全部<\/span><span class="ss-chip__count">2</,
  );
  assert.match(idle, /placeholder="筛选"/);
  const picking = render(Matrix, { ...base, sources, selected: new Set(["u|docx"]) });
  // 第一行换成选择条，第二行来源片保留
  assert.doesNotMatch(picking, /placeholder="筛选"/);
  assert.match(picking, /已选/);
  assert.match(picking, /class="mx-sources"/);
});
