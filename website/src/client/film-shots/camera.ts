/// 镜头的「机位」（DOM 一侧）。镜头里除字幕、提示条之外的内容都放在一个 `.cam` 里，
/// 推近 / 拉远 / 穿过去 / 摇镜头就是给它一个 translate + scale（transform-origin 0 0）。几何是纯函数，在 demos/camera.ts。
/// 机位、对焦（整层虚实）、景深（层里的一部分暗、虚）都只用 WAAPI（fill: forwards）摆，不写内联样式：
/// settle / showShot 取消镜头里的动画就回到归位、全清，rest() 不用另管。减少动态时短片不播，这里也一律不动。
import { CAM_EASE, DOF, flyFrames, HOME, onScreen, poseTransform, toContent, type Pose } from "../../demos/camera.ts";
import type { Point, Rect } from "../../demos/filmShots.ts";
import { animate, rectIn, type FilmEnv } from "./kit.ts";

export {
  aimAt,
  CAM_EASE,
  DOF,
  fitScale,
  frame,
  HOME,
  lerp,
  onScreen,
  panBy,
  poseTransform,
  rectOnScreen,
  toContent,
  zoomAbout,
  type Pose,
} from "../../demos/camera.ts";

export function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const cams = new WeakMap<HTMLElement, Camera>();

/// 镜头 shot 的机位（它里面的 `.cam`）
export function cameraOf(env: FilmEnv, shot: HTMLElement): Camera {
  let c = cams.get(shot);
  if (!c) cams.set(shot, (c = new Camera(env, shot.querySelector<HTMLElement>(".cam")!)));
  return c;
}

export class Camera {
  constructor(
    private readonly env: FilmEnv,
    readonly el: HTMLElement,
  ) {}

  /// 舞台大小
  get stage(): { w: number; h: number } {
    const f = this.env.film.getBoundingClientRect();
    return { w: f.width, h: f.height };
  }

  /// 机位此刻的样子（运镜进行中也对：读的是计算样式）
  get pose(): Pose {
    const t = getComputedStyle(this.el).transform;
    if (!t || t === "none") return HOME;
    const m = new DOMMatrixReadOnly(t);
    return { s: m.a, x: m.e, y: m.f };
  }

  /// 元素的内容坐标（扣掉机位此刻的变换）
  rect(target: Element): Rect {
    const r = rectIn(this.env, target);
    const p = this.pose;
    const [x, y] = toContent(p, [r.x, r.y]);
    return { x, y, w: r.w / p.s, h: r.h / p.s };
  }

  /// 元素上 (dx, dy) 那一点的内容坐标
  point(target: Element, dx = 0.5, dy = 0.5): Point {
    const r = this.rect(target);
    return [r.x + r.w * dx, r.y + r.h * dy];
  }

  /// 机位 pose 下，元素上 (dx, dy) 那一点在画面上的位置（光标要去的地方；默认 dy 同光标的 0.55）
  at(target: Element, pose: Pose, dx = 0.5, dy = 0.55): Point {
    return onScreen(pose, this.point(target, dx, dy));
  }

  /// 运镜到 to。返回播完的 Promise（被取消也算播完）。减少动态时不动
  move(to: Pose, ms: number, opts: { easing?: string; delay?: number; from?: Pose } = {}): Promise<unknown> {
    if (reducedMotion()) return Promise.resolve();
    const from = opts.from ?? this.pose;
    return this.el
      .animate([{ transform: poseTransform(from) }, { transform: poseTransform(to) }], {
        duration: ms,
        delay: opts.delay ?? 0,
        easing: opts.easing ?? CAM_EASE,
        fill: opts.delay ? "both" : "forwards",
      })
      .finished.catch(() => {});
  }

  /// 机位当场摆在 p、停着（镜头从推近的样子开场时用：enter 与 demo 之间不出帧，demo 一开头摆上，看不出跳）
  hold(p: Pose): void {
    if (reducedMotion()) return;
    this.el.animate([{ transform: poseTransform(p) }, { transform: poseTransform(p) }], { duration: 1, fill: "forwards" });
  }

  /// 对焦：整层从虚 a px 到虚 b px（转场里出画的那层虚过去、入画的那层由虚到实）。
  /// span：0–1，模糊变化从哪段进度开始、到哪段结束（其余时间保持）
  blur(a: number, b: number, ms: number, opts: { delay?: number; span?: [number, number] } = {}): Promise<unknown> {
    if (reducedMotion()) return Promise.resolve();
    const [p, q] = opts.span ?? [0, 1];
    return this.el
      .animate(
        [
          { filter: `blur(${a}px)`, offset: 0 },
          { filter: `blur(${a}px)`, offset: p },
          { filter: `blur(${b}px)`, offset: q },
          { filter: `blur(${b}px)`, offset: 1 },
        ],
        { duration: ms, delay: opts.delay ?? 0, easing: "linear", fill: "both" },
      )
      .finished.catch(() => {});
  }
}

/// 景深：推近时不是主角的那部分退到景深外（暗一点、虚一点），拉远时回来。ms 为 0 时当场到位
export function soften(els: Element[], on: boolean, ms: number, delay = 0): void {
  if (reducedMotion()) return;
  const soft = { opacity: DOF.opacity, filter: `blur(${DOF.blur}px)` };
  const sharp = { opacity: 1, filter: "blur(0px)" };
  for (const el of els) {
    el.animate(on ? [sharp, soft] : [soft, sharp], { duration: ms, delay, easing: CAM_EASE, fill: "both" });
  }
}

/// 机位下的共享元素飞行（同 kit.fly，但来源在推近的机位里、落点给画面矩形）：克隆体按元素的版面大小克隆，
/// 第一帧放大成画面里原件的样子（字一样大），飞到画面矩形 to。克隆体挂在舞台上（`.fly`），返回它，调用方飞完自己移除
export async function flyCam(env: FilmEnv, from: HTMLElement, to: Rect, ms: number, easing = "cubic-bezier(.6,0,.2,1)"): Promise<HTMLElement> {
  const a = rectIn(env, from);
  const f = flyFrames(a, from.offsetWidth, from.offsetHeight, to);
  const clone = from.cloneNode(true) as HTMLElement;
  clone.classList.add("fly");
  clone.removeAttribute("id");
  clone.style.cssText = `left:${f.box.x}px;top:${f.box.y}px;width:${f.box.w}px;height:${f.box.h}px;opacity:1;transform:${f.from};transition:none`;
  env.film.appendChild(clone);
  await animate(clone, [{ transform: f.from }, { transform: f.to }], { duration: ms, easing });
  return clone;
}
