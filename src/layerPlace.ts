/// 小浮层（来源页的目标浮层、`+ 来源`，MCP 的同名挑选浮层）的定位规则，纯函数、不碰 DOM。
///
/// - 默认从触发控件下方 `gap` 展开；只有下方放不下、上方放得下时才往上翻；
///   两边都放不下时选空间大的一侧，浮层内部滚动。
/// - 最大高度取「朝向那一侧剩余的可用空间」与 `cap`（约 360）中较小的；「放得下」按这个上限比，
///   内容再多也只要求放下 `cap` 那么高。
/// - 左右：左沿对齐触发控件；右边越界时改为右沿对齐触发控件；仍越界就贴着窗口边距。

export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface LayerPlacement {
  top: number;
  left: number;
  /// 浮层的最大高度；内容更高时在浮层内部滚动
  maxHeight: number;
  side: "below" | "above";
}

export const LAYER_GAP = 6;
/// 离窗口边缘至少留这么多
export const LAYER_MARGIN = 16;
export const LAYER_CAP = 360;

export function placeLayer(
  anchor: AnchorRect,
  /// 浮层不设高度上限时的自然尺寸
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: { gap?: number; margin?: number; cap?: number } = {},
): LayerPlacement {
  const gap = opts.gap ?? LAYER_GAP;
  const margin = opts.margin ?? LAYER_MARGIN;
  const cap = opts.cap ?? LAYER_CAP;
  const below = Math.max(0, viewport.height - margin - (anchor.bottom + gap));
  const above = Math.max(0, anchor.top - gap - margin);
  const need = Math.min(size.height, cap);
  const side =
    need <= below ? "below" : need <= above ? "above" : below >= above ? "below" : "above";
  const maxHeight = Math.min(cap, side === "below" ? below : above);
  const height = Math.min(size.height, maxHeight);
  const top = side === "below" ? anchor.bottom + gap : anchor.top - gap - height;

  const right = viewport.width - margin;
  let left = anchor.left;
  if (left + size.width > right) left = anchor.right - size.width;
  left = Math.max(margin, Math.min(left, right - size.width));
  return { top, left, maxHeight, side };
}

// ===== 浮起的提示小窗（DESIGN「反馈的两种形态」「浮起小窗的位置」） =====

/// 提示小窗与锚点的间距：锚点正下方 4
export const TOAST_GAP = 4;
/// 提示小窗离窗口四边至少留这么多（DESIGN「出现的那一刻定位，之后钉在窗口上」：贴窗口四边留 16）
export const TOAST_MARGIN = 16;

/// 水平对齐：
/// - `center` 单格：居中于格；靠近边界右沿放不下时右对齐该格
/// - `start` 一行 / 来源片 / 设置项：左对齐锚点（行的名字）；放不下时右对齐锚点
/// - `end` 批量的键：右对齐该键右沿、向左展开；左边放不下时左对齐锚点
export type ToastAlign = "center" | "start" | "end";

export interface ToastPlacement {
  top: number;
  left: number;
  side: "below" | "above";
}

/// 提示小窗放哪：默认锚点正下方 `gap`；下方放不下、上方放得下才翻到上方——
/// 两种都**不盖住锚点**（被点的控件、它所说的那一格 / 那一行）。水平按 `align`，
/// 再夹进 `bounds`（面板左右沿；不给就是窗口）与窗口四边 16 之内。
/// 只在出现的那一刻算一次（FloatingToast），之后不随滚动重算
export function placeToast(
  anchor: AnchorRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: {
    align?: ToastAlign;
    gap?: number;
    margin?: number;
    bounds?: { left: number; right: number };
  } = {},
): ToastPlacement {
  const align = opts.align ?? "center";
  const gap = opts.gap ?? TOAST_GAP;
  const margin = opts.margin ?? TOAST_MARGIN;

  const belowTop = anchor.bottom + gap;
  const aboveTop = anchor.top - gap - size.height;
  const fitsBelow = belowTop + size.height <= viewport.height - margin;
  const side = !fitsBelow && aboveTop >= margin ? "above" : "below";
  // 两边都放不下（窗口太矮）：最后一招，夹回窗口里
  const top =
    side === "below"
      ? Math.max(margin, Math.min(belowTop, viewport.height - margin - size.height))
      : aboveTop;

  const lo = Math.max(margin, opts.bounds?.left ?? margin);
  const hi = Math.min(viewport.width - margin, opts.bounds?.right ?? viewport.width - margin);
  const w = size.width;
  let left: number;
  if (align === "center") {
    left = (anchor.left + anchor.right) / 2 - w / 2;
    if (left + w > hi) left = anchor.right - w;
    if (left < lo) left = anchor.left;
  } else if (align === "start") {
    left = anchor.left;
    if (left + w > hi) left = anchor.right - w;
  } else {
    left = anchor.right - w;
    if (left < lo) left = anchor.left;
  }
  left = Math.max(lo, Math.min(left, hi - w));
  return { top, left, side };
}
