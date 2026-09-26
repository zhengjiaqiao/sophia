/// 范围（spec 2026-09-26-object-first-navigation R3 R4 R5）：SKILLS / MCP 页面头左端的滑槽 `全部 ｜ 用户级 ｜ 项目级`，
/// 与表格上方那一行 `项目` 筛选片（前 6 个 + `更多 ▾`）。两页共用同一个范围，状态归壳（shell/nav.ts）。
/// 带业务状态（项目列表、排序记忆），所以是页面层组件，不进 `src/ui`（DESIGN「不进组件库、在页面层合并的」）。
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  Chip,
  ChipRow,
  FloatingLayer,
  IconChevronDown,
  Menu,
  MenuItem,
  Mono,
  SectionLabel,
  Tabs,
  TextField,
  Tooltip,
} from "./ui";
import type { ScopeLevel } from "./shell/nav";
import { chipProjects, matchProject, type ScopeProject } from "./scopeView";
import { PROJECT_SORTS, type ProjectSort } from "./sidebarProjects";
import { shortPath } from "./pathText";
import "./ScopeBar.css";

const LEVELS: ReadonlyArray<{ id: ScopeLevel; label: string }> = [
  { id: "all", label: "全部" },
  { id: "user", label: "用户级" },
  { id: "project", label: "项目级" },
];

/// 选位置（R8）：范围里不止一个位置时，`管理来源`、`+ 来源`、菜单「添加来源…」先弹它，
/// 选好再进原来的流程（来源管理页、添加来源页仍只作用于一个位置）。锚在被按的键上，打开即聚焦第一项
export function PlacePicker({
  anchor,
  places,
  title,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  places: ReadonlyArray<{ key: string; label: string }>;
  title: string;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <FloatingLayer trigger={anchor} onClose={onClose} label="选位置" align="end">
      <Menu autoFocus title={title}>
        {places.map((p) => (
          <MenuItem key={p.key} onSelect={() => onPick(p.key)}>
            {p.label}
          </MenuItem>
        ))}
      </Menu>
    </FloatingLayer>
  );
}

/// 页面头左端的滑槽：换的是范围，不是页（SKILLS / MCP 在侧栏）
export function ScopeTabs({
  value,
  onChange,
}: {
  value: ScopeLevel;
  onChange: (level: ScopeLevel) => void;
}) {
  return <Tabs items={LEVELS} value={value} onChange={onChange} label="范围" />;
}

export interface ProjectChipsProps {
  /// 按最近活跃排好的项目（筛选片取前 6 个）
  recent: ReadonlyArray<ScopeProject>;
  /// 按用户选的排序排好的项目（「更多」列表用）
  sorted: ReadonlyArray<ScopeProject>;
  selected: string | null;
  onSelect: (project: string | null) => void;
  sort: ProjectSort;
  onSort: (sort: ProjectSort) => void;
  /// 每次变化＝打开「更多」列表（应用菜单「切换项目…」⌘P）
  openRequest: number;
}

/// 表格上方那一行：`项目` + `全部` + 前 6 个项目 + `更多 ▾`。单选，任何时候都有一颗亮着
export function ProjectChips({
  recent,
  sorted,
  selected,
  onSelect,
  sort,
  onSort,
  openRequest,
}: ProjectChipsProps) {
  const { chips, more } = chipProjects(recent, selected);
  const [open, setOpen] = useState(false);
  /// 浮层锚在 `更多` 上；没有 `更多`（项目不超过 6 个）时锚在行首标签上（⌘P 打开时）
  const moreRef = useRef<HTMLSpanElement>(null);
  const rowRef = useRef<HTMLSpanElement>(null);
  const lastRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest === lastRequest.current) return;
    lastRequest.current = openRequest;
    setOpen(true);
  }, [openRequest]);
  const anchor = moreRef.current ?? rowRef.current;
  if (recent.length === 0) return null;
  return (
    <span className="scope-chips" ref={rowRef}>
      <ChipRow label="项目" listLabel="按项目筛选">
        <Chip selected={selected === null} onClick={() => onSelect(null)}>
          全部
        </Chip>
        {chips.map((p) => (
          <Tooltip
            key={p.key}
            content={
              <Mono path inherit>
                {p.path}
              </Mono>
            }
          >
            <Chip selected={selected === p.key} onClick={() => onSelect(p.key)}>
              {p.label}
            </Chip>
          </Tooltip>
        ))}
        {more.length > 0 ? (
          <span ref={moreRef} className="scope-chips__more">
            <Chip selected={false} onClick={() => setOpen((v) => !v)}>
              更多
              <IconChevronDown className="scope-chips__chevron" />
            </Chip>
          </span>
        ) : null}
      </ChipRow>
      {open && anchor ? (
        <ProjectList
          anchor={anchor}
          projects={sorted}
          selected={selected}
          sort={sort}
          onSort={onSort}
          onPick={(key) => {
            onSelect(key);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </span>
  );
}

/// 「更多」浮层：搜索框 + 排序 + 全部项目（名字 + 短路径，悬停完整路径）。没有添加、没有移除（R10）。
/// 焦点落在搜索框；↓ 进入列表、回车选中第一条；列表里方向键移动（Menu 自带）；Esc 与点外面收起（FloatingLayer）
function ProjectList({
  anchor,
  projects,
  selected,
  sort,
  onSort,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  projects: ReadonlyArray<ScopeProject>;
  selected: string | null;
  sort: ProjectSort;
  onSort: (sort: ProjectSort) => void;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const shown = projects.filter((p) => matchProject(p, query));
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      listRef.current?.querySelector<HTMLElement>("[role=menuitemradio]")?.focus();
    } else if (e.key === "Enter" && shown.length > 0) {
      e.preventDefault();
      onPick(shown[0].key);
    }
  };
  return (
    <FloatingLayer trigger={anchor} onClose={onClose} label="切换项目" className="scope-list">
      <div className="scope-list__search">
        <TextField
          search
          value={query}
          onChange={setQuery}
          label="搜索项目"
          placeholder={`搜索 ${projects.length} 个项目`}
          autoFocus
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="scope-list__head">
        <SectionLabel
          action={
            <span className="scope-list__sort">
              {PROJECT_SORTS.map((s) => (
                <Chip key={s.id} selected={s.id === sort} onClick={() => onSort(s.id)}>
                  {s.label}
                </Chip>
              ))}
            </span>
          }
        >
          项目
        </SectionLabel>
      </div>
      <div ref={listRef}>
        <Menu label="项目">
          {shown.map((p) => (
            <Tooltip
              key={p.key}
              content={
                <Mono path inherit>
                  {p.path}
                </Mono>
              }
              placement="top"
            >
              <MenuItem
                kind="radio"
                checked={p.key === selected}
                sub={<Mono path>{shortPath(p.path)}</Mono>}
                onSelect={() => onPick(p.key)}
              >
                {p.label}
              </MenuItem>
            </Tooltip>
          ))}
        </Menu>
      </div>
    </FloatingLayer>
  );
}
