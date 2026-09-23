import type { ReactNode } from "react";
import { Button, IconButton } from "./Button.tsx";
import { IconAttention, IconClose } from "./icons.tsx";
import { Spinner } from "./Spinner.tsx";

/// 错误横幅（DESIGN「提示条分两档 › 需要注意 · 大面积」，front-matter `banner-error`）：应用级 / 页级故障，
/// 放在内容区页边内的 **`surface` 灰面板**（8 圆角、无边无影），不自动消失。大面积不用黑——一整条黑太重。
/// 左侧墨色 `!`，主句 `ink` + 副句 `ink-mute`，右端默认描边紧凑键（canvas 底）与可选 `×`。
/// 与提示条的区别——提示条是某次操作的结果，横幅是那条链路此刻不通。

export interface ErrorBannerProps {
  /// 主句：动词 600 用 <b> 包；路径用等宽包一层再传进来
  message: ReactNode;
  /// 副句：`ink-mute` 的原因（`权限不足`）
  detail?: ReactNode;
  /// 右端的默认描边紧凑键（`再试一次` `重启路由`）
  action?: { label: string; onClick: () => void };
  /// 可关的才给 ×（页级「路由没在跑」不可关，恢复后自动收起）
  onClose?: () => void;
}

export function ErrorBanner({ message, detail, action, onClose }: ErrorBannerProps) {
  return (
    <div className="ss-banner" role="alert">
      <span className="ss-banner__mark" title="故障" role="img" aria-label="故障">
        <IconAttention />
      </span>
      <div className="ss-banner__body">
        <div className="ss-banner__text">
          <div className="ss-banner__message">{message}</div>
          {detail ? <div className="ss-banner__detail">{detail}</div> : null}
        </div>
        {action ? (
          <Button size="compact" onClick={action.onClick}>
            {action.label}
          </Button>
        ) : null}
        {onClose ? (
          <span className="ss-banner__close">
            <IconButton icon={<IconClose />} title="关闭" onClick={onClose} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

export interface NoticePanelAction {
  label: string;
  onClick: () => void;
  /// 给了就禁用，并作为悬停说明
  disabledReason?: string;
}

export interface NoticePanelProps {
  /// 一句后果：`改动要重启 Codex 才生效`
  message: ReactNode;
  /// 默认描边紧凑键（canvas 底）
  action?: NoticePanelAction;
  /// 可选的文字链（`稍后`）
  link?: { label: string; onClick: () => void };
  /// 正在执行：键的位置换成忙碌指示 + 这一句（`正在接管`），不再出键与文字链
  busy?: string;
  /// 原因（`端口 47328 被别的程序占着`）：跟在主句后同一行写出（`ink-mute`），不藏进悬停——
  /// 原因决定下一步怎么做（端口被占时重启多半还会失败）
  reason?: string;
}

/// 行内待办条（DESIGN「提示条分两档 › 需要注意 · 大面积」，front-matter `row-notice`）：挂在某一行下面、
/// 内容宽的 `surface` 灰面板（8 圆角、无边无影），墨色 `!` + 一句 + 默认描边紧凑键 + 可选文字链
export function NoticePanel({ message, action, link, busy, reason }: NoticePanelProps) {
  return (
    <div className="ss-noticepanel" role="status">
      <span className="ss-noticepanel__mark" title="要你动手" role="img" aria-label="要你动手">
        <IconAttention />
      </span>
      <span className="ss-noticepanel__message">
        {message}
        {reason ? <span className="ss-noticepanel__reason"> · {reason}</span> : null}
      </span>
      {busy ? (
        <span className="ss-noticepanel__actions">
          <Spinner size={14} label={busy} />
          <span>{busy}</span>
        </span>
      ) : action || link ? (
        <span className="ss-noticepanel__actions">
          {action ? (
            action.disabledReason ? (
              <Button size="compact" disabled disabledReason={action.disabledReason}>
                {action.label}
              </Button>
            ) : (
              <Button size="compact" onClick={action.onClick}>
                {action.label}
              </Button>
            )
          ) : null}
          {link ? (
            <Button variant="link" onClick={link.onClick}>
              {link.label}
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
