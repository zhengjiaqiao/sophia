import assert from "node:assert/strict";
import test from "node:test";
import {
  LAYER_CAP,
  LAYER_GAP,
  LAYER_MARGIN,
  TOAST_GAP,
  TOAST_MARGIN,
  placeLayer,
  placeToast,
} from "../src/layerPlace.ts";

const view = { width: 1100, height: 720 };
/// 触发控件：左 32，高 28，按 `top` 放
const at = (top: number, left = 32, width = 70) => ({
  top,
  bottom: top + 28,
  left,
  right: left + width,
});

test("下方放得下：从触发控件下方 6 展开，最大高度取下方剩余与 360 中较小的", () => {
  const p = placeLayer(at(100), { width: 260, height: 300 }, view);
  assert.equal(p.side, "below");
  assert.equal(p.top, 128 + LAYER_GAP);
  assert.equal(p.left, 32);
  assert.equal(p.maxHeight, LAYER_CAP);
});

test("下方放不下、上方放得下才往上翻：浮层底边在触发控件上方 6", () => {
  const p = placeLayer(at(600), { width: 260, height: 300 }, view);
  assert.equal(p.side, "above");
  assert.equal(p.top + 300, 600 - LAYER_GAP);
  assert.equal(p.maxHeight, Math.min(LAYER_CAP, 600 - LAYER_GAP - LAYER_MARGIN));
});

test("内容再多也只按 360 比放不放得下：下方有 360 就朝下，内部滚动", () => {
  const top = 720 - LAYER_MARGIN - LAYER_CAP - LAYER_GAP - 28;
  const p = placeLayer(at(top), { width: 260, height: 1400 }, view);
  assert.equal(p.side, "below");
  assert.equal(p.maxHeight, LAYER_CAP);
});

test("两边都放不下：选空间大的一边，最大高度就是那一边的剩余", () => {
  const small = { width: 1100, height: 400 };
  const low = placeLayer(at(250), { width: 260, height: 800 }, small);
  assert.equal(low.side, "above");
  assert.equal(low.maxHeight, 250 - LAYER_GAP - LAYER_MARGIN);
  assert.equal(low.top, LAYER_MARGIN);
  const high = placeLayer(at(100), { width: 260, height: 800 }, small);
  assert.equal(high.side, "below");
  assert.equal(high.maxHeight, 400 - LAYER_MARGIN - (128 + LAYER_GAP));
});

test("左右不越出窗口：右边放不下时右沿对齐触发控件，仍越界就离边 16", () => {
  const right = placeLayer(at(100, 1000, 60), { width: 260, height: 100 }, view);
  assert.equal(right.left, 1060 - 260);
  // 触发控件本身就贴着窗口右边：右沿对齐它也越界，改为离右边 16
  const clamped = placeLayer(at(100, 1070, 25), { width: 260, height: 100 }, view);
  assert.equal(clamped.left + 260, 1100 - LAYER_MARGIN);
  const leftEdge = placeLayer(at(100, 4, 20), { width: 260, height: 100 }, view);
  assert.equal(leftEdge.left, LAYER_MARGIN);
});

test("窗口比浮层还窄：贴左边距，不给负坐标", () => {
  const p = placeLayer(at(100, 50), { width: 400, height: 100 }, { width: 300, height: 720 });
  assert.equal(p.left, LAYER_MARGIN);
});

// ===== 浮起的提示小窗（DESIGN「浮起小窗的位置」） =====

/// 一格：88 宽、34 高
const cell = (top: number, left: number) => ({ top, bottom: top + 34, left, right: left + 88 });

test("提示小窗：单格正下方 4、水平居中于格，不盖住格子", () => {
  const p = placeToast(cell(200, 400), { width: 120, height: 32 }, view);
  assert.equal(TOAST_GAP, 4);
  assert.equal(p.side, "below");
  assert.equal(p.top, 200 + 34 + 4);
  assert.equal(p.left, 400 + 44 - 60);
});

test("提示小窗：单格靠近面板右沿放不下时右对齐该格", () => {
  const bounds = { left: 300, right: 700 };
  const p = placeToast(cell(200, 612), { width: 200, height: 32 }, view, { bounds });
  assert.equal(p.left + 200, 612 + 88);
});

test("提示小窗：一行左对齐名字；批量键右对齐键右沿、向左展开，左边放不下改左对齐", () => {
  const row = { top: 100, bottom: 134, left: 266, right: 900 };
  assert.equal(placeToast(row, { width: 240, height: 32 }, view, { align: "start" }).left, 266);
  const key = { top: 60, bottom: 88, left: 500, right: 560 };
  const end = placeToast(key, { width: 200, height: 32 }, view, { align: "end" });
  assert.equal(end.left + 200, 560);
  assert.equal(end.top, 88 + 4);
  const first = { top: 60, bottom: 88, left: 280, right: 360 };
  const flipped = placeToast(first, { width: 200, height: 32 }, view, {
    align: "end",
    bounds: { left: 266, right: 900 },
  });
  assert.equal(flipped.left, 280);
});

test("提示小窗：下方放不下才翻到上方——两种都不盖住锚点；两边都放不下仍在下方", () => {
  const low = placeToast(cell(680, 400), { width: 120, height: 32 }, view);
  assert.equal(low.side, "above");
  assert.equal(low.top + 32 + TOAST_GAP, 680);
  const tiny = { width: 320, height: 60 };
  const cramped = placeToast(
    { top: 10, bottom: 40, left: 20, right: 100 },
    { width: 120, height: 40 },
    tiny,
  );
  assert.equal(cramped.side, "below");
});

test("提示小窗：夹在窗口边距之内（菜单栏面板 320 宽）", () => {
  const tray = { width: 320, height: 200 };
  const p = placeToast(
    { top: 10, bottom: 34, left: 250, right: 310 },
    { width: 120, height: 32 },
    tray,
    {
      align: "start",
    },
  );
  assert.ok(p.left + 120 <= 320 - TOAST_MARGIN);
  assert.ok(p.left >= TOAST_MARGIN);
});
