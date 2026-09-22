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
        cc: { dot: "linked" as const, clickable: true, tip: "点一下关闭" },
        cx: { dot: "missing" as const, clickable: true, tip: "点一下开启" },
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
  // 原件位置列恢复：列头文字可排序 + ▾ 下拉；格里写来源名
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

test("Matrix：按位置筛选时列头写「原件位置 · 通用仓库 ×」", () => {
  const html = render(Matrix, {
    ...base,
    originFilter: { label: "通用仓库", onClear: () => undefined },
    originMenu: () => null,
  });
  assert.match(html, /<span>· 通用仓库<\/span>/);
  assert.match(html, /aria-label="清除按位置筛选"/);
  assert.match(html, /aria-haspopup="dialog"/);
});

test("OriginMenu：全部 N 选中反色；每个来源一行规则，没开的整段 ink-faint，目标图标组可点", async () => {
  const { OriginMenu } = await import("../src/Matrix.tsx");
  const noop = () => undefined;
  const html = render(OriginMenu, {
    total: 56,
    selected: null,
    onSelect: noop,
    hint: noop,
    close: noop,
    sources: [
      {
        id: "u",
        label: "通用仓库",
        count: 26,
        rule: {
          on: true,
          targets: ["cc", "cx"],
          available: [
            { id: "cc", agentId: "claude-code", name: "Claude Code" },
            { id: "cx", agentId: "codex", name: "Codex" },
          ],
          onToggle: noop,
          onTargets: noop,
        },
      },
      {
        id: "w",
        label: "WeiboAP",
        count: 29,
        rule: {
          on: false,
          targets: ["cc"],
          available: [{ id: "cc", agentId: "claude-code", name: "Claude Code" }],
          onToggle: noop,
          onTargets: noop,
          error: "来源位置已不存在，请刷新",
        },
      },
    ],
  });
  assert.match(html, /class="mx-omenu__all is-selected"/);
  assert.match(html, /全部 <span class="mx-mono">56<\/span>/);
  assert.match(html, /class="mx-rule"/);
  assert.match(html, /class="mx-rule is-off"/);
  assert.match(html, /aria-label="改目标：Claude Code、Codex"/);
  assert.match(html, /role="switch" aria-checked="true"/);
  // 规则设不上：行内黑窗
  assert.match(html, /class="mx-omenu__error" role="alert"/);
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
  assert.match(html, /grid-template-columns:34px 246px 72px 120px 88px 88px 24px/);
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
