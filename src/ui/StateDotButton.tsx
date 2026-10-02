import type { ButtonHTMLAttributes, ReactNode } from "react";

/// 状态点的外层按钮（DESIGN「命中区与视觉尺寸是两回事」「格子悬停光晕」）：点只有 10px，可点时命中区由它撑——
/// 至少 24×24、没有键面、不抬起；整格多大由调用方的类给（表格格子 88 × 行高、选择行 28 方）。
/// 悬停 / 键盘聚焦它时，里面 `hoverable` 的 `StateDot` 出光晕（点本身不变）；键盘焦点 1px `ink` 外框。
///
/// 里面放 `StateDot`（或忙碌时的 14 宽刻度）；点击、键盘、读屏名都由调用方给，其余属性原样落到 `<button>` 上
/// （`Tooltip` 转进来的 `aria-describedby` 也是）。刚变化的那一格要闪一下：在**格子**上加 `data-flash`
/// （见 ui.css「刚变化的格子闪一下」），不在这颗按钮上
export interface StateDotButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
}

export function StateDotButton({ className, children, ...rest }: StateDotButtonProps) {
  return (
    <button
      type="button"
      className={className ? `ss-dot-btn ${className}` : "ss-dot-btn"}
      {...rest}
    >
      {children}
    </button>
  );
}
