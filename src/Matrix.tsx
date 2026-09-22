/// 表格 = 面板（DESIGN「材料与工艺 › 表格 = 面板」「列头与组头的悬停」「格子悬停预览」
/// 「提示框」「键盘」「选择操作条」，画板 Main / Mcp / Empty）。
///
/// Skills 与 MCP **共用这一张表**：两边只是内容不同——行是 skill 或 MCP 服务，列是 agent，
/// 格是同一套状态点。本组件只管形制与交互（通道条表头、按来源分组、十字带、提示框、
/// 键盘、选择操作条、就地提示的锚点），不碰 api、不认后端状态：调用方把一切折算成
/// 「记号 + 能不能点 + 一句话」交进来，点了什么再原样交回去。
///
/// 版式（画板的写法直接当 CSS 抄，见 Matrix.css）：
/// - 名称列定宽 280（勾选 34 + 名字 246），agent 列各 88，MCP 另有 72 的 `传输` 列；
///   所有横线止于最后一列右沿 + 24，工具行的 `+ skill` 右对齐到同一条边
/// - 表头底 2px 结构线；分组之间 1px `ink`；行 1px `hairline`；行高 34
/// - 悬停十字带：行带 + 列带（列带跳过组头——组头不是数据行）
/// - 格子提示框：一行「动词 · 快捷键」，格子正上方 6，停留 700ms；格间移动每格重新计时，
///   所以不追着鼠标；键盘焦点到达同样计时
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { Dot } from "./cellState";
import { compareBy, DOT_RANK, toggleSort, type SortState } from "./sort.ts";
import {
  AgentIcon,
  AgentKey,
  AgentMark,
  Checkbox,
  DOT_LABEL,
  Cap,
  IconCannot,
  IconClose,
  IconSearch,
  Spinner,
  StateDot,
  Switch,
  TIP_DELAY_MS,
  Tooltip,
} from "./ui/index.ts";
import { displayPath } from "./pathText.ts";
import "./Matrix.css";

/// 版式常量，与 Matrix.css 同值（列带要按它算左边距）
const CHECK_W = 34;
const NAME_W = 246;
const COL_W = 88;
const TAIL_W = 24;
const ORIGIN_W = 120;

/// 一格的键：行键 + 列 id。闪烁、就地提示都按它认格
const CELL_SEP = String.fromCharCode(31);
export const cellKey = (rowKey: string, columnId: string) => rowKey + CELL_SEP + columnId;

export interface MatrixColumn {
  id: string;
  /// harness id，决定图标
  agentId: string;
  /// 列头名（Condensed 大写只给拉丁 run，见 Cap）
  name: string;
  /// 列头第三层：这个 agent 下能用的格数（只写分子）
  count: number;
  /// 列头提示框：`Claude Code · 41 个已开启`
  tip: string;
  /// 这一列的目录还不存在：虚线列头（添加时顺手建出来）
  missing?: boolean;
}

export interface MatrixCellView {
  dot: Dot;
  /// 点下去会做事（开关、写进、重新链接）；false 时点击无动作，只由提示框说原因
  clickable: boolean;
  /// 提示框一行：可点时是「动词」（`点一下开启`），不可点时是原因
  tip: string;
  /// 操作进行中：画成灰色的将来状态（进度就是格子依次点亮）
  pending?: boolean;
}

export interface MatrixRowView {
  key: string;
  name: string;
  /// 原件位置 / 来源位置格：来源名（同名来源用区分片段）+ 完整路径；悬停出路径提示框与 `打开 ↗`
  origin: { id: string; label: string; path: string; onReveal: () => void };
  /// 列 id → 格；null＝这一行在这一列没有格（短横，不可点）
  cells: Record<string, MatrixCellView | null>;
  /// 名字后的标注：`×2`（提示框同时列两份读数）、`2 份不一样`、`Codex 不支持`
  mark?: ReactNode;
  /// 同名组：悬停（或键盘焦点）任一行，同组的行一起亮，并出 `extra`
  dupGroup?: string;
  /// 同名行悬停时的动作（`只留这份`），在名称格里。不越过面板右沿——
  /// 判断用的读数进 `×2` 的提示框
  extra?: ReactNode;
  /// 点名字就地展开的详情（描述 / 路径 + 打开 ↗ / 改于 …）；不给就不能展开
  detail?: ReactNode;
  /// MCP 的 `传输` 列内容
  transport?: ReactNode;
  /// 非空＝这一行勾不动，值是原因
  selectDisabledReason?: string;
  /// 非空＝这一行正在操作：名字后 14px 转盘，句子进读屏与悬停
  busy?: string;
}

/// 选择操作条上的一颗**动词键**：对已选的，在这一列做这件事（DESIGN「选择操作条」）。
/// `关闭 ✳ CLAUDE CODE` / `开启 ⎔ CODEX · 2 个`；「全部」键没有 agent：`全部开启`
export interface SelectionKey {
  id: string;
  /// harness id，画列头同一枚图标；没有就是「全部」键
  agentId?: string;
  /// agent 名（Condensed 大写，跟随列头）；「全部」键不给
  name?: string;
  /// 中文动词：`开启` `关闭` `写进` `全部开启` `全部关闭`
  verb: string;
  /// 受影响数 ≠ 已选数时才给，写成 `· N 个`
  count?: number;
  /// 没有能做的动作：禁用，提示框说原因
  disabledReason?: string;
  /// 提示框：按下会怎样
  tip?: string;
  onPress: () => void;
}

export interface MatrixProps {
  columns: MatrixColumn[];
  /// 原件位置列：列头文字（`原件位置` / `来源位置`）
  originLabel: string;
  /// 按位置筛选中：列头写 `原件位置 · 通用仓库 ×`
  originFilter?: { label: string; onClear: () => void } | null;
  /// 列头 ▾ 下拉的内容（全部 N / 各来源行 + 规则）。`hint` 让规则行悬停时作用列列头轻亮
  originMenu?: (ctl: { close: () => void; hint: (columnIds: string[]) => void }) => ReactNode;
  rows: MatrixRowView[];
  /// 名称列头：`名称` / `服务`
  nameLabel: string;
  /// 名称列头的提示框（机制说明放这里，不放常驻说明条）
  nameTip?: string;
  /// 名称列头后的总数（`名称 56`，等宽 ink-faint）；替代删掉的「全部 N」筛选片
  nameCount?: number;
  /// MCP 的 `传输` 列（72）
  transportLabel?: string;

  filterText: string;
  onFilterText: (text: string) => void;
  /// 工具行右端的 `+ skill` / `+ MCP`，右沿对齐面板右沿
  addButton?: ReactNode;

  /// 选中的行键
  selected: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  /// 选择操作条：每列一颗键 + 「全部」
  selectionKeys: SelectionKey[];
  selectionAll?: SelectionKey;

  busy: boolean;
  onCell: (rowKey: string, columnId: string) => void;
  onUndo?: () => void;
  /// 键盘快捷键是否生效（二级页面盖在上面时关掉）
  shortcuts?: boolean;

  /// 一行都没有时，表头下面放什么（空态）
  empty?: ReactNode;
  /// 刚变化的格：播一次 120ms 反色闪，`nonce` 变了才重播；`stagger` 毫秒依次亮
  flash?: { keys: string[]; nonce: number; stagger?: number };
  /// 单格失败：格子下方的小黑窗
  cellNotice?: { rowKey: string; columnId: string; text: string } | null;
  /// 贴在某一行下方的提示条（只留这份 · 撤销）
  rowToast?: { rowKey: string; node: ReactNode } | null;
  /// 贴在被按下的键下方 4、右对齐该键的提示条（批量结果）
  keyToast?: { keyId: string; node: ReactNode } | null;
  /// 无关位置的全局事（自动规则）：右下，右沿对齐面板右沿
  globalToast?: ReactNode;
  /// 从待处理页跳回来：滚到这几行（或这一列的列头）并闪一下（⑦）。`nonce` 变了才重做
  focus?: { rowKeys: string[]; columnId?: string; nonce: number } | null;
}

/// 一格的身份（行的来源 + 名字 + 列）
type CellLike = { sourceId: string; skill: string; targetId: string };

/// 「全部」的效果恰好等于某一颗 agent 键（同一个动作、同一批格）时，这颗「全部」是噪音，隐藏
export function duplicatesAKey(
  all: { op: string; cells: CellLike[] },
  presses: { op: string; cells: CellLike[] }[],
): boolean {
  const key = (c: CellLike) => `${c.sourceId}|${c.skill}|${c.targetId}`;
  const mine = new Set(all.cells.map(key));
  return presses.some(
    (p) =>
      p.op === all.op && p.cells.length === mine.size && p.cells.every((c) => mine.has(key(c))),
  );
}

/// 把键盘焦点格夹回当前表的范围：取最近的有效行和列。表为空（没有行或没有列）时返回 null
export function clampFocus(
  focus: { r: number; c: number },
  rows: number,
  cols: number,
): { r: number; c: number } | null {
  if (rows <= 0 || cols <= 0) return null;
  return {
    r: Math.max(0, Math.min(rows - 1, focus.r)),
    c: Math.max(0, Math.min(cols - 1, focus.c)),
  };
}

/// 行内忙碌：14px 细弧，句子进提示框与读屏文本（DESIGN「忙碌指示」）。完成即消失
function InlineBusy({ label }: { label?: string }) {
  if (label === undefined) return null;
  return (
    <Tooltip content={label} context="table">
      <span className="mx-busy" role="status">
        <Spinner size={14} label={label} />
      </span>
    </Tooltip>
  );
}

/// 展开记号：12px 实心三角，▸ 收起 / ▾ 展开。不在悬停也没展开时占位不显示（名字不跳）
function Disclosure({ open, shown }: { open: boolean; shown: boolean }) {
  return (
    <svg
      className="mx-disclosure"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      style={{
        transform: open ? "rotate(90deg)" : undefined,
        visibility: shown ? "visible" : "hidden",
      }}
    >
      <path d="M4 2.5 8.5 6 4 9.5Z" fill="currentColor" />
    </svg>
  );
}

/// `打开 ↗`：12 ink-mute，悬停转 ink 加下划线；点一下在访达中显示。提示框是完整路径
export function RevealLink({ path, onReveal }: { path: string; onReveal: () => void }) {
  return (
    <Tooltip content={<span className="mx-mono">{displayPath(path)}</span>}>
      <button
        type="button"
        className="mx-reveal"
        aria-label={`在访达中显示 ${displayPath(path)}`}
        onClick={onReveal}
      >
        打开
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 7l4-4M3.6 3H7v3.4" />
        </svg>
      </button>
    </Tooltip>
  );
}

/// 排序箭头：默认不占眼（占位不抽走，hover 时行不跳），hover 出淡箭头，激活转黑
function SortArrow({ active, desc }: { active: boolean; desc: boolean }) {
  return (
    <svg
      className={`mx-sort${active ? " is-active" : ""}`}
      width="8"
      height="8"
      viewBox="0 0 8 8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <path d={desc ? "M1.4 2.8L4 5.4l2.6-2.6" : "M1.4 5.2L4 2.6l2.6 2.6"} />
    </svg>
  );
}

/// 规则图式里的箭头：来源 → 目标
function RuleArrow() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 8h10.5M9 4l4 4-4 4" />
    </svg>
  );
}

/// 选择操作条上的动词键：动词（按钮字）+ 列头同一枚图标 + agent 名（Condensed 大写）+ 可选数量。
/// 不画圆点、不写 ±N（圆点在按钮上读成「已选中」，−1 读成负数，都要解码）。
/// `iconOnly`：最后一级降级，名字进提示框
function KeyButton({ k, iconOnly }: { k: SelectionKey; iconOnly: boolean }) {
  const disabled = k.disabledReason !== undefined;
  const count = k.count !== undefined ? ` · ${k.count} 个` : "";
  const label = `${k.verb}${k.name ? ` ${k.name}` : ""}${count}`;
  const button = (
    <button
      type="button"
      className="ss-btn mx-key"
      disabled={disabled}
      aria-label={disabled ? `${label}：${k.disabledReason}` : label}
      onClick={disabled ? undefined : k.onPress}
    >
      <span>{k.verb}</span>
      {k.agentId ? <AgentIcon id={k.agentId} name={k.name ?? ""} size={14} /> : null}
      {k.name && !iconOnly ? (
        <span className="mx-keyname">
          <Cap>{k.name}</Cap>
        </span>
      ) : null}
      {count ? <span className="mx-keycount">{count}</span> : null}
    </button>
  );
  const tipText = disabled ? k.disabledReason : k.tip;
  const tip = iconOnly && k.name ? (tipText ? `${k.name} · ${tipText}` : k.name) : tipText;
  // 提示框默认在上方，放不下时 Tooltip 自己翻到下方
  return tip ? <Tooltip content={tip}>{button}</Tooltip> : button;
}

export default function Matrix(props: MatrixProps) {
  const {
    columns,
    originLabel,
    originFilter,
    originMenu,
    rows,
    nameLabel,
    nameTip,
    transportLabel,
    filterText,
    onFilterText,
    nameCount,
    addButton,
    selected,
    onSelectionChange,
    selectionKeys,
    selectionAll,
    busy,
    onCell,
    onUndo,
    shortcuts = true,
    empty,
    flash,
    cellNotice,
    rowToast,
    keyToast,
    globalToast,
    focus: jump,
  } = props;

  const tipId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // 默认排序：名称升序，同名两份天然相邻（DESIGN「默认值」）
  // null＝默认（名称升序），表头不画箭头；点过才画（DESIGN「表头排序」）
  const [sortState, setSort] = useState<SortState | null>(null);
  const sort: SortState = sortState ?? { key: "name", dir: "asc" };
  // 悬停的格（十字带）/ 列头（列带）/ 下拉里规则行（作用列轻亮）/ 同名组
  const [hover, setHover] = useState<{ row: string; col: string | null } | null>(null);
  const [headHover, setHeadHover] = useState<string | null>(null);
  const [hintCols, setHintCols] = useState<string[]>([]);
  // 键盘焦点所在格（行序号、列序号），以及焦点此刻在不在表身里
  // 键盘焦点（roving tabindex）存的原值；用时一律经 clampFocus 夹回当前表的范围
  const [focusRaw, setFocus] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const [focusWithin, setFocusWithin] = useState(false);
  // 提示框：停够 700ms 的那一格
  const [tip, setTip] = useState<string | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 正在闪的格
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  // Shift 区间选择的锚点
  const anchor = useRef<string | null>(null);
  const shift = useRef(false);
  // 全局提示条的右沿：对齐面板右沿
  const [toastRight, setToastRight] = useState(32);
  // 吸顶：工具行（勾选时是选择条）在最上面，列头紧贴它下面
  const barRef = useRef<HTMLDivElement>(null);
  const [barH, setBarH] = useState(0);
  // 原件位置列头 ▾ 下拉
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // 就地展开详情的那一行（一次只展开一行）
  const [expanded, setExpanded] = useState<string | null>(null);

  const hasTransport = transportLabel !== undefined;
  const template = [
    `${CHECK_W}px`,
    `${NAME_W}px`,
    ...(hasTransport ? ["72px"] : []),
    `${ORIGIN_W}px`,
    ...columns.map(() => `${COL_W}px`),
    `${TAIL_W}px`,
  ].join(" ");
  const lead = CHECK_W + NAME_W + (hasTransport ? 72 : 0) + ORIGIN_W;
  const width = lead + columns.length * COL_W + TAIL_W;
  const colLeft = (index: number) => lead + index * COL_W;
  const gridStyle: CSSProperties = { gridTemplateColumns: template };

  // ---- 排序：名称 / 原件位置 / 某一列的格；同值再按名称、位置，同名两份相邻 ----
  const byName = compareBy((r: MatrixRowView) => r.name, "asc");
  const byOrigin = compareBy((r: MatrixRowView) => r.origin.label, "asc");
  const primary =
    sort.key === "name"
      ? compareBy((r: MatrixRowView) => r.name, sort.dir)
      : sort.key === "origin"
        ? compareBy((r: MatrixRowView) => r.origin.label, sort.dir)
        : compareBy((r: MatrixRowView) => DOT_RANK[r.cells[sort.key]?.dot ?? "none"], sort.dir);
  // 键盘在格间移动按这个顺序
  const flat = [...rows].sort((a, b) => primary(a, b) || byName(a, b) || byOrigin(a, b));
  const rowIndex = new Map(flat.map((row, i) => [row.key, i]));
  // 筛选让行变少、列数变了之后，焦点格可能落在表外——那样整张表没有一个 tabIndex=0 的格，
  // Tab 键会直接跳过整张表。所以每次渲染都夹回最近的有效格；表为空时没有格可夹
  const focus = clampFocus(focusRaw, flat.length, columns.length) ?? { r: 0, c: 0 };

  const selectable = flat.filter((row) => row.selectDisabledReason === undefined);
  const selectedVisible = flat.filter((row) => selected.has(row.key));
  const allChecked: boolean | "mixed" =
    selectable.length > 0 && selectable.every((row) => selected.has(row.key))
      ? true
      : selectedVisible.length > 0
        ? "mixed"
        : false;

  // ---- 闪烁：nonce 变了就把这批格加进来，animationend 时各自拿掉 ----
  const flashNonce = flash?.nonce;
  useEffect(() => {
    if (!flash || flash.keys.length === 0) return;
    const stagger = flash.stagger ?? 0;
    if (stagger === 0) {
      setFlashing(new Set(flash.keys));
      return;
    }
    // 依次点亮：一格接一格，那就是进度
    const timers = flash.keys.map((key, i) =>
      setTimeout(() => setFlashing((prev) => new Set(prev).add(key)), i * stagger),
    );
    return () => timers.forEach(clearTimeout);
    // 只跟 nonce：同一批 keys 的数组身份每次渲染都会变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flashNonce]);
  // ---- 跳回：滚到那一行并闪一下 ----
  const [flashRows, setFlashRows] = useState<Set<string>>(new Set());
  const [flashCol, setFlashCol] = useState<string | null>(null);
  const jumpNonce = jump?.nonce;
  useEffect(() => {
    if (!jump) return;
    setFlashRows(new Set(jump.rowKeys));
    setFlashCol(jump.rowKeys.length === 0 ? (jump.columnId ?? null) : null);
    scrollToJump(jump);
    // 只跟 nonce
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpNonce]);
  const scrollToJump = (target: { rowKeys: string[]; columnId?: string }) => {
    const root = rootRef.current;
    const first = target.rowKeys[0];
    const el =
      first !== undefined
        ? root?.querySelector(`[data-row="${CSS.escape(first)}"]`)
        : target.columnId !== undefined
          ? root?.querySelector(`[data-col="${CSS.escape(target.columnId)}"]`)
          : null;
    el?.scrollIntoView({ block: "center" });
  };

  const endFlash = (key: string) =>
    setFlashing((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });

  // ---- 提示框计时：每进一格重新计时，所以格间移动时不出现 ----
  const armTip = (key: string) => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    setTip(null);
    tipTimer.current = setTimeout(() => setTip(key), TIP_DELAY_MS.table);
  };
  const dropTip = () => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = null;
    setTip(null);
  };
  useEffect(() => () => dropTip(), []);

  // ---- 下拉：点外面关闭 ----
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
        setHintCols([]);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  // ---- 吸顶的列头高度、面板右侧余量 ----
  useLayoutEffect(() => {
    const measure = () => {
      if (barRef.current) setBarH(barRef.current.offsetHeight);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [width, columns.length]);

  // ---- 全局提示条贴面板右沿 ----
  useLayoutEffect(() => {
    if (!globalToast) return;
    const measure = () => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (rect) setToastRight(Math.max(16, window.innerWidth - rect.right));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [globalToast, width]);

  // ---- 选择 ----
  const toggleRow = (row: MatrixRowView) => {
    const want = !selected.has(row.key);
    const from =
      shift.current && anchor.current !== null ? rowIndex.get(anchor.current) : undefined;
    const to = rowIndex.get(row.key) ?? 0;
    const span =
      from !== undefined ? flat.slice(Math.min(from, to), Math.max(from, to) + 1) : [row];
    const next = new Set(selected);
    for (const r of span) {
      if (r.selectDisabledReason !== undefined) continue;
      if (want) next.add(r.key);
      else next.delete(r.key);
    }
    anchor.current = row.key;
    onSelectionChange(next);
  };
  const setAll = (want: boolean) => {
    const next = new Set(selected);
    for (const r of selectable) {
      if (want) next.add(r.key);
      else next.delete(r.key);
    }
    onSelectionChange(next);
  };

  // ---- 键盘：方向键在格间移动，焦点环在格上，十字带跟随 ----
  const focusCell = (r: number, c: number) => {
    const rr = Math.max(0, Math.min(flat.length - 1, r));
    const cc = Math.max(0, Math.min(columns.length - 1, c));
    setFocus({ r: rr, c: cc });
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-cell="${rr}:${cc}"]`);
    el?.focus();
  };
  const onBodyKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const move = moves[e.key];
    if (!move || flat.length === 0 || columns.length === 0) return;
    e.preventDefault();
    focusCell(focus.r + move[0], focus.c + move[1]);
  };

  // ⌘F 筛选、⌘Z 撤销、⌘A 全选当前组、Esc 取消选择
  const live = useRef({ onUndo, onSelectionChange, selected, flat, menuOpen, expanded });
  live.current = { onUndo, onSelectionChange, selected, flat, menuOpen, expanded };
  useEffect(() => {
    if (!shortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;
      const s = live.current;
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
        return;
      }
      if (typing) return;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "z" && s.onUndo) {
        e.preventDefault();
        s.onUndo();
        return;
      }
      // ⌘A 只在焦点就在表里时接管：在页面别处按 ⌘A 不该悄悄勾上一整组
      if (mod && e.key.toLowerCase() === "a" && rootRef.current?.contains(document.activeElement)) {
        // 没有分组了：全选当前可见的行
        if (s.flat.length === 0) return;
        e.preventDefault();
        const next = new Set(s.selected);
        for (const r of s.flat) {
          if (r.selectDisabledReason === undefined) next.add(r.key);
        }
        s.onSelectionChange(next);
        return;
      }
      // Esc：先收起下拉 / 展开的行，再取消选择
      if (e.key === "Escape" && (s.menuOpen || s.expanded !== null)) {
        e.preventDefault();
        setMenuOpen(false);
        setExpanded(null);
        return;
      }
      if (e.key === "Escape" && s.selected.size > 0) {
        e.preventDefault();
        s.onSelectionChange(new Set());
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shortcuts]);

  // ---- 十字带：悬停优先，其次键盘焦点 ----
  const focusRow = focusWithin ? flat[focus.r] : undefined;
  const activeRow = hover?.row ?? focusRow?.key ?? null;
  const activeCol =
    (hover ? hover.col : focusWithin ? (columns[focus.c]?.id ?? null) : null) ?? headHover;
  const activeDup =
    flat.find((r) => r.key === activeRow)?.dupGroup ??
    (focusRow !== undefined ? focusRow.dupGroup : undefined);
  const bandIndex = activeCol === null ? -1 : columns.findIndex((c) => c.id === activeCol);

  // ---- 工具行 / 选择操作条（同一个 28 槽位） ----
  const selecting = selectedVisible.length > 0;
  const selRef = useRef<HTMLDivElement>(null);
  // 放不下时的降级（「全部」与某颗键重复时由调用方直接不给）：
  // 1 键距收到 4 → 2「已选 N 个」缩成「N 个」→ 3 agent 名只留图标。列数变了从头量
  const [fit, setFit] = useState(0);
  useLayoutEffect(() => setFit(0), [columns.length, width, selectionAll === undefined]);
  useLayoutEffect(() => {
    const el = selRef.current;
    if (!selecting || !el || fit >= 3) return;
    if (el.scrollWidth > el.clientWidth + 1) setFit((f) => f + 1);
  });
  const toolbar = selecting ? (
    // 选择操作条「顶替工具行」：`+ skill` / `+ MCP` 不出现，收在面板右沿之内
    <div
      className={`mx-toolbar mx-toolbar--select${fit >= 1 ? " is-tight" : ""}`}
      ref={selRef}
      style={{ width }}
    >
      <span className="mx-selcount">
        {fit >= 2 ? null : "已选 "}
        <span className="mx-mono">{selectedVisible.length}</span> 个
      </span>
      <span className={`mx-keys${busy ? " ss-busy" : ""}`}>
        {[...selectionKeys, ...(selectionAll ? [selectionAll] : [])].map((k) => (
          <span key={k.id} className="mx-keywrap">
            <KeyButton k={k} iconOnly={fit >= 3} />
            {keyToast?.keyId === k.id ? <div className="mx-keytoast">{keyToast.node}</div> : null}
          </span>
        ))}
      </span>
      {/* 取消选择是 busy 的豁免项：它不写磁盘 */}
      <button
        type="button"
        className="ss-btn ss-btn--link mx-clear"
        onClick={() => onSelectionChange(new Set())}
      >
        取消选择
      </button>
    </div>
  ) : (
    // 工具行只有筛选框（弹性，最小 200）+ 右端添加键；来源筛选片已删——表格按来源分组，
    // 片与组头重复表达同一信息，按来源看靠组头折叠
    <div className="mx-toolbar" style={{ width }}>
      {/* 筛选输入框不受 busy 约束（§6）；✕ 在框内 8px 以内 */}
      <label className="mx-filter">
        <IconSearch size={12} />
        <input
          ref={filterRef}
          type="text"
          placeholder="筛选"
          aria-label="筛选"
          value={filterText}
          onChange={(e) => onFilterText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filterText !== "") {
              e.stopPropagation();
              onFilterText("");
            }
          }}
        />
        {filterText !== "" ? (
          <button
            type="button"
            className="mx-filter__clear"
            title="清除筛选"
            aria-label="清除筛选"
            onClick={() => onFilterText("")}
          >
            <IconClose size={12} />
          </button>
        ) : null}
      </label>
      {addButton ? (
        <span className={`mx-toolbar__end${busy ? " ss-busy" : ""}`}>{addButton}</span>
      ) : null}
    </div>
  );

  // ---- 表头 ----
  const sortBy = (key: string) => setSort((prev) => toggleSort(prev ?? sort, key));
  const header = (
    <div className="mx-grid mx-head" style={{ ...gridStyle, top: barH }}>
      <div className="mx-head__check">
        {/* 表头整行不置灰，只灰这个全选框（§6 第二条细节） */}
        {selectable.length === 0 ? (
          <Checkbox checked={false} label="全选" disabledReason="没有可以勾选的行" />
        ) : (
          <Checkbox
            checked={allChecked}
            label="全选"
            onChange={() => setAll(allChecked !== true)}
          />
        )}
      </div>
      <div className="mx-head__name">
        {/* 表头排序 busy 期间照常可点：排序不写磁盘 */}
        {nameTip ? (
          <Tooltip content={nameTip} context="table">
            <button type="button" className="mx-headbtn" onClick={() => sortBy("name")}>
              {nameLabel}
              {nameCount !== undefined ? <span className="mx-namecount">{nameCount}</span> : null}
              <SortArrow active={sortState?.key === "name"} desc={sort.dir === "desc"} />
            </button>
          </Tooltip>
        ) : (
          <button type="button" className="mx-headbtn" onClick={() => sortBy("name")}>
            {nameLabel}
            {nameCount !== undefined ? <span className="mx-namecount">{nameCount}</span> : null}
            <SortArrow active={sortState?.key === "name"} desc={sort.dir === "desc"} />
          </button>
        )}
      </div>
      {hasTransport ? <div className="mx-head__label">{transportLabel}</div> : null}
      {/* 原件位置：点文字按位置排序，点 ▾ 打开下拉（自动添加规则 + 按来源筛选） */}
      <div className="mx-head__origin" ref={menuRef}>
        <button type="button" className="mx-headbtn" onClick={() => sortBy("origin")}>
          {originLabel}
          {originFilter ? null : (
            <SortArrow active={sortState?.key === "origin"} desc={sort.dir === "desc"} />
          )}
        </button>
        {originFilter ? (
          <span className="mx-originfilter">
            <span>· {originFilter.label}</span>
            <button
              type="button"
              className="mx-originfilter__clear"
              title="清除按位置筛选"
              aria-label="清除按位置筛选"
              onClick={originFilter.onClear}
            >
              <IconClose size={10} />
            </button>
          </span>
        ) : null}
        {originMenu ? (
          <button
            type="button"
            className={`mx-menubtn${menuOpen ? " is-open" : ""}`}
            aria-expanded={menuOpen}
            aria-haspopup="dialog"
            aria-label={`${originLabel}：自动添加规则与按位置筛选`}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M2.2 3.8 5 6.6l2.8-2.8" />
            </svg>
          </button>
        ) : null}
        {menuOpen && originMenu ? (
          <div className="mx-menu" role="dialog" aria-label={originLabel}>
            {originMenu({
              close: () => {
                setMenuOpen(false);
                setHintCols([]);
              },
              hint: setHintCols,
            })}
          </div>
        ) : null}
      </div>
      {columns.map((col) => {
        const classes = ["mx-head__col"];
        // 列头只回应列头自己的悬停；格子的十字带不点亮列头（画板 Main）
        if (headHover === col.id) classes.push("is-hot");
        else if (hintCols.includes(col.id)) classes.push("is-hint");
        if (flashCol === col.id) classes.push("mx-jump");
        return (
          <div
            key={col.id}
            data-col={col.id}
            onAnimationEnd={() => setFlashCol(null)}
            className={classes.join(" ")}
            onMouseEnter={() => setHeadHover(col.id)}
            onMouseLeave={() => setHeadHover((prev) => (prev === col.id ? null : prev))}
          >
            <Tooltip content={col.tip} context="table">
              <button
                type="button"
                className={`mx-colbtn${col.missing ? " is-missing" : ""}`}
                aria-label={`${col.tip}，按这一列排序`}
                onClick={() => sortBy(col.id)}
              >
                <AgentMark
                  id={col.agentId}
                  name={col.name}
                  layout="header"
                  count={col.count}
                  dim={col.missing}
                />
                <SortArrow active={sortState?.key === col.id} desc={sort.dir === "desc"} />
              </button>
            </Tooltip>
          </div>
        );
      })}
      <div />
    </div>
  );

  // ---- 表身 ----
  const renderRow = (row: MatrixRowView) => {
    const r = rowIndex.get(row.key) ?? 0;
    const isSelected = selected.has(row.key);
    const hot = activeRow === row.key || (row.dupGroup !== undefined && row.dupGroup === activeDup);
    const classes = ["mx-grid", "mx-row"];
    if (isSelected) classes.push("is-selected");
    if (hot) classes.push("is-hot");
    if (flashRows.has(row.key)) classes.push("mx-jump");
    const showExtra = row.extra !== undefined && hot;
    const open = expanded === row.key && row.detail !== undefined;

    return (
      <Fragment key={row.key}>
        <div
          data-row={row.key}
          className={classes.join(" ")}
          style={gridStyle}
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget)
              setFlashRows((prev) => {
                if (!prev.has(row.key)) return prev;
                const next = new Set(prev);
                next.delete(row.key);
                return next;
              });
          }}
          onMouseEnter={() => setHover({ row: row.key, col: null })}
          onMouseLeave={() => setHover(null)}
        >
          <div
            className="mx-row__check"
            onClickCapture={(e) => {
              shift.current = e.shiftKey;
            }}
          >
            {row.selectDisabledReason !== undefined ? (
              <Checkbox
                checked={false}
                label={`勾选 ${row.name}`}
                disabledReason={row.selectDisabledReason}
              />
            ) : (
              <Checkbox
                checked={isSelected}
                label={`勾选 ${row.name}`}
                onChange={() => toggleRow(row)}
              />
            )}
          </div>
          <div className="mx-row__name">
            {row.detail !== undefined ? (
              <button
                type="button"
                className="mx-namebtn"
                aria-expanded={open}
                aria-label={`${row.name}，${open ? "收起详情" : "展开详情"}`}
                onClick={() => setExpanded(open ? null : row.key)}
              >
                <Disclosure open={open} shown={open || hot} />
                <span className="mx-name">{row.name}</span>
              </button>
            ) : (
              <span className="mx-name mx-name--plain">{row.name}</span>
            )}
            {row.mark}
            {showExtra ? <span className="mx-extra">{row.extra}</span> : null}
            <InlineBusy label={row.busy} />
          </div>
          {hasTransport ? <div className="mx-row__transport">{row.transport}</div> : null}
          {/* 原件位置：写来源名；悬停出完整路径提示框与 `打开 ↗`（这一行已展开时只出提示框） */}
          <div className="mx-row__origin">
            <Tooltip
              content={
                <>
                  <div>{row.origin.label}</div>
                  <div className="mx-mono">{displayPath(row.origin.path)}</div>
                </>
              }
              context="table"
            >
              <span className="mx-origin" tabIndex={-1}>
                {row.origin.label}
              </span>
            </Tooltip>
            {hot && !open ? (
              <RevealLink path={row.origin.path} onReveal={row.origin.onReveal} />
            ) : null}
          </div>
          {columns.map((col, c) => {
            const view = row.cells[col.id] ?? null;
            const key = cellKey(row.key, col.id);
            const cellClasses = ["mx-cell"];
            if (flashing.has(key)) cellClasses.push("ss-flash");
            const notice =
              cellNotice && cellNotice.rowKey === row.key && cellNotice.columnId === col.id
                ? cellNotice.text
                : null;
            const focused = focus.r === r && focus.c === c;
            const enter = () => {
              setHover({ row: row.key, col: col.id });
              armTip(key);
            };
            return (
              <div
                key={col.id}
                className={cellClasses.join(" ")}
                onMouseEnter={enter}
                onMouseLeave={() => {
                  setHover({ row: row.key, col: null });
                  dropTip();
                }}
                onAnimationEnd={() => endFlash(key)}
              >
                {view === null ? (
                  <span
                    className="mx-cellbtn is-inert"
                    data-cell={`${r}:${c}`}
                    tabIndex={focused ? 0 : -1}
                    role="img"
                    aria-label={`${row.name} · ${col.name}：这一列没有这一格`}
                    onFocus={() => {
                      setFocus({ r, c });
                      armTip(key);
                    }}
                    onBlur={dropTip}
                  >
                    <StateDot dot="none" title="" label="无此格" />
                  </span>
                ) : (
                  <button
                    type="button"
                    className={`ss-dot-btn mx-cellbtn${view.clickable ? "" : " is-inert"}`}
                    data-cell={`${r}:${c}`}
                    tabIndex={focused ? 0 : -1}
                    aria-label={`${row.name} · ${col.name}：${DOT_LABEL[view.dot]}。${view.tip}`}
                    aria-describedby={tip === key ? `${tipId}-tip` : undefined}
                    onFocus={() => {
                      setFocus({ r, c });
                      armTip(key);
                    }}
                    onBlur={dropTip}
                    onClick={() => {
                      dropTip();
                      if (view.clickable) onCell(row.key, col.id);
                    }}
                  >
                    <StateDot
                      dot={view.dot}
                      preview={view.clickable && !view.pending}
                      muted={view.pending}
                      title=""
                      label={DOT_LABEL[view.dot]}
                    />
                  </button>
                )}
                {tip === key && view !== null ? (
                  <span
                    id={`${tipId}-tip`}
                    role="tooltip"
                    className={`ss-tip ${r === 0 ? "ss-tip--bottom" : "ss-tip--top"} ss-tip--center is-open`}
                  >
                    {view.tip}
                    {view.clickable ? (
                      <>
                        {" · "}
                        <span className="ss-tip__key">空格</span>
                      </>
                    ) : null}
                  </span>
                ) : null}
                {notice !== null ? (
                  <span className="mx-cellnotice" role="alert">
                    <IconCannot size={12} />
                    {notice}
                  </span>
                ) : null}
              </div>
            );
          })}
          <div />
          {rowToast?.rowKey === row.key ? <div className="mx-rowtoast">{rowToast.node}</div> : null}
        </div>
        {open ? (
          // 就地展开：左沿与名字对齐，不跨进 agent 列
          <div className="mx-grid mx-detail" style={gridStyle}>
            <div
              className="mx-detail__body"
              style={{ gridColumn: `2 / span ${hasTransport ? 3 : 2}` }}
            >
              {row.detail}
            </div>
          </div>
        ) : null}
      </Fragment>
    );
  };

  return (
    <div className="mx" ref={rootRef}>
      {/* 工具行 / 选择条吸顶：共用一个槽位，滚动之后也要点得到 */}
      <div className="mx-bar" ref={barRef}>
        {toolbar}
      </div>
      <div className="mx-panel" ref={panelRef} style={{ width }}>
        {header}
        <div
          className="mx-body"
          ref={bodyRef}
          onKeyDown={onBodyKey}
          onFocus={(e) => {
            // 十字带只跟随键盘焦点：鼠标点过的格子留着焦点，但鼠标移开后不该再亮着
            const target = e.target as HTMLElement;
            setFocusWithin(target.matches(":focus-visible"));
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
          }}
        >
          {bandIndex >= 0 && flat.length > 0 ? (
            <div className="mx-band" style={{ left: colLeft(bandIndex) }} aria-hidden="true" />
          ) : null}
          {flat.map(renderRow)}
        </div>
        {flat.length === 0 && empty ? <div className="mx-empty">{empty}</div> : null}
      </div>
      {globalToast ? (
        <div className="mx-globaltoast" style={{ right: toastRight }}>
          {globalToast}
        </div>
      ) : null}
    </div>
  );
}

/// 原件位置列头下拉里的一个来源（DESIGN「材料与工艺」：自动添加规则在列头下拉里）
export interface OriginMenuSource {
  id: string;
  label: string;
  /// 完整路径，进提示框
  title?: string;
  count: number;
  rule: {
    on: boolean;
    /// 目标列 id；关着时是「打开会用哪些」（上次用的，没有则已安装的前两个）
    targets: string[];
    /// 可选的目标（列 id + agent 图标）
    available: { id: string; agentId: string; name: string }[];
    onToggle: (next: boolean) => void;
    onTargets: (ids: string[]) => void;
    /// 规则设不上（读不到来源等）：行内黑窗说原因
    error?: string | null;
    disabledReason?: string;
  };
}

/// 列头下拉：顶部 `全部 N`（选中反色）；每个来源一行
/// `名字 N · 以后新出现的 → [目标图标组] [紧凑开关]`。点来源名＝按它筛选；点图标组就地弹出
/// agent 图标键改目标（与添加页同组件，至少留一个）；规则关着这一段 ink-faint，开关可以直接打开
export function OriginMenu({
  total,
  selected,
  onSelect,
  sources,
  hint,
  close,
}: {
  total: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  sources: OriginMenuSource[];
  hint: (columnIds: string[]) => void;
  close: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  // 列表行的提示框放在该行同一行的空白处（规则段左边），不放到上一行——
  // 放到上一行会被读成上一行的信息（DESIGN「提示框」）
  const [tipFor, setTipFor] = useState<string | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipId = useId();
  const armRowTip = (id: string) => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => setTipFor(id), TIP_DELAY_MS.default);
  };
  const dropRowTip = () => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = null;
    setTipFor(null);
  };
  useEffect(() => dropRowTip, []);
  return (
    <div className="mx-omenu">
      <button
        type="button"
        className={`mx-omenu__all${selected === null ? " is-selected" : ""}`}
        onClick={() => {
          onSelect(null);
          close();
        }}
      >
        全部 <span className="mx-mono">{total}</span>
      </button>
      {sources.map((src) => {
        const rule = src.rule;
        const chosen = rule.available.filter((a) => rule.targets.includes(a.id));
        return (
          <div key={src.id} className="mx-omenu__item">
            <div className={`mx-omenu__row${selected === src.id ? " is-selected" : ""}`}>
              <button
                type="button"
                className="mx-omenu__name"
                title={src.title}
                onClick={() => {
                  onSelect(src.id);
                  close();
                }}
              >
                {src.label} <span className="mx-mono">{src.count}</span>
              </button>
              <span
                className={`mx-rule${rule.on ? "" : " is-off"}`}
                aria-describedby={`${tipId}-${src.id}`}
                onMouseEnter={() => {
                  hint(rule.targets);
                  armRowTip(src.id);
                }}
                onMouseLeave={() => {
                  hint([]);
                  dropRowTip();
                }}
                onFocus={() => armRowTip(src.id)}
                onBlur={dropRowTip}
              >
                <span
                  id={`${tipId}-${src.id}`}
                  role="tooltip"
                  className={`ss-tip mx-rowtip${tipFor === src.id ? " is-open" : ""}`}
                >
                  只管以后新出现的，现有的不变
                </span>
                <span className="mx-rule__text">以后新出现的</span>
                <RuleArrow />
                <button
                  type="button"
                  className="mx-rule__targets"
                  aria-expanded={editing === src.id}
                  aria-label={`改目标：${chosen.map((a) => a.name).join("、") || "还没选"}`}
                  onClick={() => setEditing((v) => (v === src.id ? null : src.id))}
                >
                  {chosen.map((a) => (
                    <AgentIcon key={a.id} id={a.agentId} name={a.name} labelled />
                  ))}
                </button>
                <span className="mx-rule__switch">
                  {rule.disabledReason ? (
                    <Switch
                      size="inline"
                      checked={rule.on}
                      onChange={rule.onToggle}
                      label={`${src.label} 以后新出现的自动添加`}
                      disabledReason={rule.disabledReason}
                    />
                  ) : (
                    <Switch
                      size="inline"
                      checked={rule.on}
                      onChange={rule.onToggle}
                      label={`${src.label} 以后新出现的自动添加`}
                    />
                  )}
                </span>
              </span>
            </div>
            {editing === src.id ? (
              <div className="mx-omenu__keys">
                {rule.available.map((a) => {
                  const pressed = rule.targets.includes(a.id);
                  const last = pressed && rule.targets.length === 1;
                  return (
                    <AgentKey
                      key={a.id}
                      id={a.agentId}
                      name={a.name}
                      pressed={pressed}
                      disabledReason={last ? "至少留一个" : undefined}
                      onToggle={(next) =>
                        rule.onTargets(
                          next ? [...rule.targets, a.id] : rule.targets.filter((id) => id !== a.id),
                        )
                      }
                    />
                  );
                })}
              </div>
            ) : null}
            {rule.error ? (
              <div className="mx-omenu__error" role="alert">
                <IconCannot size={12} />
                {rule.error}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
