import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";
import { orphanTotals, type OrphanRow } from "../src/orphanRows.ts";

/// 失效链接的常驻提示（产品负责人 2026-09-27：孤链散在表里没有提示；提示条能关掉就找不回入口，
/// 选择行里按 ● 清除又太绕）：有孤链就在表格上方写一句，不能关，清完自己消失

const { OrphanNotice } = await import("../src/OrphanNotice.tsx");

const clear = (target: string, name: string) => ({
  kind: "brokenLink" as const,
  itemName: name,
  sourcePath: `/gone/${name}`,
  targetPath: `${target}/${name}`,
  target,
});
const orphan = (name: string, targets: string[]): OrphanRow => ({
  key: `orphan|global|${name}`,
  skill: name,
  pointedTo: `/gone/${name}`,
  links: targets.map((t) => ({ targetId: t, clear: clear(`/h/.${t}/skills`, name) })),
});

test("汇总：几个 skill、几条失效链接、清掉它们要执行的全部动作", () => {
  const totals = orphanTotals([orphan("a", ["codex", "claude-code"]), orphan("b", ["codex"])]);
  assert.equal(totals.skills, 2);
  assert.equal(totals.links, 3);
  assert.deepEqual(
    totals.clears.map((c) => c.targetPath),
    ["/h/.codex/skills/a", "/h/.claude-code/skills/a", "/h/.codex/skills/b"],
  );
  assert.equal(orphanTotals([]).links, 0);
});

const props = (only: boolean) => ({
  skills: 10,
  links: 20,
  only,
  onToggleOnly: () => undefined,
  onClearAll: () => undefined,
});

test("一句现状 + 只看这些 + 全部清除；没有关掉的键", () => {
  const html = render(OrphanNotice, props(false));
  assert.match(html, /10 个 skill 的原件已经不在了，留下 20 条失效链接/);
  assert.match(html, />只看这些</);
  assert.match(html, />全部清除</);
  assert.doesNotMatch(html, /关闭|收起|aria-label="×"/);
});

test("只看这些开着时，那颗键换成「显示全部」", () => {
  const html = render(OrphanNotice, props(true));
  assert.match(html, />显示全部</);
  assert.doesNotMatch(html, />只看这些</);
});

test("两颗都是默认紧凑键：浅键（末尾 ↗）只给离开 Sophia 的动作", () => {
  const html = render(OrphanNotice, props(false));
  assert.doesNotMatch(html, /ss-btn--quiet/);
});
