import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { TIP_DELAY_MS } from "../ui";

/// 列表行的提示框（DESIGN「提示框 › 位置」）：**放在该行同一行的右侧空白处**，不放到上一行——
/// 放到上一行会被读成上一行的信息。材质与 ui 的 Tooltip 相同（复用 `.ss-tip`），只是锚点换成行：
///
/// - `after`：贴在整行右沿外 8（添加页来源栏：行右边是真正的空白）
/// - `before`：贴在触发点左边 8、与它同一行（触发点本身在行尾，比如添加页行尾的 `同名`）
///
/// 行 = 触发点最近的 `[data-rowtip]` 祖先。时机 400ms，移开立即消失；键盘焦点同样触发；
/// 内容同时作 `aria-describedby`。用 `position: fixed` 算坐标，不被列表的滚动容器裁掉
export function RowTip({
  content,
  side = "after",
  focusable = true,
  children,
}: {
  content: ReactNode;
  side?: "after" | "before";
  /// 触发点自己不可聚焦（标签、记号）时由包裹层接住键盘焦点；触发点本身是按钮时给 false
  focusable?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  const place = () => {
    const trigger = wrap.current;
    if (!trigger) return;
    const row = (trigger.closest("[data-rowtip]") as HTMLElement | null) ?? trigger;
    const r = row.getBoundingClientRect();
    const t = trigger.getBoundingClientRect();
    const top = r.top + r.height / 2;
    setStyle(
      side === "after"
        ? { position: "fixed", top, left: r.right + 8, transform: "translateY(-50%)" }
        : {
            position: "fixed",
            top,
            right: window.innerWidth - t.left + 8,
            transform: "translateY(-50%)",
          },
    );
  };
  const arm = () => {
    clear();
    timer.current = setTimeout(place, TIP_DELAY_MS.default);
  };
  const close = () => {
    clear();
    setStyle(null);
  };

  return (
    <span
      ref={wrap}
      className="pages-rowtip"
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={id}
      onMouseEnter={arm}
      onMouseLeave={close}
      onFocus={arm}
      onBlur={close}
    >
      {children}
      <span
        id={id}
        role="tooltip"
        className={`ss-tip${style ? " is-open" : ""}`}
        style={style ?? undefined}
      >
        {content}
      </span>
    </span>
  );
}
