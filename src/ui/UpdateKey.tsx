import { t } from "../i18n.ts";
import { IconDownload, IconUpgrade } from "./icons.tsx";
import { SWEEP, Spinner } from "./Spinner.tsx";
import { Tooltip } from "./Tooltip.tsx";

/// 侧栏更新键（DESIGN「壳：侧栏 › 更新键」，画板「侧栏里的新版本」定稿，参照 Codex 侧栏底的更新键）：
/// 贴在 `设置` 那一行右端的一颗 20 × 20 小方键（圆角同别的键，control 7；圆只给只读的状态点），只在有新版时出现。
/// **键上只有图标，不展开**（2026-10-02 产品负责人：悬浮才展示更符合规范）：字由提示框（`Tooltip`，墨色浮窗）说，
/// 悬停 400ms 或键盘聚焦时出、按下即收，同时作读屏文字。
///
/// 三种样子，颜色和图标都不同，一眼分得开：
/// - 有新版、还没下（下载失败也回到这里，再点就是重试）：纸面键（抬起）+ 箭头加线，提示框 `下载 0.2.0`
/// - 正在下载：平贴、不能点（同禁用键：透明底 + 1px hairline），**进度画在键上**——五根刻度按进度依次点亮
///   （拿不到总大小时用扫过的忙碌刻度），提示框 `正在下载 43%`
/// - 下好了：墨键 + 向上箭头（到新版；重启由提示框的字说），提示框 `重启以更新到 0.2.0`，点了就重启
///
/// 出现时从 60% 弹到原大小（弹簧，只一次）；换处境只换底色与图标。
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

/// 进度刻度：几何同 14 宽的忙碌刻度（5 根 1.5 × 7、间距 1.6），按进度点亮前 N 根（0–19% 一根 …… 80% 起五根）
const TICKS = 5;
export function litTicks(percent: number): number {
  return Math.min(TICKS, Math.max(1, Math.floor(percent / (100 / TICKS)) + 1));
}

function ProgressTicks({ percent }: { percent: number }) {
  const { width, height, gap } = SWEEP[14];
  const pitch = width + gap;
  const x0 = +((14 - (TICKS * width + (TICKS - 1) * gap)) / 2).toFixed(2);
  const lit = litTicks(percent);
  return (
    <svg
      className="ss-updatekey__ticks"
      width={14}
      height={height}
      viewBox={`0 0 14 ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      {Array.from({ length: TICKS }, (_, i) => (
        <rect
          key={i}
          className={i < lit ? "is-lit" : undefined}
          x={+(x0 + i * pitch).toFixed(2)}
          y={0}
          width={width}
          height={height}
          rx={width / 2}
        />
      ))}
    </svg>
  );
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
  // 一直是同一颗 <button>：换处境时只换类，换色才有过渡，出现的弹簧也只播一次。
  // 下载中不能点但不用 disabled：提示框里的字就是原因，读屏照样读到进度
  return (
    <Tooltip content={label} nowrap>
      <button
        type="button"
        className={`ss-updatekey ss-updatekey--${tone}`}
        aria-label={label}
        aria-disabled={busy || undefined}
        onClick={busy ? undefined : ready ? onRestart : onDownload}
      >
        {busy ? (
          phase.percent === null ? (
            <Spinner size={14} label={label} />
          ) : (
            <ProgressTicks percent={phase.percent} />
          )
        ) : ready ? (
          <IconUpgrade size={12} />
        ) : (
          <IconDownload size={12} />
        )}
      </button>
    </Tooltip>
  );
}
