import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Button } from "./Button.tsx";

/// 确认弹窗（DESIGN「页面还是弹层」「材料与工艺 › 对话框」，画板 Feedback「确认」）。
///
/// **只给两件真正不可逆的事**：MCP 的批量或跨域写入、重启 Codex（⑪ 能撤销就不弹确认）。
///
/// - 无外框白板，内边距 24 28，宽 460；标题 15/600（head-cap 档，汉字字距 0）
/// - 遮罩：`canvas` 80%（opacity 层，不用 rgba）
/// - **锚在触发它的那一行下方 6px**，且**那一行不被遮罩盖住**——用户始终看得见自己
///   正在决定的那一行（⑦）。实现：遮罩按 `anchor` 挖出那一行的矩形（四块拼成），
///   行本身不用调用方抬 z-index；行上叠一层透明接收层，点它与点遮罩一样是取消
/// - 主动作反色、只写动词（`重启` `写进去`）；`取消` 是文字链
/// - **承载后果与安全信息的句子必须留**（`safetyNote`）——那是功能
/// - 背景点击与 Esc 等同取消

export interface ConfirmAnchor {
  /// 触发行在视口里的矩形（`getBoundingClientRect()` 的结果即可）
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface ConfirmProps {
  /// 标题：`重启 Codex？` `把 notion 写进 Codex · User？`
  title: ReactNode;
  /// 正文插槽：一句后果、或后果示意图
  children?: ReactNode;
  /// 路径铭牌：`ink` 底、等宽 12 白字、内边距 10 12；`meta` 是第二行 `ink-faint`
  nameplate?: { path: string; meta?: ReactNode };
  /// 一句安全信息（13 `ink-mute`）：`会把请求头和令牌一并复制过去`
  safetyNote?: ReactNode;
  /// 主动作：只写动词，说清会发生什么，不写「确定」
  confirmLabel: string;
  onConfirm?: () => void;
  /// 非空即禁用主动作，并作为悬停说明
  confirmDisabledReason?: string;
  /// 默认「取消」
  cancelLabel?: string;
  onCancel: () => void;
  /// 触发行。不给就居中（没有触发行的场合）
  anchor?: ConfirmAnchor;
  /// 对话框与触发行怎么对齐：start 左沿对齐（默认）；end 右沿对齐——触发控件在行尾时（删网关的垃圾桶）
  align?: "start" | "end";
}

const GAP = 6;
const WIDTH = 460;

/// 遮罩挖掉触发行：上、下、左、右四块
function veilPieces(a: ConfirmAnchor): CSSProperties[] {
  return [
    { top: 0, left: 0, right: 0, height: Math.max(0, a.top) },
    { top: a.bottom, left: 0, right: 0, bottom: 0 },
    { top: a.top, left: 0, width: Math.max(0, a.left), height: a.bottom - a.top },
    { top: a.top, left: a.right, right: 0, height: a.bottom - a.top },
  ];
}

export function Confirm({
  title,
  children,
  nameplate,
  safetyNote,
  confirmLabel,
  onConfirm,
  confirmDisabledReason,
  cancelLabel = "取消",
  onCancel,
  anchor,
  align = "start",
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
  const dialogStyle: CSSProperties | undefined = anchor
    ? {
        position: "absolute",
        top: anchor.bottom + GAP,
        // 左对齐触发行（end 时右沿对齐触发行）；窗口不够宽时贴右边留 16
        left:
          align === "end"
            ? `max(16px, min(${anchor.right - WIDTH}px, calc(100vw - ${WIDTH + 16}px)))`
            : `min(${anchor.left}px, calc(100vw - ${WIDTH + 16}px))`,
      }
    : undefined;

  return (
    <div className={`ss-confirm-layer${anchor ? " is-anchored" : ""}`} role="presentation">
      {anchor ? (
        <>
          {veilPieces(anchor).map((style, i) => (
            <div key={i} className="ss-confirm-veil" style={style} onClick={onCancel} />
          ))}
          <div
            className="ss-confirm-hole"
            style={{
              top: anchor.top,
              left: anchor.left,
              width: anchor.right - anchor.left,
              height: anchor.bottom - anchor.top,
            }}
            onClick={onCancel}
          />
        </>
      ) : (
        <div className="ss-confirm-veil ss-confirm-veil--full" onClick={onCancel} />
      )}
      <div className="ss-confirm" role="dialog" aria-modal="true" style={dialogStyle}>
        <div className="ss-confirm__title">{title}</div>
        {children ? <div className="ss-confirm__body">{children}</div> : null}
        {nameplate ? (
          <div className="ss-confirm__nameplate">
            <div className="ss-confirm__path">{nameplate.path}</div>
            {nameplate.meta ? <div className="ss-confirm__meta">{nameplate.meta}</div> : null}
          </div>
        ) : null}
        {safetyNote ? <div className="ss-confirm__safety">{safetyNote}</div> : null}
        <div className="ss-confirm__foot">
          <Button variant="link" onClick={onCancel}>
            {cancelLabel}
          </Button>
          {disabled ? (
            <Button variant="primary" disabled disabledReason={confirmDisabledReason as string}>
              {confirmLabel}
            </Button>
          ) : (
            <Button variant="primary" onClick={onConfirm}>
              {confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
