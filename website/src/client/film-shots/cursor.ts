/// 演示用的光标（舞台里的 `.ghost`）：走弧线到目标、按一下、放出涟漪。路径与时长的几何在 demos/filmShots.ts（cursorPath）。
/// 一个舞台一只光标；它的位置记在这里，换镜头时 clearOverlay 把它收起，下次从舞台右下角重新入场。
import { cursorPath, type Point } from "../../demos/filmShots.ts";
import type { ShotCtx } from "../../demos/film.ts";
import type { FilmEnv } from "./kit.ts";
import { CAM_EASE, onScreen, toContent, type Pose } from "../../demos/camera.ts";

const cursors = new WeakMap<HTMLElement, Cursor>();

export function cursorOf(env: FilmEnv): Cursor {
  let c = cursors.get(env.film);
  if (!c) cursors.set(env.film, (c = new Cursor(env)));
  return c;
}

class Cursor {
  private pos: Point | null = null;
  /// 最近一次走位要多久（毫秒）：按下要等走到了再停一拍
  private travel = 0;
  /// 机位的放大倍数（光标是「画面里的」光标，推近时跟着变大；写在 transform 上，见 moveTo 的注释）
  private zoom = 1;
  /// 走位的动画（只取消它，不取消缩放）
  private trip: Animation | null = null;
  private readonly el: HTMLElement;
  constructor(private readonly env: FilmEnv) {
    this.el = env.film.querySelector<HTMLElement>(".ghost")!;
  }

  /// 清掉后（clearOverlay 把光标收起）下一次出场重新从右下角来
  reset(): void {
    this.pos = null;
    this.zoom = 1;
    this.trip = null;
  }

  show(): void {
    this.el.classList.add("show");
  }
  hide(): void {
    this.el.classList.remove("show");
  }

  private start(): Point {
    const f = this.env.film.getBoundingClientRect();
    return this.pos ?? [f.width * 0.82, f.height * 0.86];
  }

  /// 从现在的位置走到 to（舞台坐标）要多久：运镜时让光标与画面同时到
  travelTime(to: Point): number {
    return cursorPath(this.start(), to).duration;
  }

  /// 走到 target 上（dx、dy 是在目标里的相对位置；也可以直接给舞台坐标，运镜时由机位算好落点），返回落点（相对舞台）
  moveTo(target: Element | Point, dx = 0.5, dy = 0.55): Point {
    const f = this.env.film.getBoundingClientRect();
    let to: Point;
    if (Array.isArray(target)) to = target;
    else {
      const r = target.getBoundingClientRect();
      to = [r.left - f.left + r.width * dx, r.top - f.top + r.height * dy];
    }
    const from = this.start();
    this.pos = to;
    const path = cursorPath(from, to);
    this.travel = path.duration;
    this.trip?.cancel();
    // 终点写进内联样式，动画只负责过程：动画被取消时光标停在终点，不跳回原点。
    // 位置用 translate 属性而不是 transform：按一下的 scale 排在 translate 之后、transform 之前，
    // 写在 transform 里时位移也会跟着缩 15%，光标每按一下就往左上滑一截
    this.el.style.translate = `${to[0]}px ${to[1]}px`;
    // 机位的缩放写在 transform（排在 translate、scale 之后，transform-origin 在箭头尖上），只改大小、不挪位置
    this.trip = this.el.animate(
      [
        { translate: `${from[0]}px ${from[1]}px` },
        { translate: `${path.mid[0]}px ${path.mid[1]}px`, offset: 0.5 },
        { translate: `${to[0]}px ${to[1]}px` },
      ],
      { duration: path.duration, easing: "cubic-bezier(.45,0,.15,1)" },
    );
    this.show();
    return to;
  }

  /// 跟着机位变大变小（与运镜同时长、同缓动）：光标是「画面里的」光标，推近时跟着变大
  zoomTo(s: number, ms: number, delay = 0, easing = CAM_EASE): void {
    const from = this.zoom;
    this.zoom = s;
    this.el.style.transform = `scale(${s})`;
    this.el.animate([{ transform: `scale(${from})` }, { transform: `scale(${s})` }], {
      duration: ms,
      delay,
      easing,
      fill: "backwards",
    });
  }

  /// 光标停着时运镜：它指着的内容点跟着画面走（机位从 from 到 to，同时长、同缓动，所以始终贴在同一点上）
  follow(from: Pose, to: Pose, ms: number, delay = 0, easing = CAM_EASE): void {
    if (!this.pos) return;
    const a = this.pos;
    const b = onScreen(to, toContent(from, a));
    this.pos = b;
    this.trip?.cancel();
    this.el.style.translate = `${b[0]}px ${b[1]}px`;
    this.trip = this.el.animate([{ translate: `${a[0]}px ${a[1]}px` }, { translate: `${b[0]}px ${b[1]}px` }], {
      duration: ms,
      delay,
      easing,
      fill: "backwards",
    });
    this.zoomTo(to.s, ms, delay, easing);
  }

  /// 走到 target，到了再停 dwell 毫秒（瞄准的一拍），按一下（放涟漪），再过一拍执行 act。
  /// target 给舞台坐标时由机位算好落点（Camera.at），运镜中也对得上。
  /// notBefore：最早什么时候按（performance.now() 的时刻，留给字幕，见 READ_BEAT）。被打断返回 false（act 不执行）
  async tap(ctx: ShotCtx, target: Element | Point, dwell: number, act: () => void, notBefore = 0): Promise<boolean> {
    const p = this.moveTo(target);
    await ctx.sleep(Math.max(this.travel + dwell, notBefore - performance.now()));
    if (!ctx.alive()) return false;
    this.el.animate([{ scale: 1 }, { scale: 0.85 }, { scale: 1 }], { duration: 200 });
    const rip = document.createElement("span");
    rip.className = "ripple";
    rip.style.left = `${p[0]}px`;
    rip.style.top = `${p[1]}px`;
    if (this.zoom !== 1) rip.style.scale = String(this.zoom);
    rip.addEventListener("animationend", () => rip.remove());
    this.env.film.appendChild(rip);
    await ctx.sleep(120);
    if (!ctx.alive()) return false;
    act();
    return true;
  }
}
