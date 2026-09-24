import { useEffect, useState } from "react";
import type { ReactNode } from "react";

/// 忙碌指示：刻度扫过（DESIGN「忙碌指示：只在用户等的地方，带文字」，2026-09-25 取代辐条）。
///
/// 一排短竖刻线（`ctl-border`、圆头），亮的那根 `ink`、前一根留一格 `ink-mute` 余晖，按格阶跃从左走到右，
/// 到头从左重来，一趟 0.8s（Braun 调谐刻度上指针扫过刻线）。不用圆：界面里的圆已经全是格子状态。
/// 只给用户发起、正在等的操作用，**必须带一句忙什么**：`label` 同时作读屏文本；
/// 可见文字由调用方紧挨着写（`正在重启 Codex`）。后台例行读取不显示任何忙碌。完成即卸载。
/// 不用橙：忙碌不是「在生效」。`prefers-reduced-motion` 下刻度不走、全部 `ink-mute` 静止，
/// 文字后跟 `…` 每 500ms 增减一点（ui.css 末尾）。

export interface SpinnerProps {
  /// 14：行内、按钮内；24：内容区居中（首次扫描）。数字是刻度的宽
  size?: 14 | 24;
  /// 忙什么，作读屏文本
  label: string;
}

/// 两档的刻度几何（DESIGN：14 宽 → 5 根 1.5 × 7、间距 1.6；24 宽 → 7 根 2 × 10、间距 1.7）。
/// 根数与 ui.css 的 `steps(5)` / `steps(7)`、格距 × 根数与 `--sweep` 对应
export const SWEEP: Record<14 | 24, { ticks: number; width: number; height: number; gap: number }> =
  {
    14: { ticks: 5, width: 1.5, height: 7, gap: 1.6 },
    24: { ticks: 7, width: 2, height: 10, gap: 1.7 },
  };

export function Spinner({ size = 14, label }: SpinnerProps) {
  const { ticks, width, height, gap } = SWEEP[size];
  const pitch = width + gap;
  // 一排刻线在 size 宽里居中（总宽 13.9 / 24.2，差的那一点两边分）
  const x0 = +((size - (ticks * width + (ticks - 1) * gap)) / 2).toFixed(2);
  const tick = (x: number, className: string, key?: number) => (
    <rect
      key={key}
      className={className}
      x={x}
      y={0}
      width={width}
      height={height}
      rx={width / 2}
    />
  );
  // 静止刻线打底；余晖与亮的那根从第 0 格起，由 ui.css 的 ss-sweep 一格一格往右推
  return (
    <svg
      className={`ss-spinner ss-spinner--${size}`}
      width={size}
      height={height}
      viewBox={`0 0 ${size} ${height}`}
      role="img"
      aria-label={label}
    >
      {Array.from({ length: ticks }, (_, i) =>
        tick(+(x0 + i * pitch).toFixed(2), "ss-spinner__tick", i),
      )}
      {tick(x0, "ss-spinner__glow")}
      {tick(x0, "ss-spinner__lit")}
    </svg>
  );
}

/// 忙碌的统一门槛（DESIGN「反馈的两种形态 › 忙碌」）：0.3 秒内完成就什么都不显示（不闪一下），
/// 超过才换成忙碌刻度 + 一句。全应用只有这一个数
export const BUSY_DELAY_MS = 300;

/// `busy` 持续超过门槛才为 true；`busy` 一落就立即为 false
export function useBusyShown(busy: boolean, delay = BUSY_DELAY_MS): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!busy) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [busy, delay]);
  return busy && shown;
}

export interface BusySlotProps {
  /// 触发的那颗键此刻在等
  busy: boolean;
  /// 忙什么：`正在重启 Codex`；同时作读屏文本
  label: string;
  /// 触发键本身
  children: ReactNode;
  /// 给忙碌那一句换外观时用（默认 13 `ink-mute`）
  className?: string;
}

/// 触发键原位忙碌（DESIGN「反馈的两种形态 › 忙碌」）：只锁这颗键——`busy` 一起就点不动，
/// 过了 0.3 秒门槛才原位换成 14 宽刻度 + 一句；更快完成的什么都不显示
export function BusySlot({ busy, label, children, className }: BusySlotProps) {
  const shown = useBusyShown(busy);
  if (shown) {
    return (
      <span className={className ? `ss-busyslot ${className}` : "ss-busyslot"} role="status">
        <Spinner size={14} label={label} />
        <span>{label}</span>
      </span>
    );
  }
  if (busy) {
    return (
      <span className="ss-locked" aria-busy="true">
        {children}
      </span>
    );
  }
  return <>{children}</>;
}
