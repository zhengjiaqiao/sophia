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
import { createPortal } from "react-dom";
import { keyboardModality } from "../inputModality.ts";
import { placeTip, type ToastAlign } from "../layerPlace.ts";
import type { ReactElement, ReactNode } from "react";

/// 提示框（DESIGN「提示框」，画板 States「提示框」）：文字确定性由它承载，
/// **原生 title 不作唯一说明**（系统灰底小框、约 1 秒延迟、位置不受控），只作 aria 兜底。
///
/// - 材质：墨窗（全应用唯一的墨色浮窗）白字 12/400，重点词 600（调用方用 <b> 包）；`control` 7 圆角、
///   浮层投影、无箭头；内边距 6 8；最大宽 240，超出换行
/// - 表格格子只一行「动词」；快捷键（` · 空格`）只在键盘焦点唤起时写，鼠标悬停不写
///   （`.ss-tip__keyhint` 默认不显示，触发控件 `:focus-visible` 时才显示，见 ui.css）
/// - 位置：锚在触发控件上，正上方 6、水平居中（≤16px 就近）；上方放不下才放下方，
///   居中出窗时对齐外侧边，夹在窗口四边 16 之内（`placeTip`）。格子的提示框允许盖住上一行邻格，
///   只保护本格与本行
/// - 图层：打开时气泡经 portal 挂到 body、fixed 定位，出现那一刻按触发控件的屏幕位置算一次——
///   不被滚动容器裁掉、不被侧栏和吸顶区盖住（z 50，确认弹窗 40 之上，弹窗里的提示框照样看得见）。
///   打开期间任何滚动、改窗口大小都当即收起，不跟着漂。收着时气泡留在包层里（display: none），
///   `aria-describedby` 始终指得到它
/// - 时机：表格内停留 700ms、表格外 400ms；在格与格之间移动时每格重新计时，所以
///   不追着鼠标；移开立即消失；键盘焦点到达同样计时
/// - 按下：能点的控件按下即收起（按下是决定，结果提示出在旁边，提示框挂着会盖住它）；
///   **点了做不了的控件**（`explain`）按下当即弹出、不等延时，停约 3 秒，再按一下收起
///   ——同格子的「点了做不了的格子，立刻说明」（Matrix 的 cellPress / PINNED_TIP_MS）
/// - 嵌套：外层提示框包着的控件自己也有提示框（禁用原因）时，指针或焦点在里层上只出里层那一个
/// - **只说屏幕上没说的**：内容只是触发文字的完整值时用 `TruncTip`——悬停 / 焦点那一刻量一次，
///   文字真被截断才出，完整显示着就不出（DESIGN「提示框只说屏幕上没说的」）
/// - 可访问性：内容同时作 `aria-describedby`，不依赖悬停
/// - **表格格子**（`context="table"` + `open` + `ceiling`）：整张表同一时刻只出一个格子的提示框，何时出由表自己数
///   （每进一格重新计 700ms、按下做不了的格子当即钉出 3 秒）——给 `open` 就是受控，组件只管画、放、滚动时收起；
///   `ceiling`：往上弹会钻到吸顶区（工具行、列头，`--tip-ceiling`）底下时翻到下方。快捷键同样只在键盘焦点唤起时写

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
  /// 水平对齐：默认居中于触发控件；`end` 右沿对齐、向左展开（行尾的键）。出窗时自动改对齐外侧边
  align?: ToastAlign;
  /// 这一句按画板单行显示，不受 240 上限折行；窗口放不下时才折行
  nowrap?: boolean;
  /// 触发点本身不可聚焦（标签、记号、禁用的控件）时给 true：包裹层接住键盘焦点
  focusable?: boolean;
  /// 触发控件点了做不了（禁用）：按下当即弹出说明、不等延时，再按收起；
  /// 包层里的原生禁用控件不吃指针（ui.css），悬停和按下都落在包层上
  explain?: boolean;
  /// 内容就是触发文字的完整值：只在它此刻真被截断时出（见 `TruncTip`）
  truncated?: boolean;
  /// 受控：给了就由调用方决定开没开（表格格子，见上），组件不再自己计时、不接悬停与按下
  open?: boolean;
  /// 往上弹时不钻到吸顶区底下（`tipCeiling`：最近的滚动容器顶 + 继承来的 `--tip-ceiling`），钻到就翻到下方
  ceiling?: boolean;
  children: ReactElement;
}

/// 包层里有没有哪一段文字此刻被截断（横向溢出）；行内元素量不出宽度，不算
export function isClipped(root: Element | null): boolean {
  if (!root) return false;
  const all = [root, ...Array.from(root.querySelectorAll("*"))];
  return all.some((el) => el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1);
}

/// 打开后算好的位置；`keyed`：这次是键盘焦点唤起的，写快捷键
type TipPos = { top: number; left: number; side: "top" | "bottom"; keyed: boolean };

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
  align = "center",
  nowrap = false,
  focusable,
  explain = false,
  truncated = false,
  open,
  ceiling = false,
  children,
}: TooltipProps) {
  const id = useId();
  const idle = content === undefined || content === null || content === "";
  const controlled = open !== undefined;
  const [tip, setTip] = useState<TipState>(TIP_IDLE);
  // 受控时打开期间滚动 / 改窗口大小：先收起，等调用方把 open 落下再说
  const [suppressed, setSuppressed] = useState(false);
  const state = useRef(tip);
  const [pos, setPos] = useState<TipPos | null>(null);
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
    if (!next.open) setPos(null);
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
  /// 此刻画不画：受控看 open，否则看自己的状态
  const shown = controlled ? Boolean(open) && !idle && !suppressed : tip.open;
  useEffect(() => {
    if (!open) setSuppressed(false);
  }, [open]);
  useEffect(() => {
    if (!shown) setPos(null);
  }, [shown]);
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

  // 出现那一刻量一次（气泡已挂进 body、先藏着）：按触发控件此刻的屏幕位置放，之后不重算。
  // 快捷键只给键盘焦点唤起的：先把类挂上再量，量到的宽里含 ` · 空格`
  useLayoutEffect(() => {
    const el = bubble.current;
    const w = wrapper.current;
    if (!shown || pos || !el || !w) return;
    const keyed = w.matches(":focus-visible") || w.querySelector(":focus-visible") !== null;
    el.classList.toggle("is-keyed", keyed);
    const r = w.getBoundingClientRect();
    const anchor = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const view = { width: window.innerWidth, height: window.innerHeight };
    let p = placeTip(anchor, size, view, {
      prefer: placement === "top" ? "above" : "below",
      align,
    });
    // 往上弹会钻到吸顶区底下：翻到下方
    if (ceiling && p.side === "above" && p.top < tipCeiling(w)) {
      p = placeTip(anchor, size, view, { prefer: "below", align });
    }
    setPos({ top: p.top, left: p.left, side: p.side === "above" ? "top" : "bottom", keyed });
  }, [shown, pos, placement, align, ceiling]);

  // 打开期间滚动（任何一层滚动容器）或改窗口大小：当即收起，不让它离开触发控件漂在原处
  useEffect(() => {
    if (!shown) return;
    const close = () => {
      if (controlled) {
        setSuppressed(true);
        return;
      }
      clear();
      latest.current("leave");
    };
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [shown, controlled]);

  const wrapFocus = focusable && !idle;
  // 没有内容、只给完整值的：不碰触发控件的 aria-describedby——外层提示框经 Button 等转进来的描述
  // 要留着（禁用原因撤了的里层包层曾把它清成 undefined，外层的说明读屏就读不到了）
  const trigger =
    !wrapFocus && !idle && !truncated && isValidElement<{ "aria-describedby"?: string }>(children)
      ? cloneElement(children, { "aria-describedby": id })
      : children;

  // 打开时挂到 body（服务端渲染没有 document，就地画）
  const floating = shown && typeof document !== "undefined";
  const classes = ["ss-tip", `ss-tip--${pos?.side ?? placement}`];
  if (nowrap) classes.push("ss-tip--nowrap");
  if (shown) classes.push("is-open");
  if (floating) classes.push("is-floating");
  if (pos?.keyed) classes.push("is-keyed");
  // 受控时悬停、按下、焦点都归调用方：包层只是个锚
  const passive = idle || controlled;
  const wrap = ["ss-tipwrap"];
  if (idle) wrap.push("is-idle");
  else if (explain) wrap.push("is-explain");

  const bubbleEl = (
    <span
      ref={bubble}
      id={id}
      role="tooltip"
      className={classes.join(" ")}
      style={
        floating ? (pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }) : undefined
      }
    >
      {content}
      {shortcut ? (
        <span className="ss-tip__keyhint">
          {" · "}
          <span className="ss-tip__key">{shortcut}</span>
        </span>
      ) : null}
    </span>
  );

  return (
    // 没有内容时把外层的 nest 原样传下去：里层要占的是真正会出提示框的那一层
    <NestContext.Provider value={idle ? outer : own}>
      <span
        ref={wrapper}
        className={wrap.join(" ")}
        tabIndex={wrapFocus ? 0 : undefined}
        aria-describedby={wrapFocus ? id : undefined}
        onMouseEnter={passive ? undefined : arm}
        onMouseLeave={passive ? undefined : leave}
        onPointerDown={passive ? undefined : press}
        onKeyDown={
          passive
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
          passive
            ? undefined
            : () => {
                if (isKeyboardFocus()) arm();
              }
        }
        onBlur={passive ? undefined : leave}
      >
        {trigger}
        {idle ? null : floating ? createPortal(bubbleEl, document.body) : bubbleEl}
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
  nowrap,
  children,
}: {
  reason: string | undefined;
  placement?: "top" | "bottom";
  nowrap?: boolean;
  children: ReactElement;
}) {
  return (
    <Tooltip content={reason} placement={placement} nowrap={nowrap} focusable explain>
      {children}
    </Tooltip>
  );
}

/// 可见区域的上界（视口坐标）：窗口顶，或最近一个会裁切内容的祖先（overflow 非 visible）的顶，
/// 再加上继承来的 CSS 变量 `--tip-ceiling`（px）——吸顶区（工具行、列头）的底边相对滚动容器顶的距离，
/// 由拥有吸顶区的组件写在自己根节点上。往上弹的提示框顶边高过它就翻到下方（`Tooltip ceiling`；
/// 表格格子迁到 `Tooltip` 之前，Matrix 画在内容流里的那一份也用它）
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
