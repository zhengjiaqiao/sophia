import type { ReactNode } from "react";
import { Tooltip } from "./Tooltip.tsx";

export interface TagProps {
  children: ReactNode;
  /// strong：`ink` 600（`同名` `无法连接`）；weak：`ink-mute` 400（`已添加` `未安装`）
  tone?: "strong" | "weak";
  /// 悬停可以读到更多：给了就挂提示框。不加装饰线（裁决 D21：点状下划线是网页 abbr 惯例，
  /// macOS 上没人认得）。表格名字后的 `2 份不一样` 也是它（点它由表格拉开这一行的抽屉）
  tip?: ReactNode;
}

/// 标签（DESIGN「Shapes」）：**不可点的标识是没有框的 12px 文字**。有框的都能点——
/// 带框的 `同名` 和行内按钮 `清除` 肉眼不可分，所以旧的方标签 TagSquare 删了
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
