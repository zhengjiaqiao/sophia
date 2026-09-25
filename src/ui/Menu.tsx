import { createContext, useContext, useEffect, useId, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { InLayerContext } from "./FloatingLayer.tsx";
import { CheckMark } from "./CheckRow.tsx";
import { IconTick } from "./icons.tsx";

/// 菜单（DESIGN「浮层：下拉」，裁决：菜单项**高 30、13 号字**——浮层菜单比页面列表紧凑，是 macOS 惯例）：
/// 一组可点的选项，一项一行（可带一行 12 `ink-mute` 副行）。悬停与键盘高亮是 `surface` 底、`control` 7 圆角、
/// 左右内缩；没有分隔线、没有图标之外的装饰。三种项（`MenuItem kind`），按选下去是什么意思选：
/// - `action` 普通项：点了做一件事、菜单关掉（托盘 `打开 Sophia` `退出`、MCP 同名时挑一份）
/// - `radio` 单选：一组里选一个，当前项前打 ✓（左边留一格 16，没打勾的项文字照样对齐；侧栏 `最近活跃 / 名称`）
/// - `check` 多选：各项独立勾选，前面是勾选框（14），没勾的名字 `ink-mute`、勾上 `ink`（来源行的目标 agent）
///
/// 不管定位：浮起的放进 `FloatingLayer`（锚在触发控件上、放不下上翻、点外面 / Esc / 滚动关掉）；
/// 常驻在面板里的（托盘底部）直接放，`context="panel"` 让项的左右内缩对齐面板的 16 内边距。
/// 键盘：方向键上下移动（首尾相接）、Home / End；`autoFocus` 打开即聚焦第一项。
/// 点不了的项给 `disabledReason`：原因写在这一项的副行里（浮层会滚动裁切，悬停提示框放不进去）

type MenuContextValue = { onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void };
const MenuContext = createContext<MenuContextValue | null>(null);

const ITEM = ".ss-menuitem:not(:disabled)";

export interface MenuProps {
  /// 读屏名（`项目排序` `目标 agent`）。在 `FloatingLayer` 里时由浮层的 `label` 说，这里可以不给
  label?: string;
  /// 打开即把焦点放到第一项（键盘打开的浮层）
  autoFocus?: boolean;
  /// layer（默认）：在浮层里，项左右内缩 4；panel：常驻在面板里（托盘），内缩 6、占满面板宽
  context?: "layer" | "panel";
  /// 菜单最宽多少，副行在里面折行。浮层里默认 320（菜单类浮层随内容、不设定宽）；
  /// 面板里默认不设上限（占满面板宽）
  maxWidth?: number;
  /// 可选的一句标题（`notion 有 3 份，写进哪一份？`）：13 `ink`，不是可点的项
  title?: ReactNode;
  children: ReactNode;
}

export function Menu({
  label,
  autoFocus = false,
  context = "layer",
  maxWidth = context === "layer" ? 320 : undefined,
  title,
  children,
}: MenuProps) {
  const inLayer = useContext(InLayerContext);
  const listRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // 浮层第一帧是隐藏的（等量好位置），隔一帧再聚焦
  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>(ITEM)?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
    const at = items.indexOf(event.currentTarget);
    const last = items.length - 1;
    const next =
      event.key === "ArrowDown"
        ? at === last
          ? 0
          : at + 1
        : event.key === "ArrowUp"
          ? at <= 0
            ? last
            : at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  };

  // 浮层自己已经是 role="menu"、带着读屏名：这里不再叠一层
  const role = inLayer ? undefined : "menu";
  return (
    <MenuContext.Provider value={{ onKeyDown }}>
      <div
        ref={listRef}
        className={`ss-menulist ss-menulist--${context}`}
        role={role}
        aria-label={role ? label : undefined}
        aria-labelledby={role && !label && title ? titleId : undefined}
        style={maxWidth === undefined ? undefined : { maxWidth }}
      >
        {title ? (
          <div className="ss-menulist__title" id={titleId}>
            {title}
          </div>
        ) : null}
        {children}
      </div>
    </MenuContext.Provider>
  );
}

export type MenuItemKind = "action" | "radio" | "check";

export interface MenuItemProps {
  /// 名字，13 号字
  children: ReactNode;
  /// action（默认）/ radio / check，见 Menu
  kind?: MenuItemKind;
  /// radio：是不是当前项；check：勾没勾
  checked?: boolean;
  /// 名字前的图形（agent 图标 14），在 ✓ / 勾选框之后
  icon?: ReactNode;
  /// 副行：12 `ink-mute`，放不下折行（同名几份差在哪几个字段）
  sub?: ReactNode;
  /// 给了就不可点：名字退到 `ink-faint`，原因写在副行（取代 `sub`）
  disabledReason?: string;
  /// 点了做什么；传进来的 target 是这一项（要在它旁边出结果提示时用）
  onSelect?: (target: HTMLButtonElement) => void;
}

export function MenuItem({
  children,
  kind = "action",
  checked = false,
  icon,
  sub,
  disabledReason,
  onSelect,
}: MenuItemProps) {
  const menu = useContext(MenuContext);
  const whyId = useId();
  const disabled = disabledReason !== undefined;
  const role =
    kind === "radio" ? "menuitemradio" : kind === "check" ? "menuitemcheckbox" : "menuitem";
  const classes = ["ss-menuitem", `ss-menuitem--${kind}`];
  if (checked) classes.push("is-on");
  const second = disabled ? disabledReason : sub;
  return (
    <button
      type="button"
      role={role}
      aria-checked={kind === "action" ? undefined : checked}
      aria-describedby={disabled ? whyId : undefined}
      className={classes.join(" ")}
      // 多选项：悬停这一项时勾选框「手靠近」（ui 的统一行钩子）
      data-checkrow={kind === "check" && !disabled ? "" : undefined}
      disabled={disabled}
      onKeyDown={menu?.onKeyDown}
      onClick={disabled ? undefined : (e) => onSelect?.(e.currentTarget)}
    >
      {kind === "radio" ? (
        <span className="ss-menuitem__tick">{checked ? <IconTick /> : null}</span>
      ) : null}
      {kind === "check" ? <CheckMark on={checked} /> : null}
      {icon ? <span className="ss-menuitem__icon">{icon}</span> : null}
      <span className="ss-menuitem__text">
        <span className="ss-menuitem__name">{children}</span>
        {second ? (
          <span className="ss-menuitem__sub" id={disabled ? whyId : undefined}>
            {second}
          </span>
        ) : null}
      </span>
    </button>
  );
}
