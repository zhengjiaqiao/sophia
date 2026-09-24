import { useEffect, useRef, useState } from "react";
import type { ProjectTimes } from "../types.ts";
import { displayPath } from "../pathText.ts";
import { relativeTime } from "../dateText.ts";
import { PROJECT_SORTS, type ProjectSort, type SidebarProject } from "../sidebarProjects.ts";
import { contextMenuHandler } from "../contextMenu.ts";
import type { AnchorRect } from "../layerPlace.ts";
import {
  AddButton,
  AgentIcon,
  BusySlot,
  Cap,
  FloatingToast,
  IconButton,
  IconCheck,
  IconClose,
  IconSettings,
  Indicator,
  Toast,
  Tooltip,
} from "../ui/index.ts";
import { AnimatedWordmark } from "../brand/AnimatedWordmark.tsx";
import { GLOBAL_KEY, type SidebarSelection } from "./place.ts";
import type { SidebarAgent } from "./agentRegistry.ts";

/// 侧栏（DESIGN「壳：侧栏 + 一块机面 › 侧栏」，裁决 D1）：208 宽、全高、落在机壳上、不画线。
/// 自上而下：红绿灯行 28（留空、可拖窗）→ 字标带 44 → `AGENT` 段（小标经 `Cap`） → `项目` 段 → 贴底 `设置`。
/// 三段是**同一种项、同一个选中**：全侧栏一次只有一项选中，它就是机面里正在显示的那一页。
///
/// **拖窗区**（D17）：整条侧栏标 `deep`，项都是 `<button>`（自己挡掉拖动），字标标 `false`；
/// 于是红绿灯行、字标带空白、区块小标与项之间和之下的空白都能拖。

/// agent 段的一项由 agent 注册表生成（agentRegistry.ts）：每个有能力节的 agent 一项，
/// `on` 时名字后画 6px 橙点；没开不画（不画灰点）
export type { SidebarAgent } from "./agentRegistry.ts";

/// 刚移除的手动项目：`×` 原位下方浮起 `✓ 已移除 X · 撤销`
export interface RemovedProject {
  path: string;
  name: string;
  /// `×` 原来的位置（项目行已经消失，锚点记矩形）
  anchor: AnchorRect;
  /// 换一条就是新出现一次
  at: number;
}

export interface SidebarProps {
  agents: ReadonlyArray<SidebarAgent>;
  projects: ReadonlyArray<SidebarProject>;
  projectTimes: ReadonlyMap<string, ProjectTimes>;
  selection: SidebarSelection;
  onSelectLocation: (key: string) => void;
  onSelectAgent: (id: string) => void;
  onSelectSettings: () => void;
  sort: ProjectSort;
  onSort: (sort: ProjectSort) => void;
  /// 项目列表正在增删：`+ 项目` 原位忙碌、移除键锁住
  projectBusy: "add" | "remove" | null;
  onAddProject: () => void;
  /// 移除手动项目（不确认）；`anchor` 是 `×` 的位置，撤销提示锚在它下方
  onRemoveProject: (project: SidebarProject, anchor: AnchorRect) => void;
  removed: RemovedProject | null;
  onUndoRemove: () => void;
  onRemovedGone: () => void;
}

const rectOf = (el: Element): AnchorRect => {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
};

export function Sidebar(props: SidebarProps) {
  const { selection } = props;
  const isLocation = (key: string) => selection.kind === "location" && selection.key === key;
  /// 右键菜单开着的那一行：`surface` 行带，菜单关掉即摘
  const [menuFor, setMenuFor] = useState<string | null>(null);

  /// `+ 项目` 吸在滚动区底边时（下面还有没滚到的项目）才画上沿的渐隐：项目少、它紧跟最后一项时不画，
  /// 免得把最后一个项目名的下半截也淡掉
  const navRef = useRef<HTMLElement>(null);
  const [addStuck, setAddStuck] = useState(false);
  /// 往下滚过了（上面有项目被字标带挡住）：滚动区上沿画 16 渐隐，不让半截项目名硬切在字标下面
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const update = () => {
      setAddStuck(nav.scrollTop + nav.clientHeight < nav.scrollHeight - 1);
      setScrolled(nav.scrollTop > 0);
    };
    update();
    nav.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(nav);
    for (const child of Array.from(nav.children)) observer?.observe(child);
    return () => {
      nav.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [props.projects.length, props.agents.length]);

  const remove = (p: SidebarProject, row: Element | null) => {
    const x = row?.querySelector(".side-item__remove") ?? row;
    const anchor = x ? rectOf(x) : { top: 0, bottom: 0, left: 0, right: 0 };
    props.onRemoveProject(p, anchor);
  };

  return (
    <aside className="sidebar" data-tauri-drag-region="deep">
      {/* 红绿灯行：留空，系统的红绿灯浮在这里（trafficLightPosition） */}
      <div className="sidebar__lights" />
      {/* 字标带：画布只盖这一块（data-brand-band），碎片落在它的下沿 */}
      <div className="sidebar__brand" data-brand-band="">
        <h1 className="sidebar__mark">
          <AnimatedWordmark />
        </h1>
      </div>

      <nav
        className="sidebar__nav"
        aria-label="导航"
        ref={navRef}
        data-fade-top={scrolled ? "" : undefined}
      >
        {props.agents.length > 0 && (
          <>
            <div className="sidebar__head">
              <span className="sidebar__label">
                <Cap>agent</Cap>
              </span>
            </div>
            {props.agents.map((a) => {
              const on = selection.kind === "agent" && selection.id === a.id;
              return (
                <div key={a.id} className={`side-item${on ? " is-on" : ""}`}>
                  <button
                    type="button"
                    className="side-item__main"
                    aria-current={on ? "page" : undefined}
                    onClick={() => props.onSelectAgent(a.id)}
                  >
                    <span className="side-item__icon">
                      <AgentIcon id={a.id} name={a.name} size={15} />
                    </span>
                    <span className="side-item__name">{a.name}</span>
                    {a.on && (
                      <span className="side-item__dot">
                        <Indicator on label="有能力开着、在生效" />
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          </>
        )}

        {/* 小标题 `项目` + 右端排序下拉；`全局` 固定第一，不参与排序 */}
        <div className="sidebar__head">
          <span className="sidebar__label">项目</span>
          <SortMenu value={props.sort} onChange={props.onSort} />
        </div>
        <div className={`side-item${isLocation(GLOBAL_KEY) ? " is-on" : ""}`}>
          <button
            type="button"
            className="side-item__main"
            aria-current={isLocation(GLOBAL_KEY) ? "page" : undefined}
            onClick={() => props.onSelectLocation(GLOBAL_KEY)}
          >
            <span className="side-item__name">全局</span>
          </button>
        </div>
        {props.projects.map((p) => {
          const on = isLocation(p.key);
          const lastActive = props.projectTimes.get(p.path)?.lastActive ?? null;
          return (
            <div
              key={p.key}
              className={`side-item${on ? " is-on" : ""}${menuFor === p.key ? " is-menu" : ""}`}
              // 右键菜单只挂在手动添加的项目上，只有「从侧栏移除」（D18）；自动发现的没有菜单
              onContextMenu={contextMenuHandler(
                () =>
                  p.manual && props.projectBusy === null
                    ? [{ label: "从侧栏移除", run: () => remove(p, rowOf(p.key)) }]
                    : [],
                { onOpen: () => setMenuFor(p.key), onClose: () => setMenuFor(null) },
              )}
              data-project={p.key}
            >
              <button
                type="button"
                className="side-item__main"
                aria-current={on ? "page" : undefined}
                onClick={() => props.onSelectLocation(p.key)}
              >
                {/* 时间不写在侧栏上（侧栏只放名字）：悬停给完整路径和「活跃于 3 天前」 */}
                <Tooltip
                  content={
                    <>
                      {displayPath(p.path)}
                      {lastActive !== null && (
                        <>
                          <br />
                          活跃于 {relativeTime(lastActive)}
                        </>
                      )}
                    </>
                  }
                >
                  <span className="side-item__name">{p.label}</span>
                </Tooltip>
              </button>
              {p.manual && (
                <span className="side-item__remove">
                  <IconButton
                    icon={<IconClose />}
                    title="从侧栏移除 · 不动磁盘上的文件"
                    disabledReason={props.projectBusy !== null ? "正在读取，稍等" : undefined}
                    onClick={() => remove(p, rowOf(p.key))}
                  />
                </span>
              )}
            </div>
          );
        })}
        {/* `+ 项目` 是项目列表的最后一项：默认键紧凑 24，左沿对齐项目名。列表长了它吸在滚动区底边、
          不跟着滚走（DESIGN「项目」段），吸住时上沿 16 渐隐 */}
        <div className="sidebar__add" data-stuck={addStuck || undefined}>
          <BusySlot busy={props.projectBusy === "add"} label="正在添加项目">
            <AddButton
              noun="项目"
              size="compact"
              disabledReason={props.projectBusy === "remove" ? "正在移除项目，稍等" : undefined}
              onClick={props.onAddProject}
            />
          </BusySlot>
        </div>
        {props.removed && (
          <FloatingToast key={props.removed.at} align="start" anchor={() => props.removed?.anchor}>
            <Toast
              kind="success"
              verb="已移除"
              names={[props.removed.name]}
              action={{ label: "撤销", onClick: props.onUndoRemove }}
              onDismiss={props.onRemovedGone}
            />
          </FloatingToast>
        )}
      </nav>

      {/* 贴侧栏底：设置（⌘, 与应用菜单「设置…」直达） */}
      <div className="sidebar__foot">
        <div className={`side-item${selection.kind === "settings" ? " is-on" : ""}`}>
          <button
            type="button"
            className="side-item__main"
            aria-current={selection.kind === "settings" ? "page" : undefined}
            onClick={props.onSelectSettings}
          >
            <span className="side-item__icon">
              <IconSettings />
            </span>
            <span className="side-item__name">设置</span>
          </button>
        </div>
      </div>
    </aside>
  );
}

const rowOf = (key: string): Element | null =>
  document.querySelector(`.side-item[data-project="${CSS.escape(key)}"]`);

/// 小标题行右端的排序下拉：`最近活跃 ▾`，点开两项的小浮层，当前项前打 ✓。
/// 点外面、按 Esc 关闭，不铺透明罩。选择记在本机，下次打开照旧
function SortMenu({ value, onChange }: { value: ProjectSort; onChange: (s: ProjectSort) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && wrap.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);
  const current = PROJECT_SORTS.find((s) => s.id === value) ?? PROJECT_SORTS[0];
  return (
    <span ref={wrap} className="sidebar__sort">
      <button
        ref={button}
        type="button"
        className="sidebar__sort-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {current.label} ▾
      </button>
      {open && (
        <div className="sidebar__sort-menu" role="menu" aria-label="项目排序">
          {PROJECT_SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="menuitemradio"
              aria-checked={s.id === value}
              className="sidebar__sort-item"
              onClick={() => {
                onChange(s.id);
                setOpen(false);
              }}
            >
              <span className="sidebar__sort-check">
                {s.id === value && <IconCheck size={12} />}
              </span>
              {s.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
