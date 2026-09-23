import { useState } from "react";

/// 开关（DESIGN「开关」「控件有行程」）：一个**当场生效**的布尔状态，对象就是它所在的那一行。
/// 开关旁边不写「已启用」——它自己就是状态。不需要确认。
///
/// 两档，按角色选不按重要性选：
/// - `page` 32×18、旋钮 12：页面级（模型页启用、托盘）
/// - `inline` 24×14、旋钮 8：行内的规则状态（分组头「以后新出现的」、添加页「此来源以后新出现的 skill 自动添加」）
///
/// 一眼认得出是开关（胶囊轨 + 圆旋钮），机械感只做在行程和停靠上：切换 120ms
/// 机械缓动、末端 1px 过冲回弹；按下时旋钮压扁；hover 轨外缘 1px `ink-mute`。
/// 过冲只在**用户拨动之后**播一次（挂载时不播）：空闲时界面静止（已裁决的冲突 ① 对 ⑨）。

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  size?: "page" | "inline";
  /// 读屏名，**必填**：开关旁边通常没有字（规则行是图式），得告诉读屏它管什么
  label: string;
  /// 悬停说明（「只管以后新出现的，现有的不变」）
  title?: string;
  /// 给了就禁用，并作为悬停说明
  disabledReason?: string;
}

export function Switch({
  checked,
  onChange,
  size = "page",
  label,
  title,
  disabledReason,
}: SwitchProps) {
  // 拨动后的那一次过冲动画：animationend 时清掉，免得重挂载时再播
  const [moved, setMoved] = useState(false);
  const disabled = Boolean(disabledReason);
  const classes = ["ss-switch", `ss-switch--${size}`];
  if (checked) classes.push("is-on");
  if (moved) classes.push("is-moved");

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
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
      <span className="ss-switch__knob" onAnimationEnd={() => setMoved(false)} />
    </button>
  );
}

export interface CheckboxProps {
  /// `"mixed"`＝半选（全选框在部分选中时）
  checked: boolean | "mixed";
  onChange?: (next: boolean) => void;
  /// 读屏名，**必填**：视觉上复选框挨着的名字常常不在同一个元素里
  label: string;
  /// 给了就是「不可选」：`hairline` 描边，悬停说明原因（已添加的行）
  disabledReason?: string;
}

/// 复选框（DESIGN「状态与动效」「命中区与视觉尺寸是两回事」）：12px 直角方框——
/// 方＝我选的，开关＝它开着。视觉 12，命中区用伪元素撑到 24，不动 border
export function Checkbox({ checked, onChange, label, disabledReason }: CheckboxProps) {
  const disabled = Boolean(disabledReason);
  const classes = ["ss-checkbox"];
  if (checked === true) classes.push("is-on");
  if (checked === "mixed") classes.push("is-mixed");
  return (
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
      {checked === true ? (
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          <path d="M1.2 4.2l1.9 1.9L6.8 1.9" />
        </svg>
      ) : null}
      {checked === "mixed" ? (
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          <path d="M1.5 4h5" />
        </svg>
      ) : null}
    </button>
  );
}
