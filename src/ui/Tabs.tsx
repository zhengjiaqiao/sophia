import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Cap } from "./Cap.tsx";

/// 页签滑槽（DESIGN「页签 Tabs」「控件有重量」，物性之二）。
///
/// 一条凹下去的槽（`surface` 底、`recess-tabs` 内凹、`tab-track` 10 圆角、内边距 3），
/// 选中的那一页是槽里一枚抬起的纸面滑块（`paper` + `raise`，`control` 7 圆角）——**位置＝当前页**。
/// 页签高 28、左右 16、`nav` Condensed 15 / 700 `ink-mute`，选中 `ink`、**字重不变**（靠滑块区分，
/// 切换前后字宽不跳）；标签经 `Cap`（nav 档）以大写 + 1.17px 显示（`SKILLS` `MCP`：我们自己写的
/// 结构词，汉字 run 原样）。页签之间没有竖线、没有下划线。
///
/// **按下即切**（⑰；切页签天然可逆，不需要「移开取消」）：主键按下的那一刻就切，滑块由阻尼弹簧
/// 带过去（260ms `--spring-slide`，停稳不弹）；按住期间滑块贴近槽底，松开弹簧回位。键盘（空格、回车）
/// 与读屏照旧走 click。滑块不能拖：两个选项，点就够（⑩）。reduced-motion 下即时到位。
/// 滑块的位置量自选中页签的盒子；量到之前（首帧、静态渲染）由选中的页签自己画滑块，所以没有闪烁。
///
/// 用在哪：只有位置页的页面头。**不用在**页内筛选（那是筛选片）、网关切换（网关是列表行）。
/// 语义是导航：`<nav>` 里的按钮，当前页 `aria-current="page"`。

export interface TabItem<T extends string> {
  id: T;
  /// 原样写（`skills`）；拉丁 run 经 `Cap` 显示为大写
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
            // 指针主键按下即切；click 只接键盘与读屏（detail 为 0），指针那一下在按下时已经切过
            onPointerDown={(e) => {
              if (e.button === 0 && !on) onChange(item.id);
            }}
            onClick={(e) => {
              if (e.detail === 0 && !on) onChange(item.id);
            }}
          >
            <Cap tone="nav">{item.label}</Cap>
          </button>
        );
      })}
    </nav>
  );
}
