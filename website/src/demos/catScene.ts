/// 片尾黑猫小戏的纯逻辑（spec R8）：落点（猫每帧按字标的实际盒子定位）与小戏的生命周期。
/// 猫的「生理」在 client/catRig.ts（画布），「演戏」的 GSAP 时间线在 client/film-shots/end.ts；本文件不碰 DOM 与 GSAP。
import type { ShotCtx } from "./film.ts";

/// 停在鼻尖刚挨着 A 的地方（不压字）/ 坐下的地方；单位：猫身高，从字标右缘往右数
export const U_STOP = 0.64;
export const U_SIT = 0.6;

/// 猫身高 = 字标高的 1.5 倍
export const CAT_TO_WORDMARK = 1.5;

export interface PlacementInput {
  /// 猫画布在视口里的位置与 CSS 尺寸
  canvas: { left: number; top: number; width: number; height: number };
  /// 字标外那层遮罩的外框右、下边与右、下内边距。字标自己会被果冻晃动变形，不能拿它量，要量遮罩的内容区
  mask: { right: number; bottom: number; paddingRight: number; paddingBottom: number };
  /// 字标未变形的高度（offsetHeight）
  wordmarkHeight: number;
  dpr: number;
  /// 猫离字标右缘多远（猫身高的倍数）
  u: number;
}

/// 猫的身高 s、脚底 y（gy）、横向位置 x，都按设备像素（CatRig 的坐标）
export function catPlacement(p: PlacementInput): { s: number; gy: number; x: number } {
  const s = p.wordmarkHeight * CAT_TO_WORDMARK * p.dpr;
  const gy = (p.mask.bottom - p.mask.paddingBottom - p.canvas.top - 4) * p.dpr;
  const x = (p.mask.right - p.mask.paddingRight - p.canvas.left) * p.dpr + p.u * s;
  return { s, gy, x };
}

/// 踱进来的起点：让猫刚好在画布右缘之外（再多 1.4 个身高）
export function startU(p: { canvasWidth: number; maskRightInCanvas: number; wordmarkHeight: number }): number {
  return (p.canvasWidth - p.maskRightInCanvas) / (p.wordmarkHeight * CAT_TO_WORDMARK) + 1.4;
}

/// 猫的状态（CatRig.st 的字段）。`u` 不属于 CatRig，是上面的横向位置
export interface CatState {
  fx: number;
  moving: number;
  sit: number;
  lean: number;
  squash: number;
  tilt: number;
  lookX: number;
  lookY: number;
  lookK: number;
  blink: number;
  earL: number;
  earR: number;
  tail: number;
  tailCurl: number;
  headDip: number;
  sniff: number;
  pawUp: number;
  hop: number;
  earBack: number;
  puff: number;
  eyeWide: number;
  opacity: number;
}

/// 小戏开场：从右边踱进来（朝左）
export const CAT_START: CatState = {
  fx: -1,
  moving: 1,
  sit: 0,
  lean: 0,
  squash: 1,
  tilt: 0,
  lookX: 1,
  lookY: 0.1,
  lookK: 1,
  blink: 1,
  earL: 0,
  earR: 0,
  tail: 0,
  tailCurl: 3.8,
  headDip: 0,
  sniff: 0,
  pawUp: 0,
  hop: 0,
  earBack: 0,
  puff: 0,
  eyeWide: 0,
  opacity: 1,
};

/// 小戏收尾：坐在 A 旁边、歪着头（暂停时画的就是这个样子）
export const CAT_FINAL: CatState & { u: number } = {
  ...CAT_START,
  moving: 0,
  sit: 1,
  lookK: 0,
  tilt: 0.35,
  u: U_SIT,
};

/// 一场进行中的小戏：done 在时间线走完时兑现；kill 停掉时间线与每帧的绘制并把猫擦掉
export interface CatRun {
  done: Promise<void>;
  kill(): void;
}

/// 小戏的生命周期：同一时刻只有一只猫。
/// - run：新一场开始前先清掉上一场（重播不叠）；减少动态不放；播到一半被打断（暂停 / 跳转 / 换镜头）立刻清掉。
/// - 走完后猫留在画面上（坐着），直到 stop()（离开片尾）。
export class CatScene {
  private current: CatRun | null = null;

  private readonly start: () => CatRun;

  constructor(start: () => CatRun) {
    this.start = start;
  }

  async run(ctx: ShotCtx, reducedMotion: boolean): Promise<void> {
    this.stop();
    if (reducedMotion) return;
    const run = this.start();
    this.current = run;
    let finished = false;
    void run.done.then(() => (finished = true));
    // 被打断时 ctx.sleep 立即放行：醒来后看 alive，为假就收手
    while (!finished && ctx.alive()) {
      await Promise.race([run.done, ctx.sleep(1000)]);
    }
    if (!ctx.alive()) this.stop();
  }

  stop(): void {
    this.current?.kill();
    this.current = null;
  }
}
