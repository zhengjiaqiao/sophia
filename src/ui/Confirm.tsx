import { useEffect } from "react";
import type { ReactNode } from "react";
import { Button } from "./Button.tsx";

/// 确认弹窗（组件规范 §5）：只有会造成不可逆或难以察觉后果的操作才确认，
/// 且只确认一道。弹窗必须给出做决定所需的信息，而不只是问「确定吗」。
/// 背景点击与 Esc 等同取消。

export interface ConfirmProps {
  /// 标题。嵌了 skill 名时整个标题不做大小写转换（§1.2）
  title: ReactNode;
  /// 说明正文
  body?: ReactNode;
  /// 条件性警告段：有才出现。路径、目录大小、受影响的链接数、git 状态放这儿
  warning?: ReactNode;
  /// 主动作文案要说清会发生什么，如「删到废纸篓」，不写「确定」
  confirmLabel: string;
  onConfirm?: () => void;
  /// 非空即禁用主动作，并作为鼠标悬停的原因（§3）。
  /// 本体在 git 仓库里时就是这条：不代删，只告诉你该去哪儿删
  confirmDisabledReason?: string;
  /// 破坏性：边框同默认，分量由信息和文案承担，不涂红（§1.1）
  destructive?: boolean;
  /// 默认「取消」；不代删那个变体里是「知道了」
  cancelLabel?: string;
  onCancel: () => void;
}

export function Confirm({
  title,
  body,
  warning,
  confirmLabel,
  onConfirm,
  confirmDisabledReason,
  destructive,
  cancelLabel = "取消",
  onCancel,
}: ConfirmProps) {
  // Esc 等同取消
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const disabled = Boolean(confirmDisabledReason);

  return (
    // 背景点击等同取消；点在弹窗里不冒泡出去
    <div className="ss-confirm-layer" onClick={onCancel} role="presentation">
      <div className="ss-confirm-veil" />
      <div
        className="ss-confirm"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ss-confirm__title">{title}</div>
        {body ? <div className="ss-confirm__body">{body}</div> : null}
        {warning ? <div className="ss-confirm__warning">{warning}</div> : null}
        <div className="ss-confirm__foot">
          <Button variant="link" onClick={onCancel}>
            {cancelLabel}
          </Button>
          {disabled ? (
            <Button
              variant={destructive ? "destructive" : "default"}
              disabled
              disabledReason={confirmDisabledReason as string}
            >
              {confirmLabel}
            </Button>
          ) : (
            <Button variant={destructive ? "destructive" : "default"} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
