import type { ReactNode } from "react";
import { Button, IconButton } from "./Button.tsx";
import { IconAttention, IconClose } from "./icons.tsx";

/// 错误横幅（DESIGN「反馈：四个地方会说话」，画板 Feedback「错误横幅」）：应用级故障，
/// 顶栏之下通栏**实心黑显示窗**，不自动消失。左侧 40px 指示窗放 `!`，与提示条同一写法。
/// 与提示条的区别——提示条是某次操作的结果，横幅是那条链路此刻不通。

export interface ErrorBannerProps {
  /// 主句：动词 600 用 <b> 包；路径用等宽包一层再传进来
  message: ReactNode;
  /// 副行：`ink-faint` 12 的原因（`权限不足`）
  detail?: ReactNode;
  /// 紧跟文字的白描边紧凑键（`再试一次` `重启路由`）
  action?: { label: string; onClick: () => void };
  /// 可关的才给 ×（页级「路由没在跑」不可关，恢复后自动收起）
  onClose?: () => void;
}

export function ErrorBanner({ message, detail, action, onClose }: ErrorBannerProps) {
  return (
    <div className="ss-banner" role="alert">
      <div className="ss-banner__indicator" title="故障" role="img" aria-label="故障">
        <IconAttention />
      </div>
      <div className="ss-banner__body">
        <div className="ss-banner__text">
          <div className="ss-banner__message">{message}</div>
          {detail ? <div className="ss-banner__detail">{detail}</div> : null}
        </div>
        {action ? (
          <Button size="compact" onDark onClick={action.onClick}>
            {action.label}
          </Button>
        ) : null}
        {onClose ? (
          <span className="ss-banner__close">
            <IconButton icon={<IconClose />} title="关闭" onDark onClick={onClose} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

export interface BlackNoticeAction {
  label: string;
  onClick: () => void;
  /// 给了就禁用，并作为悬停说明
  disabledReason?: string;
}

export interface BlackNoticeProps {
  /// 一句后果：`改动要重启 Codex 才生效`
  message: ReactNode;
  /// 白描边紧凑键
  action?: BlackNoticeAction;
  /// 可选的文字链（`稍后`），黑面上 `ink-faint`
  link?: { label: string; onClick: () => void };
}

/// 行内黑窗（画板 Models / Tray「待重启」）：挂在某一行下面、内容宽、高 32 的实心黑块，
/// `!` + 一句 + 白描边键 + 可选文字链
export function BlackNotice({ message, action, link }: BlackNoticeProps) {
  return (
    <div className="ss-blacknotice" role="status">
      <span className="ss-blacknotice__mark" title="要你动手" role="img" aria-label="要你动手">
        <IconAttention />
      </span>
      <span className="ss-blacknotice__message">{message}</span>
      {action || link ? (
        <span className="ss-blacknotice__actions">
          {action ? (
            action.disabledReason ? (
              <Button size="compact" onDark disabled disabledReason={action.disabledReason}>
                {action.label}
              </Button>
            ) : (
              <Button size="compact" onDark onClick={action.onClick}>
                {action.label}
              </Button>
            )
          ) : null}
          {link ? (
            <Button variant="link" onDark onClick={link.onClick}>
              {link.label}
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
