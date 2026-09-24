import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { render } from "./ui-render.ts";

const { default: Matrix, PANEL_W } = await import("../src/Matrix.tsx");

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
  onCell: () => undefined,
};

test("Matrix：通道条表头 + 来源列（120，来源名），没有分组组头；列头名经 Cap、结构线不用墨", () => {
  const html = render(Matrix, base);
  assert.match(html, /class="mx-grid mx-head"/);
  // 原件位置列恢复：点列头文字按位置排序（没有 ▾ 下拉）；格里写来源名
  assert.match(html, /class="mx-head__origin"/);
  assert.match(html, /class="mx-origin"[^>]*>通用仓库</);
  assert.match(html, /class="mx-origin"[^>]*>WeiboAP</);
  // 按来源分组已撤销（退役行为）：没有组头、没有组头上的规则开关
  assert.doesNotMatch(html, /mx-group|以后新出现的/);
  // 目录还不存在的列：图标外一圈虚线、计数空
  assert.match(html, /mx-colbtn is-missing/);
  // 列头名经 Cap（Condensed 大写只给拉丁 run）
  assert.match(
    html,
    /class="mx-colbtn__name"><span class="ss-cap-wrap ss-cap-wrap--label"><span class="ss-cap">Claude Code<\/span>/,
  );
  // 列宽：勾选 34 + 名字（吸收余下，4 列时 246）+ 来源 120 + 88 × 2 + 尾 24；面板定宽 776
  assert.match(html, /grid-template-columns:34px minmax\(0, 1fr\) 120px 88px 88px 24px/);
  assert.match(html, /class="mx-panel" style="width:776px"/);
  // V4：没有 2px 墨线，没有列带（D23）
  const css = readFileSync(new URL("../src/Matrix.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /2px solid var\(--ink\)|mx-band/);
  assert.doesNotMatch(css, /cursor: pointer|dotted/);
  // 默认名称升序
  assert.ok(html.indexOf(">docx<") < html.indexOf(">pdf<"));
  // 行内忙碌指示 + 句子属于退役行为：批量时格子同时变、不在行里转
  assert.doesNotMatch(html, /mx-busy|正在开启/);
});

test("MCP 格的读屏名不说「软链」：linked＝已写进 · 副本，own＝原件（这两个域共用一张表，词不能照抄 skill 的）", () => {
  const mcpProps = {
    ...base,
    dotWords: "mcp" as const,
    rows: [
      {
        ...base.rows[0],
        cells: {
          cc: { dot: "linked" as const, clickable: true, tip: "从 Claude Code 移除" },
          cx: { dot: "missing" as const, clickable: true, tip: "写进 Codex" },
        },
      },
      {
        ...base.rows[1],
        cells: { cc: { dot: "own" as const, clickable: false, tip: "原件就在这儿" }, cx: null },
      },
    ],
  };
  const html = render(Matrix, mcpProps);
  assert.doesNotMatch(html, /软链/);
  assert.match(html, /aria-label="docx · Claude Code：已写进 · 副本。从 Claude Code 移除"/);
  assert.match(html, /aria-label="pdf · Claude Code：原件。原件就在这儿"/);
});

test("skill 格的读屏名不受 MCP 影响：linked 仍是「已加上 · 软链」，own 仍是「已加上 · 原件」", () => {
  const html = render(Matrix, base);
  assert.match(html, /aria-label="docx · Claude Code：已加上 · 软链。从 Claude Code 移除"/);
  assert.match(html, /aria-label="pdf · Claude Code：已加上 · 原件。原件就在这儿"/);
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

test("Matrix：选择行（D4）——表头下一条，用表格同一套列：已选 N 个 + 取消 ｜ 所有 agent ● ｜ 每个 agent 列正下方一点", () => {
  const noop = () => undefined;
  const html = render(Matrix, {
    ...base,
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
  // 选择行在列头里（吸在列头下），同一套列
  const head = html.slice(html.indexOf('class="mx-headwrap"'), html.indexOf('class="mx-body"'));
  assert.match(
    head,
    /class="mx-grid mx-selrow" style="grid-template-columns:34px minmax\(0, 1fr\) 120px 88px 88px 24px"/,
  );
  assert.match(head, /class="mx-selcount">已选 1 个</);
  assert.match(head, /class="ss-btn ss-btn--quiet"[^>]*>取消</);
  // 来源列：所有 agent + 点
  assert.match(
    head,
    /class="mx-selrow__alllabel">所有 agent<[\s\S]*?aria-label="选中的都加到所有 agent"/,
  );
  // 每个 agent 列正下方一点：● linked / ○ missing，与格子同一套，悬停出光晕
  assert.match(
    head,
    /aria-label="选中的都从 Claude Code 移除"[^>]*>[\s\S]*?data-dot="linked" data-hoverable=""/,
  );
  // 没有可改的格子：点 ink-faint，读屏带原因；按下当即说明原因（explain 包层），能点的按下即收起
  assert.match(
    head,
    /<span class="ss-tipwrap is-explain"><button type="button" class="ss-dot-btn mx-seldot is-disabled" aria-label="选中的都加到 Codex：这几个都写不进"/,
  );
  assert.match(
    head,
    /<span class="ss-tipwrap"><button type="button" class="ss-dot-btn mx-seldot" aria-label="选中的都从 Claude Code 移除"/,
  );
  // 选择行里不写 agent 名（点就在自己的列里）；列头不出任何选择控件
  assert.doesNotMatch(html, /mx-agentitem|mx-colcheck|选中的都加到 Claude Code/);
  // 名称列头左边的「全选」框是选行用的，照旧半选；选择行复选列空着（同一件事不放两个框）
  assert.match(html, /aria-checked="mixed" aria-label="全选"/);
  assert.equal((head.match(/aria-label="全选"/g) ?? []).length, 1);
  // 没有顶替工具行的选择条
  assert.doesNotMatch(html, /mx-toolbar/);
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

test("Matrix：来源筛选片——`全部` 在最前、默认选中、不带数（D12）；规则开着的片首橙点；勾选期间来源片仍在", () => {
  const sources = {
    selected: [],
    onSelect: () => undefined,
    items: [
      { id: "u", label: "通用仓库", count: 1 },
      { id: "w", label: "WeiboAP", count: 1, rule: true },
    ],
  };
  const idle = render(Matrix, { ...base, sources });
  assert.match(idle, /class="mx-sources"/);
  assert.match(idle, /aria-pressed="true"><span class="ss-chip__label">全部<\/span><\/button>/);
  // 开着自动规则的来源：片首 6px 橙点（Indicator），其余片没有
  assert.match(idle, /class="mx-sourcechip has-rule" data-origin="w"[\s\S]*?ss-indicator is-on/);
  assert.match(idle, /class="mx-sourcechip" data-origin="u"/);
  const picking = render(Matrix, { ...base, sources, selected: new Set(["u|docx"]) });
  assert.match(picking, /已选/);
  assert.match(picking, /class="mx-sources"/);
});

test("Matrix：加完来源一次选中几片（全部不选中）；片上不带「新」标记；已添加那一窗浮在新来源片下", () => {
  const html = render(Matrix, {
    ...base,
    sources: {
      selected: ["u", "w"],
      onSelect: () => undefined,
      items: [
        { id: "u", label: "通用仓库", count: 1 },
        { id: "w", label: "WeiboAP", count: 1 },
        { id: "x", label: "别处", count: 1 },
      ],
    },
    barToast: {
      id: 1,
      node: createElement("span", { className: "probe" }, "已添加"),
      origins: ["w"],
    },
  });
  assert.match(html, /aria-pressed="false"><span class="ss-chip__label">全部</);
  assert.match(html, /aria-pressed="true"><span class="ss-chip__label">通用仓库</);
  assert.match(
    html,
    /aria-pressed="true"><span class="ss-chip__label">WeiboAP<\/span><span class="ss-chip__count">1</,
  );
  assert.match(
    html,
    /aria-pressed="false"><span class="ss-chip__label">别处<\/span><span class="ss-chip__count">/,
  );
  // 只有 WeiboAP 一片带「新」
  // 「新」标记已撤回（看起来像永远不会消失）：交代改由浮起的那一窗说「已筛选出它的 N 个」
  assert.doesNotMatch(html, /ss-chip__badge|>新</);
  // 浮起的一窗（FloatingToast）：不再挂进列头，锚点按片的 data-origin 找（出现那一刻定位一次）
  assert.doesNotMatch(html, /mx-bartoast/);
  assert.doesNotMatch(html, /class="mx-headwrap"[^>]*>[^]*?class="probe"[^]*?class="mx-head /);
  assert.match(html, /class="mx-sourcechip" data-origin="w"/);
  assert.match(html, /class="ss-floattoast"[^>]*><span class="probe">已添加/);
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
  const { blockedTipOf, MCP_OWN_TIP } = await import("../src/cellTip.ts");
  assert.equal(
    blockedTipOf("own", "Claude Code", "docx", ""),
    "这就是原件，不需要链接 · 要从 Claude Code 移除，只能删掉原件",
  );
  assert.equal(
    blockedTipOf("duplicate", "Cursor", "docx", ""),
    "Cursor 里已有一个同名的 docx，不是这一份",
  );
  // 同名占位（⊘，D22）：占着这一格的是表格里另一行的来源时说出它，并指到这一行上的「只留这份」
  assert.equal(
    blockedTipOf("foreign", "Claude Code", "defuddle", "", "WeiboAP"),
    "Claude Code 里已有 WeiboAP 那份同名的 defuddle · 在这一行上只留一份",
  );
  // 整个文件夹是链接：沿用 cellState 的原因
  assert.equal(blockedTipOf("wholeLinked", "Cursor", "docx", "原句"), "原句");
  // MCP 原件格：与 core 拒绝原件格时说的同一句（mcp::removal::ORIGINAL_MESSAGE）
  assert.equal(
    MCP_OWN_TIP,
    "这是原件所在的位置，从这里移除等于删掉原件 · 要移除，选中这个来源的片，在来源行上移除这个来源",
  );
  const removal = readFileSync(
    new URL("../crates/core/src/mcp/removal.rs", import.meta.url),
    "utf8",
  );
  assert.ok(removal.includes(`"${MCP_OWN_TIP}"`), "前端原件格提示与 core ORIGINAL_MESSAGE 不一致");
});

test("批量写入：格子同时变、不依次点亮；只锁按下的那一项，过了 0.3 秒门槛才在它旁出忙碌指示 + 一句", async () => {
  const { BUSY_DELAY_MS } = await import("../src/ui/Spinner.tsx");
  const { batchBusyText } = await import("../src/toastText.ts");
  // 全应用一个门槛（取代原来批量专用的 500ms 与各处的零延迟）
  assert.equal(BUSY_DELAY_MS, 300);
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
  assert.doesNotMatch(render(Matrix, props), /mx-keybusy|mx-locked/);
  // 刚按下（首帧，还没过门槛）：只有按下的那一项锁住，不出忙碌指示、不变淡；别的项照常能按
  const pressed = render(Matrix, { ...props, keyBusy: { keyId: "cx", label: "正在加到 Codex" } });
  assert.doesNotMatch(pressed, /mx-selbusy/);
  assert.doesNotMatch(pressed, /ss-busy/);
  assert.equal((pressed.match(/<span class="mx-locked">/g) ?? []).length, 1);
  // 锁住的是 Codex 那一列的点
  const lock = pressed.indexOf('<span class="mx-locked">');
  assert.ok(lock > pressed.indexOf('aria-label="选中的都加到 Claude Code"'));
  assert.ok(pressed.indexOf('aria-label="选中的都加到 Codex"') > lock);
  // 过了门槛之后：被按的点原位换成辐条、`已选 N 个` 后接一句——只在门槛之后（经 useBusyShown 把关）
  const src = readFileSync(new URL("../src/Matrix.tsx", import.meta.url), "utf8");
  assert.match(src, /busy=\{busyShown && busyKey === col\.id\}/);
  assert.match(src, /busyShown && keyBusy \? \(\s*<span className="mx-selbusy"/);
});

test("单格的结果：浮在被点那一格正下方（成功与失败同一个位置），不挂进行里，不重复名字，不带撤销，一次只一条", async () => {
  const { Toast } = await import("../src/ui/Toast.tsx");
  const { toastFor } = await import("../src/toastText.ts");
  const text = toastFor("link", {
    done: [{ name: "docx", agent: { id: "codex", name: "Codex" } }],
    omitNames: true,
  });
  const node = createElement(Toast, { ...text });
  // 没有就不占位
  assert.doesNotMatch(render(Matrix, base), /ss-floattoast/);
  const html = render(Matrix, {
    ...base,
    cellToast: { id: 1, rowKey: "u|docx", columnId: "cx", node },
  });
  // 只一条；锚点按格的 data-col 找，所以格上要有它
  assert.equal((html.match(/class="ss-floattoast"/g) ?? []).length, 1);
  assert.match(html, /<div data-col="cx" class="mx-cell"/);
  // 浮在表的最外层（行、格之后），不在行里：悬停它不会被当成悬停那一格
  const at = html.indexOf('class="ss-floattoast"');
  assert.ok(at > html.indexOf('data-row="w|pdf"'));
  const line = html.slice(at);
  // `✓ 加到 [Codex]`：造句复用 toastFor（省名字），成功是白窗；不重复 skill 名、不带撤销
  assert.match(line, /ss-toast--routine[\s\S]*?加到/);
  assert.doesNotMatch(line, /撤销/);
  assert.doesNotMatch(line, /docx/);
  // 同一格失败时只出黑窗（一次只一条，失败优先），原因是整句
  const failed = render(Matrix, {
    ...base,
    cellToast: { id: 1, rowKey: "u|docx", columnId: "cx", node },
    cellNotice: { rowKey: "u|docx", columnId: "cx", text: "Codex 的 skills 目录写不进去" },
  });
  assert.equal((failed.match(/class="ss-floattoast"/g) ?? []).length, 1);
  assert.match(failed, /ss-toast--notice" data-kind="cannot" role="alert"/);
  assert.match(failed, /class="ss-toast__message">Codex 的 skills 目录写不进去</);
  // 旧的行内一行与格下小黑窗的样式已撤
  const css = readFileSync(new URL("../src/Matrix.css", import.meta.url), "utf8");
  assert.doesNotMatch(
    css,
    /mx-celltoast|mx-cellnotice|mx-rowtoast|mx-keytoast|mx-bartoast|mx-globaltoast/,
  );
});

test("批量忙碌锁：只锁按下的那一项、不变淡；过了 0.3 秒门槛（与忙碌指示同一时刻）才变淡；工具行右端不锁", async () => {
  const { busyLockClass } = await import("../src/Matrix.tsx");
  assert.equal(busyLockClass(false, false), undefined);
  assert.equal(busyLockClass(true, false), "mx-locked");
  assert.equal(busyLockClass(true, true), "ss-busy");
  const noop = () => undefined;
  const check = (label: string) => ({ checked: false, label, tip: label, onToggle: noop });
  // 刚开始忙（首帧，计时器还没到点）：按下的「所有 agent」锁住但不淡，其余两项不锁
  const html = render(Matrix, {
    ...base,
    keyBusy: { keyId: "all", label: "正在加到 所有 agent" },
    selected: new Set(["u|docx"]),
    allAgents: check("选中的都加到所有 agent"),
    columnChecks: { cc: check("选中的都加到 Claude Code"), cx: check("选中的都加到 Codex") },
  });
  assert.equal((html.match(/<span class="mx-locked">/g) ?? []).length, 1);
  assert.doesNotMatch(html, /ss-busy/);
  const css = readFileSync(new URL("../src/Matrix.css", import.meta.url), "utf8");
  const locked = css.match(/\.mx-locked \{([^}]*)\}/)?.[1] ?? "";
  assert.match(locked, /pointer-events: none/);
  assert.doesNotMatch(locked, /opacity/);
});

test("格子提示框的 · 空格 只给键盘：鼠标悬停不写，格子按钮 :focus-visible 时才写", () => {
  const src = readFileSync(new URL("../src/Matrix.tsx", import.meta.url), "utf8");
  assert.match(
    src,
    /<span className="ss-tip__keyhint">\s*\{" · "\}\s*<span className="ss-tip__key">空格<\/span>/,
  );
  const css = readFileSync(new URL("../src/Matrix.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.mx-cell:has\(\.mx-cellbtn:focus-visible\) \.ss-tip__keyhint \{\s*display: inline;/,
  );
});

test("Skills 与 MCP 同一个固定面板宽度 776（34 + 246 + 120 + 4 × 88 + 24）；页面头、来源片与表格同一条右沿", () => {
  assert.equal(PANEL_W, 776);
  const css = readFileSync(new URL("../src/Matrix.css", import.meta.url), "utf8");
  // 页面头（壳渲染）在位置页里限宽到同一条右沿，并与来源片、列头一起吸顶
  assert.match(
    css,
    /\.face__scroll > \.page-head:has\(~ \.mx-page\) \{[^}]*position: sticky;[^}]*max-width: 776px;/,
  );
  assert.match(css, /\.mx-bar \{[^}]*position: sticky;[^}]*width: 776px;/);
});

test("MCP 5 列时名称列让到 158、面板宽不变：名称列吸收余下的宽度", () => {
  const five = ["a", "b", "c", "d", "e"].map((id) => ({
    id,
    agentId: "codex",
    name: "Codex",
    count: 0,
    tip: "Codex",
  }));
  const html = render(Matrix, { ...base, columns: five, rows: [] });
  assert.match(
    html,
    /grid-template-columns:34px minmax\(0, 1fr\) 120px 88px 88px 88px 88px 88px 24px/,
  );
  assert.equal(776 - 34 - 120 - 5 * 88 - 24, 158);
});

test("MCP 列头第二行 LOCAL / PROJECT 经 Cap；没有 `传输` 列（D7：挪进行详情）", () => {
  const html = render(Matrix, {
    ...base,
    dotWords: "mcp" as const,
    columns: [
      { id: "l", agentId: "claude-code", name: "Claude Code", scope: "local", count: 1, tip: "x" },
      {
        id: "p",
        agentId: "claude-code",
        name: "Claude Code",
        scope: "project",
        count: 0,
        tip: "y",
      },
    ],
    rows: [],
  });
  assert.match(
    html,
    /class="mx-colbtn__scope"><span class="ss-cap-wrap ss-cap-wrap--label"><span class="ss-cap">local</,
  );
  assert.doesNotMatch(html, /传输|mx-row__transport/);
});

test("来源行：短路径中段省略（前段截断、末两级完整）", async () => {
  const { splitPath } = await import("../src/SourceRow.tsx");
  assert.deepEqual(splitPath("/Users/me/Library/Application Support/WeiboAP/skills"), {
    head: "/Users/me/Library/Application Support/",
    tail: "WeiboAP/skills",
  });
  assert.deepEqual(splitPath("~/skills"), { head: "", tail: "~/skills" });
});
