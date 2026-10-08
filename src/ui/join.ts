/// 「加入」动效（DESIGN-components「动效 › 加入」，#265，画板第 1 屏）：勾上一项时，它的名字变成一枚小片，
/// 从勾选处冒出，先向下被抛出一小段（越走越慢），再折返被吸向它加入的集合（越飞越快）、边飞边缩小、轻微倾斜，
/// 到了淡出——一道向下鼓的二次贝塞尔弧，共 `--dur-join`（400ms）。照 Dia 下载的轨迹逐帧看过。
///
/// 只用在「勾选＝加进一个集合」的地方（选模型浮层勾一个 → 飞进 `已选` 页签）。落点的计数怎么弹由调用方定
/// （页签计数换数时自己弹一下）。减少动态效果时 `--dur-join` 是 0：不飞，立刻落地，调用方只换数字
import { motionMs } from "./motion.ts";

/// 一帧：相对起点的位移（px）、缩放、倾斜（度）、透明度
export interface JoinFrame {
  x: number;
  y: number;
  scale: number;
  rotate: number;
  opacity: number;
}

/// 控制点：起点下方 140、略偏左 10（实际最多下坠约 40：二次贝塞尔只到控制点的一部分）
const PULL_X = -10;
const PULL_Y = 140;

/// 轨迹（`steps + 1` 帧，时间上等分，配线性时间轴播放）：前 10% 冒出来（从 0.85 倍放大到原大、淡入）；
/// 之后沿弧线走，进度按时间的平方推进——先慢后快；飞到最后缩到 0.45 倍、倾斜 -10°，最后 12% 淡出
export function joinFrames(dx: number, dy: number, steps = 40): JoinFrame[] {
  const frames: JoinFrame[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (t < 0.1) {
      const p = t / 0.1;
      frames.push({ x: 0, y: 0, scale: 0.85 + 0.15 * p, rotate: 0, opacity: p });
      continue;
    }
    const u = (t - 0.1) / 0.9;
    const e = u * u;
    frames.push({
      x: 2 * (1 - e) * e * PULL_X + e * e * dx,
      y: 2 * (1 - e) * e * PULL_Y + e * e * dy,
      scale: 1 - 0.55 * e * e,
      rotate: -10 * e,
      opacity: u > 0.88 ? 1 - (u - 0.88) / 0.12 : 1,
    });
  }
  return frames;
}

/// 屏幕上的一块（`DOMRect` 的这几项）
export interface JoinBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/// 放一枚：小片从 `from`（勾选框所在处，左沿对齐、上下居中）飞到 `to`（落点的中心）。飞完（或不飞）时 resolve。
/// 小片挂在 body 上、fixed、不吃指针；读屏不读它（落地后的计数与「已选」才是结果）
export function playJoin(from: JoinBox, to: JoinBox, label: string): Promise<void> {
  const ms = motionMs("--dur-join");
  if (ms <= 0 || typeof document === "undefined") return Promise.resolve();
  const chip = document.createElement("span");
  chip.className = "ss-join";
  chip.textContent = label;
  chip.setAttribute("aria-hidden", "true");
  document.body.appendChild(chip);
  const x0 = from.left;
  const y0 = from.top + from.height / 2 - chip.offsetHeight / 2;
  chip.style.left = `${x0}px`;
  chip.style.top = `${y0}px`;
  const dx = to.left + to.width / 2 - x0 - chip.offsetWidth * 0.25;
  const dy = to.top + to.height / 2 - y0 - chip.offsetHeight / 2;
  const keyframes = joinFrames(dx, dy).map((f) => ({
    transform: `translate(${f.x}px, ${f.y}px) rotate(${f.rotate}deg) scale(${f.scale})`,
    opacity: f.opacity,
  }));
  return new Promise((resolve) => {
    const done = () => {
      chip.remove();
      resolve();
    };
    if (typeof chip.animate !== "function") {
      done();
      return;
    }
    const animation = chip.animate(keyframes, { duration: ms, easing: "linear" });
    animation.onfinish = done;
    animation.oncancel = done;
  });
}
