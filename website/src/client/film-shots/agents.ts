/// 第 1 镜头：「你用的 AI agent，它都认得。」agent 名字卡散落后排成两列（spec R7.1）。
/// 排好的样子由 CSS 决定（components/film/ShotAgents.astro 的 .chips__grid），所以 rest() 只要收掉动画；
/// 演示时每张卡从随机的散落位置（agentChips.scatterPose）飞到它排好的格子里。
/// 机位：散落时名字卡在景深外（整层虚、略远），字幕是唯一清楚的东西；吸附的同时对上焦、推回全景——「认得」就是对上焦。
/// 出场时机位朝名字卡推过去、虚掉，飞走的卡（克隆体，清楚的）落成第 2 镜头的表头，第 2 镜头由远而近、由虚到实。
import type { Shot, ShotCtx } from "../../demos/film.ts";
import { scatterPose } from "../../demos/agentChips.ts";
import { animate, capIn, capOut, clearOverlay, fly, holdCap, READ_BEAT, settle, showShot, type FilmEnv, within } from "./kit.ts";
import { poseMatrix } from "./poses.ts";
import { cameraOf, HOME, zoomAbout, type Pose } from "./camera.ts";
import type { Point } from "../../demos/filmShots.ts";

const SNAP_EASE = "cubic-bezier(.16,1,.3,1)";
/// 散落时机位退远多少、虚多少；吸附时多久对上焦、推回全景
const SCATTER_SCALE = 0.95;
const SCATTER_BLUR = 2.5;
const LOCK_MS = 1100;
/// 出场：往名字卡推多少、虚到多少；第 2 镜头从多远推进来、从多虚对上焦
const OUT_SCALE = 1.12;
const OUT_BLUR = 5;
const IN_SCALE = 0.92;
const IN_BLUR = 4;

export function agentsShot(env: FilmEnv, index: number): Shot {
  const shot = env.shotEls[index]!;
  const chips = [...shot.querySelectorAll<HTMLElement>(".chip7")];
  const grid = shot.querySelector<HTMLElement>(".chips__grid")!;
  const cam = cameraOf(env, shot);
  /// 排好的两列在画面上的中心（机位归位时量）
  const gridCenter = (): Point => cam.at(grid, HOME, 0.5, 0.5);

  return {
    // 进度条按真实用时走（含出场转场，2026-10-07 加机位后实测 3.15 秒），不是画板的名义时长 3.6 秒
    duration: 3150,

    enter() {
      showShot(env, index);
      settle(shot);
      clearOverlay(env);
    },

    async demo(ctx: ShotCtx) {
      // 从静止帧接着往下播：画面已经是排好的样子，停一拍直接往下
      if (ctx.fromRest) {
        await ctx.sleep(1100);
        return;
      }
      capIn(shot);
      const stage = env.film.getBoundingClientRect();
      const size = { w: stage.width, h: stage.height };
      const poses = chips.map((chip) => {
        const r = chip.getBoundingClientRect();
        const pose = scatterPose(size, { w: r.width, h: r.height }, Math.random);
        // 位移 = 散落位置 − 排好的位置（都相对舞台）
        const dx = pose.x - (r.left - stage.left);
        const dy = pose.y - (r.top - stage.top);
        return `translate(${dx}px, ${dy}px) rotate(${pose.r}deg) scale(.92)`;
      });
      // 散落时整层退远一点、虚着（以排好的两列为中心）；字幕升完一拍、卡开始吸附时对上焦、推回全景
      const wide: Pose = zoomAbout(HOME, gridCenter(), SCATTER_SCALE);
      void cam.move(HOME, LOCK_MS, { from: wide, delay: READ_BEAT - 100 });
      void cam.blur(SCATTER_BLUR, 0, READ_BEAT - 100 + LOCK_MS, { span: [(READ_BEAT - 100) / (READ_BEAT - 100 + LOCK_MS), 0.92] });
      chips.forEach((chip, i) => {
        // 先在散落处淡入，停一会儿，再依次吸附到排好的格子里
        chip.animate([{ transform: poses[i]!, opacity: 0 }, { transform: poses[i]!, opacity: 1 }], {
          duration: 500,
          delay: 200 + i * 50,
          fill: "both",
        });
        chip.animate([{ transform: poses[i]! }, { transform: "none" }], {
          duration: 950,
          delay: READ_BEAT + i * 45,
          easing: SNAP_EASE,
          fill: "both",
        });
      });
      await ctx.sleep(READ_BEAT);
      if (!ctx.alive()) return;
      await ctx.sleep(750);
    },

    // 转场：字幕收走，前几张名字卡各自飞成矩阵的表头（共享元素）；机位推过名字卡、对焦落到第 2 镜头的表头上
    async exit(ctx: ShotCtx) {
      const next = env.shotEls[index + 1]!;
      const wait = capOut(shot);
      poseMatrix(env, next, "start");
      await ctx.sleep(Math.max(wait, 280));
      if (!ctx.alive()) return;
      const heads = [...next.querySelectorAll<HTMLElement>("th")].slice(1);
      // 先量好起落点再起运镜（fly 当场量：两边机位此刻都在归位）
      const flights = chips.slice(0, heads.length).map((chip, i) => fly(env, chip, heads[i]!, 800 + i * 60, 0.7));
      // 机位：本镜头朝名字卡推过去、虚掉；第 2 镜头从表头那里由远而近、由虚到实，在克隆体落定前到位
      const nextCam = cameraOf(env, next);
      void cam.move(zoomAbout(HOME, gridCenter(), OUT_SCALE), 800, { from: HOME });
      void cam.blur(0, OUT_BLUR, 800, { span: [0.1, 0.8] });
      const headsAt = nextCam.at(next.querySelector("thead")!, HOME, 0.6, 0.5);
      void nextCam.move(HOME, 850, { from: zoomAbout(HOME, headsAt, IN_SCALE), delay: 100 });
      void nextCam.blur(IN_BLUR, 0, 950, { span: [0.25, 0.9] });
      // 飞走的卡原处不留；落点的表头等克隆体到位前一刻才显出来，两边交叉淡入淡出
      chips.slice(0, heads.length).forEach((chip) => void animate(chip, [{ opacity: 0 }, { opacity: 0 }], { duration: 1 }));
      heads.forEach((th, i) =>
        th.animate([{ opacity: 0 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }], { duration: 800 + i * 60, easing: "linear" }),
      );
      holdCap(next);
      next.classList.add("on");
      void animate(shot, [{ opacity: 1 }, { opacity: 0 }], { duration: 500 });
      void animate(next, [{ opacity: 0 }, { opacity: 1 }], { duration: 600, delay: 250, fill: "both" });
      await within(ctx, Promise.all(flights), 800 + heads.length * 60);
      if (!ctx.alive()) return;
      env.film.querySelectorAll(".fly").forEach((c) => c.remove());
    },

    rest() {
      showShot(env, index);
      settle(shot);
      clearOverlay(env);
    },
  };
}
