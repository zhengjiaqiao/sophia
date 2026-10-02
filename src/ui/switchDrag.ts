/// 开关滑块的拖动判定（DESIGN「开关」「控件有重量 › 拖」）。纯逻辑，tests/switch-drag.test.ts 直接测。
///
/// 在滑块或槽上按下：横向累计位移不超过 3px 就松手＝一次点击（切换）；超过 3px 进入拖动，
/// 滑块 1:1 跟手、夹在 [0, 行程] 之间。松手时取最后 50ms 的平均速度：|v| ≥ 0.3px/ms（快速甩）
/// 按速度方向落；否则看位置，过了行程一半落对侧，没过回原位。落到对侧＝一次切换，与点击走同一条路。

/// 进入拖动的门槛：横移超过它才算拖（px）
export const DRAG_SLOP_PX = 3;
/// 松手速度取最后这段时间的平均（ms）
export const VELOCITY_WINDOW_MS = 50;
/// 快速甩的速度门槛（px/ms，即 300px/s）
export const FLING_PX_PER_MS = 0.3;

interface Sample {
  /// 事件时间戳（ms）
  t: number;
  /// 指针横坐标（px）
  x: number;
}

export interface SwitchDrag {
  /// 按下时开关的状态（滑块在右＝开）
  from: boolean;
  /// 滑块的行程：标准 17、紧凑 13（px）
  travel: number;
  /// 按下时的指针横坐标
  startX: number;
  /// 已越过 3px 门槛，进入拖动（一旦越过就不再退回点击）
  dragging: boolean;
  /// 滑块离左端的位移，夹在 [0, travel]
  offset: number;
  /// 最近的指针采样，只留速度窗口够用的那些
  samples: ReadonlyArray<Sample>;
}

/// 按下。禁用的开关拖不动，返回 null
export function dragStart(
  from: boolean,
  travel: number,
  x: number,
  t: number,
  disabled = false,
): SwitchDrag | null {
  if (disabled) return null;
  return {
    from,
    travel,
    startX: x,
    dragging: false,
    offset: from ? travel : 0,
    samples: [{ t, x }],
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/// 指针移动：越过门槛后滑块跟手
export function dragMove(d: SwitchDrag, x: number, t: number): SwitchDrag {
  const dx = x - d.startX;
  const dragging = d.dragging || Math.abs(dx) > DRAG_SLOP_PX;
  const origin = d.from ? d.travel : 0;
  const samples = [...d.samples, { t, x }].filter((s) => s.t >= t - VELOCITY_WINDOW_MS * 2);
  return {
    ...d,
    dragging,
    offset: dragging ? clamp(origin + dx, 0, d.travel) : origin,
    samples,
  };
}

/// 松手前最后 50ms 的平均速度（px/ms）；窗口里只有一个采样（停住了再松手）时为 0
export function releaseVelocity(samples: ReadonlyArray<Sample>, now: number): number {
  const recent = samples.filter((s) => s.t >= now - VELOCITY_WINDOW_MS && s.t <= now);
  if (recent.length < 2) return 0;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

/// 拖动松手后落在哪一侧（true＝右＝开）
export function settleSide(offset: number, travel: number, velocity: number): boolean {
  if (Math.abs(velocity) >= FLING_PX_PER_MS) return velocity > 0;
  return offset > travel / 2;
}

/// 松手：返回开关应处的状态。没越过门槛＝点击，切换；拖动了＝按速度或位置判定
export function dragEnd(d: SwitchDrag, x: number, t: number): boolean {
  const moved = dragMove(d, x, t);
  if (!moved.dragging) return !d.from;
  return settleSide(moved.offset, d.travel, releaseVelocity(moved.samples, t));
}
