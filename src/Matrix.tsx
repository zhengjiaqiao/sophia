/// 位置页的表格（DESIGN「位置页：skills ｜ mcp」「表格（组件）」「选择行」「列头的悬停」
/// 「格子悬停光晕」「提示框」「键盘」「右键菜单」，画板 V4Layouts skills / skills-select / sources / mcp）。
///
/// Skills 与 MCP **共用这一张表**：两边只是内容不同——行是 skill 或 MCP 服务，列是 agent，
/// 格是同一套状态点（以后 `sessions` 页签也沿用它，所以这里不认任何 skill / MCP 专有字段）。
/// 本组件只管形制与交互：页面头右端的筛选框与管来源的两颗键、bar 插槽（调用方放什么就是什么，
/// 例如项目筛选片，见 R4）、通道条表头、来源列、
/// 行带、提示框、行详情抽屉、键盘与菜单命令、右键菜单、表格里的选择行、浮起提示小窗的锚点、
/// 新手提示条的两个插槽（bar 插槽下、空态上）。位置页上没有来源行：管来源进二级页「来源管理页」。
/// 不碰 api、不认后端状态：调用方把一切折算成「记号 + 能不能点 + 一句话」交进来，点了什么再原样交回去。
///
/// 版式（Matrix.css）：
/// - 面板定宽 776 = 复选 34 + 名称 246 + 来源 144 + 4 × 88；agent 少时多出的给名称列。
///   多于 4 格（MCP 的 Claude 合组、项目里的 Local / Project）时每格收窄：5 格 76、6 格 64，名称列至少留 200，
///   面板宽不变——切页签时右端的键不跳（⑦）
/// - 表头底 1px `hairline` 结构线；行与行 1px `row-line`；行高 34
/// - 悬停只出行带，不出列带（D23）
/// - 格子提示框：一行动词，格子正上方 6，停留 700ms；格间移动每格重新计时，所以不追着鼠标
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
} from "react";
import type { Dot } from "./cellState";
import { compareBy, DOT_RANK, toggleSort, type SortState } from "./sort.ts";
import {
  AddButton,
  AgentIcon,
  BusySlot,
  Button,
  Cap,
  Checkbox,
  DOT_LABEL,
  Drawer,
  DrawerHandle,
  FloatingToast,
  IconSortArrow,
  Mono,
  PageHeadActions,
  PINNED_TIP_MS,
  Spinner,
  StateDot,
  StateDotButton,
  TextField,
  TIP_DELAY_MS,
  Toast,
  Tooltip,
  useBusyShown,
} from "./ui/index.ts";
import { useMenuFlag, usePageCommand } from "./shell/menuBus.ts";
import { canPopup, contextMenuHandler, type ContextMenuItem } from "./contextMenu.ts";
import { displayPath } from "./pathText.ts";
import { t, tn, tRich, type MessageKey } from "./i18n.ts";
import { sourceNoun } from "./terms.ts";
import { sentencePieces } from "./ui/sentence.tsx";
import { keyboardModality } from "./inputModality.ts";
import "./Matrix.css";

/// 版式常量，与 Matrix.css 同值
const CHECK_W = 34;
const NAME_W = 246;
const ORIGIN_W = 144;
/// 多位置时名称后的「位置」列（spec 2026-09-26-object-first-navigation R6）：地方够时位置 88、来源照常 144；
/// agent 列多了放不下时，先把来源收到 80、再把位置收到 72，先保住名称列 246——MCP 项目带 Local 时 5 个 agent 列，
/// 两列都到下限，名称列仍留 150，放得下「名字 + 2 处不支持」。截掉的位置名、来源名在提示框里
const PLACE_W = 88;
const PLACE_W_MIN = 72;
const ORIGIN_W_MIN = 80;
const COL_W = 88;
/// 5 格、6 格时每格的宽（DESIGN「MCP 支持哪些 agent › 格宽」）
const COL_W_5 = 76;
const COL_W_6 = 64;
/// 名字前的拉手列：拉手 18 + 6（Matrix.css 的 `--mx-handle-col` 同值）
const HANDLE_W = 24;
/// 抽屉要并排几份值（MCP 的字段差异）时右沿只让出这么多
const WIDE_DETAIL_END = 24;
/// 悬停状态里「来源格」的列标记（agent 列用 target id，不会撞上）
const ORIGIN_COL = "\u0000origin";
/// 悬停的是生效范围格（行内悬停键 `修改` 只在悬停这一格时出）
const PLACE_COL = "\u0000place";
/// 列表里最多显示几个 agent（core 的 `MAX_SHOWN`，DESIGN「设置页 · 最多 4 个」）
const MAX_AGENTS = 4;
/// Skills 与 MCP 同一个固定面板宽度（DESIGN「位置页 › 面板宽度」）：页面头右端的筛选框与 `+ 来源`、
/// bar 插槽、表格右沿同一条线，切页签不跳。Matrix.css 里页面头的 `max-width` 与它同值
export const PANEL_W = CHECK_W + NAME_W + ORIGIN_W + MAX_AGENTS * COL_W;
/// 面板随窗口变宽的上限（2026-09-30 产品负责人：「左右拉动界面宽度，没有等比例变化，导致大片空白」；
/// tokens.css `--panel-w` 同值）：再宽就留白——行太宽时行与列头隔得太远、难对
export const PANEL_MAX = 1200;

/// 面板此刻的宽：可用宽度夹在 776（最窄窗口里本来就放得下）与上限之间；还没量到（0）按最窄
export function panelWidth(available: number): number {
  return Math.min(PANEL_MAX, Math.max(PANEL_W, Math.floor(available)));
}

/// 这么宽的面板里位置列、来源列各多宽：776 时同原来（`placeWidths` / 来源 144）；更宽时多出来的按
/// 名称 : 位置 : 来源 在 776 时的比例分，agent 列不变，名称列（1fr）拿余下的。没有位置列时 place 为 null
export function panelColumns(
  agentColumns: number,
  hasPlace: boolean,
  width: number,
): { place: number | null; origin: number } {
  const base = hasPlace ? placeWidths(agentColumns) : { place: 0, origin: ORIGIN_W };
  const name =
    PANEL_W - CHECK_W - agentColumns * agentColumnWidth(agentColumns) - base.place - base.origin;
  const extra = Math.max(0, width - PANEL_W);
  const share = (w: number) => w + Math.round((extra * w) / (name + base.place + base.origin));
  return { place: hasPlace ? share(base.place) : null, origin: share(base.origin) };
}

/// 每个 agent 格的宽：一共不超过 4 格时 88；5 格 76；6 格（`全部` 下 Claude 三格 + 另外 3 家）64
export function agentColumnWidth(agentColumns: number): number {
  return agentColumns <= MAX_AGENTS ? COL_W : agentColumns === 5 ? COL_W_5 : COL_W_6;
}

/// 列头按合组切段：相邻几列同一个 `group.id` 并成一段（共用组头），其余一列一段
export function headerRuns(
  columns: MatrixColumn[],
): Array<{ group?: MatrixColumn["group"]; columns: MatrixColumn[] }> {
  const runs: Array<{ group?: MatrixColumn["group"]; columns: MatrixColumn[] }> = [];
  for (const col of columns) {
    const last = runs[runs.length - 1];
    if (col.group && last?.group?.id === col.group.id) last.columns.push(col);
    else runs.push({ group: col.group, columns: [col] });
  }
  return runs;
}

/// 多位置时位置列与来源列的宽：先给名称列留足 246，不够时依次收来源、收位置，都到下限就不再收
export function placeWidths(agentColumns: number): { place: number; origin: number } {
  const free = PANEL_W - CHECK_W - agentColumns * agentColumnWidth(agentColumns);
  let place = PLACE_W;
  let origin = ORIGIN_W;
  let short = NAME_W - (free - place - origin);
  const o = Math.max(0, Math.min(short, origin - ORIGIN_W_MIN));
  origin -= o;
  short -= o;
  place -= Math.max(0, Math.min(short, place - PLACE_W_MIN));
  return { place, origin };
}

/// 点了做不了的格子后，说明停留的时长：与禁用控件按下钉出的提示框同一个（ui/Tooltip）
export { PINNED_TIP_MS };

/// 按下一格（点击或空格）做什么：能改的交给调用方改数据；做不了的只当即说明，不碰数据
export const cellPress = (view: Pick<MatrixCellView, "clickable">): "act" | "explain" =>
  view.clickable ? "act" : "explain";

/// 一格的键：行键 + 列 id。闪烁、就地提示都按它认格
const CELL_SEP = String.fromCharCode(31);
export const cellKey = (rowKey: string, columnId: string) => rowKey + CELL_SEP + columnId;

/// 单格失败的提示条。`failure` 给了就画整句（`context7 写进 [Codex] 失败 · 没有写入权限，没动`，副行文件路径；
/// spec 2026-10-04-local-diagnostics R12，画板 AuPbAQHePv3L1U3g1PAtH8），不给就把 `text` 当整句。提示条里不放详情
export interface CellNotice {
  rowKey: string;
  columnId: string;
  text: string;
  failure?: {
    sentence: MessageKey;
    names: string[];
    agents: { id: string; name: string }[];
    reason?: string;
    /// 副行：等宽读数（写的是哪个文件，主目录写 `~`）
    stats?: string;
  };
}

export interface MatrixColumn {
  id: string;
  /// harness id，决定图标
  agentId: string;
  /// 列头名：agent 名原样传进来，列头经 `Cap` 显示为 Condensed 大写（列头是 agent 身份）
  name: string;
  /// 列头第二行（`ink-faint` 小标，经 `Cap` 大写）；不给就只有一行。
  /// 在合组里时是组头线下这一格的小标（MCP 的 `仅自己` / `团队共享`）
  scope?: string;
  /// 名字放不下一行时的后半截（`Claude` + `Desktop`）：第二行与名字同字重、同墨色，读成一个名字，
  /// 占小标那一行的位置（spec 2026-09-30-mcp-claude-self-team R2）
  nameTail?: string;
  /// 合组列头：相邻几列同一个 `group.id` 时共用一个图标 + 名字，下面一条结构线横跨这几格，
  /// 线下每格只写小标（`scope`）+ 计数（MCP 的 Claude Code：`CLAUDE CODE` 下分 `仅自己` / `团队共享`）
  group?: { id: string; agentId: string; name: string };
  /// 列头第三层：这个 agent 下已加上的格数（只写分子）
  count: number;
  /// 列头提示框：`Claude Code · 41 个已加上`
  tip: string;
  /// 列头提示框另起的一行补充说明（MCP 项目位置下 Copilot 列头的 `Copilot 也会读这个项目的 .mcp.json…`）
  note?: string;
  /// 这一列的目录还不存在：图标外一圈虚线、名字退到 `ink-faint`、计数空（加上第一个时会自动创建）
  missing?: boolean;
}

export interface MatrixCellView {
  dot: Dot;
  /// 点下去会做事（开关、写进、重新链接）；false 时点击无动作，只由提示框说原因
  clickable: boolean;
  /// 提示框一行：可点时是「动词」（`加到 Claude Code`），不可点时是原因
  tip: string;
  /// 提示框第二行（墨面上的次字）：只在动词说不清落到哪时给（MCP 项目行里 Claude Code 两格：写在哪、给谁用）
  tipDetail?: string;
  /// 单格写入进行中：画成灰色的将来状态（批量不用它，格子同时变）
  pending?: boolean;
  /// 多位置的表里「这一行的位置没有这一列」（spec 2026-09-26-object-first-navigation AC16）：空着、不画记号，
  /// 悬停 / 键盘焦点照样出提示框说原因，点一下只说明
  blank?: boolean;
}

export interface MatrixRowView {
  key: string;
  name: string;
  /// 「位置」格：这一行所在的位置（`用户级` 或项目名）；表格给了 `placeLabel` 时才画
  place?: string;
  /// 生效范围格的动作（MCP 修改生效范围，spec 2026-09-30-mcp-config-scope R3）：悬停这一格（或键盘焦点在这一行）时，
  /// 值后面跟一颗默认键紧凑（`label`，提示框 `tip`），按下交给调用方（出确认框）——行内悬停键，同来源格的 `打开 ↗`。
  /// 格子本身不画底色与 ˅：「值 + ˅」是下拉框，像筛选（2026-09-30 产品负责人）
  placeAction?: { label: string; tip: string; onOpen: (trigger: HTMLElement) => void };
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
    /// 写的就是路径（MCP「配置文件」，spec 2026-09-30-mcp-config-scope R1）：等宽小字、`label` 是放得下的写法，
    /// 列窄时从左边截、留住文件名；悬停同来源格一样出 `打开 ↗`（行内悬停键）
    asPath?: boolean;
  };
  /// 列 id → 格；null＝这一行在这一列没有格（短横，不可点）
  cells: Record<string, MatrixCellView | null>;
  /// 名字后的记号，算名字的一部分：`×2`、`2 份不一样`、`Codex 不支持`——都是纯文字（12 号），不是键。
  /// 名称格里只有「名字 记号 ˅」，行内的动作（只留这份、看差异）都在这一行的抽屉里；
  /// 点记号与点名字一样拉开抽屉
  mark?: ReactNode;
  /// 悬停（或键盘焦点在这一行）时紧跟记号出现的一颗键；抽屉拉开时不出（抽屉里有同一颗）。
  /// 同名推荐保留的那一行：`只留这份`（2026-09-30 产品负责人：「悬浮到推荐保留的时候，右边也能出来一个只留这份的按钮」）
  hoverAction?: ReactNode;
  /// 同名组：悬停（或键盘焦点）任一行，同组的行一起亮
  dupGroup?: string;
  /// 行详情，收在这一行下面的抽屉里（skill：描述 / 路径 + 打开 ↗ / 改于 … / 同名时 `只留这份`；
  /// MCP：传输 / 命令 / 原件 / 几份不一样时的字段差异）：名字后跟拉手，点名字、记号或拉手拉开；
  /// 不给就没有拉手、不能拉开。表格一次只开一格
  detail?: ReactNode;
  /// 抽屉要并排几份值（MCP 的字段差异）：从名字左沿铺到最后一列，只让出尾列
  detailWide?: boolean;
  /// 非空＝这一行勾不动，值是原因
  selectDisabledReason?: string;
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
  /// 画成一颗键时键上写什么（选择行的「所有 agent」键，2026-09-30 产品负责人：「加入 xx（xx 是 agent 图标）」）：
  /// 一句整句，`{agents}` 是这一下真会改到的 agent 的图标（按图标去重）——`加到 [✳][⎔]`、`从 [✳][⎔] 移除`
  /// （`line` 是目录键，语序归各语言的译文）。与结果提示条 `✓ 加到 [图标] 2 个` 同一个写法；读屏名在 `label`（写全名字）
  keyFace?: { line: MessageKey; agents: { id: string; name: string }[] };
}

/// 选择行「所有 agent」键上的一面：整句里的文字段与图标组；各段是 flex 项、间距由 gap 给（不靠空白，见 CLAUDE.md）
function AllKeyFace({ face }: { face: NonNullable<ColumnCheck["keyFace"]> }) {
  const icons = (
    <span className="mx-allkey__icons">
      {face.agents.map((a) => (
        <AgentIcon key={a.id} id={a.id} name={a.name} />
      ))}
    </span>
  );
  return (
    <span className="mx-allkey">
      {sentencePieces(tRich(face.line, { agents: icons }), (text, key) => (
        <span key={key}>{text}</span>
      ))}
    </span>
  );
}

export interface MatrixProps {
  columns: MatrixColumn[];
  /// 「来源」列的列头文字
  originLabel: string;
  /// 「位置」列的列头文字：范围里不止一个位置时给，名称后多一列、来源列让窄；不给就没有这一列
  placeLabel?: string;
  /// 页面头下方的插槽（吸顶）：以前固定放按来源筛选的胶囊行；R9 去掉了它，现在是个空槽——
  /// 调用方放什么就是什么（例如 R4 的项目筛选片），Matrix 不认来源、不认项目。没给就只留上下距
  bar?: ReactNode;
  /// 新手提示条的插槽：bar 插槽下、表头上（推动表格）。放 `<NoticePanel mark={false} open flush>`：提示条开着时
  /// bar 插槽的下内边距让成 16（提示条到它 16），提示条自带下外距 16；收起后回到表格上距 18
  hint?: ReactNode;
  /// 新手提示条的插槽：空态上方（一行都没有时才出）
  emptyHint?: ReactNode;
  rows: MatrixRowView[];
  /// 名称列头：`名称`
  nameLabel: string;
  /// 名称列头的提示框（机制说明放这里，不放常驻说明条）
  nameTip?: string;
  /// 名称列头后的总数（`名称 58`）：随当前筛选
  nameCount?: number;
  /// 读屏词与选择行全有的画法用哪一套：skill 的「已加上 · 软链」●，或 MCP 的「已写进」⦿
  dotWords?: "skill" | "mcp";

  filterText: string;
  onFilterText: (text: string) => void;
  /// 页面头右端、筛选框右边的动作（`管理来源` `+ 来源`，见 `SourceKeys`）
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
  /// 过了 0.3 秒门槛那一点原位换成 14 宽刻度，`已选 N 个` 后面接一句（`· 正在加到 Codex`）
  keyBusy?: { keyId: string; label: string } | null;
  /// 点格之后真要等的（拆开整个文件夹链接）：过了 0.3 秒门槛，被点那一格正下方浮起刻度 + 一句
  cellBusy?: { rowKey: string; columnId: string; label: string } | null;
  /// 单格失败：被点那一格正下方的提示条说原因（与成功同一个位置），8 秒，悬停停表
  cellNotice?: CellNotice | null;
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
  /// 从别处带过来要看的那一行（装完提示的「去处理」，issue #111）：拉开它的抽屉、滚到眼前。
  /// `nonce` 变了才再做一次；这一行此刻不在表里（筛掉了、还没扫出来）时不做
  reveal?: { key: string; nonce: number } | null;
  /// 拉开了：调用方撤掉 `reveal`（表格重挂时不再拉一次）
  onRevealed?: () => void;
}

/// 格的读屏名：状态名统一成「已加上 / 未加上」（「已开启」会读成应用开着）；受阻统称「受阻」（D22）、
/// 写失败说「无法写入」（D24）——这两个就是 ui 的 `DOT_LABEL`，不在这里另写一份。
/// skill 与 MCP 共用 `DOT_LABEL`，但「有」在两边不是同一件事——skill 分软链 ● 与原件 ⦿，
/// MCP 只有 ●（一份独立定义，DESIGN「MCP 格子只有两种」）：读屏词不能说反
const skillDotText = (): Record<Dot, string> => ({
  ...DOT_LABEL,
  linked: t("skills.dot.skillLinked"),
  missing: t("skills.dot.missing"),
  own: t("skills.dot.own"),
});
/// MCP 用词与格子提示框同一套：格子只有 ● 有、○ 没有（DESIGN「MCP 格子只有两种」），不分原件副本
const mcpDotText = (): Record<Dot, string> => ({
  ...DOT_LABEL,
  linked: t("skills.dot.mcpLinked"),
  missing: t("skills.dot.missing"),
});

/// 键盘焦点所在的列：`NAME_COL`（-1）是名字（行本身：空格加选、回车拉开抽屉），0 起是 agent 列的格
export const NAME_COL = -1;

/// 把键盘焦点格夹回当前表的范围：取最近的有效行和列（名字那一列 `NAME_COL` 也算）。
/// 表为空（没有行或没有列）时返回 null
export function clampFocus(
  focus: { r: number; c: number },
  rows: number,
  cols: number,
): { r: number; c: number } | null {
  if (rows <= 0 || cols <= 0) return null;
  return {
    r: Math.max(0, Math.min(rows - 1, focus.r)),
    c: Math.max(NAME_COL, Math.min(cols - 1, focus.c)),
  };
}

/// 来源名这一格的内容（表格页「来源」列与来源管理页的来源格共用，2026-09-30）：写来源名，悬停出名字 + 完整路径的
/// 提示框；`revealShown` 时名字后跟 `打开 ↗`，名字按列宽截断（提示框 fit="shrink"），完整值在提示框里。
/// 什么时候算「悬停这一格」由调用方判断（表格按格，来源管理页按格或键盘焦点所在的行）
export function OriginLabel({
  label,
  path,
  split,
  gone = false,
  revealShown,
  onReveal,
  asPath = false,
  reserve = false,
}: {
  label: string;
  path: string;
  /// 写的就是路径：等宽小字、从右往左截（留住文件名），提示框只写完整路径（见 `MatrixRowView.origin.asPath`）
  asPath?: boolean;
  /// `打开 ↗` 一直占着位置、不出时看不见（列宽按内容算的地方用：自动同步页 / 原件位置管理页——键出来时这一列不变宽，
  /// 右边的列不跟着挪；2026-09-30 产品负责人：「右边的一列会反复变位置，是不是应该提前预留位置」）。表格页列宽固定，不用
  reserve?: boolean;
  /// 同名来源：名字 + 区分片段两段，放不下只截名字
  split?: { name: string; seg: string };
  /// 原件已经不在了：名字用 ink-faint、不出 `打开 ↗`
  gone?: boolean;
  revealShown: boolean;
  onReveal: () => void;
}) {
  return (
    <>
      <Tooltip
        fit="shrink"
        content={
          <>
            {asPath ? null : <div>{label}</div>}
            <div>
              <Mono path inherit>
                {path}
              </Mono>
            </div>
          </>
        }
        context="table"
      >
        <span
          className={`mx-origin${gone ? " is-gone" : ""}${split ? " is-split" : ""}${asPath ? " mx-origin--path" : ""}`}
          tabIndex={-1}
        >
          {asPath ? (
            // 路径从右往左截，留住文件名；前后各一个 LRM，/ ~ 不会被 rtl 挪位
            `\u200e${label}\u200e`
          ) : split ? (
            <>
              <span className="mx-origin__name">{split.name}</span>
              {/* 分隔用不换行空格：flex 项之间的普通空白会被吃掉 */}
              <span className="mx-origin__seg">{` · ${split.seg}`}</span>
            </>
          ) : (
            label
          )}
        </span>
      </Tooltip>
      {revealShown && !gone ? (
        <RevealLink path={path} onReveal={onReveal} />
      ) : reserve && !gone ? (
        // 占位：同一颗键，看不见、点不到、读屏读不到
        <span className="mx-reveal is-reserved" aria-hidden="true" inert>
          <RevealLink path={path} onReveal={onReveal} />
        </span>
      ) : null}
    </>
  );
}

/// `打开 ↗`：离开 Sophia 的动作（在访达中显示），浅键、↗ 由组件画。提示框是完整路径。
/// 外层是动作链的一格：整体一行不缩，旁边的名字、路径按列宽截断或折行
export function RevealLink({ path, onReveal }: { path: string; onReveal: () => void }) {
  return (
    <span className="mx-reveal">
      <Tooltip
        content={
          <Mono path inherit>
            {path}
          </Mono>
        }
      >
        <Button
          variant="quiet"
          ariaLabel={t("skills.matrix.revealLabel", { path: displayPath(path) })}
          onClick={onReveal}
        >
          {t("skills.matrix.reveal")}
        </Button>
      </Tooltip>
    </span>
  );
}

/// 页面头右端的筛选框（DESIGN「位置页 › 页面头」）：输入框的搜索形态，定宽 200、占位 `筛选`、框内右端写 `⌘F`
/// （熟练路径看得见，⑩）；有字时换成 ✕ 清除、框里 Esc 先清空——长相与清除都归 `TextField`。
/// 这里只接菜单「筛选」（⌘F）：聚焦并全选；`enabled` 为 false（添加来源页盖在上面）时不接
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
    <TextField
      search
      shortcut="⌘F"
      width={200}
      label={t("skills.matrix.filter")}
      placeholder={t("skills.matrix.filter")}
      value={value}
      onChange={onChange}
      inputRef={ref}
    />
  );
}

/// 页面头右端管来源的两颗键（DESIGN「位置页 › 页面头」）：`管理来源`（默认键 28）+ 8 + `+ 来源`（最右端）——
/// 两件管来源的事并排（① 就近）。这个位置一个来源都没订阅时不给 `onManage`，`管理来源` 不出（空态已有 `+ 来源`）。
/// skills 与 mcp 同一处，切页签不跳。回调拿到被按的那颗键：范围里不止一个位置时，选位置的浮层锚在它上面（R8）；
/// `+ 来源` 带 `data-source-key="add"`，菜单「添加来源…」没有按键时浮层锚到它
export function SourceKeys({
  onManage,
  onAdd,
  manageLabel = t("sources.manage.skills"),
}: {
  onManage?: (at: HTMLElement | null) => void;
  /// 不给就没有 `+` 那颗键（MCP 不再添加来源，spec 2026-09-30-mcp-config-scope R5）
  onAdd?: (at: HTMLElement | null) => void;
  /// 管理那颗键上的字：默认 `管理原件位置`（skill）；MCP 是 `自动同步`
  manageLabel?: string;
}) {
  const manageRef = useRef<HTMLSpanElement>(null);
  const addRef = useRef<HTMLSpanElement>(null);
  const keyIn = (ref: RefObject<HTMLSpanElement | null>) =>
    ref.current?.querySelector("button") ?? null;
  return (
    <>
      {onManage ? (
        <span ref={manageRef} className="mx-sourcekey">
          <Button onClick={() => onManage(keyIn(manageRef))}>{manageLabel}</Button>
        </span>
      ) : null}
      {onAdd ? (
        <span ref={addRef} className="mx-sourcekey" data-source-key="add">
          <AddButton
            noun={sourceNoun("skills")}
            label={t("sources.add.buttonSkill")}
            onClick={() => onAdd(keyIn(addRef))}
          />
        </span>
      ) : null}
    </>
  );
}

/// 页面头右端：筛选框 + 这一页的动作（`管理来源` `+ 来源`），间距 8。表格还没有的时候（扫描中、这个位置
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

/// 选择行里的一点：10px 状态点（● / ○；MCP 全有时画 ⦿，同它的格子），与格子同形、同列、同行为。悬停时点不变、下层出光晕
/// （选择行底已是 surface，光晕用 track，见 Matrix.css）；提示框列受影响的名字；
/// 没有可改的格子时点 `ink-faint`、不出光晕，按下即说原因
function SelDot({
  check,
  on,
  locked = false,
  busy = false,
}: {
  check: ColumnCheck;
  /// 全有（打勾）时画成哪一种：skill 是 ●，MCP 是 ⦿（DESIGN「MCP 格子只有两种」）
  on: Dot;
  /// 批量写入进行中：点不动（键盘的空格 / 回车也不行）
  locked?: boolean;
  /// 过了 0.3 秒门槛：点原位换成 14 宽刻度
  busy?: boolean;
}) {
  const disabled = check.disabledReason !== undefined;
  const button = (
    <StateDotButton
      className={`mx-seldot${disabled ? " is-disabled" : ""}`}
      aria-label={
        disabled
          ? t("skills.matrix.checkDisabled", {
              label: check.label,
              reason: check.disabledReason ?? "",
            })
          : check.label
      }
      aria-disabled={disabled || undefined}
      onClick={disabled || locked ? undefined : () => check.onToggle()}
    >
      {busy ? (
        <Spinner size={14} label={check.label} />
      ) : (
        // 选择行的底已是 surface：光晕换 track（onSurface）
        <StateDot
          dot={check.checked ? on : "missing"}
          hoverable={!disabled}
          muted={disabled}
          onSurface
          label={check.checked ? t("skills.dot.checked") : t("skills.dot.missing")}
        />
      )}
    </StateDotButton>
  );
  return (
    // 没有可改的格子：按下当即说明原因（同禁用的键），不是按下即收起
    <Tooltip content={check.disabledReason ?? check.tip} placement="bottom" explain={disabled}>
      {button}
    </Tooltip>
  );
}

/// 排序箭头 ↑ / ↓：只在当前的排序依据列常显（默认名称升序时也显示，Finder 惯例）；其余列不占眼。
/// 图形是词表里的 `IconSortArrow`，读屏名（升序 / 降序）挂在外层
function SortArrow({ active, desc }: { active: boolean; desc: boolean }) {
  return (
    <span
      className={`mx-sort${active ? " is-active" : ""}`}
      role={active ? "img" : undefined}
      aria-label={
        active ? (desc ? t("skills.matrix.sortDesc") : t("skills.matrix.sortAsc")) : undefined
      }
      aria-hidden={active ? undefined : true}
    >
      <IconSortArrow desc={desc} />
    </span>
  );
}

export default function Matrix(props: MatrixProps) {
  const {
    columns,
    originLabel,
    placeLabel,
    bar,
    hint,
    emptyHint,
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
    reveal,
    onRevealed,
  } = props;

  const drawerId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // 默认排序：名称升序，同名两份天然相邻（DESIGN「默认值」）；当前排序依据列常显箭头
  const [sortState, setSort] = useState<SortState | null>(null);
  const sort: SortState = sortState ?? { key: "name", dir: "asc" };
  // 悬停的行（行带）；col 是悬停的那一格：agent 列的 id，来源格是 ORIGIN_COL
  const [hover, setHover] = useState<{ row: string; col: string | null } | null>(null);
  // 右键菜单开着的那一行：出 surface 行带，菜单关掉即消失
  const [menuRow, setMenuRow] = useState<string | null>(null);
  // 键盘焦点（roving tabindex）存的原值；用时一律经 clampFocus 夹回当前表的范围
  const [focusRaw, setFocus] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const [focusWithin, setFocusWithin] = useState(false);
  // 提示框：停够 700ms 的那一格（整张表同一时刻只出一格，画与放归 `Tooltip` 的受控写法）
  const [tip, setTip] = useState<string | null>(null);
  // 这一格的提示框是点出来的（做不了的格子），不是悬停出来的
  const [tipPinned, setTipPinned] = useState(false);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 正在闪的格
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  // Shift 区间选择的锚点
  const anchor = useRef<string | null>(null);
  const shift = useRef(false);
  // 吸顶：bar 插槽在页面头下，列头（+ 选择行）紧贴它下面
  const barRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const [barH, setBarH] = useState(0);
  // 拉开了行详情抽屉的那一行。表格一次只开一格（DESIGN「抽屉」）：拉开另一行，这一行收起
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggleDetail = (key: string) => setExpanded((prev) => (prev === key ? null : key));
  // 「去处理」带过来的那一行：拉开抽屉（表格一次只开一格，别的收起），挂上之后滚到眼前（居中：吸顶的表头盖不住它，
  // 下面拉开的抽屉也露得出来）。每个 nonce 只做一次
  const revealed = useRef<number | null>(null);
  const revealRow = reveal?.key ?? null;
  const revealNonce = reveal?.nonce ?? null;
  const revealHere = revealRow !== null && rows.some((r) => r.key === revealRow);
  useEffect(() => {
    if (!revealHere || revealRow === null || revealed.current === revealNonce) return;
    revealed.current = revealNonce;
    setExpanded(revealRow);
    onRevealed?.();
    // 抽屉挂上之后再滚（不在清理里取消：拉开抽屉的那一次重绘不该把它撤掉）
    requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector(`[data-row="${CSS.escape(revealRow)}"]`)
        ?.scrollIntoView({ block: "center" });
    });
    // onRevealed 每次渲染可能是新的；只在要拉的那一行变了时做
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealHere, revealRow, revealNonce]);

  const dotText = dotWords === "mcp" ? mcpDotText() : skillDotText();
  const colW = agentColumnWidth(columns.length);
  // 面板随窗口变宽（776–1200）：量这张表能用的宽，多出来的按比例分给名称、位置、来源
  const [available, setAvailable] = useState(0);
  const width = panelWidth(available);
  const widths = panelColumns(columns.length, placeLabel !== undefined, width);
  const template = [
    `${CHECK_W}px`,
    // 名称列吸收面板里余下的宽度：776 时 4 格 246、少于 4 格更宽、5 格（每格 76）218、6 格（每格 64）214
    "minmax(0, 1fr)",
    ...(widths.place !== null ? [`${widths.place}px`] : []),
    `${widths.origin}px`,
    ...columns.map(() => `${colW}px`),
  ].join(" ");
  const gridStyle: CSSProperties = { gridTemplateColumns: template };

  // ---- 排序：名称 / 来源 / 某一列的格；同值再按名称、来源，同名两份相邻 ----
  const byName = compareBy((r: MatrixRowView) => r.name, "asc");
  const byOrigin = compareBy((r: MatrixRowView) => r.origin.label, "asc");
  const byPlace = compareBy((r: MatrixRowView) => r.place ?? "", "asc");
  const primary =
    sort.key === "name"
      ? compareBy((r: MatrixRowView) => r.name, sort.dir)
      : sort.key === "origin"
        ? compareBy((r: MatrixRowView) => r.origin.label, sort.dir)
        : sort.key === "place"
          ? compareBy((r: MatrixRowView) => r.place ?? "", sort.dir)
          : compareBy((r: MatrixRowView) => DOT_RANK[r.cells[sort.key]?.dot ?? "none"], sort.dir);
  // 键盘在格间移动按这个顺序；同名的两个位置相邻（位置先于来源）
  const flat = [...rows].sort(
    (a, b) => primary(a, b) || byName(a, b) || byPlace(a, b) || byOrigin(a, b),
  );
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
    setTipPinned(false);
    tipTimer.current = setTimeout(() => setTip(key), TIP_DELAY_MS.table);
  };
  const dropTip = () => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = null;
    setTip(null);
    setTipPinned(false);
  };
  useEffect(() => () => dropTip(), []);
  // 点了做不了的格子（或空格）：不等 700ms，当即弹出这一格的提示框，停约 3 秒；移开、点别处即消
  const pinTip = (key: string) => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    setTip(key);
    setTipPinned(true);
    tipTimer.current = setTimeout(dropTip, PINNED_TIP_MS);
  };
  // 钉出来的说明：按在别处（不是这一格）即收起；再按这一格由它自己的点击重新钉住
  useEffect(() => {
    if (!tipPinned || tip === null) return;
    const away = (e: PointerEvent) => {
      const cell = (e.target as Element | null)?.closest?.("[data-cellkey]");
      if (cell?.getAttribute("data-cellkey") !== tip) dropTip();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [tipPinned, tip]);

  // 吸顶区底边相对滚动容器顶的距离写进 `--tip-ceiling`：格子与列头的提示框（`Tooltip ceiling`）往上弹
  // 会钻到吸顶区底下时翻到下方
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

  // ---- 面板能用的宽：跟着窗口（机面）变 ----
  useLayoutEffect(() => {
    const host = rootRef.current?.parentElement;
    if (!host) return;
    const measure = () => {
      const cs = getComputedStyle(host);
      setAvailable(
        host.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0"),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // ---- 吸顶区的高度 ----
  // bar 插槽折行、出现 / 消失都会改高度：只在 resize 时量，列头就停在旧高度上，
  // 行从 bar 插槽和列头之间的缝里漏出来（产品负责人真机）。
  // 要量 border-box：灰面板开 / 关时只改 bar 的下内边距（Matrix.css 的 `:has([data-hint="open"])`，18 ↔ 16，
  // 带过渡），默认的 content-box 不变、回调不来，列头停在旧高度上露出缝（0.1.1 产品负责人真机）
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
    observer.observe(bar, { box: "border-box" });
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

  // ---- 键盘：方向键在格间移动，焦点环在格上，行带跟随；最左一格是名字（行本身）----
  const focusCell = (r: number, c: number) => {
    const rr = Math.max(0, Math.min(flat.length - 1, r));
    const cc = Math.max(NAME_COL, Math.min(columns.length - 1, c));
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
    // 行带跟着键盘走：鼠标停在别的行上也让位（2026-09-27 真人测试 KEY-1），鼠标移进别的行时悬停再接回来
    setHover(null);
    focusCell(focus.r + move[0], focus.c + move[1]);
  };

  // ---- 菜单命令（DESIGN「应用菜单」）：⌘F 聚焦筛选框（FilterBox 自己接）、⌘A 勾选当前筛选的
  // 全部行、⌘Z 撤销最近一次可撤销的操作（没有就无操作，菜单项灰着）。输入框聚焦时壳把全选 / 撤销
  // 作用于文字，不会发到这里 ----
  const live = useRef({
    onUndo,
    onSelectionChange,
    selected,
    flat,
    expanded,
    shortcuts,
  });
  live.current = {
    onUndo,
    onSelectionChange,
    selected,
    flat,
    expanded,
    shortcuts,
  };
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

  // 键盘直达：Esc 先收起拉开的抽屉，再取消选择。在 Tauri 里 ⌘F / ⌘Z / ⌘A 由菜单栏接走（上面的
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
  // 才变淡（`BusySlot dim`）、原位换成刻度、`已选 N 个` 后面接一句 ----
  const busyShown = useBusyShown(keyBusy != null);
  // 单格真要等时，过了门槛格子下方浮起的那一句（`BusySlot float`）顶替这一格的结果提示
  const cellBusyShown = useBusyShown(cellBusy != null);
  // 浮起的提示小窗：换一条（调用方给了新对象）就是新出现一次——重挂、重新定位、计时从头来
  const keyToastKey = useIdentityKey(keyToast);
  const rowToastKey = useIdentityKey(rowToast);

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
  /// 一个 agent 格的列头：图标 / 名字 / 第二行 / 计数；在合组里只有小标 + 计数（图标与名字在组头）。
  /// `slot`：表里有合组时，其余列在第二行的位置留空（高一条结构线 + 一行小标），列头同高、计数对齐
  const colHead = (col: MatrixColumn, slot: boolean) => (
    <div key={col.id} data-col={col.id} className="mx-head__col">
      {/* 列头只排序；悬停只出提示框，不出列带（D23） */}
      <Tooltip
        content={
          col.note ? (
            <>
              {col.tip}
              <br />
              {col.note}
            </>
          ) : (
            col.tip
          )
        }
        context="table"
        placement="bottom"
      >
        <button
          type="button"
          className={`mx-colbtn${col.missing ? " is-missing" : ""}`}
          aria-label={
            col.note
              ? t("skills.matrix.colSortNote", { tip: col.tip, note: col.note })
              : t("skills.matrix.colSort", { tip: col.tip })
          }
          onClick={() => sortBy(col.id)}
        >
          {col.group ? null : (
            <>
              <span className="mx-colbtn__icon">
                <AgentIcon id={col.agentId} name={col.name} />
              </span>
              <span className="mx-colbtn__name">
                <Cap>{col.name}</Cap>
              </span>
            </>
          )}
          {col.nameTail ? (
            <span className={`mx-colbtn__name mx-colbtn__tail${slot ? " is-slotted" : ""}`}>
              <Cap>{col.nameTail}</Cap>
            </span>
          ) : col.scope ? (
            <span className="mx-colbtn__scope">
              <Cap>{col.scope}</Cap>
            </span>
          ) : slot ? (
            <span className="mx-colbtn__slot" aria-hidden="true" />
          ) : null}
          <span className="mx-colbtn__count">{col.missing ? "" : col.count}</span>
          <SortArrow active={sort.key === col.id} desc={sort.dir === "desc"} />
        </button>
      </Tooltip>
    </div>
  );
  // 有合组或有两行名字的列时，其余列在第二行的位置留空，列头同高、计数对齐
  const grouped = columns.some((col) => col.group !== undefined || col.nameTail !== undefined);
  const header = (
    <div className="mx-grid mx-head" style={gridStyle}>
      <div className="mx-head__check">
        {/* 表头整行不置灰，只灰这个全选框 */}
        {selectable.length === 0 ? (
          <Checkbox
            checked={false}
            label={t("skills.matrix.selectAll")}
            disabledReason={t("skills.matrix.nothingToSelect")}
          />
        ) : (
          <Checkbox
            checked={allChecked}
            label={t("skills.matrix.selectAll")}
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
      {/* 位置：只在多位置时有；点文字按位置排序（同位置聚拢） */}
      {placeLabel !== undefined ? (
        <div className="mx-head__place">
          <button type="button" className="mx-headbtn" onClick={() => sortBy("place")}>
            {placeLabel}
            <SortArrow active={sort.key === "place"} desc={sort.dir === "desc"} />
          </button>
        </div>
      ) : null}
      {/* 来源：点文字按来源排序（同来源聚拢） */}
      <div className="mx-head__origin">
        <button type="button" className="mx-headbtn" onClick={() => sortBy("origin")}>
          {originLabel}
          <SortArrow active={sort.key === "origin"} desc={sort.dir === "desc"} />
        </button>
      </div>
      {headerRuns(columns).flatMap((run) =>
        run.group ? (
          // 合组：图标 + 名字共用，下面一条结构线横跨这几格，线下每格小标 + 计数（各自排序、各自提示框）
          <div
            key={`group:${run.group.id}`}
            className="mx-head__group"
            style={{ gridColumn: `span ${run.columns.length}` }}
          >
            <span className="mx-headgroup__top">
              <span className="mx-colbtn__icon">
                <AgentIcon id={run.group.agentId} name={run.group.name} />
              </span>
              <span className="mx-colbtn__name">
                <Cap>{run.group.name}</Cap>
              </span>
            </span>
            <span className="mx-headgroup__rule" aria-hidden="true" />
            <div className="mx-headgroup__cells">
              {run.columns.map((col) => colHead(col, false))}
            </div>
          </div>
        ) : (
          run.columns.map((col) => colHead(col, grouped))
        ),
      )}
    </div>
  );

  // ---- 选择行（D4）：勾了行之后表头结构线下插入一条，用表格同一套列；每个 agent 列正下方一点 ----
  const busyKey = keyBusy?.keyId;
  const selRow = selecting ? (
    <div
      className="mx-grid mx-selrow"
      style={gridStyle}
      data-place={placeLabel !== undefined ? "" : undefined}
    >
      {/* 复选列空着：全选框就在正上方的表头里 */}
      <div />
      {/* 左段横跨名称 + 位置 + 来源（第三批画板 5A）：那两列在选择行里本来空着，English 的
          `3 selected · Cancel · Add to [图标]` 只占名称列放不下；跨几列由 Matrix.css 按有没有位置列定 */}
      <div className="mx-selrow__name">
        <span className="mx-selcount">{tn("skills.matrix.selected", selectedVisible.length)}</span>
        {/* 取消选择是 busy 的豁免项：它不写磁盘；等于 Esc */}
        <Button size="compact" onClick={() => onSelectionChange(new Set())}>
          {t("skills.matrix.cancel")}
        </Button>
        {/* 所有 agent：一颗紧凑默认键紧跟 `取消`（2026-09-30 产品负责人：原来借住在来源列的一个点「和别的列是错开的，
            而且表头也不符」）。键上的字随状态翻转（全都有＝移除），提示框列出受影响的；各 agent 列下的点不变 */}
        {allAgents ? (
          <span className="mx-keywrap" data-key="all">
            <BusySlot mode="dim" busy={busyKey === "all"} label={keyBusy?.label ?? ""}>
              {allAgents.disabledReason !== undefined ? (
                // 没有能改的：键禁用，按下即说原因（ReasonTip 归 Button）
                <Button size="compact" disabled disabledReason={allAgents.disabledReason}>
                  {allAgents.keyFace ? <AllKeyFace face={allAgents.keyFace} /> : allAgents.label}
                </Button>
              ) : (
                <Tooltip content={allAgents.tip}>
                  <Button
                    size="compact"
                    ariaLabel={allAgents.label}
                    onClick={busyKey === "all" ? undefined : allAgents.onToggle}
                  >
                    {allAgents.keyFace ? <AllKeyFace face={allAgents.keyFace} /> : allAgents.label}
                  </Button>
                </Tooltip>
              )}
            </BusySlot>
          </span>
        ) : null}
        {busyShown && keyBusy ? (
          <span className="mx-selbusy" role="status">
            {`· ${keyBusy.label}`}
          </span>
        ) : null}
      </div>
      {columns.map((col) => (
        <div key={col.id} className="mx-selrow__col">
          {columnChecks?.[col.id] ? (
            <span className="mx-keywrap" data-key={col.id}>
              <BusySlot mode="dim" busy={busyKey === col.id} label={keyBusy?.label ?? ""}>
                <SelDot
                  check={columnChecks[col.id]}
                  on="linked"
                  locked={busyKey === col.id}
                  busy={busyShown && busyKey === col.id}
                />
              </BusySlot>
            </span>
          ) : null}
        </div>
      ))}
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
    const open = expanded === row.key && row.detail !== undefined;
    if (open) classes.push("is-open");
    const selectable = row.selectDisabledReason === undefined;
    const detailId = `${drawerId}-d${r}`;
    // 来源格的 `打开 ↗`：鼠标悬停在这一格时才出（DESIGN「来源」列：悬停该格）；没有鼠标悬停时
    // 跟着键盘焦点 / 右键菜单所在的行，键盘也够得着
    const revealShown =
      !open &&
      !row.origin.gone &&
      (hover ? hover.row === row.key && hover.col === ORIGIN_COL : activeRow === row.key);
    // 生效范围格的 `修改`：同来源格的 `打开 ↗`，悬停这一格才出；没有鼠标悬停时跟着键盘焦点 / 右键菜单所在的行
    const placeKeyShown = hover
      ? hover.row === row.key && hover.col === PLACE_COL
      : activeRow === row.key;
    const nameFocused = focus.r === r && focus.c === NAME_COL;
    // 右键菜单（D18）：只作加速器，每一项在界面上都另有入口；不改变勾选
    const menuItems = (el: HTMLElement): ContextMenuItem[] => [
      ...(row.detail !== undefined
        ? [
            {
              label: open ? t("skills.matrix.collapseDetail") : t("skills.matrix.expandDetail"),
              run: () => toggleDetail(row.key),
            },
          ]
        : []),
      "separator",
      ...(row.menu?.(el) ?? []),
    ];

    return (
      <div key={row.key} className="mx-rowgroup">
        <div
          data-row={row.key}
          // 行悬停钩子：勾选框进「手靠近」态、名字后的拉手出现（组件层 ui.css）
          data-checkrow=""
          data-drawer-row=""
          className={classes.join(" ")}
          style={gridStyle}
          onMouseEnter={() => setHover({ row: row.key, col: null })}
          onMouseLeave={() => setHover(null)}
          // `⌘` 点行＝加选 / 去掉这一行（DESIGN「勾选框」）：点在格子、名字上也是，不再执行格子自己的动作；
          // 不带 ⌘ 时点行的其余地方不勾选（表格里勾选只经由行首那颗框）
          onClickCapture={(e) => {
            if (!(e.metaKey || e.ctrlKey)) return;
            e.preventDefault();
            e.stopPropagation();
            if (!selectable) return;
            shift.current = false;
            toggleRow(row);
          }}
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
                label={t("skills.matrix.checkRow", { name: row.name })}
                disabledReason={row.selectDisabledReason}
              />
            ) : (
              <Checkbox
                checked={isSelected}
                label={t("skills.matrix.checkRow", { name: row.name })}
                onChange={() => toggleRow(row)}
              />
            )}
          </div>
          {/* › 名字 ×2：名称格只放拉手、名字与记号。拉手在名字前自成一列（18 + 6，没有抽屉的行留空，
              各行名字对齐），悬停这一行（或键盘焦点在这一行）才出、拉开的常显；行内的动作都在抽屉里，
              名字不会被键挤成省略号——只有列宽真不够时才截断 */}
          <div className="mx-row__name">
            <span className="mx-handle">
              {row.detail !== undefined ? (
                <DrawerHandle
                  open={open}
                  onToggle={() => toggleDetail(row.key)}
                  label={t("skills.matrix.detailOf", { name: row.name })}
                  controls={detailId}
                />
              ) : null}
            </span>
            {/* 名字也是这一行的键盘落点（方向键从第一格再往左）：空格加选、回车拉开抽屉；鼠标点名字拉开抽屉 */}
            <span
              className={`mx-name${row.detail !== undefined ? " is-toggle" : ""}`}
              role="button"
              data-cell={`${r}:${NAME_COL}`}
              tabIndex={nameFocused ? 0 : -1}
              aria-label={
                row.detail !== undefined
                  ? open
                    ? t("skills.matrix.rowAriaOpen", { name: row.name })
                    : t("skills.matrix.rowAriaClosed", { name: row.name })
                  : t("skills.matrix.rowAriaPlain", { name: row.name })
              }
              aria-expanded={row.detail !== undefined ? open : undefined}
              onFocus={() => setFocus({ r, c: NAME_COL })}
              onClick={row.detail !== undefined ? () => toggleDetail(row.key) : undefined}
              onKeyDown={(e) => {
                if (e.key === " ") {
                  e.preventDefault();
                  if (!selectable) return;
                  shift.current = e.shiftKey;
                  toggleRow(row);
                } else if (e.key === "Enter" && row.detail !== undefined) {
                  e.preventDefault();
                  toggleDetail(row.key);
                }
              }}
            >
              {row.name}
            </span>
            {row.mark !== undefined ? (
              // 记号是纯文字，点它与点名字一样拉开抽屉（键盘走名字上的回车或拉手）
              <span
                className="mx-mark"
                onClick={row.detail !== undefined ? () => toggleDetail(row.key) : undefined}
              >
                {row.mark}
              </span>
            ) : null}
            {row.hoverAction !== undefined && !open && activeRow === row.key ? (
              // 键自己的点击不冒到名字上（那会拉开抽屉）
              <span className="mx-rowaction" onClick={(e) => e.stopPropagation()}>
                {row.hoverAction}
              </span>
            ) : null}
          </div>
          {placeLabel !== undefined ? (
            // 位置名放不下时截断，完整值在提示框里
            <div
              className="mx-row__place"
              onMouseEnter={() => setHover({ row: row.key, col: PLACE_COL })}
              onMouseLeave={() => setHover({ row: row.key, col: null })}
            >
              <Tooltip fit="shrink" content={row.place ?? ""} context="table">
                <span className="mx-place" tabIndex={-1}>
                  {row.place ?? ""}
                </span>
              </Tooltip>
              {/* 行内悬停键（DESIGN「行内悬停键」）：值照常在、放不下截断，键跟在后面不缩；
                  键按下的 click 冒泡到这一层，拿它当触发处（Button 的 onClick 不带事件） */}
              {row.placeAction && placeKeyShown ? (
                <span
                  className="mx-placekey"
                  onClick={(e) => row.placeAction?.onOpen(e.currentTarget)}
                >
                  <Tooltip content={row.placeAction.tip} context="table">
                    <Button size="compact">{row.placeAction.label}</Button>
                  </Tooltip>
                </span>
              ) : null}
            </div>
          ) : null}
          {/* 来源：写来源名；悬停出完整路径提示框与 `打开 ↗`（这一行已展开时只出提示框） */}
          <div
            className="mx-row__origin"
            onMouseEnter={() => setHover({ row: row.key, col: ORIGIN_COL })}
            onMouseLeave={() => setHover({ row: row.key, col: null })}
          >
            <OriginLabel
              label={row.origin.label}
              path={row.origin.path}
              split={row.origin.split}
              gone={row.origin.gone}
              revealShown={revealShown}
              onReveal={row.origin.onReveal}
              asPath={row.origin.asPath}
            />
          </div>
          {columns.map((col, c) => {
            const view = row.cells[col.id] ?? null;
            const key = cellKey(row.key, col.id);
            const focused = focus.r === r && focus.c === c;
            // 格子下方浮起的忙碌一句（BusySlot float）在 React 树里是这一格的子孙，但它不接指针，进不了这一格
            const enter = () => {
              setHover({ row: row.key, col: col.id });
              armTip(key);
            };
            const busyHere = cellBusy?.rowKey === row.key && cellBusy.columnId === col.id;
            return (
              <div
                key={col.id}
                data-col={col.id}
                data-cellkey={key}
                className="mx-cell"
                // 刚变化的格：反色闪一次（ui 的公开钩子），animationend 时摘掉
                data-flash={flashing.has(key) ? "" : undefined}
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
                    aria-label={t("skills.matrix.noSlotAria", { row: row.name, column: col.name })}
                    onFocus={() => {
                      setFocus({ r, c });
                      armTip(key);
                    }}
                    onBlur={dropTip}
                  >
                    <StateDot dot="none" label={t("skills.matrix.noSlot")} />
                  </span>
                ) : (
                  // 点格之后真要等的（拆开）：过了门槛，格子下方浮起刻度 + 一句（靠右沿的列右对齐，不越过表格右沿）
                  <BusySlot
                    mode="float"
                    busy={busyHere}
                    label={busyHere ? cellBusy.label : ""}
                    align={c === columns.length - 1 ? "end" : "center"}
                  >
                    {/* 提示框一行动词，格子正上方 6（第一行放下方；往上会钻到吸顶区底下时也翻到下方）；
                        快捷键 ` · 空格` 只在键盘焦点唤起时写。何时出由表自己数（armTip / pinTip） */}
                    <Tooltip
                      content={
                        view.tipDetail ? (
                          <>
                            {view.tip}
                            <br />
                            <span className="mx-tipdetail">{view.tipDetail}</span>
                          </>
                        ) : (
                          view.tip
                        )
                      }
                      context="table"
                      open={tip === key}
                      ceiling
                      placement={r === 0 ? "bottom" : "top"}
                      shortcut={view.clickable ? t("skills.matrix.spaceKey") : undefined}
                    >
                      <StateDotButton
                        className={`mx-cellbtn${view.clickable ? "" : " is-inert"}`}
                        data-cell={`${r}:${c}`}
                        tabIndex={focused ? 0 : -1}
                        aria-label={
                          view.blank
                            ? t("skills.matrix.cellAriaBlank", {
                                row: row.name,
                                column: col.name,
                                tip: view.tip,
                              })
                            : view.tipDetail
                              ? t("skills.matrix.cellAriaDetail", {
                                  row: row.name,
                                  column: col.name,
                                  dot: dotText[view.dot],
                                  tip: view.tip,
                                  detail: view.tipDetail,
                                })
                              : t("skills.matrix.cellAria", {
                                  row: row.name,
                                  column: col.name,
                                  dot: dotText[view.dot],
                                  tip: view.tip,
                                })
                        }
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
                        {view.blank ? null : (
                          <StateDot
                            dot={view.dot}
                            hoverable={view.clickable && !view.pending}
                            muted={view.pending}
                            label={dotText[view.dot]}
                          />
                        )}
                      </StateDotButton>
                    </Tooltip>
                  </BusySlot>
                )}
              </div>
            );
          })}
        </div>
        {/* 行详情抽屉：左沿对齐名字（复选列 + 拉手列之后）、右沿让出 agent 列（要并排几份值的铺到最后一列，
            只让出尾列）；Esc 收起 */}
        {row.detail !== undefined ? (
          <Drawer
            open={open}
            id={detailId}
            inset={{
              start: CHECK_W + HANDLE_W,
              end: row.detailWide ? WIDE_DETAIL_END : columns.length * colW,
            }}
          >
            <div className="mx-detail">{row.detail}</div>
          </Drawer>
        ) : null}
      </div>
    );
  };

  return (
    <div
      className="mx"
      ref={rootRef}
      style={{ ["--mx-w" as string]: `${width}px` } as CSSProperties}
    >
      <LocationActions
        filterText={filterText}
        onFilterText={onFilterText}
        actions={headActions}
        inputRef={filterRef}
        enabled={shortcuts}
      />
      {/* bar 插槽吸在页面头下；表格上距在这一块的下内边距里。没有内容时整行不出，只留上下距 */}
      <div className="mx-bar" ref={barRef}>
        {bar}
      </div>
      {/* 新手提示条的插槽：bar 插槽下、表头上，随页面滚走（不吸顶） */}
      {hint ? <div className="mx-hint">{hint}</div> : null}
      <div
        className="mx-panel"
        ref={panelRef}
        // 格宽随格数（`agentColumnWidth`）：格子按钮与合组列头的小格按它排（Matrix.css `--mx-col-w`）
        style={{ width, ["--mx-col-w" as string]: `${colW}px` } as CSSProperties}
      >
        {/* 列头连同结构线与选择行吸顶，紧贴 bar 插槽下面 */}
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
          onFocus={() => {
            // 行带只跟随键盘焦点：鼠标点过的格子留着焦点，但鼠标移开后不该再亮着。
            // 键盘焦点看 inputModality，不看 `:focus-visible`（CLAUDE.md）
            setFocusWithin(keyboardModality());
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
          }}
        >
          {flat.map(renderRow)}
        </div>
        {flat.length === 0 && empty ? (
          <div className="mx-empty">
            {/* 新手提示条的插槽：空态上方 */}
            {emptyHint ? <div className="mx-hint">{emptyHint}</div> : null}
            {empty}
          </div>
        ) : null}
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
      {cellBusy && cellBusyShown ? null : cellNotice ? ( // 单格真要等（过了门槛）：格子下方已浮起在忙的那一句（格子里的 BusySlot），结果出来之前不出别的
        // 单格：成功与失败同一个位置（格子正下方），一次只一条，失败优先
        <FloatingToast
          key={`notice:${cellNotice.rowKey}:${cellNotice.columnId}:${cellNotice.text}`}
          anchor={cellAnchor(cellNotice.rowKey, cellNotice.columnId)}
          bounds={panelBounds}
        >
          {cellNotice.failure ? (
            <Toast kind="cannot" {...cellNotice.failure} onDismiss={onDismissCellNotice} />
          ) : (
            <Toast kind="cannot" message={cellNotice.text} onDismiss={onDismissCellNotice} />
          )}
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

/// 批量：选择行里被按的那一点所在的列（居中于该列；靠右沿时右对齐，由 placeToast 夹进面板）。
/// 选择行已经收起（取消了勾选之后再 ⌘Z）：退到同一列的列头下（「所有 agent」退到来源列头），
/// 结果仍出在那一列上，不落右下、也不因为找不到锚点而看不见
const keyAnchor = (keyId: string) => (probe: HTMLElement) => {
  const root = rootOf(probe);
  return (
    root?.querySelector(`.mx-keywrap[data-key="${CSS.escape(keyId)}"]`) ??
    (keyId === "all"
      ? root?.querySelector(".mx-head__origin")
      : root?.querySelector(`.mx-head__col[data-col="${CSS.escape(keyId)}"]`))
  );
};

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
