import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
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
  // 行内忙碌指示 + 句子属于退役行为：批量时格子同时变、不在行里转
  assert.doesNotMatch(html, /mx-busy|正在开启/);
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

test("Matrix：选择态——第一行 已选 N 个 + 所有 agent + 每个 agent 一项「● / ○ 名字」+ 取消选择", () => {
  const noop = () => undefined;
  const html = render(Matrix, {
    ...base,
    transportLabel: "传输",
    selected: new Set(["u|docx"]),
    allAgents: {
      checked: false,
      label: "选中的都加到所有 agent",
      tip: "加到所有 agent",
      onToggle: noop,
    },
    columnChecks: {
      cc: {
        checked: true,
        label: "选中的都从 Claude Code 移除",
        tip: "从 Claude Code 移除",
        onToggle: noop,
      },
      cx: {
        checked: false,
        label: "选中的都加到 Codex",
        tip: "加到 Codex",
        disabledReason: "这几个都写不进",
        onToggle: noop,
      },
    },
  });
  assert.match(html, /grid-template-columns:34px 246px 72px 120px 88px 88px 24px/);
  assert.match(html, /已选 <span class="mx-mono">1<\/span> 个/);
  assert.match(html, /aria-label="选中的都加到所有 agent"/);
  assert.match(html, /class="mx-agentitem__name">所有 agent</);
  // 每一项是 button：状态点（● linked / ○ missing，与格子同一套，带悬停预览）+ 正文名字
  assert.match(
    html,
    /aria-label="选中的都从 Claude Code 移除"[^>]*>[\s\S]*?data-dot="linked" data-preview=""/,
  );
  assert.match(html, /class="mx-agentitem__name">Claude Code</);
  // 禁用：点和字都用 disabled 色，读屏带原因
  assert.match(
    html,
    /class="ss-dot-btn mx-agentitem is-disabled" aria-label="选中的都加到 Codex：这几个都写不进"/,
  );
  assert.match(html, /取消选择/);
  // 列头复选框属于已退役的行为：列头回到只有图标、名字、计数
  assert.doesNotMatch(html, /mx-colcheck|选中的都加到 Claude Code/);
  // 名称列头左边的「全选」框是选行用的，照旧半选
  assert.match(html, /aria-checked="mixed" aria-label="全选"/);
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

test("点了做不了的格子：只当即说明（提示框立即出现、停约 3 秒），不交给调用方改数据", async () => {
  const { cellPress, PINNED_TIP_MS } = await import("../src/Matrix.tsx");
  assert.equal(cellPress({ clickable: false }), "explain");
  assert.equal(cellPress({ clickable: true }), "act");
  assert.equal(PINNED_TIP_MS, 3000);
  // 做不了的格子仍是可聚焦、可按的按钮（空格同样触发），不是被禁用的死控件
  const html = render(Matrix, {
    ...base,
    rows: [
      {
        ...base.rows[0],
        cells: {
          cc: { dot: "own" as const, clickable: false, tip: "这就是原件" },
          cx: { dot: "missing" as const, clickable: true, tip: "加到 Codex" },
        },
      },
    ],
  });
  assert.match(html, /<button type="button" class="ss-dot-btn mx-cellbtn is-inert"/);
  assert.doesNotMatch(html, /mx-cellbtn is-inert"[^>]*disabled/);
});

test("做不了的格子的说明：为什么 + 去哪做", async () => {
  const { blockedTipOf, mcpOwnTip } = await import("../src/cellTip.ts");
  assert.equal(
    blockedTipOf("own", "Claude Code", "docx", ""),
    "这就是原件，不需要链接 · 要从 Claude Code 移除，只能删掉原件",
  );
  assert.equal(
    blockedTipOf("duplicate", "Cursor", "docx", ""),
    "Cursor 下已有一个同名的 docx，不是这一份",
  );
  assert.equal(
    blockedTipOf("foreign", "Cursor", "docx", ""),
    "Cursor 下已有一个同名的 docx，不是这一份",
  );
  // 整个文件夹是链接：沿用 cellState 的原因
  assert.equal(blockedTipOf("wholeLinked", "Cursor", "docx", "原句"), "原句");
  assert.match(mcpOwnTip("Claude Code"), /^这就是原件，不需要写进 · 要从 Claude Code 移除/);
});

test("批量写入：格子同时变、不依次点亮；真的慢（> 500ms）才在触发项旁出忙碌指示 + 一句", async () => {
  const { BATCH_BUSY_DELAY_MS } = await import("../src/Matrix.tsx");
  const { batchBusyText } = await import("../src/toastText.ts");
  assert.equal(BATCH_BUSY_DELAY_MS, 500);
  assert.equal(batchBusyText("link", "Codex"), "正在加到 Codex");
  assert.equal(batchBusyText("unlink", "Codex"), "正在从 Codex 移除");
  assert.equal(batchBusyText("write", "Cursor"), "正在写进 Cursor");
  const noop = () => undefined;
  const check = (label: string) => ({ checked: false, label, tip: label, onToggle: noop });
  const props = {
    ...base,
    selected: new Set(["u|docx"]),
    allAgents: check("选中的都加到所有 agent"),
    columnChecks: { cc: check("选中的都加到 Claude Code"), cx: check("选中的都加到 Codex") },
  };
  // 没慢到阈值：什么都不显示
  assert.doesNotMatch(render(Matrix, props), /mx-keybusy/);
  // 慢了：忙碌指示 + 句子贴在触发的那一项旁，只这一项
  const slow = render(Matrix, { ...props, keyBusy: { keyId: "cx", label: "正在加到 Codex" } });
  assert.equal((slow.match(/class="mx-keybusy"/g) ?? []).length, 1);
  const at = slow.indexOf('class="mx-keybusy"');
  assert.ok(at > slow.indexOf('mx-agentitem__name">Codex<'));
  assert.ok(at > slow.indexOf('mx-agentitem__name">Claude Code<'));
  assert.match(
    slow.slice(at),
    /^class="mx-keybusy" role="status">[\s\S]*?<span>正在加到 Codex<\/span>/,
  );
});

test("单格成功的例行一行：固定在列头行左段（名称 / 原件位置列头文字上方），左对齐名称列，一次只一条", async () => {
  const { Toast } = await import("../src/ui/Toast.tsx");
  const { toastFor } = await import("../src/toastText.ts");
  const text = toastFor("link", {
    done: [{ name: "excalidraw", agent: { id: "codex", name: "Codex" } }],
  });
  const node = createElement(Toast, {
    ...text,
    action: { label: "撤销", onClick: () => undefined },
  });
  // 没有就不占位
  assert.doesNotMatch(render(Matrix, base), /mx-celltoast/);
  const html = render(Matrix, { ...base, cellToast: { id: 1, node } });
  // 只一条（槽位是单值，新的替换旧的，不排队）
  assert.equal((html.match(/class="mx-celltoast"/g) ?? []).length, 1);
  // 在吸顶的列头里、agent 列头之前；左沿 = 勾选列宽（对齐名称列），宽 = 名字 246 + 原件位置 120，不伸进 agent 列
  const head = html.indexOf('class="mx-grid mx-head"');
  const at = html.indexOf('class="mx-celltoast"');
  assert.ok(head >= 0 && at > head && at < html.indexOf('class="mx-head__col"'));
  assert.match(html.slice(at), /^class="mx-celltoast" style="left:34px;width:366px">/);
  // 造句复用 toastFor、组件复用例行档：✓ 加到 [Codex] excalidraw · 撤销
  assert.match(html.slice(at), /ss-toast--routine[\s\S]*?加到[\s\S]*?excalidraw[\s\S]*?>撤销</);
  // 底边停在列头文字上沿（文字 19 + 表头下内边距 6），不盖列头文字
  const css = readFileSync(new URL("../src/Matrix.css", import.meta.url), "utf8");
  assert.match(css, /\.mx-celltoast \{[^}]*position: absolute;[^}]*top: 0;[^}]*bottom: 25px;/);
});

test("批量忙碌锁：开始就锁住工具行各项、不变淡；忙过 500ms（与忙碌指示同一时刻）才变淡", async () => {
  const { busyLockClass, BATCH_BUSY_DELAY_MS } = await import("../src/Matrix.tsx");
  assert.equal(busyLockClass(false, false), undefined);
  assert.equal(busyLockClass(true, false), "mx-locked");
  assert.equal(busyLockClass(true, true), "ss-busy");
  assert.equal(BATCH_BUSY_DELAY_MS, 500);
  const noop = () => undefined;
  const check = (label: string) => ({ checked: false, label, tip: label, onToggle: noop });
  // 刚开始忙（首帧，计时器还没到点）：各项锁住但不淡
  const html = render(Matrix, {
    ...base,
    busy: true,
    selected: new Set(["u|docx"]),
    allAgents: check("选中的都加到所有 agent"),
    columnChecks: { cc: check("选中的都加到 Claude Code"), cx: check("选中的都加到 Codex") },
  });
  assert.equal((html.match(/<span class="mx-locked">/g) ?? []).length, 3);
  assert.doesNotMatch(html, /ss-busy/);
  const css = readFileSync(new URL("../src/Matrix.css", import.meta.url), "utf8");
  const locked = css.match(/\.mx-locked \{([^}]*)\}/)?.[1] ?? "";
  assert.match(locked, /pointer-events: none/);
  assert.doesNotMatch(locked, /opacity/);
});
