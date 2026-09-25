import type { ReactNode } from "react";
import { IconClose } from "./icons.tsx";
import { ReasonTip } from "./Tooltip.tsx";

/// 来源筛选胶囊（DESIGN「选择片 Chip」，2026-09-25）：一颗浅胶囊，`recess` 底、13 `ink-mute`、高 26、
/// 左右 10，无边无投影、平贴——它是切换状态，不是按一下执行动作的键。悬停 `surface` 底 + `ink` 字；
/// **选中＝墨色胶囊**：`ink` 底、`face` 字、字重不跳，再悬停内沿 1px `ink-mute`；不可选：实线 `hairline`、`ink-faint` 字。
/// 名字后可带计数（12 tabular、间距 6：没选 `ink-faint`，选中 `ctl-border`）；不带图标（片上不点灯）。
/// 名字最宽 220，放不下以 … 截断（计数完整保留）；完整值由调用方挂提示框（来源筛选的提示框本来就写全名）。
/// 不可选的原因经 `ReasonTip`：悬停出、按下当即出（同禁用的键）。
/// 单选由调用方管（`aria-pressed` 表示选没选上）。

interface ChipBase {
  children: ReactNode;
  /// 12 tabular 计数，跟在名字后面；不给就不画（`全部` 不带数）
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
  const { children, count, selected, onClick, title, disabled, disabledReason } = props;
  const classes = ["ss-chip"];
  if (selected) classes.push("is-selected");

  return (
    <ReasonTip reason={disabled ? disabledReason : undefined}>
      <button
        type="button"
        className={classes.join(" ")}
        title={disabled ? disabledReason : title}
        disabled={disabled}
        aria-pressed={selected ? true : false}
        onClick={disabled ? undefined : onClick}
      >
        <span className="ss-chip__label">{children}</span>
        {count !== undefined ? <span className="ss-chip__count">{count}</span> : null}
      </button>
    </ReasonTip>
  );
}

export interface ModelChipProps {
  /// 友好名（`Opus 4.6`），原样
  name: string;
  /// 完整 id（`anthropic/claude-opus-4-6`），进 title
  id: string;
  /// 给了才有 ×
  onRemove?: () => void;
  /// 两家网关的同名模型都选上时片名后的 ` · 网关短名`（DESIGN「在用」）：短名 `ink-mute`，只在撞名时给
  suffix?: string | null;
}

/// 模型片（DESIGN front-matter `model-chip`，2026-09-25）：白胶囊，高 26、左 10 右 8，`paper` 面 + 1px `hairline` 环，
/// 13 `ink`；末尾 9px 的 ×（词表里的 `IconClose` 缩到 9，线宽仍 1.4，`ink-mute`，悬停转 `ink`，左间距 6）。与来源胶囊（灰胶囊、选中墨色）
/// 是两种东西、两种样子：不用墨、平贴不抬起，放在机面和凹面上同一个样子。× 的视觉 9，命中区 25
export function ModelChip({ name, id, onRemove, suffix }: ModelChipProps) {
  const full = suffix ? `${name} · ${suffix}` : name;
  return (
    <span className="ss-modelchip" title={id}>
      <span className="ss-modelchip__name">
        {name}
        {suffix ? <span className="ss-modelchip__suffix">{` · ${suffix}`}</span> : null}
      </span>
      {onRemove ? (
        <button
          type="button"
          className="ss-modelchip__remove"
          title="移除"
          aria-label={`移除 ${full}`}
          onClick={onRemove}
        >
          <IconClose size={9} />
        </button>
      ) : null}
    </span>
  );
}
