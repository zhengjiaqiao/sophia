import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Button } from "./Button.tsx";

/// 确认弹窗（DESIGN「页面还是弹层」「材料与工艺 › 对话框」，画板 Feedback「确认」）。
///
/// **只给两件真正不可逆的事**：MCP 的批量或跨域写入、重启 Codex（⑪ 能撤销就不弹确认）。
///
/// - 纸浮层：`paper` + 1px `hairline` 边、`float` 12 圆角 + 浮层投影，内边距 20 20 16，宽 384；
///   标题 `head` 16/600，正文 `body` 15 `ink-mute`
/// - 遮罩：`ink` 16%（`ink` 底 + opacity 层），整面压暗
/// - **锚在触发它的那一行下方 6px**，不盖住那一行（⑦）；遮罩整面压暗，不挖出那一行——
///   标题已写明对象，挖出的白带在压暗的页面上像出错了
/// - 键高 32、间距 8、右对齐：`取消` 是默认键（D14，macOS 惯例），主动作墨键在右、只写动词
///   （`重启` `写进去`）——两颗键都抬起，主次靠墨与纸分开
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
  /// 路径铭牌：凹面（`recess` 底 + 内凹）、等宽 12 `ink` 字、内边距 10 12，路径可拖选；`meta` 是第二行 `ink-faint`
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
const WIDTH = 384;

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
      {/* 遮罩整面压暗、不挖触发行：标题已写明对象（删掉 openrouter？），确认框锚在触发行旁；
          挖出来的那一条白带在压暗的页面上像是出错了（产品负责人真机） */}
      <div className="ss-confirm-veil ss-confirm-veil--full" onClick={onCancel} />
      <div className="ss-confirm" role="dialog" aria-modal="true" style={dialogStyle}>
        <div className="ss-confirm__title">{title}</div>
        {children ? <div className="ss-confirm__body">{children}</div> : null}
        {nameplate ? (
          <div className="ss-confirm__nameplate">
            <div className="ss-confirm__path ss-selectable">{nameplate.path}</div>
            {nameplate.meta ? <div className="ss-confirm__meta">{nameplate.meta}</div> : null}
          </div>
        ) : null}
        {safetyNote ? <div className="ss-confirm__safety">{safetyNote}</div> : null}
        <div className="ss-confirm__foot">
          <Button size="row" onClick={onCancel}>
            {cancelLabel}
          </Button>
          {disabled ? (
            <Button
              variant="primary"
              size="row"
              disabled
              disabledReason={confirmDisabledReason as string}
            >
              {confirmLabel}
            </Button>
          ) : (
            <Button variant="primary" size="row" onClick={onConfirm}>
              {confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
