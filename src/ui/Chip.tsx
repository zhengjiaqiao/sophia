import type { ReactNode } from "react";

/// 选择片（组件规范 §3.0）：多选/单选的紧凑控件，用在 agent 选择、筛选。
/// pill 形，因为它可点（§3.1）。选中用反色而不是填充色——界面零色彩。
/// 文字不大写：片上放的是 agent 名这类专名，大写只给我们自己写的结构词（§1.2）。

interface ChipBase {
  children: ReactNode;
  /// 16px 图标在左，间距 8px
  icon?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  title?: string;
}

/// 不可选必须同时给出原因（§3.0）
type ChipDisabled =
  { disabled: true; disabledReason: string } | { disabled?: false; disabledReason?: never };

export type ChipProps = ChipBase & ChipDisabled;

export function Chip(props: ChipProps) {
  const { children, icon, selected, onClick, title, disabled, disabledReason } = props;
  const classes = ["ss-chip"];
  if (selected) classes.push("is-selected");

  return (
    <button
      type="button"
      className={classes.join(" ")}
      title={disabled ? disabledReason : title}
      disabled={disabled}
      aria-pressed={selected ? true : false}
      onClick={disabled ? undefined : onClick}
    >
      {icon ? <span className="ss-chip__icon">{icon}</span> : null}
      <span className="ss-chip__label">{children}</span>
    </button>
  );
}
