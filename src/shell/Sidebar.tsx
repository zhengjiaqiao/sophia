import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectTimes } from "../types.ts";
import { displayPath } from "../pathText.ts";
import { relativeTime } from "../dateText.ts";
import { PROJECT_SORTS, type ProjectSort, type SidebarProject } from "../sidebarProjects.ts";
import { contextMenuHandler } from "../contextMenu.ts";
import type { AnchorRect } from "../layerPlace.ts";
import {
  AgentIcon,
  BusySlot,
  Cap,
  FadeViewport,
  FloatingLayer,
  FloatingToast,
  IconButton,
  IconClose,
  IconPlus,
  IconSettings,
  IconChevronDown,
  Indicator,
  Menu,
  MenuItem,
  ReasonTip,
  SectionLabel,
  Toast,
  Tooltip,
  useEdgeFades,
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

  const navRef = useRef<HTMLElement>(null);
  /// 往下滚过了（上面有项目被字标带挡住）：滚动区上沿画 16 渐隐，不让半截项目名硬切在字标下面。
  /// 只用上沿：下沿有吸底的 `+ 项目` 与它的线（不用渐隐）
  const scrolled = useEdgeFades(navRef).start;
  const navFade = { start: scrolled, end: false };

  /// `+ 项目` 吸在滚动区底边时（下面还有没滚到的项目）上沿才出 1px row-line；项目少、它紧跟最后一项时不画。
  /// 判断靠哨兵：它排在 `+ 项目` 的原位末端（不随 sticky 移动），原位露在可见区里＝没吸住，
  /// 被挤到可见区下面＝吸住了。IntersectionObserver 只在跨线时回调，不逐帧算；
  /// 可见区底边按 nav 的下内边距内缩——sticky 的 bottom: 0 也是量到内边距里面
  const addEndRef = useRef<HTMLDivElement>(null);
  const [addStuck, setAddStuck] = useState(false);
  useEffect(() => {
    const nav = navRef.current;
    const end = addEndRef.current;
    if (!nav || !end || typeof IntersectionObserver === "undefined") return;
    const inset = parseFloat(getComputedStyle(nav).paddingBottom) || 0;
    const observer = new IntersectionObserver(([entry]) => setAddStuck(!entry.isIntersecting), {
      root: nav,
      rootMargin: `0px 0px ${-inset}px 0px`,
    });
    observer.observe(end);
    return () => observer.disconnect();
  }, []);

  const addBusy = props.projectBusy === "add";
  const addLocked = props.projectBusy === "remove" ? "正在移除项目，稍等" : undefined;

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

      <FadeViewport fade={navFade} tone="shell" className="sidebar__scroll">
        <nav className="sidebar__nav" aria-label="导航" ref={navRef}>
          {props.agents.length > 0 && (
            <>
              <div className="sidebar__head">
                <SectionLabel>
                  <Cap>agent</Cap>
                </SectionLabel>
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
            <SectionLabel action={<SortMenu value={props.sort} onChange={props.onSort} />}>
              项目
            </SectionLabel>
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
                    fit="grow"
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
          {/* `+ 项目` 是项目列表的最后一项，长相是侧栏的一行（不是键）：14px `+` + `项目`，ink-mute，
          行高、左沿、悬停 surface 带都同项目行。列表长了它吸在滚动区底边、不跟着滚走（DESIGN「项目」段），
          只在吸住时上沿出 1px row-line */}
          <div className="sidebar__add" data-stuck={addStuck || undefined}>
            <div className="side-item side-item--add">
              <ReasonTip reason={addLocked} fit="grow">
                <button
                  type="button"
                  className="side-item__main"
                  title={addLocked}
                  disabled={addBusy || addLocked !== undefined}
                  aria-busy={addBusy || undefined}
                  onClick={props.onAddProject}
                >
                  <BusySlot busy={addBusy} label="正在添加项目">
                    <span className="side-item__icon">
                      <IconPlus size={14} />
                    </span>
                    <span className="side-item__name">项目</span>
                  </BusySlot>
                </button>
              </ReasonTip>
            </div>
          </div>
          {/* 吸底哨兵：`+ 项目` 原位的末端，不占高 */}
          <div ref={addEndRef} className="sidebar__add-end" aria-hidden="true" />
          {props.removed && (
            <FloatingToast
              key={props.removed.at}
              align="start"
              anchor={() => props.removed?.anchor}
            >
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
      </FadeViewport>

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

/// 小标题行右端的排序下拉：`最近活跃 ˅`（记号是统一的线形箭头 `IconChevronDown`），点开两项的单选菜单
/// （ui 的 `Menu` + `MenuItem kind="radio"`，当前项前打 ✓），放在锚着这颗键的 `FloatingLayer` 里——
/// 定位、放不下上翻、点外面 / Esc 关都归浮层。选择记在本机，下次打开照旧
function SortMenu({ value, onChange }: { value: ProjectSort; onChange: (s: ProjectSort) => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const current = PROJECT_SORTS.find((s) => s.id === value) ?? PROJECT_SORTS[0];
  return (
    <>
      <button
        ref={button}
        type="button"
        className="sidebar__sort-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {current.label}
        <IconChevronDown className="sidebar__sort-chevron" />
      </button>
      {open && button.current ? (
        <FloatingLayer trigger={button.current} onClose={close} label="项目排序" align="end">
          <Menu autoFocus>
            {PROJECT_SORTS.map((s) => (
              <MenuItem
                key={s.id}
                kind="radio"
                checked={s.id === value}
                onSelect={() => {
                  onChange(s.id);
                  setOpen(false);
                }}
              >
                {s.label}
              </MenuItem>
            ))}
          </Menu>
        </FloatingLayer>
      ) : null}
    </>
  );
}
