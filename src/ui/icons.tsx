import type { ReactNode } from "react";

/// 界面图标（DESIGN「图标」，路径抄自画板 `.superpowers/design/Marks.dc.html`）。
///
/// 一律 16px 画布、`currentColor` 取色、1.4 描边、圆头圆角接。**不引第三方图标库**：
/// 几十条路径换一个新依赖不划算，而且外来图标带着自己的网格和笔锋，混进来就破了这套线。
///
/// 词表之外的动作一律写字（判据：用户在别的软件里见过同一个图形做同一件事）。
/// 图标不替代文案的职责——调用方要么图标配文字，要么走 `IconButton`（`title` 必填，
/// 同时作 `aria-label`）。
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

/// 关掉 / 移除一片：×
export function IconClose(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" />
    </Glyph>
  );
}

/// 删掉：带盖垃圾桶
export function IconTrash(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M2.6 4.3h10.8" />
      <path d="M6.2 4.3V2.8h3.6v1.5" />
      <path d="M4.1 4.3l.6 9.1h6.6l.6-9.1" />
      <path d="M6.6 6.8v4.2M9.4 6.8v4.2" />
    </Glyph>
  );
}

/// 编辑：45° 斜置的铅笔
export function IconEdit(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M11.1 1.9l3 3-8.3 8.3-3.9.9.9-3.9z" />
      <path d="M9.6 3.4l3 3" />
    </Glyph>
  );
}

/// 下一条 / 进到里面去：右向角标。它指的是「进到里面去」，不是「跳到外部」
export function IconChevronRight(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6.2 3.4L10.8 8l-4.6 4.6" />
    </Glyph>
  );
}

/// 返回：二级页面头那支左箭头
export function IconArrowLeft(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M13.4 8H2.6M7 3.6 2.6 8 7 12.4" />
    </Glyph>
  );
}

/// 搜索：放大镜（只在输入框内用）
export function IconSearch(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="7" cy="7" r="4.3" />
      <path d="M10.2 10.2l3.2 3.2" />
    </Glyph>
  );
}

/// 添加：+（图标按钮里 16px）。`AddButton` 里的是 12px 的同形
export function IconPlus(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M8 2.6v10.8M2.6 8h10.8" />
    </Glyph>
  );
}

/// 设置：顶栏右端那个入口。**必须是有齿圈的齿轮**——第一版画成圆心加八根
/// 放射线，那是太阳，用户看成了「切换日间模式」
export function IconSettings(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6.41 3.63L6.57 1.81A6.6 6.6 0 0 1 9.43 1.81L9.59 3.63A4.5 4.5 0 0 1 9.97 3.79L11.36 2.61A6.6 6.6 0 0 1 13.39 4.64L12.21 6.03A4.5 4.5 0 0 1 12.37 6.41L14.19 6.57A6.6 6.6 0 0 1 14.19 9.43L12.37 9.59A4.5 4.5 0 0 1 12.21 9.97L13.39 11.36A6.6 6.6 0 0 1 11.36 13.39L9.97 12.21A4.5 4.5 0 0 1 9.59 12.37L9.43 14.19A6.6 6.6 0 0 1 6.57 14.19L6.41 12.37A4.5 4.5 0 0 1 6.03 12.21L4.64 13.39A6.6 6.6 0 0 1 2.61 11.36L3.79 9.97A4.5 4.5 0 0 1 3.63 9.59L1.81 9.43A6.6 6.6 0 0 1 1.81 6.57L3.63 6.41A4.5 4.5 0 0 1 3.79 6.03L2.61 4.64A6.6 6.6 0 0 1 4.64 2.61L6.03 3.79Z" />
      <circle cx="8" cy="8" r="2" />
    </Glyph>
  );
}

// ---- 对勾：全应用只有这一种画法 ----

/// ✓（DESIGN「✓ 只有一种画法」，2026-09-25）：10px 视框、1.8 描边、圆头圆角，`currentColor`。
/// 勾选框里的对勾、提示条句首的 ✓、读数里的 `2 ✓`、菜单的当前项都用它，不用字体里的 ✓ 字符，
/// 也不按 16px 图标的画法另画一枚。尺寸固定 10，不随处缩放
export function IconTick() {
  return (
    <svg
      className="ss-tick"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 5.3 4.1 7.4 8 2.8" />
    </svg>
  );
}

/// 下拉 / 展开的记号：全应用只有这一枚（2026-09-25 产品负责人：「这种展开的按钮，箭头应该保持一致」）——
/// 10px 线形 ˅、1.4 描边、圆头圆角，与勾选框的对勾同一套画法。抽屉拉手、目标框、排序下拉都用它；
/// 不用排版字符 ▾ ▸（字形随字体变、粗细对不上）。朝向由调用方转（拉开时抽屉翻转 180°）
export function IconChevronDown({ className }: { className?: string } = {}) {
  return (
    <svg
      className={className ? `ss-chevron ${className}` : "ss-chevron"}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M1.5 3.5 5 7 8.5 3.5" />
    </svg>
  );
}

// ---- 显示窗里的另两个状态记号：只跟在一句话或一个读数前面，不给命中区 ----

/// 做不成：⊘
export function IconCannot(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="8" r="6.3" />
      <path d="M3.6 12.4L12.4 3.6" />
    </Glyph>
  );
}

/// 部分失败 / 要你注意：!
export function IconAttention(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M8 2.6v7.2" />
      <path d="M8 12.9v0.3" />
    </Glyph>
  );
}
