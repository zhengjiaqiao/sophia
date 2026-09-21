import type { ReactNode } from "react";

export interface TagSquareProps {
  children: ReactNode;
  /// 弱的一档：hairline 描边、弱字色。给「已导入」这类不需要抢眼的状态
  weak?: boolean;
  title?: string;
}

/// 零圆角方标签（DESIGN `tag-square`）：**不可点的标识**用它——
/// 圆角 pill 是「可点」的记号，按不动的东西不能有圆角（DESIGN「Shapes」）。
/// 曾在三处各写一份（内联常量、两个页面各自的 class），收成这一个。
export function TagSquare({ children, weak, title }: TagSquareProps) {
  return (
    <span className={weak ? "ss-tag ss-tag--weak" : "ss-tag"} title={title}>
      {children}
    </span>
  );
}
