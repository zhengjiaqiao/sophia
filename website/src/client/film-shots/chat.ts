/// 第 4 镜头：「换了模型，原来的对话都还在。」选中的模型卡（上一镜头的 exit）飞进对话框的模型键，
/// 第一轮对话还在，输入一句「换个模型，再讲一遍」，新模型接着同一段对话回答；出场时镜头往上摇到菜单栏（接第 5 镜头）。
/// 机位：开场推近在输入框上（模型卡刚飞进来的地方），原来的对话在景深外；发出去后拉回全景，原来的对话对上焦——「都还在」。
/// 出场是真的摇镜头：两个镜头像上下摞着的两格，机位往上摇，一起往下走（demos/camera.ts 的 tiltUp），落在第 5 镜头推近的菜单栏上。
import type { Shot, ShotCtx } from "../../demos/film.ts";
import { tiltUp } from "../../demos/camera.ts";
import { typeDelay, typedPrefixes } from "../../demos/filmShots.ts";
import { cursorOf } from "./cursor.ts";
import { capIn, capOut, clearOverlay, holdCap, READ_BEAT, settle, showShot, type FilmEnv, within } from "./kit.ts";
import { poseChat, poseUsage } from "./poses.ts";
import { CAM_EASE, cameraOf, fitScale, frame, HOME, soften, type Pose } from "./camera.ts";
import { trayFraming } from "./usage.ts";

/// 推近输入框的倍数上限、拉回全景多久
const PUSH_SCALE = 1.3;
const PULL_MS = 800;
/// 向上摇多久、途中虚到多少
const TILT_MS = 1050;
const TILT_BLUR = 2.5;

/// 推近的输入框：输入框放在画面中间偏下，整条留在画面里。上一镜头（models.ts）飞模型卡的落点也按它算
export function composerFraming(env: FilmEnv, shot: HTMLElement): Pose {
  const cam = cameraOf(env, shot);
  const { w, h } = cam.stage;
  const box = cam.rect(shot.querySelector(".composer")!);
  const s = fitScale(PUSH_SCALE, box.w, w, 16, 1.06);
  return frame(s, [box.x + box.w / 2, box.y + box.h / 2], [w / 2, h * 0.74], box, { w, h });
}

/// 推近时退到景深外的：第一轮对话
export function earlierMessages(shot: HTMLElement): HTMLElement[] {
  return [...shot.querySelectorAll<HTMLElement>(".msg")].slice(0, 2);
}

export function chatShot(env: FilmEnv, index: number): Shot {
  const shot = env.shotEls[index]!;
  const msgs = [...shot.querySelectorAll<HTMLElement>(".msg")];
  const reply = shot.querySelector<HTMLElement>(".reply")!;
  const input = shot.querySelector<HTMLElement>(".input")!;
  const chip = shot.querySelector<HTMLElement>(".model")!;
  // 要打的两段文字是静态 HTML 里现成的（目录文案）：输入框的 data-text、回复的全文
  const ask = input.dataset.text!;
  const answer = reply.textContent ?? "";

  /// 逐字打出来；被打断返回 false
  async function type(ctx: ShotCtx, el: HTMLElement, text: string, ms: number): Promise<boolean> {
    for (const prefix of typedPrefixes(text)) {
      if (!ctx.alive()) return false;
      el.textContent = prefix;
      await ctx.sleep(ms);
    }
    return ctx.alive();
  }
  const show = (m: HTMLElement) => {
    m.hidden = false;
    m.classList.add("shown");
  };

  return {
    // 进度条按真实用时走（2026-10-07 加机位、真摇镜头后实测 4.95 秒；画板名义 9.3 秒）
    duration: 4950,

    enter() {
      showShot(env, index);
      settle(shot);
      clearOverlay(env);
      poseChat(env, shot, "start");
    },

    async demo(ctx: ShotCtx) {
      // 开场推近在输入框上（上一镜头的模型卡就落在这里），第一轮对话在景深外
      const cam = cameraOf(env, shot);
      const close = composerFraming(env, shot);
      const earlier = earlierMessages(shot);
      cam.hold(close);
      soften(earlier, true, 0);
      const cursor = cursorOf(env);
      cursor.zoomTo(close.s, 0);
      capIn(shot);
      // 模型键露面（飞来的卡落在这里），闪一下表示换了
      chip.removeAttribute("data-hold");
      chip.animate(
        [
          { background: "var(--ink)", color: "var(--face)", transform: "scale(1.08)" },
          { transform: "none" },
        ],
        { duration: 900, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
      cursor.moveTo(cam.at(input, close, 0.4));
      await ctx.sleep(READ_BEAT);
      if (!ctx.alive()) return;
      if (!(await type(ctx, input, ask, typeDelay(ask, { max: 55, total: 800 })))) return;
      await ctx.sleep(200);
      if (!ctx.alive()) return;
      input.textContent = "";
      show(msgs[2]!);
      // 发出去：拉回全景，第一轮对话对上焦，新模型的回答接着写
      void cam.move(HOME, PULL_MS, { from: close });
      cursor.follow(close, HOME, PULL_MS);
      soften(earlier, false, PULL_MS);
      await ctx.sleep(250);
      if (!ctx.alive()) return;
      reply.textContent = "";
      show(msgs[3]!);
      if (!(await type(ctx, reply, answer, typeDelay(answer, { max: 30, total: 1100 })))) return;
      await ctx.sleep(500);
    },

    // 转场：机位往上摇到菜单栏（对应「抬头就知道」）。第 5 镜头的世界摞在这一镜头上面一格，
    // 两层一起往下走同一段距离；途中虚一点（摇得快），落定时停在第 5 镜头推近的菜单栏上（它的 demo 从这个机位开场）
    async exit(ctx: ShotCtx) {
      const next = env.shotEls[index + 1]!;
      const wait = capOut(shot);
      poseUsage(env, next, "start");
      await ctx.sleep(Math.max(wait, 280));
      if (!ctx.alive()) return;
      const cam = cameraOf(env, shot);
      const nextCam = cameraOf(env, next);
      const p = tiltUp(trayFraming(env, next), cam.stage.h);
      holdCap(next);
      next.classList.add("on");
      void cam.move(p.outTo, TILT_MS, { from: p.outFrom, easing: CAM_EASE });
      void cam.blur(0, TILT_BLUR, TILT_MS, { span: [0.15, 0.55] });
      cursorOf(env).follow(p.outFrom, p.outTo, TILT_MS);
      void nextCam.blur(TILT_BLUR, 0, TILT_MS, { span: [0.45, 0.9] });
      await within(ctx, nextCam.move(p.inTo, TILT_MS, { from: p.inFrom, easing: CAM_EASE }), TILT_MS);
    },

    rest() {
      showShot(env, index);
      settle(shot);
      clearOverlay(env);
      poseChat(env, shot, "end");
    },
  };
}
