import type { ReactNode } from "react";

/// 选择片（DESIGN「选择片 Chip」）：胶囊，高 28，文字 13（不大写，内容是专名），
/// 计数等宽 12。未选 hairline 描边，选中**反色**，不可选灰描边灰字。图标 14 在左，间距 6。
/// 用在：来源筛选片、分段片。胶囊＝一个可切换的状态（DESIGN「Shapes」）。

interface ChipBase {
  children: ReactNode;
  /// 14px 图标在左
  icon?: ReactNode;
  /// 等宽 tabular 计数，跟在名字后面；不零填充
  count?: number;
  /// 名字后 6 的一个短标记（新来源的 `新`）：12/600，与片内文字同色，选中反色时跟着反；
  /// 在名字那段之外，名字截断时照样看得见
  badge?: string;
  selected?: boolean;
  onClick?: () => void;
  title?: string;
}

/// 不可选必须同时给出原因
type ChipDisabled =
  { disabled: true; disabledReason: string } | { disabled?: false; disabledReason?: never };

export type ChipProps = ChipBase & ChipDisabled;

export function Chip(props: ChipProps) {
  const { children, icon, count, badge, selected, onClick, title, disabled, disabledReason } =
    props;
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
      {badge ? <span className="ss-chip__badge">{badge}</span> : null}
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

/// 模型片（DESIGN front-matter `chip-compact`）：高 24 胶囊，hairline 描边，末尾 9px 的 ×
/// （`ink-mute`，悬停转 `ink`）。× 的视觉 9，命中区 24
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
