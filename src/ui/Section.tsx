import type { ReactNode } from "react";
import "./Section.css";

/// agent 页的一节（DESIGN「agent 页」：一个 agent 一页，页内按能力分节）。所有能力节同一骨架：
/// 节头＝节名（`head` 16 / 600）+ 12 + 这一节的总开关（有的话，紧跟节名）+ 右端一格这一节自己的动作；
/// 下面是节内容。页面头下 24、节与节之间 48。今天用它的是 Codex「第三方模型」，以后的「用量」同样用它
export interface SectionProps {
  /// 节名（`第三方模型`、`用量`），原样
  title: ReactNode;
  /// 紧跟节名的总开关，以及紧跟开关的、它引起的下一步（Codex 的 `重启生效`）；没有总开关的节不给
  control?: ReactNode;
  /// 节头右端这一节自己的动作（`卸下后台服务`）；没有时这一格空着
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
