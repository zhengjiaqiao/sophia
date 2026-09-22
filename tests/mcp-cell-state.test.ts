import assert from "node:assert/strict";
import test from "node:test";
import {
  differentCopiesMessage,
  differentCopiesTag,
  differentCopiesTitle,
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

test("own：来源就写在这一列，画本体环，点了只说明它是来源", () => {
  assert.deepEqual(viewOf("own", ctx), {
    dot: "own",
    clickable: false,
    reason: "这份 notion 就写在 Codex 里，写到别处去的就是它",
  });
});

test("equal：实心，这儿也有一份、连的是同一个服务", () => {
  assert.deepEqual(viewOf("equal", ctx), {
    dot: "linked",
    clickable: false,
    reason: "Codex 里这份 notion 和来源那份连的是同一个服务",
  });
});

/// 端点一致但认证头要到运行时才生成：说清只比到了哪一步，别假装比过了全部
test("sameEndpoint：实心，说清为什么没法逐字比对", () => {
  assert.deepEqual(viewOf("sameEndpoint", ctx), {
    dot: "linked",
    clickable: false,
    reason: "两边连的是同一个地址；认证头要到运行时才生成，没法逐字比对",
  });
});

/// §8.1：可点的那种不带 reason——成功句由调用方汇总，一次操作只出一句
test("missing：空心，可点，不自带成功文案", () => {
  const view = viewOf("missing", ctx);
  assert.deepEqual(view, { dot: "missing", clickable: true });
  assert.equal(view.reason, undefined);
});

test("invalid：整份文件读不出来，画斜杠环，不写，进待处理栏", () => {
  assert.deepEqual(viewOf("invalid", ctx), {
    dot: "readOnly",
    clickable: false,
    reason: "Codex 的配置这次读不出来，什么都没往里写",
    issue: "invalidLocation",
  });
});

test("unsupported：搬过去就不是原来那个了，画无此格短横，不写，也不进待处理栏", () => {
  const view = viewOf("unsupported", ctx);
  assert.deepEqual(view, {
    dot: "none",
    clickable: false,
    reason: "notion 用了只有 Claude Code 认得的写法，搬到别处就不是原来那个了",
  });
  assert.equal(view.issue, undefined);
});

/// 这个映射存在的理由：三种异常/已有态画出来都不可点，但说的不是同一件事。
/// 凭动作数组为空就统一说一句话，对它们全是错的
test("不可点的几种各说各的，可点的那种一句都不说", () => {
  const states: McpDotState[] = ["own", "equal", "sameEndpoint", "invalid", "unsupported"];
  const reasons = states.map((state) => viewOf(state, ctx).reason ?? "");
  for (const reason of reasons) assert.ok(reason.length > 0);
  assert.equal(new Set(reasons).size, states.length, "每一种的文案必须各不相同");
  assert.equal(viewOf("missing", ctx).reason, undefined);
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

/// 两个位置各有一份同名但地址不同的配置：scan 为每个位置各建一条条目，
/// 合成一行后两边**各画自己的环**，差异挂在行上（AC4）
test("两处冲突：各画自己的环，行上有一个标记，格里没有第四种形", () => {
  const conflicting = row(
    entry("claude-code", { "claude-code": "own", codex: "conflict" }),
    entry("codex", { "claude-code": "conflict", codex: "own" }),
  );
  assert.equal(cellViewOf(conflicting, "claude-code", labelOf)?.dot, "own");
  assert.equal(cellViewOf(conflicting, "codex", labelOf)?.dot, "own");
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
