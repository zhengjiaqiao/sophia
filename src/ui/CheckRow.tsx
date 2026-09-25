import type { ReactNode } from "react";
import { CheckboxGlyph } from "./Switch.tsx";
import { ReasonTip } from "./Tooltip.tsx";

/// 画出来的 14px 勾选框（与 `Checkbox` 同一套 `.ss-checkbox` 样式、同一个记号），给「整行是按钮」的地方用：
/// 命中区是整行（DESIGN「命中区与视觉尺寸是两回事」），方框本身不是按钮——按钮里套按钮不合法。
/// 读屏状态由外层行的 `role` + `aria-checked` 说，这里 aria-hidden。`"mixed"`＝半选，画一道短横。
/// 行悬停时方框「手靠近」：行元素加 `data-checkrow`（行禁用时别加）；行禁用（`:disabled`）时方框自动平贴。
/// 用在 `CheckRow`、`MenuItem kind="check"`；页面里不再手拼 `.ss-checkbox`
export function CheckMark({ on }: { on: boolean | "mixed" }) {
  const classes = ["ss-checkbox", "ss-checkmark"];
  if (on === true) classes.push("is-on");
  if (on === "mixed") classes.push("is-mixed");
  return (
    <span className={classes.join(" ")} aria-hidden="true">
      <CheckboxGlyph checked={on} />
    </span>
  );
}

export interface CheckRowProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /// 名字（body 15，放不下截断）
  children: ReactNode;
  /// 名字前的图形（agent 图标 16），在勾选框之后
  icon?: ReactNode;
  /// 行尾（模型 id：等宽 12 `ink-faint`，放不下截断）。由调用方给好样子（`Mono`）
  trailing?: ReactNode;
  /// 给了就不可选：整行平贴、字退到 `ink-faint`、不回应悬停；原因提示框悬停出、按下当即出
  disabledReason?: string;
  /// 这一行此刻被点名（取消勾选后行下浮起提示的那一会儿）：保持悬停底
  highlighted?: boolean;
  /// list（默认）：列表里一行 34（`--row-h`），框 → 名字 12；grid：设置页的三列网格一格 36，框 → 图标 → 名字各 10
  size?: "list" | "grid";
  /// 读屏名；不给就用名字的文字
  label?: string;
}

/// 勾选行（DESIGN「勾选框」「命中区与视觉尺寸是两回事」）：**整行可点**的一项多选——左 14px 勾选框（只画状态）+
/// 可选图标 + 名字 + 可选行尾。悬停整行 `surface` 底（`control` 7，行的底左右各外扩 8，框仍与上面的文字左沿对齐），
/// 方框随行「手靠近」。设置页 `列表里的 agent`、网关抽屉里的模型勾选列表用它。
/// 一件事：我选了哪些；当场生效的布尔状态用开关，浮层里的多选用 `MenuItem kind="check"`
export function CheckRow({
  checked,
  onChange,
  children,
  icon,
  trailing,
  disabledReason,
  highlighted = false,
  size = "list",
  label,
}: CheckRowProps) {
  const disabled = disabledReason !== undefined;
  const classes = ["ss-checkrow", `ss-checkrow--${size}`];
  if (highlighted) classes.push("is-noted");
  return (
    <ReasonTip reason={disabledReason}>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={label}
        className={classes.join(" ")}
        data-checkrow={disabled ? undefined : ""}
        title={disabledReason}
        disabled={disabled}
        onClick={disabled ? undefined : () => onChange(!checked)}
      >
        <CheckMark on={checked} />
        {icon ? <span className="ss-checkrow__icon">{icon}</span> : null}
        <span className="ss-checkrow__name">{children}</span>
        {trailing ? <span className="ss-checkrow__trailing">{trailing}</span> : null}
      </button>
    </ReasonTip>
  );
}
