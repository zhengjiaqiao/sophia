/// 片尾黑猫小戏（spec R8，画板 catScene 原样移植）：GSAP 时间线编排「演戏」，CatRig 每帧算「生理」并画到画布。
/// 这个模块带着 GSAP，只在播到片尾前才动态加载（client/film-shots/end.ts 里 import()），随站打包、不走 CDN（R22）。
/// 好奇 → 试探 → 吓一跳 → 假装没事 → 得意。
import { gsap } from "gsap";
import {
  CAT_FINAL,
  CAT_START,
  catPlacement,
  startU,
  U_SIT,
  U_STOP,
  type CatRun,
} from "../../demos/catScene.ts";
import { CatRig } from "../catRig.ts";

export interface Cat {
  /// 开一场小戏：猫从右边踱进来，走完后坐在 A 旁边（保持呼吸、眨眼）直到 kill
  start(): CatRun;
  /// 静态画一只坐着的猫（暂停时的完整画面）；没有就没有，不要求
  showFinal(): void;
  /// 擦掉猫
  clear(): void;
}

/// 字标像果冻一样晃一下：左下角为轴
function wobble(el: HTMLElement): gsap.core.Timeline {
  return gsap
    .timeline()
    .to(el, { rotation: -4, skewX: -9, scaleY: 0.93, duration: 0.07, ease: "power2.out", transformOrigin: "0% 100%" })
    .to(el, { rotation: 0, skewX: 0, scaleY: 1, duration: 1.4, ease: "elastic.out(1.15, .22)" });
}

export function createCat(shot: HTMLElement): Cat {
  const canvas = shot.querySelector<HTMLCanvasElement>(".catcv")!;
  const mask = shot.querySelector<HTMLElement>(".endmask")!;
  const wm = shot.querySelector<HTMLElement>(".endwm")!;
  // CatRig 是原样移植的 JS（catRig.ts 里关了类型检查），这里按 any 用
  const rig: any = new (CatRig as any)(canvas);
  let tl: gsap.core.Timeline | null = null;
  let tick: (() => void) | null = null;
  let showingFinal = false;
  let resizeObs: ResizeObserver | null = null;

  /// 取色：跟着页面 token（深色下猫保持墨色，描 1px 轮廓光）
  function colors(): void {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
    rig.setColors({
      ink: v("--cat-body", "#1c1c1a"),
      paper: v("--cat-eye", "#ffffff"),
      mute: v("--ink-mute", "#4e4e4a"),
      rim: v("--cat-rim", "#ffffff"),
    });
  }

  /// 每帧按字标实际位置与大小定位（改窗口大小、切手机宽都跟得上）。
  /// 量遮罩的内容区而不是字标本身：字标会被果冻晃动变形
  function place(u: number): void {
    const cw = Math.round(canvas.clientWidth * rig.dpr);
    const ch = Math.round(canvas.clientHeight * rig.dpr);
    if (cw !== canvas.width || ch !== canvas.height) rig.resize();
    const f = canvas.getBoundingClientRect();
    const m = mask.getBoundingClientRect();
    const cs = getComputedStyle(mask);
    Object.assign(
      rig.st,
      catPlacement({
        canvas: { left: f.left, top: f.top, width: f.width, height: f.height },
        mask: {
          right: m.right,
          bottom: m.bottom,
          paddingRight: parseFloat(cs.paddingRight),
          paddingBottom: parseFloat(cs.paddingBottom),
        },
        wordmarkHeight: wm.offsetHeight,
        dpr: rig.dpr,
        u,
      }),
    );
  }

  function clear(): void {
    tl?.kill();
    tl = null;
    if (tick) {
      gsap.ticker.remove(tick);
      tick = null;
    }
    resizeObs?.disconnect();
    resizeObs = null;
    showingFinal = false;
    rig.st.opacity = 0;
    rig.render();
    gsap.set(wm, { clearProps: "transform" });
  }

  function drawFinal(): void {
    rig.resize();
    colors();
    Object.assign(rig.st, CAT_FINAL);
    rig.lastX = null;
    rig._px = null;
    rig._vx = 0;
    rig.tailA = 0;
    rig.tailV = 0;
    place(CAT_FINAL.u);
    rig.step(0);
    rig.render();
  }

  return {
    clear,

    showFinal() {
      clear();
      drawFinal();
      showingFinal = true;
      // 暂停时改窗口大小：重画一次，猫仍在 A 旁边
      resizeObs = new ResizeObserver(() => showingFinal && drawFinal());
      resizeObs.observe(canvas);
    },

    start() {
      clear();
      rig.resize();
      colors();
      const st = rig.st;
      const pos = { u: 0 };
      const f = canvas.getBoundingClientRect();
      pos.u = startU({
        canvasWidth: canvas.clientWidth,
        maskRightInCanvas: mask.getBoundingClientRect().right - f.left,
        wordmarkHeight: wm.offsetHeight,
      });
      Object.assign(st, CAT_START);
      rig.lastX = null;
      rig._px = null;
      rig._vx = 0;
      rig.phase = 0;
      rig.tailA = 0;
      rig.tailV = 0;
      let last = performance.now();
      let frames = 0;
      place(pos.u);
      tick = () => {
        const now = performance.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        // 深浅色可能在演出中切换：隔一会儿重新取一次色
        if (++frames % 30 === 0) colors();
        place(pos.u);
        rig.step(dt);
        rig.render();
      };
      gsap.ticker.add(tick);

      const t = (tl = gsap.timeline());
      // 踱步进来，看见字标，越走越慢
      t
        .to(pos, { u: U_STOP, duration: 1.85, ease: "power1.out" })
        .to(st, { moving: 0, duration: 0.5, ease: "power2.out" }, "-=.55")
        .to(st, { lookY: 0.3, duration: 0.6, ease: "sine.inOut" }, "-=1")
        // 停住：重心往前一倾再回正，尾巴跟着多甩一下
        .to(st, { lean: 0.09, tail: 0.4, duration: 0.2, ease: "power1.out" }, "-=.15")
        .to(st, { lean: 0, duration: 0.5, ease: "back.out(2.4)" })
        .to(st, { tail: 0, duration: 0.7, ease: "power2.inOut" }, "<")
        // 好奇：低头凑近末尾的 A，耳朵朝前，嗅
        .to(st, { headDip: 1, lookY: 0.45, earL: 0.14, earR: 0.14, duration: 0.5, ease: "power2.inOut" }, "-=.45")
        .to(st, { sniff: 1, duration: 0.12 }, "<.25")
        .to(st, { sniff: 0, duration: 0.2 }, "+=.4")
        // 试探：慢慢抬爪 → 半空犹豫 → 飞快一拍
        .to(st, { pawUp: 0.55, headDip: 0.55, lean: 0.05, duration: 0.38, ease: "power2.inOut" })
        .to(st, { pawUp: 0.47, duration: 0.25, ease: "sine.inOut" })
        .to(st, { pawUp: 1, duration: 0.08, ease: "power3.in" })
        .add(wobble(wm))
        .to(st, { pawUp: 0.3, duration: 0.12, ease: "power2.out" })
        // 吓一跳：往后弹开、耳朵压平、尾巴炸毛、瞪眼
        .to(pos, { u: U_STOP + 0.42, duration: 0.2, ease: "power2.out" }, "-=.04")
        .to(
          st,
          { hop: 0.32, lean: 0, earBack: 1, puff: 1, eyeWide: 1, headDip: 0, lookY: 0.2, pawUp: 0, tail: 0.7, earL: 0, earR: 0, duration: 0.2, ease: "power2.out" },
          "<",
        )
        .to(st, { hop: 0, duration: 0.2, ease: "power2.in" })
        .to(st, { squash: 0.88, duration: 0.06 })
        .to(st, { squash: 1, duration: 0.4, ease: "back.out(3.2)" })
        // 盯着还在晃的字标看一会儿
        .to(st, { lookY: 0.35, duration: 0.4, ease: "sine.inOut" }, "-=.2")
        // 假装没事：慢慢恢复，转头看你，歪头，坐下
        .to(st, { earBack: 0, puff: 0, eyeWide: 0, tail: 0, duration: 0.8, ease: "power2.out" }, "+=.2")
        // 若无其事地踱回 A 旁边（字标还是它的）
        .to(st, { moving: 1, duration: 0.15 }, "-=.55")
        .to(pos, { u: U_SIT, duration: 0.8, ease: "sine.inOut" }, "<")
        .to(st, { moving: 0, duration: 0.3, ease: "power2.out" }, "-=.3")
        .to(st, { lookK: 0, tilt: 1, duration: 0.55, ease: "power2.out" }, "-=.15")
        .to(st, { sit: 1, duration: 0.65, ease: "power2.inOut" }, "-=.25")
        .to(st, { squash: 0.95, duration: 0.1 }, "-=.1")
        .to(st, { squash: 1, duration: 0.3, ease: "back.out(3)" })
        // 冲你慢慢眨一下眼（猫表示亲近），尾尖卷一卷
        .to(st, { blink: 0.06, duration: 0.3, ease: "power2.in" }, "+=.12")
        .to(st, { blink: 1, duration: 0.45, ease: "power2.out" }, "+=.18")
        .to(st, { tilt: 0.35, duration: 0.7, ease: "sine.inOut" }, "<")
        .to(st, { tailCurl: 4.5, duration: 0.45, ease: "sine.inOut", yoyo: true, repeat: 1 }, "<");

      const done = new Promise<void>((resolve) => t.eventCallback("onComplete", resolve));
      return { done, kill: clear };
    },
  };
}
