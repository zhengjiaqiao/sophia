import type { ReactNode } from "react";

/// 选择片（DESIGN「选择片 Chip」）：胶囊，高 28，文字 13（原样大小写，内容是专名），
/// 计数 12 tabular。未选：透明底（透出机面）+ 1px `ctl-border`、计数 `ink-faint`；
/// **选中＝墨片**：`ink` 底、`face` 字、计数 `ctl-border`；不可选：`hairline` 边、`ink-faint` 字。
/// 片不投影、没有底边——它是切换状态，不是按一下执行动作的键。图标 14 在左，间距 6。
/// 用在：来源筛选片。胶囊＝一个可切换的状态（DESIGN「Shapes」）。

interface ChipBase {
  children: ReactNode;
  /// 14px 图标在左
  icon?: ReactNode;
  /// 12 tabular 计数，跟在名字后面；不零填充
  count?: number;
  selected?: boolean;
  onClick?: () => void;
  title?: string;
}

/// 不可选必须同时给出原因
type ChipDisabled =
  { disabled: true; disabledReason: string } | { disabled?: false; disabledReason?: never };

export type ChipProps = ChipBase & ChipDisabled;

export function Chip(props: ChipProps) {
  const { children, icon, count, selected, onClick, title, disabled, disabledReason } = props;
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
      {count !== undefined ? <span className="ss-chip__count">{count}</span> : null}
    </button>
  );
}

export interface ModelChipProps {
  /// 友好名（`Opus 4.6`），原样
  name: string;
  /// 完整 id（`anthropic/claude-opus-4-6`），进 title
  id: string;
  /// 给了才有 ×
  onRemove?: () => void;
}

/// 模型片（DESIGN front-matter `model-chip`）：高 24 胶囊，`paper` 面 + 1px `hairline` 环，
/// 末尾 9px 的 ×（`ink-mute`，悬停转 `ink`，间距 6）。与筛选片形状一样、材质不同：无墨、无底边。
/// × 的视觉 9，命中区 25
export function ModelChip({ name, id, onRemove }: ModelChipProps) {
  return (
    <span className="ss-modelchip" title={id}>
      <span className="ss-modelchip__name">{name}</span>
      {onRemove ? (
        <button
          type="button"
          className="ss-modelchip__remove"
          title="移除"
          aria-label={`移除 ${name}`}
          onClick={onRemove}
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 9 9"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M1.8 1.8l5.4 5.4M7.2 1.8l-5.4 5.4" />
          </svg>
        </button>
      ) : null}
    </span>
  );
}
