import { useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { IconChevronDown } from "./icons.tsx";

/// 抽屉（DESIGN「抽屉（展开与收起）」，2026-09-25 取代 `▸ / ▾` 字符）：展开＝从机面里拉出一格抽屉。
///
/// 两件：
/// - `DrawerHandle` 拉手：**全应用一个形、一个位置**（2026-09-25 评审第二轮，⑤ 同一个动作只学一次）——
///   在名字前自成一列（拉手 18 + 6 + 名字；调用方给没有抽屉的行留空，各行名字对齐），`×2` 这类记号跟在名字后。
///   只有一枚 10px 线形箭头（1.4 描边、`ink-mute`），没有键面、不抬起；命中区 18 方。
///   收起朝右 ›，拉开时 260ms 弹簧转 90° 朝下 ˅（访达列表的展开三角惯例）。
///   **有勾选框的行平时不画**：悬停这一行、键盘焦点在这一行上、已拉开时才出——行元素加 `data-drawer-row` 作钩子。
///   点它只切换抽屉，不冒泡到行（行自己的点击另有用处）。
/// - `Drawer` 抽屉：这一行下面的一格平的浅灰槽（`recess` 底、不画内凹阴影、`control` 7、内边距 10 12），
///   上 6 下 10、下沿 1px `row-line`；高度 0 ↔ 内容高 260ms 机械缓动，`prefers-reduced-motion` 下即时。
///   左沿对齐这一行的名字，由调用方给 `.ss-drawer__well` 加左外边距（经 `className` 挂自己的类）。
///
/// **行首没有勾选框的行**（网关行）用 `always`：拉手常显——前面没有勾选框，拉手不会和它挤在一起
/// （2026-09-25 产品负责人真机：「前面没有选择框的时候，展开按钮不需要悬浮才出现，可以直接展示在文字前面」）。
/// 只有出现时机随行不同，形与方向处处一样。
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
  /// 常显（行首没有勾选框的行）；不给就只在悬停 / 键盘焦点到这一行、或已拉开时出
  always?: boolean;
}

export function DrawerHandle({
  open,
  onToggle,
  label,
  controls,
  always = false,
}: DrawerHandleProps) {
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    // 行本身点了也拉开（点名字、点整行）：别让这一下再冒到行上切第二次
    e.stopPropagation();
    onToggle();
  };
  return (
    <button
      type="button"
      className={`ss-drawerhandle${always ? " is-always" : ""}${open ? " is-open" : ""}`}
      aria-label={label}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onClick}
    >
      <IconChevronDown className="ss-drawerhandle__glyph" />
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
