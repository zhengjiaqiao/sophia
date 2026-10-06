import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { FOCUSABLE, FloatingLayer } from "./FloatingLayer.tsx";
import { TIP_DELAY_MS } from "./Tooltip.tsx";

/// 悬浮卡（DESIGN-components「悬浮卡 HoverCard」，画板 06e734c8，2026-10-06 产品负责人：「悬浮碳层除了之前墨色的那种
/// 建议的，还有这种带交互的」）：手停在一句话上，在字下面浮起一张纸卡，卡里能选字、能点。
///
/// 和提示框（`Tooltip`）分工：提示框是墨色、只读的一两句话，手一移开就收；悬浮卡是纸（就是 `FloatingLayer`：
/// `paper` + 1px `hairline`、`float` 12 圆角 + 浮层投影），里面放一段要看、要复制的东西。
///
/// - 停 400 ms 出（同表格外的提示框）；手离开字和卡 300 ms 后收，斜着挪进卡里不收。
/// - 点一下那句话（或焦点在它上时按回车、空格）：立刻出并钉住，点外面、Esc、再点一次、页面滚动才收。
/// - 键盘：那句话能 Tab 停到，停够了出卡；卡开着时 Tab 进卡，Esc 收卡、焦点回到那句话。
/// - 那句话平时不加任何记号（D21）；手放上去、卡开着时字转主字色，说「这里有东西」。
export const HOVER_CARD_LEAVE_MS = 300;

export type HoverCardState = "closed" | "hover" | "pinned";
/// delay：停够了；press：点一下 / 回车 / 空格；leave：手离开字和卡够久了（或焦点走了）；dismiss：点外面、Esc、滚动
export type HoverCardEvent = "delay" | "press" | "leave" | "dismiss";

export function hoverCardNext(state: HoverCardState, event: HoverCardEvent): HoverCardState {
  switch (event) {
    case "delay":
      return state === "closed" ? "hover" : state;
    case "press":
      return state === "pinned" ? "closed" : "pinned";
    case "leave":
      return state === "hover" ? "closed" : state;
    case "dismiss":
      return "closed";
  }
}

export interface HoverCardProps {
  /// 触发它的那句话（只放字；句子里的键放在外面，不算触发区）
  children: ReactNode;
  /// 卡里的东西
  content: ReactNode;
  /// 卡的读屏名
  label: string;
  /// 加在触发的那句话上（它自己是 flex 项时，如网关行的原因）
  className?: string;
  /// 卡的滚动区（`FloatingLayer` 的 className）：宽度、内边距由它定
  cardClassName?: string;
  /// 初始就钉住打开（样张用；服务端渲染没有锚点，不画卡）
  defaultOpen?: boolean;
}

export function HoverCard({
  children,
  content,
  label,
  className,
  cardClassName,
  defaultOpen = false,
}: HoverCardProps) {
  const [state, setState] = useState<HoverCardState>("closed");
  const [trigger, setTrigger] = useState<HTMLSpanElement | null>(null);
  /// 用回车 / 空格钉住时把焦点放进卡里；悬停与点击不抢焦点
  const [focusCard, setFocusCard] = useState(false);
  const cardId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /// 刚收起（Esc 会把焦点还给这句话）：这一次聚焦不再计时出卡
  const dismissed = useRef(false);

  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const send = useCallback((event: HoverCardEvent) => {
    setState((s) => hoverCardNext(s, event));
  }, []);
  const later = (event: HoverCardEvent, ms: number) => {
    clear();
    timer.current = setTimeout(() => send(event), ms);
  };
  useEffect(() => clear, []);
  useEffect(() => {
    if (defaultOpen) setState("pinned");
  }, [defaultOpen]);

  const open = state !== "closed";
  const dismiss = useCallback(() => {
    clear();
    // 只挡紧接着的那一次聚焦（Esc 关卡后同步把焦点还给这句话）；点外面关的不会有，下一轮就作废
    dismissed.current = true;
    setTimeout(() => {
      dismissed.current = false;
    }, 0);
    setFocusCard(false);
    send("dismiss");
  }, [send]);

  const press = (byKey: boolean) => {
    clear();
    dismissed.current = false;
    setFocusCard(byKey && state !== "pinned");
    send("press");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      press(true);
      return;
    }
    // 卡挂在 body 末尾：开着时 Tab 从这句话直接进卡，不然要走完后面整页才到
    if (event.key === "Tab" && !event.shiftKey && open) {
      const first = document
        .getElementById(cardId)
        ?.closest(".ss-layer")
        ?.querySelector<HTMLElement>(FOCUSABLE);
      if (first) {
        event.preventDefault();
        clear();
        first.focus({ preventScroll: true });
      }
    }
  };

  /// 焦点离开这句话、也不在卡里：悬停态收起（钉住的不收）
  const onBlur = () => {
    setTimeout(() => {
      const active = document.activeElement;
      const card = document.getElementById(cardId)?.closest(".ss-layer");
      if (active && card?.contains(active)) return;
      if (active === trigger) return;
      clear();
      send("leave");
    }, 0);
  };

  return (
    <>
      <span
        ref={setTrigger}
        className={["ss-hovercard", className, open ? "is-open" : null].filter(Boolean).join(" ")}
        tabIndex={0}
        role="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        onPointerEnter={() => {
          if (state === "closed") later("delay", TIP_DELAY_MS.default);
          else clear();
        }}
        onPointerLeave={() => {
          if (state === "closed") clear();
          else later("leave", HOVER_CARD_LEAVE_MS);
        }}
        onClick={() => press(false)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (dismissed.current) {
            dismissed.current = false;
            return;
          }
          if (state === "closed") later("delay", TIP_DELAY_MS.default);
        }}
        onBlur={onBlur}
      >
        {children}
      </span>
      {open && trigger ? (
        <FloatingLayer
          trigger={trigger}
          onClose={dismiss}
          label={label}
          role="dialog"
          autoFocus={focusCard}
          onHover={(inside) => (inside ? clear() : later("leave", HOVER_CARD_LEAVE_MS))}
          className={cardClassName}
        >
          <div id={cardId}>{content}</div>
        </FloatingLayer>
      ) : null}
    </>
  );
}
