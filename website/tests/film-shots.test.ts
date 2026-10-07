/// 首屏短片第 2–5 镜头的纯逻辑（#242，spec R7、R17.1、AC5）：起点 / 终点的姿态、共享元素飞行的几何、光标路径、打字节奏。
/// 镜头的视觉编排本身在浏览器里看；这里只测不依赖 DOM 的部分。
import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_PROVIDERS } from "../src/demos/models.ts";
import { FilmPlayer, type Shot, type ShotCtx } from "../src/demos/film.ts";
import { AGENTS as MATRIX_AGENTS } from "../src/demos/skills-matrix.ts";
import { readFileSync } from "node:fs";
import {
  FILM_MODELS,
  PICKED_MODEL,
  TRAY_GHOST_OPACITY,
  TRAY_GLYPH,
  WORDMARK_GLYPH,
  WORDMARK_S_CUT,
  WORDMARK_S_FILLS,
  trayToWordmark,
  chatPose,
  cursorPath,
  flyDelta,
  flyTransform,
  matrixPose,
  modelsPose,
  relativeRect,
  selectionFrames,
  tapWaits,
  typeDelay,
  typedPrefixes,
  usableCount,
  usagePose,
} from "../src/demos/filmShots.ts";

test("relativeRect：取元素相对舞台左上角的位置与大小", () => {
  assert.deepEqual(relativeRect({ left: 130, top: 90, width: 40, height: 20 }, { left: 100, top: 50 }), { x: 30, y: 40, w: 40, h: 20 });
});

test("共享元素飞行：以中心为原点缩放平移后，中心与大小都落在目标上", () => {
  const a = { x: 40, y: 60, w: 100, h: 36 };
  const b = { x: 300, y: 20, w: 70, h: 28 };
  const d = flyDelta(a, b);
  // 变换后的中心 = 原中心 + 平移；大小 = 原大小 × 缩放
  assert.equal(a.x + a.w / 2 + d.dx, b.x + b.w / 2);
  assert.equal(a.y + a.h / 2 + d.dy, b.y + b.h / 2);
  assert.equal(a.w * d.sx, b.w);
  assert.equal(a.h * d.sy, b.h);
  assert.equal(flyTransform(d), `translate(${d.dx}px, ${d.dy}px) scale(${d.sx}, ${d.sy})`);
  assert.equal(flyTransform({ dx: 0, dy: 0, sx: 1, sy: 1 }), "translate(0px, 0px) scale(1, 1)");
});

test("光标路径：中途点偏离直线（走弧线），时长夹在 420–880ms，原地不动也不出 NaN", () => {
  const p = cursorPath([0, 0], [400, 0]);
  assert.ok(Math.abs(p.mid[1]) > 1, "中点要离开直线");
  assert.equal(p.mid[0] | 0, 200);
  assert.equal(p.duration, 600);
  assert.equal(cursorPath([0, 0], [10, 0]).duration, 420);
  assert.equal(cursorPath([0, 0], [2000, 0]).duration, 880);
  const same = cursorPath([5, 5], [5, 5]);
  assert.ok(Number.isFinite(same.mid[0]) && Number.isFinite(same.mid[1]));
  assert.equal(same.duration, 420);
});

test("下划线飞成选中框：起点是关键词底下一道 3px 的线，终点正好套住模型卡", () => {
  const em = { x: 100, y: 50, w: 200, h: 30 };
  const mod = { x: 240, y: 180, w: 160, h: 42 };
  const [from, to] = selectionFrames(em, mod);
  assert.equal(from.height, "3px");
  assert.equal(from.left, "100px");
  assert.equal(from.width, `${200 * 0.86}px`);
  assert.equal(from.top, `${50 + 30 - 4}px`);
  assert.deepEqual([to.left, to.top, to.width, to.height], ["240px", "180px", "160px", "42px"]);
  assert.equal(to.borderRadius, "14px");
});

test("第 2 镜头：起点第 1 行只有原件，点三格后终点全部可用；终点与起点只差被点的那几格", () => {
  const start = matrixPose("start");
  const end = matrixPose("end");
  assert.equal(start.length, 2);
  assert.ok(start.every((row) => row.length === MATRIX_AGENTS.length));
  assert.deepEqual(start[0], ["original", "open", "open", "open"]);
  assert.deepEqual(end[0], ["original", "added", "added", "added"]);
  // 第 2 行不变
  assert.deepEqual(start[1], end[1]);
  // 被点的格子正好是起点里「点一下加上」的那几格
  const taps = start[0].flatMap((s, c) => (s === "open" ? [c] : []));
  assert.deepEqual(taps, [1, 2, 3]);
  assert.ok(taps.every((c) => end[0][c] === "added"));
  // 提示条里的数字是终点这一行能用的 agent 数
  assert.equal(usableCount(end[0]), MATRIX_AGENTS.length);
  assert.equal(usableCount(start[0]), 1);
});

test("第 3 镜头：起点开关全关、模型卡没出现；终点开关全开、选中第 2 张；开关数跟名单走", () => {
  for (const n of [1, 2, 3]) {
    const s = modelsPose("start", n);
    assert.deepEqual(s.switches, Array(n).fill(false));
    assert.equal(s.modsShown, false);
    assert.equal(s.picked, null);
    const e = modelsPose("end", n);
    assert.deepEqual(e.switches, Array(n).fill(true));
    assert.equal(e.modsShown, true);
    assert.equal(e.picked, PICKED_MODEL);
  }
});

test("示例模型：厂商都在模型区的示例服务商里，被选中的是第三方模型而不是官方", () => {
  assert.equal(FILM_MODELS.length, 3);
  for (const m of FILM_MODELS) if (m.vendor) assert.ok((DEMO_PROVIDERS as readonly string[]).includes(m.vendor), m.vendor);
  assert.equal(FILM_MODELS[0]!.vendor, null, "第 1 张是官方模型");
  assert.notEqual(FILM_MODELS[PICKED_MODEL]!.vendor, null);
});

test("点开关的节奏：第一下停得久，之后渐快；n 个开关给 n 个等待", () => {
  assert.deepEqual(tapWaits(1), [220]);
  assert.deepEqual(tapWaits(3), [220, 160, 160]);
  assert.deepEqual(tapWaits(4), [220, 160, 160, 160]);
  assert.deepEqual(tapWaits(0), []);
});

test("第 4 镜头：起点只有前两条消息、模型键还没出现；终点四条都在、键在", () => {
  assert.deepEqual(chatPose("start"), { messages: 2, chip: false });
  assert.deepEqual(chatPose("end"), { messages: 4, chip: true });
});

test("第 5 镜头：起点面板收着，终点面板展开", () => {
  assert.deepEqual(usagePose("start"), { open: false });
  assert.deepEqual(usagePose("end"), { open: true });
});

test("打字：按字符（不是 UTF-16 单元）逐步给出前缀；英文的空格一个不丢", () => {
  assert.deepEqual(typedPrefixes("换个模"), ["换", "换个", "换个模"]);
  assert.deepEqual(typedPrefixes("a b "), ["a", "a ", "a b", "a b "]);
  assert.deepEqual(typedPrefixes("a😀"), ["a", "a😀"]);
  assert.deepEqual(typedPrefixes(""), []);
});

test("打字节奏：短句按最慢的一档，长句压到总时长内，不会快过 12ms", () => {
  assert.equal(typeDelay("换个模型，再讲一遍", { max: 55, total: 1100 }), 55);
  const long = "Sure. user is empty until someone signs in, so check that it exists before reading its name.";
  const d = typeDelay(long, { max: 30, total: 1200 });
  assert.ok(d >= 12 && d < 30);
  assert.ok(d * Array.from(long).length <= 1200 + 12);
  assert.equal(typeDelay("x".repeat(500), { max: 30, total: 1000 }), 12);
  assert.equal(typeDelay("", { max: 30, total: 1000 }), 30);
});

/// 记日志的假镜头（同 film.test.ts），用来核对 5 镜头时的循环与跳转、以及 #243 追加第 6 个镜头不用改播放器
function logShots(log: string[], count: number): Shot[] {
  return Array.from({ length: count }, (_, i) => ({
    duration: 100,
    enter: () => void log.push(`enter${i}`),
    async demo(ctx: ShotCtx) {
      log.push(`demo${i}`);
      await ctx.sleep(100);
    },
    exit: async () => void log.push(`exit${i}`),
    rest: () => void log.push(`rest${i}`),
  }));
}
const tick = () => new Promise<void>((r) => setImmediate(r));
function manualClock() {
  const waiting: (() => void)[] = [];
  return {
    sleep: (_ms: number) => new Promise<void>((res) => waiting.push(res)),
    async step(times: number) {
      for (let i = 0; i < times; i++) {
        await tick();
        waiting.splice(0).forEach((r) => r());
      }
      await tick();
    },
  };
}

for (const count of [5, 6]) {
  test(`${count} 个镜头：播完最后一个回到第 1 个，进度条跟着回到第 1 段`, async () => {
    const clock = manualClock();
    const log: string[] = [];
    const seen: string[] = [];
    const p = new FilmPlayer(logShots(log, count), { clock, onChange: (s) => seen.push(`${s.index}`) });
    p.play();
    await clock.step(count + 1);
    assert.deepEqual(
      seen.slice(0, count + 1),
      [...Array.from({ length: count }, (_, i) => `${i}`), "0"],
    );
  });

  test(`${count} 个镜头：点任一段，先摆好上一镜头的结尾，再从这一镜头播起`, async () => {
    for (let n = 1; n < count; n++) {
      const clock = manualClock();
      const log: string[] = [];
      const p = new FilmPlayer(logShots(log, count), { clock });
      p.seek(n);
      await clock.step(1);
      assert.deepEqual(log.slice(0, 3), [`rest${n - 1}`, `enter${n}`, `demo${n}`], `seek(${n})`);
    }
  });
}

// ---------- 第 5 镜头 → 片尾的对接：托盘图标落成字标的 S ----------

/// 读 assets/logo 里的一张图：每条 path 的 d、transform、fill（fill-opacity），按出现顺序
function logoFile(name: string): string {
  return readFileSync(new URL(`../../assets/logo/${name}`, import.meta.url), "utf8");
}
function logoPaths(name: string): { d: string; transform: string; fill?: string; opacity?: string }[] {
  const re = /<path d="([^"]+)" transform="([^"]+)"(?: fill="([^"]+)")?(?: fill-opacity="([^"]+)")?/g;
  return [...logoFile(name).matchAll(re)].map((m) => ({
    d: m[1]!,
    transform: m[2]!,
    fill: m[3],
    opacity: m[4],
  }));
}
/// 轮廓的 x 范围（字形轮廓只用绝对坐标的 M L H V Q Z）
function xRange(d: string): [number, number] {
  const xs: number[] = [];
  for (const [, cmd, args] of d.matchAll(/([MLHVQZ])([^MLHVQZ]*)/g)) {
    const n = args!.trim()
      ? args!
          .trim()
          .split(/[\s,]+/)
          .map(Number)
      : [];
    if (cmd === "H") xs.push(...n);
    else if (cmd !== "V") xs.push(...n.filter((_, i) => i % 2 === 0));
  }
  return [Math.min(...xs), Math.max(...xs)];
}

test("对接用的字形数据与 assets/logo 里的托盘图标、字标一致（重新生成图标后要跟着改）", () => {
  const T = TRAY_GLYPH;
  const [tGhost, tMain] = logoPaths("tray.svg");
  const k = T.k.toFixed(4);
  const tf = (p: readonly number[]) =>
    `translate(${p[0]} ${p[1]}) scale(${k} -${k}) translate(-${T.origin[0]} -${T.origin[1]}.0)`;
  assert.ok(logoFile("tray.svg").includes(`viewBox="0 0 ${T.box} ${T.box}"`));
  assert.equal(tMain!.transform, tf(T.main));
  assert.equal(tGhost!.transform, tf(T.ghost));
  assert.equal(tGhost!.opacity, String(TRAY_GHOST_OPACITY));

  const W = WORDMARK_GLYPH;
  for (const [file, fills] of [
    ["wordmark.svg", WORDMARK_S_FILLS.light],
    ["wordmark-inverse.svg", WORDMARK_S_FILLS.dark],
  ] as const) {
    assert.ok(logoFile(file).includes(`viewBox="0 0 ${W.w} ${W.h}"`), file);
    const paths = logoPaths(file);
    const [ghost, main, o] = paths;
    // 同一个字形：托盘图标与字标的 S 是同一条轮廓
    assert.equal(ghost!.d, tMain!.d, file);
    assert.equal(main!.d, tMain!.d, file);
    assert.equal(ghost!.transform, `translate(${W.ghost[0].toFixed(1)} ${W.ghost[1]}) scale(1 -1)`, file);
    assert.equal(main!.transform, `translate(${W.main[0]} ${W.main[1]}) scale(1 -1)`, file);
    assert.equal(ghost!.fill, fills.ghost, file);
    assert.equal(main!.fill, fills.main, file);
    // 重合处浅一档：最后一条（裁在主体里的那份重影）
    const overlap = paths.at(-1)!;
    assert.equal(overlap.transform, ghost!.transform, file);
    assert.equal(overlap.fill, fills.overlap, file);
    // 裁 S 的竖线在 S 右缘之后、O 左缘之前（O 是第 3 条：左缘 = 平移 + 轮廓最小 x）
    const oLeft = Number(o!.transform.match(/translate\(([\d.]+)/)![1]) + xRange(o!.d)[0];
    const sRight = W.main[0] + xRange(main!.d)[1];
    assert.ok(sRight < WORDMARK_S_CUT && WORDMARK_S_CUT < oLeft, `${file}: S 右缘 ${sRight}，O 左缘 ${oLeft}`);
  }
});

test("trayToWordmark：S 上任一点经变换后与托盘图标里同一点重合；变换取消后就在字标上", () => {
  const tray = { x: 500, y: 40, w: 15, h: 15 };
  const word = { x: 120, y: 200, w: (80 * 3304) / 916, h: 80 };
  const { tx, ty, s, ghostDx, ghostDy } = trayToWordmark(tray, word);
  const T = TRAY_GLYPH;
  const W = WORDMARK_GLYPH;
  for (const [gx, gy] of [
    [27, -8],
    [420, 708],
    [223.5, 350],
  ] as const) {
    // 托盘图标里：字体单位 → viewBox → 屏幕
    const trayPx = [
      tray.x + (tray.w / T.box) * (T.main[0] + T.k * (gx - T.origin[0])),
      tray.y + (tray.h / T.box) * (T.main[1] - T.k * (gy - T.origin[1])),
    ];
    // 与字标同 viewBox 的那张：字体单位 → viewBox → 元素内 → 变换（原点左上）→ 屏幕
    const local = [(word.w / W.w) * (W.main[0] + gx), (word.h / W.h) * (W.main[1] - gy)];
    const flyPx = [word.x + tx + s * local[0]!, word.y + ty + s * local[1]!];
    assert.ok(Math.abs(flyPx[0]! - trayPx[0]!) < 1e-9, `x ${gx},${gy}`);
    assert.ok(Math.abs(flyPx[1]! - trayPx[1]!) < 1e-9, `y ${gx},${gy}`);
  }
  // 托盘图标的重影水平多错开一截（标志的 1.6 倍），垂直与字标相同
  assert.ok(Math.abs(ghostDx - (-240 / 0.838 + 179)) < 1e-9);
  assert.ok(Math.abs(ghostDy) < 0.01);
});
