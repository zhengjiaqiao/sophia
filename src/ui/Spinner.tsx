import { useEffect, useState } from "react";
import type { ReactNode } from "react";

/// 忙碌指示：macOS 式辐条转圈（DESIGN「忙碌指示：只在用户等的地方，带文字」；2026-09-24 重新裁决 D19）。
///
/// 8 根圆头辐条围成一圈，`ink-mute`，不透明度从 1 往逆时针方向递减到 0.2（淡的拖在转动后面）；整圈按 8 步阶跃顺时针转，1 圈 / 1s。
/// 换掉地球绕太阳的理由：「一环 + 一点」与原件记号 ⦿ 同形异义；辐条是系统惯例，不用学。
/// 只给用户发起、正在等的操作用，**必须带一句忙什么**：`label` 同时作读屏文本；
/// 可见文字由调用方紧挨着写（`正在重启 Codex`）。后台例行读取不显示任何忙碌。完成即卸载，不做停转动画。
/// `prefers-reduced-motion` 下不转、渐变静止，文字后跟 `…` 每 500ms 增减一点（ui.css 末尾）。

export interface SpinnerProps {
  /// 14：行内、按钮内；24：内容区居中（首次扫描）
  size?: 14 | 24;
  /// 忙什么，作读屏文本
  label: string;
}

/// 两档的辐条几何（DESIGN：14 → 内径 3、外端 6.25、粗 1.5；24 → 5 / 11 / 2）
const SPOKE: Record<14 | 24, { inner: number; outer: number; width: number }> = {
  14: { inner: 3, outer: 6.25, width: 1.5 },
  24: { inner: 5, outer: 11, width: 2 },
};

/// 辐条根数；ui.css 的 `steps(8)` 与之对应
export const SPOKES = 8;

export function Spinner({ size = 14, label }: SpinnerProps) {
  const { inner, outer, width } = SPOKE[size];
  const c = size / 2;
  // 第 0 根在 12 点钟、最实，往逆时针方向逐根变淡；整颗 svg 按 8 步阶跃转，看上去实的那根在走
  return (
    <svg
      className="ss-spinner"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
    >
      {Array.from({ length: SPOKES }, (_, i) => (
        <line
          key={i}
          x1={c}
          y1={c - inner}
          x2={c}
          y2={c - outer}
          stroke="currentColor"
          strokeWidth={width}
          strokeLinecap="round"
          opacity={+(1 - (0.8 * i) / (SPOKES - 1)).toFixed(3)}
          transform={`rotate(${(-360 / SPOKES) * i} ${c} ${c})`}
        />
      ))}
    </svg>
  );
}

/// 忙碌的统一门槛（DESIGN「反馈的两种形态 › 忙碌」）：0.3 秒内完成就什么都不显示（不闪一下），
/// 超过才换成转圈 + 一句。全应用只有这一个数
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
/// 过了 0.3 秒门槛才原位换成 14px 辐条转圈 + 一句；更快完成的什么都不显示
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
