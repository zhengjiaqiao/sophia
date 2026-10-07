/// 第 5 镜头：「额度还剩多少，抬头就知道。」镜头从对话上摇到菜单栏（上一镜头的 exit），光标点一下托盘，
/// 面板展开、额度条长出来。数据与用量区同一份（USAGE_SAMPLE），标记同一个函数（usageHtml.ts）。
/// 机位：上一镜头摇上来时直接停在推近的菜单栏上（trayFraming），在那儿点托盘；面板一展开就拉回全景，额度条在拉远的过程里长出来。
/// 出场（转场进片尾）：面板缩回菜单栏里的托盘图标，图标飞到片尾、落成字标的 S（对接镜头：托盘图标、标志、字标首字母是同一个字形）。
import type { Shot, ShotCtx } from "../../demos/film.ts";
import { TRAY_GHOST_OPACITY, WORDMARK_GLYPH, WORDMARK_S_FILLS, trayToWordmark } from "../../demos/filmShots.ts";
import { cursorOf } from "./cursor.ts";
import { poseEndStart, preloadEnding } from "./end.ts";
import { animate, capIn, capOut, clearOverlay, READ_BEAT, rectIn, settle, showShot, type FilmEnv, within } from "./kit.ts";
import { poseUsage } from "./poses.ts";
import { cameraOf, fitScale, frame, HOME, type Pose } from "./camera.ts";

/// 推近菜单栏的倍数上限、拉回全景多久、点完多久开始拉
const PUSH_SCALE = 1.35;
const PULL_MS = 850;
const PULL_DELAY = 120;

/// 推近的菜单栏：托盘放在画面上偏右、上三分之一处，菜单栏尽量整条留在画面里。
/// 上一镜头（chat.ts）摇镜头的落点也是它：两处同一个函数，落点与本镜头开场的机位一致
export function trayFraming(env: FilmEnv, shot: HTMLElement): Pose {
  const cam = cameraOf(env, shot);
  const { w, h } = cam.stage;
  const bar = cam.rect(shot.querySelector(".menubar")!);
  const s = fitScale(PUSH_SCALE, bar.w, w, 16, 1.15);
  const tray = cam.point(shot.querySelector(".tray")!);
  return frame(s, tray, [w * 0.62, h * 0.36], bar, { w, h });
}

const SVG_NS = "http://www.w3.org/2000/svg";

/// 飞行用的 S：与字标同一个 viewBox，只画首字母——重影、主体、重合处浅一档（裁在主体里的那份重影）。
/// 轮廓取托盘图标里的同一条（同一个字形）。两份重影各包一层 `.gh`，飞的途中从托盘图标的错位挪回字标的错位
function flyingS(d: string): SVGSVGElement {
  const W = WORDMARK_GLYPH;
  const ghost = `<path d="${d}" transform="translate(${W.ghost[0]} ${W.ghost[1]}) scale(1 -1)"/>`;
  const main = `transform="translate(${W.main[0]} ${W.main[1]}) scale(1 -1)"`;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W.w} ${W.h}`);
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("fly");
  svg.innerHTML =
    `<defs><clipPath id="fly-s-main"><path d="${d}" ${main}/></clipPath></defs>` +
    `<g class="gh">${ghost}</g><path class="mn" d="${d}" ${main}/>` +
    `<g class="ov" clip-path="url(#fly-s-main)"><g class="gh">${ghost}</g></g>`;
  return svg;
}

export function usageShot(env: FilmEnv, index: number): Shot {
  const shot = env.shotEls[index]!;
  const tray = shot.querySelector<HTMLElement>(".tray")!;
  const drop = shot.querySelector<HTMLElement>(".drop")!;
  const bars = [...shot.querySelectorAll<HTMLElement>(".bar i")];

  return {
    // 实测值（从本镜头 enter 到片尾 enter，含转场，实测 4.7 秒；画板名义 5.4 秒）
    duration: 4700,

    enter() {
      showShot(env, index);
      settle(shot);
      clearOverlay(env);
      poseUsage(env, shot, "start");
    },

    async demo(ctx: ShotCtx) {
      // 开场就是推近的菜单栏（上一镜头摇上来的落点；点进度条跳过来时直接切到这里）
      const cam = cameraOf(env, shot);
      const close = trayFraming(env, shot);
      cam.hold(close);
      const cursor = cursorOf(env);
      cursor.zoomTo(close.s, 0);
      capIn(shot);
      const ready = performance.now() + READ_BEAT;
      const ok = await cursor.tap(ctx, cam.at(tray, close), 220, () => {
        tray.dataset.open = "true";
        drop.dataset.open = "true";
        // 面板一展开就拉回全景：看到整块面板与长出来的额度条；光标停在托盘上，跟着画面走
        void cam.move(HOME, PULL_MS, { from: close, delay: PULL_DELAY });
        cursor.follow(close, HOME, PULL_MS, PULL_DELAY);
        // 条从空长到各自的位置（终点是标记里写好的 scaleX，不在这里另算）
        bars.forEach((bar, i) => {
          bar.animate([{ transform: "scaleX(0)" }, { transform: bar.style.transform }], {
            duration: 1100,
            delay: 150 + i * 90,
            easing: "cubic-bezier(.2,.8,.2,1)",
            fill: "backwards",
          });
        });
      }, ready);
      if (!ok) return;
      await ctx.sleep(1250);
    },

    // 转场：字幕收走 → 面板淡掉内容、收成药丸、缩进托盘图标 → 图标飞到片尾、落成字标的 S（之后播放器调片尾的 enter，
    // 片尾从这一帧接着把其余字母展开）。落点是片尾的真实排版：先把片尾摆成起点、透明地排一遍再量
    async exit(ctx: ShotCtx) {
      const next = env.shotEls[index + 1]!;
      const wait = capOut(shot);
      // 猫的代码通常开播时就拉好了；它决定字标落在哪儿（有猫时整组居中），等一会儿，等不到就按没有猫排
      const ending = within(ctx, preloadEnding(), 900);
      await ctx.sleep(Math.max(wait, 280));
      if (!ctx.alive()) return;
      const icon = tray.querySelector<SVGElement>("svg")!;
      const ic = rectIn(env, icon);
      const dr = rectIn(env, drop);
      // 面板中心 → 图标中心
      const pdx = ic.x + ic.w / 2 - (dr.x + dr.w / 2);
      const pdy = ic.y + ic.h / 2 - (dr.y + dr.h / 2);
      // 光标随菜单栏退场（不然它留在舞台上，到片尾 enter 才被收起、跳回原点）
      cursorOf(env).hide();
      [...drop.children].forEach((c) => void animate(c, [{ opacity: 1 }, { opacity: 0 }], { duration: 160 }));
      await ctx.sleep(140);
      if (!ctx.alive()) return;
      const pw = 96;
      const ph = 26;
      const iv = (dr.h - ph) / 2;
      const ih = (dr.w - pw) / 2;
      const full = "inset(0px 0px 0px 0px round 12px)";
      const pill = `inset(${iv}px ${ih}px ${iv}px ${ih}px round 999px)`;
      const ease = "cubic-bezier(.65,0,.35,1)";
      await within(ctx, animate(drop, [{ clipPath: full }, { clipPath: pill }], { duration: 420, easing: ease }), 420);
      if (!ctx.alive()) return;
      await within(
        ctx,
        animate(
          drop,
          [
            { clipPath: pill, transform: "none", opacity: 1 },
            { clipPath: pill, transform: `translate(${pdx}px,${pdy}px) scale(.22)`, opacity: 0.25 },
          ],
          { duration: 420, easing: ease },
        ),
        420,
      );
      await ending;
      if (!ctx.alive()) return;

      // 片尾摆成起点（字标只露 S），透明地显示出来量字标的真实位置与大小；深浅色看显示的是哪一张字标
      poseEndStart(next, true);
      next.classList.add("on");
      next.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 1, fill: "forwards" });
      const img = [...next.querySelectorAll<HTMLImageElement>(".endwm img")].find((i) => i.getClientRects().length > 0)!;
      const wr = rectIn(env, img);
      const fills = WORDMARK_S_FILLS[img.classList.contains("logo-d") ? "dark" : "light"];
      // 托盘图标的颜色（currentColor = ink）：飞的途中换成字标 S 的三档灰
      const ink = getComputedStyle(tray).color;
      const { tx, ty, s, ghostDx, ghostDy } = trayToWordmark(ic, wr);

      const big = flyingS(icon.querySelector("path")!.getAttribute("d")!);
      big.style.cssText = `left:${wr.x}px;top:${wr.y}px;width:${wr.w}px;height:${wr.h}px;transform-origin:0 0;overflow:visible`;
      env.film.appendChild(big);
      const fly = { duration: 820, easing: "cubic-bezier(.6,0,.2,1)" };
      void animate(icon, [{ opacity: 0 }, { opacity: 0 }], { duration: 1 });
      void animate(shot, [{ opacity: 1 }, { opacity: 0 }], { duration: 360 });
      big.querySelectorAll(".gh").forEach((g) => {
        void animate(g, [{ transform: `translate(${ghostDx}px, ${ghostDy}px)` }, { transform: "translate(0px, 0px)" }], fly);
      });
      void animate(
        big.querySelector(".gh > path")!,
        [
          { fill: ink, fillOpacity: TRAY_GHOST_OPACITY },
          { fill: fills.ghost, fillOpacity: 1 },
        ],
        fly,
      );
      void animate(big.querySelector(".mn")!, [{ fill: ink }, { fill: fills.main }], fly);
      big.querySelector<SVGElement>(".ov path")!.style.fill = fills.overlap;
      // 托盘图标没有「重合处浅一档」：后半程才浮出来
      void animate(big.querySelector(".ov")!, [{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1 }], fly);
      await within(
        ctx,
        animate(big, [{ transform: `translate(${tx}px, ${ty}px) scale(${s})` }, { transform: "translate(0px, 0px) scale(1)" }], fly),
        fly.duration,
      );
      if (!ctx.alive()) {
        // 打断：片尾的起点作废；克隆由下一个 enter / rest 的 clearOverlay 收掉
        delete next.dataset.hand;
        return;
      }
      // 落定：真字标（只露 S）与飞来的 S 重合，同一帧换过去
      next.getAnimations({ subtree: false }).forEach((a) => a.cancel());
      big.remove();
    },

    rest() {
      showShot(env, index);
      settle(shot);
      clearOverlay(env);
      poseUsage(env, shot, "end");
    },
  };
}
