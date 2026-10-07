/// 第 3 镜头：「任何 AI agent，都能接上任意模型。」光标逐个打开开关（名单来自站点配置，页面里按 SITE.agents 渲染，
/// 这里只数 DOM 里有几个开关），模型卡一张张落下；「任意模型」的下划线画出来、飞成选中框套住第 2 张；
/// 出场时被选中的模型卡飞进对话框的模型键（接第 4 镜头）。
/// 机位：从上一镜头的圆点里穿进来就停在全景，点开关时不动；下划线飞成选中框的同时推近到被选中的模型卡上，
/// 开关卡退到景深外——不拉回，最后这个动作点就是下一镜头的入口：机位接着往卡上推、虚过去，卡飞进对话框的模型键。
import type { Shot, ShotCtx } from "../../demos/film.ts";
import { PICKED_MODEL, selectionFrames, tapWaits, type Point } from "../../demos/filmShots.ts";
import { cursorOf } from "./cursor.ts";
import { animate, capIn, capOut, clearOverlay, holdCap, READ_BEAT, rectIn, settle, showShot, snap, type FilmEnv, within } from "./kit.ts";
import { poseChat, poseModels } from "./poses.ts";
import { CAM_EASE, cameraOf, fitScale, flyCam, frame, HOME, lerp, rectOnScreen, soften, zoomAbout, type Pose } from "./camera.ts";
import { composerFraming, earlierMessages } from "./chat.ts";

/// 推近模型卡：倍数上限（比第 2 镜头轻：再大开关卡会挤到字幕底下）；下划线飞成选中框与推近同时长、同缓动
const PUSH_SCALE = 1.15;
const PUSH_MS = 780;
/// 转场：模型卡飞进模型键多久；本镜头接着往卡上推多少、虚到多少；第 4 镜头从多远推进来、从多虚对上焦
const HANDOFF_MS = 850;
const OUT_SCALE = 1.3;
const OUT_BLUR = 6;
const IN_SCALE = 0.85;
const IN_BLUR = 4;

export function modelsShot(env: FilmEnv, index: number): Shot {
  const shot = env.shotEls[index]!;
  const switches = [...shot.querySelectorAll<HTMLElement>(".switch")];
  const modsBox = shot.querySelector<HTMLElement>(".mods")!;
  const mods = [...shot.querySelectorAll<HTMLElement>(".mod")];
  const keyword = shot.querySelector<HTMLElement>("em.ul")!;
  const picked = mods[PICKED_MODEL]!;
  const swCard = shot.querySelector<HTMLElement>(".sw7")!;
  const cam = cameraOf(env, shot);

  /// 推近到被选中的模型卡：以它为中心放大，三张卡贴着画面右边留在画面里——卡列（与开关卡同一列）往右长，
  /// 不往左挤到字幕底下；竖直方向往画面中间挪一点
  function pickFraming(): Pose {
    const { w, h } = cam.stage;
    const box = cam.rect(modsBox);
    const focus = cam.point(picked);
    const s = fitScale(PUSH_SCALE, box.w, w, 16, 1.06);
    return frame(s, focus, [focus[0], lerp(focus[1], h * 0.6, 0.4)], box, { w, h });
  }

  // 模型卡依次落下，略带倾斜
  function dealMods(): void {
    modsBox.dataset.shown = "true";
    mods.forEach((m, i) => {
      m.animate(
        [
          { opacity: 0, transform: `translateY(-30px) scale(.9) rotate(${(i - 1) * 4}deg)` },
          { opacity: 1, transform: "none" },
        ],
        { duration: 700, delay: 120 + i * 110, easing: "cubic-bezier(.16,1,.3,1)", fill: "backwards" },
      );
    });
  }

  return {
    // 进度条按真实用时走（从本镜头 enter 到下一镜头 enter，2026-10-07 加机位后实测 5.38 秒；画板名义 8.2 秒）
    duration: 5400,

    enter() {
      showShot(env, index);
      settle(shot);
      clearOverlay(env);
      poseModels(env, shot, "start");
    },

    async demo(ctx: ShotCtx) {
      capIn(shot);
      const cursor = cursorOf(env);
      const waits = tapWaits(switches.length);
      const ready = performance.now() + READ_BEAT;
      for (const [i, sw] of switches.entries()) {
        const ok = await cursor.tap(ctx, sw, waits[i]!, () => {
          sw.dataset.on = "true";
          if (i === 0) dealMods();
        }, ready);
        if (!ok) return;
      }
      await ctx.sleep(600);
      if (!ctx.alive()) return;
      keyword.classList.add("drawn");
      cursor.hide();
      await ctx.sleep(400);
      if (!ctx.alive()) return;
      // 下划线飞成选中框，同时机位推近到被选中的那张卡上、开关卡退到景深外：
      // 框的终点是卡在推近后的画面位置，与运镜同时长、同缓动，落定时正好套住
      const close = pickFraming();
      const target = rectOnScreen(close, cam.rect(picked));
      const [from, to] = selectionFrames(rectIn(env, keyword), target);
      to.borderRadius = `${14 * close.s}px`;
      const box = document.createElement("div");
      box.className = "selbox";
      Object.assign(box.style, from, { background: "var(--accent)" });
      env.film.appendChild(box);
      snap(env, () => keyword.classList.remove("drawn"));
      void cam.move(close, PUSH_MS, { from: HOME });
      soften([swCard], true, PUSH_MS);
      await within(
        ctx,
        animate(box, [{ ...from, background: "var(--accent)" }, { ...to, background: "transparent" }], {
          duration: PUSH_MS,
          easing: CAM_EASE,
        }),
        PUSH_MS,
      );
      if (!ctx.alive()) return;
      picked.classList.add("pick");
      box.remove();
      await ctx.sleep(450);
    },

    // 转场：选中的模型卡飞进下一镜头对话框里的模型键。机位接着往卡上推、虚过去；
    // 第 4 镜头从模型键那里由远而近、由虚到实，停在推近的输入框上（它的 demo 从这个机位开场）
    async exit(ctx: ShotCtx) {
      const next = env.shotEls[index + 1]!;
      const nextCam = cameraOf(env, next);
      const wait = capOut(shot);
      poseChat(env, next, "start");
      await ctx.sleep(Math.max(wait, 280));
      if (!ctx.alive()) return;
      const chip = next.querySelector<HTMLElement>(".model")!;
      const landing = composerFraming(env, next);
      const slot = rectOnScreen(landing, nextCam.rect(chip));
      const slotMid: Point = [slot.x + slot.w / 2, slot.y + slot.h / 2];
      // 先量位置再起运镜
      const from = cam.pose;
      const card = rectIn(env, picked);
      const flight = flyCam(env, picked, slot, HANDOFF_MS);
      // 卡离开原处（克隆体接着飞），原处不留
      void animate(picked, [{ opacity: 0 }, { opacity: 0 }], { duration: 1 });
      void cam.move(zoomAbout(from, [card.x + card.w / 2, card.y + card.h / 2], OUT_SCALE), HANDOFF_MS, { from });
      void cam.blur(0, OUT_BLUR, HANDOFF_MS, { span: [0.1, 0.7] });
      holdCap(next);
      next.classList.add("on");
      soften(earlierMessages(next), true, 0);
      void nextCam.move(landing, HANDOFF_MS, { from: zoomAbout(landing, slotMid, IN_SCALE) });
      void nextCam.blur(IN_BLUR, 0, HANDOFF_MS, { span: [0.2, 0.85] });
      void animate(shot, [{ opacity: 1 }, { opacity: 0 }], { duration: 600, delay: 200 });
      void animate(next, [{ opacity: 0 }, { opacity: 1 }], { duration: 600, delay: 150, fill: "both" });
      const clone = await within(ctx, flight, HANDOFF_MS);
      clone?.remove();
    },

    rest() {
      showShot(env, index);
      settle(shot);
      // 转场里给下一镜头摆的景深（第一轮对话变暗变虚）也收掉：暂停在转场中途时不留在下一镜头上
      settle(env.shotEls[index + 1]!);
      clearOverlay(env);
      poseModels(env, shot, "end");
    },
  };
}
