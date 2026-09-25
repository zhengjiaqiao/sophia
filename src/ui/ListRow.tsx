import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from "react";
import { Drawer, DrawerHandle } from "./Drawer.tsx";

/// 列表行（DESIGN「网关」「添加来源」：两者同一骨架，⑤）：**两行、整行可点**的列表项，下挂一格抽屉。
///
/// ```
/// [勾选 24 · 8] [拉手 18 · 6] 名字（15 ink，放不下截断）              [行尾动作列]
///                              第二行（12 ink-mute，上距 3）
///   ↳ 抽屉：左沿对齐名字
/// ```
/// - 行首勾选格可选（`check`，通常是 `Checkbox`）：有它时拉手平时不画，悬停这一行 / 键盘焦点在行里 / 已拉开才出；
///   没有时拉手常显（DESIGN「抽屉」：只有出现时机随行不同，形与方向处处一样）
/// - 拉手自成一列，各行名字对齐；没有抽屉的行这一格留空
/// - **点整行＝拉开 / 收起抽屉**（勾选格与行尾动作列里的点击不算，它们各有各的事）；Esc 收起
/// - 悬停：整行 `surface` 带（`control` 7，左右各外扩 8，文字起点不变；裁决：整行能点就有悬停回应）；
///   拉开着不出悬停带；右键菜单开着时给 `highlighted` 保持亮着
/// - 行与行之间 1px `row-line`（画在「行 + 抽屉」这一组的底下，抽屉属于它上面那一行；最后一行不画）
///
/// 行的内容全由插槽给：名字、第二行、行尾动作、抽屉内容。表格行不是它（列由表格定、格子是动作）

export interface ListRowProps {
  /// 名字：body 15 `ink`，放不下截断
  title: ReactNode;
  /// 第二行：12 `ink-mute`（`地址 · 已连接 · 已选 2 / 103`），怎么截断由内容自己定
  sub?: ReactNode;
  /// 行首勾选格（24 宽 + 8）：通常是 `Checkbox`。给了拉手就平时隐藏
  check?: ReactNode;
  /// 行尾动作列（键间 4）：`再试一次`、铅笔、垃圾桶
  actions?: ReactNode;
  /// 抽屉内容。给了才有拉手、整行才可点
  drawer?: ReactNode;
  /// 抽屉拉开没有（调用方的状态）
  open?: boolean;
  /// 点整行、点拉手、Esc：切换抽屉
  onToggle?: () => void;
  /// 拉手的读屏名：说拉开的是什么（`openrouter 的模型`）
  drawerLabel?: string;
  /// 抽屉的 id（拉手的 aria-controls）
  drawerId?: string;
  /// 行与抽屉之间的一块（这一行没写成时的灰面板）
  notice?: ReactNode;
  /// 右键菜单开着：保持行带亮着
  highlighted?: boolean;
  /// 右键菜单（`contextMenuHandler(...)`）
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  /// 挂在这一组的外层上（行的转场：刚加入时闪两下）
  className?: string;
  /// 这一组外层的动画播完（调用方据此撤掉闪烁类）
  onAnimationEnd?: () => void;
  /// 行本身（可点的那一块）的 ref：浮起提示锚在它上面
  rowRef?: Ref<HTMLDivElement>;
}

export function ListRow({
  title,
  sub,
  check,
  actions,
  drawer,
  open = false,
  onToggle,
  drawerLabel,
  drawerId,
  notice,
  highlighted = false,
  onContextMenu,
  className,
  onAnimationEnd,
  rowRef,
}: ListRowProps) {
  const hasDrawer = drawer !== undefined && drawer !== null;
  const hasCheck = check !== undefined && check !== null;
  const classes = ["ss-listrow"];
  if (hasCheck) classes.push("has-check");
  if (open) classes.push("is-open");
  if (highlighted) classes.push("is-highlighted");
  if (className) classes.push(className);

  // 点整行拉开 / 收起；勾选格与行尾动作列里的点击各有各的事
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    if (target.closest(".ss-listrow__check, .ss-listrow__actions")) return;
    onToggle?.();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && open && onToggle) {
      e.stopPropagation();
      onToggle();
    }
  };

  return (
    <div
      className={classes.join(" ")}
      onKeyDown={hasDrawer ? onKeyDown : undefined}
      onAnimationEnd={
        onAnimationEnd
          ? (e) => {
              if (e.target === e.currentTarget) onAnimationEnd();
            }
          : undefined
      }
    >
      <div
        ref={rowRef}
        className="ss-listrow__main"
        data-drawer-row={hasDrawer ? "" : undefined}
        onClick={hasDrawer ? onClick : undefined}
        onContextMenu={onContextMenu}
      >
        {hasCheck ? <span className="ss-listrow__check">{check}</span> : null}
        <span className="ss-listrow__handle">
          {hasDrawer && onToggle ? (
            <DrawerHandle
              open={open}
              onToggle={onToggle}
              label={drawerLabel ?? ""}
              controls={drawerId}
              always={!hasCheck}
            />
          ) : null}
        </span>
        <span className="ss-listrow__content">
          <span className="ss-listrow__title">{title}</span>
          {sub !== undefined && sub !== null ? (
            <span className="ss-listrow__sub">{sub}</span>
          ) : null}
        </span>
        {actions ? <span className="ss-listrow__actions">{actions}</span> : null}
      </div>
      {notice ? <div className="ss-listrow__notice">{notice}</div> : null}
      {hasDrawer ? (
        // 抽屉左沿对齐名字：勾选格 24 + 8、拉手 18 + 6
        <Drawer open={open} id={drawerId} inset={hasCheck ? 56 : 24} rule={false} flush>
          {drawer}
        </Drawer>
      ) : null}
    </div>
  );
}
