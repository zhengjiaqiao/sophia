import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

/// 页签滑槽（DESIGN「页签 Tabs」，物件感一）。
///
/// 一条凹下去的槽（`hairline` 底、`recess-tabs` 内凹、`tab-track` 10 圆角、内边距 3），
/// 选中的那一页是槽里一枚纸面滑块（`paper` + 1px `ctl-border` 环 + `ctl-edge` 底边）——**位置＝当前页**。
/// 页签高 28、左右 16、15 / 500 `ink-mute`，选中 `ink` 600；拉丁一律小写（`skills` `mcp`：
/// 我们自己写的结构词）。页签之间没有竖线、没有下划线。
///
/// 切换时滑块沿槽平移 120ms（机械缓动；reduced-motion 即时）；按下选中的那一枚时滑块底边消失、下沉 1px。
/// 滑块的位置量自选中页签的盒子；量到之前（首帧、静态渲染）由选中的页签自己画滑块，所以没有闪烁。
///
/// 用在哪：只有一级导航。**不用在**页内筛选（那是筛选片）、网关切换（网关是列表行）。
/// 语义是导航：`<nav>` 里的按钮，当前页 `aria-current="page"`。

export interface TabItem<T extends string> {
  id: T;
  /// 原样写；拉丁由样式转小写
  label: string;
}

export interface TabsProps<T extends string> {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  /// 读屏名：这一组导航管什么（`功能`）
  label: string;
}

export function Tabs<T extends string>({ items, value, onChange, label }: TabsProps<T>) {
  const trackRef = useRef<HTMLElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);

  // 量选中页签在槽里的位置：选中变了、槽的大小变了（字体晚到、窗口缩放）都重量
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => {
      const on = track.querySelector<HTMLElement>(".ss-tabs__tab.is-on");
      if (!on) {
        setThumb(null);
        return;
      }
      // offsetLeft 与滑块的 left 都从槽的内边距盒左沿起算（槽 position: relative），直接可用
      setThumb({ x: on.offsetLeft, w: on.offsetWidth });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [value, items]);

  const style = thumb
    ? ({ "--thumb-x": `${thumb.x}px`, "--thumb-w": `${thumb.w}px` } as CSSProperties)
    : undefined;

  return (
    <nav
      ref={trackRef}
      className={`ss-tabs${thumb ? " has-thumb" : ""}`}
      aria-label={label}
      style={style}
    >
      <span className="ss-tabs__thumb" aria-hidden="true" />
      {items.map((item) => {
        const on = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            className={`ss-tabs__tab${on ? " is-on" : ""}`}
            aria-current={on ? "page" : undefined}
            onClick={() => {
              if (!on) onChange(item.id);
            }}
          >
            <span className="ss-tabs__label" data-label={item.label}>
              {item.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
