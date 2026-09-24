/* 字标动效「黑猫与玻璃」：绘制与物理（DESIGN「壳 → 字标动效：黑猫与玻璃」）。
   移植自产品负责人定稿的原型（第 21 版），V4 起落在侧栏顶的字标带里：纯 Canvas 2D，不依赖 React。

   - 静止时画布是空的，显示的是原来的 <img> 字标；只有猫出现、裂开、碎开、复原期间画布才接管，
     那时把 <img> 调成透明（不用 visibility，读屏还要读它的 alt）。
   - rAF 只在悬停和复原期间跑；回到静止就停。
   - 字标位图的颜色是标志资产自己的（DESIGN「标志」：标志不随界面 token 换色）：由 SVG 源码
     逐条路径填出来，和 <img> 同源，灰影的色值只在 SVG 里。不直接 drawImage(<img>)：
     没写宽高的 SVG 在各引擎里的固有尺寸不一致，画进画布会变形。
   - 猫与裂纹的取色读 tokens.css 的变量（--ink / --paper / --ink-mute / --ctl-edge），不写字面值。
   - 画布只盖侧栏的字标带（宿主外面带 data-brand-band 的那一块，208 × 44）：不盖红绿灯行、
     不盖导航项；碎片落在字标带的下沿（看不见的地面），左右不出侧栏。
   - 本文件的纯函数（rng / fracture / labelShards / packShards）不碰 DOM，
     tests/glass-mark.test.ts 直接测。 */

export type Pt = [number, number];
export type Rand = () => number;

/** 线性同余随机数：给同一个种子，裂纹逐位相同（测试靠它） */
export function rng(seed: number): Rand {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const smooth = (x: number) => x * x * (3 - 2 * x);
const wrapAngle = (a: number) => {
  a %= Math.PI * 2;
  return a > Math.PI ? a - Math.PI * 2 : a < -Math.PI ? a + Math.PI * 2 : a;
};

// ———— 裂纹几何 ————

/** 一条裂纹：折线 pts、各点的累计长度 cum；d0 是它离敲击点多远开始出现 */
export interface CrackSeg {
  pts: Pt[];
  cum: number[];
  d0: number;
  main: boolean;
}

export interface Fracture {
  ix: number;
  iy: number;
  maxD: number;
  segs: CrackSeg[];
}

/** 放射 + 同心环：折线主裂纹、斜向细枝、敲击点碎纹。坐标是字标位图的设备像素。
    随机数全部从 R 取，同一个 R 序列给出同一张裂纹 */
export function fracture(rw: number, rh: number, ix0: number, iy0: number, R: Rand): Fracture {
  const ix = Math.max(0, Math.min(rw, ix0));
  const iy = Math.max(0, Math.min(rh, iy0));
  const corners: Pt[] = [
    [0, 0],
    [rw, 0],
    [0, rh],
    [rw, rh],
  ];
  const maxD = Math.max(...corners.map(([x, y]) => Math.hypot(x - ix, y - iy))) * 1.05;
  const N = 11 + Math.floor(R() * 5);
  const ang: number[] = [];
  for (let i = 0; i < N; i++) ang.push(((i + (R() - 0.5) * 0.85) / N) * Math.PI * 2 + R() * 0.3);
  const radii = [0];
  let r = rh * (0.16 + R() * 0.06);
  while (r < maxD) {
    radii.push(r);
    r *= 1.5 + R() * 0.3;
  }
  radii.push(maxD);
  const P: Pt[][] = radii.map((rr, k) =>
    ang.map((a): Pt => {
      const j = k === 0 ? 0 : rr * (1 + (R() - 0.5) * 0.38);
      return [ix + Math.cos(a) * j, iy + Math.sin(a) * j];
    }),
  );
  const lerp = (a: Pt, b: Pt, t: number): Pt => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ];
  const raw: { a: Pt; b: Pt; ring: boolean }[] = [];
  for (let k = 0; k < radii.length - 1; k++) {
    const sub = 1 + Math.floor(k / 3);
    for (let i = 0; i < N; i++) {
      const i2 = (i + 1) % N;
      const a0 = P[k][i],
        a1 = P[k][i2],
        b0 = P[k + 1][i],
        b1 = P[k + 1][i2];
      for (let s = 0; s < sub; s++) {
        const t0 = s / sub,
          t1 = (s + 1) / sub;
        raw.push({ a: lerp(b0, b1, t0), b: lerp(b0, b1, t1), ring: true });
        raw.push(
          s === 0
            ? { a: k === 0 ? [ix, iy] : a0, b: b0, ring: false }
            : { a: lerp(a0, a1, t0), b: lerp(b0, b1, t0), ring: false },
        );
      }
    }
  }
  const jag = (A: Pt, B: Pt, amp: number, step: number) => {
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
    const nx = -(B[1] - A[1]) / L,
      ny = (B[0] - A[0]) / L;
    const n = Math.max(2, Math.min(9, Math.round(L / step)));
    const pts: Pt[] = [A];
    let drift = 0;
    for (let i = 1; i < n; i++) {
      drift = drift * 0.5 + (R() - 0.5) * 2 * Math.min(amp, L * 0.1);
      const tt = i / n + ((R() - 0.5) * 0.3) / n;
      pts.push([A[0] + (B[0] - A[0]) * tt + nx * drift, A[1] + (B[1] - A[1]) * tt + ny * drift]);
    }
    pts.push(B);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    return { pts, cum };
  };
  const inBox = (A: Pt, B: Pt) =>
    Math.min(A[0], B[0]) < rw &&
    Math.max(A[0], B[0]) > 0 &&
    Math.min(A[1], B[1]) < rh &&
    Math.max(A[1], B[1]) > 0;
  const segs: CrackSeg[] = [];
  for (const sg of raw) {
    if (!inBox(sg.a, sg.b)) continue;
    let A = sg.a,
      B = sg.b;
    const dA = Math.hypot(A[0] - ix, A[1] - iy),
      dB = Math.hypot(B[0] - ix, B[1] - iy);
    if (dB < dA) [A, B] = [B, A];
    const d0 = Math.min(dA, dB) + (sg.ring ? rh * 0.05 : 0);
    const line = jag(A, B, rh * 0.045, rh * 0.06);
    segs.push({ ...line, d0, main: true });
    const total = line.cum[line.cum.length - 1];
    const nb = Math.floor((total / (rh * 0.55)) * (0.3 + R() * 0.7));
    for (let b = 0; b < nb; b++) {
      const at = R() * total;
      let i = 1;
      while (i < line.cum.length - 1 && line.cum[i] < at) i++;
      const f = (at - line.cum[i - 1]) / (line.cum[i] - line.cum[i - 1] || 1);
      const P0 = line.pts[i - 1],
        P1 = line.pts[i];
      const O: Pt = [P0[0] + (P1[0] - P0[0]) * f, P0[1] + (P1[1] - P0[1]) * f];
      const dir =
        Math.atan2(P1[1] - P0[1], P1[0] - P0[0]) + (R() < 0.5 ? -1 : 1) * (0.45 + R() * 0.7);
      const len = rh * (0.08 + R() * 0.28);
      const E: Pt = [O[0] + Math.cos(dir) * len, O[1] + Math.sin(dir) * len];
      if (inBox(O, E)) segs.push({ ...jag(O, E, rh * 0.02, rh * 0.04), d0: d0 + at, main: false });
    }
  }
  for (let i = 0; i < 9; i++) {
    const a0 = R() * Math.PI * 2,
      r0 = rh * R() * 0.05,
      len = rh * (0.05 + R() * 0.14);
    const O: Pt = [ix + Math.cos(a0) * r0, iy + Math.sin(a0) * r0];
    const dir = a0 + (R() - 0.5) * 1.6;
    const E: Pt = [O[0] + Math.cos(dir) * len, O[1] + Math.sin(dir) * len];
    if (inBox(O, E)) segs.push({ ...jag(O, E, rh * 0.015, rh * 0.03), d0: r0, main: false });
  }
  return { ix, iy, maxD, segs };
}

// ———— 碎片切分 ————

export interface ShardRegion {
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 按画面上实际的裂纹切碎片（敲碎那一刻做一次，逐像素）。
    base 是完整字标、crack 是画了裂纹的字标，都是 rw×rh 的 RGBA。
    字形里被裂纹围起来的每一块连通区域是一块碎片；没闭合的细枝切不断玻璃，留在碎片上一起掉。
    裂纹像素和太小的碎屑分给最近的碎片，孤立的小点自成一块——
    所以每个有墨的像素（alpha > 0）恰好属于一块碎片，拼回去就是完整的字标。
    返回每个像素的碎片号 lab（-1 = 透明）和保留下来的碎片外框 */
export function labelShards(
  base: ArrayLike<number>,
  crack: ArrayLike<number>,
  rw: number,
  rh: number,
  minPx: number,
): { lab: Int32Array; regions: ShardRegion[] } {
  const N = rw * rh;
  const solid = new Uint8Array(N);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    if (base[p + 3] <= 24) continue;
    // 裂纹像素：与完整字标差得够多（黑字上的裂纹更浅、浅灰重影上的裂纹更深，取绝对值）
    if (
      Math.abs(crack[p] + crack[p + 1] + crack[p + 2] - (base[p] + base[p + 1] + base[p + 2])) > 60
    )
      continue;
    solid[i] = 1;
  }
  const lab = new Int32Array(N).fill(-1);
  const stack = new Int32Array(N);
  const sizes: number[] = [];
  // 四邻域连通：裂纹线一两像素宽，八邻域会从斜角漏过去
  const flood = (seed: number, id: number, ok: (j: number) => boolean) => {
    let sp = 0,
      n = 0;
    stack[sp++] = seed;
    lab[seed] = id;
    while (sp) {
      const j = stack[--sp],
        x = j % rw,
        y = (j / rw) | 0;
      n++;
      if (x > 0 && lab[j - 1] < 0 && ok(j - 1)) ((lab[j - 1] = id), (stack[sp++] = j - 1));
      if (x < rw - 1 && lab[j + 1] < 0 && ok(j + 1)) ((lab[j + 1] = id), (stack[sp++] = j + 1));
      if (y > 0 && lab[j - rw] < 0 && ok(j - rw)) ((lab[j - rw] = id), (stack[sp++] = j - rw));
      if (y < rh - 1 && lab[j + rw] < 0 && ok(j + rw)) ((lab[j + rw] = id), (stack[sp++] = j + rw));
    }
    return n;
  };
  for (let i = 0; i < N; i++) {
    if (!solid[i] || lab[i] >= 0) continue;
    sizes.push(flood(i, sizes.length, (j) => solid[j] === 1));
  }
  const kept = sizes.map((n) => n >= minPx);
  // 由保留下来的碎片向外逐圈生长（八邻域），吃掉裂纹像素、碎屑和抗锯齿边
  const q = new Int32Array(N);
  let qn = 0;
  for (let i = 0; i < N; i++) {
    if (lab[i] >= 0 && !kept[lab[i]]) lab[i] = -1;
    if (lab[i] >= 0) q[qn++] = i;
  }
  for (let h = 0; h < qn; h++) {
    const j = q[h],
      x = j % rw,
      y = (j / rw) | 0,
      id = lab[j];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx,
          yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= rw || yy >= rh) continue;
        const k = yy * rw + xx;
        if (lab[k] >= 0 || base[k * 4 + 3] === 0) continue;
        lab[k] = id;
        q[qn++] = k;
      }
    }
  }
  // 长不到的孤立墨点（和任何保留碎片都不相连）自成一块，保证一个像素都不丢
  for (let i = 0; i < N; i++) {
    if (lab[i] >= 0 || base[i * 4 + 3] === 0) continue;
    kept.push(true);
    sizes.push(flood(i, sizes.length, (j) => base[j * 4 + 3] !== 0));
  }
  const boxes: ShardRegion[] = sizes.map((_, id) => ({ id, x0: rw, y0: rh, x1: -1, y1: -1 }));
  for (let i = 0; i < N; i++) {
    const id = lab[i];
    if (id < 0) continue;
    const b = boxes[id],
      x = i % rw,
      y = (i / rw) | 0;
    if (x < b.x0) b.x0 = x;
    if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y;
    if (y > b.y1) b.y1 = y;
  }
  return { lab, regions: boxes.filter((b) => kept[b.id] && b.x1 >= 0) };
}

/** 碎片图集的排法：按高矮排成几行货架，图集宽 rw + 2·gap，最宽的碎片也放得下。
    每块碎片的外框占一格，格与格之间、格与图集边之间至少隔 gap（≥ 2）个像素：
    紧挨着格子的那一圈由 segment 填上复制出来的边缘像素，外面再留透明——
    碎片旋转着画时插值会取到框外，取到的和单独一张画布时（边缘夹取）一样，也取不到邻居。
    cells[i] 是 regions[i] 那一格的左上角 */
export function packShards(
  regions: ShardRegion[],
  rw: number,
  gap = 2,
): { cells: Pt[]; w: number; h: number } {
  const w = rw + gap * 2;
  const size = (r: ShardRegion) => [r.x1 - r.x0 + 1, r.y1 - r.y0 + 1];
  const order = regions
    .map((_, i) => i)
    .sort((a, b) => size(regions[b])[1] - size(regions[a])[1] || a - b);
  const cells: Pt[] = [];
  let x = gap,
    y = gap,
    rowH = 0;
  for (const i of order) {
    const [sw, sh] = size(regions[i]);
    if (x + sw + gap > w && x > gap) {
      x = gap;
      y += rowH + gap;
      rowH = 0;
    }
    cells[i] = [x, y];
    x += sw + gap;
    rowH = Math.max(rowH, sh);
  }
  return { cells, w, h: y + rowH + gap };
}

/** 凸包（单调链），给碎片落地时算最低点 */
function hull(P: Pt[]): Pt[] {
  P.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Pt[] = [],
    up: Pt[] = [];
  for (const p of P) {
    while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i];
    while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop();
    up.push(p);
  }
  up.pop();
  lo.pop();
  return lo.concat(up);
}

// ———— 字母分前后两层：S、P、I 在后，O、H、A 在前 ————
// 路径取自 assets/logo/wordmark.svg（viewBox 3304×916，y 轴翻转，平移 [tx, 808]）。
// 猫画在字标上之后，把这三个字母按原样盖回来，猫就像钻到了它们后面
const FRONT: [string, number][] = [
  [
    "M34 190V510Q34 600 89.0 654.0Q144 708 236 708Q328 708 383.5 654.0Q439 600 439 510V190Q439 100 383.5 46.0Q328 -8 236 -8Q144 -8 89.0 46.0Q34 100 34 190ZM298 184V516Q298 548 281.0 567.5Q264 587 236 587Q208 587 191.5 567.5Q175 548 175 516V184Q175 152 191.5 132.5Q208 113 236 113Q264 113 281.0 132.5Q298 152 298 184Z",
    754,
  ],
  [
    "M307 700H424Q429 700 432.5 696.5Q436 693 436 688V12Q436 7 432.5 3.5Q429 0 424 0H307Q302 0 298.5 3.5Q295 7 295 12V285Q295 290 290 290H190Q185 290 185 285V12Q185 7 181.5 3.5Q178 0 173 0H56Q51 0 47.5 3.5Q44 7 44 12V688Q44 693 47.5 696.5Q51 700 56 700H173Q178 700 181.5 696.5Q185 693 185 688V416Q185 411 190 411H290Q295 411 295 416V688Q295 693 298.5 696.5Q302 700 307 700Z",
    1882,
  ],
  [
    "M325 11 309 107Q309 112 303 112H176Q170 112 170 107L154 11Q153 0 141 0H24Q11 0 14 13L161 689Q163 700 174 700H309Q320 700 322 689L468 13L469 9Q469 0 458 0H338Q326 0 325 11ZM194 221H284Q289 221 288 226L241 499Q240 502 238.0 502.0Q236 502 235 499L190 226Q190 221 194 221Z",
    2782,
  ],
];
const VIEW_W = 3304,
  VIEW_H = 916,
  BASELINE = 808;

interface Shape {
  path: Path2D;
  tone: string; // 填色，原样取自 SVG 的 fill
  clip: Path2D | null;
}

/** SVG 的 transform 只认 translate / scale（字标由脚本生成，只用这两种） */
function parseTransform(t: string | null): DOMMatrix {
  const m = new DOMMatrix();
  for (const [, fn, args] of (t ?? "").matchAll(/(translate|scale)\(([^)]*)\)/g)) {
    const [a, b] = args
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (fn === "translate") m.translateSelf(a, b || 0);
    else m.scaleSelf(a, Number.isNaN(b) || b === undefined ? a : b);
  }
  return m;
}

/** 把字标 SVG 拆成「路径 + 填色 + 裁切」，按文档顺序画出来就是 <img> 的样子 */
function parseWordmark(svg: string): Shape[] {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const toPath = (el: Element) => {
    const p = new Path2D();
    p.addPath(new Path2D(el.getAttribute("d") ?? ""), parseTransform(el.getAttribute("transform")));
    return p;
  };
  const clips = new Map<string, Path2D>();
  for (const cp of root.querySelectorAll("clipPath")) {
    const p = new Path2D();
    for (const el of cp.querySelectorAll("path")) p.addPath(toPath(el));
    clips.set(cp.id, p);
  }
  const shapes: Shape[] = [];
  for (const el of root.querySelectorAll("path")) {
    if (el.closest("clipPath")) continue;
    const ref = el.closest("[clip-path]")?.getAttribute("clip-path") ?? "";
    const id = /url\(#([^)]+)\)/.exec(ref)?.[1];
    const tone = el.closest("[fill]")?.getAttribute("fill") ?? "";
    shapes.push({ path: toPath(el), tone, clip: id ? (clips.get(id) ?? null) : null });
  }
  return shapes;
}

/** 找不到字标带时（单独渲染字标）的退路：画布左右各伸出 24px、上下各 15px */
const PAD_X = 24;
const PAD_Y = 15;
const HOVER_DELAY = 0.4; // 秒：停这么久猫才出来，扫过去不惊动它

type Mode = "rest" | "armed" | "cracked" | "crack" | "heal" | "fall" | "rebuild" | "mend";
type CatState = "hidden" | "walk" | "pause" | "flee" | "exit";

interface Layer extends Fracture {
  t0: number;
  target: number;
  tauMain: number;
  tauB: number;
  delayB: number;
}

interface Shard {
  ax: number; // 在图集里的左上角
  ay: number;
  sw: number;
  sh: number;
  pts: Pt[];
  hcx: number; // 原位（画布设备像素）
  hcy: number;
  px: number;
  py: number;
  r: number;
  vx: number;
  vy: number;
  w: number;
  e: number;
  size: number;
  rel: number;
  sleep: boolean;
  still: number;
  landed: boolean;
  delay: number;
  lifted: boolean;
  liftV: number;
}

interface Cat {
  on: boolean;
  state: CatState;
  x: number;
  gy: number | null;
  gvy: number;
  dir: number;
  face: number;
  v: number;
  t: number;
  target: number;
  phase: number;
  clock: number;
  tilt: number;
  sit: number;
  pauseFor: number;
  fast: boolean;
  hop: { t: number } | null;
  turn: { t: number; from: number; to: number } | null;
}

interface Palette {
  ink: string;
  paper: string;
  mute: string;
  edge: string; // --ctl-edge：次级裂纹
}

const newCat = (): Cat => ({
  on: false,
  state: "hidden",
  x: 0,
  gy: null,
  gvy: 0,
  dir: -1,
  face: -1,
  v: 0,
  t: 0,
  target: 0,
  phase: 0,
  clock: 0,
  tilt: 0,
  sit: 0,
  pauseFor: 0,
  fast: false,
  hop: null,
  turn: null,
});

const makeCanvas = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

const ctx2d = (c: HTMLCanvasElement) => {
  const g = c.getContext("2d");
  if (!g) throw new Error("canvas 2d 不可用");
  return g;
};

/** 一个字标的动效。host 收指针事件（字标框：含左下重影，右到 A 右沿 + 4），img 是静止时显示的字标，
    canvas 叠在 img 上方、不接指针事件 */
export class GlassMark {
  private readonly host: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly c: HTMLCanvasElement;
  private readonly svg: string;
  private shapes: Shape[] | null = null;
  private readonly reduce: MediaQueryList;
  private raf = 0;
  private ready = false;
  private blank = true; // 画布当前是空的，<img> 在显示

  // 几何（setup 时按当前布局与 DPR 量）
  private dpr = 1;
  private rw = 0;
  private rh = 0;
  private ox = 0;
  private oy = 0;
  private baseline = 0;
  private col: Palette = { ink: "", paper: "", mute: "", edge: "" };
  private base!: HTMLCanvasElement;
  private data!: Uint8ClampedArray;
  private layer!: HTMLCanvasElement;
  private crackImg!: HTMLCanvasElement;
  private atlas: HTMLCanvasElement | null = null; // 全部碎片的像素，每块占一格
  private front!: Path2D;
  private catCv: HTMLCanvasElement | null = null;
  private catTint: HTMLCanvasElement | null = null;
  private catWh: HTMLCanvasElement | null = null;

  // 状态
  private mode: Mode = "rest";
  private hover = false;
  private hoverSince = 0;
  private ptr: Pt | null = null;
  private layers: Layer[] = [];
  private frags: Shard[] = [];
  private sh = { x: 0, y: 0, vx: 0, vy: 0 };
  private cat: Cat = newCat();
  private hits = 0;
  private need = 2;
  private composed = false;
  private dirty = false;
  private last: number | null = null;
  private finalFr: Fracture | null = null;
  private impact: Pt = [0, 0];
  private maxD = 1;
  private G = 0;
  private c0 = 0;
  private e0 = 0;
  private m0 = 0;
  private leftAt = 0;
  private pendingRebuild = false;

  constructor(host: HTMLElement, img: HTMLImageElement, canvas: HTMLCanvasElement, svg: string) {
    this.host = host;
    this.img = img;
    this.c = canvas;
    this.svg = svg;
    this.reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    host.addEventListener("pointermove", this.onMove);
    host.addEventListener("pointerleave", this.onLeave);
    host.addEventListener("pointerdown", this.onDown);
    this.reduce.addEventListener("change", this.onReduce);
  }

  destroy() {
    this.host.removeEventListener("pointermove", this.onMove);
    this.host.removeEventListener("pointerleave", this.onLeave);
    this.host.removeEventListener("pointerdown", this.onDown);
    this.reduce.removeEventListener("change", this.onReduce);
    this.stop();
  }

  // ———— 事件 ————
  private onMove = (ev: PointerEvent) => {
    if (ev.pointerType !== "mouse") return;
    if (!this.hover) {
      if (this.reduce.matches || !this.wake()) return;
      this.ptr = this.canvasPt(ev);
      this.hover = true;
      this.enter(performance.now());
    }
    this.ptr = this.canvasPt(ev);
    this.host.style.cursor = ["armed", "cracked", "rest"].includes(this.mode) ? "pointer" : "";
  };

  private onLeave = () => {
    this.host.style.cursor = "";
    if (!this.hover) return;
    this.hover = false;
    this.ptr = null;
    this.leave(performance.now());
  };

  private onDown = (ev: PointerEvent) => {
    if (this.reduce.matches || ev.button !== 0 || !this.wake()) return;
    const now = performance.now();
    const cp = this.canvasPt(ev);
    this.ptr = cp;
    // 触屏没有悬停：碎片还在落时再点一下就当移开，开始复原
    if (ev.pointerType !== "mouse" && this.mode === "fall") {
      this.hover = false;
      this.leave(now);
      return;
    }
    if (!this.hover) {
      this.hover = true;
      this.enter(now);
    }
    if (this.catNear(cp)) this.catHop();
    this.strike(now, [cp[0] - this.ox, cp[1] - this.oy]);
  };

  /** 系统中途打开「减少动态效果」：立刻回到静止 */
  private onReduce = () => {
    if (!this.reduce.matches) return;
    this.hover = false;
    this.ptr = null;
    this.stop();
  };

  private canvasPt(ev: PointerEvent): Pt {
    const r = this.c.getBoundingClientRect();
    return [(ev.clientX - r.left) * this.dpr, (ev.clientY - r.top) * this.dpr];
  }

  // ———— 起停 ————

  /** 确保动画在跑；从静止唤醒时按当前布局与 DPR 重新量一次。字标还没排版出来就不动 */
  private wake(): boolean {
    if (this.raf) return true;
    if (this.img.getBoundingClientRect().width === 0) return false;
    try {
      this.setup();
    } catch {
      return false; // 画布不可用时字标保持静止，不影响其他功能
    }
    this.last = null;
    this.raf = requestAnimationFrame(this.tick);
    return true;
  }

  /** 停下、清空画布、回到原来的 <img> */
  private stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.mode = "rest";
    this.layers = [];
    this.frags = [];
    this.cat = newCat();
    this.sh = { x: 0, y: 0, vx: 0, vy: 0 };
    this.host.style.cursor = "";
    this.showImg();
  }

  private tick = (now: number) => {
    this.raf = 0;
    this.frame(now);
    const idle = !this.hover && this.mode === "rest" && !this.cat.on && !this.shaking();
    if (idle) this.showImg();
    else this.raf = requestAnimationFrame(this.tick);
  };

  private showImg() {
    if (this.ready && !this.blank) {
      ctx2d(this.c).setTransform(1, 0, 0, 1, 0, 0);
      ctx2d(this.c).clearRect(0, 0, this.c.width, this.c.height);
    }
    this.blank = true;
    this.img.style.opacity = "";
  }

  private setup() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ir = this.img.getBoundingClientRect(),
      hr = this.host.getBoundingClientRect();
    // 画布只盖字标带：左右到侧栏两沿，上下到字标带的上下沿（碎片落在下沿上）
    const band = this.host.closest<HTMLElement>("[data-brand-band]")?.getBoundingClientRect();
    const box = band ?? {
      left: ir.left - PAD_X,
      right: ir.right + PAD_X,
      top: ir.top - PAD_Y,
      bottom: ir.bottom + PAD_Y,
    };
    // 画布尺寸取整到设备像素，CSS 尺寸反算回来，画布不做缩放
    this.c.width = Math.round((box.right - box.left) * dpr);
    this.c.height = Math.round((box.bottom - box.top) * dpr);
    const s = this.c.style;
    s.left = `${box.left - hr.left}px`;
    s.top = `${box.top - hr.top}px`;
    s.width = `${this.c.width / dpr}px`;
    s.height = `${this.c.height / dpr}px`;
    this.dpr = dpr;
    // 字标宽取整到设备像素：实测 WebKit 与 Chromium 都把 93.78px 宽的 <img> 画进 188 个设备像素，
    // 按精确宽画，右端会和 <img> 差小半个像素，猫出现、画布接管的那一刻看得出跳动
    const mw = Math.round(ir.width * dpr);
    this.rw = mw;
    this.rh = Math.round(ir.height * dpr);
    this.ox = Math.round((ir.left - box.left) * dpr);
    this.oy = Math.round((ir.top - box.top) * dpr);

    const root = getComputedStyle(document.documentElement);
    const v = (name: string) => root.getPropertyValue(name).trim();
    this.col = {
      ink: v("--ink"),
      paper: v("--paper"),
      mute: v("--ink-mute"),
      edge: v("--ctl-edge"),
    };

    // 字标位图：按 SVG 的路径、填色与裁切逐条填出来
    this.shapes ??= parseWordmark(this.svg);
    const kx = mw / VIEW_W,
      ky = this.rh / VIEW_H;
    this.base = makeCanvas(this.rw, this.rh);
    const bg = ctx2d(this.base);
    bg.setTransform(kx, 0, 0, ky, 0, 0);
    for (const sh of this.shapes) {
      bg.save();
      if (sh.clip) bg.clip(sh.clip);
      bg.fillStyle = sh.tone;
      bg.fill(sh.path);
      bg.restore();
    }
    this.data = bg.getImageData(0, 0, this.rw, this.rh).data;
    this.layer = makeCanvas(this.rw, this.rh);
    this.crackImg = makeCanvas(this.rw, this.rh);

    const front = new Path2D();
    for (const [d, tx] of FRONT)
      front.addPath(new Path2D(d), new DOMMatrix([kx, 0, 0, -ky, tx * kx, BASELINE * ky]));
    this.front = front;
    this.baseline = BASELINE * ky;

    this.mode = "rest";
    this.layers = [];
    this.frags = [];
    this.cat = newCat();
    this.catCv = this.catTint = this.catWh = null;
    this.blank = true;
    this.ready = true;
  }

  // ———— 一震：有阻尼的弹簧（晃两三下停住） ————
  private kick(strength: number, R: Rand) {
    const a = Math.PI / 2 + (R() - 0.5) * 1.4,
      v = strength * this.rh * 3.2;
    this.sh.vx += Math.cos(a) * v;
    this.sh.vy += Math.sin(a) * v;
  }

  private stepShake(dt: number) {
    const s = this.sh,
      w = 78,
      z = 0.16;
    s.vx += (-w * w * s.x - 2 * z * w * s.vx) * dt;
    s.vy += (-w * w * s.y - 2 * z * w * s.vy) * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
  }

  private shaking() {
    const s = this.sh;
    return Math.abs(s.x) + Math.abs(s.y) + (Math.abs(s.vx) + Math.abs(s.vy)) / 78 > 0.05;
  }

  // ———— 画：字标 + 裂纹（近处线粗、远处线细；主裂纹瞬间炸开，细纹随后爬出；敲击点闪一下） ————
  private composeCracks(now: number, alpha = 1) {
    const L = this.layer,
      g = ctx2d(L),
      base = Math.max(0.9, 0.55 * this.dpr);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    g.clearRect(0, 0, L.width, L.height);
    g.drawImage(this.base, 0, 0);
    g.globalCompositeOperation = "source-atop";
    g.lineCap = "round";
    g.lineJoin = "round";
    const W = [1.3, 0.95, 0.75],
      A = [0.95, 0.82, 0.66];
    // 主裂纹 --ink-mute，次级裂纹 --ctl-edge（DESIGN「敲玻璃」）
    for (const main of [true, false]) {
      g.strokeStyle = main ? this.col.mute : this.col.edge;
      for (let b = 0; b < 3; b++) {
        g.globalAlpha = A[b] * alpha * (main ? 1 : 0.85);
        g.lineWidth = Math.max(0.7, base * W[b] * (main ? 1 : 0.55));
        g.beginPath();
        for (const l of this.layers) {
          const t = Math.max(0, (now - l.t0) / 1000);
          const reach = main
            ? l.target * (1 - Math.exp(-t / l.tauMain))
            : l.target * (1 - Math.exp(-Math.max(0, t - l.delayB) / l.tauB));
          for (const sg of l.segs) {
            if (sg.main !== main) continue;
            const bucket = sg.d0 < l.target * 0.25 ? 0 : sg.d0 < l.target * 0.6 ? 1 : 2;
            if (bucket !== b) continue;
            const q = reach - sg.d0;
            if (q <= 0) continue;
            const { pts, cum } = sg;
            g.moveTo(...pts[0]);
            for (let i = 1; i < pts.length; i++) {
              if (q >= cum[i]) {
                g.lineTo(...pts[i]);
                continue;
              }
              const f = (q - cum[i - 1]) / (cum[i] - cum[i - 1]);
              g.lineTo(
                pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
                pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f,
              );
              break;
            }
          }
        }
        g.stroke();
      }
    }
    // 敲击点的一下闪光：画布色由中心向外淡到透明
    for (const l of this.layers) {
      const t = (now - l.t0) / 1000,
        a = 0.8 * Math.exp(-t / 0.05) * alpha;
      if (a < 0.02) continue;
      const rad = this.rh * (0.14 + t * 1.6),
        gr = g.createRadialGradient(l.ix, l.iy, 0, l.ix, l.iy, rad);
      gr.addColorStop(0, this.col.paper);
      gr.addColorStop(1, transparentOf(this.col.paper));
      g.globalAlpha = a;
      g.fillStyle = gr;
      g.fillRect(l.ix - rad, l.iy - rad, rad * 2, rad * 2);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
  }

  private crackAnimating(now: number) {
    return this.layers.some((l) => (now - l.t0) / 1000 < 1.4) || this.shaking();
  }

  private clear(g: CanvasRenderingContext2D) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.c.width, this.c.height);
  }

  private drawLayer(g: CanvasRenderingContext2D) {
    this.clear(g);
    g.drawImage(this.layer, this.ox + this.sh.x, this.oy + this.sh.y);
  }

  private drawRest(g: CanvasRenderingContext2D) {
    this.clear(g);
    g.drawImage(this.base, this.ox, this.oy);
  }

  private drawFrags(g: CanvasRenderingContext2D) {
    this.clear(g);
    const atlas = this.atlas;
    if (!atlas) return;
    for (const f of this.frags) {
      const cs = Math.cos(f.r),
        sn = Math.sin(f.r);
      g.setTransform(cs, sn, -sn, cs, f.px + this.sh.x, f.py + this.sh.y);
      g.drawImage(atlas, f.ax, f.ay, f.sw, f.sh, -f.sw / 2, -f.sh / 2, f.sw, f.sh);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ———— 交互 ————
  private rollNeed() {
    this.need = 2 + Math.floor(Math.random() * 3); // 敲 2～4 下才碎，每次随机
  }

  private enter(now: number) {
    this.hoverSince = now;
    if (this.mode === "fall") {
      this.pendingRebuild = false;
      return;
    }
    if (this.mode === "rebuild") {
      this.collapseFromRebuild();
      return;
    }
    if (this.mode === "rest") {
      this.layers = [];
      this.hits = 0;
      this.rollNeed();
      this.mode = "armed";
    }
  }

  private leave(now: number) {
    this.catExit(false);
    if (this.mode === "armed") {
      this.mode = "rest";
      return;
    }
    if (this.mode === "cracked" || this.mode === "crack") {
      this.mode = "heal";
      this.e0 = now;
      return;
    }
    if (this.mode === "fall") {
      this.pendingRebuild = true;
      this.leftAt = now;
    }
  }

  private strike(now: number, lp: Pt) {
    if (this.mode === "fall" || this.mode === "crack") return;
    if (this.mode === "mend" || this.mode === "heal") {
      this.mode = "rest";
      this.layers = [];
      this.dirty = true;
    }
    if (this.mode === "rebuild") {
      this.collapseFromRebuild();
      return;
    }
    if (this.mode === "rest") this.enter(now);
    const R = rng((Math.random() * 1e9) | 0),
      fr = fracture(this.rw, this.rh, lp[0], lp[1], R);
    this.hits++;
    const final = this.hits >= this.need,
      s = 0.45 + (0.55 * this.hits) / this.need;
    this.composed = false;
    this.layers.push({
      ...fr,
      t0: now,
      target: final ? fr.maxD * 1.12 : this.rh * (0.55 + (1.1 * this.hits) / this.need),
      tauMain: final ? 0.07 : 0.05,
      tauB: final ? 0.14 : 0.17,
      delayB: 0.03,
    });
    this.kick(final ? 1.25 : s, R);
    if (final) {
      this.mode = "crack";
      this.c0 = now;
      this.finalFr = fr;
    } else this.mode = "cracked";
  }

  // ———— 猫：停留时从字标右侧进来，在字母之间走来走去；鼠标靠近就躲开；点到附近会跳一下 ————
  private catSize() {
    return this.rh * 0.52; // 字标高度的 0.52 倍（DESIGN 定稿）
  }

  private catStart() {
    const s = this.catSize();
    this.cat = {
      ...newCat(),
      on: true,
      state: "walk",
      x: this.ox + this.rw + s * 1.2,
      target: this.ox + this.rw * (0.3 + Math.random() * 0.4),
    };
  }

  private catExit(fast: boolean) {
    const c = this.cat;
    if (!c.on) return;
    c.state = "exit";
    c.dir = c.x > this.ox + this.rw * 0.5 ? 1 : -1;
    c.fast = fast;
  }

  private catTurnTo(dir: number) {
    const c = this.cat;
    if (c.face === dir || c.turn) return;
    c.turn = { t: 0, from: c.face, to: dir };
  }

  private stepCat(dt: number, now: number) {
    const c = this.cat,
      s = this.catSize(),
      lo = this.ox + s * 0.8,
      hi = this.ox + this.rw - s * 0.8;
    if (!c.on) {
      if (
        !this.reduce.matches &&
        this.hover &&
        (this.mode === "armed" || this.mode === "cracked") &&
        (now - this.hoverSince) / 1000 > HOVER_DELAY
      )
        this.catStart();
      return;
    }
    c.clock += dt;
    c.tilt += ((c.state === "pause" && !c.turn ? 1 : 0) - c.tilt) * Math.min(1, dt * 5);
    c.sit += ((c.state === "pause" && c.t > 0.35 && !c.turn ? 1 : 0) - c.sit) * Math.min(1, dt * 4);
    if (!this.hover && c.state !== "exit") this.catExit(false);
    const bodyY = (c.gy ?? this.oy + this.baseline) - s * 0.5;
    // 鼠标靠近：被吓一下，加快几步走开
    if (this.ptr && (c.state === "walk" || c.state === "pause")) {
      const dx = c.x - this.ptr[0],
        dy = bodyY - this.ptr[1];
      if (Math.abs(dx) < s * 1.1 && Math.abs(dy) < s * 1.2) {
        let d = dx >= 0 ? 1 : -1;
        if ((d > 0 && c.x > hi - s) || (d < 0 && c.x < lo + s)) d = -d;
        c.state = "flee";
        c.t = 0;
        c.dir = d;
        c.target = d > 0 ? hi : lo;
      }
    }
    if (c.state === "walk") {
      c.dir = Math.sign(c.target - c.x) || c.dir;
      if (Math.abs(c.target - c.x) < s * 0.15) {
        c.state = "pause";
        c.t = 0;
        c.pauseFor = 1.6 + Math.random() * 2;
      }
    } else if (c.state === "flee") {
      c.t += dt;
      if (c.t > 0.9) {
        c.state = "walk";
        c.target = lo + Math.random() * (hi - lo);
      }
    } else if (c.state === "pause") {
      c.t += dt;
      if (this.ptr && c.t > 0.5) {
        const d = Math.sign(this.ptr[0] - c.x); // 鼠标在身后：转过来看你
        if (d && d !== c.face) this.catTurnTo(d);
      }
      if (c.t > c.pauseFor) {
        c.state = "walk";
        c.target = lo + Math.random() * (hi - lo);
      }
    }
    // 方向与脸朝向不一致：先停下，再慢慢转身
    const wantDir = c.state === "pause" ? 0 : c.dir;
    if (wantDir && wantDir !== c.face && !c.turn && Math.abs(c.v) < s * 0.08)
      this.catTurnTo(wantDir);
    if (c.turn) {
      c.turn.t += dt;
      if (c.turn.t >= 0.45) {
        c.face = c.turn.to;
        c.turn = null;
      }
    }
    const speed: Record<CatState, number> = {
      walk: s * 0.8,
      flee: s * 2.1,
      exit: s * (c.fast ? 2.6 : 1.2),
      pause: 0,
      hidden: 0,
    };
    const wander = 1 + 0.12 * Math.sin(c.clock * 0.9) + 0.06 * Math.sin(c.clock * 2.3);
    const canGo = !c.turn && (wantDir === 0 || wantDir === c.face || c.state === "exit");
    const want = canGo && wantDir ? speed[c.state] * wander * wantDir : 0;
    if (c.state === "exit" && wantDir !== c.face) c.face = wantDir;
    const tau = c.state === "flee" ? 0.25 : 0.55;
    c.v += (want - c.v) * (1 - Math.exp(-dt / tau));
    c.x += c.v * dt;
    if (c.state !== "exit") {
      if (c.x < lo) {
        c.x = lo;
        c.target = hi;
      }
      if (c.x > hi) {
        c.x = hi;
        c.target = lo;
      }
    }
    c.phase = (c.phase + (Math.abs(c.v) * dt) / (s * 0.6)) % 1; // 一个步态周期走 0.6 个身高，与步幅一致（着地的脚不打滑）
    const fallen = this.mode === "fall" || this.mode === "rebuild" || this.mode === "mend";
    const ground = fallen ? this.c.height - Math.max(1, this.dpr) : this.oy + this.baseline;
    if (c.gy == null) {
      c.gy = ground;
      c.gvy = 0;
    }
    if (c.gy < ground - 0.5) {
      c.gvy += this.rh * 14 * dt;
      c.gy = Math.min(ground, c.gy + c.gvy * dt);
    } else {
      c.gy = ground;
      c.gvy = 0;
    }
    if (c.hop) {
      c.hop.t += dt;
      if (c.hop.t > 0.5) c.hop = null;
    }
    if (c.state === "exit" && (c.x > this.c.width + s * 1.5 || c.x < -s * 1.5)) {
      c.on = false;
      c.state = "hidden";
      this.dirty = true;
    }
  }

  private catNear(cp: Pt) {
    const c = this.cat,
      s = this.catSize();
    return (
      c.on &&
      Math.abs(cp[0] - c.x) < s * 1.1 &&
      Math.abs(cp[1] - (this.oy + this.baseline - s * 0.5)) < s
    );
  }

  private catHop() {
    const c = this.cat;
    if (!c.on || c.hop) return;
    c.hop = { t: 0 };
    c.state = "flee";
    c.t = 0;
    if (!c.turn) c.dir = c.face;
  }

  /** 小黑猫：大圆头、微侧的脸露出两只眼睛、大三角耳、细长腿、螺旋卷尾。
      慢走是四拍「侧对步」：左后→左前→右后→右前依次落地；着地的脚钉在地上不打滑。
      sit 0→1 从站姿过渡到坐姿；look 是瞳孔看的方向；whisk 只画须子（须子不描白边） */
  private catSilhouette(g: CanvasRenderingContext2D, p: CatPose, whisk: boolean) {
    const { s, fx, ph, moving, clock, pausing, fleeing, tilt, sit, look } = p;
    const { ink, paper, mute } = this.col;
    g.save();
    g.scale(fx * s, s);
    g.fillStyle = g.strokeStyle = ink;
    g.lineCap = "round";
    g.lineJoin = "round";
    const lerp = (A: Pt, B: Pt, k: number): Pt => [
      A[0] + (B[0] - A[0]) * k,
      A[1] + (B[1] - A[1]) * k,
    ];
    const add = (A: Pt, B: Pt): Pt => [A[0] + B[0], A[1] + B[1]];
    const e = smooth(sit),
      duty = 0.64,
      stride = 0.6 * duty * moving;
    const foot = (nx: number, off: number, lift: number): Pt => {
      const u = (((ph + off) % 1) + 1) % 1;
      if (u < duty) return [nx + stride * (0.5 - u / duty), 0];
      const w = (u - duty) / (1 - duty),
        q = smooth(w);
      return [nx + stride * (-0.5 + q), -lift * Math.sin(Math.PI * w) * moving];
    };
    const ik = (R: Pt, F: Pt, a: number, b: number, bend: number): Pt => {
      const dx = F[0] - R[0],
        dy = F[1] - R[1],
        d = Math.min(Math.hypot(dx, dy), a + b - 1e-4),
        th = Math.atan2(dy, dx);
      const al = Math.acos(Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d))));
      return [R[0] + a * Math.cos(th + bend * al), R[1] + a * Math.sin(th + bend * al)];
    };
    const shb = Math.sin((ph * 2 + 0.25) * Math.PI * 2) * 0.014 * moving;
    const hp = Math.sin((ph * 2 + 0.75) * Math.PI * 2) * 0.014 * moving;
    const H = lerp([-0.3, -0.41 + hp], [-0.2, -0.2], e),
      S = lerp([0.15, -0.42 + shb], [0.08, -0.46], e);
    const hb = Math.sin((ph * 2 + 0.1) * Math.PI * 2) * 0.008 * moving;
    const Hd = add(S, lerp([0.19, -0.3 + hb], [0.1, -0.33], e));
    const headT = () => {
      g.translate(Hd[0], Hd[1]);
      g.rotate(-tilt * 0.18);
    };
    if (whisk) {
      g.lineWidth = Math.max(0.007, 1 / s);
      g.strokeStyle = mute;
      headT();
      const sides: [number, number, number, number][] = [
        [-0.14, 0.08, -1, 0.2],
        [0.24, 0.06, 1, 0.3],
      ];
      for (const [ox, oy, sx, L] of sides) {
        for (const k of [-1, 0, 1]) {
          g.beginPath();
          g.moveTo(ox, oy + k * 0.02);
          g.quadraticCurveTo(
            ox + sx * L * 0.55,
            oy + k * 0.035 - 0.03,
            ox + sx * L,
            oy + k * 0.07 - 0.02,
          );
          g.stroke();
        }
      }
      g.restore();
      return;
    }
    // 腿：站着走 ↔ 坐下（前腿直立、后腿折进臀部）
    const legs: [number, boolean][] = [
      [0, false],
      [0.25, true],
      [0.5, false],
      [0.75, true],
    ];
    legs.forEach(([off, fore], i) => {
      const side = i < 2 ? -1 : 1;
      if (fore) {
        const F = lerp(foot(0.18, off, 0.07), [0.11 + side * 0.025, 0], e),
          E = ik(S, F, 0.23, 0.23, 1);
        g.lineWidth = 0.075;
        g.beginPath();
        g.moveTo(...S);
        g.lineTo(...E);
        g.lineTo(...F);
        g.stroke();
        g.beginPath();
        g.ellipse(F[0] + 0.02, F[1] - 0.025, 0.055, 0.035, 0, 0, Math.PI * 2);
        g.fill();
      } else {
        const Fw = foot(-0.3, off, 0.065),
          F = lerp(Fw, [-0.02 + side * 0.02, 0], e);
        const A = lerp(add(Fw, [-0.05, -0.1]), [-0.2, -0.03], e),
          K = ik(H, A, 0.18, 0.17, -1);
        g.lineWidth = 0.08;
        g.beginPath();
        g.moveTo(...H);
        g.lineTo(...K);
        g.lineTo(...A);
        g.lineTo(...F);
        g.stroke();
        g.beginPath();
        g.ellipse(F[0] + 0.02, F[1] - 0.025, 0.055, 0.035, 0, 0, Math.PI * 2);
        g.fill();
      }
    });
    // 尾巴：从臀部升起，末端卷成螺旋；尾尖慢慢摆，受惊时往后放平
    {
      const B = add(H, [-0.12, -0.1]);
      const sw =
        Math.sin(clock * 1.3) * 0.08 +
        (pausing ? Math.sin(clock * 3.1) * 0.05 : 0) +
        (fleeing ? 0.7 : 0);
      g.save();
      g.translate(...B);
      g.rotate(-sw - e * 0.15);
      const pts: Pt[] = [];
      const bz = (a: number, b: number, c: number, d: number, u: number) =>
        a * (1 - u) ** 3 + 3 * b * u * (1 - u) ** 2 + 3 * c * u * u * (1 - u) + d * u ** 3;
      for (let i = 0; i <= 16; i++) {
        const u = i / 16;
        pts.push([bz(0, -0.2, -0.22, -0.04, u), bz(0, -0.03, -0.42, -0.52, u)]);
      }
      const P = pts[16],
        tx = 0.18,
        ty = -0.1,
        tl = Math.hypot(tx, ty);
      const cx = P[0] + (-ty / tl) * 0.085,
        cy = P[1] + (tx / tl) * 0.085;
      const a0 = Math.atan2(P[1] - cy, P[0] - cx);
      for (let i = 1; i <= 18; i++) {
        const u = i / 18,
          r = 0.085 * (1 - 0.45 * u),
          an = a0 + u * 3.8;
        pts.push([cx + r * Math.cos(an), cy + r * Math.sin(an)]);
      }
      g.lineWidth = 0.085;
      g.beginPath();
      g.moveTo(...pts[0]);
      for (const q of pts) g.lineTo(...q);
      g.stroke();
      g.restore();
    }
    // 身子：臀、胸两团，中间收一点腰
    g.lineWidth = 0.28;
    g.beginPath();
    g.moveTo(...H);
    g.lineTo(...S);
    g.stroke();
    g.beginPath();
    g.ellipse(
      H[0] - 0.02,
      H[1] - 0.01 - e * 0.02,
      0.17 + e * 0.04,
      0.155 + e * 0.04,
      0,
      0,
      Math.PI * 2,
    );
    g.fill();
    g.beginPath();
    g.ellipse(S[0] + 0.04, S[1] + 0.01, 0.14, 0.17, -0.3 * e, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 0.17;
    g.beginPath();
    g.moveTo(...S);
    g.lineTo(Hd[0] - 0.04, Hd[1] + 0.08);
    g.stroke();
    // 头
    g.save();
    headT();
    g.beginPath();
    g.ellipse(0, 0, 0.24, 0.215, 0, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.ellipse(0.03, 0.07, 0.25, 0.15, 0, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 0.03;
    const ear = (b1: Pt, tp: Pt, b2: Pt, bow: number) => {
      g.beginPath();
      g.moveTo(...b1);
      g.quadraticCurveTo((b1[0] + tp[0]) / 2 + bow, (b1[1] + tp[1]) / 2, ...tp);
      g.quadraticCurveTo((b2[0] + tp[0]) / 2 + bow * 0.5, (b2[1] + tp[1]) / 2 + 0.02, ...b2);
      g.closePath();
      g.fill();
      g.stroke();
    };
    ear([-0.22, -0.07], [-0.26, -0.37], [-0.08, -0.19], 0.03);
    ear([0.06, -0.2], [0.26, -0.31], [0.22, -0.06], -0.02);
    // 眼睛：一近一远，瞳孔看向 look；偶尔眨眼
    const bl = clock % 3.6 < 0.13 ? 0.1 : 1,
      ll = Math.hypot(look[0], look[1]) || 1,
      lx = look[0] / ll,
      ly = look[1] / ll;
    const eyes: [number, number, number][] = [
      [-0.04, 0, 0.085],
      [0.14, -0.05, 0.072],
    ];
    for (const [ex, ey, r] of eyes) {
      g.fillStyle = paper;
      g.beginPath();
      g.ellipse(ex, ey, r, r * bl, 0, 0, Math.PI * 2);
      g.fill();
      if (bl < 1) continue;
      const pr = r * 0.56,
        m = r - pr - 0.006,
        px = ex + lx * m,
        py = ey + ly * m;
      g.fillStyle = ink;
      g.beginPath();
      g.arc(px, py, pr, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = paper;
      g.beginPath();
      g.arc(px + pr * 0.35, py - pr * 0.35, pr * 0.22, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = mute; // 鼻头
    g.beginPath();
    g.moveTo(0.05, 0.07);
    g.lineTo(0.09, 0.07);
    g.lineTo(0.07, 0.095);
    g.closePath();
    g.fill();
    g.restore();
    g.restore();
  }

  /** 猫：黑身 + 一圈画布色描边（八方向各偏一点叠出来），再叠上不描边的灰须子 */
  private drawCatBody(g: CanvasRenderingContext2D) {
    const c = this.cat;
    if (!c.on) return;
    const s = this.catSize(),
      dpr = this.dpr,
      hop = c.hop ? Math.sin(Math.PI * clamp01(c.hop.t / 0.5)) * s * 0.9 : 0;
    const moving = Math.min(1, Math.abs(c.v) / (s * 0.5)) * (c.turn ? 0.35 : 1);
    let fx = c.face;
    if (c.turn) {
      const e = smooth(clamp01(c.turn.t / 0.45));
      fx = c.turn.from * Math.cos(Math.PI * e);
      if (Math.abs(fx) < 0.12) fx = 0.12 * (e < 0.5 ? c.turn.from : c.turn.to);
    }
    const pad = Math.ceil(s * 0.3),
      W = Math.ceil(s * 2.4) + pad * 2,
      H = Math.ceil(s * 1.3) + pad * 2;
    if (!this.catCv || !this.catTint || !this.catWh || this.catCv.width !== W) {
      this.catCv = makeCanvas(W, H);
      this.catTint = makeCanvas(W, H);
      this.catWh = makeCanvas(W, H);
    }
    const ground = c.gy ?? this.oy + this.baseline;
    const gy0 = ground - hop,
      hx = c.x + fx * s * 0.33,
      hy = gy0 - s * 0.66;
    const look: Pt =
      this.ptr && c.state !== "exit"
        ? [(this.ptr[0] - hx) * Math.sign(fx), this.ptr[1] - hy]
        : [1, -0.15];
    const pose: CatPose = {
      s,
      fx,
      ph: c.phase,
      moving,
      clock: c.clock,
      pausing: c.state === "pause",
      fleeing: c.state === "flee" || (c.state === "exit" && c.fast),
      tilt: c.tilt,
      sit: c.sit,
      look,
    };
    const paint = (cv: HTMLCanvasElement, whisk: boolean) => {
      const cg = ctx2d(cv);
      cg.setTransform(1, 0, 0, 1, 0, 0);
      cg.clearRect(0, 0, W, H);
      cg.translate(W / 2, H - pad);
      this.catSilhouette(cg, pose, whisk);
    };
    paint(this.catCv, false);
    paint(this.catWh, true);
    const tg = ctx2d(this.catTint);
    tg.setTransform(1, 0, 0, 1, 0, 0);
    tg.clearRect(0, 0, W, H);
    tg.globalCompositeOperation = "source-over";
    tg.drawImage(this.catCv, 0, 0);
    tg.globalCompositeOperation = "source-in";
    tg.fillStyle = this.col.paper;
    tg.fillRect(0, 0, W, H);
    tg.globalCompositeOperation = "source-over";
    const gx = c.x + this.sh.x - W / 2,
      gy = ground + this.sh.y - hop - (H - pad),
      h = Math.max(1.2, dpr * 1.2);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    for (let a = 0; a < 8; a++)
      g.drawImage(
        this.catTint,
        gx + Math.cos((a * Math.PI) / 4) * h,
        gy + Math.sin((a * Math.PI) / 4) * h,
      );
    g.drawImage(this.catCv, gx, gy);
    g.drawImage(this.catWh, gx, gy);
    g.restore();
  }

  /** 画在字标上：底图 → 猫 → 再把前层字母盖回来 */
  private drawCatWeave(g: CanvasRenderingContext2D, src: HTMLCanvasElement) {
    if (!this.cat.on) return;
    this.drawCatBody(g);
    g.save();
    g.setTransform(1, 0, 0, 1, this.ox + this.sh.x, this.oy + this.sh.y);
    g.clip(this.front);
    g.drawImage(src, 0, 0);
    g.restore();
  }

  // ———— 碎开：由近及远依次脱落，碎片上带着裂纹 ————
  private shatter(now: number) {
    this.composeCracks(now);
    const cg = ctx2d(this.crackImg);
    cg.clearRect(0, 0, this.rw, this.rh);
    cg.drawImage(this.layer, 0, 0);
    const fr = this.finalFr ?? fracture(this.rw, this.rh, this.rw / 2, this.rh / 2, Math.random);
    const R = rng((Math.random() * 1e9) | 0),
      rh = this.rh;
    const t0 = performance.now();
    this.frags = this.segment();
    // 切分是唯一的逐像素重活，留一条 User Timing 记录，开发者工具的 Performance 里看得到
    performance.measure("glass-mark:segment", { start: t0 });
    this.impact = [this.ox + fr.ix, this.oy + fr.iy];
    this.maxD = fr.maxD;
    const maxA = Math.max(1, ...this.frags.map((f) => f.sw * f.sh));
    this.G = rh * 14;
    for (const f of this.frags) {
      const light = 1 - Math.sqrt((f.sw * f.sh) / maxA);
      const dx = f.px - this.impact[0],
        dy = f.py - this.impact[1],
        d = Math.hypot(dx, dy) || 1,
        dn = d / rh;
      f.rel = (d / fr.maxD) * 0.3 + R() * 0.05; // 近处先脱落
      const mag = rh * (1.9 / (1 + dn * 2.2)) * (0.6 + light * 0.8); // 远处几乎只是塌落
      f.vx = (dx / d) * mag + (R() - 0.5) * rh * 0.25;
      f.vy = (dy / d) * mag * 0.6 - (rh * (R() * 0.35 + light * 0.45)) / (1 + dn);
      f.w = (R() - 0.5) * (1.2 + 6 / (1 + dn)) * (0.5 + light);
      f.e = 0.18 + light * 0.22;
    }
    this.mode = "fall";
    this.pendingRebuild = false;
    this.catExit(true);
  }

  /** 逐像素切分（labelShards），再把每块碎片连同它身上的裂纹拷进一张图集（packShards 排格子）：
      像素只拷一次、只上传一次，画的时候 drawImage 取各自那一格。
      以前每块碎片一张小画布，WebKit 里光是建这三十多张画布就要十几毫秒 */
  private segment(): Shard[] {
    const { rw, rh } = this;
    const ck = ctx2d(this.crackImg).getImageData(0, 0, rw, rh).data;
    const { lab, regions } = labelShards(
      this.data,
      ck,
      rw,
      rh,
      Math.max(3, 5 * this.dpr * this.dpr),
    );
    const { cells, w: AW, h: AH } = packShards(regions, rw);
    const atlas = new ImageData(AW, AH),
      od = atlas.data;
    const frags: Shard[] = [];
    regions.forEach((r, i) => {
      const sw = r.x1 - r.x0 + 1,
        sh = r.y1 - r.y0 + 1,
        [ax, ay] = cells[i],
        edge: Pt[] = [];
      for (let y = r.y0; y <= r.y1; y++) {
        for (let x = r.x0; x <= r.x1; x++) {
          const j = y * rw + x;
          if (lab[j] !== r.id) continue;
          const p = j * 4,
            q = ((ay + y - r.y0) * AW + (ax + x - r.x0)) * 4;
          od[q] = ck[p];
          od[q + 1] = ck[p + 1];
          od[q + 2] = ck[p + 2];
          od[q + 3] = ck[p + 3];
          const border = x === 0 || y === 0 || x === rw - 1 || y === rh - 1;
          if (
            border ||
            lab[j - 1] !== r.id ||
            lab[j + 1] !== r.id ||
            lab[j - rw] !== r.id ||
            lab[j + rw] !== r.id
          ) {
            edge.push([x - r.x0, y - r.y0], [x - r.x0 + 1, y - r.y0 + 1]);
          }
        }
      }
      // 格子外面一圈复制边上的像素（先上下两行，再左右两列连角一起）
      const at = (x: number, y: number) => (y * AW + x) * 4;
      od.copyWithin(at(ax, ay - 1), at(ax, ay), at(ax + sw, ay));
      od.copyWithin(at(ax, ay + sh), at(ax, ay + sh - 1), at(ax + sw, ay + sh - 1));
      for (let y = ay - 1; y <= ay + sh; y++) {
        od.copyWithin(at(ax - 1, y), at(ax, y), at(ax + 1, y));
        od.copyWithin(at(ax + sw, y), at(ax + sw - 1, y), at(ax + sw, y));
      }
      const pts = hull(edge).map(([x, y]): Pt => [x - sw / 2, y - sh / 2]);
      const hcx = this.ox + r.x0 + sw / 2,
        hcy = this.oy + r.y0 + sh / 2;
      frags.push({
        ax,
        ay,
        sw,
        sh,
        pts,
        hcx,
        hcy,
        px: hcx,
        py: hcy,
        r: 0,
        vx: 0,
        vy: 0,
        w: 0,
        e: 0.2,
        size: Math.max(sw, sh),
        rel: 0,
        sleep: false,
        still: 0,
        landed: false,
        delay: 0,
        lifted: false,
        liftV: 0,
      });
    });
    // 图集画布够大就沿用（putImageData 连透明像素一起覆盖，不用先清），不够才换一张
    if (!this.atlas || this.atlas.width < AW || this.atlas.height < AH)
      this.atlas = makeCanvas(AW, AH);
    ctx2d(this.atlas).putImageData(atlas, 0, 0);
    return frags;
  }

  private collapseFromRebuild() {
    for (const f of this.frags) {
      f.rel = 0;
      f.sleep = false;
      f.still = 0;
    }
    this.mode = "fall";
    this.pendingRebuild = false;
  }

  private stepFall(dt: number) {
    const G = this.G,
      floor = this.c.height - Math.max(1, this.dpr),
      CW = this.c.width,
      mu = 0.55;
    for (const f of this.frags) {
      if (f.sleep) continue;
      if (f.rel > 0) {
        f.rel -= dt;
        continue;
      }
      f.vy += G * dt;
      f.vx *= Math.exp(-0.35 * dt);
      f.w *= Math.exp(-0.4 * dt);
      f.px += f.vx * dt;
      f.py += f.vy * dt;
      f.r += f.w * dt;
      const cs = Math.cos(f.r),
        sn = Math.sin(f.r);
      let maxY = -1e9,
        lowX = 0,
        minX = 1e9,
        maxX = -1e9;
      for (const [x, y] of f.pts) {
        const ry = x * sn + y * cs,
          rx = x * cs - y * sn;
        if (ry > maxY) {
          maxY = ry;
          lowX = rx;
        }
        if (rx < minX) minX = rx;
        if (rx > maxX) maxX = rx;
      }
      if (f.px + minX < 0) {
        f.px = -minX;
        f.vx = Math.abs(f.vx) * 0.35;
      }
      if (f.px + maxX > CW) {
        f.px = CW - maxX;
        f.vx = -Math.abs(f.vx) * 0.35;
      }
      if (f.py + maxY >= floor) {
        f.py = floor - maxY;
        f.landed = true;
        if (f.vy > 0) {
          const imp = f.vy;
          f.vy = imp > G * 0.035 ? -imp * f.e : 0;
          f.w += -(lowX / (f.size * f.size)) * imp * 0.7; // 角先着地会翻一下
        }
        const dv = mu * G * dt;
        f.vx = Math.abs(f.vx) <= dv ? 0 : f.vx - Math.sign(f.vx) * dv; // 库仑摩擦：匀减速滑停
        f.w -= (lowX / f.size) * (G / f.size) * dt * 0.8; // 靠重心倒向平面
        f.w *= Math.exp(-5 * dt);
        if (Math.abs(f.vx) < 1 && Math.abs(f.vy) < this.rh * 0.05 && Math.abs(f.w) < 0.06) {
          f.still += dt;
          if (f.still > 0.18) {
            f.sleep = true;
            f.vx = f.vy = f.w = 0;
          }
        } else f.still = 0;
      }
    }
  }

  // ———— 复原：先被轻轻托起，再由阻尼弹簧拉回原位（带一点过冲），由近及远依次归位；最后裂纹淡去 ————
  private startRebuild() {
    const R = rng((Math.random() * 1e9) | 0);
    for (const f of this.frags) {
      f.r = wrapAngle(f.r);
      f.sleep = false;
      const d = Math.hypot(f.hcx - this.impact[0], f.hcy - this.impact[1]);
      f.delay = 0.04 + (d / this.maxD) * 0.42 + R() * 0.1;
      f.lifted = false;
      f.liftV = this.rh * (0.45 + R() * 0.3);
    }
    this.mode = "rebuild";
  }

  private stepRebuild(dt: number) {
    const w = 7.2,
      z = 0.86;
    let done = true;
    for (const f of this.frags) {
      if (f.delay > 0) {
        f.delay -= dt;
        done = false;
        continue;
      }
      if (!f.lifted) {
        f.lifted = true;
        f.vy = Math.min(f.vy, 0) - f.liftV;
        f.vx *= 0.2;
        f.w *= 0.2;
      }
      f.vx += (-w * w * (f.px - f.hcx) - 2 * z * w * f.vx) * dt;
      f.vy += (-w * w * (f.py - f.hcy) - 2 * z * w * f.vy) * dt;
      f.w += (-w * w * f.r - 2 * z * w * f.w) * dt;
      f.px += f.vx * dt;
      f.py += f.vy * dt;
      f.r += f.w * dt;
      const off = Math.abs(f.px - f.hcx) + Math.abs(f.py - f.hcy) > this.rh * 0.012;
      if (off || Math.abs(f.vx) + Math.abs(f.vy) > this.rh * 0.12 || Math.abs(f.r) > 0.02)
        done = false;
    }
    return done;
  }

  private reset(now: number) {
    this.layers = [];
    this.hits = 0;
    this.frags = [];
    this.mode = this.hover ? "armed" : "rest";
    if (this.mode === "armed") {
      this.rollNeed();
      this.hoverSince = now;
    }
    this.dirty = true;
  }

  private frame(now: number) {
    const dt = Math.min(1 / 30, Math.max(0, (now - (this.last ?? now)) / 1000));
    this.last = now;
    const sub = (n: (h: number) => void) => {
      let left = dt;
      while (left > 1e-6) {
        const h = Math.min(left, 1 / 240);
        n(h);
        left -= h;
      }
    };
    sub((h) => this.stepShake(h));
    sub((h) => this.stepCat(h, now));
    let healA = 1,
      mendA = 0;
    if (this.mode === "crack" && (now - this.c0) / 1000 >= 0.16) this.shatter(now);
    if (this.mode === "heal") {
      const k = easeOut(clamp01((now - this.e0) / 1000 / 0.32));
      healA = 1 - k;
      if (k >= 1) this.reset(now);
    }
    if (this.mode === "fall") {
      sub((h) => this.stepFall(h));
      if (this.pendingRebuild) {
        const lim = this.rh * 0.4;
        const settled = this.frags.every(
          (f) =>
            f.sleep || (f.landed && f.rel <= 0 && Math.abs(f.vy) < lim && Math.abs(f.vx) < lim),
        );
        if (settled || (now - this.leftAt) / 1000 > 1.2) {
          this.pendingRebuild = false;
          this.startRebuild();
        }
      }
    }
    if (this.mode === "rebuild") {
      let done = false;
      sub((h) => {
        done = this.stepRebuild(h);
      });
      if (done) {
        this.mode = "mend";
        this.m0 = now;
      }
    }
    if (this.mode === "mend") {
      sub((h) => this.stepRebuild(h));
      const k = easeOut(clamp01((now - this.m0) / 1000 / 0.8));
      mendA = 1 - k;
      if (k >= 1) this.reset(now);
    }

    const g = ctx2d(this.c);
    // 字标原样、没有猫、没在晃：交给 <img>，画布留空
    const plain =
      (this.mode === "rest" || this.mode === "armed") && !this.cat.on && !this.shaking();
    if (plain) {
      this.dirty = false;
      this.showImg();
      return;
    }
    const crackBusy = this.layers.length > 0 && this.crackAnimating(now);
    const moving =
      this.cat.on ||
      this.shaking() ||
      crackBusy ||
      !["rest", "armed", "cracked"].includes(this.mode);
    if (!moving && !this.dirty && !this.blank) return;
    this.dirty = false;
    this.blank = false;
    this.img.style.opacity = "0";
    switch (this.mode) {
      case "rest":
      case "armed":
        this.drawRest(g);
        this.drawCatWeave(g, this.base);
        break;
      case "cracked":
        if (crackBusy || !this.composed) {
          this.composeCracks(now);
          this.composed = true;
        }
        this.drawLayer(g);
        this.drawCatWeave(g, this.layer);
        break;
      case "crack":
        this.composeCracks(now);
        this.drawLayer(g);
        this.drawCatWeave(g, this.layer);
        break;
      case "heal":
        this.composeCracks(now, healA);
        this.drawLayer(g);
        this.drawCatWeave(g, this.layer);
        break;
      case "fall":
      case "rebuild":
        this.drawFrags(g);
        this.drawCatBody(g);
        break;
      case "mend":
        this.drawFrags(g);
        g.globalAlpha = 1 - mendA; // 完整字标在碎片上约 0.8 秒渐显，裂纹愈合
        g.drawImage(this.base, this.ox, this.oy);
        g.globalAlpha = 1;
        break;
    }
  }
}

interface CatPose {
  s: number;
  fx: number;
  ph: number;
  moving: number;
  clock: number;
  pausing: boolean;
  fleeing: boolean;
  tilt: number;
  sit: number;
  look: Pt;
}

/** 同一颜色的全透明版本（径向渐变的外圈要淡到「透明的画布色」，淡到黑色透明会发灰）。
    token 是 #rrggbb，补上 00 的 alpha 位即可；认不出的写法退回 transparent */
function transparentOf(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}00` : "transparent";
}
