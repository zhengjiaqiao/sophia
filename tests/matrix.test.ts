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
        verb: "开启",
        count: 2,
        onPress: () => undefined,
      },
      {
        id: "cc",
        agentId: "claude-code",
        name: "Claude Code",
        verb: "关闭",
        disabledReason: "已选的都是原件",
        onPress: () => undefined,
      },
    ],
  });
  assert.match(html, /grid-template-columns:34px 246px 72px 88px 88px 24px/);
  assert.match(html, /已选 <span class="mx-mono">1<\/span> 个/);
  // 动词键：动词 + 列头同一枚图标 + Condensed 大写名 + 受影响数 ≠ 已选数时的「· N 个」；
  // 不画圆点、不写 ±N（第 5 轮「状态点 + 增量」已撤回）
  assert.match(html, /aria-label="开启 Codex · 2 个"/);
  assert.match(html, /class="mx-keycount"> · 2 个</);
  assert.doesNotMatch(html, /mx-keydot|ss-dot--own is-muted|\+1/);
  assert.match(html, /取消选择/);
  // 没有能做的动作：禁用，原因进提示框
  assert.match(html, /disabled=""[^>]*aria-label="关闭 Claude Code：已选的都是原件"/);
  // 工具行（筛选框）让位
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

test("duplicatesAKey：「全部」与某颗键做同一件事（同动作、同一批格）时隐藏", async () => {
  const { duplicatesAKey } = await import("../src/Matrix.tsx");
  const c = (skill: string, targetId: string) => ({ sourceId: "s", skill, targetId });
  const codex = { op: "link", cells: [c("a", "codex"), c("b", "codex")] };
  const cc = { op: "unlink", cells: [c("a", "cc")] };
  // 只有 Codex 那颗能开：全部开启 = 开启 Codex
  assert.equal(
    duplicatesAKey({ op: "link", cells: [c("b", "codex"), c("a", "codex")] }, [codex, cc]),
    true,
  );
  // 全部开启涉及两列：不重复
  assert.equal(
    duplicatesAKey({ op: "link", cells: [c("a", "codex"), c("b", "codex"), c("a", "cursor")] }, [
      codex,
    ]),
    false,
  );
  // 同一批格但动作不同：不重复
  assert.equal(duplicatesAKey({ op: "link", cells: [c("a", "cc")] }, [cc]), false);
});

test("Matrix：名称列头带总数，没有来源筛选片", () => {
  const html = render(Matrix, { ...base, nameCount: 12 });
  assert.match(html, /名称<span class="mx-namecount">12<\/span>/);
  // 没有来源筛选片
  assert.doesNotMatch(html, /ss-chip/);
});
