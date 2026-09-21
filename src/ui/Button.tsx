import type { ReactNode } from "react";

/// 按钮（组件规范 §3）：只有一种形——ghost pill。没有填充按钮。
/// 破坏性操作不用红：分量由弹窗里的信息和按钮文案承担（§1.1）。

/// inverse：反色，表示「现在开着」的开关态（DESIGN components.button-inverse）
export type ButtonVariant = "default" | "destructive" | "link" | "inverse";
/// 两种尺寸按所在容器的高度选，不按重要性选
export type ButtonSize = "regular" | "compact";

interface ButtonBase {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  title?: string;
  /// 反色底上的文字链（错误横幅里的「关闭」）
  inverse?: boolean;
}

/// 禁用必须同时给出原因（§3）：不可只置灰，类型上就不给这个选项。
type DisabledProps =
  { disabled: true; disabledReason: string } | { disabled?: false; disabledReason?: never };

export type ButtonProps = ButtonBase & DisabledProps;

export function Button(props: ButtonProps) {
  const {
    children,
    onClick,
    variant = "default",
    size = "regular",
    title,
    inverse,
    disabled,
    disabledReason,
  } = props;

  const classes = ["ss-btn"];
  if (size === "compact") classes.push("ss-btn--compact");
  if (variant === "destructive") classes.push("ss-btn--destructive");
  if (variant === "link") classes.push("ss-btn--link");
  if (variant === "inverse") classes.push("ss-btn--inverse");
  if (inverse) classes.push("is-inverse");

  return (
    <button
      type="button"
      className={classes.join(" ")}
      // 禁用时把原因挂在 title 上，鼠标停住就知道为什么按不动
      title={disabled ? disabledReason : title}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
    >
      {children}
    </button>
  );
}
