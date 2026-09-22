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
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { Dot } from "./cellState";
import { compareBy, DOT_RANK, toggleSort, type SortState } from "./sort.ts";
import {
  AgentIcon,
  AgentMark,
  Checkbox,
  DOT_LABEL,
  IconCannot,
  IconClose,
  IconSearch,
  Rotor,
  StateDot,
  Switch,
  TIP_DELAY_MS,
  Tooltip,
} from "./ui/index.ts";
import "./Matrix.css";

/// 版式常量，与 Matrix.css 同值（列带要按它算左边距）
const CHECK_W = 34;
const NAME_W = 246;
const COL_W = 88;
const TAIL_W = 24;

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
  /// 属于哪个分组（MatrixGroupView.key）
  group: string;
  name: string;
  /// 列 id → 格；null＝这一行在这一列没有格（短横，不可点）
  cells: Record<string, MatrixCellView | null>;
  /// 名字后的标注：`×2`、`2 份不一样`、`Codex 不支持`
  mark?: ReactNode;
  /// 同名组：悬停（或键盘焦点）任一行，同组的行一起亮，并出 `extra`
  dupGroup?: string;
  /// 同名行悬停时名字右侧出现的读数与动作（`3 个文件` + `只留这份`）
  extra?: ReactNode;
  /// MCP 的 `传输` 列内容
  transport?: ReactNode;
  /// 非空＝这一行勾不动，值是原因
  selectDisabledReason?: string;
  /// 非空＝这一行正在操作：名字后 14px 转盘，句子进读屏与悬停
  busy?: string;
}

export interface MatrixRule {
  on: boolean;
  /// 规则作用的列：图标组，悬停组头时这几列列头轻亮
  agents: { id: string; name: string; columnId: string }[];
  onToggle: (next: boolean) => void;
  disabledReason?: string;
}

export interface MatrixGroupView {
  key: string;
  label: string;
  /// 组名的读屏补充（来源路径）；路径不出现在可见文案里
  title?: string;
  count: number;
  rule?: MatrixRule;
}

/// 选择操作条上的一颗键：**已选的 × 这一列**。写出按下会产生的增量
export interface SelectionKey {
  id: string;
  /// 没有就是「全部」键，不画图标与点
  agentId?: string;
  name: string;
  /// linked：已选的在这儿全开着（按下关）；missing：有没开的（按下开）；own：禁用时的灰色原件环
  dot?: "linked" | "missing" | "own";
  /// 有符号的增量：`−2` / `+2`；0 由调用方给 disabledReason
  delta: number;
  disabledReason?: string;
  /// 提示框：按下会怎样
  tip?: string;
  onPress: () => void;
}

export interface MatrixProps {
  columns: MatrixColumn[];
  groups: MatrixGroupView[];
  rows: MatrixRowView[];
  /// 名称列头：`名称` / `服务`
  nameLabel: string;
  /// 名称列头的提示框（机制说明放这里，不放常驻说明条）
  nameTip?: string;
  /// MCP 的 `传输` 列（72）
  transportLabel?: string;

  filterText: string;
  onFilterText: (text: string) => void;
  /// 来源筛选片（Chip 一排）
  chips?: ReactNode;
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

/// 行内转盘：活干完不立刻消失，停转回弹之后再卸（DESIGN「转盘」）
function InlineRotor({ label }: { label?: string }) {
  const [shown, setShown] = useState(label);
  const active = label !== undefined;
  useEffect(() => {
    if (active) setShown(label);
  }, [active, label]);
  if (shown === undefined) return null;
  return (
    <span className="mx-rotor" title={shown} role="status" aria-label={shown}>
      <Rotor size={14} spinning={active} label={shown} onStopped={() => setShown(undefined)} />
    </span>
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

/// 选择操作条上的键。默认按钮（2px 矩形，28）：点 + 名字 + 增量读数
function KeyButton({ k }: { k: SelectionKey }) {
  const disabled = k.disabledReason !== undefined;
  const sign = k.delta > 0 ? `+${k.delta}` : k.delta < 0 ? `−${-k.delta}` : "";
  const dot =
    k.dot === undefined ? null : disabled && k.dot === "own" ? (
      <StateDot dot="own" muted title="" label="原件" />
    ) : (
      <span className={`mx-keydot mx-keydot--${k.dot}`} aria-hidden="true" />
    );
  const button = (
    <button
      type="button"
      className="ss-btn ss-btn--compact mx-key"
      disabled={disabled}
      aria-label={`${k.name}${sign ? ` ${sign}` : ""}${disabled ? `：${k.disabledReason}` : ""}`}
      onClick={disabled ? undefined : k.onPress}
    >
      {dot}
      <span>{k.name}</span>
      {sign && !disabled ? <span className="mx-keydelta">{sign}</span> : null}
    </button>
  );
  const tip = disabled ? k.disabledReason : k.tip;
  return tip ? (
    <Tooltip content={tip} placement="bottom">
      {button}
    </Tooltip>
  ) : (
    button
  );
}

export default function Matrix(props: MatrixProps) {
  const {
    columns,
    groups,
    rows,
    nameLabel,
    nameTip,
    transportLabel,
    filterText,
    onFilterText,
    chips,
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

  // 默认排序：名称升序，组内排序（DESIGN「默认值」）
  // null＝默认（名称升序），表头不画箭头；点过才画（DESIGN「表头排序」）
  const [sortState, setSort] = useState<SortState | null>(null);
  const sort: SortState = sortState ?? { key: "name", dir: "asc" };
  // 悬停的格（十字带）/ 列头（列带）/ 组头规则（作用列轻亮）/ 同名组
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

  const hasTransport = transportLabel !== undefined;
  const template = [
    `${CHECK_W}px`,
    `${NAME_W}px`,
    ...(hasTransport ? ["72px"] : []),
    ...columns.map(() => `${COL_W}px`),
    `${TAIL_W}px`,
  ].join(" ");
  const width = CHECK_W + NAME_W + (hasTransport ? 72 : 0) + columns.length * COL_W + TAIL_W;
  const colLeft = (index: number) => CHECK_W + NAME_W + (hasTransport ? 72 : 0) + index * COL_W;
  const gridStyle: CSSProperties = { gridTemplateColumns: template };

  // ---- 分组 + 组内排序 ----
  const byGroup = new Map<string, MatrixRowView[]>();
  for (const row of rows) {
    const list = byGroup.get(row.group);
    if (list) list.push(row);
    else byGroup.set(row.group, [row]);
  }
  const cmp =
    sort.key === "name"
      ? compareBy((r: MatrixRowView) => r.name, sort.dir)
      : compareBy((r: MatrixRowView) => DOT_RANK[r.cells[sort.key]?.dot ?? "none"], sort.dir);
  const sections = groups
    .map((group) => ({ group, rows: [...(byGroup.get(group.key) ?? [])].sort(cmp) }))
    .filter((s) => s.rows.length > 0);
  // 键盘在格间移动按这个顺序
  const flat = sections.flatMap((s) => s.rows);
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
    const root = rootRef.current;
    const first = jump.rowKeys[0];
    const el =
      first !== undefined
        ? root?.querySelector(`[data-row="${CSS.escape(first)}"]`)
        : jump.columnId !== undefined
          ? root?.querySelector(`[data-col="${CSS.escape(jump.columnId)}"]`)
          : null;
    el?.scrollIntoView({ block: "center" });
    setFlashRows(new Set(jump.rowKeys));
    setFlashCol(jump.rowKeys.length === 0 ? (jump.columnId ?? null) : null);
    // 只跟 nonce
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpNonce]);

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
  const live = useRef({ onUndo, onSelectionChange, selected, flat, focus, hover, focusWithin });
  live.current = { onUndo, onSelectionChange, selected, flat, focus, hover, focusWithin };
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
      if (mod && e.key.toLowerCase() === "a") {
        // 当前组：键盘焦点所在行 → 悬停的行 → 第一组
        const at =
          (s.focusWithin ? s.flat[s.focus.r] : undefined) ??
          s.flat.find((r) => r.key === s.hover?.row) ??
          s.flat[0];
        if (!at) return;
        e.preventDefault();
        const next = new Set(s.selected);
        for (const r of s.flat) {
          if (r.group === at.group && r.selectDisabledReason === undefined) next.add(r.key);
        }
        s.onSelectionChange(next);
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
  // 放不下时的最后一级退让：「已选 N 个」缩成「N 个」。列数变了从头量
  const [short, setShort] = useState(false);
  useLayoutEffect(() => setShort(false), [columns.length, width]);
  useLayoutEffect(() => {
    const el = selRef.current;
    if (!selecting || !el || short) return;
    if (el.scrollWidth > el.clientWidth + 1) setShort(true);
  });
  const toolbar = selecting ? (
    // 选择操作条「顶替工具行」（DESIGN「选择操作条」「主视图」）：`+ skill` / `+ MCP` 不出现，
    // 收在面板右沿之内；紧凑键，取消选择是文字链。还放不下才把「已选 N 个」缩成「N 个」
    <div className="mx-toolbar mx-toolbar--select" ref={selRef} style={{ width }}>
      <span className="mx-selcount">
        {short ? null : "已选 "}
        <span className="mx-mono">{selectedVisible.length}</span> 个
      </span>
      <span className={`mx-keys${busy ? " ss-busy" : ""}`}>
        {selectionKeys.map((k) => (
          <span key={k.id} className="mx-keywrap">
            <KeyButton k={k} />
            {keyToast?.keyId === k.id ? <div className="mx-keytoast">{keyToast.node}</div> : null}
          </span>
        ))}
        {selectionAll ? (
          <span className="mx-keywrap mx-keywrap--all">
            <KeyButton k={selectionAll} />
            {keyToast?.keyId === selectionAll.id ? (
              <div className="mx-keytoast">{keyToast.node}</div>
            ) : null}
          </span>
        ) : null}
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
    <div className="mx-toolbar" style={{ minWidth: width, width: "max-content" }}>
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
      {chips ? <span className={`mx-chips${busy ? " ss-busy" : ""}`}>{chips}</span> : null}
      {addButton ? (
        <span className={`mx-toolbar__end${busy ? " ss-busy" : ""}`}>{addButton}</span>
      ) : null}
    </div>
  );

  // ---- 表头 ----
  const sortBy = (key: string) => setSort((prev) => toggleSort(prev ?? sort, key));
  const header = (
    <div className="mx-grid mx-head" style={gridStyle}>
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
              <SortArrow active={sortState?.key === "name"} desc={sort.dir === "desc"} />
            </button>
          </Tooltip>
        ) : (
          <button type="button" className="mx-headbtn" onClick={() => sortBy("name")}>
            {nameLabel}
            <SortArrow active={sortState?.key === "name"} desc={sort.dir === "desc"} />
          </button>
        )}
      </div>
      {hasTransport ? <div className="mx-head__label">{transportLabel}</div> : null}
      {columns.map((col) => {
        const classes = ["mx-head__col"];
        // 列头只回应列头自己的悬停；格子的十字带不点亮列头（画板 Main）
        if (headHover === col.id) classes.push("is-hot");
        else if (hintCols.includes(col.id)) classes.push("is-hint");
        if (flashCol === col.id) classes.push("ss-flash");
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
  const groupHeader = (group: MatrixGroupView, first: boolean) => {
    const rule = group.rule;
    return (
      <div
        key={`g:${group.key}`}
        className={`mx-group${first ? " is-first" : ""}`}
        style={{ width }}
      >
        <span className="mx-group__name" title={group.title}>
          {group.label}
        </span>
        <span className="mx-mono mx-faint">{group.count}</span>
        {rule ? (
          <Tooltip content="只管以后新出现的，现有的不变">
            <span
              className={`mx-rule${rule.on ? "" : " is-off"}`}
              onMouseEnter={() => setHintCols(rule.agents.map((a) => a.columnId))}
              onMouseLeave={() => setHintCols([])}
            >
              <span className="mx-rule__text">· 以后新出现的</span>
              <RuleArrow />
              {rule.agents.map((a) => (
                <AgentIcon key={a.columnId} id={a.id} name={a.name} labelled />
              ))}
              <span className="mx-rule__switch">
                {rule.disabledReason ? (
                  <Switch
                    size="inline"
                    checked={rule.on}
                    onChange={rule.onToggle}
                    label={`${group.label} 以后新出现的自动开启`}
                    disabledReason={rule.disabledReason}
                  />
                ) : (
                  <Switch
                    size="inline"
                    checked={rule.on}
                    onChange={rule.onToggle}
                    label={`${group.label} 以后新出现的自动开启`}
                  />
                )}
              </span>
            </span>
          </Tooltip>
        ) : null}
      </div>
    );
  };

  const renderRow = (row: MatrixRowView) => {
    const r = rowIndex.get(row.key) ?? 0;
    const isSelected = selected.has(row.key);
    const hot = activeRow === row.key || (row.dupGroup !== undefined && row.dupGroup === activeDup);
    const classes = ["mx-grid", "mx-row"];
    if (isSelected) classes.push("is-selected");
    if (hot) classes.push("is-hot");
    if (flashRows.has(row.key)) classes.push("ss-flash");
    const showExtra = row.extra !== undefined && hot;
    return (
      <div
        key={row.key}
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
          <span className="mx-name">{row.name}</span>
          {row.mark}
          <InlineRotor label={row.busy} />
          {showExtra ? <span className="mx-extra">{row.extra}</span> : null}
        </div>
        {hasTransport ? <div className="mx-row__transport">{row.transport}</div> : null}
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
    );
  };

  return (
    <div className="mx" ref={rootRef}>
      {toolbar}
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
          {sections.map((s, i) => (
            <div key={s.group.key} role="rowgroup" aria-label={s.group.label}>
              {groupHeader(s.group, i === 0)}
              {s.rows.map(renderRow)}
            </div>
          ))}
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
