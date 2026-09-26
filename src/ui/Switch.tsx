import { useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { ReasonTip } from "./Tooltip.tsx";
import { IconDash, IconTick } from "./icons.tsx";
import { dragEnd, dragMove, dragStart, type SwitchDrag } from "./switchDrag.ts";

/// 开关（DESIGN「开关」「控件有重量」，物性之三）：一个**当场生效**的布尔状态，对象就是它所在的那一行。
/// 开关旁边不写「已启用」——它自己就是状态。不需要确认。
///
/// 实物滑动开关：`recess` 凹槽 + 抬起的纸面滑块（`raise`，面上无纹）。刻线印在槽上：
/// 开＝滑块在右、左边露出一道 8×2 的橙线；关＝滑块在左、盖住它。位置 + 刻线两重表达，
/// 色弱用户靠位置不丢信息。**开关旁不再点指示点**（紧挨开关的灯是同一件事说两遍）；橙只在这里和指示点上。
///
/// 两档，按角色选不按重要性选：
/// - `regular` 34×20（滑块 16、行程 14、刻线 8×2）：能力的总开关（Codex「第三方模型」、托盘）
/// - `compact` 28×16（滑块 12、行程 12、刻线 6×2）：行内的规则状态（来源管理页「以后新出现的自动加到」）
///
/// 物性做在重量、拖动与停靠上：悬停滑块影子略重；按住滑块贴近槽底（`raise-pressed` + 按压变形）；
/// 点一下或拖过去，滑块由阻尼弹簧停靠（200ms `--spring-slide`），刻条在判定后 120ms 换色。
/// 可拖：在槽或滑块上按住横移 > 3px 进入拖动，滑块 1:1 跟手；松手按速度或位置判定（`switchDrag.ts`）。
/// 落到对侧与点击走同一条路（`onChange`）；开关是受控的，父级不接受这次切换时滑块弹回原位。
/// 键盘（空格、回车）与读屏照旧是一次点击。
/// 不可用：槽透明 + `hairline` 环、滑块 `recess` 平贴无投影、刻线 `hairline`；拖不动。

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

/// 滑块行程读 CSS 的 `--travel`（ui.css 是尺寸的唯一来源）
function travelOf(el: Element): number {
  const v = parseFloat(getComputedStyle(el).getPropertyValue("--travel"));
  return Number.isFinite(v) ? v : 0;
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
  const disabled = Boolean(disabledReason);
  // 正在槽上按着：拖动状态（滑块跟手的位移）。ref 给事件处理读最新值，state 给渲染
  const [drag, setDragState] = useState<SwitchDrag | null>(null);
  const dragRef = useRef<SwitchDrag | null>(null);
  const setDrag = (d: SwitchDrag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  // 槽上的这一按已经在松手时判定过了：紧随其后的那次 click 不再切换一次
  const handled = useRef(false);

  const classes = ["ss-switch", `ss-switch--${size}`];
  if (checked) classes.push("is-on");
  if (drag?.dragging) classes.push("is-dragging");

  const onPointerDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    const start = dragStart(checked, travelOf(e.currentTarget), e.clientX, e.timeStamp, disabled);
    if (!start) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag(start);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const d = dragRef.current;
    if (d) setDrag(dragMove(d, e.clientX, e.timeStamp));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const next = dragEnd(d, e.clientX, e.timeStamp);
    setDrag(null);
    // 松手之后浏览器还会补一个 click（同一个任务里派发）；这一按已经判定过，别再切一次。
    // 拖出了按钮时不会有 click，下一轮任务就把标记清掉，免得吞掉之后的键盘操作
    handled.current = true;
    setTimeout(() => {
      handled.current = false;
    }, 0);
    if (next !== checked) onChange(next);
  };
  const onPointerCancel = () => setDrag(null);

  // 拖动中滑块跟手：内联位移盖过 is-on 的位置，松手后去掉，弹簧从松手处停靠到类名给的那一端
  const knobStyle = drag?.dragging
    ? ({ translate: `${drag.offset}px 0` } as CSSProperties)
    : undefined;

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
                if (handled.current) {
                  handled.current = false;
                  return;
                }
                onChange(!checked);
              }
        }
      >
        <span
          className="ss-switch__track"
          aria-hidden="true"
          onPointerDown={disabled ? undefined : onPointerDown}
          onPointerMove={disabled ? undefined : onPointerMove}
          onPointerUp={disabled ? undefined : onPointerUp}
          onPointerCancel={disabled ? undefined : onPointerCancel}
        >
          <span className="ss-switch__scribe" />
          <span className="ss-switch__knob" style={knobStyle} />
        </span>
      </button>
    </ReasonTip>
  );
}

export interface IndicatorProps {
  /// 读屏名。不给就当装饰（旁边的名字已经说了状态）
  label?: string;
}

/// 指示点（DESIGN「开关 › 指示点」，裁决「橙的两种形态」）：6px `accent` 圆点，外一圈 2px 同色 14% 的
/// 灯罩环（`--accent-halo`，平的色环，不模糊、不发光）。橙的**含义**只有一个「开着 / 在生效」，
/// 形态有两种：开关刻线与这颗点。**只在看不到开关的地方出现**：侧栏 agent 名后（这个 agent 上有能力开着）。
/// 关着不画——没有灰点，是否渲染由调用方的条件决定
export function Indicator({ label }: IndicatorProps) {
  // `is-on` 留在类名上：只剩这一态，样式不靠它；页面与测试据它认「开着的灯」
  return label ? (
    <span className="ss-indicator is-on" role="img" aria-label={label} title={label} />
  ) : (
    <span className="ss-indicator is-on" aria-hidden="true" />
  );
}

export interface CheckboxProps {
  /// `"mixed"`＝半选（全选框在部分选中时）
  checked: boolean | "mixed";
  onChange?: (next: boolean) => void;
  /// 读屏名，**必填**：视觉上勾选框挨着的名字常常不在同一个元素里
  label: string;
  /// 给了就是「不可选」：`hairline` 边、透明底，原因提示框悬停出、按下当即出（已添加的行）
  disabledReason?: string;
}

/// 勾选框（DESIGN「勾选框」「命中区与视觉尺寸是两回事」）：14 方、`mark` 4 圆角（裁决：14，同 macOS）——
/// 方＝我选的，开关＝它开着。未勾＝平贴的 `paper` 白面 + 1px `ink-faint` 内环；手靠近＝`raise-hover` 抬起；
/// 勾上＝墨底白勾（`ink` 底、中心 10px `face` 对勾）；半选＝同墨底 + 8×2 `face` 短横。
/// 视觉 14，命中区用伪元素撑到 24，不动 border；全应用只有这一个尺寸。
///
/// 行悬停钩子：列表 / 表格的行元素加 `data-checkrow`，悬停这一行时它里面的勾选框进「手靠近」态
/// （ui.css `[data-checkrow]:hover .ss-checkbox`），页面不必各写一份覆盖
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

/// 勾选框里的记号：勾上＝统一对勾 `IconTick`（10px、1.8），半选＝8×2 短横 `IconDash`，没勾＝不画。
/// `Checkbox` 与画出来的方框 `CheckMark`（CheckRow.tsx）共用这一份，同一个记号在全应用里只有一个画法。
/// 不在公开面上：页面用 `Checkbox`，整行是按钮的列表用 `CheckRow` / `CheckMark`
export function CheckboxGlyph({ checked }: { checked: boolean | "mixed" }) {
  if (checked === false) return null;
  if (checked === true) return <IconTick />;
  return <IconDash />;
}
