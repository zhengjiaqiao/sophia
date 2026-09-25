import assert from "node:assert/strict";
import test from "node:test";
import {
  differentCopiesMessage,
  differentCopiesTag,
  differentCopiesTitle,
  presentView,
  viewOf,
  type McpDotState,
} from "../src/mcpCellState.ts";
import { cellViewOf, differingSourceIds } from "../src/mcpView.ts";
import type { McpCellState, McpEntry } from "../src/types.ts";

const ctx = { service: "notion", location: "Codex", source: "Claude Code" };

/// 同名服务在一个域里合成一行，行里保留每个真实来源
const entry = (sourceId: string, states: Record<string, McpCellState>): McpEntry => ({
  sourceId,
  name: "notion",
  transport: "http",
  reason: null,
  cells: Object.entries(states).map(([targetId, state]) => ({ targetId, state, reason: null })),
});

const row = (...entries: McpEntry[]) => ({ name: "notion", entries });
const labelOf = (id: string) => (id === "claude-code" ? "Claude Code" : "Codex");

/// DESIGN「MCP 格子只有两种：⦿ 有、○ 没有」（2026-09-25）：这一列的配置里有这一项就是 ⦿，
/// 不管它是不是本行的来源、和来源一样不一样；可点（确认后从这个 agent 删掉），不带 reason（§8.1）
test("own / equal / sameEndpoint：都是 ⦿，可点（确认后删掉），不自带文案，没有「副本」之分", () => {
  for (const state of ["own", "equal", "sameEndpoint"] as McpDotState[]) {
    assert.deepEqual(viewOf(state, ctx), { dot: "own", clickable: true }, state);
  }
  assert.deepEqual(presentView(), { dot: "own", clickable: true });
});

/// §8.1：可点的那种不带 reason——成功句由调用方汇总，一次操作只出一句
test("missing：空心，可点，不自带成功文案", () => {
  const view = viewOf("missing", ctx);
  assert.deepEqual(view, { dot: "missing", clickable: true });
  assert.equal(view.reason, undefined);
});

test("invalid：整份文件读不出来，画斜杠环，不写，算要拿主意的问题", () => {
  assert.deepEqual(viewOf("invalid", ctx), {
    dot: "readOnly",
    clickable: false,
    reason: "这次无法读取 Codex 的配置，没有往里写",
    issue: "invalidLocation",
  });
});

test("unsupported：搬过去就不是原来那个了，画受阻记号（与 skill 同名占位同形），不写，也不算要拿主意的问题", () => {
  const view = viewOf("unsupported", ctx);
  assert.deepEqual(view, {
    dot: "blocked",
    clickable: false,
    reason: "notion 用了只有 Claude Code 支持的写法，写到别处就不是原来那个了",
  });
  assert.equal(view.issue, undefined);
});

/// 这个映射存在的理由：两种异常画出来都不可点，但说的不是同一件事。
/// 凭动作数组为空就统一说一句话，对它们全是错的
test("不可点的几种各说各的，可点的那几种一句都不说", () => {
  const states: McpDotState[] = ["invalid", "unsupported"];
  const reasons = states.map((state) => viewOf(state, ctx).reason ?? "");
  for (const reason of reasons) assert.ok(reason.length > 0);
  assert.equal(new Set(reasons).size, states.length, "每一种的文案必须各不相同");
  for (const state of ["own", "missing", "equal", "sameEndpoint"] as McpDotState[]) {
    assert.equal(viewOf(state, ctx).clickable, true);
    assert.equal(viewOf(state, ctx).reason, undefined);
  }
});

/// R2：`conflict` 不进格。两处各持有一份不一样的定义，是**行级**事实
test("conflict 做成行级标记，说清是同一对而不是各自又多出一份", () => {
  assert.equal(differentCopiesTag(2), "2 份不一样");
  assert.equal(
    differentCopiesTitle(["Claude Code", "Codex"]),
    "Claude Code 和 Codex 各有一份，连的地址不一样",
  );
  assert.equal(
    differentCopiesMessage("notion", ["Claude Code", "Codex"]),
    "Claude Code 和 Codex 各有一份 notion，连的地址不一样——两份都没动",
  );
});

/// 两个位置各有一份同名但地址不同的配置：scan 为每个位置各建一条条目。合成一行后
/// 两处都是 ⦿（都能确认后删掉）；差异挂在行上（AC4）
test("两处冲突：两列都画 ⦿，行上有一个标记，格里没有第四种形", () => {
  const conflicting = row(
    entry("claude-code", { "claude-code": "own", codex: "conflict" }),
    entry("codex", { "claude-code": "conflict", codex: "own" }),
  );
  assert.deepEqual(cellViewOf(conflicting, "claude-code", labelOf), presentView());
  assert.deepEqual(cellViewOf(conflicting, "codex", labelOf), presentView());
  assert.deepEqual(differingSourceIds(conflicting, new Set(["claude-code", "codex"])), [
    "claude-code",
    "codex",
  ]);
  assert.equal(
    differentCopiesTag(differingSourceIds(conflicting, new Set(["claude-code", "codex"])).length),
    "2 份不一样",
  );
});

test("没有冲突的行不挂标记，缺的那一列照常可点", () => {
  const plain = row(entry("claude-code", { "claude-code": "own", codex: "missing" }));
  assert.deepEqual(differingSourceIds(plain, new Set(["claude-code", "codex"])), []);
  assert.equal(cellViewOf(plain, "codex", labelOf)?.clickable, true);
  // 这一列上压根没有格：画短横，不是空心
  assert.equal(cellViewOf(plain, "cursor", labelOf), null);
});

/// 有 ＝ ⦿、没有 ＝ ○（DESIGN「MCP 格子只有两种」）：不管这一列自己的条目带 own、
/// 还是别的来源看它是 equal / sameEndpoint，都是同一种可点的 ⦿；还没有的那一列是可写的 ○
test("有就是 ⦿、没有就是 ○：来源那一列与别的有定义的列画法、行为都一样", () => {
  const labels = (id: string) =>
    ({ a: "Claude Code", b: "Codex", c: "Cursor", d: "Gemini" })[id] ?? id;
  const shared = {
    ...row(
      entry("a", { a: "own", b: "equal", c: "sameEndpoint", d: "missing" }),
      entry("b", { a: "equal", b: "own", c: "sameEndpoint", d: "missing" }),
      entry("c", { a: "sameEndpoint", b: "sameEndpoint", c: "own", d: "missing" }),
    ),
  };
  for (const id of ["a", "b", "c"]) {
    assert.deepEqual(cellViewOf(shared, id, labels), { dot: "own", clickable: true }, id);
  }
  // 还没有的那一列：○，点了写进
  assert.deepEqual(cellViewOf(shared, "d", labels), { dot: "missing", clickable: true });
});

test("行的来源在别处（订阅进来的）时，本域里有定义的列照样是 ⦿", () => {
  // 行的来源 x 不在本域的列里：a 有一份就是 ⦿，b 还没有
  const foreign = row(
    entry("x", { a: "equal", b: "missing" }),
    entry("a", { a: "own", b: "missing" }),
  );
  assert.deepEqual(cellViewOf(foreign, "a", labelOf), presentView());
  assert.equal(cellViewOf(foreign, "b", labelOf)?.dot, "missing");
});

test("只剩 conflict 也说明那一列有一份：画 ⦿、可点", () => {
  const onlyConflict = row(entry("claude-code", { "claude-code": "own", codex: "conflict" }));
  assert.deepEqual(cellViewOf(onlyConflict, "claude-code", labelOf), presentView());
  // codex 自己的条目不在这一行里，但 conflict 说明它那儿有一份
  assert.deepEqual(cellViewOf(onlyConflict, "codex", labelOf), presentView());
});

/// 只有几家 agent 接得住的条目（用命令生成请求头）：接不住的那一格原因用 core 给的那句，
/// 不说「只有来源认得的写法」——换一家 agent 就搬得过去
test("unsupported：条目带 onlyHarnesses 时原因用 core 给这一格的那句", () => {
  const helper: McpEntry = {
    sourceId: "codex",
    name: "gh",
    transport: "http",
    reason: null,
    onlyHarnesses: ["claude-code", "codex"],
    cells: [
      { targetId: "codex", state: "own", reason: null },
      { targetId: "claude-code", state: "missing", reason: null },
      { targetId: "cursor", state: "unsupported", reason: "Cursor 不支持用命令生成请求头" },
    ],
  };
  const labels = (id: string) =>
    ({ codex: "Codex", "claude-code": "Claude Code", cursor: "Cursor" })[id] ?? id;
  const view = cellViewOf({ name: "gh", entries: [helper] }, "cursor", labels);
  assert.deepEqual(view, {
    dot: "blocked",
    clickable: false,
    reason: "Cursor 不支持用命令生成请求头",
  });
  // 接得住的那一家照常可写
  assert.equal(
    cellViewOf({ name: "gh", entries: [helper] }, "claude-code", labels)?.clickable,
    true,
  );
  // 没有 onlyHarnesses 的：照旧是「只有来源认得的写法」
  const plain: McpEntry = { ...helper, onlyHarnesses: undefined, name: "notion" };
  assert.equal(
    cellViewOf({ name: "notion", entries: [plain] }, "cursor", labels)?.reason,
    "notion 用了只有 Codex 支持的写法，写到别处就不是原来那个了",
  );
});
