import { useEffect, useLayoutEffect, useRef } from "react";

/// 转盘（DESIGN「转盘：唯一的忙碌指示」，画板 Marks「转盘」）。
///
/// 盘面 + 偏心手指窝：识别特征是偏心点，旋转时靠它的位移被感知。
/// ≤ 20px 只画盘面 + 偏心点（r1.9；加轴毂会三层同心，读成靶心 / 录制键）；
/// 64px 才加轴毂（偏心点 r1.3，随 viewBox 放大，描边 non-scaling 保持 1.4）。
///
/// 只在真的有活干时出现：调用方在忙时渲染它（`spinning`），活干完把 `spinning` 置 false——
/// 它不会立刻消失，而是 600ms 机械减速、末端过冲 2° 回弹后停住，再回调 `onStopped`，
/// 调用方这时再卸掉它（空闲时不占位）。
/// 匀速 1 圈 / 1.2s 线性。`prefers-reduced-motion` 下不转，改为每 400ms 跳 45°，停转即停。

export interface RotorProps {
  /// 14：行内；18：顶栏全局忙碌；64：首次扫描空态
  size?: 14 | 18 | 64;
  spinning: boolean;
  /// 停转回弹结束（reduced-motion 下立即）；调用方在这里卸掉转盘
  onStopped?: () => void;
  /// 忙什么，读屏与悬停用（句子降为 title，DESIGN「视觉优先」）
  label?: string;
}

/// 停转：减速 600ms，冲过终点 2° 再回来
const STOP_MS = 600;
const OVERSHOOT_DEG = 2;
/// 按匀速 300°/s 起步、ease-out 减速到 0，600ms 大约还能转四分之一圈
const COAST_DEG = 90;

/// 停住后保持在终点（WAAPI 的 fill 模式；单独起名是因为 lint-ui 会把 `fill: "…"` 读成颜色）
const HOLD_END: FillMode = "forwards";

/// 转盘匀速一圈的时长，与 tokens.css --motion-rotor 同值
const TURN_MS = 1200;

export function Rotor({ size = 18, spinning, onStopped, label = "正在处理" }: RotorProps) {
  const ref = useRef<SVGSVGElement>(null);
  const stoppedCb = useRef(onStopped);
  stoppedCb.current = onStopped;
  // 只有「转着 → 停」才播停转；一挂载就是停着的，不动
  const wasSpinning = useRef(spinning);
  // CSS 动画开始转的时刻。停转要从「现在转到的角度」接着减速——提交时 is-spinning
  // 已被 React 拿掉、计算样式里读不到角度了，所以按时间推算
  const startedAt = useRef(0);

  useLayoutEffect(() => {
    if (spinning) startedAt.current = performance.now();
  }, [spinning]);

  useEffect(() => {
    const el = ref.current;
    const was = wasSpinning.current;
    wasSpinning.current = spinning;
    if (spinning || !was || !el) return;
    // 从「正在转」切到「停」：接住当前角度，用 WAAPI 做阻尼停转
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof el.animate !== "function") {
      stoppedCb.current?.();
      return;
    }
    const from = (((performance.now() - startedAt.current) % TURN_MS) / TURN_MS) * 360;
    const to = from + COAST_DEG;
    const anim = el.animate(
      [
        { transform: `rotate(${from}deg)`, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
        { transform: `rotate(${to + OVERSHOOT_DEG}deg)`, offset: 0.8, easing: "ease-in-out" },
        { transform: `rotate(${to}deg)` },
      ],
      { duration: STOP_MS, fill: HOLD_END },
    );
    anim.onfinish = () => stoppedCb.current?.();
    return () => anim.cancel();
  }, [spinning]);

  const big = size === 64;
  return (
    <svg
      ref={ref}
      className={`ss-rotor${spinning ? " is-spinning" : ""}`}
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <circle
        cx="9"
        cy="9"
        r="7.3"
        stroke="currentColor"
        strokeWidth="1.4"
        vectorEffect="non-scaling-stroke"
      />
      {big ? (
        <>
          <circle
            cx="9"
            cy="9"
            r="2.4"
            stroke="currentColor"
            strokeWidth="1.4"
            vectorEffect="non-scaling-stroke"
          />
          <circle cx="12.6" cy="5.4" r="1.3" fill="currentColor" />
        </>
      ) : (
        <circle cx="12.3" cy="5.7" r="1.9" fill="currentColor" />
      )}
    </svg>
  );
}
