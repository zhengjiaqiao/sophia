/// 片尾黑猫小戏的逻辑（spec R8、AC6）：猫按字标位置落点、小戏的生命周期（重播不叠、离开清掉、减少动态不放）。
/// 猫的节奏与造型由产品负责人在真机上看，不在这里测。
import assert from "node:assert/strict";
import test from "node:test";
import { CAT_FINAL, CatScene, catPlacement, startU, U_SIT, U_STOP, type CatRun } from "../src/demos/catScene.ts";
import type { ShotCtx } from "../src/demos/film.ts";

// ---------- 落点：猫每帧按字标「未变形的盒子」（遮罩内容区）定位 ----------

const base = {
  canvas: { left: 100, top: 50, width: 800, height: 400 },
  // 遮罩（字标外一层）的外框与内边距；字标高 80
  mask: { right: 500, bottom: 200, paddingRight: 4, paddingBottom: 10 },
  wordmarkHeight: 80,
  dpr: 2,
};

test("猫的身高是字标高的 1.5 倍，按设备像素算", () => {
  assert.equal(catPlacement({ ...base, u: 0 }).s, 240);
});

test("猫脚踩在字标底边：遮罩底边去掉内边距，再留 4px 空隙", () => {
  // (200 - 10 - 50 - 4) * 2
  assert.equal(catPlacement({ ...base, u: 0 }).gy, 272);
});

test("u 是以猫身高为单位、从字标右缘往右数的距离", () => {
  // 右缘 (500 - 4 - 100) * 2 = 792；u = .6 → 再右移 .6 × 240
  assert.equal(catPlacement({ ...base, u: 0.6 }).x, 936);
  assert.equal(catPlacement({ ...base, u: 0 }).x, 792);
});

test("改窗口大小后字标变矮：猫跟着变小，仍挨着字标右缘（手机宽，AC6）", () => {
  const narrow = { ...base, wordmarkHeight: 48, dpr: 1, mask: { ...base.mask, right: 300 } };
  const p = catPlacement({ ...narrow, u: U_SIT });
  assert.equal(p.s, 72);
  // 右缘 (300 - 4 - 100) = 196；U_SIT = .6 → + 43.2
  assert.ok(Math.abs(p.x - 239.2) < 1e-9);
});

test("出场位置在画布右缘之外，猫是从画面外踱进来的", () => {
  // 画布宽 800、字标右缘在画布内 396：(800 - 396) / (80 × 1.5) + 1.4
  const u = startU({ canvasWidth: 800, maskRightInCanvas: 396, wordmarkHeight: 80 });
  assert.ok(Math.abs(u - (404 / 120 + 1.4)) < 1e-9);
  assert.ok(u > U_STOP);
});

test("坐下的位置比嗅 A 的位置更靠近字标（踱回来）", () => {
  assert.ok(U_SIT < U_STOP);
  assert.equal(CAT_FINAL.sit, 1);
  assert.equal(CAT_FINAL.u, U_SIT);
});

// ---------- 生命周期 ----------

/// 假的一场小戏：记录开了几场、各自有没有被收掉；finish() 让它自然播完
function fakeStart() {
  const runs: { killed: boolean; finish: () => void }[] = [];
  const start = (): CatRun => {
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    const run = { killed: false, finish };
    runs.push(run);
    return {
      done,
      kill() {
        run.killed = true;
      },
    };
  };
  const alive = () => runs.filter((r) => !r.killed).length;
  return { start, runs, alive };
}

/// 可手动打断的上下文
function ctxOf() {
  let live = true;
  const waiting: (() => void)[] = [];
  const ctx: ShotCtx = {
    alive: () => live,
    sleep: () => new Promise<void>((r) => waiting.push(r)),
    fromRest: false,
  };
  return {
    ctx,
    interrupt() {
      live = false;
      waiting.splice(0).forEach((r) => r());
    },
  };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

test("小戏走完：run 返回，猫还留在画面上，等离开片尾才清", async () => {
  const f = fakeStart();
  const scene = new CatScene(f.start);
  const { ctx } = ctxOf();
  const p = scene.run(ctx, false);
  await tick();
  f.runs[0]!.finish();
  await p;
  assert.equal(f.alive(), 1);
  scene.stop();
  assert.equal(f.alive(), 0);
});

test("重播不叠两只猫：新一场开始前旧的先清掉", async () => {
  const f = fakeStart();
  const scene = new CatScene(f.start);
  const a = ctxOf();
  const first = scene.run(a.ctx, false);
  await tick();
  f.runs[0]!.finish();
  await first;
  // 第二轮开始时旧猫还在（没有人调 stop）
  const b = ctxOf();
  const second = scene.run(b.ctx, false);
  await tick();
  assert.equal(f.runs.length, 2);
  assert.equal(f.alive(), 1, "同一时刻只有一只猫");
  assert.equal(f.runs[0]!.killed, true);
  f.runs[1]!.finish();
  await second;
});

test("播到一半被打断（暂停、跳走、换镜头）：猫立刻清掉", async () => {
  const f = fakeStart();
  const scene = new CatScene(f.start);
  const c = ctxOf();
  const p = scene.run(c.ctx, false);
  await tick();
  assert.equal(f.alive(), 1);
  c.interrupt();
  await p;
  assert.equal(f.alive(), 0);
});

test("没有在播时 stop 无害，重复 stop 也无害", () => {
  const f = fakeStart();
  const scene = new CatScene(f.start);
  scene.stop();
  scene.stop();
  assert.equal(f.runs.length, 0);
});

test("访客开了减少动态：不放猫", async () => {
  const f = fakeStart();
  const scene = new CatScene(f.start);
  await scene.run(ctxOf().ctx, true);
  assert.equal(f.runs.length, 0);
});
