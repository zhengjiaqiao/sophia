import { useLayoutEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";

/// 样张的骨架：一个家族一页（`#keys` …），每个组件一块（名字 + 一件事 + 何时用），每块若干格样张，
/// 每格下面写这是哪个状态（静止、悬停、按下、禁用、忙碌、选中、错误……）。
/// 内容一律用 Sophia 的真实内容：skill brainstorming、defuddle，项目 CardBox，网关 openrouter

export type ForcedState = "hover" | "active" | "focus";

export interface FamilyProps {
  id: string;
  title: string;
  /// 这个家族管什么（一句）
  lead: string;
  children: ReactNode;
}

export function Family({ id, title, lead, children }: FamilyProps) {
  return (
    <section className="gallery-family" id={id} data-family={id}>
      <h1 className="gallery-family__title">{title}</h1>
      <p className="gallery-family__lead">{lead}</p>
      {children}
    </section>
  );
}

export interface BlockProps {
  /// 组件名（`Button`）
  name: string;
  /// 一件事 ｜ 何时用 ｜ 不要用在（DESIGN 组件使用指南的一行）
  guide: string;
  children: ReactNode;
}

export function Block({ name, guide, children }: BlockProps) {
  return (
    <div className="gallery-block" data-component={name}>
      <div className="gallery-block__head">
        <code className="gallery-block__name">{name}</code>
        <span className="gallery-block__guide">{guide}</span>
      </div>
      <div className="gallery-block__grid">{children}</div>
    </div>
  );
}

export interface SpecimenProps {
  /// 这一格是什么状态（`静止` `悬停` `禁用 · 先填地址`）
  label: string;
  /// 钉住一种交互态（见 forceStates.ts）
  force?: ForcedState;
  /// 样张框：plain 直接放在机面上；stage 定高的一块机面，里面 fixed / absolute 的东西（确认框、推入页、浮起小窗）只在这块里铺开
  frame?: "plain" | "stage";
  /// 样张框的宽 / 高（stage 默认 360 × 240）
  width?: number;
  height?: number;
  children: ReactNode;
}

export function Specimen({
  label,
  force,
  frame = "plain",
  width,
  height,
  children,
}: SpecimenProps) {
  const ref = useRef<HTMLDivElement>(null);
  // 钉住的交互态：悬停 / 按下框里每一层都挂上（指针停在最里层时，祖先也都在 :hover）；
  // 键盘焦点只挂在第一个能聚焦的元素上，它的祖先挂 focus-within
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !force) return;
    if (force !== "focus") {
      const all = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
      for (const el of all) el.setAttribute("data-force", force);
      return;
    }
    const target = root.querySelector<HTMLElement>("button, input, a[href], [tabindex]");
    if (!target) return;
    target.setAttribute("data-force", "focus");
    for (let el = target.parentElement; el && root.contains(el); el = el.parentElement) {
      el.setAttribute("data-force", "focus-within");
    }
  });
  const style: CSSProperties = {};
  if (width !== undefined) style.width = width;
  if (height !== undefined) style.height = height;
  return (
    <figure className="gallery-specimen">
      <div
        ref={ref}
        className={`gallery-specimen__frame gallery-specimen__frame--${frame}`}
        style={style}
      >
        {children}
      </div>
      <figcaption className="gallery-specimen__label">{label}</figcaption>
    </figure>
  );
}
