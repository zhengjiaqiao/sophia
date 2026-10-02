import { t } from "../i18n.ts";
import { IconDownload, IconUpgrade } from "./icons.tsx";
import { Spinner } from "./Spinner.tsx";

/// 侧栏更新键（DESIGN「壳：侧栏 › 更新键」，画板「侧栏里的新版本」定稿，参照 Codex 侧栏底的更新键）：
/// 贴在 `设置` 那一行右端的一颗 20 × 20 小方键（圆角同别的键，control 7；圆只给只读的状态点），只在有新版时出现，平时只露图标，手放上去 / 键盘聚焦时向左展开出字。
///
/// 三种样子，颜色和图标都不同，一眼分得开：
/// - 有新版、还没下（下载失败也回到这里，再点就是重试）：纸面键（抬起）+ 向下箭头，展开 `下载 0.2.0`
/// - 正在下载：平贴、不能点（同禁用键：透明底 + 1px hairline），常展开，刻度 + `正在下载 43%`
/// - 下好了：墨键 + 向上箭头（到新版；重启由展开的字说），展开 `重启以更新到 0.2.0`，点了就重启
///
/// 出现时从 60% 弹到原大小（弹簧，只一次）；下载中 → 下好了是同一颗键收回成小方键、换色。
/// 不做呼吸、闪烁这类循环动画（等于在催）。不能关：只占一个图标大小，不值得关。
export type UpdateKeyPhase =
  | { kind: "none" }
  | { kind: "available" | "failed"; version: string }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "installed"; version: string };

export interface UpdateKeyProps {
  phase: UpdateKeyPhase;
  /// 纸面键：下载并安装
  onDownload: () => void;
  /// 墨键：重启
  onRestart: () => void;
}

export function UpdateKey({ phase, onDownload, onRestart }: UpdateKeyProps) {
  if (phase.kind === "none") return null;
  const busy = phase.kind === "downloading";
  const ready = phase.kind === "installed";
  const label = busy
    ? phase.percent === null
      ? t("shell.updateKey.downloading")
      : t("shell.updateKey.downloadingPercent", { percent: phase.percent })
    : ready
      ? t("shell.updateKey.restart", { version: phase.version })
      : t("shell.updateKey.download", { version: phase.version });
  const tone = busy ? "busy" : ready ? "ink" : "paper";
  // 一直是同一颗 <button>：换处境时只换类，展开 / 收回与换色才有过渡，出现的弹簧也只播一次。
  // 下载中不能点但不用 disabled：键上的字就是原因，读屏照样读到进度
  return (
    <button
      type="button"
      className={`ss-updatekey ss-updatekey--${tone}`}
      aria-label={label}
      aria-disabled={busy || undefined}
      onClick={busy ? undefined : ready ? onRestart : onDownload}
    >
      {busy ? (
        <Spinner size={14} label={t("shell.updateKey.downloading")} />
      ) : ready ? (
        <IconUpgrade size={12} />
      ) : (
        <IconDownload size={12} />
      )}
      <span className="ss-updatekey__label">{label}</span>
    </button>
  );
}
