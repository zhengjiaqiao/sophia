import type { ReactNode } from "react";
import type { ToastAlign } from "../layerPlace.ts";
import { FloatingToast } from "./FloatingToast.tsx";
import { Spinner, useBusyShown } from "./Spinner.tsx";

/// 触发键原位忙碌（DESIGN「反馈的两种形态 › 忙碌」「忙碌指示：只在用户等的地方，带文字」）。
///
/// **全应用只有这一个 0.3 秒门槛**（`useBusyShown`）：`busy` 一起，这颗键当即点不动、外观不变；
/// 更快做完的什么都不显示（不闪一下）；过了门槛才按形态露出「在忙」。三种形态，按那颗键周围放不放得下一句话选：
/// - `replace`（默认）：键原位换成 14 宽刻度 + 一句（`正在重启 Codex`）。放得下一句话的地方都用它
/// - `dim`：键留在原位、变淡到 `--busy-dim`，不换字——键本身就是那个记号、旁边放不下一句（表格选择行的一点）
/// - `float`：键留在原位锁着，一句话浮在键下方（纸窗 `BusyToast`，同提示条的位置规则）——键很小、
///   结果提示稍后也出在同一个位置（格子）
///
/// 只给用户发起、正在等的事；后台例行读取不显示忙碌。完成（`busy` 落下）即恢复原样

export type BusyMode = "replace" | "dim" | "float";

export interface BusySlotProps {
  /// 触发的那颗键此刻在等
  busy: boolean;
  /// 忙什么：`正在重启 Codex`；同时作读屏文本
  label: string;
  /// 触发键本身
  children: ReactNode;
  /// 过了门槛怎么露出「在忙」，见上
  mode?: BusyMode;
  /// `replace`：给那一句换外观时用（默认 13 `ink-mute`、刻度与字间距 6）
  className?: string;
  /// `float`：浮窗的水平对齐（默认居中于键）
  align?: ToastAlign;
}

export function BusySlot({
  busy,
  label,
  children,
  mode = "replace",
  className,
  align,
}: BusySlotProps) {
  const shown = useBusyShown(busy);

  if (mode === "dim") {
    // 包层一直在（空闲时不带任何样子）：键不因忙闲重挂
    const classes = ["ss-busyslot-dim"];
    if (busy) classes.push("is-locked");
    if (shown) classes.push("is-dim");
    return (
      <span className={classes.join(" ")} aria-busy={busy || undefined}>
        {children}
      </span>
    );
  }

  if (mode === "float") {
    // 包层是浮窗的锚：键照旧、锁着，一句话浮在它下方
    return (
      <span
        className={busy ? "ss-busyslot-float is-locked" : "ss-busyslot-float"}
        aria-busy={busy || undefined}
      >
        {children}
        {shown ? (
          <FloatingToast align={align}>
            <BusyToast label={label} />
          </FloatingToast>
        ) : null}
      </span>
    );
  }

  if (shown) {
    return (
      <span className={className ? `ss-busyslot ${className}` : "ss-busyslot"} role="status">
        <Spinner size={14} label={label} />
        <span>{label}</span>
      </span>
    );
  }
  if (busy) {
    return (
      <span className="ss-locked" aria-busy="true">
        {children}
      </span>
    );
  }
  return <>{children}</>;
}

/// 浮起的「在忙」一窗（提示条的忙碌形态，`Toast busy=` 也画它）：同成功提示条的纸窗、单行高 32，
/// 句首 14 宽刻度 + 一句 13 `ink-mute`。不自己消失：忙完由调用方撤下、换成结果提示条（同一个位置）。
/// 位置不归它管：放进 `FloatingToast`（`BusySlot mode="float"` 自己放）
export function BusyToast({ label }: { label: string }) {
  return (
    <div className="ss-toast ss-toast--routine ss-toast--busy" role="status">
      <Spinner size={14} label={label} />
      <span>{label}</span>
    </div>
  );
}
