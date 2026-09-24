import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { edgeFades } from "../modelsView.ts";
import { placeLayer, type LayerPlacement } from "../layerPlace.ts";
import "./FloatingLayer.css";

/// 小浮层（DESIGN「浮层：下拉、提示框、提示条、确认框」的下拉 / 选择器一行）：`paper` + 1px `hairline` 边、
/// `float` 12 圆角 + `float` 投影。来源行的目标浮层、MCP 同名挑选浮层共用（原在来源管理页里，
/// 那一页随 D3 删除，搬到这里）。
///
/// 定位规则见 `placeLayer`：默认在触发控件下方 6 展开，下方放不下、上方放得下才往上翻；最大高度取
/// 朝向那一侧的剩余空间与 360 中较小的，超出在浮层内部滚动，滚动边缘渐隐（DESIGN「渐变只用于功能」）。
/// 点外面、Esc、页面滚动都关，不铺透明罩。用 fixed 定位、挂到 body 上：触发控件在滚动的列表里、
/// 还可能在吸顶块里（来源行在来源片那一块里，那一块有自己的层叠上下文，挂在原处会被下面吸顶的列头盖住）
export function FloatingLayer({
  trigger,
  onClose,
  className,
  label,
  children,
}: {
  trigger: HTMLElement;
  onClose: () => void;
  /// 挂在滚动区上：宽度、内边距、纵向排列由它定
  className: string;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<LayerPlacement | null>(null);
  const [fade, setFade] = useState({ start: false, end: false });

  // 每次渲染后重量一次：内容变了（MCP 差异取回来、勾选改了行）也按新尺寸放。
  // 自然高度＝外框高 − 滚动区可见高 + 滚动区内容高，不受当前最大高度影响；位置没变就不 setState
  useLayoutEffect(() => {
    const el = ref.current;
    const scroll = scrollRef.current;
    if (!el || !scroll) return;
    const a = trigger.getBoundingClientRect();
    const next = placeLayer(
      { top: a.top, bottom: a.bottom, left: a.left, right: a.right },
      {
        width: el.offsetWidth,
        height: el.offsetHeight - scroll.clientHeight + scroll.scrollHeight,
      },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPos((prev) =>
      prev &&
      prev.top === next.top &&
      prev.left === next.left &&
      prev.maxHeight === next.maxHeight &&
      prev.side === next.side
        ? prev
        : next,
    );
  });

  /// 滚动边缘渐隐：上面 / 下面还有被裁掉的行时，那一边出 16px 渐隐
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const next = edgeFades(el.scrollTop, el.clientHeight, el.scrollHeight);
      setFade((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  });

  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (ref.current?.contains(target) || trigger.contains(target));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 捕获阶段接走：不让页面把 Esc 当成返回 / 取消选择
      event.stopPropagation();
      event.preventDefault();
      onClose();
      trigger.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) onClose();
    };
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node && ref.current?.contains(event.target))) onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [trigger, onClose]);

  const layer = (
    <div
      ref={ref}
      className="ss-layer"
      role="menu"
      aria-label={label}
      style={
        pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight } : { visibility: "hidden" }
      }
    >
      <FadeViewport fade={fade}>
        <div ref={scrollRef} className={`ss-layer__scroll ${className}`}>
          {children}
        </div>
      </FadeViewport>
    </div>
  );
  return typeof document === "undefined" ? layer : createPortal(layer, document.body);
}

/// 带渐隐的外层：上 / 下还有被裁掉的内容时，那一边 16px 渐隐（从 paper 或 face，由 `tone` 定）
export function FadeViewport({
  fade,
  tone = "paper",
  className,
  children,
}: {
  fade: { start: boolean; end: boolean };
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
