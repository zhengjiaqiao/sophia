import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";
import { setLocale } from "../src/i18n.ts";

setLocale("zh-Hans");
const { McpDiffPanel } = await import("../src/McpDiffPanel.tsx");

const props = {
  labelOf: (id: string) => id,
  pathOf: () => undefined,
  onReveal: () => undefined,
};

// #302：MCP 行抽屉里「N 份不一样」取差异出错是常驻的：一句给人看，原文进句子前面的「!」，不能丢
test("取差异出错：句子里只有给人看的一句，后端的原文在前面的「!」里", () => {
  const html = render(McpDiffPanel, {
    ...props,
    diff: {
      failure: {
        code: "internal",
        message: "Sophia 的数据读取失败",
        detail: "Permission denied (os error 13)",
      },
    },
  });
  assert.match(html, /无法比对：Sophia 的数据读取失败/);
  assert.match(html, /ss-markbtn--row/);
  assert.doesNotMatch(html, /\[internal]|\[detail]/);
});

test("取差异出错、没有原文（给人看的一句）：不画「!」", () => {
  const html = render(McpDiffPanel, {
    ...props,
    diff: { failure: { code: "invalid", message: "这处配置无法读取" } },
  });
  assert.match(html, /无法比对：这处配置无法读取/);
  assert.doesNotMatch(html, /ss-markbtn/);
});
