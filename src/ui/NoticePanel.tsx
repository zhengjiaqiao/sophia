import type { ReactNode } from "react";
import { BusySlot } from "./BusySlot.tsx";
import { Button, IconButton } from "./Button.tsx";
import { IconAttention, IconClose } from "./icons.tsx";

/// 灰面板（DESIGN「灰面板 NoticePanel」「提示条分两档 › 需要注意 · 大面积」）：**不会自己走、要你处理**的事。
/// 放在机面里的 `surface` 灰面板（`face` 12 圆角、无边无投影），左侧墨色 `!`，一句后果 + 默认键（紧凑 24，纸面在灰上
/// 读得出是一颗键）+ 可选第二颗默认键（`稍后`）+ 可选 ×。大面积不用墨——一整条黑太重。
/// 与提示条的区别：提示条是某次操作的结果、会自己走；灰面板是那条链路此刻不通、或一件待办，问题解决自动收起。
///
/// 一个组件三种范围（`scope`），意思相同、只差放在哪（原来的 `ErrorBanner` 就是 `scope="app"`）：
/// - `app` 应用级：机面顶上、页面头之上，满内容宽；主句 15 `ink` + 可选第二行 `detail` 13 `ink-mute`，内边距 12 16
/// - `section` 节：一节里（节头下、在用行下）。**占满所在容器的宽**（块级 flex、`align-self: stretch`）：
///   放进哪一块就铺满哪一块，宽由容器定、组件不自己限宽；键被推到右端控件列，主句占满中间、放不下折行
/// - `row` 行（默认）：挂在某一行下面，宽随内容；内边距 8 12，整体 13 号字
///
/// 原因（`reason`）跟在主句后同一行写出（`ink-mute`），不藏进悬停——原因决定下一步怎么做。写全，放不下就折行。
/// 正在执行（`busy`）：键先锁住，过了 0.3 秒门槛原位换成忙碌刻度 + 这一句（`BusySlot`），不再出两颗键

export type NoticeScope = "app" | "section" | "row";

export interface NoticePanelAction {
  label: string;
  onClick: () => void;
  /// 给了就禁用，原因进提示框（按下当即出）
  disabledReason?: string;
}

export interface NoticePanelProps {
  /// 放在哪：`app` 应用级 / `section` 一节里 / `row` 一行下（默认）
  scope?: NoticeScope;
  /// 一句后果：`改动要重启 Codex 才生效`。动词 600 用 <b> 包；路径用等宽包一层再传进来
  message: ReactNode;
  /// 原因（`端口 47328 被别的程序占着`）：跟在主句后同一行，`ink-mute`，写全、可折行
  reason?: string;
  /// 第二行（`app` 用）：`ink-mute` 的补充说明，另起一行
  detail?: ReactNode;
  /// 默认键，紧凑 24（`再试一次` `重启路由`）
  action?: NoticePanelAction;
  /// 可选的第二颗键（`稍后`）：同样是默认键紧凑 24——应用内能点的一律默认键
  secondary?: { label: string; onClick: () => void };
  /// **已废弃**：`secondary` 的旧名，页面迁移后删掉
  link?: { label: string; onClick: () => void };
  /// 正在执行：`正在接管`
  busy?: string;
  /// 可关的才给右端 ×（行下失败原因可关；接管 / 重新写入这类待办不可关，问题解决自动消失）
  onClose?: () => void;
}

export function NoticePanel({
  scope = "row",
  message,
  reason,
  detail,
  action,
  secondary,
  link,
  busy,
  onClose,
}: NoticePanelProps) {
  const second = secondary ?? link;
  const app = scope === "app";
  const keys =
    action || second ? (
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
        {second ? (
          <Button size="compact" onClick={second.onClick}>
            {second.label}
          </Button>
        ) : null}
      </span>
    ) : null;
  return (
    <div className={`ss-noticepanel ss-noticepanel--${scope}`} role={app ? "alert" : "status"}>
      <span
        className="ss-noticepanel__mark"
        title={app ? "故障" : "要你动手"}
        role="img"
        aria-label={app ? "故障" : "要你动手"}
      >
        <IconAttention />
      </span>
      <span className="ss-noticepanel__message">
        {message}
        {reason ? <span className="ss-noticepanel__reason"> · {reason}</span> : null}
        {detail ? <span className="ss-noticepanel__detail">{detail}</span> : null}
      </span>
      {keys !== null || busy !== undefined ? (
        <BusySlot busy={busy !== undefined} label={busy ?? ""} className="ss-noticepanel__busy">
          {keys}
        </BusySlot>
      ) : null}
      {onClose ? (
        <span className="ss-noticepanel__close">
          <IconButton icon={<IconClose />} title="关闭" onClick={onClose} />
        </span>
      ) : null}
    </div>
  );
}
