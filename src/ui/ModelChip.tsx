import { t } from "../i18n.ts";
import { IconClose } from "./icons.tsx";
import { Mono } from "./Mono.tsx";
import { Tooltip } from "./Tooltip.tsx";

export interface ModelChipProps {
  /// 友好名（`Opus 4.6`），原样
  name: string;
  /// 完整 id（`anthropic/claude-opus-4-6`）：片上看不到，悬停整片出提示框（等宽）
  id: string;
  /// 给了才有 ×
  onRemove?: () => void;
  /// 两家网关的同名模型都选上时片名后的 ` · 网关短名`（DESIGN「在用」）：短名 `ink-mute`，只在撞名时给
  suffix?: string | null;
}

/// 模型片（DESIGN front-matter `model-chip`，2026-09-25）：白胶囊，高 26、左 10 右 8，`paper` 面 + 1px `hairline` 环，
/// 13 `ink`；末尾 9px 的 ×（词表里的 `IconClose` 缩到 9，线宽仍 1.4，`ink-mute`，悬停转 `ink`，左间距 6）。与来源胶囊（灰胶囊、选中墨色）
/// 是两种东西、两种样子：不用墨、平贴不抬起，放在机面和凹面上同一个样子。× 的视觉 9，命中区 25。
/// 完整 id 与 × 的「移除」都走提示框（不写原生 title：悬停会弹系统灰框，2026-10-06）；指针在 × 上时只出「移除」
export function ModelChip({ name, id, onRemove, suffix }: ModelChipProps) {
  const full = suffix ? `${name} · ${suffix}` : name;
  return (
    <Tooltip content={<Mono inherit>{id}</Mono>}>
      <span className="ss-modelchip">
        <span className="ss-modelchip__name">
          {name}
          {suffix ? <span className="ss-modelchip__suffix">{` · ${suffix}`}</span> : null}
        </span>
        {onRemove ? (
          <Tooltip content={t("common.modelChip.remove")}>
            <button
              type="button"
              className="ss-modelchip__remove"
              aria-label={t("common.modelChip.removeNamed", { name: full })}
              onClick={onRemove}
            >
              <IconClose size={9} />
            </button>
          </Tooltip>
        ) : null}
      </span>
    </Tooltip>
  );
}
