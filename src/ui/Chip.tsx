import type { ReactNode } from "react";

/// 来源筛选胶囊（DESIGN「选择片 Chip」，2026-09-25）：一颗浅胶囊，`recess` 底、13 `ink-mute`、高 26、
/// 左右 10，无边无投影、平贴——它是切换状态，不是按一下执行动作的键。悬停 `surface` 底 + `ink` 字；
/// **选中＝墨色胶囊**：`ink` 底、`face` 字、字重不跳，再悬停内沿 1px `ink-mute`；不可选：实线 `hairline`、`ink-faint` 字。
/// **只写名字**：不带计数、不带图标（片上不点灯）。多选纳入式由调用方管（`aria-pressed` 表示选没选上）。

interface ChipBase {
  children: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  title?: string;
}

/// 不可选必须同时给出原因
type ChipDisabled =
  { disabled: true; disabledReason: string } | { disabled?: false; disabledReason?: never };

export type ChipProps = ChipBase & ChipDisabled;

export function Chip(props: ChipProps) {
  const { children, selected, onClick, title, disabled, disabledReason } = props;
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
      <span className="ss-chip__label">{children}</span>
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
  /// 两家网关的同名模型都选上时片名后的 ` · 网关短名`（DESIGN「在用」）：短名 `ink-mute`，只在撞名时给
  suffix?: string | null;
}

/// 模型片（DESIGN front-matter `model-chip`，2026-09-25）：白胶囊，高 26、左 10 右 8，`paper` 面 + 1px `hairline` 环，
/// 13 `ink`；末尾 9px 的 ×（1.4 描边线形，`ink-mute`，悬停转 `ink`，左间距 6）。与来源胶囊（灰胶囊、选中墨色）
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
          <svg
            width="9"
            height="9"
            viewBox="0 0 9 9"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
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
