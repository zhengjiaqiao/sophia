import type { ReactNode } from "react";
import { Button } from "./Button.tsx";

/// 灰字一句（DESIGN「空态与忙碌态」：筛选无结果、一块区域暂时是空的）：一句 13 `ink-mute`，可带一颗紧凑默认键
/// （`没有匹配的模型 · 清除筛选`、`还没有网关，先加一家`）。不带图、不居中——整块区域完全没有内容、要说现状和
/// 下一步时用 `Empty`。离开 Sophia 的动作（`去发布页`）给 `leave`：画成跟在句子后面的浅键（`inline`，末尾自动带 ↗），
/// 不垫底，与句子之间一个「 · 」，排在句子里跟着折行（2026-10-06）。外距归所在的页
export interface NoteProps {
  children: ReactNode;
  /// 句后的一颗键：默认键紧凑 24；`leave` 时句后浅键
  action?: { label: string; onClick: () => void; leave?: boolean };
}

export function Note({ children, action }: NoteProps) {
  if (action?.leave)
    return (
      <p className="ss-note">
        <span className="ss-note__text">
          {children}
          {/* 「·」与后面的键之间不折开：`·` 不会孤零零留在行尾 */}
          {" ·\u00a0"}
          <Button variant="quiet" inline onClick={action.onClick}>
            {action.label}
          </Button>
        </span>
      </p>
    );
  return (
    <p className="ss-note">
      <span className="ss-note__text">{children}</span>
      {action ? (
        <Button size="compact" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </p>
  );
}
