/// 把 demos/filmShots.ts 里的起点 / 终点姿态摆到页面上（第 2–5 镜头）。
/// 终点姿态就是服务端渲出来的样子，所以 rest() 摆回终点 = 回到静态 HTML；起点是演示开始时的样子。
/// 同一个函数两处用：镜头自己的 enter() / rest()，以及上一镜头的 exit()（转场里下一镜头已经露面，要先摆好起点）。
import {
  chatPose,
  matrixPose,
  modelsPose,
  usagePose,
  type Phase,
} from "../../demos/filmShots.ts";
import { snap, type FilmEnv } from "./kit.ts";

const $ = <T extends HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement>(root: ParentNode, sel: string) => [...root.querySelectorAll<T>(sel)];

/// 第 2 镜头：每格的状态、提示条收起
export function poseMatrix(env: FilmEnv, shot: HTMLElement, phase: Phase): void {
  const pose = matrixPose(phase);
  snap(env, () => {
    for (const cell of $$(shot, ".cell")) {
      cell.dataset.s = pose[Number(cell.dataset.r)]![Number(cell.dataset.c)]!;
      cell.classList.remove("is-pop");
    }
    const toast = $(shot, ".toast7");
    toast.classList.remove("on");
    toast.textContent = "";
  });
}

/// 第 3 镜头：开关、模型卡出没、选中框、字幕下划线
export function poseModels(env: FilmEnv, shot: HTMLElement, phase: Phase): void {
  const switches = $$(shot, ".switch");
  const pose = modelsPose(phase, switches.length);
  snap(env, () => {
    switches.forEach((s, i) => (s.dataset.on = String(pose.switches[i])));
    $(shot, ".mods").dataset.shown = String(pose.modsShown);
    $$(shot, ".mod").forEach((m, i) => m.classList.toggle("pick", pose.picked === i));
    $(shot, "em.ul").classList.remove("drawn");
  });
}

/// 第 4 镜头：消息条数、模型键、输入框、新回复的文字（回复全文第一次摆姿态时从静态 HTML 里读下来存在 data-full）
export function poseChat(env: FilmEnv, shot: HTMLElement, phase: Phase): void {
  const pose = chatPose(phase);
  snap(env, () => {
    $$(shot, ".msg").forEach((m, i) => {
      m.hidden = i >= pose.messages;
      m.classList.remove("shown");
    });
    const reply = $(shot, ".reply");
    reply.dataset.full ??= reply.textContent ?? "";
    reply.textContent = reply.dataset.full;
    $(shot, ".input").textContent = "";
    const chip = $(shot, ".model");
    if (pose.chip) chip.removeAttribute("data-hold");
    else chip.setAttribute("data-hold", "");
  });
}

/// 第 5 镜头：面板展开 / 收着、托盘高亮
export function poseUsage(env: FilmEnv, shot: HTMLElement, phase: Phase): void {
  const { open } = usagePose(phase);
  snap(env, () => {
    $(shot, ".drop").dataset.open = String(open);
    $(shot, ".tray").dataset.open = String(open);
  });
}
