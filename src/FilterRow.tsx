/// 位置页（SKILLS / MCP）的页面头左端与筛选行（spec 2026-09-27-skill-mcp-market R1 R2；DESIGN「位置页 › 页面头」
/// 「筛选行」「更多 列表」）：
/// - 页面头左端的滑槽 `我的 ｜ 发现`（`FaceTabs`），两页各记各的，状态归壳（shell/nav.ts）；
/// - `我的` 下页面头下 10 的一行（`FilterRow`）：左 `位置` 胶囊（`全部` `用户级` + 最近活跃的项目 + `更多 ▾`），
///   右端 `来源：全部 ▾` 下拉（`SourcePicker`，状态归各页，`useSourceFilter`）。这一行不折行。
/// 带业务状态（项目列表、排序记忆），所以是页面层组件，不进 `src/ui`（DESIGN「不进组件库、在页面层合并的」）。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  Chip,
  ChipRow,
  FloatingLayer,
  IconChevronDown,
  Menu,
  MenuItem,
  MenuSeparator,
  Mono,
  SectionLabel,
  Tabs,
  TextField,
  Tooltip,
} from "./ui/index.ts";
import { isProjectKey, type Face, type Location } from "./shell/nav.ts";
import {
  MAX_CHIPS,
  chipProjects,
  fitChips,
  matchProject,
  measuredProjects,
  resolveSource,
  sourceOptions,
  type ScopeProject,
  type SourceOption,
} from "./scopeView.ts";
import { PROJECT_SORTS, type ProjectSort } from "./sidebarProjects.ts";
import { t, tn } from "./i18n.ts";
import { shortPath } from "./pathText.ts";
import "./FilterRow.css";

const faces = (): ReadonlyArray<{ id: Face; label: string }> => [
  { id: "mine", label: t("skills.filter.faceMine") },
  { id: "discover", label: t("skills.filter.faceDiscover") },
];

/// 页面头左端的滑槽：同一类东西的两面——我已有的、外面有的（R1）
export function FaceTabs({ value, onChange }: { value: Face; onChange: (face: Face) => void }) {
  return (
    <Tabs items={faces()} value={value} onChange={onChange} label={t("skills.filter.faceLabel")} />
  );
}

/// 胶囊与右端 `来源` 下拉之间至少留这么宽（同 FilterRow.css 的 `gap`）
const SOURCE_GAP = 16;

export interface FilterRowProps {
  /// 按最近活跃排好的项目（位置胶囊取前几个）
  recent: ReadonlyArray<ScopeProject>;
  /// 按用户选的排序排好的项目（「更多」列表用）
  sorted: ReadonlyArray<ScopeProject>;
  location: Location;
  onLocation: (location: Location) => void;
  sort: ProjectSort;
  onSort: (sort: ProjectSort) => void;
  /// 「更多」列表开没开（状态归壳：应用菜单「切换项目…」⌘P 也开它）
  listOpen: boolean;
  /// ⌘P 第几次：列表已开着时再按，焦点回到搜索框
  listFocus: number;
  onListOpen: (open: boolean) => void;
  /// 右端：这一页的 `来源` 下拉（`useSourceFilter().picker`）
  source?: ReactNode;
  /// 有没有 `全部`（默认有）。安装页的 `位置` 去掉它：装只能装到一个位置（spec R9）
  all?: boolean;
  /// 行首标签（默认 `位置`）；null＝不画（安装页：上面已有同名的区块小标）
  rowLabel?: string | null;
  /// 悬停项目片的提示框写什么（默认项目的完整路径；安装页写这个位置的完整落点）
  tipOf?: (project: ScopeProject) => string;
}

/// 表格上方那一行：`位置` + `全部` `用户级` + 项目 + `更多 ▾` ……… `来源：全部 ▾`。
/// 位置单选，任何时候都有一颗亮着。项目片至多 6 个，这一行放不下时提前收进 `更多`（在隐藏的量尺里量真实的胶囊）。
/// 一个项目都没有时照画 `全部` `用户级`（2026-09-30 产品负责人真机：不画「太空了」；取代 09-29 的「不画」）
export function FilterRow({
  recent,
  sorted,
  location,
  onLocation,
  sort,
  onSort,
  listOpen: open,
  listFocus,
  onListOpen: setOpen,
  source,
  all = true,
  rowLabel = t("skills.filter.place"),
  tipOf = (p) => p.path,
}: FilterRowProps) {
  const selectedProject = isProjectKey(location) ? location : null;
  const rowRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState(MAX_CHIPS);
  const ruled = measuredProjects(recent, selectedProject);
  const ruledKey = ruled.map((p) => `${p.key}\t${p.label}`).join("\n");
  const recentKey = recent.map((p) => p.key).join("\n");

  // 量：整行宽、右端下拉宽、量尺里每一颗胶囊的宽。行变宽窄、字体晚到（量尺变大小）、下拉换了字都重量
  useLayoutEffect(() => {
    const row = rowRef.current;
    const ruler = rulerRef.current;
    if (!row || !ruler) return;
    const measure = () => {
      const items = [...ruler.querySelectorAll<HTMLElement>('[role="listitem"]')].map((el) =>
        el.getBoundingClientRect(),
      );
      // 量尺：（全部、）用户级、候选项目、更多。`fixed` 量到用户级那一颗为止
      const lead = all ? 1 : 0;
      if (items.length !== ruled.length + lead + 2) return;
      const left = ruler.getBoundingClientRect().left;
      const widths = new Map(ruled.map((p, i) => [p.key, items[i + lead + 1].width]));
      const sourceWidth = sourceRef.current?.getBoundingClientRect().width ?? 0;
      setLimit(
        fitChips(recent, selectedProject, {
          width: row.clientWidth - (sourceWidth > 0 ? sourceWidth + SOURCE_GAP : 0),
          fixed: items[lead].right - left,
          gap: items[1].left - items[0].right,
          more: items[items.length - 1].width,
          widthOf: (key) => widths.get(key) ?? 0,
        }),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(ruler);
    if (sourceRef.current) observer.observe(sourceRef.current);
    return () => observer.disconnect();
    // 候选与选中变了才换量法；recent 每次渲染是新数组，按内容比
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruledKey, recentKey, selectedProject, all, rowLabel]);

  const { chips, more } = chipProjects(recent, selectedProject, limit);
  /// 浮层锚在 `更多` 上；没有 `更多`（项目都露出来了）时锚在亮着的那一颗上（⌘P 打开时）
  const moreRef = useRef<HTMLSpanElement>(null);
  // 锚在键本身上：收起时焦点还给它（外面包的 span 拿不到焦点）。挂载后才量得到：⌘P 从 `发现` 过来时
  // 筛选行与列表同一帧出现，第一次渲染时键还不在
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    setAnchor(
      moreRef.current?.querySelector<HTMLElement>("button") ??
        chipsRef.current?.querySelector<HTMLElement>('button[aria-pressed="true"]') ??
        chipsRef.current,
    );
  }, [open, more.length, location]);

  const pathTip = (path: string) => (
    <Mono path inherit>
      {path}
    </Mono>
  );
  return (
    <div className="filter-row" ref={rowRef}>
      <div className="filter-row__chips" ref={chipsRef}>
        <ChipRow
          label={rowLabel ?? undefined}
          listLabel={all ? t("skills.filter.byPlace") : t("skills.filter.place")}
          wrap={false}
        >
          {all ? (
            <Chip selected={location === "all"} onClick={() => onLocation("all")}>
              {t("skills.filter.all")}
            </Chip>
          ) : null}
          <Chip selected={location === "user"} onClick={() => onLocation("user")}>
            {t("skills.scope.user")}
          </Chip>
          {chips.map((p) => (
            <Tooltip key={p.key} content={pathTip(tipOf(p))}>
              <Chip
                selected={location === p.key}
                onClick={() => isProjectKey(p.key) && onLocation(p.key)}
              >
                {p.label}
              </Chip>
            </Tooltip>
          ))}
          {more.length > 0 ? (
            <span ref={moreRef} className="filter-row__more">
              <Chip selected={false} onClick={() => setOpen(!open)}>
                {t("skills.filter.more")}
                <IconChevronDown className="filter-row__chevron" />
              </Chip>
            </span>
          ) : null}
        </ChipRow>
      </div>
      {source ? (
        <div className="filter-row__source" ref={sourceRef}>
          {source}
        </div>
      ) : null}
      {/* 量尺：同一种胶囊排成一行，不占位、看不见、读屏与键盘都到不了 */}
      <div className="filter-row__ruler" ref={rulerRef} aria-hidden="true" inert>
        <ChipRow label={rowLabel ?? undefined} wrap={false}>
          {all ? <Chip>{t("skills.filter.all")}</Chip> : null}
          <Chip>{t("skills.scope.user")}</Chip>
          {ruled.map((p) => (
            <Chip key={p.key}>{p.label}</Chip>
          ))}
          <Chip>
            {t("skills.filter.more")}
            <IconChevronDown className="filter-row__chevron" />
          </Chip>
        </ChipRow>
      </div>
      {open && anchor ? (
        <ProjectList
          anchor={anchor}
          focusRequest={listFocus}
          projects={sorted}
          selected={selectedProject}
          sort={sort}
          onSort={onSort}
          onPick={(key) => {
            if (isProjectKey(key)) onLocation(key);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

/// 「更多」浮层：搜索框 + 排序 + 全部项目（名字 + 短路径，悬停完整路径）。没有添加、没有移除：项目在设置「生效范围」里加、勾不勾。
/// 焦点落在搜索框；↓ 进入列表、回车选中第一条；列表里方向键移动（Menu 自带）；Esc 与点外面收起（FloatingLayer）
export function ProjectList({
  anchor,
  focusRequest,
  projects,
  selected,
  sort,
  onSort,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  /// ⌘P 在列表已经开着时再按：焦点回到搜索框
  focusRequest: number;
  projects: ReadonlyArray<ScopeProject>;
  selected: string | null;
  sort: ProjectSort;
  onSort: (sort: ProjectSort) => void;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // 浮层第一帧是隐藏的（等量好位置），`autoFocus` 落不到隐藏的输入框上：隔一帧再聚焦（同 Menu）
  useEffect(() => {
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);
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
    <FloatingLayer
      trigger={anchor}
      onClose={onClose}
      label={t("skills.filter.switchProject")}
      className="scope-list"
    >
      <div className="scope-list__search">
        <TextField
          search
          value={query}
          onChange={setQuery}
          label={t("skills.filter.searchProject")}
          placeholder={tn("skills.filter.searchProjectCount", projects.length)}
          inputRef={searchRef}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="scope-list__head">
        <SectionLabel
          action={
            <span className="scope-list__sort">
              {PROJECT_SORTS.map((s) => (
                <Chip key={s.id} selected={s.id === sort} onClick={() => onSort(s.id)}>
                  {t(s.labelKey)}
                </Chip>
              ))}
            </span>
          }
        >
          {t("skills.filter.project")}
        </SectionLabel>
      </div>
      <div ref={listRef}>
        <Menu label={t("skills.filter.project")}>
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

/// 筛选行右端的 `来源` 下拉：`来源：` + 当前值（`ink`）+ `˅`，平贴、手靠近出 `surface` 底；
/// 点开是单选菜单（`全部` + 分隔 + 这个位置里有的来源，右侧带条数），右沿对齐触发处
export function SourcePicker({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<SourceOption>;
  /// null＝全部
  value: string | null;
  onChange: (label: string | null) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = () => setAnchor(null);
  const pick = (label: string | null) => {
    onChange(label);
    close();
  };
  return (
    <>
      <button
        type="button"
        className={`filter-source${anchor ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(e) => {
          const at = e.currentTarget;
          setAnchor((prev) => (prev ? null : at));
        }}
      >
        <span className="filter-source__key">{t("skills.filter.sourceKey")}</span>
        <span className="filter-source__value">{value ?? t("skills.filter.all")}</span>
        <IconChevronDown className="filter-source__chevron" />
      </button>
      {anchor ? (
        <FloatingLayer
          trigger={anchor}
          onClose={close}
          label={t("skills.filter.bySource")}
          align="end"
        >
          <Menu autoFocus>
            <MenuItem kind="radio" checked={value === null} onSelect={() => pick(null)}>
              {t("skills.filter.all")}
            </MenuItem>
            {options.length > 0 ? <MenuSeparator /> : null}
            {options.map((o) => (
              <MenuItem
                key={o.label}
                kind="radio"
                checked={value === o.label}
                count={o.count}
                onSelect={() => pick(o.label)}
              >
                {o.label}
              </MenuItem>
            ))}
          </Menu>
        </FloatingLayer>
      ) : null}
    </>
  );
}

/// 一页的来源筛选（R2）：`labels` 是当前位置里每一行的来源名（与「来源」列同一个写法），还没读回来时给 null。
/// 选过的来源不在当前位置里了（换了位置、来源被移除）回到 `全部`，记着的也一并忘掉——之后它再出现也不自己回来
export function useSourceFilter(labels: ReadonlyArray<string> | null) {
  const [picked, setPicked] = useState<string | null>(null);
  const loaded = labels !== null;
  const labelsKey = labels?.join("\n") ?? "";
  const options = useMemo(
    () => sourceOptions(labels ?? []),
    // 每次渲染是新数组，按内容比
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labelsKey],
  );
  const value = resolveSource(picked, options);
  useEffect(() => {
    if (loaded && picked !== null && value === null) setPicked(null);
  }, [loaded, picked, value]);
  return {
    /// 此刻生效的来源；null＝全部
    value,
    /// 这一行留不留（来源名）
    keeps: (label: string) => value === null || label === value,
    /// 回到 `全部`（装完提示的「去处理」：要看的那一行不能被来源筛掉）
    clear: () => setPicked(null),
    picker: <SourcePicker options={options} value={value} onChange={setPicked} />,
  };
}
