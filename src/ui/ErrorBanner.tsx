import type { ReactNode } from "react";
import { Button } from "./Button.tsx";

/// 错误横幅（组件规范 §4.2）：顶栏之下通栏，反色。
/// 与提示条的区别——提示条是某次操作的结果，横幅是应用级故障（扫描失败、
/// 配置读不出、后台进程掉了）。反色是这套零色彩系统里最强的强调手段，
/// 留给这种罕见情况。**不自动消失**，所以这里没有计时器。

export interface ErrorBannerProps {
  /// 左侧错误原文，路径这类用等宽包一层再传进来
  message: ReactNode;
  onClose: () => void;
}

export function ErrorBanner({ message, onClose }: ErrorBannerProps) {
  return (
    <div className="ss-banner" role="alert">
      <div className="ss-banner__message">{message}</div>
      <Button variant="link" inverse onClick={onClose}>
        关闭
      </Button>
    </div>
  );
}
