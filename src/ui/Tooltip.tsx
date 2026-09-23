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
/// - 表格格子只一行「动词」；快捷键（` · 空格`）只在键盘焦点唤起时写，鼠标悬停不写
///   （`.ss-tip__keyhint` 默认不显示，触发控件 `:focus-visible` 时才显示，见 ui.css）
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
  /// 按下之后到移开之前不再出：按下是决定，结果提示（批量提示条、行内一行）就出在触发控件旁，
  /// 提示框还挂着会把它盖住（产品负责人真机）
  const pressed = useRef(false);
  const bubble = useRef<HTMLSpanElement>(null);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const arm = () => {
    clear();
    if (pressed.current) return;
    timer.current = setTimeout(() => setOpen(true), TIP_DELAY_MS[context]);
  };
  const close = () => {
    clear();
    setOpen(false);
    setSide(placement);
    setAlign("center");
  };

  const press = () => {
    pressed.current = true;
    close();
  };
  const leave = () => {
    pressed.current = false;
    close();
  };

  useEffect(() => clear, []);

  // 出现那一刻量一次：上方出界就翻到下方，左右出窗就对齐外侧边。
  // 上界见 tipCeiling：顶栏在滚动容器外，往上弹会被容器裁掉；吸顶区也会盖住紧挨它的一行
  useLayoutEffect(() => {
    if (!open || !bubble.current) return;
    const r = bubble.current.getBoundingClientRect();
    if (side === "top" && r.top < tipCeiling(bubble.current)) setSide("bottom");
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
      onMouseLeave={leave}
      onPointerDown={press}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") press();
      }}
      onFocus={arm}
      onBlur={leave}
    >
      {trigger}
      <span ref={bubble} id={id} role="tooltip" className={classes.join(" ")}>
        {content}
        {shortcut ? (
          <span className="ss-tip__keyhint">
            {" · "}
            <span className="ss-tip__key">{shortcut}</span>
          </span>
        ) : null}
      </span>
    </span>
  );
}

/// 提示框可见区域的上界（视口坐标）：窗口顶，或最近一个会裁切内容的祖先（overflow 非 visible）的顶，
/// 再加上继承来的 CSS 变量 `--tip-ceiling`（px）——吸顶区（工具行、列头）的底边相对滚动容器顶的距离，
/// 由拥有吸顶区的组件写在自己根节点上。往上弹的提示框顶边高过它就翻到下方
export function tipCeiling(el: HTMLElement): number {
  const inset = parseFloat(getComputedStyle(el).getPropertyValue("--tip-ceiling")) || 0;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowY !== "visible") {
      return Math.max(0, p.getBoundingClientRect().top + inset);
    }
  }
  return Math.max(0, inset);
}
