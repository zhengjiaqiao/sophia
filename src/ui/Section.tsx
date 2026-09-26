import type { ReactNode } from "react";
import "./Section.css";

/// agent 页的一节（DESIGN「agent 页」：一个 agent 一页，页内按能力分节）。所有能力节同一骨架：
/// 节头一行＝节名（`head` 16 / 600）+ 12 + 这一节的总开关（有的话）+ 12 + 条件出现的键（Codex 的
/// `重启生效` / `启动 Codex` / `卸下后台服务`）：开关紧跟节名，说的就是这一节（2026-09-25 产品负责人真机：
/// 「这个开关按钮太远了」——开关放在右端，离它说的节名 700px）。下面是节内容。页面头下 24、节与节之间 48 归外壳
export interface SectionProps {
  /// 节名（`第三方模型`、`用量`），原样
  title: ReactNode;
  /// 紧跟节名的总开关；没有总开关的节不给
  control?: ReactNode;
  /// 开关右边 12 的键（它引起的下一步、或只属于某个状态的动作）；没有时这一格空着
  actions?: ReactNode;
  /// 节头的 ref：锚定确认要锚在节头下方、不盖节头
  headRef?: (el: HTMLDivElement | null) => void;
  children?: ReactNode;
}

export function Section({ title, control, actions, headRef, children }: SectionProps) {
  return (
    <div className="ss-section">
      <div className="ss-section__head" ref={headRef}>
        <h2 className="ss-section__title">{title}</h2>
        {control ? <div className="ss-section__control">{control}</div> : null}
        {actions ? <div className="ss-section__actions">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}
