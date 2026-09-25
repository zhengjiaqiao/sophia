import type { ReactNode } from "react";
import { Tooltip } from "./Tooltip.tsx";

export interface TagProps {
  children: ReactNode;
  /// strong：`ink` 600（`同名` `无法连接`）；weak：`ink-mute` 400（`已添加` `未安装`）；
  /// count：12 tabular `ink-faint` 的计数记号（表格名字后的同名 `×2`，惯例写法、零学习；不换等宽字族）
  tone?: "strong" | "weak" | "count";
  /// 读屏名：记号本身读不出意思时给（`×2` → `同名：有 2 份`）；没有提示框时也作 title
  label?: string;
  /// 悬停可以读到更多：给了就挂提示框。不加装饰线（裁决 D21：点状下划线是网页 abbr 惯例，
  /// macOS 上没人认得）。表格名字后的 `2 份不一样` 也是它（点它由表格拉开这一行的抽屉）；
  /// `×2` 的提示框同时列两份的读数（主视图放不下越界读数时）
  tip?: ReactNode;
}

/// 标签（DESIGN「Shapes」）：**不可点的标识是没有框的 12px 文字**。有框的都能点——
/// 带框的 `同名` 和行内按钮 `清除` 肉眼不可分，所以旧的方标签 TagSquare 删了。
/// 同名的 `×2` 是它的 `count` 一档（原 DupMark，2026-09-26 并进来）：不再有「[」括线——
/// 自创记号没有足够理由（DESIGN 已裁决的冲突「同名怎么标」）
export function Tag({ children, tone = "strong", label, tip }: TagProps) {
  const classes = ["ss-tag", `ss-tag--${tone}`];
  if (tip) classes.push("has-tip");
  const named = label ? { role: "img" as const, "aria-label": label } : {};
  const tag = (
    <span className={classes.join(" ")} title={tip ? undefined : label} {...named}>
      {children}
    </span>
  );
  if (!tip) return tag;
  return (
    <Tooltip content={tip} focusable>
      {tag}
    </Tooltip>
  );
}
