/// 首屏短片的「机位」几何（spec R7，DESIGN「官网」短片一节的机位语言）：纯函数，不碰 DOM，测试在 tests/film-camera.test.ts。
/// 镜头里除字幕、提示条之外的内容都在一个 `.cam` 层里，机位就是给它的 translate + scale（transform-origin 0 0）。
/// DOM 一侧（读机位、运镜、景深）在 src/client/film-shots/camera.ts。
///
/// 坐标：内容坐标 = 机位归位时相对舞台左上角的坐标（.cam 与 .shot、舞台同一个框）。
/// 机位 p 下，内容点 q 落在画面 (x + s·qx, y + s·qy)。两个机位之间按同一缓动插值时，translate 与 scale 都线性于进度，
/// 所以任一内容点在画面上走的是直线、与进度同步——光标、涟漪、揭开的圆只要用同一缓动、同一时长，就始终贴在同一个内容点上。
import type { Point, Rect } from "./filmShots.ts";

export interface Pose {
  s: number;
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

/// 归位：不放大、不平移。rest() 的完整画面就是它
export const HOME: Pose = { s: 1, x: 0, y: 0 };

/// 运镜的缓动：慢起慢停（同站内 --ease-mech 的家族，但两头都收，推拉不显得「弹」）
export const CAM_EASE = "cubic-bezier(.65,0,.35,1)";

/// 景深外的东西：暗一点、虚一点（推近时不是主角的那部分）
export const DOF = { opacity: 0.38, blur: 1.6 };

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function poseTransform(p: Pose): string {
  return `translate(${p.x}px, ${p.y}px) scale(${p.s})`;
}

/// 机位 p 下，内容点 q 在画面上的位置
export function onScreen(p: Pose, q: Point): Point {
  return [p.x + p.s * q[0], p.y + p.s * q[1]];
}

/// 画面点 q 在机位 p 下对应的内容点
export function toContent(p: Pose, q: Point): Point {
  return [(q[0] - p.x) / p.s, (q[1] - p.y) / p.s];
}

/// 机位 p 下，内容矩形 r 在画面上的矩形
export function rectOnScreen(p: Pose, r: Rect): Rect {
  const [x, y] = onScreen(p, [r.x, r.y]);
  return { x, y, w: r.w * p.s, h: r.h * p.s };
}

/// 放大 s 倍、让内容点 q 落在画面 to 处的机位
export function aimAt(q: Point, s: number, to: Point): Pose {
  return { s, x: to[0] - s * q[0], y: to[1] - s * q[1] };
}

/// 以画面点 at 为不动点，把机位再放大 k 倍（k < 1 是退远）：转场里「接着往前推」「从远处推进来」用
export function zoomAbout(p: Pose, at: Point, k: number): Pose {
  return { s: p.s * k, x: at[0] - k * (at[0] - p.x), y: at[1] - k * (at[1] - p.y) };
}

/// 机位整体平移（摇镜头）：内容在画面上移动 (dx, dy)
export function panBy(p: Pose, dx: number, dy: number): Pose {
  return { s: p.s, x: p.x + dx, y: p.y + dy };
}

/// 向上摇（「抬头就知道」）：下一镜头的世界摞在这一镜头的上面一格（相距 gap × 舞台高）。
/// 机位往上摇时两层一起往下走同一段距离、同一缓动——看起来是一台机器摇过去，不是两张画各自滑动。
/// landing：摇到位时下一镜头的机位（可以是推近的）；返回两层各自的起止机位
export function tiltUp(landing: Pose, stageH: number, gap = 1.05) {
  const d = stageH * gap;
  return { outFrom: HOME, outTo: panBy(HOME, 0, d), inFrom: panBy(landing, 0, -d), inTo: landing };
}

/// 推近的倍数：想推到 want 倍，但 keep 宽（内容坐标）放大后要能留在画面里（左右各留 margin）；不低于 min
export function fitScale(want: number, keepW: number, stageW: number, margin = 16, min = 1): number {
  return Math.max(min, Math.min(want, (stageW - 2 * margin) / keepW));
}

/// 构图：放大 s 倍，把 focus（内容坐标）带到画面的 to；再平移让 keep（内容坐标，通常是整张卡片）尽量留在画面里（四周留 margin）。
/// 某一边放不下时，那一边保持以焦点构图
export function frame(s: number, focus: Point, to: Point, keep: Rect, stage: Size, margin = 16): Pose {
  const p = aimAt(focus, s, to);
  const fit = (pos: number, start: number, size: number, room: number) => {
    const a = pos + s * start;
    const b = a + s * size;
    if (b - a > room - 2 * margin) return pos;
    if (a < margin) return pos + (margin - a);
    if (b > room - margin) return pos - (b - (room - margin));
    return pos;
  };
  return { s, x: fit(p.x, keep.x, keep.w, stage.w), y: fit(p.y, keep.y, keep.h, stage.h) };
}

/// 机位下的共享元素飞行：克隆体按元素自己的版面大小（不受机位缩放影响的 w0 × h0）摆在 a（画面矩形）的中心，
/// 起始缩放 a.w / w0（= 来源机位的放大倍数），这样克隆体第一帧与画面里的原件一样大、字也一样大。
/// 返回克隆体的盒子与起止 transform（都以盒子中心为原点）
export function flyFrames(a: Rect, w0: number, h0: number, b: Rect): { box: Rect; from: string; to: string } {
  const box = { x: a.x + a.w / 2 - w0 / 2, y: a.y + a.h / 2 - h0 / 2, w: w0, h: h0 };
  const k = a.w / w0;
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  return {
    box,
    from: `translate(0px, 0px) scale(${k}, ${k})`,
    to: `translate(${dx}px, ${dy}px) scale(${b.w / w0}, ${b.h / h0})`,
  };
}

/// 穿过圆点转场的「洞」：一张软边圆形遮罩（radial-gradient，实心到 SOFT_EDGE 处、再到边缘透明），
/// 圆心沿 start → end 的直线走（与机位同缓动，所以一直对着圆点），推到 open 进度时才从 0 张开，到终点盖满整个画面。
/// 返回 WAAPI 关键帧（mask-size / mask-position，遮罩图本身在 CSS 的 .shot.portal 上）
export const SOFT_EDGE = 0.8;
// 类型别名而不是 interface：要能直接交给 Element.animate（Keyframe 带字符串索引签名）
export type HoleFrame = {
  maskSize: string;
  maskPosition: string;
  offset: number;
};
export function holeFrames(start: Point, end: Point, open: number, stage: Size): HoleFrame[] {
  const at = (c: Point, d: number) => ({ maskSize: `${d}px ${d}px`, maskPosition: `${c[0] - d / 2}px ${c[1] - d / 2}px` });
  const mid: Point = [lerp(start[0], end[0], open), lerp(start[1], end[1], open)];
  // 终点：实心部分的半径够到离圆心最远的角
  const far = Math.max(
    ...[
      [0, 0],
      [stage.w, 0],
      [0, stage.h],
      [stage.w, stage.h],
    ].map(([x, y]) => Math.hypot(x! - end[0], y! - end[1])),
  );
  const d = (2 * far) / SOFT_EDGE;
  return [
    { ...at(start, 0), offset: 0 },
    { ...at(mid, 0), offset: open },
    { ...at(end, d), offset: 1 },
  ];
}
