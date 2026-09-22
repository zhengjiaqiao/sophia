import type { ReactNode } from "react";
import { Tooltip } from "./Tooltip.tsx";

export interface TagProps {
  children: ReactNode;
  /// strong：`ink` 600（`同名` `连不上` `2 份不一样`）；weak：`ink-faint` 400（`已添加` `未安装`）
  tone?: "strong" | "weak";
  /// 悬停可以读到更多：给了就加点状下划线（1px dotted `ink-faint`，abbr 惯例）并挂提示框。
  /// 实线下划线只属于文字链（可点）——标签可悬停但不可点
  tip?: ReactNode;
}

/// 标签（DESIGN「Shapes」）：**不可点的标识是没有框的 12px 文字**。有框的都能点——
/// 1px 黑框的 `同名` 和行内按钮 `清除` 肉眼不可分，所以旧的方标签 TagSquare 删了
export function Tag({ children, tone = "strong", tip }: TagProps) {
  const classes = ["ss-tag", `ss-tag--${tone}`];
  if (tip) classes.push("has-tip");
  const tag = <span className={classes.join(" ")}>{children}</span>;
  if (!tip) return tag;
  return (
    <Tooltip content={tip} focusable>
      {tag}
    </Tooltip>
  );
}
