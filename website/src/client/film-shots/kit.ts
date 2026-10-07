/// 镜头实现共用的 DOM 小工具（#242 / #243 的镜头也用）。纯 DOM，不含播放逻辑（播放逻辑在 src/demos/film.ts）。
import { flyDelta, flyTransform, relativeRect, type Rect } from "../../demos/filmShots.ts";
import type { ShotCtx } from "../../demos/film.ts";
import { cursorOf } from "./cursor.ts";

export interface FilmEnv {
  /// 舞台 `.film`
  film: HTMLElement;
  /// 每个镜头的容器 `.shot`，按镜头序号排列
  shotEls: HTMLElement[];
}

const EASE = "cubic-bezier(.2,.8,.2,1)";

/// 字幕先于演示（R7）：两行字幕约 0.8 秒升完，再给一拍读到，演示的第一个关键动作（按下、吸附、打字）才发生。
/// 光标可以在这段时间里先走过去，但不按
export const READ_BEAT = 1100;

/// 动画（WAAPI），返回「播完」的 Promise；被取消时也算播完，不抛错
export function animate(el: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions = {}): Promise<unknown> {
  return el.animate(keyframes, { duration: 700, easing: EASE, fill: "forwards", ...options }).finished.catch(() => {});
}

/// 只显示第 n 个镜头（其余收起）。转场时给镜头元素本身加过的动画与内联样式（淡入淡出、揭开、上摇）也在这里收掉，
/// 否则转场被暂停 / 跳转打断后，它们会留在已经收起的镜头上，下次再显示时带着半截的样子
export function showShot(env: FilmEnv, n: number): void {
  env.shotEls.forEach((el, i) => {
    el.classList.toggle("on", i === n);
    el.getAnimations({ subtree: false }).forEach((a) => a.cancel());
    el.style.removeProperty("z-index");
    // 机位（.cam）也归位——转场里推过去 / 穿进来的机位被打断时，不能带着放大留到下次
    el.classList.remove("portal");
    el.querySelectorAll(".cam").forEach((c) => c.getAnimations().forEach((a) => a.cancel()));
  });
}

/// 收掉镜头里所有进行中的动画与转场克隆，回到 CSS 里写的静态样子（= 镜头的完整画面）。
/// 镜头的静态样子必须由 CSS 决定：这样静止帧、关 JS、暂停都靠它，不需要 JS 再摆一遍
export function settle(shot: HTMLElement): void {
  shot.getAnimations({ subtree: true }).forEach((a) => a.cancel());
  shot.querySelectorAll(".fly, .selbox").forEach((e) => e.remove());
}

/// 镜头里的字幕：每行包在 `.ln` 里（外层 span 裁切），两行依次升起
export function capIn(shot: HTMLElement): void {
  shot.querySelectorAll<HTMLElement>(".cap7 .ln").forEach((l, i) => {
    l.animate([{ transform: "translateY(112%)" }, { transform: "translateY(0)" }], {
      duration: 620,
      delay: 90 + i * 90,
      easing: "cubic-bezier(.16,1,.3,1)",
      // 升起之前藏在裁切框下面；播完回到 CSS 的静态位置
      fill: "backwards",
    });
  });
}

/// 字幕向上收走，返回等它收完的毫秒数
export function capOut(shot: HTMLElement): number {
  const lines = shot.querySelectorAll<HTMLElement>(".cap7 .ln");
  lines.forEach((l, i) => {
    l.animate([{ transform: "translateY(0)" }, { transform: "translateY(-112%)" }], {
      duration: 240,
      delay: i * 40,
      easing: "cubic-bezier(.7,0,.84,0)",
      fill: "forwards",
    });
  });
  return lines.length ? 260 : 0;
}

// ---------- #242 追加：共享元素、舞台上的临时物件、姿态 ----------

/// 元素相对舞台左上角的位置与大小（舞台不缩放，直接用屏幕坐标相减）
export function rectIn(env: FilmEnv, el: Element): Rect {
  return relativeRect(el.getBoundingClientRect(), env.film.getBoundingClientRect());
}

/// 共享元素：把 from 的样子克隆一份，从 from 的位置飞到 to 的位置（中心对中心、按大小缩放）。
/// 克隆体挂在舞台上（`.fly`），返回它，调用方飞完自己移除（打断时由 clearOverlay 收掉）。
/// `fadeAt`（0–1）：飞到这个进度后淡出，给落点另有真身的情形用（名字卡飞成表头）
export async function fly(
  env: FilmEnv,
  from: HTMLElement,
  to: HTMLElement,
  ms = 750,
  fadeAt?: number,
): Promise<HTMLElement> {
  const a = rectIn(env, from);
  const b = rectIn(env, to);
  const clone = from.cloneNode(true) as HTMLElement;
  clone.classList.add("fly");
  clone.removeAttribute("id");
  clone.style.cssText = `left:${a.x}px;top:${a.y}px;width:${a.w}px;height:${a.h}px;opacity:1;transform:none;transition:none`;
  env.film.appendChild(clone);
  const end = flyTransform(flyDelta(a, b));
  const frames: Keyframe[] = [{ transform: "translate(0px, 0px) scale(1, 1)", opacity: 1 }];
  if (fadeAt !== undefined) frames.push({ transform: end, opacity: 1, offset: fadeAt }, { transform: end, opacity: 0 });
  else frames.push({ transform: end, opacity: 1 });
  await animate(clone, frames, { duration: ms, easing: "cubic-bezier(.6,0,.2,1)" });
  return clone;
}

/// 等一段动画播完，但被打断（暂停 / 跳转，ctx.sleep 立即放行）时不再等：转场飞到一半就能让位，
/// 留在舞台上的半截克隆由下一个 enter / rest 里的 clearOverlay 收掉。`ms` 是动画名义时长（多留一点余量）
export async function within<T>(ctx: ShotCtx, work: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([work, ctx.sleep(ms + 200).then(() => undefined)]);
}

/// 清掉舞台上的转场克隆、选中框、点击涟漪，光标收起。镜头的 enter / rest 都调：
/// 暂停或跳转可能发生在转场飞到一半，这些东西挂在舞台上而不在任何一个镜头里，settle 够不着
export function clearOverlay(env: FilmEnv): void {
  env.film.querySelectorAll(".fly, .selbox, .ripple").forEach((e) => e.remove());
  const ghost = env.film.querySelector<HTMLElement>(".ghost");
  if (ghost) {
    ghost.getAnimations().forEach((a) => a.cancel());
    ghost.classList.remove("show");
    ghost.style.translate = "";
    ghost.style.transform = "";
    cursorOf(env).reset();
  }
}

/// 摆姿态：关掉过渡、改完、强制样式生效、再恢复——改动当场到位，不会变成一段慢动画
export function snap(env: FilmEnv, change: () => void): void {
  env.film.classList.add("snap");
  change();
  void env.film.offsetWidth;
  env.film.classList.remove("snap");
}

/// 字幕先藏在裁切框下面（转场里下一镜头已经露面、字幕还没升起时用）；该镜头 enter() 的 settle 会取消它，接着 capIn
export function holdCap(shot: HTMLElement): void {
  shot.querySelectorAll<HTMLElement>(".cap7 .ln").forEach((l) => {
    l.animate([{ transform: "translateY(112%)" }, { transform: "translateY(112%)" }], { duration: 1, fill: "forwards" });
  });
}
