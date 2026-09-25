import { useCallback, useEffect, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { edgeFades, NO_FADE, type EdgeFade } from "./edgeFades.ts";

/// 滚动边缘渐隐（DESIGN「渐变只用于功能」）：可滚动区域哪一边还有被裁掉的内容，那一边出 16px 渐隐
/// （`--fade-edge`，从底色渐到透明）。两件：
/// - `useEdgeFades` 量：哪一边此刻有被裁掉的内容（滚动、容器改尺寸、内容变了都重量）
/// - `FadeViewport` 画：包在滚动区外面，按量到的结果在上 / 下沿出渐隐（浮层里从 `paper`，机面上从 `face`）
/// 横向的（机面左右沿）只用得上量：画法归外壳。全应用只有这一份监听，页面不再各写一份

export { edgeFades, NO_FADE } from "./edgeFades.ts";
export type { EdgeFade } from "./edgeFades.ts";

/// 量一个滚动容器：`axis` 纵向（默认）看上下，横向看左右。
/// 滚动、容器或它的直接内容改尺寸时重量；拥有它的组件每次重绘后也量一次（内容换了、高度没变的情形）
export function useEdgeFades(ref: RefObject<HTMLElement | null>, axis: "y" | "x" = "y"): EdgeFade {
  const [fade, setFade] = useState<EdgeFade>(NO_FADE);
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next =
      axis === "y"
        ? edgeFades(el.scrollTop, el.clientHeight, el.scrollHeight)
        : edgeFades(el.scrollLeft, el.clientWidth, el.scrollWidth);
    setFade((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, [ref, axis]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (observer) {
      observer.observe(el);
      for (const child of Array.from(el.children)) observer.observe(child);
    }
    return () => {
      el.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [ref, update]);

  // 每次重绘后再量一次：内容换了但容器与第一层尺寸都没变时（浮层里勾选改了行），上面的监听收不到
  useEffect(() => {
    update();
  });

  return fade;
}

/// 带渐隐的外层：上 / 下还有被裁掉的内容时，那一边 16px 渐隐（从 paper 或 face，由 `tone` 定）。
/// 滚动的是里面那一层（调用方的元素，挂 `useEdgeFades` 的 ref）
export function FadeViewport({
  fade,
  tone = "paper",
  className,
  children,
}: {
  fade: EdgeFade;
  /// 渐隐从哪种底色开始：浮层里是 paper，机面上是 face
  tone?: "paper" | "face";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`ss-layer__viewport${tone === "face" ? " ss-layer__viewport--face" : ""}${className ? ` ${className}` : ""}`}
      data-fade-top={fade.start || undefined}
      data-fade-bottom={fade.end || undefined}
    >
      {children}
    </div>
  );
}
