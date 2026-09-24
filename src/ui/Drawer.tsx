import { useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";

/// 抽屉（DESIGN「抽屉（展开与收起）」，2026-09-25 取代 `▸ / ▾` 字符）：展开＝从机面里拉出一格抽屉。
///
/// 两件：
/// - `DrawerHandle` 拉手：跟在名字后面（名字 + 6 + 拉手；有 `×2` 时跟在 `×2` 之后，行内键排在拉手之后）。
///   只有一枚 10px 线形箭头（1.4 描边、`ink-mute`），没有键面、不抬起；命中区 18 方。
///   **平时不画**：悬停这一行、键盘焦点在这一行上、已拉开时才出——行元素加 `data-drawer-row` 作钩子。
///   收起朝下 ˅，拉开时 260ms 弹簧翻转朝上 ˄。点它只切换抽屉，不冒泡到行（行自己的点击另有用处）。
/// - `Drawer` 抽屉：这一行下面的一格凹槽（`recess` 底 + `recess-tabs` 内凹、`control` 7、内边距 10 12），
///   上 6 下 10、下沿 1px `row-line`；高度 0 ↔ 内容高 260ms 机械缓动，`prefers-reduced-motion` 下即时。
///   左沿对齐这一行的名字，由调用方给 `.ss-drawer__well` 加左外边距（经 `className` 挂自己的类）。
///
/// 谁开抽屉、Esc 收起、表格一次只开一格，都是调用方的状态；这里只管长相与动效。

/// 抽屉滑出 / 滑回的时长，与 tokens.css 的 `--dur-drawer` 同值：收起时内容留到滑完才卸
export const DRAWER_MS = 260;

export interface DrawerHandleProps {
  open: boolean;
  onToggle: () => void;
  /// 读屏名：说拉开的是什么（`defuddle 的详情`）。展开没展开由 aria-expanded 说
  label: string;
  /// 抽屉的 id（`Drawer` 的 `id`），给 aria-controls
  controls?: string;
}

export function DrawerHandle({ open, onToggle, label, controls }: DrawerHandleProps) {
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    // 行本身点了也拉开（点名字、点整行）：别让这一下再冒到行上切第二次
    e.stopPropagation();
    onToggle();
  };
  return (
    <button
      type="button"
      className={open ? "ss-drawerhandle is-open" : "ss-drawerhandle"}
      aria-label={label}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onClick}
    >
      <svg
        className="ss-drawerhandle__glyph"
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
        <path d="M1.5 3.5 5 7 8.5 3.5" />
      </svg>
    </button>
  );
}

export interface DrawerProps {
  open: boolean;
  children: ReactNode;
  /// 给拉手的 aria-controls 对上
  id?: string;
  /// 挂在外层上，调用方据此对齐左沿（`.x .ss-drawer__well { margin-left: … }`）、改上下留白
  className?: string;
}

export function Drawer({ open, children, id, className }: DrawerProps) {
  // 收起时内容先留着，等高度滑回 0 再卸，免得一关就空着往回缩
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), DRAWER_MS);
    return () => clearTimeout(timer);
  }, [open]);
  const classes = ["ss-drawer"];
  if (open) classes.push("is-open");
  if (className) classes.push(className);
  // 外层一直在（空的、高 0）：拉开时 grid 行从 0fr 过渡到 1fr，第一次拉开也有动效
  return (
    <div className={classes.join(" ")} id={id} inert={!open}>
      <div className="ss-drawer__clip">
        {open || mounted ? (
          <div className="ss-drawer__room">
            <div className="ss-drawer__well">{children}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
