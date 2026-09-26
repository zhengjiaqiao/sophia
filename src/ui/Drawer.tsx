import { useEffect, useState } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { IconChevronDown } from "./icons.tsx";
import { motionMs } from "./motion.ts";

/// 抽屉（DESIGN「抽屉（展开与收起）」，2026-09-25 取代 `▸ / ▾` 字符）：展开＝从机面里拉出一格抽屉。
///
/// 两件：
/// - `DrawerHandle` 拉手：**全应用一个形、一个位置**（2026-09-25 评审第二轮，⑤ 同一个动作只学一次）——
///   在名字前自成一列（拉手 18 + 6 + 名字；调用方给没有抽屉的行留空，各行名字对齐），`×2` 这类记号跟在名字后。
///   只有一枚 10px 线形箭头（1.4 描边、`ink-mute`），没有键面、不抬起；命中区 18 方。
///   收起朝右 ›，拉开时 260ms 弹簧转 90° 朝下 ˅（访达列表的展开三角惯例）。
///   **有勾选框的行平时不画**：悬停这一行、键盘焦点在这一行上、已拉开时才出——行元素加 `data-drawer-row` 作钩子。
///   点它只切换抽屉，不冒泡到行（行自己的点击另有用处）。
/// - `Drawer` 抽屉：这一行下面拉出来的详情，**不垫底色块**（详情缩进到名字的左沿、夹在这一行和下一条行线之间，
///   归属已经清楚）；上 6 下 12、下沿 1px `row-line`；高度 0 ↔ 内容高 `--dur-drawer` 机械缓动，
///   `prefers-reduced-motion` 下即时。左沿对齐这一行的名字：`inset`（行首让出多少）；
///   行线归「行 + 抽屉」那一组画的（列表行）给 `rule={false}`，紧贴行的给 `flush`。页面不再覆盖 `.ss-drawer__*`。
///
/// **行首没有勾选框的行**（网关行）用 `always`：拉手常显——前面没有勾选框，拉手不会和它挤在一起
/// （2026-09-25 产品负责人真机：「前面没有选择框的时候，展开按钮不需要悬浮才出现，可以直接展示在文字前面」）。
/// 只有出现时机随行不同，形与方向处处一样。
///
/// 谁开抽屉、Esc 收起、表格一次只开一格，都是调用方的状态；这里只管长相与动效。

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

/// 抽屉内容的左右让位：数字是 px，字符串原样进 CSS（`calc(34px + var(--mx-handle-col))`）
export type DrawerInset = number | string | { start?: number | string; end?: number | string };

export interface DrawerProps {
  open: boolean;
  children: ReactNode;
  /// 给拉手的 aria-controls 对上
  id?: string;
  /// 左沿对齐这一行的名字：行首让出多少（勾选列、拉手列）；给对象时还能让出右边（表格的 agent 列）
  inset?: DrawerInset;
  /// 抽屉下沿的 `row-line`（默认有）。行线由「行 + 抽屉」这一组自己画时给 false
  rule?: boolean;
  /// 紧贴行：上内边距 0（行自己已经留了下内边距）
  flush?: boolean;
  /// 挂在外层上：给内容排版用（抽屉里的格子、列），不再用来改抽屉自己的边距
  className?: string;
}

const cssLength = (v: number | string | undefined) => (typeof v === "number" ? `${v}px` : v);

export function Drawer({
  open,
  children,
  id,
  inset,
  rule = true,
  flush = false,
  className,
}: DrawerProps) {
  // 收起时内容先留着，等高度滑回 0 再卸，免得一关就空着往回缩（时长取 `--dur-drawer`）
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), motionMs("--dur-drawer"));
    return () => clearTimeout(timer);
  }, [open]);
  const classes = ["ss-drawer"];
  if (open) classes.push("is-open");
  if (!rule) classes.push("is-bare");
  if (flush) classes.push("is-flush");
  if (className) classes.push(className);
  const side = typeof inset === "object" ? inset : { start: inset };
  const wellStyle: CSSProperties | undefined =
    inset === undefined
      ? undefined
      : { marginInlineStart: cssLength(side.start), marginInlineEnd: cssLength(side.end) };
  // 外层一直在（空的、高 0）：拉开时 grid 行从 0fr 过渡到 1fr，第一次拉开也有动效
  return (
    <div className={classes.join(" ")} id={id} inert={!open}>
      <div className="ss-drawer__clip">
        {open || mounted ? (
          <div className="ss-drawer__room">
            <div className="ss-drawer__well" style={wellStyle}>
              {children}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
