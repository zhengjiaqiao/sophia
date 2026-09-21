import type { ReactNode } from "react";
import { Button } from "./Button.tsx";

/// 行内待办条（组件规范 §4.4）：挂在具体某一行下面，一句话 + 紧凑 pill + 「稍后」。
/// 不自动消失。
///
/// 和待处理栏的边界：这件事属于某一行、处理它的动作就在那一行上，用这个；
/// 跨行、或需要集中一条条过，用待处理栏。**不要两边都放。**

export interface RowNoticeAction {
  label: string;
  onClick: () => void;
  /// 给了就禁用，并作为鼠标悬停的原因（§3）
  disabledReason?: string;
}

export interface RowNoticeProps {
  message: ReactNode;
  actions: RowNoticeAction[];
  /// 「稍后」：不处理，但条子留着
  onLater: () => void;
  laterLabel?: string;
}

export function RowNotice({ message, actions, onLater, laterLabel = "稍后" }: RowNoticeProps) {
  return (
    <div className="ss-rownotice">
      <span className="ss-rownotice__message">{message}</span>
      <span className="ss-rownotice__actions">
        {actions.map((action) =>
          action.disabledReason ? (
            <Button
              key={action.label}
              size="compact"
              disabled
              disabledReason={action.disabledReason}
            >
              {action.label}
            </Button>
          ) : (
            <Button key={action.label} size="compact" onClick={action.onClick}>
              {action.label}
            </Button>
          ),
        )}
        <Button variant="link" onClick={onLater}>
          {laterLabel}
        </Button>
      </span>
    </div>
  );
}
