import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";

/// 提示框（DESIGN「提示框」，画板 States「提示框」）：文字确定性由它承载，
/// **原生 title 不作唯一说明**（系统灰底小框、约 1 秒延迟、位置不受控），只作 aria 兜底。
///
/// - 材质：黑窗白字 12/400，重点词 600（调用方用 <b> 包）；圆角 0、无阴影无箭头；
///   内边距 6 8；最大宽 240，超出换行
/// - 表格格子只一行「动词 · 快捷键」：`点一下开启 · 空格`
/// - 位置：锚在触发控件上，正上方 6、水平居中（≤16px 就近）；上方放不下才放下方，
///   居中出窗时对齐外侧边。格子的提示框允许盖住上一行邻格，只保护本格与本行
/// - 时机：表格内停留 700ms、表格外 400ms；在格与格之间移动时每格重新计时，所以
///   不追着鼠标；移开立即消失；键盘焦点到达同样计时
/// - 可访问性：内容同时作 `aria-describedby`，不依赖悬停

export const TIP_DELAY_MS = { table: 700, default: 400 } as const;

export interface TooltipProps {
  /// 一行「是什么」+ 可选一行「按下会怎样」；重点词用 <b>
  content: ReactNode;
  /// 快捷键：等宽 12 `ink-faint`，跟在 ` · ` 后面
  shortcut?: string;
  /// table：表格格子（700ms）；default：表格外的按钮、标签（400ms）
  context?: "table" | "default";
  /// 优先方向；放不下时自动翻到另一侧
  placement?: "top" | "bottom";
  /// 触发点本身不可聚焦（标签、记号）时给 true：包裹层接住键盘焦点
  focusable?: boolean;
  children: ReactElement;
}

type Align = "center" | "start" | "end";

export function Tooltip({
  content,
  shortcut,
  context = "default",
  placement = "top",
  focusable,
  children,
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"top" | "bottom">(placement);
  const [align, setAlign] = useState<Align>("center");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bubble = useRef<HTMLSpanElement>(null);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const arm = () => {
    clear();
    timer.current = setTimeout(() => setOpen(true), TIP_DELAY_MS[context]);
  };
  const close = () => {
    clear();
    setOpen(false);
    setSide(placement);
    setAlign("center");
  };

  useEffect(() => clear, []);

  // 出现那一刻量一次：上方出窗就翻到下方，左右出窗就对齐外侧边
  useLayoutEffect(() => {
    if (!open || !bubble.current) return;
    const r = bubble.current.getBoundingClientRect();
    if (side === "top" && r.top < 0) setSide("bottom");
    if (align === "center") {
      if (r.left < 0) setAlign("start");
      else if (r.right > window.innerWidth) setAlign("end");
    }
  }, [open, side, align]);

  const trigger =
    !focusable && isValidElement<{ "aria-describedby"?: string }>(children)
      ? cloneElement(children, { "aria-describedby": id })
      : children;

  const classes = ["ss-tip", `ss-tip--${side}`, `ss-tip--${align}`];
  if (open) classes.push("is-open");

  return (
    <span
      className="ss-tipwrap"
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={focusable ? id : undefined}
      onMouseEnter={arm}
      onMouseLeave={close}
      onFocus={arm}
      onBlur={close}
    >
      {trigger}
      <span ref={bubble} id={id} role="tooltip" className={classes.join(" ")}>
        {content}
        {shortcut ? (
          <>
            {" · "}
            <span className="ss-tip__key">{shortcut}</span>
          </>
        ) : null}
      </span>
    </span>
  );
}
