/// 忙碌指示：惯例细弧（DESIGN「忙碌指示：只在用户等的地方，带文字」，画板 Marks / States「忙碌」）。
///
/// 270° 缺口圆弧，1.5px 线宽 `ink`，匀速 1 圈 / 0.9s。只给用户发起、正在等的操作用，
/// **必须带一句忙什么**：`label` 同时作读屏文本；可见文字由调用方紧挨着写（`正在重启 Codex`）。
/// 后台例行读取不显示任何忙碌。完成即卸载，不做停转动画。
/// `prefers-reduced-motion` 下不转（静止细弧，文字照常）。

export interface SpinnerProps {
  /// 14：行内、按钮内；24：内容区居中（首次扫描）
  size?: 14 | 24;
  /// 忙什么，作读屏文本
  label: string;
}

export function Spinner({ size = 14, label }: SpinnerProps) {
  // 半径让 1.5px 描边落在 viewBox 内；270° 弧 = 周长 × 0.75
  const r = (size - 1.5) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  return (
    <svg
      className="ss-spinner"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
    >
      <circle
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeDasharray={`${circumference * 0.75} ${circumference}`}
      />
    </svg>
  );
}
