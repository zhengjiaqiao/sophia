import { IconClose } from "./icons.tsx";

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
