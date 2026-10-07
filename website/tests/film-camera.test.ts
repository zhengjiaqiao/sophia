/// 首屏短片的机位几何（spec R7，DESIGN「官网」短片的机位语言）：推近、构图、转场里的接力、穿过圆点的洞、向上摇。
/// 运镜本身在浏览器里看；这里测不依赖 DOM 的那部分。
import assert from "node:assert/strict";
import test from "node:test";
import {
  aimAt,
  fitScale,
  flyFrames,
  frame,
  holeFrames,
  HOME,
  lerp,
  onScreen,
  panBy,
  poseTransform,
  rectOnScreen,
  SOFT_EDGE,
  tiltUp,
  toContent,
  zoomAbout,
  type Pose,
} from "../src/demos/camera.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const closePt = (a: [number, number], b: [number, number]) => {
  close(a[0], b[0]);
  close(a[1], b[1]);
};

test("归位：内容点就在画面上原处；transform 写法同 CSS（transform-origin 0 0）", () => {
  closePt(onScreen(HOME, [120, 80]), [120, 80]);
  assert.equal(poseTransform({ s: 1.3, x: -40, y: 12 }), "translate(-40px, 12px) scale(1.3)");
});

test("onScreen 与 toContent 互逆", () => {
  const p: Pose = { s: 1.27, x: -133.5, y: 41 };
  closePt(toContent(p, onScreen(p, [210, 97])), [210, 97]);
  closePt(onScreen(p, toContent(p, [10, 300])), [10, 300]);
});

test("aimAt：放大 s 倍后，内容点正好落在画面的目标处", () => {
  const p = aimAt([300, 200], 1.3, [320, 260]);
  assert.equal(p.s, 1.3);
  closePt(onScreen(p, [300, 200]), [320, 260]);
});

test("rectOnScreen：矩形的四角都按机位换算", () => {
  const p: Pose = { s: 1.5, x: -20, y: 10 };
  const r = rectOnScreen(p, { x: 100, y: 40, w: 60, h: 20 });
  closePt([r.x, r.y], onScreen(p, [100, 40]));
  closePt([r.x + r.w, r.y + r.h], onScreen(p, [160, 60]));
});

test("两个机位按同一进度插值时，任一内容点在画面上走直线、与进度同步（光标、选中框、洞跟着机位走的前提）", () => {
  const a: Pose = { s: 1.3, x: -150, y: -60 };
  const b = HOME;
  const q: [number, number] = [420, 250];
  for (const t of [0, 0.25, 0.5, 0.9, 1]) {
    const p: Pose = { s: lerp(a.s, b.s, t), x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
    const [ax, ay] = onScreen(a, q);
    const [bx, by] = onScreen(b, q);
    closePt(onScreen(p, q), [lerp(ax, bx, t), lerp(ay, by, t)]);
  }
});

test("zoomAbout：以画面点为不动点再放大（转场里接着往前推 / 从远处推进来）", () => {
  const p: Pose = { s: 1.2, x: -80, y: -30 };
  const at: [number, number] = [400, 300];
  const q = toContent(p, at);
  for (const k of [0.85, 1.3]) {
    const z = zoomAbout(p, at, k);
    close(z.s, p.s * k);
    closePt(onScreen(z, q), at);
  }
});

test("panBy：整层平移，所有内容点在画面上走同一段距离", () => {
  const p: Pose = { s: 1.35, x: -240, y: 80 };
  const m = panBy(p, 0, -420);
  for (const q of [
    [0, 0],
    [300, 120],
  ] as [number, number][]) {
    const [x0, y0] = onScreen(p, q);
    closePt(onScreen(m, q), [x0, y0 - 420]);
  }
});

test("fitScale：想推多大推多大，但要留得下 keep 的宽；不低于下限", () => {
  assert.equal(fitScale(1.3, 300, 616), 1.3);
  close(fitScale(1.3, 500, 616, 16), (616 - 32) / 500);
  assert.equal(fitScale(1.3, 352, 400, 16, 1.06), 1.06);
});

test("frame：焦点落在目标处；卡片放得下时整张留在画面里（四周留 margin），放不下的那一边保持以焦点构图", () => {
  const stage = { w: 600, h: 400 };
  // 放得下、本来就在画面里：不挪
  const card = { x: 200, y: 150, w: 200, h: 100 };
  const p = frame(1.3, [300, 200], [300, 200], card, stage);
  closePt(onScreen(p, [300, 200]), [300, 200]);
  // 焦点在卡片右边缘附近、目标在画面右侧：卡片会出右边，往左挪回来
  const q = frame(1.3, [390, 200], [590, 200], card, stage);
  const r = rectOnScreen(q, card);
  close(r.x + r.w, stage.w - 16);
  // 卡片太宽放不下：横向保持以焦点构图
  const wide = { x: 20, y: 150, w: 560, h: 100 };
  const z = frame(1.3, [300, 200], [280, 200], wide, stage);
  close(onScreen(z, [300, 200])[0], 280);
});

test("flyFrames：克隆体第一帧与推近画面里的原件同位置、同大小（字一样大），最后一帧落在目标矩形上", () => {
  const a = { x: 300, y: 200, w: 260, h: 52 }; // 机位 1.3 倍下的画面矩形
  const f = flyFrames(a, 200, 40, { x: 420, y: 310, w: 90, h: 26 });
  // 盒子是版面大小、中心对着 a 的中心
  assert.deepEqual(f.box, { x: 330, y: 206, w: 200, h: 40 });
  assert.equal(f.from, "translate(0px, 0px) scale(1.3, 1.3)");
  // 以盒子中心为原点：中心平移到目标中心，缩放到目标大小
  assert.equal(f.to, `translate(${465 - 430}px, ${323 - 226}px) scale(${90 / 200}, ${26 / 40})`);
});

test("穿过圆点的洞：到 open 进度前一直是 0；洞心沿起点到终点的直线走；终点时实心部分盖满整个画面", () => {
  const stage = { w: 616, h: 411 };
  const start: [number, number] = [540, 170];
  const end: [number, number] = [400, 190];
  const f = holeFrames(start, end, 0.4, stage);
  assert.deepEqual(
    f.map((k) => k.offset),
    [0, 0.4, 1],
  );
  const size = (k: { maskSize: string }) => parseFloat(k.maskSize);
  const center = (k: { maskSize: string; maskPosition: string }): [number, number] => {
    const [x, y] = k.maskPosition.split(" ").map(parseFloat);
    return [x! + size(k) / 2, y! + size(k) / 2];
  };
  assert.equal(size(f[0]!), 0);
  assert.equal(size(f[1]!), 0);
  closePt(center(f[0]!), start);
  closePt(center(f[1]!), [lerp(start[0], end[0], 0.4), lerp(start[1], end[1], 0.4)]);
  closePt(center(f[2]!), end);
  const solid = (size(f[2]!) / 2) * SOFT_EDGE;
  for (const [x, y] of [
    [0, 0],
    [stage.w, 0],
    [0, stage.h],
    [stage.w, stage.h],
  ] as [number, number][]) {
    assert.ok(Math.hypot(x - end[0], y - end[1]) <= solid + 1e-9);
  }
});

test("向上摇：两层一起往下走同一段距离（一台机器摇过去），下一镜头落在给定的机位上", () => {
  const landing: Pose = { s: 1.35, x: -242.7, y: 78.9 };
  const p = tiltUp(landing, 411);
  assert.deepEqual(p.outFrom, HOME);
  assert.deepEqual(p.inTo, landing);
  const dOut = p.outTo.y - p.outFrom.y;
  const dIn = p.inTo.y - p.inFrom.y;
  close(dOut, 411 * 1.05);
  close(dIn, dOut);
  assert.equal(p.outTo.x, p.outFrom.x);
  assert.equal(p.inFrom.s, landing.s);
});
