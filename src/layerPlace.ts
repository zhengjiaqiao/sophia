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
