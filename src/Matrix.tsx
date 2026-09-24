/// 位置页的表格（DESIGN「位置页：skills ｜ mcp」「表格（组件）」「选择行」「列头的悬停」
/// 「格子悬停光晕」「提示框」「键盘」「右键菜单」，画板 V4Layouts skills / skills-select / sources / mcp）。
///
/// Skills 与 MCP **共用这一张表**：两边只是内容不同——行是 skill 或 MCP 服务，列是 agent，
/// 格是同一套状态点（以后 `sessions` 页签也沿用它，所以这里不认任何 skill / MCP 专有字段）。
/// 本组件只管形制与交互：页面头右端的筛选框、来源筛选片、来源行的槽位、通道条表头、来源列、
/// 行带、提示框、行内展开、键盘与菜单命令、右键菜单、表格里的选择行、浮起提示小窗的锚点。
/// 不碰 api、不认后端状态：调用方把一切折算成「记号 + 能不能点 + 一句话」交进来，点了什么再原样交回去。
///
/// 版式（Matrix.css）：
/// - 面板定宽 776 = 复选 34 + 名称 246 + 来源 120 + 4 × 88 + 尾 24；agent 少时多出的给名称列，
///   多于 4 列（MCP 项目位置的 5 列）时名称列让到 158，面板宽不变——切页签时右端的键不跳（⑦）
/// - 表头底 1px `hairline` 结构线；行与行 1px `row-line`；行高 34
/// - 悬停只出行带，不出列带（D23）
/// - 格子提示框：一行动词，格子正上方 6，停留 700ms；格间移动每格重新计时，所以不追着鼠标
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
} from "react";
import type { Dot } from "./cellState";
import { compareBy, DOT_RANK, toggleSort, type SortState } from "./sort.ts";
import { pickOrigin } from "./originFilter.ts";
import {
  AgentIcon,
  Button,
  Cap,
  Checkbox,
  Chip,
  DOT_LABEL,
  FloatingToast,
  IconClose,
  IconSearch,
  Indicator,
  PINNED_TIP_MS,
  Spinner,
  StateDot,
  TIP_DELAY_MS,
  tipCeiling,
  Toast,
  Tooltip,
  useBusyShown,
} from "./ui/index.ts";
import { PageHeadActions } from "./shell/PageHead.tsx";
import { useMenuFlag, usePageCommand } from "./shell/menuBus.ts";
import { canPopup, contextMenuHandler, type ContextMenuItem } from "./contextMenu.ts";
import { displayPath, shortPath } from "./pathText.ts";
import "./Matrix.css";

/// 版式常量，与 Matrix.css 同值
const CHECK_W = 34;
const NAME_W = 246;
const ORIGIN_W = 120;
const COL_W = 88;
const TAIL_W = 24;
/// 列表里最多显示几个 agent（core 的 `MAX_SHOWN`，DESIGN「设置页 · 最多 4 个」）
const MAX_AGENTS = 4;
/// Skills 与 MCP 同一个固定面板宽度（DESIGN「位置页 › 面板宽度」）：页面头右端的筛选框与 `+ 来源`、
/// 来源片、来源行、表格右沿同一条线，切页签不跳。Matrix.css 里页面头的 `max-width` 与它同值
export const PANEL_W = CHECK_W + NAME_W + ORIGIN_W + MAX_AGENTS * COL_W + TAIL_W;

/// 点了做不了的格子后，说明停留的时长：与禁用控件按下钉出的提示框同一个（ui/Tooltip）
export { PINNED_TIP_MS };

/// 按下一格（点击或空格）做什么：能改的交给调用方改数据；做不了的只当即说明，不碰数据
export const cellPress = (view: Pick<MatrixCellView, "clickable">): "act" | "explain" =>
  view.clickable ? "act" : "explain";

/// 一格的键：行键 + 列 id。闪烁、就地提示都按它认格
const CELL_SEP = String.fromCharCode(31);
export const cellKey = (rowKey: string, columnId: string) => rowKey + CELL_SEP + columnId;

export interface MatrixColumn {
  id: string;
  /// harness id，决定图标
  agentId: string;
  /// 列头名：agent 名原样传进来，列头经 `Cap` 显示为 Condensed 大写（列头是 agent 身份）
  name: string;
  /// 列头第二行（MCP 项目位置里同一个 agent 的两处：`local` / `project`，经 `Cap` 大写）；不给就只有一行
  scope?: string;
  /// 列头第三层：这个 agent 下已加上的格数（只写分子）
  count: number;
  /// 列头提示框：`Claude Code · 41 个已加上`
  tip: string;
  /// 这一列的目录还不存在：图标外一圈虚线、名字退到 `ink-faint`、计数空（加上第一个时会自动创建）
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
  /// 「来源」格：来源名（同名来源用区分片段）+ 完整路径；悬停出路径提示框与 `打开 ↗`。
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
  /// 名字后的标注：`×2`、`2 份不一样`（安静键）、`Codex 不支持`（弱标识）
  mark?: ReactNode;
  /// 同名组：悬停（或键盘焦点）任一行，同组的行一起亮，并出 `extra`
  dupGroup?: string;
  /// 同名行悬停时的动作（`只留这份`），在名称格里，不越过面板右沿
  extra?: ReactNode;
  /// 点名字就地展开的详情（skill：描述 / 路径 + 打开 ↗ / 改于 …；MCP：传输 / 原件）；不给就不能展开
  detail?: ReactNode;
  /// 调用方控制开合的就地展开区（MCP 点 `2 份不一样` 展开的字段差异）：给了就出在这一行下面，
  /// 从名字左沿铺到最后一列；不给就收着
  panel?: ReactNode;
  /// 非空＝这一行勾不动，值是原因
  selectDisabledReason?: string;
  /// `extra` 里的动作正在执行（`只留这份` 在等体检）：不随悬停收起，忙碌指示留在原位
  extraPinned?: boolean;
  /// 右键菜单里「展开详情」之后的项（在访达中显示原件、拷贝路径、只留这份…）。
  /// 右键那一刻才取；`row` 是这一行此刻的元素（要确认的项锚在它上面）
  menu?: (row: HTMLElement) => ContextMenuItem[];
}

/// 选择行里一列的点（DESIGN「选择行」）：与格子同一套记号。**只有两态**：● ＝选中的在这一列里
/// （按能改的格算）全都有；否则 ○。点 ○ ＝全部加上（补齐缺的），点 ● ＝全部移除——和点格子是同一件事
export interface ColumnCheck {
  checked: boolean;
  /// 读屏名：`选中的都加到 Claude Code` / `选中的都从 Codex 移除`
  label: string;
  /// 提示框：动词 + 数量 + 受影响的名字；不受影响的注明原因
  tip: ReactNode;
  /// 没有可改的格子：点画 `ink-faint`、不出光晕，按下即说原因
  disabledReason?: string;
  onToggle: () => void;
}

/// 一片来源筛选片
export interface SourceChipItem {
  id: string;
  label: string;
  /// 提示框第一行的完整名（片名是最短区分片段、放不下还会截断）；不给就用 label
  full?: string;
  /// 提示框第二行的路径（原值；显示时写成短路径 `~/…`，mono）
  path?: string;
  /// 这个来源在表格里的行数
  count: number;
  /// 这个来源开着「以后新出现的自动加到」：片首一颗 6px 橙点（⑪⑮ 规则在背后做事，开着要看得见）
  rule?: boolean;
  /// 右键菜单（在访达中显示 · 移除来源…）；右键那一刻才取。`chip` 是这一片此刻的元素
  menu?: (chip: HTMLElement) => ContextMenuItem[];
}

export interface MatrixProps {
  columns: MatrixColumn[];
  /// 「来源」列的列头文字
  originLabel: string;
  /// 来源筛选片：`全部`（不带数，D12）在最前、默认选中；每片 `来源名 N`，选中为墨片。
  /// 放不下折行（不超出面板宽）；片名放不下截断，完整值用同一行右侧的提示框给。
  /// selected 空＝全部；用户点片是单选（originFilter.ts `pickOrigin`），加完来源时调用方可一次选中几片
  sources?: {
    selected: readonly string[];
    onSelect: (next: string[]) => void;
    items: SourceChipItem[];
    /// 片后同一行末尾的东西（`管理来源`，裁决 15）：跟着片折行
    tail?: ReactNode;
  };
  /// 来源行（恰好选中一个来源片时由调用方给）：片下 6，表格上距随之从 14 改为 10
  sourceRow?: ReactNode;
  rows: MatrixRowView[];
  /// 名称列头：`名称`
  nameLabel: string;
  /// 名称列头的提示框（机制说明放这里，不放常驻说明条）
  nameTip?: string;
  /// 名称列头后的总数（`名称 58`）：随当前筛选
  nameCount?: number;
  /// 读屏词用哪一套：skill 的「已加上 · 软链」，或 MCP 的「已写进 · 副本」（两边 linked 不是同一件事）
  dotWords?: "skill" | "mcp";

  filterText: string;
  onFilterText: (text: string) => void;
  /// 页面头右端、筛选框右边的动作（`+ 来源`）
  headActions?: ReactNode;

  /// 选中的行键
  selected: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  /// 选择行来源列那一点：「所有 agent」
  allAgents?: ColumnCheck;
  /// 选择行里每个 agent 列正下方的点，键为列 id
  columnChecks?: Record<string, ColumnCheck>;

  onCell: (rowKey: string, columnId: string) => void;
  onUndo?: () => void;
  /// 此刻有没有可撤销的操作：菜单「撤销」亮不亮（⌘Z 没有可撤的就是无操作）
  canUndo?: boolean;
  /// 键盘快捷键与菜单命令是否交给这张表（添加来源页推进来盖住它时关掉）
  shortcuts?: boolean;

  /// 一行都没有时，表头下面放什么（空态）
  empty?: ReactNode;
  /// 刚变化的格：播一次 120ms 反色闪，`nonce` 变了才重播。**只给单格**：批量时格子同时变成新状态、不闪
  flash?: { keys: string[]; nonce: number };
  /// 批量写入进行中：按下的那一点（"all" 或列 id）当即锁住（只锁它，别的点照常能按、排队执行），
  /// 过了 0.3 秒门槛那一点原位换成 14px 辐条转圈，`已选 N 个` 后面接一句（`· 正在加到 Codex`）
  keyBusy?: { keyId: string; label: string } | null;
  /// 点格之后真要等的（拆开整个文件夹链接）：过了 0.3 秒门槛，被点那一格正下方浮起转圈 + 一句
  cellBusy?: { rowKey: string; columnId: string; label: string } | null;
  /// 单格失败：被点那一格正下方的墨窗说原因（与成功同一个位置），8 秒，悬停停表
  cellNotice?: { rowKey: string; columnId: string; text: string } | null;
  onDismissCellNotice?: () => void;
  /// 一行的结果（只留这份）：锚在被按下的那个控件上（`at`：按下那一刻它的位置）
  rowToast?: {
    rowKey: string;
    at?: { top: number; bottom: number; left: number; right: number };
    node: ReactNode;
  } | null;
  /// 批量结果：浮在选择行里被按的那一点正下方 4，居中于该列（靠右沿时右对齐）
  keyToast?: { keyId: string; node: ReactNode } | null;
  /// 单格加上 / 移除成功：浮在被点那一格正下方 4。一次只一条：`id` 变了就重挂，计时从头来
  cellToast?: { id: number; rowKey: string; columnId: string; node: ReactNode } | null;
  /// 加完来源滑回：浮在新来源那几片的正下方 4；`id` 变了就是新的一条
  barToast?: { id: number; node: ReactNode; origins: string[] } | null;
}

/// 格的读屏名：状态名统一成「已加上 / 未加上」（「已开启」会读成应用开着）；受阻统称「受阻」（D22）、
/// 写失败说「无法写入」（D24）——这两个就是 ui 的 `DOT_LABEL`，不在这里另写一份。
/// skill 与 MCP 共用 `DOT_LABEL`，但 `linked`（这儿有一份）在两边不是同一件事——
/// skill 是一条软链，MCP 是一份独立配置副本（DESIGN「MCP 格子同样是开关」）：读屏词不能说反
const SKILL_DOT_TEXT: Record<Dot, string> = {
  ...DOT_LABEL,
  linked: "已加上 · 软链",
  missing: "未加上",
  own: "已加上 · 原件",
};
/// MCP 用词与格子提示框、原件格提示框同一套（`MCP_OWN_TIP`）：原件不说「已加上」
const MCP_DOT_TEXT: Record<Dot, string> = {
  ...DOT_LABEL,
  linked: "已写进 · 副本",
  missing: "未加上",
  own: "原件",
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

/// 按下的那一点的忙碌外观：不忙无类；忙了先只锁（`mx-locked`，点不动、不变淡），
/// 忙过 0.3 秒门槛（BUSY_DELAY_MS）才变淡（`ss-busy`）
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

/// `打开 ↗`：离开 Sophia 的外链（在访达中显示）。提示框是完整路径
export function RevealLink({ path, onReveal }: { path: string; onReveal: () => void }) {
  return (
    <Tooltip content={<span className="mx-mono">{displayPath(path)}</span>}>
      <span className="mx-reveal">
        <Button
          variant="external"
          ariaLabel={`在访达中显示 ${displayPath(path)}`}
          onClick={onReveal}
        >
          打开
        </Button>
      </span>
    </Tooltip>
  );
}

/// 页面头右端的筛选框（DESIGN「位置页 › 页面头」）：定宽 200、高 28 的凹面，放大镜在框内左侧，
/// 占位 `筛选`，框内右端写 `⌘F`（熟练路径看得见，⑩）；有字时右端换成 ✕ 清除（8px 内）。
/// 菜单「筛选」（⌘F）聚焦它；`enabled` 为 false（添加来源页盖在上面）时不接
export function FilterBox({
  value,
  onChange,
  inputRef,
  enabled = true,
}: {
  value: string;
  onChange: (text: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  enabled?: boolean;
}) {
  const own = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? own;
  usePageCommand("filter", () => {
    if (!enabled) return;
    ref.current?.focus();
    ref.current?.select();
  });
  return (
    <label className="mx-filter">
      <IconSearch size={16} />
      <input
        ref={ref}
        type="text"
        placeholder="筛选"
        aria-label="筛选"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value !== "") {
            e.stopPropagation();
            onChange("");
          }
        }}
      />
      {value !== "" ? (
        <button
          type="button"
          className="mx-filter__clear"
          title="清除筛选"
          aria-label="清除筛选"
          onClick={() => {
            onChange("");
            ref.current?.focus();
          }}
        >
          <IconClose size={12} />
        </button>
      ) : (
        <span className="mx-filter__key" aria-hidden="true">
          ⌘F
        </span>
      )}
    </label>
  );
}

/// 页面头右端：筛选框 + 这一页的动作（`+ 来源`），间距 8。表格还没有的时候（扫描中、这个位置
/// 没有页）也照常放，页面头不跳
export function LocationActions({
  filterText,
  onFilterText,
  actions,
  inputRef,
  enabled,
}: {
  filterText: string;
  onFilterText: (text: string) => void;
  actions?: ReactNode;
  inputRef?: RefObject<HTMLInputElement | null>;
  enabled?: boolean;
}) {
  return (
    <PageHeadActions>
      <FilterBox value={filterText} onChange={onFilterText} inputRef={inputRef} enabled={enabled} />
      {actions}
    </PageHeadActions>
  );
}

/// 选择行里的一点：10px 状态点（● / ○），与格子同形、同列、同行为。悬停时点不变、下层出光晕
/// （选择行底已是 surface，光晕用 track，见 Matrix.css）；提示框列受影响的名字；
/// 没有可改的格子时点 `ink-faint`、不出光晕，按下即说原因
function SelDot({
  check,
  locked = false,
  busy = false,
}: {
  check: ColumnCheck;
  /// 批量写入进行中：点不动（键盘的空格 / 回车也不行）
  locked?: boolean;
  /// 过了 0.3 秒门槛：点原位换成 14px 辐条转圈
  busy?: boolean;
}) {
  const disabled = check.disabledReason !== undefined;
  const button = (
    <button
      type="button"
      className={`ss-dot-btn mx-seldot${disabled ? " is-disabled" : ""}`}
      aria-label={disabled ? `${check.label}：${check.disabledReason}` : check.label}
      aria-disabled={disabled || undefined}
      onClick={disabled || locked ? undefined : () => check.onToggle()}
    >
      {busy ? (
        <Spinner size={14} label={check.label} />
      ) : (
        <StateDot
          dot={check.checked ? "linked" : "missing"}
          hoverable={!disabled}
          muted={disabled}
          title=""
          label={check.checked ? "已加上" : "未加上"}
        />
      )}
    </button>
  );
  return (
    // 没有可改的格子：按下当即说明原因（同禁用的键），不是按下即收起
    <Tooltip content={check.disabledReason ?? check.tip} placement="bottom" explain={disabled}>
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
    sourceRow,
    rows,
    nameLabel,
    nameTip,
    dotWords = "skill",
    filterText,
    onFilterText,
    headActions,
    nameCount,
    selected,
    onSelectionChange,
    allAgents,
    columnChecks,
    onCell,
    onUndo,
    canUndo = false,
    shortcuts = true,
    empty,
    flash,
    cellNotice,
    onDismissCellNotice,
    rowToast,
    keyToast,
    cellToast,
    keyBusy,
    cellBusy,
    barToast,
  } = props;

  const tipId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // 默认排序：名称升序，同名两份天然相邻（DESIGN「默认值」）；当前排序依据列常显箭头
  const [sortState, setSort] = useState<SortState | null>(null);
  const sort: SortState = sortState ?? { key: "name", dir: "asc" };
  // 悬停的行（行带）
  const [hover, setHover] = useState<{ row: string; col: string | null } | null>(null);
  // 右键菜单开着的那一行：出 surface 行带，菜单关掉即消失
  const [menuRow, setMenuRow] = useState<string | null>(null);
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
  // 吸顶：来源片（+ 来源行）在页面头下，列头（+ 选择行）紧贴它下面
  const barRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const [barH, setBarH] = useState(0);
  // 就地展开详情的那一行（一次只展开一行）
  const [expanded, setExpanded] = useState<string | null>(null);

  const dotText = dotWords === "mcp" ? MCP_DOT_TEXT : SKILL_DOT_TEXT;
  const template = [
    `${CHECK_W}px`,
    // 名称列吸收面板里余下的宽度：4 列时 246、少于 4 列更宽、5 列时 158
    "minmax(0, 1fr)",
    `${ORIGIN_W}px`,
    ...columns.map(() => `${COL_W}px`),
    `${TAIL_W}px`,
  ].join(" ");
  const width = PANEL_W;
  const gridStyle: CSSProperties = { gridTemplateColumns: template };

  // ---- 排序：名称 / 来源 / 某一列的格；同值再按名称、来源，同名两份相邻 ----
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

  // ---- 吸顶区的高度 ----
  // 来源片折行、来源行出现 / 消失都会改高度：只在 resize 时量，列头就停在旧高度上，
  // 行从来源片和列头之间的缝里漏出来（产品负责人真机）
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

  // ---- 键盘：方向键在格间移动，焦点环在格上，行带跟随 ----
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

  // ---- 菜单命令（DESIGN「应用菜单」）：⌘F 聚焦筛选框（FilterBox 自己接）、⌘A 勾选当前筛选的
  // 全部行、⌘Z 撤销最近一次可撤销的操作（没有就无操作，菜单项灰着）。输入框聚焦时壳把全选 / 撤销
  // 作用于文字，不会发到这里 ----
  const live = useRef({ onUndo, onSelectionChange, selected, flat, expanded, shortcuts });
  live.current = { onUndo, onSelectionChange, selected, flat, expanded, shortcuts };
  const selectAllVisible = () => {
    const s = live.current;
    if (!s.shortcuts || s.flat.length === 0) return;
    const next = new Set(s.selected);
    for (const r of s.flat) if (r.selectDisabledReason === undefined) next.add(r.key);
    s.onSelectionChange(next);
  };
  const undoLast = () => {
    if (live.current.shortcuts) live.current.onUndo?.();
  };
  usePageCommand("select-all", selectAllVisible);
  usePageCommand("undo", undoLast);
  useMenuFlag("undo", shortcuts && canUndo);

  // 键盘直达：Esc 先收起展开的行，再取消选择。在 Tauri 里 ⌘F / ⌘Z / ⌘A 由菜单栏接走（上面的
  // 页面命令）；不在 Tauri 里（浏览器预览）没有菜单栏，这里照同样的行为接按键
  useEffect(() => {
    if (!shortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;
      const s = live.current;
      if (mod && !canPopup()) {
        const key = e.key.toLowerCase();
        if (key === "f") {
          e.preventDefault();
          filterRef.current?.focus();
          filterRef.current?.select();
          return;
        }
        if (typing) return;
        if (key === "z" && !e.shiftKey) {
          e.preventDefault();
          undoLast();
          return;
        }
        if (key === "a") {
          e.preventDefault();
          selectAllVisible();
          return;
        }
      }
      if (typing) return;
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
    // live 里拿最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortcuts]);

  // ---- 行带：悬停优先，其次键盘焦点，再次右键菜单开着的那一行 ----
  const focusRow = focusWithin ? flat[focus.r] : undefined;
  const activeRow = hover?.row ?? focusRow?.key ?? menuRow;
  const activeDup =
    flat.find((r) => r.key === activeRow)?.dupGroup ??
    (focusRow !== undefined ? focusRow.dupGroup : undefined);

  // ---- 忙碌锁：只锁按下的那一点（防重复点；别的点照常能按，调用方排队执行），过了 0.3 秒门槛
  // 才变淡、原位换成转圈 ----
  const busyShown = useBusyShown(keyBusy != null);
  const cellBusyShown = useBusyShown(cellBusy != null);
  // 浮起的提示小窗：换一条（调用方给了新对象）就是新出现一次——重挂、重新定位、计时从头来
  const keyToastKey = useIdentityKey(keyToast);
  const rowToastKey = useIdentityKey(rowToast);
  const lockOf = (keyId: string) => busyLockClass(keyBusy?.keyId === keyId, busyShown);

  const selecting = selectedVisible.length > 0;

  // ---- 表头 ----
  const sortBy = (key: string) => setSort((prev) => toggleSort(prev ?? sort, key));
  const nameHead = (
    <button type="button" className="mx-headbtn" onClick={() => sortBy("name")}>
      {nameLabel}
      {nameCount !== undefined ? <span className="mx-namecount">{nameCount}</span> : null}
      <SortArrow active={sort.key === "name"} desc={sort.dir === "desc"} />
    </button>
  );
  const header = (
    <div className="mx-grid mx-head" style={gridStyle}>
      <div className="mx-head__check">
        {/* 表头整行不置灰，只灰这个全选框 */}
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
            {nameHead}
          </Tooltip>
        ) : (
          nameHead
        )}
      </div>
      {/* 来源：点文字按来源排序（同来源聚拢） */}
      <div className="mx-head__origin">
        <button type="button" className="mx-headbtn" onClick={() => sortBy("origin")}>
          {originLabel}
          <SortArrow active={sort.key === "origin"} desc={sort.dir === "desc"} />
        </button>
      </div>
      {columns.map((col) => (
        <div key={col.id} data-col={col.id} className="mx-head__col">
          {/* 列头只排序；悬停只出提示框，不出列带（D23） */}
          <Tooltip content={col.tip} context="table" placement="bottom">
            <button
              type="button"
              className={`mx-colbtn${col.missing ? " is-missing" : ""}`}
              aria-label={`${col.tip}，按这一列排序`}
              onClick={() => sortBy(col.id)}
            >
              <span className="mx-colbtn__icon">
                <AgentIcon id={col.agentId} name={col.name} />
              </span>
              <span className="mx-colbtn__name">
                <Cap>{col.name}</Cap>
              </span>
              {col.scope ? (
                <span className="mx-colbtn__scope">
                  <Cap>{col.scope}</Cap>
                </span>
              ) : null}
              <span className="mx-colbtn__count">{col.missing ? "" : col.count}</span>
              <SortArrow active={sort.key === col.id} desc={sort.dir === "desc"} />
            </button>
          </Tooltip>
        </div>
      ))}
      <div />
    </div>
  );

  // ---- 选择行（D4）：勾了行之后表头结构线下插入一条，用表格同一套列；每个 agent 列正下方一点 ----
  const busyKey = keyBusy?.keyId;
  const selRow = selecting ? (
    <div className="mx-grid mx-selrow" style={gridStyle}>
      {/* 复选列空着：全选框就在正上方的表头里 */}
      <div />
      <div className="mx-selrow__name">
        <span className="mx-selcount">{`已选 ${selectedVisible.length} 个`}</span>
        {/* 取消选择是 busy 的豁免项：它不写磁盘；等于 Esc */}
        <Button variant="quiet" onClick={() => onSelectionChange(new Set())}>
          取消
        </Button>
        {busyShown && keyBusy ? (
          <span className="mx-selbusy" role="status">
            {`· ${keyBusy.label}`}
          </span>
        ) : null}
      </div>
      <div className="mx-selrow__all">
        {allAgents ? (
          <>
            <span className="mx-selrow__alllabel">所有 agent</span>
            <span className="mx-keywrap" data-key="all">
              <span className={lockOf("all")}>
                <SelDot
                  check={allAgents}
                  locked={busyKey === "all"}
                  busy={busyShown && busyKey === "all"}
                />
              </span>
            </span>
          </>
        ) : null}
      </div>
      {columns.map((col) => (
        <div key={col.id} className="mx-selrow__col">
          {columnChecks?.[col.id] ? (
            <span className="mx-keywrap" data-key={col.id}>
              <span className={lockOf(col.id)}>
                <SelDot
                  check={columnChecks[col.id]}
                  locked={busyKey === col.id}
                  busy={busyShown && busyKey === col.id}
                />
              </span>
            </span>
          ) : null}
        </div>
      ))}
      <div />
    </div>
  ) : null;

  // ---- 表身 ----
  const renderRow = (row: MatrixRowView) => {
    const r = rowIndex.get(row.key) ?? 0;
    const isSelected = selected.has(row.key);
    const hot = activeRow === row.key || (row.dupGroup !== undefined && row.dupGroup === activeDup);
    const classes = ["mx-grid", "mx-row"];
    if (isSelected) classes.push("is-selected");
    if (hot) classes.push("is-hot");
    const showExtra = row.extra !== undefined && (hot || row.extraPinned === true);
    const open = expanded === row.key && row.detail !== undefined;
    // 右键菜单（D18）：只作加速器，每一项在界面上都另有入口；不改变勾选
    const menuItems = (el: HTMLElement): ContextMenuItem[] => [
      ...(row.detail !== undefined
        ? [
            {
              label: open ? "收起详情" : "展开详情",
              run: () => setExpanded(open ? null : row.key),
            },
          ]
        : []),
      "separator",
      ...(row.menu?.(el) ?? []),
    ];

    return (
      <Fragment key={row.key}>
        <div
          data-row={row.key}
          className={classes.join(" ")}
          style={gridStyle}
          onMouseEnter={() => setHover({ row: row.key, col: null })}
          onMouseLeave={() => setHover(null)}
          onContextMenu={(e) => {
            const el = e.currentTarget;
            contextMenuHandler(() => menuItems(el), {
              onOpen: () => setMenuRow(row.key),
              onClose: () => setMenuRow((prev) => (prev === row.key ? null : prev)),
            })(e);
          }}
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
          </div>
          {/* 来源：写来源名；悬停出完整路径提示框与 `打开 ↗`（这一行已展开时只出提示框） */}
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
                    <span className="mx-origin__seg">{` · ${row.origin.split.seg}`}</span>
                  </>
                ) : (
                  row.origin.label
                )}
              </span>
            </Tooltip>
            {hot && !open && !row.origin.gone ? (
              <RevealLink path={row.origin.path} onReveal={row.origin.onReveal} />
            ) : null}
          </div>
          {columns.map((col, c) => {
            const view = row.cells[col.id] ?? null;
            const key = cellKey(row.key, col.id);
            const cellClasses = ["mx-cell"];
            if (flashing.has(key)) cellClasses.push("ss-flash");
            const focused = focus.r === r && focus.c === c;
            const enter = () => {
              setHover({ row: row.key, col: col.id });
              armTip(key);
            };
            return (
              <div
                key={col.id}
                data-col={col.id}
                className={cellClasses.join(" ")}
                onMouseEnter={enter}
                onMouseLeave={() => {
                  setHover({ row: row.key, col: null });
                  dropTip();
                }}
                // 格子本身就是开关，没有第二个动作：右键不出菜单（DESIGN「右键菜单」）
                onContextMenu={(e) => e.stopPropagation()}
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
                    aria-label={`${row.name} · ${col.name}：${dotText[view.dot]}。${view.tip}`}
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
                      label={dotText[view.dot]}
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
              </div>
            );
          })}
          <div />
        </div>
        {open ? (
          // 就地展开：左沿与名字对齐，不跨进 agent 列
          <div className="mx-grid mx-detail" style={gridStyle}>
            <div className="mx-detail__body" style={{ gridColumn: "2 / span 2" }}>
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
      <LocationActions
        filterText={filterText}
        onFilterText={onFilterText}
        actions={headActions}
        inputRef={filterRef}
        enabled={shortcuts}
      />
      {/* 来源片与来源行吸在页面头下；表格上距在这一块的下内边距里（有来源行时 10，否则 14） */}
      <div className={`mx-bar${sourceRow ? " has-sourcerow" : ""}`} ref={barRef}>
        {sources ? <SourceChips {...sources} width={width} /> : null}
        {sourceRow ? <div className="mx-sourcerow-slot">{sourceRow}</div> : null}
      </div>
      <div className="mx-panel" ref={panelRef} style={{ width }}>
        {/* 列头连同结构线与选择行吸顶，紧贴来源片（+ 来源行）下面 */}
        <div
          className="mx-headwrap"
          ref={headRef}
          style={{ top: `calc(var(--mx-top) + ${barH}px)` }}
        >
          {header}
          {selRow}
        </div>
        <div
          className="mx-body"
          ref={bodyRef}
          onKeyDown={onBodyKey}
          onFocus={(e) => {
            // 行带只跟随键盘焦点：鼠标点过的格子留着焦点，但鼠标移开后不该再亮着
            const target = e.target as HTMLElement;
            setFocusWithin(target.matches(":focus-visible"));
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
          }}
        >
          {flat.map(renderRow)}
        </div>
        {flat.length === 0 && empty ? <div className="mx-empty">{empty}</div> : null}
      </div>
      {/* 浮起的提示小窗（DESIGN「反馈的两种形态」）：挂在表的最外层、按锚点定位，不挂进格 / 行里——
          挂进去的话，悬停小窗会被当成悬停那一格（行带、格子提示框跟着出来） */}
      {keyToast ? (
        <FloatingToast
          key={`key:${keyToastKey}`}
          anchor={keyAnchor(keyToast.keyId)}
          bounds={panelBounds}
        >
          {keyToast.node}
        </FloatingToast>
      ) : null}
      {cellBusy && cellBusyShown ? (
        // 单格真要等（过了门槛）：结果出现之前，同一个位置先说在忙什么
        <FloatingToast
          key={`busy:${cellBusy.rowKey}:${cellBusy.columnId}`}
          anchor={cellAnchor(cellBusy.rowKey, cellBusy.columnId)}
          bounds={panelBounds}
        >
          <span className="ss-toast ss-toast--routine mx-cellbusy" role="status">
            <Spinner size={14} label={cellBusy.label} />
            <span>{cellBusy.label}</span>
          </span>
        </FloatingToast>
      ) : cellNotice ? (
        // 单格：成功与失败同一个位置（格子正下方），一次只一条，失败优先
        <FloatingToast
          key={`notice:${cellNotice.rowKey}:${cellNotice.columnId}:${cellNotice.text}`}
          anchor={cellAnchor(cellNotice.rowKey, cellNotice.columnId)}
          bounds={panelBounds}
        >
          <Toast kind="cannot" message={cellNotice.text} onDismiss={onDismissCellNotice} />
        </FloatingToast>
      ) : cellToast ? (
        <FloatingToast
          key={`cell:${cellToast.id}`}
          anchor={cellAnchor(cellToast.rowKey, cellToast.columnId)}
          bounds={panelBounds}
        >
          {cellToast.node}
        </FloatingToast>
      ) : null}
      {rowToast ? (
        <FloatingToast
          key={`row:${rowToastKey}`}
          align="start"
          anchor={rowToast.at ? () => rowToast.at : rowAnchor(rowToast.rowKey)}
          bounds={panelBounds}
        >
          {rowToast.node}
        </FloatingToast>
      ) : null}
      {barToast ? (
        <FloatingToast
          key={`bar:${barToast.id}`}
          align="start"
          anchor={chipsAnchor(barToast.origins)}
        >
          {barToast.node}
        </FloatingToast>
      ) : null}
    </div>
  );
}

/// 同一个对象同一个号，换了对象号加一（渲染里读写 ref：同一个值重渲染多少次都得同一个号）
function useIdentityKey(value: unknown): number {
  const ref = useRef<{ value: unknown; n: number }>({ value, n: 0 });
  if (ref.current.value !== value) ref.current = { value, n: ref.current.n + 1 };
  return ref.current.n;
}

const rootOf = (probe: HTMLElement) => probe.closest(".mx");
const rowEl = (probe: HTMLElement, rowKey: string) =>
  rootOf(probe)?.querySelector(`.mx-row[data-row="${CSS.escape(rowKey)}"]`);
/// 浮起的提示小窗水平夹在面板左右沿之内
const panelBounds = (probe: HTMLElement) => rootOf(probe)?.querySelector(".mx-panel");

/// 批量：选择行里被按的那一点所在的列（居中于该列；靠右沿时右对齐，由 placeToast 夹进面板）
const keyAnchor = (keyId: string) => (probe: HTMLElement) =>
  rootOf(probe)?.querySelector(`.mx-keywrap[data-key="${CSS.escape(keyId)}"]`);

/// 单格：被点的那一格
const cellAnchor = (rowKey: string, columnId: string) => (probe: HTMLElement) =>
  rowEl(probe, rowKey)?.querySelector(`.mx-cell[data-col="${CSS.escape(columnId)}"]`);

/// 一行的结果浮在该行下方：上下沿取整行，左沿取名字那一格（勾选列之后）
const rowAnchor = (rowKey: string) => (probe: HTMLElement) => {
  const row = rowEl(probe, rowKey);
  const name = row?.querySelector(".mx-row__name");
  if (!row || !name) return row;
  const r = row.getBoundingClientRect();
  const n = name.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: n.left, right: r.right };
};

/// 加完来源的那一窗浮在新来源那几片的正下方：取这几片合起来的矩形；一片都没有时锚在整排片上
const chipsAnchor = (origins: string[]) => (probe: HTMLElement) => {
  const group = rootOf(probe)?.querySelector(".mx-sources");
  const chips = origins
    .map((id) => group?.querySelector(`[data-origin="${CSS.escape(id)}"]`))
    .filter((el): el is Element => el != null)
    .map((el) => el.getBoundingClientRect());
  if (chips.length === 0) {
    const first = group?.firstElementChild?.getBoundingClientRect();
    return first
      ? { top: first.top, bottom: first.bottom, left: first.left, right: first.right }
      : group;
  }
  return {
    top: Math.min(...chips.map((c) => c.top)),
    bottom: Math.max(...chips.map((c) => c.bottom)),
    left: Math.min(...chips.map((c) => c.left)),
    right: Math.max(...chips.map((c) => c.right)),
  };
};

/// 来源筛选片平铺（DESIGN「位置页 › 来源筛选片」）。点片＝只看这个来源（单选），再点 `全部` 恢复。
/// `全部` 不带数：总数在 `名称 N` 上（D12）。开着自动规则的来源片首一颗橙点
function SourceChips({
  selected,
  onSelect,
  items,
  tail,
  width,
}: NonNullable<MatrixProps["sources"]> & { width: number }) {
  return (
    <div className="mx-sources" style={{ maxWidth: width }} role="group" aria-label="按来源筛选">
      {/* `全部` 片没有提示框，也没有右键菜单；格子、列头右键同样没有（DESIGN「右键菜单」） */}
      <Chip selected={selected.length === 0} onClick={() => onSelect([])}>
        全部
      </Chip>
      {items.map((item) => (
        <span
          key={item.id}
          className={`mx-sourcechip${item.rule ? " has-rule" : ""}`}
          data-origin={item.id}
          onContextMenu={(e) => {
            const el = e.currentTarget;
            if (item.menu) contextMenuHandler(() => item.menu?.(el) ?? [])(e);
          }}
        >
          <Tooltip content={<SourceChipTip item={item} />}>
            <Chip
              selected={selected.includes(item.id)}
              count={item.count}
              icon={
                item.rule ? <Indicator on label="以后新出现的会自动加上，规则开着" /> : undefined
              }
              onClick={() => onSelect(pickOrigin(selected, item.id))}
            >
              {item.label}
            </Chip>
          </Tooltip>
        </span>
      ))}
      {tail}
    </div>
  );
}

/// 来源片悬停的提示框（DESIGN「来源筛选片」）：完整名 + 短路径 + 选中后能做什么。来源行只在恰好选中一片时
/// 出现，入口要让人看得见（⑧）；路径与这句都是片上没有的信息，不算重复
export const SOURCE_CHIP_HINT = "选中后在下方设置自动添加或移除";

export function SourceChipTip({ item }: { item: Pick<SourceChipItem, "label" | "full" | "path"> }) {
  return (
    <>
      {item.full ?? item.label}
      {item.path ? (
        <>
          <br />
          <span className="mx-mono mx-chiptip__path">{shortPath(item.path)}</span>
        </>
      ) : null}
      <br />
      {SOURCE_CHIP_HINT}
    </>
  );
}
