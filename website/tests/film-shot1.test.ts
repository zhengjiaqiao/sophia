/// 第 1 镜头「agent 名字卡散落」的几何（spec R7、ticket #185：名字卡散落不出画面）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FILM_AGENTS, scatterPose, rotatedBounds } from "../src/demos/agentChips.ts";

/// 确定的伪随机序列（线性同余），加上两个极端值，覆盖「贴着边」的情况
function* randoms(n: number) {
  yield () => 0;
  yield () => 0.999999;
  let s = 12345;
  for (let i = 0; i < n; i++)
    yield () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
}

function inside(film: { w: number; h: number }, chip: { w: number; h: number }, rand: () => number) {
  const p = scatterPose(film, chip, rand);
  const b = rotatedBounds(p.x, p.y, chip.w, chip.h, p.r);
  return { p, b, ok: b.left >= 0 && b.top >= 0 && b.right <= film.w && b.bottom <= film.h };
}

test("宽屏（3:2）：任何随机值下，旋转后的名字卡整张都在画面里", () => {
  const film = { w: 560, h: 373 };
  for (const rand of randoms(300))
    for (const w of [84, 120, 160]) {
      // 每个维度都换一组随机数：把同一个 rand 连续调用的结果都覆盖到
      const r = inside(film, { w, h: 36 }, rand);
      assert.ok(r.ok, `w=${w} 越界：${JSON.stringify(r.b)}`);
    }
});

test("窄画面（手机 4:5 宽 370；横版但只有 400 宽）：同样整张在画面里，并且避开顶部的字幕区", () => {
  for (const film of [
    { w: 370, h: 462 },
    { w: 400, h: 267 },
  ])
    for (const rand of randoms(300))
      for (const w of [84, 120, 160]) {
        const r = inside(film, { w, h: 36 }, rand);
        assert.ok(r.ok, `${film.w}x${film.h} w=${w} 越界：${JSON.stringify(r.b)}`);
        assert.ok(r.b.top >= film.h * 0.28, `w=${w} 压到字幕：top=${r.b.top}`);
      }
});

test("宽屏时散落在右半边（左边是字幕）", () => {
  const film = { w: 560, h: 373 };
  for (const rand of randoms(100)) {
    const { p } = inside(film, { w: 120, h: 36 }, rand);
    assert.ok(p.x >= film.w * 0.4, `x=${p.x}`);
  }
});

test("旋转后的外框：不转时就是原框，转了会更宽更高", () => {
  assert.deepEqual(rotatedBounds(10, 20, 100, 40, 0), { left: 10, top: 20, right: 110, bottom: 60 });
  const b = rotatedBounds(10, 20, 100, 40, 90);
  assert.ok(Math.abs(b.right - b.left - 40) < 1e-9 && Math.abs(b.bottom - b.top - 100) < 1e-9);
});

test("名字卡上的 agent 都是应用认得的（harnesses.json 里有这个显示名）", () => {
  const file = fileURLToPath(new URL("../../crates/core/data/harnesses.json", import.meta.url));
  const known = new Set((JSON.parse(readFileSync(file, "utf8")) as { harnesses: { display_name: string }[] }).harnesses.map((h) => h.display_name));
  for (const n of FILM_AGENTS) assert.ok(known.has(n), `${n} 不在 harnesses.json`);
  assert.equal(FILM_AGENTS.length, 8);
});
