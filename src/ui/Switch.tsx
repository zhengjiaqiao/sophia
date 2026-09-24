import { useState } from "react";
import { ReasonTip } from "./Tooltip.tsx";

/// 开关（DESIGN「开关」「控件有行程」，物件感二）：一个**当场生效**的布尔状态，对象就是它所在的那一行。
/// 开关旁边不写「已启用」——它自己就是状态。不需要确认。
///
/// 实物滑动开关：左侧 7px 一颗指示点 + 凹槽 + 带三道防滑纹的纸面滑块。刻条印在槽上，
/// 滑块盖住一条、露出另一条——开＝滑块在右、左边露出橙刻条、橙点；关＝滑块在左、右边露出灰刻条、灰点。
/// 位置 + 刻条 + 指示点三重表达，色弱用户靠位置不丢信息。**橙只在这里（和指示点）**。
///
/// 两档，按角色选不按重要性选：
/// - `regular` 40×20（滑块 19×16、刻条 12×6、点 6）：页面级（模型页、托盘的启用）
/// - `compact` 32×16（滑块 15×12、刻条 9×4、点 5）：行内的规则状态（来源行「以后新出现的自动加到」）
///
/// 机械感只做在行程和停靠上：切换 120ms 机械缓动、末端 1px 过冲回弹；按下时滑块底边消失、下沉 1px；
/// hover 槽外缘 1px `ctl-edge`。过冲只在**用户拨动之后**播一次（挂载时不播）：空闲时界面静止。
/// 不可用：槽透明 + `hairline` 环、滑块 `recess` 无底边、刻条与防滑纹 `hairline`、指示点空心。

export type SwitchSize = "regular" | "compact";

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  size?: SwitchSize;
  /// 读屏名，**必填**：开关旁边通常没有字（规则行是图式），得告诉读屏它管什么
  label: string;
  /// 悬停说明（「只管以后新出现的，现有的不变」）
  title?: string;
  /// 给了就禁用。原因提示框悬停出、**按下当即出**（DESIGN「所有点了做不了的控件，按下当即说明原因」：
  /// 它是开关，用户一定会去点）；外面再包的提示框（「打开：…」）禁用期间让给它
  disabledReason?: string;
  /// 禁用原因提示框的优先方向（默认上方）
  tipPlacement?: "top" | "bottom";
  /// 外面包的 Tooltip 经 cloneElement 挂上来的，转给 <button>
  "aria-describedby"?: string;
}

export function Switch({
  checked,
  onChange,
  size = "regular",
  label,
  title,
  disabledReason,
  tipPlacement,
  "aria-describedby": describedBy,
}: SwitchProps) {
  // 拨动后的那一次过冲动画：animationend 时清掉，免得重挂载时再播
  const [moved, setMoved] = useState(false);
  const disabled = Boolean(disabledReason);
  const classes = ["ss-switch", `ss-switch--${size}`];
  if (checked) classes.push("is-on");
  if (moved) classes.push("is-moved");

  return (
    <ReasonTip reason={disabledReason} placement={tipPlacement}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        aria-describedby={describedBy}
        className={classes.join(" ")}
        title={disabled ? disabledReason : title}
        disabled={disabled}
        onClick={
          disabled
            ? undefined
            : () => {
                setMoved(true);
                onChange(!checked);
              }
        }
      >
        <Indicator on={checked} size={size} disabled={disabled} />
        <span className="ss-switch__track" aria-hidden="true">
          <span className="ss-switch__scribe ss-switch__scribe--on" />
          <span className="ss-switch__scribe ss-switch__scribe--off" />
          <span className="ss-switch__knob" onAnimationEnd={() => setMoved(false)}>
            <span className="ss-switch__grip" />
            <span className="ss-switch__grip" />
            <span className="ss-switch__grip" />
          </span>
        </span>
      </button>
    </ReasonTip>
  );
}

export interface IndicatorProps {
  /// 开着 / 在生效
  on: boolean;
  /// regular 6px（默认）；compact 5px（紧凑开关旁）
  size?: SwitchSize;
  /// 不可用：空心（1px `hairline` 环）
  disabled?: boolean;
  /// 读屏名。不给就当装饰（旁边的开关或名字已经说了状态）
  label?: string;
}

/// 指示点（DESIGN「开关」，裁决「橙的两种形态」）：6px 圆，开＝`accent` 橙、关＝`ctl-border`；
/// 不发光、无投影。橙的**含义**只有一个「开着 / 在生效」，形态有两种：开关刻条与这颗点。
/// 用在：开关左侧 7px；侧栏 `Codex` 后（第三方模型开着才画）；开着规则的来源片片首
export function Indicator({ on, size = "regular", disabled, label }: IndicatorProps) {
  const classes = ["ss-indicator"];
  if (size === "compact") classes.push("ss-indicator--compact");
  if (on) classes.push("is-on");
  if (disabled) classes.push("is-disabled");
  return label ? (
    <span className={classes.join(" ")} role="img" aria-label={label} title={label} />
  ) : (
    <span className={classes.join(" ")} aria-hidden="true" />
  );
}

export interface CheckboxProps {
  /// `"mixed"`＝半选（全选框在部分选中时）
  checked: boolean | "mixed";
  onChange?: (next: boolean) => void;
  /// 读屏名，**必填**：视觉上复选框挨着的名字常常不在同一个元素里
  label: string;
  /// 给了就是「不可选」：`hairline` 边、透明底，原因提示框悬停出、按下当即出（已添加的行）
  disabledReason?: string;
}

/// 复选框（DESIGN「复选框」「命中区与视觉尺寸是两回事」）：13 方、`mark` 4 圆角——
/// 方＝我选的，开关＝它开着。关＝`paper` 底 + 1px `ink-faint` 边；开＝`ink` 底 + `face` 对勾；
/// 半选＝`ink` 底 + `face` 短横。视觉 13，命中区用伪元素撑到 25，不动 border；全应用只有这一个尺寸
export function Checkbox({ checked, onChange, label, disabledReason }: CheckboxProps) {
  const disabled = Boolean(disabledReason);
  const classes = ["ss-checkbox"];
  if (checked === true) classes.push("is-on");
  if (checked === "mixed") classes.push("is-mixed");
  return (
    <ReasonTip reason={disabledReason}>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked === "mixed" ? "mixed" : checked}
        aria-label={label}
        className={classes.join(" ")}
        title={disabledReason}
        disabled={disabled}
        onClick={disabled ? undefined : () => onChange?.(checked !== true)}
      >
        <CheckboxGlyph checked={checked} />
      </button>
    </ReasonTip>
  );
}

/// 复选框里的记号：勾上＝对勾，半选＝短横，没勾＝不画。`Checkbox` 与整行是按钮的列表
/// （`pages/CheckMark.tsx`）共用这一份，同一个记号在全应用里只有一个画法
export function CheckboxGlyph({ checked }: { checked: boolean | "mixed" }) {
  if (checked === false) return null;
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 9 9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={checked === true ? "M1.6 4.7l1.9 1.9L7.4 2.4" : "M2 4.5h5"} />
    </svg>
  );
}
