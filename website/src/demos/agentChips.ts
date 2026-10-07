/// 第 1 镜头（agent 名字卡散落后排成两列）的几何，纯函数。
/// 排好的位置由 CSS 决定（静止帧、关 JS 都靠它），这里只管「散落」：每张卡随机落在画面里的一处，带一点倾斜。

export interface Size {
  w: number;
  h: number;
}
export interface Pose {
  /// 卡片未旋转时左上角在画面里的位置（px）
  x: number;
  y: number;
  /// 倾斜角（度）
  r: number;
}

/// 舞台宽度（px）低于它算窄：名字卡排布换成整幅两列（ShotAgents.astro 里的 @container 同值）
export const NARROW_FILM = 560;

/// 最大倾斜（度）：±MAX_TILT
export const MAX_TILT = 13;

/// 第 1 镜头里散落、排队的 agent 名字（都得是应用认得的：tests/film-shot1.test.ts 对着 harnesses.json 查）
export const FILM_AGENTS = [
  "Claude Code",
  "Codex",
  "Cursor",
  "Gemini CLI",
  "GitHub Copilot",
  "Windsurf",
  "Kimi",
  "Qwen Code",
] as const;

/// 一张卡散落到哪：按卡自身宽高收在画面里（旋转后的外框也不出画面）。
/// 宽屏落在右半边（左边是字幕），窄屏落在字幕下方的整幅。rand 依次取 x、y、倾斜角
export function scatterPose(film: Size, chip: Size, rand: () => number): Pose {
  // 画面宽不到 560：整幅都能落（卡片在字幕下方）；够宽时落在右半边，左边留给字幕。CSS 里排好的位置同此分界
  const narrow = film.w < NARROW_FILM;
  const sideGap = film.w * 0.06;
  const lo = (narrow ? sideGap : film.w * 0.42) + 4;
  const hi = Math.max(lo, film.w - chip.w - sideGap - 4);
  const top = film.h * (narrow ? 0.3 : 0.12);
  // 旋转后外框在竖直方向最多多出 (w·sinθ + h·cosθ − h) / 2；底部与顶部各留这么多
  const tilt = (MAX_TILT * Math.PI) / 180;
  const lift = (chip.w * Math.sin(tilt) + chip.h * Math.cos(tilt) - chip.h) / 2;
  const yLo = top + lift;
  const yHi = Math.max(yLo, film.h * 0.92 - chip.h - lift);
  return {
    x: lo + rand() * (hi - lo),
    y: yLo + rand() * (yHi - yLo),
    r: (rand() - 0.5) * 2 * MAX_TILT,
  };
}

/// 卡片绕中心旋转 r 度后的外接矩形
export function rotatedBounds(x: number, y: number, w: number, h: number, r: number) {
  const a = (r * Math.PI) / 180;
  const bw = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
  const bh = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
  const cx = x + w / 2;
  const cy = y + h / 2;
  return { left: cx - bw / 2, top: cy - bh / 2, right: cx + bw / 2, bottom: cy + bh / 2 };
}
