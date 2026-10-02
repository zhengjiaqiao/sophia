import { IconRefreshSpin } from "./icons.tsx";

export interface RefreshSpinProps {
  /// 读屏名（`正在刷新`）：转圈没有可见文字，读屏靠 role=status 的这一句
  label: string;
  /// 调用方给整块的定位类（发现页热门那一行要光学下移 1px，跟着那颗 ↻ 走）
  className?: string;
  /// 与被换下的那颗 ↻ 同大：发现页热门 12，网关行 16（图标键的默认图形）。缺省 12
  size?: 12 | 16;
}

/// 刷新键按下后（调用方过了 0.3 秒门槛才换上，`useBusyShown`）：原位一个转动的圆，不带箭头、不带文字，转到刷新结束。
/// **全应用唯一的转圈**（2026-09-30 产品负责人真机「这里破例转圈」）：只给刷新键（发现页热门榜单、网关行的 ↻）；
/// 别处的忙碌仍是刻度 + 一句（`BusySlot`）。占位与图标键同大（28 × 28），换上换下那一行不动
export function RefreshSpin({ label, className, size = 12 }: RefreshSpinProps) {
  return (
    <span
      className={className ? `ss-refreshspin ${className}` : "ss-refreshspin"}
      role="status"
      aria-label={label}
    >
      <IconRefreshSpin size={size} />
    </span>
  );
}
