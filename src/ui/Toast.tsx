import { useEffect } from "react";
import type { ReactNode } from "react";
import { Button } from "./Button.tsx";

/// 提示条（组件规范 §4.1）：右下角浮层，说「刚做完了什么」。
/// 不排队——一次操作只汇总成一句，新的替换旧的，由上层保证。

/// 三类语气，四种形态：成功（带副行统计）、成功·多项（不带）、做不成、部分失败。
export type ToastKind = "success" | "cannot" | "partial";

/// 停留时长：成功 6 秒，做不成与部分失败 8 秒——后两种要多读一会儿
export const TOAST_DWELL_MS: Record<ToastKind, number> = {
  success: 6000,
  cannot: 8000,
  partial: 8000,
};

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastProps {
  kind: ToastKind;
  /// 一句话总结。做不成时说原因，不说失败（§4.5）
  message: ReactNode;
  /// 副行等宽统计，如「新建了 1 个目录 · 1 条链接」
  stats?: string;
  /// 「撤销」只在该操作可逆时给；部分失败给「查看」跳待处理栏
  action?: ToastAction;
  /// 给了就到点自动消失
  onDismiss?: () => void;
  /// 手动关闭。busy 期间它照常可用（§6）
  onClose?: () => void;
}

export function Toast({ kind, message, stats, action, onDismiss, onClose }: ToastProps) {
  useEffect(() => {
    if (!onDismiss) return;
    const timer = setTimeout(onDismiss, TOAST_DWELL_MS[kind]);
    return () => clearTimeout(timer);
  }, [kind, onDismiss]);

  const hasFoot = Boolean(action || stats || onClose);

  return (
    <div className="ss-toast" data-kind={kind} role="status">
      <div className="ss-toast__message">{message}</div>
      {hasFoot ? (
        <div className="ss-toast__foot">
          {action ? (
            <Button variant="link" onClick={action.onClick}>
              {action.label}
            </Button>
          ) : null}
          {stats ? <span className="ss-toast__stats">{stats}</span> : null}
          {onClose ? (
            <Button variant="link" onClick={onClose}>
              关闭
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
