/// 开关滑块的拖动判定（DESIGN「开关」「控件有重量 › 拖」；src/ui/switchDrag.ts）
import assert from "node:assert/strict";
import test from "node:test";
import {
  DRAG_SLOP_PX,
  FLING_PX_PER_MS,
  VELOCITY_WINDOW_MS,
  dragEnd,
  dragMove,
  dragStart,
  releaseVelocity,
  settleSide,
} from "../src/ui/switchDrag.ts";

const TRAVEL = 17; // 标准开关的滑块行程（ui.css 的 --travel）

/// 从 (x0, t0) 起按给定的 [dx, dt] 逐步移动
function walk(from: boolean, steps: Array<[number, number]>, x0 = 100, t0 = 1000) {
  let d = dragStart(from, TRAVEL, x0, t0);
  assert.ok(d);
  let x = x0;
  let t = t0;
  for (const [dx, dt] of steps) {
    x += dx;
    t += dt;
    d = dragMove(d, x, t);
  }
  return { d, x, t };
}

test("门槛与速度窗口按规范：3px、50ms、0.3px/ms", () => {
  assert.equal(DRAG_SLOP_PX, 3);
  assert.equal(VELOCITY_WINDOW_MS, 50);
  assert.equal(FLING_PX_PER_MS, 0.3);
});

test("横移不超过 3px 就松手＝一次点击：切换", () => {
  const { d, x, t } = walk(false, [
    [2, 20],
    [1, 20],
  ]);
  assert.equal(d.dragging, false);
  // 没进拖动：滑块留在原位，不跟手
  assert.equal(d.offset, 0);
  assert.equal(dragEnd(d, x, t + 200), true);
  const on = walk(true, [[-3, 30]]);
  assert.equal(dragEnd(on.d, on.x, on.t + 200), false);
});

test("横移超过 3px 进入拖动，滑块 1:1 跟手、夹在两端之间，越过门槛后不再退回点击", () => {
  const { d } = walk(false, [[4, 16]]);
  assert.equal(d.dragging, true);
  assert.equal(d.offset, 4);
  const back = dragMove(d, 100, 1100);
  assert.equal(back.dragging, true);
  assert.equal(back.offset, 0);
  // 夹在 [0, 行程]
  assert.equal(dragMove(d, 100 + 40, 1200).offset, TRAVEL);
  assert.equal(dragMove(d, 100 - 40, 1200).offset, 0);
  // 开着时从右端起算
  const on = walk(true, [[-5, 16]]);
  assert.equal(on.d.offset, TRAVEL - 5);
});

test("慢慢拖过一半落到对侧（切换），没过一半回原位", () => {
  // 停住 100ms 再松手：窗口里速度为 0，只看位置
  const past = walk(false, [
    [9, 200],
    [0, 100],
  ]);
  assert.equal(past.d.offset, 9);
  assert.equal(dragEnd(past.d, past.x, past.t), true);
  const short = walk(false, [
    [8, 200],
    [0, 100],
  ]);
  assert.equal(dragEnd(short.d, short.x, short.t), false);
  // 正好一半不算过
  assert.equal(settleSide(TRAVEL / 2, TRAVEL, 0), false);
  // 开着往左拖过一半：关
  const left = walk(true, [
    [-10, 200],
    [0, 100],
  ]);
  assert.equal(dragEnd(left.d, left.x, left.t), false);
});

test("快速甩（|v| ≥ 0.3px/ms）按速度方向落，不看位置", () => {
  // 只拖了 5px（没过一半），但最后 50ms 里以 0.5px/ms 往右甩
  const fling = walk(false, [
    [-1, 100],
    [6, 12],
  ]);
  assert.ok(fling.d.offset < TRAVEL / 2);
  assert.ok(releaseVelocity(fling.d.samples, fling.t) >= FLING_PX_PER_MS);
  assert.equal(dragEnd(fling.d, fling.x, fling.t), true);
  // 拖过了一半，但往回甩：落回原位
  const back = walk(false, [
    [16, 200],
    [-5, 12],
  ]);
  assert.ok(back.d.offset > TRAVEL / 2);
  assert.equal(dragEnd(back.d, back.x, back.t), false);
  // 慢于门槛的移动不算甩
  assert.equal(settleSide(3, TRAVEL, 0.29), false);
  assert.equal(settleSide(3, TRAVEL, 0.3), true);
  assert.equal(settleSide(14, TRAVEL, -0.3), false);
});

test("速度只取松手前 50ms：更早的快速移动不算", () => {
  const samples = [
    { t: 0, x: 0 },
    { t: 10, x: 20 },
    { t: 200, x: 20 },
    { t: 230, x: 23 },
  ];
  assert.equal(releaseVelocity(samples, 230), 0.1);
  // 窗口里只剩一个采样（停住了再松手）：0
  assert.equal(releaseVelocity(samples.slice(0, 3), 240), 0);
});

test("禁用的开关拖不动", () => {
  assert.equal(dragStart(false, TRAVEL, 0, 0, true), null);
  assert.ok(dragStart(false, TRAVEL, 0, 0, false));
});
