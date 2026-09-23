import { useEffect, useState } from "react";
import type { ReactNode } from "react";

/// 忙碌指示：地球绕太阳（DESIGN「忙碌指示：只在用户等的地方，带文字」，画板 Marks / States「忙碌」）。
///
/// 中心一颗实心太阳（`ink`，约占直径 40%），一颗小地球（`ink`）沿一圈细轨道匀速转，1 圈 / 1.2s 线性。
/// **轨道要画**（产品负责人：没有圆环看不懂是在转）：1px `ink-faint`，比原件记号 ⦿ 的 1.4px 墨环
/// 淡且细，加上地球在环上转、旁边总有一句「正在…」，不会被读成原件。
/// 只给用户发起、正在等的操作用，**必须带一句忙什么**：`label` 同时作读屏文本；
/// 可见文字由调用方紧挨着写（`正在重启 Codex`）。后台例行读取不显示任何忙碌。完成即卸载，不做停转动画。
/// `prefers-reduced-motion` 下地球停在 12 点钟方向，文字后跟 `…` 每 500ms 增减一点（ui.css 末尾）。

export interface SpinnerProps {
  /// 14：行内、按钮内；24：内容区居中（首次扫描）
  size?: 14 | 24;
  /// 忙什么，作读屏文本
  label: string;
}

/// 两档的太阳 / 地球直径（DESIGN：14 → 5.5 / 2.5，24 → 9 / 4）
const BODIES: Record<14 | 24, { sun: number; earth: number }> = {
  14: { sun: 5.5, earth: 2.5 },
  24: { sun: 9, earth: 4 },
};

export function Spinner({ size = 14, label }: SpinnerProps) {
  const { sun, earth } = BODIES[size];
  const c = size / 2;
  // 地球画在 12 点钟、贴着 viewBox 上沿；整颗 svg 绕中心转，太阳居中转了也不变，
  // 所以只有地球在动。减少动效时不转，地球就停在 12 点钟
  return (
    <svg
      className="ss-spinner"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
    >
      <circle className="ss-spinner__orbit" cx={c} cy={c} r={c - earth / 2} fill="none" />
      <circle className="ss-spinner__sun" cx={c} cy={c} r={sun / 2} fill="currentColor" />
      <circle
        className="ss-spinner__earth"
        cx={c}
        cy={earth / 2}
        r={earth / 2}
        fill="currentColor"
      />
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
/// 过了 0.3 秒门槛才原位换成 14px 地球绕太阳 + 一句；更快完成的什么都不显示
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
