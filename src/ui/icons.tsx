import type { ReactNode } from "react";

/// 界面图标（组件规范 §9 的同一套画法，与 AgentMark 共用）。
///
/// 一律 16px 画布、`currentColor` 取色、1.4 描边、圆头圆角接。**不引第三方图标库**：
/// 几十条路径换一个新依赖不划算，而且外来图标带着自己的网格和笔锋，混进来就破了这套线。
///
/// 只收**语义不会被误读**的动作。图标不替代文案的职责——调用方要么图标配文字，
/// 要么给 `aria-label` 与 `title`（`Button` 的类型强制了这一点）。
///
/// 非 16px 尺寸时按比例反算 strokeWidth，让**画出来的线宽恒为 1.4 CSS px**：
/// 直接把 16 的图放大到 24，笔画会跟着粗到 2.1，和满屏 1px 的 hairline 打架。

export interface IconProps {
  /// 默认 16。改尺寸不改线宽
  size?: number;
}

function Glyph({ size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={(1.4 * 16) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/// 关闭：浮层与横幅右上角那个 ×
export function IconClose(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Glyph>
  );
}

/// 撤销：逆时针回头箭头
export function IconUndo(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M5.6 3.4 2.6 6.4l3 3" />
      <path d="M2.6 6.4h6a3.8 3.8 0 0 1 0 7.6H6.2" />
    </Glyph>
  );
}

/// 刷新 / 再试一次：缺口在右上的环形箭头
export function IconRefresh(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M13.5 8a5.5 5.5 0 1 0-1.6 3.9" />
      <path d="M13.5 3.6V8H9.1" />
    </Glyph>
  );
}

/// 在文件管理器里显示：文件夹。用放大镜会被读成「搜索」
export function IconReveal(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M2 12.6V3.8h3.8l1.4 1.8H14v7a.9.9 0 0 1-.9.9H2.9a.9.9 0 0 1-.9-.9Z" />
    </Glyph>
  );
}

/// 删除：废纸篓
export function IconTrash(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M2.8 4.4h10.4" />
      <path d="M6.3 4.4V3.1a.8.8 0 0 1 .8-.8h1.8a.8.8 0 0 1 .8.8v1.3" />
      <path d="m4.3 4.4.6 8.4a.9.9 0 0 0 .9.9h4.4a.9.9 0 0 0 .9-.9l.6-8.4" />
    </Glyph>
  );
}

/// 打开二级页面：右向角标。它指的是「进到里面去」，不是「跳到外部」
export function IconChevronRight(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m6 3.4 4.6 4.6L6 12.6" />
    </Glyph>
  );
}

/// 返回：二级页面顶栏那支左箭头
export function IconArrowLeft(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M13.4 8H2.6M7 3.6 2.6 8 7 12.4" />
    </Glyph>
  );
}

/// 设置：顶栏右端那个入口。齿轮是少数不会被误读的图形之一，
/// 但它仍然要带 `aria-label` 与 `title`——图标不替代文案的职责
export function IconSettings(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.4v1.8M8 12.8v1.8M14.6 8h-1.8M3.2 8H1.4M12.67 3.33l-1.27 1.27M4.6 11.4l-1.27 1.27M12.67 12.67 11.4 11.4M4.6 4.6 3.33 3.33" />
    </Glyph>
  );
}
