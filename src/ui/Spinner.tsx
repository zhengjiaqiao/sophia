/// 忙碌指示：地球绕太阳（DESIGN「忙碌指示：只在用户等的地方，带文字」，画板 Marks / States「忙碌」）。
///
/// 中心一颗实心太阳（`ink`，约占直径 40%），一颗小地球（`ink`）沿看不见的圆轨道匀速转，
/// 1 圈 / 1.2s 线性。**不画轨道线**：环 + 中心点是原件记号 ⦿，画出来会撞形。
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
