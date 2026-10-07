/// 第 6 镜头（片尾）：上一镜头的托盘图标落成字标的 S（对接，写在 usage.ts 的 exit 里），其余字母从 S 往右展开，
/// 黑猫小戏约 8.5 秒（2026-10-07 产品负责人嫌慢，收短了停顿），落「点几下，就配好。」（spec R7.6、R8）。
/// 猫与 GSAP 在 ending.ts，只在要播到片尾时才动态加载；加载失败就没有猫，字标与落字照常。
import { CatScene } from "../../demos/catScene.ts";
import type { Shot, ShotCtx } from "../../demos/film.ts";
import { WORDMARK_GLYPH, WORDMARK_S_CUT } from "../../demos/filmShots.ts";
import type { Cat } from "./ending.ts";
import { animate, clearOverlay, settle, showShot, within, type FilmEnv } from "./kit.ts";

type Ending = typeof import("./ending.ts");
let loading: Promise<Ending | null> | null = null;
/// 猫的代码已经拉下来了（同步可查：对接前要定字标落在哪儿）
let ready: Ending | null = null;

/// 提前把猫的代码拉下来（开播时调一次；重复调用只加载一次）
export function preloadEnding(): Promise<Ending | null> {
  loading ??= import("./ending.ts").then((m) => (ready = m)).catch(() => null);
  return loading;
}

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/// 片尾的起点：字标只露 S（`data-hand`，裁切在 ShotEnd.astro）、落字藏着。猫的代码已在就放猫：整组（字标 + 猫）居中，
/// S 落在最终位置上。上一镜头的对接先调它（`flown`：本轮的位置已定，片尾 enter 不再改），片尾 enter 再调一次
export function poseEndStart(shot: HTMLElement, flown = false): void {
  if (shot.dataset.hand === "flown" && !flown) {
    shot.dataset.hand = "";
    return;
  }
  shot.dataset.hand = flown ? "flown" : "";
  if (ready && !reduced()) shot.dataset.cat = "on";
  else delete shot.dataset.cat;
}

export function endShot(env: FilmEnv, index: number): Shot {
  const shot = env.shotEls[index]!;
  const wm = shot.querySelector<HTMLElement>(".endwm")!;
  const line = shot.querySelector<HTMLElement>(".end-line")!;
  let cat: Cat | null = null;
  const scene = new CatScene(() => cat!.start());

  /// 摆成完整画面：没有猫则字标居中；有猫（已加载过）就静静坐在 A 旁边
  function pose(): void {
    scene.stop();
    delete shot.dataset.hand;
    if (cat && !reduced()) {
      shot.dataset.cat = "on";
      cat.showFinal();
    } else {
      delete shot.dataset.cat;
    }
  }

  return {
    // 实测值（片尾 enter 到下一镜头 enter 约 13.85 秒：字母展开 0.75 + 小戏 + 落字后停 2 + 淡出 0.6；画板名义 16.5 秒）
    duration: 13850,

    enter() {
      showShot(env, index);
      settle(shot);
      clearOverlay(env);
      scene.stop();
      cat?.clear();
      poseEndStart(shot);
    },

    async demo(ctx: ShotCtx) {
      if (shot.dataset.cat === "on" && !cat) cat = ready!.createCat(shot);
      // 落字先藏着，小戏演完再出
      line.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 1, fill: "forwards" });
      // S 落定一拍，其余字母从 S 往右展开
      await ctx.sleep(120);
      if (!ctx.alive()) return;
      const cut = `inset(0px ${((1 - WORDMARK_S_CUT / WORDMARK_GLYPH.w) * 100).toFixed(3)}% 0px 0px)`;
      await within(
        ctx,
        animate(wm, [{ clipPath: cut }, { clipPath: "inset(0px 0% 0px 0px)" }], {
          duration: 620,
          easing: "cubic-bezier(.16,1,.3,1)",
        }),
        620,
      );
      if (!ctx.alive()) return;
      delete shot.dataset.hand;
      wm.getAnimations().forEach((a) => a.cancel());
      if (shot.dataset.cat === "on" && cat) await scene.run(ctx, reduced());
      if (!ctx.alive()) return;
      line.getAnimations().forEach((a) => a.cancel());
      void animate(line, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], {
        duration: 600,
        easing: "ease",
        fill: "backwards",
      });
      await ctx.sleep(2000);
    },

    // 离开片尾：整幅淡出，猫随之清掉
    async exit(ctx: ShotCtx) {
      await within(ctx, animate(shot, [{ opacity: 1 }, { opacity: 0 }], { duration: 600 }), 600);
      scene.stop();
      cat?.clear();
    },

    rest() {
      showShot(env, index);
      settle(shot);
      clearOverlay(env);
      pose();
    },
  };
}
