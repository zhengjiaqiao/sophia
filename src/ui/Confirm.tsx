import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { t } from "../i18n.ts";
import { BusySlot } from "./BusySlot.tsx";
import { Button } from "./Button.tsx";

/// 确认弹窗（DESIGN「页面还是弹层」「材料与工艺 › 对话框」，画板 Feedback「确认」）。
///
/// **只给真正不可逆、或会打断别处的决定**（⑪ 能撤销就不弹确认）：删原件、只留这份、删 MCP 最后一份、删网关、
/// 移除来源、MCP 的批量或跨域写入、重启 Codex、退出 Sophia（会把 Codex、Claude 改回官方并重启）。
///
/// - 纸浮层：`paper` + 1px `hairline` 边、`float` 12 圆角 + 浮层投影，内边距 20 20 16，宽 384；
///   标题 `head` 16/600，正文 `body` 15 `ink-mute`
/// - 遮罩：`ink` 16%（`ink` 底 + opacity 层），整面压暗
/// - **一律在窗口正中**（2026-09-25 产品负责人：锚在靠下的格子时确认框出窗、键被截掉，「要不然这种弹窗都从
///   页面中间出……不在锚点位置也是能接受的，因为其实就让用户看这个」）：确认框出来时它就是唯一要看的东西，
///   标题已写明对象；遮罩整面压暗
/// - 键高 32、间距 8、右对齐：`取消` 是默认键（D14，macOS 惯例），主动作墨键在右、只写动词
///   （`重启` `写进去`）——两颗键都抬起，主次靠墨与纸分开
/// - **承载后果与安全信息的句子必须留**（`safetyNote`）——那是功能
/// - 背景点击与 Esc 等同取消
/// - **忙碌**（`busy`，确认之后要等十几秒的事：退出时重启 Codex、Claude）：键区原位换成忙碌刻度 + 这一句
///   （`BusySlot`，0.3 秒门槛），确认框留在原处；忙时 Esc、点遮罩都不收起
/// - **单键**（不给 `onCancel`：只能读完再走的说明，如退出时没做成的那一家）：只有主动作一颗键、焦点在它上面；
///   Esc、点遮罩不收起
///
/// **窄面板形态**（`inline`，托盘面板这种放不下居中弹窗、也不该压暗整窗的地方）：在触发它的那一行下面当场展开
/// 一块凹面（`recess`、`face` 12 圆角、内边距 10 12，无边无投影、无遮罩），标题 13 / 600 `ink` + 一句后果 12
/// `ink-mute`（均衡折行），右对齐 `取消`（默认键紧凑 24）与主动作墨键（紧凑 24），键间 12。不接 Esc（Esc 归面板本身），
/// 外距由调用方的那一行给。触发键用 `ariaControls` 指向它的 `id`

export interface ConfirmProps {
  /// 标题：`重启 Codex？` `把 notion 写进 Codex · User？`
  title: ReactNode;
  /// 正文插槽：一句后果、或后果示意图
  children?: ReactNode;
  /// 路径铭牌：等宽 12 `ink` 字、不垫底色块，路径可拖选；`meta` 是第二行 `ink-faint`
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
  /// 不给就是单键：只有主动作，焦点在它上面，Esc 与点遮罩不收起
  onCancel?: () => void;
  /// 正在执行（`正在重启 Codex`）：键区原位换成忙碌刻度 + 这一句；忙时 Esc、点遮罩不收起
  busy?: string;
  /// 窄面板形态：在触发它的那一行下面当场展开的一块凹面（托盘），见上
  inline?: boolean;
  /// 窄面板形态的 id（触发键的 `aria-controls`）
  id?: string;
}

export function Confirm({
  title,
  children,
  nameplate,
  safetyNote,
  confirmLabel,
  onConfirm,
  confirmDisabledReason,
  cancelLabel = t("common.cancel"),
  onCancel,
  busy,
  inline = false,
  id,
}: ConfirmProps) {
  const titleId = useId();
  /// Esc、点遮罩收起：单键与忙碌时没有这条路
  const dismiss = busy === undefined ? onCancel : undefined;
  // Esc 等同取消（窄面板不接：Esc 归它所在的面板）
  useEffect(() => {
    if (inline || !dismiss) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dismiss, inline]);

  // 焦点默认在 `取消`（DESIGN-components「确认」）：回车 / 空格等于取消；单键时落在主动作上（第一颗键）。
  // 收起时焦点还给打开前的地方。程序放的焦点不画框、不唤起提示（inputModality）
  const foot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    foot.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  const disabled = Boolean(confirmDisabledReason);
  const size = inline ? "compact" : "row";
  const keys = (
    <>
      {onCancel ? (
        <Button size={size} onClick={onCancel}>
          {cancelLabel}
        </Button>
      ) : null}
      {disabled ? (
        <Button
          variant="primary"
          size={size}
          disabled
          disabledReason={confirmDisabledReason as string}
        >
          {confirmLabel}
        </Button>
      ) : (
        <Button variant="primary" size={size} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      )}
    </>
  );

  const content = (
    <>
      <div className="ss-confirm__title" id={titleId}>
        {title}
      </div>
      {children ? <div className="ss-confirm__body">{children}</div> : null}
      {nameplate ? (
        <div className="ss-confirm__nameplate">
          <div className="ss-confirm__path ss-selectable">{nameplate.path}</div>
          {nameplate.meta ? <div className="ss-confirm__meta">{nameplate.meta}</div> : null}
        </div>
      ) : null}
      {safetyNote ? <div className="ss-confirm__safety">{safetyNote}</div> : null}
      <div className="ss-confirm__foot" ref={foot}>
        <BusySlot busy={busy !== undefined} label={busy ?? ""}>
          {keys}
        </BusySlot>
      </div>
    </>
  );

  if (inline) {
    return (
      <div
        className="ss-confirm ss-confirm--inline"
        id={id}
        role="dialog"
        aria-labelledby={titleId}
      >
        {content}
      </div>
    );
  }

  return (
    <div className="ss-confirm-layer" role="presentation">
      {/* 遮罩整面压暗：标题已写明对象（删掉 openrouter？） */}
      <div className="ss-confirm-veil ss-confirm-veil--full" onClick={dismiss} />
      <div className="ss-confirm" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {content}
      </div>
    </div>
  );
}
