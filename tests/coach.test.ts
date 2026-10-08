/// 引导气泡只出一次（#265，DESIGN-components「引导气泡 Coach」；src/coach.ts）：每种全应用只出一次，记在设置里
/// （core 的看过表 `seenHints`，与新手提示共用一份）
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { render } from "./ui-render.ts";
import { COACH_KEY, createCoachStore } from "../src/coach.ts";

const { Coach, placeCoach } = await import("../src/ui/Coach.tsx");

function fakePersist(initial: string[] = []) {
  const stored = [...initial];
  const marks: string[] = [];
  return {
    persist: {
      async list() {
        return [...stored];
      },
      async mark(id: string) {
        marks.push(id);
        if (!stored.includes(id)) stored.push(id);
      },
    },
    stored,
    marks,
  };
}

test("第一次要出时出、并当场记进设置；之后同一种再也不出（重开应用也不出）", async () => {
  const f = fakePersist();
  const coach = createCoachStore(f.persist);
  await coach.load();
  assert.equal(coach.show("pick-order"), true);
  assert.deepEqual(f.marks, [COACH_KEY["pick-order"]]);
  assert.equal(coach.show("pick-order"), false, "这次运行里不再出");

  const again = createCoachStore(f.persist);
  await again.load();
  assert.equal(again.show("pick-order"), false, "重开应用也不出");
});

test("看过表还没读到时不出（宁可这次不出，也不出第二次）", () => {
  const coach = createCoachStore(fakePersist().persist);
  assert.equal(coach.show("pick-order"), false);
});

test("气泡：一句话 + `知道了`，放在一直在的 status 区里（读屏在句子出来时读）；收起时区还在、没有字", () => {
  const anchor = {} as HTMLElement;
  const open = render(Coach, {
    anchor,
    open: true,
    onDismiss: () => {},
    children: createElement("span", null, "可以在这里拖动调整顺序"),
  });
  assert.match(open, /role="status"[^]*可以在这里拖动调整顺序[^]*>知道了</);
  const closed = render(Coach, { anchor, open: false, onDismiss: () => {}, children: "x" });
  assert.match(closed, /role="status"/);
  assert.doesNotMatch(closed, /知道了/);
});

test("气泡的位置：目标正下方 10、箭头对着目标中线；先往左展开，左边放不下才往右；夹进窗口四边 16", () => {
  // 目标在右侧（浮层里的「已选」页签）：往左展开，箭头离右端 28
  assert.deepEqual(
    placeCoach({ left: 700, right: 760, bottom: 100 }, { width: 300 }, { width: 1000 }),
    {
      left: 730 - 272,
      top: 110,
      arrowX: 272,
    },
  );
  // 目标在左边：往右展开，箭头离左端 28
  assert.deepEqual(
    placeCoach({ left: 40, right: 80, bottom: 20 }, { width: 300 }, { width: 1000 }),
    {
      left: 32,
      top: 30,
      arrowX: 28,
    },
  );
});

// 走查 2026-10-07 第 1 条：气泡挂在浮层里，伸出浮层的那一截会被裁掉（只剩「知道了」）。给了浮层的边界就夹进它的
// 左右内沿各 16（同浮层的内边距），不再只看窗口
test("气泡的位置：给了浮层边界时夹进浮层左右各 16，箭头仍对着目标中线", () => {
  // 浮层 600–980，「已选」页签在 700–760：往左展开会伸出浮层左沿，改往右展开，再夹进右内沿（980 − 16 − 300）
  assert.deepEqual(
    placeCoach(
      { left: 700, right: 760, bottom: 100 },
      { width: 300 },
      { width: 1200 },
      { left: 600, right: 980 },
    ),
    { left: 664, top: 110, arrowX: 730 - 664 },
  );
  // 页签在浮层右端：往左展开放得下，照旧
  assert.deepEqual(
    placeCoach(
      { left: 900, right: 960, bottom: 100 },
      { width: 300 },
      { width: 1200 },
      { left: 600, right: 980 },
    ),
    { left: 930 - 272, top: 110, arrowX: 272 },
  );
});
