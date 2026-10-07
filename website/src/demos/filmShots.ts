/// 首屏短片第 2–5 镜头的纯逻辑（#242，spec R7）：每个镜头的「起点 / 终点」姿态、共享元素飞行的几何、光标路径、打字节奏。
/// 不 import astro / DOM。DOM 一侧在 src/client/film-shots/（poses.ts 把这里的姿态摆到页面上，各镜头文件按这里的节奏演）。
/// 终点姿态 = 镜头的完整画面，也是服务端渲出来的静态样子（关 JS、静止帧、暂停、点进度条前一段都是它）；
/// 起点姿态 = 演示开始时的样子。两个姿态都在这里写一处，Astro 与客户端共用。
import { AGENTS as MATRIX_AGENTS, type CellState } from "./skills-matrix.ts";

export type Phase = "start" | "end";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Point = [number, number];

/// 元素相对舞台左上角的位置与大小
export function relativeRect(
  r: { left: number; top: number; width: number; height: number },
  origin: { left: number; top: number },
): Rect {
  return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
}

/// 共享元素飞行：克隆体摆在 a 处，以中心为原点平移 + 缩放后，中心与大小都落在 b 上
export function flyDelta(a: Rect, b: Rect): { dx: number; dy: number; sx: number; sy: number } {
  return {
    dx: b.x + b.w / 2 - (a.x + a.w / 2),
    dy: b.y + b.h / 2 - (a.y + a.h / 2),
    sx: b.w / a.w,
    sy: b.h / a.h,
  };
}
export function flyTransform(d: { dx: number; dy: number; sx: number; sy: number }): string {
  return `translate(${d.dx}px, ${d.dy}px) scale(${d.sx}, ${d.sy})`;
}

/// 光标从 from 走到 to：中途点往一侧鼓出去一点（走弧线，不是直线），距离越远走得越久（420–880ms）
export function cursorPath(from: Point, to: Point): { mid: Point; duration: number } {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const d = Math.hypot(dx, dy) || 1;
  const bow = Math.min(56, d * 0.16);
  return {
    mid: [(from[0] + to[0]) / 2 - (dy / d) * bow, (from[1] + to[1]) / 2 + (dx / d) * bow],
    duration: Math.max(420, Math.min(880, d * 1.5)),
  };
}

export interface Frame {
  left: string;
  top: string;
  width: string;
  height: string;
  borderRadius: string;
}

/// 「任意模型」的下划线飞成选中框：起点是关键词底下一道 3px 的线（长度取词宽的 86%，避开句号），终点正好套住模型卡
export function selectionFrames(em: Rect, mod: Rect, trim = 0.86): [Frame, Frame] {
  return [
    {
      left: `${em.x}px`,
      top: `${em.y + em.h - 4}px`,
      width: `${em.w * trim}px`,
      height: "3px",
      borderRadius: "3px",
    },
    {
      left: `${mod.x}px`,
      top: `${mod.y}px`,
      width: `${mod.w}px`,
      height: `${mod.h}px`,
      borderRadius: "14px",
    },
  ];
}

// ---------- 第 2 镜头：skill 矩阵 ----------

/// 两行：第 1 行是演示的主角（点三格补齐），第 2 行是陪衬。列同 skill 区的表（skills-matrix 的 AGENTS）
const MATRIX_START: CellState[][] = [
  ["original", "open", "open", "open"],
  ["added", "added", "added", "open"],
];
export const MATRIX_ROWS = ["pr-review", "brand-voice"] as const;
export const MATRIX_COLS = MATRIX_AGENTS;

export function matrixPose(phase: Phase): CellState[][] {
  const rows = MATRIX_START.map((r) => [...r]);
  if (phase === "end") rows[0] = rows[0]!.map((s) => (s === "open" ? "added" : s));
  return rows;
}

/// 这一行里能用的 agent 数（已加上 + 原件）：提示条「pr-review：4 个 agent 都能用了」里的数
export function usableCount(row: readonly CellState[]): number {
  return row.filter((s) => s === "added" || s === "original").length;
}

// ---------- 第 3 镜头：开关与模型卡 ----------

/// 模型卡：模型名不翻译；vendor 为 null 是官方模型（标签走目录 models.official）。厂商在模型区示例服务商里（测试核对）
export const FILM_MODELS: readonly { id: string; vendor: string | null }[] = [
  { id: "gpt-5.5", vendor: null },
  { id: "deepseek-v4", vendor: "DeepSeek" },
  { id: "kimi-k3", vendor: "Kimi" },
];
/// 开关打开后选中的那张（飞进对话框的也是它）
export const PICKED_MODEL = 1;

/// 开关数由站点配置的 agent 名单决定（R17.1，页面里从 SITE.agents 渲染），这里只管 n 个开关的姿态
export function modelsPose(phase: Phase, switchCount: number) {
  const on = phase === "end";
  return {
    switches: Array<boolean>(switchCount).fill(on),
    modsShown: on,
    picked: on ? PICKED_MODEL : null,
  };
}

/// 点开关时光标走到后停的一拍：第一下瞄得久一点，之后渐快（字幕先读完由 READ_BEAT 管，不在这里）
export function tapWaits(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i === 0 ? 220 : 160));
}

// ---------- 第 4 镜头：对话 ----------

/// 起点：只有第一轮（问 + 答）、模型键还没出现；终点：换模型后的第二轮也在，键在
export function chatPose(phase: Phase) {
  return phase === "end" ? { messages: 4, chip: true } : { messages: 2, chip: false };
}

/// 逐字打出来：按字符（不是 UTF-16 单元）给出每一步的前缀，英文的空格原样保留
export function typedPrefixes(text: string): string[] {
  const chars = Array.from(text);
  return chars.map((_, i) => chars.slice(0, i + 1).join(""));
}

/// 每个字的间隔：短句用 max，长句压进 total（英文比中文长得多）；不快过 12ms
export function typeDelay(text: string, { max, total }: { max: number; total: number }): number {
  const n = Array.from(text).length;
  if (n === 0) return max;
  return Math.max(12, Math.min(max, total / n));
}

// ---------- 第 5 镜头：菜单栏用量 ----------

export function usagePose(phase: Phase) {
  return { open: phase === "end" };
}

// ---------- 第 5 镜头 → 片尾：托盘图标落成字标的 S（对接镜头） ----------
// 托盘图标、标志、字标首字母是同一个字形（Barlow Condensed 700 的 S + 左下重影，assets/logo/）。
// 下面的数取自 assets/logo/tray.svg 与 wordmark(-inverse).svg（tests/film-shots.test.ts 逐项对过，重新生成图标后测试会提醒）。
// 字形坐标是字体单位（y 向上）；每张图把它映射到自己的 viewBox：主体 S 的位置、缩放、重影相对主体的错位。

/// 托盘图标：705 见方，`translate(main) scale(k, -k) translate(-origin)`；重影的水平错位是标志的 1.6 倍（光学补偿）
export const TRAY_GLYPH = {
  box: 705,
  k: 0.838,
  main: [472.5, 324.5],
  ghost: [232.5, 380.5],
  origin: [223.5, 350],
} as const;
/// 字标：3304 × 916，`translate(main) scale(1, -1)`；重影只属于首字母 S
export const WORDMARK_GLYPH = {
  w: 3304,
  h: 916,
  main: [215, 808],
  ghost: [36, 874.8266666666667],
} as const;
/// 字标里 S（含重影）之后、O 之前的一条竖线（viewBox 单位；S 右缘 635、O 左缘 788）。
/// ShotEnd.astro 的 `--s-cut` 按它裁（字标只露 S），两处一起改
export const WORDMARK_S_CUT = 700;
/// 字标 S 的三档灰（重影、主体、重合处浅一档）：浅色 wordmark.svg、深色 wordmark-inverse.svg。托盘图标没有「重合处」这一档
export const WORDMARK_S_FILLS = {
  light: { ghost: "#c8c8d0", main: "#000000", overlap: "#9a9aa2" },
  dark: { ghost: "#5a5a5f", main: "#ffffff", overlap: "#c8c8d0" },
} as const;
/// 托盘图标的重影是主体颜色的 45%（模板图只留透明度）
export const TRAY_GHOST_OPACITY = 0.45;

/// 对接：一张与字标同 viewBox、同大小、摆在字标位置（word）上的 S，要让它此刻正好盖在托盘图标（tray）的 S 上，
/// 给它的变换（`transform-origin: 0 0` 下的 `translate(tx, ty) scale(s)`；飞到 `none` 就与字标重合）。
/// 另给重影要先挪开的量（字标 viewBox 单位）：托盘图标的重影更靠左，飞的途中挪回字标的错位
export function trayToWordmark(
  tray: Rect,
  word: Rect,
): { tx: number; ty: number; s: number; ghostDx: number; ghostDy: number } {
  const T = TRAY_GLYPH;
  const W = WORDMARK_GLYPH;
  // 每个字体单位在屏幕上多少像素
  const kt = (tray.w / T.box) * T.k;
  const kw = word.w / W.w;
  // 托盘图标里字形原点（字体单位 0,0）的屏幕位置
  const ox = tray.x + (tray.w / T.box) * (T.main[0] - T.k * T.origin[0]);
  const oy = tray.y + (tray.h / T.box) * (T.main[1] + T.k * T.origin[1]);
  return {
    tx: ox - word.x - kt * W.main[0],
    ty: oy - word.y - kt * W.main[1],
    s: kt / kw,
    ghostDx: (T.ghost[0] - T.main[0]) / T.k - (W.ghost[0] - W.main[0]),
    ghostDy: (T.ghost[1] - T.main[1]) / T.k - (W.ghost[1] - W.main[1]),
  };
}
