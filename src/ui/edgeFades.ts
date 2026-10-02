/// 滚动边缘渐隐的判定（纯函数，DESIGN「渐变只用于功能」）：可滚动区域哪一边还有被裁掉的内容，那一边出渐隐。
/// 量与画在 EdgeFade.tsx（`useEdgeFades` / `FadeViewport`）；这里单放一个 .ts，node:test 与页面的纯逻辑模块也能直接用

/// 两端各有没有被裁掉的内容：纵向是上 / 下，横向是左 / 右
export interface EdgeFade {
  start: boolean;
  end: boolean;
}

export const NO_FADE: EdgeFade = { start: false, end: false };

/// 滚过的距离、可见长度、内容长度 → 两端要不要渐隐。留 1px 容差，免得小数像素误判
export function edgeFades(offset: number, viewport: number, content: number): EdgeFade {
  if (content - viewport <= 1) return { start: false, end: false };
  return { start: offset > 1, end: offset + viewport < content - 1 };
}
