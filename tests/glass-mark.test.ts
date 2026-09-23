import assert from "node:assert/strict";
import test from "node:test";
import { fracture, labelShards, packShards, rng } from "../src/brand/glassMark.ts";

/// 字标动效的纯逻辑：裂纹生成可复现、碎片切分恰好铺满、碎片图集的格子互不挨着。
/// 画布那一半（绘制、物理）在浏览器里验，这里不 mock canvas

/** rw×rh 的 RGBA；ink(x, y) 为真的像素是不透明黑 */
function image(rw: number, rh: number, ink: (x: number, y: number) => boolean) {
  const px = new Uint8ClampedArray(rw * rh * 4);
  for (let y = 0; y < rh; y++)
    for (let x = 0; x < rw; x++) if (ink(x, y)) px[(y * rw + x) * 4 + 3] = 255;
  return px;
}

/** 在墨上画白色裂纹（只改有墨的像素，和 source-atop 一致） */
function crackOn(base: Uint8ClampedArray, rw: number, isCrack: (x: number, y: number) => boolean) {
  const out = base.slice();
  for (let i = 0; i < out.length / 4; i++) {
    const x = i % rw,
      y = (i / rw) | 0;
    if (out[i * 4 + 3] > 0 && isCrack(x, y)) out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255;
  }
  return out;
}

function assertCovers(base: Uint8ClampedArray, lab: Int32Array, ids: Set<number>) {
  for (let i = 0; i < lab.length; i++) {
    if (base[i * 4 + 3] > 0) assert.ok(ids.has(lab[i]), `有墨像素 ${i} 没分到碎片`);
    else assert.equal(lab[i], -1, `透明像素 ${i} 不该属于碎片`);
  }
}

test("同一个种子给出逐位相同的裂纹，换种子就不同", () => {
  const a = fracture(188, 52, 60, 20, rng(42));
  const b = fracture(188, 52, 60, 20, rng(42));
  const c = fracture(188, 52, 60, 20, rng(43));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.segs, c.segs);
  assert.ok(a.segs.some((s) => s.main) && a.segs.some((s) => !s.main), "主裂纹与细枝都要有");
  for (const s of a.segs) {
    assert.ok(s.pts.length >= 2);
    for (let i = 1; i < s.cum.length; i++) assert.ok(s.cum[i] >= s.cum[i - 1], "累计长度单调");
  }
});

test("敲击点落在字标外时夹回字标边上", () => {
  const f = fracture(188, 52, -30, 999, rng(7));
  assert.equal(f.ix, 0);
  assert.equal(f.iy, 52);
});

test("十字裂纹把一块墨切成四块，裂纹像素也分给了碎片", () => {
  const rw = 40,
    rh = 20;
  const base = image(rw, rh, (x, y) => x >= 2 && x < 38 && y >= 2 && y < 18);
  const ck = crackOn(base, rw, (x, y) => x === 20 || y === 10);
  const { lab, regions } = labelShards(base, ck, rw, rh, 5);
  assert.equal(regions.length, 4);
  assertCovers(base, lab, new Set(regions.map((r) => r.id)));
});

test("没闭合的细枝切不断，太小的碎屑并进邻居，孤立的小墨点自成一块", () => {
  const rw = 40,
    rh = 20;
  const speck = (x: number, y: number) => x === 38 && y === 1;
  const base = image(rw, rh, (x, y) => (x >= 2 && x < 30 && y >= 2 && y < 18) || speck(x, y));
  // 一条半截的竖枝，外加把角上 2×2 的碎屑整个圈起来的裂纹
  const ck = crackOn(
    base,
    rw,
    (x, y) => (x === 15 && y < 12) || (x === 4 && y <= 4) || (y === 4 && x <= 4),
  );
  const { lab, regions } = labelShards(base, ck, rw, rh, 5);
  const ids = new Set(regions.map((r) => r.id));
  assertCovers(base, lab, ids);
  assert.equal(regions.length, 2, "主体一块 + 孤立墨点一块");
  const speckId = lab[1 * rw + 38];
  const r = regions.find((x) => x.id === speckId);
  assert.deepEqual(r && [r.x0, r.y0, r.x1, r.y1], [38, 1, 38, 1]);
});

test("真实裂纹切出来的碎片恰好铺满字形", () => {
  const rw = 188,
    rh = 52;
  // 两个「字母」：一个实心块、一个中空的框
  const base = image(
    rw,
    rh,
    (x, y) =>
      (x >= 10 && x < 70 && y >= 6 && y < 46) ||
      (x >= 90 && x < 170 && y >= 6 && y < 46 && !(x >= 110 && x < 150 && y >= 16 && y < 36)),
  );
  const f = fracture(rw, rh, 80, 26, rng(2026));
  // 把每条主裂纹按 1px 宽栅格化
  const mask = new Uint8Array(rw * rh);
  for (const s of f.segs) {
    if (!s.main) continue;
    for (let i = 1; i < s.pts.length; i++) {
      const [x0, y0] = s.pts[i - 1],
        [x1, y1] = s.pts[i],
        n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) + 1;
      for (let k = 0; k <= n; k++) {
        const x = Math.round(x0 + ((x1 - x0) * k) / n),
          y = Math.round(y0 + ((y1 - y0) * k) / n);
        if (x >= 0 && y >= 0 && x < rw && y < rh) mask[y * rw + x] = 1;
      }
    }
  }
  const ck = crackOn(base, rw, (x, y) => mask[y * rw + x] === 1);
  const { lab, regions } = labelShards(base, ck, rw, rh, 20);
  assert.ok(regions.length > 4, `应碎成多块，实际 ${regions.length}`);
  assertCovers(base, lab, new Set(regions.map((r) => r.id)));
});

test("碎片图集：每块一格、都在图集里，格与格、格与边至少隔 2px", () => {
  const rw = 188,
    R = rng(99);
  // 四十块大小不一的碎片外框，外加一块和字标一样宽的：最宽的也要放得下
  const regions = Array.from({ length: 40 }, (_, id) => {
    const x0 = Math.floor(R() * 150),
      y0 = Math.floor(R() * 40);
    return { id, x0, y0, x1: x0 + Math.floor(R() * 37), y1: y0 + Math.floor(R() * 12) };
  });
  regions.push({ id: 40, x0: 0, y0: 0, x1: rw - 1, y1: 3 });
  const gap = 2;
  const { cells, w, h } = packShards(regions, rw, gap);
  assert.equal(cells.length, regions.length);
  const boxes = regions.map((r, i) => {
    const [x, y] = cells[i];
    return { x0: x, y0: y, x1: x + r.x1 - r.x0 + 1, y1: y + r.y1 - r.y0 + 1 }; // 右、下开区间
  });
  for (const b of boxes) {
    assert.ok(b.x0 >= gap && b.y0 >= gap && b.x1 + gap <= w && b.y1 + gap <= h, "离图集边至少 gap");
  }
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i],
        b = boxes[j];
      const apart =
        a.x1 + gap <= b.x0 || b.x1 + gap <= a.x0 || a.y1 + gap <= b.y0 || b.y1 + gap <= a.y0;
      assert.ok(apart, `格 ${i} 与格 ${j} 挨得太近`);
    }
});
