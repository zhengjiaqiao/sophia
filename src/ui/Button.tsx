import type { ReactNode } from "react";
import { IconLeave, IconPlus } from "./icons.tsx";
import { ReasonTip } from "./Tooltip.tsx";

/// 按键（DESIGN「按钮」「控件有重量」，视觉 V4）。
///
/// 控件矩形（`control` 7），Barlow / 苹方 13 / 600，**原样大小写、字距 0**。键分三档，每档一个意思：
/// - `primary` 墨键＝这一面的主动作：`ink` 底、`face` 字、抬起 `raise-ink`。一个面里至多一个
///   （`添加 N 个来源` `保存` 确认框主动作）
/// - `default` 默认键＝在 Sophia 里做一件事：`paper` 面、抬起 `raise`（边由投影的 1px 环给，不画描边）。
///   其余一切能点的字都是它，**含 `取消` `稍后` `撤销` `只留这份` `清除筛选`**
/// - `quiet` 浅键＝离开 Sophia（2026-09-25）：静止是平贴的一小块 `surface` 键面、无边无投影、13 `ink-mute`、
///   高 24、左右 8；手靠近 `paper` + `raise`、字转 `ink`；按下 `raise-pressed` + 按压变形。
///   **末尾一律 10px `↗`，组件自动画**，调用方只写动词（`打开` `在访达中显示` `去发布页`）。
///   只给会跳到 Sophia 外面的动作；`size` 对它不起作用（固定 24）。在灰面板、抽屉里键面自动换 `paper`
///   - `inline`：**跟在一句话后面的**浅键（2026-10-06，`隐私说明 ↗`、发送失败后的 `在 GitHub 提 ↗`）静止不垫底、
///     不带左右留白，看上去就是字 + ↗；手靠近照旧浮起 `paper` + `raise`、字转 `ink`，按下照旧。命中区靠负外距
///     保持 24 高、左右各多 4，不撑高所在那一行。与句子、彼此之间的「 · 」由调用方写（流式文字里写 ` · `，
///     flex 排的行里放一个分隔记号）。单独放的浅键（灰面板、抽屉、空态）不给
///
/// 三个尺寸按所在那一行选，不按重要性选：`regular` 28（工具行）、`compact` 24（表格行、
/// 提示条、灰面板、纸窗、抽屉）、`row` 32（确认框与页面级提交）。
///
/// 重量：静止抬起一点；悬停手靠近，影子略重、不位移（墨键在内沿加 1px `ink-mute`）；按下 70ms 贴近机面
/// （影子收紧、下沉 0.5px 并微缩，默认键键面转 `surface`）；松开 180ms 弹簧回位；focus 外 2px 处 1px 环。
/// 全部在 ui.css。
///
/// 破坏性不涂红：分量由信息和按钮文案承担（`删到废纸篓`，不写「确定」）。
///
/// 禁用（给了 `disabledReason`）：平贴、实线 `hairline`、`ink-faint` 字，无投影、按下不动（D20）；
/// 自带原因提示框，悬停出、**按下（点击、空格、回车）当即出**，页面不必再包一层。
/// 外面再包的提示框（「重启生效」的说明）在禁用期间让给原因，同时只出一个。
///
/// 不写原生 `title`（悬停弹系统灰框，2026-10-06）：`title` 参数与图标键的名字都经 `Tooltip` 出。

export type ButtonVariant = "primary" | "default" | "quiet";
export type ButtonSize = "regular" | "compact" | "row";

interface ButtonBase {
  onClick?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /// 悬停说明（键上没写全的：`看改动 ↗` 去的地址），经提示框出；禁用期间让给原因
  title?: string;
  /// 图标在文字左边（`AddButton` 的 `+` 就是这么来的）
  icon?: ReactNode;
  /// 外面包的 Tooltip 经 cloneElement 挂上来的，转给 <button>
  "aria-describedby"?: string;
  /// 开关式的键（`管理来源` / `收起`）：展开着没有、展开的是哪一块
  ariaExpanded?: boolean;
  ariaControls?: string;
  /// 按下弹出一个浮层（`详情` 弹出原文浮层：`dialog`）
  ariaHasPopup?: "dialog" | "menu";
  /// 只对浅键：跟在一句话后面，静止不垫底、不带左右留白（见上）
  inline?: boolean;
}

/// 禁用必须同时给出原因（DESIGN：禁用必须同时说明原因，类型上强制）
type DisabledProps =
  { disabled: true; disabledReason: string } | { disabled?: false; disabledReason?: never };

/// 键一定有字；纯图标的工具走 `IconButton`（旧的无字写法已删，2026-09-25）。
/// `ariaLabel` 给读屏补全字面没说全的对象（`打开` → `在访达中显示 ~/code/CardBox`）
interface LabelProps {
  children: ReactNode;
  ariaLabel?: string;
}

export type ButtonProps = ButtonBase & DisabledProps & LabelProps;

export function Button(props: ButtonProps) {
  const {
    children,
    onClick,
    variant = "default",
    size = "regular",
    title,
    icon,
    ariaLabel,
    disabled,
    disabledReason,
    "aria-describedby": describedBy,
    ariaExpanded,
    ariaControls,
    ariaHasPopup,
    inline = false,
  } = props;

  const classes = ["ss-btn"];
  if (variant === "primary") classes.push("ss-btn--primary");
  // 浅键（离开 Sophia）固定 24 高：尺寸不叠加
  const leave = variant === "quiet";
  if (leave) classes.push("ss-btn--quiet");
  if (leave && inline) classes.push("ss-btn--inline");
  if (size === "compact" && !leave) classes.push("ss-btn--compact");
  if (size === "row" && !leave) classes.push("ss-btn--row");

  return (
    <ReasonTip reason={disabled ? disabledReason : undefined} tip={title}>
      <button
        type="button"
        className={classes.join(" ")}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-haspopup={ariaHasPopup}
        aria-expanded={ariaExpanded}
        aria-controls={ariaControls}
        disabled={disabled}
        onClick={disabled ? undefined : onClick}
      >
        {icon ? <span className="ss-btn__icon">{icon}</span> : null}
        {children}
        {leave ? <IconLeave className="ss-btn__external" /> : null}
      </button>
    </ReasonTip>
  );
}

export interface IconButtonProps {
  /// 16px 图形，用 icons.tsx 词表里的
  icon: ReactNode;
  /// **必填**：提示框的字，同时作 `aria-label`。图标不替代文案，文案挪到这里
  title: string;
  onClick?: () => void;
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
/// 悬停 `surface` 底（`control` 7）、图形转 `ink`。它是工具不是键：不抬起、按下不动。
/// 设置齿轮、提示条与侧栏的 × 都是它
export function IconButton({
  icon,
  title,
  onClick,
  disabledReason,
  tipPlacement,
  tipNowrap,
  "aria-describedby": describedBy,
}: IconButtonProps) {
  const classes = ["ss-iconbtn"];
  const disabled = Boolean(disabledReason);
  return (
    <ReasonTip reason={disabledReason} tip={title} placement={tipPlacement} nowrap={tipNowrap}>
      <button
        type="button"
        className={classes.join(" ")}
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
  /// 键上的字（名词）：`原件位置` `配置文件` `网关`
  noun: string;
  onClick?: () => void;
  /// 读屏名的整句（`添加 原件位置`）：由调用方按名词取整句键，这里不拼。键上 `+ 名词` 已说全，不另出提示框
  label: string;
  /// 给了就禁用，原因提示框悬停出、按下当即出（禁用必带原因）
  disabledReason?: string;
}

/// 「开始一个添加流程」只有这一种长相（DESIGN「添加只有两种长相」）：
/// 默认按钮（工具行 28）+ 12px `+`（词表里的 `IconPlus`）+ 名词。不是灰色文字链，也不是光秃秃的图标按钮
export function AddButton({ noun, onClick, label, disabledReason }: AddButtonProps) {
  const disabled = Boolean(disabledReason);
  return (
    <ReasonTip reason={disabledReason}>
      <button
        type="button"
        className="ss-btn ss-btn--add"
        aria-label={label}
        disabled={disabled}
        onClick={disabled ? undefined : onClick}
      >
        <IconPlus size={12} />
        {noun}
      </button>
    </ReasonTip>
  );
}
