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
  /// 紧跟名字的一句（12 `ink-mute`，禁用时 `ink-faint`，离名字 8）：安装页的 `直接读取，不用链接`、
  /// 写不过去的原因、`重启 Claude Desktop 后生效`。说后果与原因，所以**不截断**：名字至多让到一半宽，
  /// 这一句先折行（行高随之长高）；名字本身超过一半才截
  note?: ReactNode;
  /// 给了就不可选：整行平贴、字退到 `ink-faint`、不回应悬停；原因提示框悬停出、按下当即出
  disabledReason?: string;
  /// 这一行此刻被点名（取消勾选后行下浮起提示的那一会儿）：保持悬停底
  highlighted?: boolean;
  /// list（默认）：列表里一行 34（`--row-h`，模型列表）；grid：设置页的三列网格一格 36。框 → 图标 → 名字各 10。
  /// small：表单里附加的一个选项（跟在 12 / 13 号的标签与说明后面：安装页「同时加进 .gitignore」、网关表单的同步勾选）——
  /// 名字 13、框与字 8、行高 28、行宽随内容。DESIGN-components「勾选行 › 字号随场景」：名字与旁边的正文同一档
  size?: "list" | "grid" | "small";
  /// 读屏名；不给就用名字的文字
  label?: string;
  /// 外面包的 Tooltip 经 cloneElement 挂上来的（设置「生效范围」的项目格停上去给路径），转给行
  "aria-describedby"?: string;
}

/// 勾选行（DESIGN「勾选框」「命中区与视觉尺寸是两回事」）：**整行可点**的一项多选——左 14px 勾选框（只画状态）+
/// 可选图标 + 名字 + 可选行尾。悬停整行 `surface` 底（`control` 7，行的底左右各外扩 8，框仍与上面的文字左沿对齐），
/// 方框随行「手靠近」。设置页 `显示的 agent`、网关抽屉里的模型勾选列表用它。
/// 一件事：我选了哪些；当场生效的布尔状态用开关，浮层里的多选用 `MenuItem kind="check"`
export function CheckRow({
  checked,
  onChange,
  children,
  icon,
  trailing,
  note,
  disabledReason,
  highlighted = false,
  size = "list",
  label,
  "aria-describedby": describedBy,
}: CheckRowProps) {
  const disabled = disabledReason !== undefined;
  const classes = ["ss-checkrow", `ss-checkrow--${size}`];
  if (highlighted) classes.push("is-noted");
  if (note) classes.push("has-note");
  return (
    <ReasonTip reason={disabledReason}>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={label}
        aria-describedby={describedBy}
        className={classes.join(" ")}
        data-checkrow={disabled ? undefined : ""}
        disabled={disabled}
        onClick={disabled ? undefined : () => onChange(!checked)}
      >
        <CheckMark on={checked} />
        {icon ? <span className="ss-checkrow__icon">{icon}</span> : null}
        <span className="ss-checkrow__name">{children}</span>
        {note ? <span className="ss-checkrow__note">{note}</span> : null}
        {trailing ? <span className="ss-checkrow__trailing">{trailing}</span> : null}
      </button>
    </ReasonTip>
  );
}

/// 画出来的 14px 单选圈（同勾选框的尺寸与重量）：没选是 `paper` 面 + 1px `ink-faint` 圈，选中是 `ink` 实心 + 中间 6px `paper` 点。
/// 给整行是按钮的单选行用（`RadioRow`），读屏状态由行的 `role="radio"` + `aria-checked` 说
export function RadioMark({ on }: { on: boolean }) {
  return <span className={on ? "ss-radiomark is-on" : "ss-radiomark"} aria-hidden="true" />;
}

export interface RadioRowProps {
  checked: boolean;
  onSelect: () => void;
  /// 名字（body 15，放不下截断）
  children: ReactNode;
  /// 给了就不可选：同勾选行
  disabledReason?: string;
  /// list（默认）：一行 34；grid：一格 36（同 `CheckRow`）
  size?: "list" | "grid";
}

/// 单选行（2026-09-30，MCP「修改生效范围」：「所有项目（用户级）｜ 只在这些项目」）：**互斥的几项**，整行可点，
/// 左 14px 单选圈 + 名字，同勾选行的尺寸、悬停与禁用。放在 `role="radiogroup"`（带读屏名）的容器里。
/// 一件事：几项里选一项且必选其一——可多选的用勾选行（`CheckRow`），缩小列表范围的筛选用胶囊（`Chip`）
export function RadioRow({
  checked,
  onSelect,
  children,
  disabledReason,
  size = "list",
}: RadioRowProps) {
  const disabled = disabledReason !== undefined;
  return (
    <ReasonTip reason={disabledReason}>
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        className={`ss-checkrow ss-checkrow--${size} ss-radiorow`}
        data-checkrow={disabled ? undefined : ""}
        disabled={disabled}
        onClick={disabled || checked ? undefined : onSelect}
      >
        <RadioMark on={checked} />
        <span className="ss-checkrow__name">{children}</span>
      </button>
    </ReasonTip>
  );
}
