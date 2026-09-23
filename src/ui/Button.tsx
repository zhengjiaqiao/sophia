import type { ReactNode } from "react";

/// 按钮（DESIGN「Components › 按钮」「控件有行程」，画板 States 的「控件四态」）。
///
/// 2px 描边矩形，Barlow / 苹方 13 / 600，**不大写、字距 0**（界面是中文，按钮几乎都含汉字）。
/// 四个变体：
/// - `primary` 主动作：`ink` 底 `canvas` 字。一个面里至多一个（`添加 N 个` `保存` 确认弹窗主动作）
/// - `default` 默认：1px `ink` 描边、透明底（`重启` `配置网关` `清除`）
/// - `link` 文字链：13 `ink-mute` 下划线，命中区高 24、左右各 6（视觉不变）——退路与次级
/// - `external` 离开 Sophia 的文字链：同上 + 10px `↗`（`打开目录` `去发布页`）
///
/// 三个尺寸按所在那一行选，不按重要性选：`regular` 28（工具行）、`compact` 24（表格行、
/// 提示条、行内待办条）、`row` 32（添加页底部那一行）。
///
/// 行程：hover 主动作键面内缩 1px 白描边、默认键铺 `surface`；pressed 下移 1px 并压扁 1px；
/// focus 外 2px 处 1px 环。全部在 ui.css，时长 120ms 机械缓动。
///
/// 破坏性不涂红：分量由信息和按钮文案承担（`删到废纸篓`，不写「确定」）。

export type ButtonVariant = "primary" | "default" | "link" | "external";
export type ButtonSize = "regular" | "compact" | "row";

interface ButtonBase {
  onClick?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  title?: string;
  /// 图标在文字左边（`AddButton` 的 `+` 就是这么来的）
  icon?: ReactNode;
  /// 放在实心黑面上：默认键变白描边键、文字链变 `ink-faint`
  onDark?: boolean;
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
  } = props;

  const classes = ["ss-btn"];
  if (variant === "primary") classes.push("ss-btn--primary");
  if (variant === "link") classes.push("ss-btn--link");
  if (variant === "external") classes.push("ss-btn--link", "ss-btn--external");
  if (size === "compact") classes.push("ss-btn--compact");
  if (size === "row") classes.push("ss-btn--row");
  if (onDark) classes.push("is-on-dark");
  if (icon && children === undefined) classes.push("ss-btn--icon");

  return (
    <button
      type="button"
      className={classes.join(" ")}
      // 禁用时把原因挂在 title 上，鼠标停住就知道为什么按不动
      title={disabled ? disabledReason : title}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
    >
      {icon ? <span className="ss-btn__icon">{icon}</span> : null}
      {variant === "external" ? <span className="ss-btn__text">{children}</span> : children}
      {variant === "external" ? <ExternalArrow /> : null}
    </button>
  );
}

export interface IconButtonProps {
  /// 16px 图形，用 icons.tsx 词表里的
  icon: ReactNode;
  /// **必填**：同时作 `aria-label`。图标不替代文案，文案挪到这里
  title: string;
  onClick?: () => void;
  onDark?: boolean;
  /// 给了就禁用，并作为悬停说明（禁用必带原因）
  disabledReason?: string;
}

/// 图标按钮（DESIGN「图标按钮」）：16px 图形、1.4 描边、28×28 命中区、无描边无底，
/// 悬停 `surface` 底 2px 圆角。顶栏的设置齿轮、提示条与侧栏的 × 都是它
export function IconButton({ icon, title, onClick, onDark, disabledReason }: IconButtonProps) {
  const classes = ["ss-iconbtn"];
  if (onDark) classes.push("is-on-dark");
  const disabled = Boolean(disabledReason);
  return (
    <button
      type="button"
      className={classes.join(" ")}
      title={disabled ? disabledReason : title}
      aria-label={title}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
    >
      <span className="ss-iconbtn__glyph">{icon}</span>
    </button>
  );
}

export interface AddButtonProps {
  /// 名词：`skill` `MCP` `项目` `来源` `网关`
  noun: string;
  onClick?: () => void;
  /// 默认「添加 <noun>」
  title?: string;
  size?: "regular" | "compact";
  /// 给了就禁用，并作为悬停说明（禁用必带原因）
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
  );
}
