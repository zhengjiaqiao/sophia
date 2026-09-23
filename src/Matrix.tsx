/// 表格 = 面板（DESIGN「材料与工艺 › 表格 = 面板」「列头的悬停」「格子悬停预览」
/// 「提示框」「键盘」「选择操作条」，画板 Main / Mcp / Empty）。
///
/// Skills 与 MCP **共用这一张表**：两边只是内容不同——行是 skill 或 MCP 服务，列是 agent，
/// 格是同一套状态点。本组件只管形制与交互（两行工具行与来源筛选片、通道条表头、原件位置列、
/// 十字带、提示框、行内展开、键盘、选择操作条、就地提示的锚点），不碰 api、不认后端状态：调用方把一切折算成
/// 「记号 + 能不能点 + 一句话」交进来，点了什么再原样交回去。
///
/// 版式（画板的写法直接当 CSS 抄，见 Matrix.css）：
/// - 名称列定宽 280（勾选 34 + 名字 246），原件位置 120，agent 列各 88，MCP 另有 72 的 `传输` 列；
///   所有横线止于最后一列右沿 + 24，工具行的 `来源` 右对齐到同一条边
/// - 表头底 2px 结构线；行 1px `hairline`；行高 34
/// - 悬停十字带：行带 + 列带
/// - 格子提示框：一行「动词 · 快捷键」，格子正上方 6，停留 700ms；格间移动每格重新计时，
///   所以不追着鼠标；键盘焦点到达同样计时
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { Dot } from "./cellState";
import { compareBy, DOT_RANK, toggleSort, type SortState } from "./sort.ts";
import {
  AgentMark,
  Checkbox,
  Chip,
  DOT_LABEL,
  IconCannot,
  IconClose,
  IconSearch,
  Spinner,
  StateDot,
  TIP_DELAY_MS,
  tipCeiling,
  Tooltip,
} from "./ui/index.ts";
import { displayPath } from "./pathText.ts";
import "./Matrix.css";

/// 版式常量，与 Matrix.css 同值（列带要按它算左边距）
const CHECK_W = 34;
const NAME_W = 246;
const COL_W = 88;
const TAIL_W = 24;
/// 点了做不了的格子后，说明停留的时长
export const PINNED_TIP_MS = 3000;
/// 批量写入超过这么久还没完成，触发项旁才出忙碌指示 + 一句；更快的什么都不显示
export const BATCH_BUSY_DELAY_MS = 500;

/// 按下一格（点击或空格）做什么：能改的交给调用方改数据；做不了的只当即说明，不碰数据
export const cellPress = (view: Pick<MatrixCellView, "clickable">): "act" | "explain" =>
  view.clickable ? "act" : "explain";
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
  /// 列头提示框：`Claude Code · 41 个已加上`
  tip: string;
  /// 这一列的目录还不存在：虚线列头（添加时顺手建出来）
  missing?: boolean;
}

export interface MatrixCellView {
  dot: Dot;
  /// 点下去会做事（开关、写进、重新链接）；false 时点击无动作，只由提示框说原因
  clickable: boolean;
  /// 提示框一行：可点时是「动词」（`加到 Claude Code`），不可点时是原因
  tip: string;
  /// 单格写入进行中：画成灰色的将来状态（批量不用它，格子同时变）
  pending?: boolean;
}

export interface MatrixRowView {
  key: string;
  name: string;
  /// 原件位置 / 来源位置格：来源名（同名来源用区分片段）+ 完整路径；悬停出路径提示框与 `打开 ↗`。
  /// `gone`：原件已经不在了（孤链行），名字用 `ink-faint`，不出 `打开 ↗`。
  /// `split`：同名来源时把 `label` 拆成来源名 + 区分片段两段画，放不下只截来源名（`ego… · 0.5.0.32`）
  origin: {
    id: string;
    label: string;
    split?: { name: string; seg: string };
    path: string;
    onReveal: () => void;
    gone?: boolean;
  };
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
  /// 调用方控制开合的就地展开区（MCP 点 `2 份不一样` 展开的字段差异）：给了就出在这一行下面，
  /// 从名字左沿铺到最后一列；不给就收着
  panel?: ReactNode;
  /// MCP 的 `传输` 列内容
  transport?: ReactNode;
  /// 非空＝这一行勾不动，值是原因
  selectDisabledReason?: string;
}

/// 选择态下按 agent 的批量操作：工具行里「状态点 + 名字」一项（DESIGN「选择操作条」），与格子同一套记号。
/// **只有两态**：● ＝选中的在这个 agent 里（按能改的格算）全都有；否则 ○，不画半选。
/// 点 ○ ＝全部加上（补齐缺的），点 ● ＝全部移除——和点格子是同一件事
export interface ColumnCheck {
  checked: boolean;
  /// 读屏名：`选中的都加到 Claude Code` / `选中的都从 Codex 移除`
  label: string;
  /// 提示框：动词 + 数量 + 受影响的名字；不受影响的注明原因
  tip: ReactNode;
  /// 没有可改的格子：禁用，提示框说原因
  disabledReason?: string;
  onToggle: () => void;
}

export interface MatrixProps {
  columns: MatrixColumn[];
  /// 原件位置列：列头文字（`原件位置` / `来源位置`）
  originLabel: string;
  /// 工具行第二行的来源筛选片：`全部 N` 在最前、默认选中；每片 `来源名 N`，选中反色。
  /// 放不下折行（不超出面板宽）；片名放不下截断，完整值用同一行右侧的提示框给
  sources?: {
    total: number;
    selected: string | null;
    onSelect: (id: string | null) => void;
    items: { id: string; label: string; full?: string; count: number }[];
  };
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
  /// 工具行右端的 `来源`（skill）/ `+ MCP`，右沿对齐面板右沿
  addButton?: ReactNode;

  /// 选中的行键
  selected: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  /// 选择态：工具行第一行的「所有 agent」一项（规则同每个 agent 那一项）
  allAgents?: ColumnCheck;
  /// 选择态：工具行第一行每个 agent 一项「● 名字 / ○ 名字」，键为列 id
  columnChecks?: Record<string, ColumnCheck>;

  busy: boolean;
  onCell: (rowKey: string, columnId: string) => void;
  onUndo?: () => void;
  /// 键盘快捷键是否生效（二级页面盖在上面时关掉）
  shortcuts?: boolean;

  /// 一行都没有时，表头下面放什么（空态）
  empty?: ReactNode;
  /// 刚变化的格：播一次 120ms 反色闪，`nonce` 变了才重播。**只给单格**：批量时格子同时变成新状态、
  /// 不闪（DESIGN 冲突表「格子变化要不要闪」）
  flash?: { keys: string[]; nonce: number };
  /// 批量写入真的慢（> BATCH_BUSY_DELAY_MS）时，工具行里触发的那一项旁出 14px 地球绕太阳 + 一句
  /// （`正在加到 Codex`）；keyId 同 keyToast（"all" 或列 id）。调用方负责延迟与撤掉
  keyBusy?: { keyId: string; label: string } | null;
  /// 单格失败：格子下方的小黑窗
  cellNotice?: { rowKey: string; columnId: string; text: string } | null;
  /// 贴在某一行下方的提示条（只留这份 · 撤销）
  rowToast?: { rowKey: string; node: ReactNode } | null;
  /// 批量结果的例行提示条：贴在按下的那一项下方（见 .mx-keytoast）
  keyToast?: { keyId: string; node: ReactNode } | null;
  /// 单格加上 / 移除成功后的例行一行：就在被点的那一行里，紧跟名字（有 `×2` 跟在它后面），
  /// 间距 12；随行滚动，不吸顶。放不下时暂时盖住同一行的原件位置格（行当下的底色），
  /// 不越过第一个 agent 列；显示期间这一行的悬停动作（`只留这份` `打开 ↗`）让位
  /// （DESIGN「单格操作出例行一行」）。一次只一条：`id` 变了就重挂，计时从头来
  cellToast?: { id: number; rowKey: string; node: ReactNode } | null;
  /// 无关位置的全局事（自动规则）：右下，右沿对齐面板右沿
  globalToast?: ReactNode;
  /// 新问题提示「查看」跳过来：滚到这几行（或这一列的列头）并闪两下（⑦）。`nonce` 变了才重做
  focus?: { rowKeys: string[]; columnId?: string; nonce: number } | null;
}

/// 格的读屏名：状态名统一成「已加上 / 未加上」（「已开启」会读成应用开着），其余沿用 DOT_LABEL
const DOT_TEXT: Record<Dot, string> = {
  ...DOT_LABEL,
  linked: "已加上 · 软链",
  missing: "未加上",
  own: "已加上 · 原件",
};

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

/// 批量写入真的慢时触发项旁的忙碌：14px 地球绕太阳 + 一句，句子同时进读屏（DESIGN「忙碌指示」）
function KeyBusy({ label }: { label: string }) {
  return (
    <span className="mx-keybusy" role="status">
      <Spinner size={14} label={label} />
      <span>{label}</span>
    </span>
  );
}

/// 工具行各项的忙碌外观：不忙无类；忙了先只锁（`mx-locked`，点不动、不变淡），
/// 忙过 BATCH_BUSY_DELAY_MS 才变淡（`ss-busy`）
export const busyLockClass = (busy: boolean, dim: boolean): string | undefined =>
  !busy ? undefined : dim ? "ss-busy" : "mx-locked";

/// 展开记号：12px 实心三角，▸ 收起 / ▾ 展开。不在悬停也没展开时占位不显示（名字不跳）
export function Disclosure({ open, shown }: { open: boolean; shown: boolean }) {
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

/// 工具行里按 agent 的一项：10px 状态点（● / ○）+ 正文名字，无图标无框。悬停时点不变、只出光晕
/// （与格子同一套 hoverable），提示框列受影响的名字；禁用时点和字都用 disabled 色、提示框写原因。
/// 名字放不下时截断，完整名在提示框里（提示框第一句就带着 agent 名）
function AgentItem({
  check,
  name,
  locked = false,
}: {
  check: ColumnCheck;
  name: string;
  /// 批量写入进行中：点不动（键盘的空格 / 回车也不行），外观由外层的忙碌类决定
  locked?: boolean;
}) {
  const disabled = check.disabledReason !== undefined;
  const button = (
    <button
      type="button"
      className={`ss-dot-btn mx-agentitem${disabled ? " is-disabled" : ""}`}
      aria-label={disabled ? `${check.label}：${check.disabledReason}` : check.label}
      aria-disabled={disabled || undefined}
      onClick={disabled || locked ? undefined : () => check.onToggle()}
    >
      <StateDot
        dot={check.checked ? "linked" : "missing"}
        hoverable={!disabled}
        muted={disabled}
        title=""
        label={check.checked ? "已加上" : "未加上"}
      />
      <span className="mx-agentitem__name">{name}</span>
    </button>
  );
  return (
    <Tooltip content={check.disabledReason ?? check.tip} placement="bottom">
      {button}
    </Tooltip>
  );
}

/// 排序箭头 ↑ / ↓：只在当前的排序依据列常显（默认名称升序时也显示，Finder 惯例）；其余列不占眼
function SortArrow({ active, desc }: { active: boolean; desc: boolean }) {
  return (
    <svg
      className={`mx-sort${active ? " is-active" : ""}`}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={active ? "img" : undefined}
      aria-label={active ? (desc ? "降序" : "升序") : undefined}
      aria-hidden={active ? undefined : true}
    >
      <path d={desc ? "M5 1.5v7M2 5.5l3 3 3-3" : "M5 8.5v-7M2 4.5l3-3 3 3"} />
    </svg>
  );
}

export default function Matrix(props: MatrixProps) {
  const {
    columns,
    originLabel,
    sources,
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
    allAgents,
    columnChecks,
    busy,
    onCell,
    onUndo,
    shortcuts = true,
    empty,
    flash,
    cellNotice,
    rowToast,
    keyToast,
    cellToast,
    keyBusy,
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
  // 悬停的格（十字带）/ 列头（列带）/ 同名组
  const [hover, setHover] = useState<{ row: string; col: string | null } | null>(null);
  const [headHover, setHeadHover] = useState<string | null>(null);
  // 键盘焦点所在格（行序号、列序号），以及焦点此刻在不在表身里
  // 键盘焦点（roving tabindex）存的原值；用时一律经 clampFocus 夹回当前表的范围
  const [focusRaw, setFocus] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const [focusWithin, setFocusWithin] = useState(false);
  // 提示框：停够 700ms 的那一格
  const [tip, setTip] = useState<string | null>(null);
  // 这一格的提示框因上方被吸顶区盖住而翻到了下方
  const [tipFlip, setTipFlip] = useState<string | null>(null);
  // 这一格的提示框是点出来的（做不了的格子），不是悬停出来的
  const [tipPinned, setTipPinned] = useState(false);
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
  const headRef = useRef<HTMLDivElement>(null);
  const [barH, setBarH] = useState(0);
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
    setFlashing(new Set(flash.keys));
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
    setTipFlip(null);
    setTipPinned(false);
    tipTimer.current = setTimeout(() => setTip(key), TIP_DELAY_MS.table);
  };
  const dropTip = () => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = null;
    setTip(null);
    setTipFlip(null);
    setTipPinned(false);
  };
  useEffect(() => () => dropTip(), []);
  // 点了做不了的格子（或空格）：不等 700ms，当即弹出这一格的提示框，停约 3 秒；移开、点别处即消
  const pinTip = (key: string) => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    if (tip !== key) {
      setTipFlip(null);
      setTip(key);
    }
    setTipPinned(true);
    tipTimer.current = setTimeout(dropTip, PINNED_TIP_MS);
  };
  useEffect(() => {
    if (!tipPinned) return;
    const away = (e: PointerEvent) => {
      const cell = (e.target as Element | null)?.closest?.(".mx-cell");
      if (!cell || !cell.contains(document.getElementById(`${tipId}-tip`))) dropTip();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [tipPinned, tipId]);

  // 格子提示框默认向上（第一行向下）；上方被吸顶区盖住时翻到格子下方
  useLayoutEffect(() => {
    if (tip === null) return;
    const el = document.getElementById(`${tipId}-tip`);
    if (el?.classList.contains("ss-tip--top") && el.getBoundingClientRect().top < tipCeiling(el)) {
      setTipFlip(tip);
    }
  }, [tip, tipId]);

  // 吸顶区底边相对滚动容器顶的距离写进 `--tip-ceiling`，所有往上弹的提示框据此决定要不要翻到下方
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let scroller: HTMLElement | null = null;
    for (let p = root.parentElement; p; p = p.parentElement) {
      if (getComputedStyle(p).overflowY !== "visible") {
        scroller = p;
        break;
      }
    }
    const update = () => {
      const head = headRef.current;
      if (!head) return;
      const top = Math.max(0, scroller ? scroller.getBoundingClientRect().top : 0);
      const inset = Math.max(0, head.getBoundingClientRect().bottom - top);
      root.style.setProperty("--tip-ceiling", `${inset}px`);
    };
    update();
    // 文档级滚动（html / body）的 scroll 事件派发在 window 上
    if (scroller === document.documentElement || scroller === document.body) scroller = null;
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      target.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [barH, width, columns.length]);

  // ---- 吸顶的列头高度、面板右侧余量 ----
  // 工具行的高度不只随窗口变：切位置后来源片从两行变一行、选择条出现或折行，都会改高度。
  // 只在 resize 时量，列头就停在旧高度上，行从工具行和列头之间的缝里漏出来（产品负责人真机）
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measure = () => setBarH(bar.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [width, columns.length]);

  // ---- 单格例行一行放不下：先在名称格里排一次，超出名称格右沿（减去 12 右内边距）就改为跨列盖住
  // 原件位置格；同一条只量一次（名字宽度在它显示的 4 秒里不变） ----
  const [coverId, setCoverId] = useState<number | null>(null);
  const cellToastId = cellToast?.id;
  useLayoutEffect(() => {
    if (cellToastId === undefined || coverId === cellToastId) return;
    const el = rootRef.current?.querySelector<HTMLElement>(".mx-celltoast");
    const cell = el?.closest<HTMLElement>(".mx-row__name");
    if (!el || !cell) return;
    const pad = parseFloat(getComputedStyle(cell).paddingRight) || 0;
    if (el.getBoundingClientRect().right > cell.getBoundingClientRect().right - pad)
      setCoverId(cellToastId);
  }, [cellToastId, coverId]);

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
  const live = useRef({ onUndo, onSelectionChange, selected, flat, expanded });
  live.current = { onUndo, onSelectionChange, selected, flat, expanded };
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
        // 全选当前可见的行
        if (s.flat.length === 0) return;
        e.preventDefault();
        const next = new Set(s.selected);
        for (const r of s.flat) {
          if (r.selectDisabledReason === undefined) next.add(r.key);
        }
        s.onSelectionChange(next);
        return;
      }
      // Esc：先收起展开的行，再取消选择
      if (e.key === "Escape" && s.expanded !== null) {
        e.preventDefault();
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

  // ---- 忙碌锁：批量写入一开始工具行各项就锁住（防重复点），超过 BATCH_BUSY_DELAY_MS 还没完成
  // 才变淡——与触发项旁的忙碌指示同一时刻出现；写得快时先淡再恢复会闪一下 ----
  const [busyDim, setBusyDim] = useState(false);
  useEffect(() => {
    if (!busy) {
      setBusyDim(false);
      return;
    }
    const timer = setTimeout(() => setBusyDim(true), BATCH_BUSY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [busy]);
  const lockClass = busyLockClass(busy, busyDim);

  // ---- 工具行 / 选择操作条（同一个 28 槽位） ----
  const selecting = selectedVisible.length > 0;
  const selRef = useRef<HTMLDivElement>(null);
  // 批量提示条贴在按下的那一项下方、左对齐；越出面板右沿时改为右对齐到那一项
  const keyToastRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const t = keyToastRef.current;
    const panel = panelRef.current;
    if (!t || !panel) return;
    t.style.left = "";
    t.style.right = "";
    if (t.getBoundingClientRect().right > panel.getBoundingClientRect().right) {
      t.style.left = "auto";
      t.style.right = "0";
    }
  }, [keyToast]);
  // 放不下时的最后手段：「已选 N 个」缩成「N 个」。列数变了从头量
  const [short, setShort] = useState(false);
  useLayoutEffect(() => setShort(false), [columns.length, width]);
  useLayoutEffect(() => {
    const el = selRef.current;
    if (!selecting || !el || short) return;
    if (el.scrollWidth > el.clientWidth + 1) setShort(true);
  });
  const toolbar = selecting ? (
    // 选择态的第一行：已选 N 个 + 全局一对「全部加上」「全部移除」+ 取消选择（第二行来源片保留）
    <div className="mx-toolbar mx-toolbar--select" ref={selRef} style={{ width }}>
      <span className="mx-selcount">
        {short ? null : "已选 "}
        <span className="mx-mono">{selectedVisible.length}</span> 个
      </span>
      {/* 忙时置灰的是各项本身，不是整组：项旁「正在加到 X」那一句要读得清 */}
      <span className="mx-agentitems">
        {allAgents ? (
          <span className="mx-keywrap">
            <span className={lockClass}>
              <AgentItem check={allAgents} name="所有 agent" locked={busy} />
            </span>
            {keyBusy?.keyId === "all" ? <KeyBusy label={keyBusy.label} /> : null}
            {keyToast?.keyId === "all" ? (
              <div className="mx-keytoast" ref={keyToastRef}>
                {keyToast.node}
              </div>
            ) : null}
          </span>
        ) : null}
        {columns.map((col) =>
          columnChecks?.[col.id] ? (
            <span key={col.id} className="mx-keywrap">
              <span className={lockClass}>
                <AgentItem check={columnChecks[col.id]} name={col.name} locked={busy} />
              </span>
              {keyBusy?.keyId === col.id ? <KeyBusy label={keyBusy.label} /> : null}
              {keyToast?.keyId === col.id ? (
                <div className="mx-keytoast" ref={keyToastRef}>
                  {keyToast.node}
                </div>
              ) : null}
            </span>
          ) : null,
        )}
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
    // 工具行第一行：筛选框（弹性，最小 200）+ 右端添加键；来源筛选片在第二行（SourceChips）
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
        <span className={`mx-toolbar__end${lockClass ? ` ${lockClass}` : ""}`}>{addButton}</span>
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
          <Tooltip content={nameTip} context="table" placement="bottom">
            <button type="button" className="mx-headbtn" onClick={() => sortBy("name")}>
              {nameLabel}
              {nameCount !== undefined ? <span className="mx-namecount">{nameCount}</span> : null}
              <SortArrow active={sort.key === "name"} desc={sort.dir === "desc"} />
            </button>
          </Tooltip>
        ) : (
          <button type="button" className="mx-headbtn" onClick={() => sortBy("name")}>
            {nameLabel}
            {nameCount !== undefined ? <span className="mx-namecount">{nameCount}</span> : null}
            <SortArrow active={sort.key === "name"} desc={sort.dir === "desc"} />
          </button>
        )}
      </div>
      {hasTransport ? <div className="mx-head__label">{transportLabel}</div> : null}
      {/* 原件位置：点文字按位置排序（同来源自然聚拢） */}
      <div className="mx-head__origin">
        <button type="button" className="mx-headbtn" onClick={() => sortBy("origin")}>
          {originLabel}
          <SortArrow active={sort.key === "origin"} desc={sort.dir === "desc"} />
        </button>
      </div>
      {columns.map((col) => {
        const classes = ["mx-head__col"];
        // 列头只回应列头自己的悬停；格子的十字带不点亮列头（画板 Main）
        if (headHover === col.id) classes.push("is-hot");
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
            <Tooltip content={col.tip} context="table" placement="bottom">
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
                <SortArrow active={sort.key === col.id} desc={sort.dir === "desc"} />
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
    // 单格例行一行在这一行时：悬停动作让位；放不下时名称格跨到第一个 agent 列前、盖住原件位置
    const toast = cellToast?.rowKey === row.key ? cellToast : null;
    const covering = toast !== null && coverId === toast.id;
    const showExtra = row.extra !== undefined && hot && toast === null;
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
          <div
            className={`mx-row__name${covering ? " is-covering" : ""}`}
            style={covering ? { gridColumn: `2 / span ${hasTransport ? 3 : 2}` } : undefined}
          >
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
            {toast ? (
              <span key={toast.id} className="mx-celltoast">
                {toast.node}
              </span>
            ) : null}
            {showExtra ? <span className="mx-extra">{row.extra}</span> : null}
          </div>
          {hasTransport && !covering ? (
            <div className="mx-row__transport">{row.transport}</div>
          ) : null}
          {/* 原件位置：写来源名；悬停出完整路径提示框与 `打开 ↗`（这一行已展开时只出提示框） */}
          {covering ? null : (
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
                <span
                  className={`mx-origin${row.origin.gone ? " is-gone" : ""}${row.origin.split ? " is-split" : ""}`}
                  tabIndex={-1}
                >
                  {row.origin.split ? (
                    <>
                      <span className="mx-origin__name">{row.origin.split.name}</span>
                      {/* 分隔用不换行空格：flex 项之间的普通空白会被吃掉 */}
                      <span className="mx-origin__seg">{`\u00a0·\u00a0${row.origin.split.seg}`}</span>
                    </>
                  ) : (
                    row.origin.label
                  )}
                </span>
              </Tooltip>
              {hot && !open && toast === null && !row.origin.gone ? (
                <RevealLink path={row.origin.path} onReveal={row.origin.onReveal} />
              ) : null}
            </div>
          )}
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
                    aria-label={`${row.name} · ${col.name}：${DOT_TEXT[view.dot]}。${view.tip}`}
                    aria-describedby={tip === key ? `${tipId}-tip` : undefined}
                    onFocus={() => {
                      setFocus({ r, c });
                      armTip(key);
                    }}
                    onBlur={dropTip}
                    onClick={() => {
                      if (cellPress(view) === "explain") {
                        pinTip(key);
                        return;
                      }
                      dropTip();
                      onCell(row.key, col.id);
                    }}
                  >
                    <StateDot
                      dot={view.dot}
                      hoverable={view.clickable && !view.pending}
                      muted={view.pending}
                      title=""
                      label={DOT_TEXT[view.dot]}
                    />
                  </button>
                )}
                {tip === key && view !== null ? (
                  <span
                    id={`${tipId}-tip`}
                    role="tooltip"
                    className={`ss-tip ${r === 0 || tipFlip === key ? "ss-tip--bottom" : "ss-tip--top"} ss-tip--center is-open`}
                  >
                    {view.tip}
                    {/* 快捷键只给键盘：格子 :focus-visible 时才显示（Matrix.css） */}
                    {view.clickable ? (
                      <span className="ss-tip__keyhint">
                        {" · "}
                        <span className="ss-tip__key">空格</span>
                      </span>
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
        {row.panel ? (
          <div className="mx-grid mx-detail" style={gridStyle}>
            <div className="mx-detail__body" style={{ gridColumn: "2 / -1" }}>
              {row.panel}
            </div>
          </div>
        ) : null}
      </Fragment>
    );
  };

  return (
    <div className="mx" ref={rootRef}>
      {/* 工具行 / 选择条吸顶：共用一个槽位，滚动之后也要点得到 */}
      {/* 工具行两行一起吸顶：第一行（勾选时是选择条）+ 第二行来源筛选片，列头紧贴其下。
          选择条只顶替第一行，来源片保持可见——选择常发生在某个筛选之内 */}
      <div className="mx-bar" ref={barRef}>
        {toolbar}
        {sources ? <SourceChips {...sources} width={width} /> : null}
      </div>
      <div className="mx-panel" ref={panelRef} style={{ width }}>
        {/* 列头吸顶（连同选择态的键行），紧贴两行工具行下面 */}
        <div className="mx-headwrap" ref={headRef} style={{ top: barH }}>
          {header}
        </div>
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

/// 工具行第二行：来源筛选片平铺（DESIGN「主视图」）。点片＝筛选，再点「全部」恢复
function SourceChips({
  total,
  selected,
  onSelect,
  items,
  width,
}: NonNullable<MatrixProps["sources"]> & { width: number }) {
  const [tipFor, setTipFor] = useState<string | null>(null);
  // 窗口右边放不下时提示框改放同一行左侧，不出窗
  const [tipLeft, setTipLeft] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipId = useId();
  // 只有片名真被截断时才给完整值；提示框放在同一行右侧
  const arm = (id: string, el: HTMLElement) => {
    if (timer.current) clearTimeout(timer.current);
    const label = el.querySelector<HTMLElement>(".ss-chip__label");
    const item = items.find((x) => x.id === id);
    // 片名被截断（按片宽，或区分片段本身就截成了「…」）时才给完整值
    const clipped =
      (label !== null && label.scrollWidth > label.clientWidth + 1) ||
      (item?.label.endsWith("…") ?? false);
    if (!clipped) return;
    setTipLeft(window.innerWidth - el.getBoundingClientRect().right < 260);
    timer.current = setTimeout(() => setTipFor(id), TIP_DELAY_MS.default);
  };
  const drop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setTipFor(null);
  };
  useEffect(() => drop, []);
  return (
    <div className="mx-sources" style={{ maxWidth: width }} role="group" aria-label="按来源筛选">
      <Chip selected={selected === null} count={total} onClick={() => onSelect(null)}>
        全部
      </Chip>
      {items.map((item) => (
        <span
          key={item.id}
          className="mx-sourcechip"
          onMouseEnter={(e) => arm(item.id, e.currentTarget)}
          onMouseLeave={drop}
          onFocus={(e) => arm(item.id, e.currentTarget)}
          onBlur={drop}
          aria-describedby={tipFor === item.id ? `${tipId}-${item.id}` : undefined}
        >
          <Chip
            selected={selected === item.id}
            count={item.count}
            onClick={() => onSelect(selected === item.id ? null : item.id)}
          >
            {item.label}
          </Chip>
          {tipFor === item.id ? (
            <span
              id={`${tipId}-${item.id}`}
              role="tooltip"
              className={`ss-tip mx-rowtip${tipLeft ? " mx-rowtip--left" : ""} is-open`}
            >
              {item.full ?? item.label}
            </span>
          ) : null}
        </span>
      ))}
    </div>
  );
}
