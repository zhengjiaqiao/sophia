import type { ReactNode } from "react";
import { NoticePanel } from "./NoticePanel.tsx";

/// **转接层，页面迁移完就删**：错误横幅已并进灰面板（`NoticePanel scope="app"`，2026-09-25 设计系统梳理）——
/// 两者意思相同（不会自己走、要你处理），只差放在哪。新代码直接写 `<NoticePanel scope="app" …/>`。
/// 灰面板的实现与说明在 NoticePanel.tsx；这里只把旧的 props 原样转过去，外观不变

export interface ErrorBannerProps {
  /// 主句：动词 600 用 <b> 包；路径用等宽包一层再传进来
  message: ReactNode;
  /// 副句：`ink-mute` 的原因（`权限不足`），另起一行
  detail?: ReactNode;
  /// 右端的默认键，紧凑 24（`再试一次` `重启路由`）
  action?: { label: string; onClick: () => void };
  /// 可关的才给 ×
  onClose?: () => void;
}

export function ErrorBanner({ message, detail, action, onClose }: ErrorBannerProps) {
  return (
    <NoticePanel scope="app" message={message} detail={detail} action={action} onClose={onClose} />
  );
}

export { NoticePanel } from "./NoticePanel.tsx";
export type { NoticePanelAction, NoticePanelProps } from "./NoticePanel.tsx";
