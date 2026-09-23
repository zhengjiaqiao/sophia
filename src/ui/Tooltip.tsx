import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { keyboardModality } from "../inputModality.ts";
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
/// - 按下：能点的控件按下即收起（按下是决定，结果提示出在旁边，提示框挂着会盖住它）；
///   **点了做不了的控件**（`explain`）按下当即弹出、不等延时，停约 3 秒，再按一下收起
///   ——同格子的「点了做不了的格子，立刻说明」（Matrix 的 cellPress / PINNED_TIP_MS）
/// - 嵌套：外层提示框包着的控件自己也有提示框（禁用原因）时，指针或焦点在里层上只出里层那一个
/// - **只说屏幕上没说的**：内容只是触发文字的完整值时用 `TruncTip`——悬停 / 焦点那一刻量一次，
///   文字真被截断才出，完整显示着就不出（DESIGN「提示框只说屏幕上没说的」）
/// - 可访问性：内容同时作 `aria-describedby`，不依赖悬停

export const TIP_DELAY_MS = { table: 700, default: 400 } as const;
/// 点了做不了的控件（或格子）按下后，说明停留的时长
export const PINNED_TIP_MS = 3000;

/// 提示框此刻的样子：开着没有、是不是按下钉出来的、按过之后移开之前还出不出
export interface TipState {
  open: boolean;
  /// 按下「做不了的控件」当即弹出的：停 PINNED_TIP_MS，再按一下收起
  pinned: boolean;
  /// 按下之后到移开之前不再出：按下是决定，结果提示（批量提示条、行内一行）就出在触发控件旁，
  /// 提示框还挂着会把它盖住（产品负责人真机）
  pressed: boolean;
}

export const TIP_IDLE: TipState = { open: false, pinned: false, pressed: false };

/// delay：悬停 / 焦点停够了；press：按下（点击、空格、回车）；expire：钉出来的停够了；
/// yield：指针或焦点进了里层提示框，让给它；leave：移开、失焦
export type TipEvent = "delay" | "press" | "expire" | "yield" | "leave";

/// 提示框的状态迁移（纯函数，组件只负责计时和派发）。
/// `explain`：触发控件点了做不了（禁用的控件）；`yielded`：指针或焦点正落在里层提示框上，让给它
export function nextTip(
  s: TipState,
  event: TipEvent,
  { explain, yielded }: { explain: boolean; yielded: boolean },
): TipState {
  if (event === "leave") return TIP_IDLE;
  if (yielded) return { open: false, pinned: false, pressed: s.pressed || event === "press" };
  switch (event) {
    case "delay":
      return s.pressed || s.open ? s : { ...s, open: true };
    case "press":
      // 能点的控件：按下即收起。做不了的：没钉着就当即钉出来（悬停已出的也钉住，不收），钉着就收起
      if (!explain || s.pinned) return { open: false, pinned: false, pressed: true };
      return { open: true, pinned: true, pressed: false };
    case "expire":
      return s.pinned ? { open: false, pinned: false, pressed: true } : s;
    case "yield":
      return { open: false, pinned: false, pressed: s.pressed };
  }
}

/// 里层提示框占住外层：指针或焦点进里层时 claim，离开时 release
interface TipNest {
  claim: () => void;
  release: () => void;
}
const NestContext = createContext<TipNest | null>(null);

export interface TooltipProps {
  /// 一行「是什么」+ 可选一行「按下会怎样」；重点词用 <b>。
  /// 空（undefined / null / ""）＝此刻没有提示框：包层不占盒（display: contents），
  /// 触发控件原地不动——给了又撤的场合（禁用原因）不必换一棵树，控件不重挂
  content: ReactNode;
  /// 快捷键：等宽 12 `ink-faint`，跟在 ` · ` 后面
  shortcut?: string;
  /// table：表格格子（700ms）；default：表格外的按钮、标签（400ms）
  context?: "table" | "default";
  /// 优先方向；放不下时自动翻到另一侧
  placement?: "top" | "bottom";
  /// 触发点本身不可聚焦（标签、记号、禁用的控件）时给 true：包裹层接住键盘焦点
  focusable?: boolean;
  /// 触发控件点了做不了（禁用）：按下当即弹出说明、不等延时，再按收起；
  /// 包层里的原生禁用控件不吃指针（ui.css），悬停和按下都落在包层上
  explain?: boolean;
  /// 内容就是触发文字的完整值：只在它此刻真被截断时出（见 `TruncTip`）
  truncated?: boolean;
  children: ReactElement;
}

/// 包层里有没有哪一段文字此刻被截断（横向溢出）；行内元素量不出宽度，不算
export function isClipped(root: Element | null): boolean {
  if (!root) return false;
  const all = [root, ...Array.from(root.querySelectorAll("*"))];
  return all.some((el) => el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1);
}

type Align = "center" | "start" | "end";

/// 这次焦点是不是用户用键盘带来的：看本窗口最近一次操作是按键还是指针（inputModality）。
/// 不用浏览器的 `:focus-visible`——窗口刚从托盘、原生对话框切回来时，它会把程序放的焦点猜成键盘焦点
function isKeyboardFocus(): boolean {
  return keyboardModality();
}

export function Tooltip({
  content,
  shortcut,
  context = "default",
  placement = "top",
  focusable,
  explain = false,
  truncated = false,
  children,
}: TooltipProps) {
  const id = useId();
  const idle = content === undefined || content === null || content === "";
  const [tip, setTip] = useState<TipState>(TIP_IDLE);
  const state = useRef(tip);
  const [side, setSide] = useState<"top" | "bottom">(placement);
  const [align, setAlign] = useState<Align>("center");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bubble = useRef<HTMLSpanElement>(null);

  // 嵌套：外层给的 nest 用来占住它；自己给里层的 nest 记着被占了几层
  const outer = useContext(NestContext);
  const claimedOuter = useRef(false);
  const yields = useRef(0);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const dispatch = (event: TipEvent) => {
    const next = nextTip(state.current, event, { explain, yielded: yields.current > 0 });
    if (next === state.current) return;
    state.current = next;
    setTip(next);
    if (!next.open) {
      setSide(placement);
      setAlign("center");
    }
  };

  // 给里层的 nest 要稳定（它是 Provider 的值），通过 ref 调到这一帧的 dispatch
  const latest = useRef(dispatch);
  latest.current = dispatch;
  const [own] = useState<TipNest>(() => ({
    claim: () => {
      yields.current += 1;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      latest.current("yield");
    },
    release: () => {
      yields.current = Math.max(0, yields.current - 1);
    },
  }));

  const claim = () => {
    if (outer && !claimedOuter.current) {
      claimedOuter.current = true;
      outer.claim();
    }
  };
  const release = () => {
    if (outer && claimedOuter.current) {
      claimedOuter.current = false;
      outer.release();
    }
  };

  const arm = () => {
    // 只给完整值的：文字完整显示着就不出（悬停那一刻量一次）
    if (truncated && !isClipped(wrapper.current)) return;
    claim();
    // 已开着（悬停出的、按下钉出的）不重新计时：点一下包层也会让它得到焦点，别把钉住的计时冲掉
    if (state.current.pressed || state.current.open) return;
    clear();
    timer.current = setTimeout(() => dispatch("delay"), TIP_DELAY_MS[context]);
  };
  const press = () => {
    clear();
    dispatch("press");
    if (state.current.pinned) timer.current = setTimeout(() => dispatch("expire"), PINNED_TIP_MS);
  };
  const leave = () => {
    clear();
    release();
    dispatch("leave");
  };

  const wrapper = useRef<HTMLSpanElement>(null);
  // 内容撤掉（禁用解除）时：停计时、收起、把外层还回去。
  // 内容给上（刚禁用）时指针正停在上面：外层先让出来（禁用原因优先），自己不计时——
  // 多半是刚按下它才忙起来的，按下之后移开之前不出提示框
  useEffect(() => {
    if (idle) {
      clear();
      release();
      state.current = TIP_IDLE;
      setTip(TIP_IDLE);
    } else if (wrapper.current?.matches(":hover")) {
      claim();
    }
  }, [idle]);
  useEffect(
    () => () => {
      clear();
      release();
    },
    [],
  );

  // 出现那一刻量一次：上方出界就翻到下方，左右出窗就对齐外侧边。
  // 上界见 tipCeiling：顶栏在滚动容器外，往上弹会被容器裁掉；吸顶区也会盖住紧挨它的一行
  useLayoutEffect(() => {
    if (!tip.open || !bubble.current) return;
    const r = bubble.current.getBoundingClientRect();
    if (side === "top" && r.top < tipCeiling(bubble.current)) setSide("bottom");
    if (align === "center") {
      if (r.left < 0) setAlign("start");
      else if (r.right > window.innerWidth) setAlign("end");
    }
  }, [tip.open, side, align]);

  const wrapFocus = focusable && !idle;
  const trigger =
    !wrapFocus && isValidElement<{ "aria-describedby"?: string }>(children)
      ? cloneElement(children, { "aria-describedby": idle || truncated ? undefined : id })
      : children;

  const classes = ["ss-tip", `ss-tip--${side}`, `ss-tip--${align}`];
  if (tip.open) classes.push("is-open");
  const wrap = ["ss-tipwrap"];
  if (idle) wrap.push("is-idle");
  else if (explain) wrap.push("is-explain");

  return (
    // 没有内容时把外层的 nest 原样传下去：里层要占的是真正会出提示框的那一层
    <NestContext.Provider value={idle ? outer : own}>
      <span
        ref={wrapper}
        className={wrap.join(" ")}
        tabIndex={wrapFocus ? 0 : undefined}
        aria-describedby={wrapFocus ? id : undefined}
        onMouseEnter={idle ? undefined : arm}
        onMouseLeave={idle ? undefined : leave}
        onPointerDown={idle ? undefined : press}
        onKeyDown={
          idle
            ? undefined
            : (e) => {
                if (e.key !== " " && e.key !== "Enter") return;
                // 做不了的控件：空格不滚页、回车不触发什么，只出说明
                if (explain) e.preventDefault();
                press();
              }
        }
        // 只有用户用键盘带来的焦点才弹（inputModality）：从二级页返回把焦点还给入口键、面板弹出时
        // 把焦点放进来，这些是程序放的焦点，用户没在看这颗键，弹出来就是无端冒提示（产品负责人）
        onFocus={
          idle
            ? undefined
            : () => {
                if (isKeyboardFocus()) arm();
              }
        }
        onBlur={idle ? undefined : leave}
      >
        {trigger}
        {idle ? null : (
          <span ref={bubble} id={id} role="tooltip" className={classes.join(" ")}>
            {content}
            {shortcut ? (
              <span className="ss-tip__keyhint">
                {" · "}
                <span className="ss-tip__key">{shortcut}</span>
              </span>
            ) : null}
          </span>
        )}
      </span>
    </NestContext.Provider>
  );
}

/// 禁用控件的原因（DESIGN「所有点了做不了的控件，按下当即说明原因」）：`Button` / `IconButton` /
/// `AddButton` / `Switch` / `Checkbox` 自己套这一层，页面不再各包一层。
/// 有原因：包层接住悬停、按下和键盘焦点（空格 / 回车），按下当即弹出；没原因：包层不占盒。
/// 两种情况是同一棵树，控件禁用 / 解禁时不重挂（焦点、开关的过冲动画都不断）
export function ReasonTip({
  reason,
  placement,
  children,
}: {
  reason: string | undefined;
  placement?: "top" | "bottom";
  children: ReactElement;
}) {
  return (
    <Tooltip content={reason} placement={placement} focusable explain>
      {children}
    </Tooltip>
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

/// 「截断才提示」（DESIGN「提示框只说屏幕上没说的」）：内容只是触发文字的完整值（网关地址、
/// 放不下的一行）时用它。悬停 / 键盘焦点那一刻量一次触发文字是否溢出，真被截断才出提示框；
/// 完整显示着就什么都不出。读屏不挂 `aria-describedby`——截断只是视觉的，文字本身读得全
export function TruncTip(props: Omit<TooltipProps, "truncated" | "explain">) {
  return <Tooltip {...props} truncated />;
}
