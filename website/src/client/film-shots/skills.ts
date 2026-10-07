/// 第 2 镜头：「一份 skill，所有 agent 都能用。」名字卡飞成矩阵表头（上一镜头的 exit），光标依次点亮第 1 行缺的三格，
/// 提示条说「pr-review：4 个 agent 都能用了」；出场时最后一格的圆点扩成圆，揭开第 3 镜头。
/// 机位：点之前推近第 1 行、另一行退到景深外，点完拉回全景；出场时推进最后一格的圆点、从里面穿到第 3 镜头。
/// 起点 / 终点姿态见 demos/filmShots.ts（matrixPose），摆到页面上的是 poses.ts。
import type { Shot, ShotCtx } from "../../demos/film.ts";
import { matrixPose, type Point } from "../../demos/filmShots.ts";
import { fillTemplate } from "../../lib/template.ts";
import { cursorOf } from "./cursor.ts";
import { capIn, capOut, clearOverlay, holdCap, READ_BEAT, settle, showShot, type FilmEnv, within } from "./kit.ts";
import { poseMatrix, poseModels } from "./poses.ts";
import { holeFrames } from "../../demos/camera.ts";
import { aimAt, CAM_EASE, cameraOf, fitScale, frame, HOME, lerp, onScreen, soften, type Camera, type Pose } from "./camera.ts";

// 运镜参数
/// 推近：放大倍数上限、时长、在字幕升起后多久开始
const PUSH_SCALE = 1.3;
const PUSH_MS = 800;
const PUSH_DELAY = 200;
/// 拉远回全景
const PULL_MS = 700;
/// 穿过圆点：推到多少倍、多久、缓动（慢起、到头最快——速度交给下一镜头接着减速，看起来是一次连续的推进）
const DIVE_SCALE = 7;
const DIVE_MS = 850;
const DIVE_EASE = "cubic-bezier(.7,0,.25,1)";
/// 推到多少进度时洞从圆点里张开
const HOLE_OPEN = 0.4;
/// 洞里的第 3 镜头起始有多远（缩放）
const FAR_SCALE = 0.66;

const OK =
  '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5.3 4.1 7.4 8 2.8"/></svg>';

export function skillsShot(env: FilmEnv, index: number): Shot {
  const shot = env.shotEls[index]!;
  const toast = shot.querySelector<HTMLElement>(".toast7")!;
  const heads = [...shot.querySelectorAll("th")].slice(1).map((th) => th.textContent ?? "");
  const cell = (r: number, c: number) => shot.querySelector<HTMLElement>(`.cell[data-r="${r}"][data-c="${c}"]`)!;
  const say = (text: string) => {
    toast.innerHTML = OK;
    toast.append(text);
    toast.classList.add("on");
  };
  // 推近时退到景深外的东西：另一行（表头只暗一点，还要认得出列名）
  const backRows = [...shot.querySelectorAll<HTMLElement>("tbody tr")].slice(1);
  const header = shot.querySelector<HTMLElement>("thead")!;
  const recede = (on: boolean, ms: number, delay = 0) => {
    soften(backRows, on, ms, delay);
    header.animate(on ? [{ opacity: 1 }, { opacity: 0.7 }] : [{ opacity: 0.7 }, { opacity: 1 }], {
      duration: ms,
      delay,
      easing: CAM_EASE,
      fill: "both",
    });
  };
  // 第 1 行的构图：放大到卡片几乎撑满画面宽（最多 1.3 倍），行移到画面中间偏下（避开字幕），卡片尽量留在画面里
  const rowFraming = (cam: Camera): Pose => {
    const f = env.film.getBoundingClientRect();
    const card = cam.rect(shot.querySelector(".mx7")!);
    const row = cam.rect(shot.querySelector("tbody tr")!);
    const s = fitScale(PUSH_SCALE, card.w, f.width, 16, 1.12);
    const focus: Point = [row.x + row.w / 2, row.y + row.h / 2];
    return frame(s, focus, [f.width / 2, lerp(focus[1], f.height * 0.56, 0.6)], card, { w: f.width, h: f.height });
  };

  // 点的就是起点里「点一下加上」的那几格（逻辑在 filmShots.matrixPose，不在这里另写一份）
  const taps = matrixPose("start")[0]!.flatMap((s, c) => (s === "open" ? [c] : []));

  return {
    // 进度条按真实用时走（从本镜头 enter 到下一镜头 enter，2026-10-07 加机位后实测 5.6 秒）
    duration: 5600,

    enter() {
      showShot(env, index);
      settle(shot);
      clearOverlay(env);
      poseMatrix(env, shot, "start");
    },

    async demo(ctx: ShotCtx) {
      capIn(shot);
      const cursor = cursorOf(env);
      const cam = cameraOf(env, shot);
      const ready = performance.now() + READ_BEAT;
      // 推近：字幕升起时机位慢慢推到第 1 行（要点的那一行），另一行退到景深外（暗一点、虚一点）；
      // 光标晚一点出发，与机位同时到第 1 格
      const focus = rowFraming(cam);
      const t0 = performance.now();
      void cam.move(focus, PUSH_MS, { delay: PUSH_DELAY, from: HOME });
      cursor.zoomTo(focus.s, PUSH_MS, PUSH_DELAY);
      recede(true, PUSH_MS, PUSH_DELAY);
      const first = cam.at(cell(0, taps[0]!), focus);
      await ctx.sleep(Math.max(0, PUSH_DELAY + PUSH_MS - cursor.travelTime(first) - (performance.now() - t0)));
      if (!ctx.alive()) return;
      for (const [i, c] of taps.entries()) {
        const target = cell(0, c);
        const ok = await cursor.tap(ctx, cam.at(target, focus), i === 0 ? 220 : 160, () => {
          target.dataset.s = "added";
          target.classList.remove("is-pop");
          void target.offsetWidth;
          target.classList.add("is-pop");
          say(fillTemplate(toast.dataset.tplAdded!, { agent: heads[c]! }));
        }, ready);
        if (!ok) return;
      }
      await ctx.sleep(300);
      if (!ctx.alive()) return;
      // 拉远：回到全景看结果（整行补齐 + 提示条）；光标停在最后一格上，跟着画面走
      say(toast.dataset.done!);
      void cam.move(HOME, PULL_MS, { from: focus });
      cursor.follow(focus, HOME, PULL_MS);
      recede(false, PULL_MS);
      await ctx.sleep(PULL_MS + 650);
    },

    // 转场：机位接着推进最后一格的圆点、穿过去——圆点开成一个洞，洞里是第 3 镜头；
    // 前景越推越近、越来越虚，后景由远而近、由虚到实（对焦从近处移到远处）
    async exit(ctx: ShotCtx) {
      const next = env.shotEls[index + 1]!;
      const cam = cameraOf(env, shot);
      const nextCam = cameraOf(env, next);
      toast.classList.remove("on");
      cursorOf(env).hide();
      const wait = capOut(shot);
      poseModels(env, next, "start");
      await ctx.sleep(Math.max(wait - 120, 120));
      if (!ctx.alive()) return;
      const last = cell(0, heads.length - 1);
      const dot = cam.point(last, 0.5, 0.5);
      const f = env.film.getBoundingClientRect();
      const mid: Point = [f.width / 2, f.height / 2];
      const from = cam.pose;
      const start = onScreen(from, dot);
      // 推进中圆点一路移向画面中心
      const end: Point = [lerp(start[0], mid[0], 0.7), lerp(start[1], mid[1], 0.7)];
      const to = aimAt(dot, DIVE_SCALE, end);
      const opts = { duration: DIVE_MS, easing: DIVE_EASE, fill: "forwards" as const };
      // 前景：推近、后半程虚掉
      void cam.move(to, DIVE_MS, { easing: DIVE_EASE, from });
      const blurOut = cam.el.animate(
        [{ filter: "blur(0px)" }, { filter: "blur(0px)", offset: 0.25 }, { filter: "blur(10px)", offset: 0.7 }, { filter: "blur(10px)" }],
        opts,
      );
      // 洞：圆点先只是变大（还是实心的墨点，不会看起来「被取消」），推到 HOLE_OPEN 的进度、前景已经虚了，
      // 洞才从圆点中心张开、盖满画面。洞是软边的圆形遮罩（.shot.portal），洞心与圆点心同缓动、同一条直线，一直对得上
      holdCap(next);
      next.classList.add("on", "portal");
      next.style.zIndex = "5";
      const hole = next.animate(holeFrames(start, end, HOLE_OPEN, { w: f.width, h: f.height }), opts);
      // 后景：从洞的落点由远而近、由虚到实
      const far = aimAt(end, FAR_SCALE, end);
      const arrive = nextCam.move(HOME, DIVE_MS + 150, { from: far, easing: "cubic-bezier(.3,0,.2,1)" });
      const focusIn = nextCam.el.animate(
        [{ filter: "blur(6px)" }, { filter: "blur(6px)", offset: 0.3 }, { filter: "blur(0px)", offset: 0.8 }, { filter: "blur(0px)" }],
        { duration: DIVE_MS + 150, easing: "linear", fill: "forwards" },
      );
      await within(ctx, Promise.all([hole.finished, blurOut.finished, arrive, focusIn.finished]).catch(() => {}), DIVE_MS + 150);
    },

    rest() {
      showShot(env, index);
      settle(shot);
      clearOverlay(env);
      poseMatrix(env, shot, "end");
    },
  };
}
