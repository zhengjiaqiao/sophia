import type { ReactNode } from "react";
import { ReasonTip } from "./Tooltip.tsx";

/// 按键（DESIGN「按钮」「控件有行程」，视觉 V4）。
///
/// 控件矩形（`control` 7），Barlow / 苹方 13 / 600，**原样大小写、字距 0**。键的阶梯（D14）：
/// - `primary` 墨键：`ink` 底、`face` 字、1px `ink-edge` 底边。一个面里至多一个（`添加 N 个` `保存` 确认框主动作）
/// - `default` 默认键：`paper` 面、1px `ctl-border` 边、1px `ctl-edge` 底边（`重启` `配置网关` `清除` 确认框的 `取消`）
/// - `quiet` 安静键：无底无边、13 `ink-mute`；悬停出 `surface` 圆角带，按下下沉 1px。
///   取代应用内的下划线文字链（`撤销` `稍后` `编辑` `只留这份` `检查更新`），命中区高 24、左右各 6（视觉不变）
/// - `external` 离开 Sophia 的链接（`button-link`）：13 `ink-mute` 下划线 + 10px `↗`（`打开 ↗` `在访达中显示 ↗`）。
///   全应用只有它带下划线、只有它用手形光标
///
/// 三个尺寸按所在那一行选，不按重要性选：`regular` 28（工具行）、`compact` 24（表格行、
/// 提示条、灰面板）、`row` 32（确认框与页面级提交）。
///
/// 行程：能按的键有 1px 底边；hover 默认键描边转 `ctl-edge`、墨键内沿加 1px `ink-mute`；
/// pressed 底边消失、下沉 1px（默认键键面转 `surface` 并内凹）；focus 外 2px 处 1px 环。全部在 ui.css。
///
/// 破坏性不涂红：分量由信息和按钮文案承担（`删到废纸篓`，不写「确定」）。
///
/// 禁用（给了 `disabledReason`）：平贴、实线 `hairline`、`ink-faint` 字，无底边无行程（D20）；
/// 自带原因提示框，悬停出、**按下（点击、空格、回车）当即出**，页面不必再包一层。
/// 外面再包的提示框（「重启生效」的说明）在禁用期间让给原因，同时只出一个。

export type ButtonVariant = "primary" | "default" | "quiet" | "external";
export type ButtonSize = "regular" | "compact" | "row";

interface ButtonBase {
  onClick?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  title?: string;
  /// 图标在文字左边（`AddButton` 的 `+` 就是这么来的）
  icon?: ReactNode;
  /// 放在墨窗上：默认键变浅描边键（1px `face` 边与字、无行程），安静键变 `ctl-border` 字
  onDark?: boolean;
  /// 外面包的 Tooltip 经 cloneElement 挂上来的，转给 <button>
  "aria-describedby"?: string;
}

/// 禁用必须同时给出原因（DESIGN：禁用必须同时给 title 说明原因，类型上强制）
type DisabledProps =
  { disabled: true; disabledReason: string } | { disabled?: false; disabledReason?: never };

/// 纯图标按钮请用 `IconButton`。这里保留无文字的写法只为还没改完的页面：
/// 没有 children 时 `ariaLabel` 与 `title` 都是必填
type LabelProps =
  | { children: ReactNode; ariaLabel?: string }
  | { children?: never; icon: ReactNode; ariaLabel: string; title: string };

export type ButtonProps = ButtonBase & DisabledProps & LabelProps;

/// 10px 的 ↗：1.4 描边、`currentColor`、左间距 3
function ExternalArrow() {
  return (
    <svg
      className="ss-btn__external"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 7l4-4M3.6 3H7v3.4" />
    </svg>
  );
}

export function Button(props: ButtonProps) {
  const {
    children,
    onClick,
    variant = "default",
    size = "regular",
    title,
    icon,
    ariaLabel,
    onDark,
    disabled,
    disabledReason,
    "aria-describedby": describedBy,
  } = props;

  const classes = ["ss-btn"];
  if (variant === "primary") classes.push("ss-btn--primary");
  if (variant === "quiet") classes.push("ss-btn--quiet");
  if (variant === "external") classes.push("ss-btn--external");
  if (size === "compact") classes.push("ss-btn--compact");
  if (size === "row") classes.push("ss-btn--row");
  if (onDark) classes.push("is-on-dark");
  if (icon && children === undefined) classes.push("ss-btn--icon");

  return (
    <ReasonTip reason={disabled ? disabledReason : undefined}>
      <button
        type="button"
        className={classes.join(" ")}
        // 禁用原因同时挂在 title 上，作 aria 兜底
        title={disabled ? disabledReason : title}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={disabled ? undefined : onClick}
      >
        {icon ? <span className="ss-btn__icon">{icon}</span> : null}
        {variant === "external" ? <span className="ss-btn__text">{children}</span> : children}
        {variant === "external" ? <ExternalArrow /> : null}
      </button>
    </ReasonTip>
  );
}

export interface IconButtonProps {
  /// 16px 图形，用 icons.tsx 词表里的
  icon: ReactNode;
  /// **必填**：同时作 `aria-label`。图标不替代文案，文案挪到这里
  title: string;
  onClick?: () => void;
  onDark?: boolean;
  /// 给了就禁用，原因提示框悬停出、按下当即出（禁用必带原因）
  disabledReason?: string;
  /// 禁用原因提示框的优先方向（默认上方）
  tipPlacement?: "top" | "bottom";
  /// 禁用原因按画板单行显示，不受 240 上限折行（来源管理页行尾的 ×）
  tipNowrap?: boolean;
  /// 外面包的 Tooltip 经 cloneElement 挂上来的，转给 <button>
  "aria-describedby"?: string;
}

/// 图标按钮（DESIGN「图标按钮」）：16px 图形、1.4 描边、28×28 命中区、无描边无底，图形 `ink-mute`；
/// 悬停 `surface` 底（`control` 7）、图形转 `ink`。它是工具不是键，没有行程。
/// 设置齿轮、提示条与侧栏的 × 都是它
export function IconButton({
  icon,
  title,
  onClick,
  onDark,
  disabledReason,
  tipPlacement,
  tipNowrap,
  "aria-describedby": describedBy,
}: IconButtonProps) {
  const classes = ["ss-iconbtn"];
  if (onDark) classes.push("is-on-dark");
  const disabled = Boolean(disabledReason);
  return (
    <ReasonTip reason={disabledReason} placement={tipPlacement} nowrap={tipNowrap}>
      <button
        type="button"
        className={classes.join(" ")}
        title={disabled ? disabledReason : title}
        aria-label={title}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={disabled ? undefined : onClick}
      >
        <span className="ss-iconbtn__glyph">{icon}</span>
      </button>
    </ReasonTip>
  );
}

export interface AddButtonProps {
  /// 名词：`skill` `MCP` `项目` `来源` `网关`
  noun: string;
  onClick?: () => void;
  /// 默认「添加 <noun>」
  title?: string;
  size?: "regular" | "compact";
  /// 给了就禁用，原因提示框悬停出、按下当即出（禁用必带原因）
  disabledReason?: string;
}

/// 「开始一个添加流程」只有这一种长相（DESIGN「添加只有两种长相」）：
/// 默认按钮 + 12px `+` + 名词。不是灰色文字链，也不是光秃秃的图标按钮
export function AddButton({
  noun,
  onClick,
  title,
  size = "regular",
  disabledReason,
}: AddButtonProps) {
  const plus = (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 1.5v9M1.5 6h9" />
    </svg>
  );
  const classes = ["ss-btn", "ss-btn--add"];
  if (size === "compact") classes.push("ss-btn--compact");
  const disabled = Boolean(disabledReason);
  return (
    <ReasonTip reason={disabledReason}>
      <button
        type="button"
        className={classes.join(" ")}
        title={disabled ? disabledReason : (title ?? `添加 ${noun}`)}
        aria-label={title ?? `添加 ${noun}`}
        disabled={disabled}
        onClick={disabled ? undefined : onClick}
      >
        {plus}
        {noun}
      </button>
    </ReasonTip>
  );
}
