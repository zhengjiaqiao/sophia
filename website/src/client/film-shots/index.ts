/// 短片的镜头清单：第 1–5 镜头 + 片尾（第 6 镜头）。
/// 每个镜头一个文件（实现 demos/film.ts 的 Shot 契约）+ 一个 components/film/Shot*.astro（静态样子），
/// 在 Film.astro 里按序放进舞台。播放器（demos/film.ts）与接线（client/film.ts）不用改。
import type { Shot } from "../../demos/film.ts";
import { agentsShot } from "./agents.ts";
import { chatShot } from "./chat.ts";
import { endShot } from "./end.ts";
import type { FilmEnv } from "./kit.ts";
import { modelsShot } from "./models.ts";
import { skillsShot } from "./skills.ts";
import { usageShot } from "./usage.ts";

/// 进度条一共 6 段（spec R7）：镜头还没接上的段先置灰
export const SHOT_COUNT = 6;

export function createShots(env: FilmEnv): Shot[] {
  return [
    agentsShot(env, 0),
    skillsShot(env, 1),
    modelsShot(env, 2),
    chatShot(env, 3),
    usageShot(env, 4),
    endShot(env, 5),
  ];
}
