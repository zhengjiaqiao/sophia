/// 首屏短片的接线：把播放器（demos/film.ts）接到 Film.astro 渲出来的 DOM 上——播放键、6 段进度条、
/// 进入视口自动播放、一碰就停、减少动态只留静止帧。镜头清单在 film-shots/index.ts。
import { FilmPlayer, type FilmState } from "../demos/film.ts";
import { preloadEnding } from "./film-shots/end.ts";
import { createShots } from "./film-shots/index.ts";

function init(wrap: HTMLElement): void {
  const film = wrap.querySelector<HTMLElement>(".film")!;
  const shotEls = [...film.querySelectorAll<HTMLElement>(".shot")];
  const playBtn = wrap.querySelector<HTMLButtonElement>(".play")!;
  const segs = [...wrap.querySelectorAll<HTMLButtonElement>(".reel button")];
  const bars = segs.map((s) => s.querySelector<HTMLElement>("b")!);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const shots = createShots({ film, shotEls });
  // 访客自己动过播放键 / 进度条 / 画面：不再自动开播
  let touched = false;
  let barAnim: Animation | null = null;

  function render(state: FilmState): void {
    barAnim?.cancel();
    barAnim = null;
    bars.forEach((b, i) => {
      b.style.transform = i < state.index ? "scaleX(1)" : "scaleX(0)";
    });
    if (state.playing) {
      const bar = bars[state.index]!;
      barAnim = bar.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
        duration: shots[state.index]!.duration,
        easing: "linear",
        fill: "forwards",
      });
    } else {
      // 停下时当前这段满格：画面是这个镜头完整的样子
      bars[state.index]!.style.transform = "scaleX(1)";
    }
    playBtn.dataset.playing = String(state.playing);
    playBtn.setAttribute("aria-label", state.playing ? playBtn.dataset.labelPause! : playBtn.dataset.labelPlay!);
  }

  const player = new FilmPlayer(shots, { reducedMotion: reduced, onChange: render });
  wrap.dataset.js = "";
  segs.forEach((s, i) => {
    // 这一镜头还没接上
    if (i >= shots.length) s.disabled = true;
  });
  player.showStill();
  // 减少动态：只显示静止帧，控件也不出现（CSS 里隐藏）
  if (reduced) return;

  playBtn.addEventListener("click", () => {
    touched = true;
    void preloadEnding();
    player.toggle();
  });
  segs.forEach((s, i) =>
    s.addEventListener("click", () => {
      touched = true;
      void preloadEnding();
      player.seek(i);
    }),
  );
  // 访客一碰短片就停在完整画面
  film.addEventListener("pointerdown", (e) => {
    if (!e.isTrusted) return;
    touched = true;
    player.pause();
  });

  new IntersectionObserver(
    (entries, observer) => {
      if (!entries[0]?.isIntersecting) return;
      observer.disconnect();
      // 开播就把片尾的猫与 GSAP 拉下来（片尾要等几十秒才轮到），不在页面加载时抢带宽
      void preloadEnding();
      setTimeout(() => {
        if (!touched) player.play(0);
      }, 500);
    },
    { threshold: 0.45 },
  ).observe(film);
}

const wrap = document.querySelector<HTMLElement>("[data-film]");
if (wrap) init(wrap);
