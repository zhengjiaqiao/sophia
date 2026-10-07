import { autoSyncWord } from "./terms.ts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { listText, t, tn, tSpaced, useLocale, useOnLocaleChange } from "./i18n.ts";
import type { AppFault } from "./backendError.ts";
import Matrix, {
  cellKey,
  RevealLink,
  SourceKeys,
  type MatrixCellView,
  type MatrixRowView,
  type CellNotice,
  type ColumnCheck,
} from "./Matrix";
import { affectedTip, TableEmpty } from "./DomainView";
import { SourcesPage } from "./pages/SourcesPage";
import { GLOBAL_KEY, type Face, type Location } from "./shell/nav";
import { mcpSourcesModel, type SourcesModel } from "./pages/sourcesModel";
import { matchesFilter } from "./rowFilter";
import type { DomainRef } from "./pages/sourcesView";
import { displayPath } from "./pathText";
import { McpPickLayer, type McpPick } from "./McpPickLayer";
import { McpScopeDialog, type ScopeChoiceView, type ScopeGitignore } from "./McpScopeDialog";
import { McpKeepConfirm, type KeepGitignore } from "./McpKeepConfirm";
import {
  afterGitignoreAdd,
  cellKeyHint,
  joinReasons,
  keyHintNote,
  keyHintNoteAsked,
} from "./mcpKeyHint";
import { LocationFrame } from "./LocationFrame";
import { DiscoverFlow, PageUndo, type InstallContext } from "./market";
import type { InstallPlaces } from "./market/InstallParts";
import {
  cellViewOf,
  claudeMoveTip,
  claudeSibling,
  claudeWhereText,
  withEnableNote,
  openCodeNoticeWanted,
  CLAUDE_SELF,
  CLAUDE_TEAM,
  differingFields,
  teamGained,
  teamLost,
  mcpAgentName,
  mcpBlankTip,
  mcpBlockedTip,
  mcpColumnNote,
  mcpEntryReason,
  mcpFailedAt,
  mcpWriteFault,
  differingSourceIds,
  mcpColumnOf,
  mcpDomains,
  mcpGroupOf,
  mcpLocationSentence,
  mcpPlaceName,
  mcpRowKey,
  mergeMcpDomains,
  pickChoices,
  pickTip,
  scopeChangeText,
  scopeMoveBlocked,
  scopeMovedTrail,
  scopeAgentOptions,
  effectiveScopeMode,
  scopeMovePlan,
  mergeScopePlans,
  scopeTargetsLabel,
  type ScopeMove,
  type ClaudeCell,
  type ScopeCellAt,
  type ScopeMode,
  sourceForMissing,
  sourceForMissingTarget,
  type McpColumn,
  type McpDomain,
  type McpDomainRow,
  type McpPlacedRow,
  type McpTable,
  mirrorFailedNote,
} from "./mcpView";
import { Button, Confirm, CornerToast, Mono, NoticePanel, Tag, Toast, ToastCount } from "./ui";
import { HINTS, useHint } from "./hints.ts";
import { McpDiffSection, McpEndpointRow } from "./McpDiffPanel";
import { mcpCopyName, mcpOriginName } from "./mcpDiffTable";
import type { ToastProps } from "./ui";
import type { AnchorRect } from "./layerPlace.ts";
import {
  batchBusyText,
  deletedMcpOriginalToast,
  deleteMcpBatchConfirm,
  deleteMcpOriginalConfirm,
  toastFor,
  type ToastAgentRef,
  type ToastItem,
  type ToastText,
} from "./toastText";
import type { Dot } from "./cellState";
import { isAgentLimit, unportableText } from "./mcpCellState";
import type {
  LocationKey,
  McpKeyHint,
  McpUndoReport,
  McpEntry,
  McpLocation,
  McpOverview,
  McpPreview,
  McpRemoveItem,
  McpReport,
  McpSelection,
} from "./types";
import "./McpTab.css";

/// MCP 页。**和 Skills 页是同一张表**（共享 `Matrix`），只是内容不同：
/// 行是 MCP 服务，列是配置位置，格是同一套状态点。
///
/// MCP 特有的差异：
/// 1. **格子只有 ● 有、○ 没有**（DESIGN「MCP 格子只有两种」）——点 ○ 写进一份；点 ● 先确认、
///    再从那个 agent 的配置里删掉这一项（哪一格都一样，不分原件副本）。
///    选择条上的键：未全有＝写进缺的，全有＝确认一次、从那个 agent 删掉选中的这几项
/// 2. **● 不是一条链接，是一份独立定义**——写进、删除都经 core 留快照：没人改过就能撤销，
///    改过了撤销禁用，改给「在访达中显示备份 ↗」作手动兜底。删除后一律给 `撤销`；写进只在
///    再按一次不能准确撤回时给（批量写进时选中的里这一列原本已有一部分）；`⌘Z` 始终可用
/// 3. **差异是行级、不是格级**——`2 份不一样` 是服务名后的纯文字记号（不是键，提示框给差异字段名）；
///    点它（或名字、拉手）拉开这一行的抽屉，不同的字段是抽屉里的一段。传输方式是服务的属性，也在抽屉里（D7）
/// 4. **批量或跨域写入要确认一道**（跨域会把请求头和令牌一并复制过去）；同域单格写入不确认，删除都确认
/// 5. **范围里可以不止一个位置**（`全部`，spec 2026-09-26-object-first-navigation R6）：几页并成一张表
///    （`mergeMcpDomains`），行带位置、列按 agent + 是不是 Local 归并；每一格的判断照旧在这一行自己那一页里做

export interface McpTabProps {
  /// 选中位置里的位置（域 key，见 shell/nav `locationsOf`）：一个时与改版前的单一位置页相同
  locations: ReadonlyArray<string>;
  /// 位置本身（`全部` / `用户级` / 某个项目）：它变了才清空勾选、收起来源页
  scopeKey: string;
  /// 出错交给窗口顶上的横幅（灰面板）。写入出错时另给该处的失败句（`加到 Codex 失败`）：原文与文件路径进「!」
  onError: (error: string, more?: Omit<AppFault, "text">) => void;
  /// 壳的错误横幅开着：新手提示让位（DESIGN-components「灰面板 · 一次性说明的用法」）
  banner?: boolean;
  /// 扫描、写入进行中：壳把后台重扫排到它结束之后（不锁页签、不锁项目切换）
  onBusy: (busy: boolean) => void;
  refreshKey: number;
  /// 每次扫描完回传一次（壳拿它算侧栏的项目并集，不用再自己扫一遍）
  onOverview?: (overview: McpOverview) => void;
  /// 页面头左端 `我的 ｜ 发现` 此刻在哪一面（spec 2026-09-27-skill-mcp-market R1）：`发现` 时机面换成发现一面，
  /// 这一页不卸载——切回 `我的` 时筛选、勾选照旧
  face?: Face;
  /// 筛选行（R2）：壳画左边的生效范围胶囊，右端放这一页给的下拉（MCP 不给）；结果交给 Matrix / LocationFrame 的 bar 插槽
  filterBar?: (source: ReactNode) => ReactNode;
  /// `发现` 一面的安装页要的（当前位置、位置胶囊、agent 名单）；不给时发现列表的 `安装` 不接
  install?: InstallContext;
  /// 空态的 `前往发现`：切到「发现」一面；不给就不出这颗键
  onDiscover?: () => void;
  /// 没有能用 MCP 的 agent 时空态的 `前往设置`：设置停在显示的 agent 那一节；不给就不出这颗键
  onOpenSettings?: () => void;
}

/// 行键：同名服务在一个位置里合成一行；不同位置是不同的行
const rowKeyOf = (row: McpPlacedRow) => mcpRowKey(row.domainKey, row.name);

/// 传输方式：只写真实的传输方式（DESIGN「主视图」）
const transportText = (entry: McpEntry): string | null =>
  entry.transport === "stdio" ? "stdio" : entry.transport === "http" ? "HTTP" : null;

/// 列头：位置名里 agent 那一段；同一页里两列撞名（项目位置里 Claude Code 的 Local / Project）才有
/// 第二行作用域（列头经 `Cap` 显示为 `LOCAL` / `PROJECT`）。全局位置 scope 恒为 User，只写 agent 名一行
const columnHeads = (targets: McpLocation[]): Map<string, { name: string; scope?: string }> => {
  const head = (l: McpLocation) => l.label.split(" · ")[0];
  const out = new Map<string, { name: string; scope?: string }>();
  for (const t of targets) {
    const clash = targets.filter((o) => head(o) === head(t)).length > 1;
    const scope = t.label.split(" · ")[1]?.replace(/ MCPs$/, "");
    out.set(
      t.id,
      clash && scope ? { name: head(t), scope: scope.toLowerCase() } : { name: head(t) },
    );
  }
  return out;
};

/// 列在句子里的名字（提示框、提示条、读屏）：`Claude Code local` / `Codex`
const columnNames = (targets: McpLocation[]): Map<string, string> =>
  new Map(
    [...columnHeads(targets)].map(([id, h]) => [id, h.scope ? `${h.name} ${h.scope}` : h.name]),
  );

const NO_PLACES: InstallPlaces = {
  recent: [],
  sorted: [],
  sort: "active",
  onSort: () => undefined,
};
const placeName = mcpPlaceName;

/// 还没有页的位置的名字：用户级 / 项目文件夹名
const keyName = (key: string): string =>
  key === "global"
    ? t("mcp.domain.user")
    : (key
        .replace(/^project:/, "")
        .split(/[/\\]+/)
        .filter(Boolean)
        .pop() ?? key);

/// 一个空格上有好几份不一样的同名定义能写：不替用户挑
const ambiguousText = (name: string) => t("mcp.blocked.ambiguous", { name });

/// WeiboAP 里的定义不在格子上删（core 同样拒绝）
const weiboRemove = () => t("mcp.cell.weiboRemove", { agent: "WeiboAP" });

/// 待确认的一次写入：批量与跨域确认，同域单格不确认
interface Pane {
  preview: McpPreview;
  crossDomain: boolean;
  anchor?: AnchorRect;
  keyId?: string;
  /// 写完再按一次同一个点恰好撤回：是就不给 `撤销`（批量写进时选中的里这一列原本已有一部分才不是）
  reversible: boolean;
}

/// 「保留这份」确认框：以 `keepId` 那一份为准改写 `locationIds` 里其余几份同名的 `name`
interface KeepPane {
  name: string;
  keepId: string;
  /// 表里的几份（含选中的那一份）
  locationIds: string[];
  /// 用户看到的那张表的指纹（`McpDiff.revision`）
  revision: string;
  /// 这一行的行键与按下时那颗键的位置（撤不了时说明出在这一行）
  rowKey: string;
  anchor?: AnchorRect;
  /// 密钥提醒（S19，issue #147）：要改写的项目文件各自的提醒；还没问回来为 null（墨键灰着）
  hints: McpKeyHint[] | null;
  /// 这一次打开的序号：只认这一次发出的检查（关了再打开同一份，上一次的回包不能填进来）
  check: number;
}

/// 待确认的删除：点了 ●（锚在那一格下），或选择行全有时按下的点（锚在那个点下）
interface DeletePane {
  /// 要删的每一项：哪个位置里的哪一个
  items: McpRemoveItem[];
  /// 选择行里按下的那个点（批量）；单格没有
  keyId?: string;
  /// 单格：那一列的 agent（提示条的图标）
  agent?: ToastAgentRef;
  anchor?: AnchorRect;
  text: ReturnType<typeof deleteMcpOriginalConfirm>;
  /// 删完给不给 `撤销`：删到这个位置里的最后一份、或这一行各份不一样（再点 ○ 写回的是别的版本）才给；
  /// 别处还有一样的，再点 ○ 就是准确反操作，不给（DESIGN「表格」MCP 条）
  undoable: boolean;
  /// 能 ⌘Z 撤、但提示条上不给 `撤销` 键：有顺手的反操作（抽屉里 `只留仅自己`：点另一格就挪过去，
  /// 2026-09-30 产品负责人：「为什么还有撤销按钮，这个可逆」）。不给＝跟着 `undoable`
  undoKey?: boolean;
  /// 删成之后那一窗换一种说法（抽屉里 `只留仅自己`：`✓ 只留仅自己 weibo-comments`，不说「删除」）
  resultText?: ToastText;
}

/// 正在撤销的那一次（undoId）：带撤销的那一窗读它，按下的 `撤销` 原位忙碌
/// （过了 0.3 秒门槛才换成刻度 + 一句）。提示小窗在状态里存的是元素，靠 context 才看得到后来的变化
const UndoBusy = createContext<string | null>(null);

/// 带 `撤销` 的提示小窗：撤销在等 core 从快照还原时，只锁这颗文字链
function UndoToast({ undoId, ...props }: ToastProps & { undoId: string | null }) {
  const busy = useContext(UndoBusy);
  const action =
    props.action && undoId !== null && busy === undoId
      ? { ...props.action, busy: t("mcp.undo.busy") }
      : props.action;
  return <Toast {...props} action={action} />;
}

/// 触发控件此刻的位置：点下去的那颗键 / 那一格还拿着焦点
const anchorNow = (): AnchorRect | undefined => {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body) return undefined;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
};

export default function McpTab({
  locations,
  scopeKey,
  onError,
  banner = false,
  onBusy,
  refreshKey,
  onOverview,
  face = "mine",
  filterBar,
  install,
  onDiscover,
  onOpenSettings,
}: McpTabProps) {
  const [overview, setOverview] = useState<McpOverview | null>(null);
  // 选中的行：域 key → 行键集合
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState("");
  // 自动同步页（页面头的 `自动同步`，原「管理来源」）开着没有。MCP 不再添加来源（spec 2026-09-30-mcp-config-scope R5）：
  // 没有 `+ 来源` 与添加来源页
  const [manageOpen, setManageOpen] = useState(false);
  // 自动同步页的生效范围胶囊用的项目（同安装页；壳没给时只有用户级）
  const places: InstallPlaces = install?.places ?? NO_PLACES;
  const locationSetKey = locations.join("\n");
  const closeManage = useCallback(() => setManageOpen(false), []);
  const [pane, setPane] = useState<Pane | null>(null);
  // 删除的确认框（点了 ●，或选择行全有时按下）
  const [deletePane, setDeletePane] = useState<DeletePane | null>(null);
  // 「保留这份」的确认框（抽屉里「N 份不一样」那张表的行尾键，issue #114）
  const [keepPane, setKeepPane] = useState<KeepPane | null>(null);
  // 同名多份的空格：点它出的挑选浮层（锚在那一格上）
  const [pick, setPick] = useState<McpPick | null>(null);
  // 修改生效范围的确认框（生效范围格的 `修改`，spec 2026-09-30-mcp-config-scope R3）：哪一行、按下时那一格在哪
  const [scopeDialog, setScopeDialog] = useState<{ rowKey: string; at: AnchorRect } | null>(null);
  // 设置里勾了 OpenCode：筛选行下一块没有「!」、能关的灰面板（#115，DESIGN「新手提示条」`mcp-opencode`）。
  // 自动同步页盖着、在 `发现` 一面时不在眼前；壳的错误横幅、确认框、挑选浮层开着时让位
  const openCodeHint = useHint("mcp-opencode", {
    eligible: face === "mine" && !manageOpen && openCodeNoticeWanted(install?.shown ?? []),
    blocked:
      banner || pane !== null || deletePane !== null || pick !== null || scopeDialog !== null,
  });
  // 乐观更新：格键 → 点下去之后该画成的圆点（写进＝●、删除＝空心）；重扫回来后撤掉
  const [optimistic, setOptimistic] = useState<Map<string, Dot>>(new Map());
  // 正在撤销的那一次（undoId）
  const [undoBusy, setUndoBusy] = useState<string | null>(null);
  const [pendingCells, setPendingCells] = useState<Set<string>>(new Set());
  // 批量写入进行中：按下的那一项（只锁它；过了 0.3 秒门槛旁边出忙碌指示 + 一句）
  // 忙碌那一句存成取文案的函数，画的时候才取：换了界面语言跟着换
  const [keyBusy, setKeyBusy] = useState<{ keyId: string; label: () => string } | null>(null);
  const [flash, setFlash] = useState<{ keys: string[]; nonce: number }>();
  const [cellNotice, setCellNotice] = useState<CellNotice | null>(null);
  const [keyToast, setKeyToast] = useState<{ keyId: string; node: ReactNode } | null>(null);
  // 单格写成（浮在被点那一格下）：一个槽位，新的替换旧的
  const [cellToast, setCellToast] = useState<{
    id: number;
    rowKey: string;
    columnId: string;
    node: ReactNode;
  } | null>(null);
  const cellToastSeq = useRef(0);
  // 「保留这份」确认框每打开一次的序号（`KeepPane.check`）
  const keepCheckSeq = useRef(0);
  // 单格删除的结果：锚在按下那一刻那一格的位置（删完这一行可能就没了，不能再去找格子）
  const [rowToast, setRowToast] = useState<{
    rowKey: string;
    at?: AnchorRect;
    node: ReactNode;
  } | null>(null);
  const [globalToast, setGlobalToast] = useState<ReactNode>(null);
  // `2 份不一样` 的字段级差异：悬停时懒加载一次（api.mcpFieldDiff）；null＝读不到，退回「配置不一样」
  const [diffs, setDiffs] = useState<Map<string, string[] | null>>(new Map());
  const diffAsked = useRef<Set<string>>(new Set());
  // 最近一次可撤销的写入（⌘Z、菜单「撤销」与提示条「撤销」走同一个）；有没有可撤的同时报给菜单
  const undoRef = useRef<(() => void) | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const setUndo = useCallback((fn: (() => void) | null) => {
    undoRef.current = fn;
    setCanUndo(fn !== null);
  }, []);
  const refreshVersion = useRef(0);
  const mounted = useRef(true);

  const dismissKey = useCallback(() => setKeyToast(null), []);
  const dismissGlobal = useCallback(() => setGlobalToast(null), []);
  const dismissCell = useCallback(() => setCellToast(null), []);
  const dismissRow = useCallback(() => setRowToast(null), []);
  const dismissNotice = useCallback(() => setCellNotice(null), []);
  /// 单格失败：同一个位置（那一格正下方）说原因，替掉那一格的成功窗（一次只一条）
  const failCell = (
    rowKey: string,
    columnId: string,
    text: string,
    failure?: CellNotice["failure"],
  ) => {
    setCellToast(null);
    setCellNotice({ rowKey, columnId, text, failure });
  };
  // 写入排队：连按几个键、连点几格时一个一个写，不和彼此抢同一份配置文件
  const queue = useRef<Promise<void>>(Promise.resolve());
  const enqueue = (job: () => Promise<void>) => {
    queue.current = queue.current.then(job, job);
    return queue.current;
  };
  const closePick = useCallback(() => setPick(null), []);
  const setOptimisticFor = (keys: string[], dot: Dot | null) =>
    setOptimistic((prev) => {
      const next = new Map(prev);
      for (const k of keys) {
        if (dot === null) next.delete(k);
        else next.set(k, dot);
      }
      return next;
    });

  const refresh = async () => {
    const version = ++refreshVersion.current;
    onBusy(true);
    try {
      const next = await api.scanMcp();
      if (mounted.current && version === refreshVersion.current) {
        setOverview(next);
        onOverview?.(next);
      }
    } catch (error) {
      onError(String(error));
    } finally {
      if (mounted.current && version === refreshVersion.current) onBusy(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // 聚焦、切项目、改设置都会自动重扫，所以没有「刷新」按钮
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // 自动规则在背后写了：右下（壳上那一叠）交代一声（⑨⑬）；格子直接是新状态，不闪
  const domainsRef = useRef<McpDomain[]>([]);
  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void> = [];
    void listen<McpReport>("mcp-auto-imported", ({ payload }) => {
      const created = payload.entries.filter((entry) => entry.outcome === "created");
      if (created.length === 0) return;
      const targets = domainsRef.current.flatMap((d) => d.targets);
      const items: ToastItem[] = created.map((e) => {
        const t = targets.find((x) => x.id === e.targetId);
        return {
          name: e.name,
          agent: t ? { id: t.harnessId, name: mcpAgentName(t) } : undefined,
          project: t ? t.domain !== "global" : undefined,
          note: e.mirrorFailed,
        };
      });
      const text = toastFor("autoWrite", { done: items });
      // 密钥提醒（S19）：自动加进了 .gitignore、或密钥第一次写进仓库没加，在原因的位置说
      const note = keyHintNote(payload, true);
      setGlobalToast(
        <Toast
          {...text}
          {...(note ? { reason: joinReasons(text.reason, note) } : {})}
          names={items.length > 2 ? undefined : text.names}
          reading={
            items.length > 2 ? <ToastCount n={items.length} line="toast.count.mcp" /> : undefined
          }
          onDismiss={dismissGlobal}
          onClose={dismissGlobal}
        />,
      );
    }).then((un) => (disposed ? un() : unlistens.push(un)));
    return () => {
      disposed = true;
      unlistens.forEach((un) => un());
    };
  }, [dismissGlobal]);

  const lang = useLocale();
  // 页名、原因句在这里按当前语言算：换了语言重算
  const domains = useMemo(() => (overview ? mcpDomains(overview) : []), [overview, lang]);
  domainsRef.current = domains;

  // 提示与弹层只属于当次选择；换了范围（切档、切项目）时勾选清空、收起来源页。
  // 按范围本身认，不按位置集合：「项目级 · 全部」下后台重扫多出一个项目，不该清掉手上正做的事
  useEffect(() => {
    setManageOpen(false);
    setPane(null);
    setDeletePane(null);
    setPick(null);
    setScopeDialog(null);
    setKeyToast(null);
    setCellToast(null);
    setRowToast(null);
    setCellNotice(null);
    // 默认一行不选；换一个位置时清空，不把别处的勾选带过来
    setSelected(new Set());
    setUndo(null);
  }, [scopeKey]);

  // 换了界面语言：存着的成句（提示条、格下那一句、字段差异）是旧语言的，收起、清掉，要用时按新语言重取。
  // 勾选、抽屉、撤销入口都不动
  useOnLocaleChange(() => {
    setCellNotice(null);
    setKeyToast(null);
    setCellToast(null);
    setRowToast(null);
    setGlobalToast(null);
    setDiffs(new Map());
    diffAsked.current = new Set();
  });

  // 范围里各位置的页（用户级在前）；这个位置一个 MCP 配置位置都没有时不在里面
  const pages = locations.flatMap((key) => domains.find((d) => d.key === key) ?? []);
  const table = useMemo(
    () => mergeMcpDomains(pages),
    // 页随每一轮扫描换新；范围不变时只跟着扫描结果走
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [domains, locationSetKey, lang],
  );
  /// 这一行自己那一页（格的判断、同名定义、差异都在一页里做）
  const pageOf = (row: McpPlacedRow): McpDomain => pages.find((d) => d.key === row.domainKey)!;
  // 自动同步页：直接进，生效范围在页里选（R8，2026-09-30：不再先弹「哪个位置？」）
  const multi = locations.length > 1;
  const openManageSources = () => setManageOpen(true);
  // 只看一个位置时它的 key（空态的说法用）
  const sourceKey = locations.length === 1 ? locations[0] : null;
  /// 位置名：与表格 `位置` 列同一个写法；表格范围外的位置取扫描出的页名，再不然取文件夹名
  const mcpPlaceNameOf = (key: string): string => {
    const page = domains.find((d) => d.key === key);
    return table.places.get(key) ?? (page ? placeName(page) : keyName(key));
  };
  /// 各位置的来源模型（来源管理页每个位置一份、添加来源页选中的那个位置）：按「位置 + 名字 + 配置位置」缓存，
  /// 重扫回来内容没变时给同一个对象，不重读
  // （签名里带界面语言：模型里有算好的文案，换了语言要重建）
  const models = useRef(new Map<string, { sig: string; model: SourcesModel }>());
  const modelOf = (key: string): SourcesModel => {
    const ref: DomainRef = { key, label: mcpPlaceNameOf(key) };
    const locs = (overview?.locations ?? []).filter((l) => l.domain === key);
    const sig = `${lang}\n${ref.label}\n${locs.map((l) => `${l.id}:${l.matrixHidden ? 1 : 0}`).join("|")}`;
    const hit = models.current.get(key);
    if (hit && hit.sig === sig) return hit.model;
    const model = mcpSourcesModel(ref, locs);
    models.current.set(key, { sig, model });
    return model;
  };

  // 扫描变了，差异可能也变了：重新懒加载
  useEffect(() => {
    diffAsked.current = new Set();
    setDiffs(new Map());
  }, [overview]);

  const loadDiff = (name: string, locationIds: string[]) => {
    if (diffAsked.current.has(name)) return;
    diffAsked.current.add(name);
    void api
      .mcpFieldDiff(name, locationIds)
      .then((diff) =>
        setDiffs((prev) =>
          new Map(prev).set(name, diff.fields.length > 0 ? diff.fields.map((f) => f.field) : null),
        ),
      )
      .catch(() => setDiffs((prev) => new Map(prev).set(name, null)));
  };

  /// 提示框：列出不同的字段名；没加载完或读不到时用扫描里认得出的（url），都没有就写「配置不一样」
  const diffTip = (name: string, scanned: string[]) => {
    const loaded = diffs.get(name);
    const fields = loaded ?? scanned;
    return fields.length > 0
      ? t("mcp.pick.fieldsDiffer", { fields: listText(fields) })
      : t("mcp.pick.different");
  };

  const locationOf = (id: string): McpLocation | undefined =>
    overview?.locations.find((location) => location.id === id);
  /// 一个位置在原因句里的名字：它是哪个 agent（`Claude Code`），不带 core 给的英文作用域（spec #239 第 42 条）
  const labelOf = (id: string) => {
    const location = locationOf(id);
    return location ? mcpAgentName(location) : id;
  };
  /// 差异表与「保留这份」里一份的名字：`用户级 · Claude Code`
  const copyNameOf = (id: string) => {
    const location = locationOf(id);
    return location ? mcpCopyName(mcpPlaceNameOf(location.domain), location) : id;
  };
  /// 一个位置里的一个服务在表里是哪一行、哪一列（写入、删除的结果按位置 id 回来）
  const rowKeyAt = (name: string, locationId: string) =>
    mcpRowKey(locationOf(locationId)?.domain ?? "global", name);
  const cellKeyAt = (name: string, locationId: string) =>
    cellKey(rowKeyAt(name, locationId), mcpColumnOf(locationId));

  const reveal = async (path: string) => {
    try {
      await api.revealInDir(path);
    } catch (e) {
      onError(String(e));
    }
  };
  /// 右键「拷贝路径」：完整路径进剪贴板（展开区里的路径同样能选中 ⌘C）
  const copyPath = (path: string) => void api.copyText(path).catch((e) => onError(String(e)));

  /// 写入的命令本身出错：窗口顶上的横幅说 `加到 Codex 失败`（几处时 `添加失败`），原文与要写的文件完整路径进「!」
  /// （spec #239 第 43 条）
  const writeFault = (error: unknown, targetIds: readonly string[]) => {
    const ids = [...new Set(targetIds)];
    const one = ids.length === 1 ? locationOf(ids[0]) : undefined;
    const paths = [
      ...new Set(
        ids.flatMap((id) => {
          const path = locationOf(id)?.path;
          return path ? [displayPath(path)] : [];
        }),
      ),
    ];
    const { text, ...more } = mcpWriteFault(
      String(error),
      one
        ? t("mcp.write.failedAtPlain", { location: mcpLocationSentence(one) })
        : t("mcp.line.writeCannot"),
      paths,
    );
    onError(text, more);
  };

  /// 这一行为什么勾不动。空值表示可勾
  const blockedOf = (p: McpDomain, row: McpDomainRow): string | undefined => {
    if (sourceForMissing(row, p.targets) !== null) return undefined;
    // 有能删的定义也能勾（选择条上全有的键＝全部删除）
    if (
      p.targets.some(
        (t) => t.harnessId !== "weiboap" && cellViewOf(row, t.id, labelOf)?.dot === "linked",
      )
    )
      return undefined;
    const targetIds = new Set(p.targets.map((target) => target.id));
    const anyMissing = row.entries.some((entry) =>
      entry.cells.some((cell) => targetIds.has(cell.targetId) && cell.state === "missing"),
    );
    if (!anyMissing) return t("mcp.blocked.nowhere", { name: row.name });
    // 「不支持」那行整行不可选：搬过去就不是原来那个了
    if (row.entries.every((entry) => entry.transport === "unsupported" || entry.reason !== null)) {
      return unportableText(
        row.name,
        labelOf(row.entries[0].sourceId),
        row.entries[0].unsupportedField,
      );
    }
    return ambiguousText(row.name);
  };

  // ===== 写入 =====

  const itemsOf = (entries: McpReport["entries"]): ToastItem[] =>
    entries.map((e) => {
      const l = locationOf(e.targetId);
      return {
        name: e.name,
        agent: l ? { id: l.harnessId, name: mcpAgentName(l) } : undefined,
        project: l ? l.domain !== "global" : undefined,
        note: e.mirrorFailed,
      };
    });

  /// 按键忙碌那一句里的位置名：「所有 agent」或那一列的列头名
  const keyAgent = (keyId: string) =>
    keyId === "all"
      ? t("mcp.key.allAgents")
      : (table.columns.find((c) => c.id === keyId)?.sentence ?? labelOf(keyId));

  /// 写一批（已经确认过或不需要确认）。keyId 给了就把结果浮在那颗键下。
  /// 单格：写的时候那一格灰着，写成闪一下。批量（按键）：格子同时变成新状态、不闪；
  /// 只锁按下的那一项，过了 0.3 秒门槛旁边出忙碌指示 + 一句（DESIGN 冲突表「格子变化要不要闪」）。
  /// 写入排在前面的写入之后。`reversible`：写完再按一次同一个点恰好撤回（单格一律是）
  const apply = (
    preview: McpPreview,
    allowCrossDomain: boolean,
    keyId?: string,
    reversible = true,
  ) => {
    const keys = preview.actions.map((a) => cellKeyAt(a.name, a.targetId));
    // Claude Code 两格互斥（spec 2026-09-30-mcp-claude-self-team R4）：另一格有的，写完从那里删掉——先画成空心
    const moving = claudeMovesFor(preview.actions);
    setOptimisticFor(
      moving.map((m) => cellKeyAt(m.name, m.locationId)),
      "missing",
    );
    const single = keyId === undefined;
    setPane(null);
    // 批量开始时收起单格那一窗：一次只一条，撤销入口不混
    if (!single) setCellToast(null);
    setOptimisticFor(keys, "linked");
    if (single) setPendingCells((prev) => new Set([...prev, ...keys]));
    if (keyId) setKeyBusy({ keyId, label: () => batchBusyText("write", keyAgent(keyId)) });
    return enqueue(() => applyWrite(preview, allowCrossDomain, keys, keyId, reversible));
  };

  const applyWrite = async (
    preview: McpPreview,
    allowCrossDomain: boolean,
    keys: string[],
    keyId: string | undefined,
    reversible: boolean,
  ) => {
    const single = keyId === undefined;
    onBusy(true);
    let result: McpReport | null = null;
    try {
      result = await api.applyMcp(preview.planId, allowCrossDomain);
    } catch (error) {
      writeFault(
        error,
        preview.actions.map((a) => a.targetId),
      );
    } finally {
      onBusy(false);
      setPendingCells((prev) => {
        const next = new Set(prev);
        for (const k of keys) next.delete(k);
        return next;
      });
      setKeyBusy((prev) => (prev?.keyId === keyId ? null : prev));
    }
    // 挪过去：写成的那几项，在同一个位置的另一格还有的，从那里删掉（R4）；两步各有撤销号，`撤销` 一起还原
    const moves = claudeMovesFor(result?.entries.filter((e) => e.outcome === "created") ?? []);
    let moveUndoId: string | null = null;
    // 另一格删除失败：给人看的原因；分不出原因（或命令本身出错，原文已进日志）时是空串，只写失败句
    let moveFailed: string | null = null;
    if (moves.length > 0) {
      try {
        const removed = await api.deleteMcpOriginal(moves);
        moveUndoId = removed.undoId;
        const miss = removed.entries.find((e) => e.outcome !== "removed");
        if (miss) moveFailed = mcpEntryReason(miss) ?? "";
      } catch {
        moveFailed = "";
      }
    }
    if (result !== null) {
      const created = result.entries.filter((e) => e.outcome === "created");
      const failed = result.entries.filter((e) => e.outcome === "failed");
      if (single)
        setFlash({ keys: created.map((e) => cellKeyAt(e.name, e.targetId)), nonce: Date.now() });
      const text = toastFor("write", {
        done: itemsOf(created),
        failed: itemsOf(failed).map((item, i) => {
          const at = locationOf(failed[i].targetId);
          return {
            ...item,
            reason: mcpFailedAt(at ? mcpLocationSentence(at) : failed[i].targetId, failed[i]),
          };
        }),
      });
      const undoId = result.undoId;
      // 单格：那一格的键、行键与列（撤销后闪那一格；撤不了时说明出在那一格下）。一份都没写成时
      // 仍锚在被点的那一格上（撤销的结果不落右下）
      const at = created[0] ?? preview.actions[0];
      const one =
        single && at
          ? {
              keys,
              rowKey: rowKeyAt(at.name, at.targetId),
              columnId: mcpColumnOf(at.targetId),
            }
          : undefined;
      // 单格所在的行已说明对象：只写 `✓ 写进 [Codex] · 撤销`（撤不了时的说明同样不重复服务名）
      const rowText = one ? toastFor("write", { done: itemsOf(created), omitNames: true }) : text;
      // 密钥提醒（产品负责人 2026-10-06）：写进项目文件的，写成那一条的原因位置接一句（同自动同步规则，没问过用户）；
      // 第一次暴露的多一颗紧凑键 `加进 .gitignore`，点了就追加，那一条换成 `已加进 .gitignore`。追加的那几行
      // （来源被忽略、写成时自动加的，和点了键补加的）各有撤销号，接进这次写入的撤销：撤成配置之后、重扫之前撤它们
      let keyFacts: Parameters<typeof cellKeyHint>[0] = result;
      const ignoreUndos: string[] = result.gitignoreUndoId ? [result.gitignoreUndoId] : [];
      const writtenNames = [...new Set(created.map((e) => e.name))];
      const undoIgnore = async () => {
        for (const id of ignoreUndos.splice(0).reverse()) {
          let message: string | null = null;
          try {
            const back = await api.mcpUndoWrite(id);
            if (back.outcome !== "undone") message = back.message;
          } catch {
            // 命令本身出错：原文已进日志，提示条只写失败句
            message = "";
          }
          if (message !== null)
            setGlobalToast(
              <Toast
                kind="partial"
                sentence="mcp.scope.toastUndo"
                names={writtenNames}
                reason={
                  message
                    ? tSpaced("mcp.report.gitignoreUndoFailed", { message })
                    : t("mcp.report.gitignoreUndoFailedPlain")
                }
                onDismiss={dismissGlobal}
                onClose={dismissGlobal}
              />,
            );
        }
      };
      // 挪过去的：先还原删掉的那一格，成了再撤写入——中途撤不了就停，不会两边都没了
      const undo = undoId
        ? moveUndoId
          ? () =>
              void (async () => {
                if (await undoWrite(moveUndoId, keyId, rowText, one))
                  await undoWrite(undoId, keyId, rowText, one, undoIgnore);
              })()
          : () => void undoWrite(undoId, keyId, rowText, one, undoIgnore)
        : null;
      setUndo(undo);
      /// 写成那一条（单格、挪过去、批量）按此刻的密钥事实画；点了 `加进 .gitignore` 再画一次
      const showWritten = () => {
        const keyed = cellKeyHint(keyFacts);
        const addKey = keyed.addGitignore
          ? { label: t("mcp.action.addGitignore"), onClick: () => void addIgnore() }
          : undefined;
        if (keyId !== undefined) {
          setKeyToast({
            keyId,
            node: (
              <UndoToast
                undoId={undoId}
                {...text}
                // 写数量（`✓ 写进 ⎔ 2 个`），名字在点的提示框里
                names={text.kind === "success" ? undefined : text.names}
                reading={
                  text.kind === "success" ? (
                    <ToastCount n={created.length} line="toast.count.mcp" />
                  ) : undefined
                }
                reason={joinReasons(text.reason, keyed.note)}
                // 再按一次同一个点就恰好撤回时不给 `撤销`（⌘Z 照旧可用）；选中的里这一列原本已有一部分时给。
                // 密钥第一次写进仓库的多一颗 `加进 .gitignore`，排在 `撤销` 前（同 `去处理 · 撤销`）
                go={addKey}
                action={
                  undo && !reversible ? { label: t("mcp.action.undo"), onClick: undo } : undefined
                }
                onDismiss={dismissKey}
                onClose={text.tier === "notice" ? dismissKey : undefined}
              />
            ),
          });
        } else if (created.length > 0 && moves.length > 0 && moveFailed === null) {
          // 挪成：`✓ 挪到团队共享 sentry · 提交后队友也能用`（R4）。不给 `撤销`：点回原来那一格就挪回去了，
          // 同单格写进（再点一下就是反操作，⑬）；⌘Z 照旧（2026-09-30 产品负责人：「可逆操作不需要撤销吧」）
          const c = created[0];
          const toTeam = mcpColumnOf(c.targetId) === CLAUDE_TEAM;
          setCellToast({
            id: ++cellToastSeq.current,
            rowKey: rowKeyAt(c.name, c.targetId),
            columnId: mcpColumnOf(c.targetId),
            node: (
              <Toast
                kind="success"
                sentence={toTeam ? "mcp.claude.moveToTeamDone" : "mcp.claude.moveToSelfDone"}
                names={[c.name]}
                trail={[toTeam ? teamGained() : teamLost()]}
                reason={keyed.note}
                go={addKey}
                onDismiss={dismissCell}
              />
            ),
          });
        } else if (created.length > 0 && moves.length === 0) {
          // 单格写成：被点那一格正下方浮起 `✓ 写进 [Codex]`（不重复服务名），替换上一条。
          // 不带撤销：再点那一格就是删掉刚写的那一份（⌘Z 照旧可用）
          setCellToast({
            id: ++cellToastSeq.current,
            rowKey: rowKeyAt(created[0].name, created[0].targetId),
            columnId: mcpColumnOf(created[0].targetId),
            node: (
              <Toast
                {...rowText}
                reason={joinReasons(rowText.reason, keyed.note)}
                go={addKey}
                onDismiss={dismissCell}
              />
            ),
          });
        }
      };
      const addIgnore = async () => {
        let added: McpReport;
        try {
          added = await api.addMcpGitignore(keyFacts.ignorable ?? []);
        } catch {
          // 命令本身出错：原文已进日志，提示条只写失败句（不拼系统原文）
          added = {
            entries: [],
            undoId: null,
            gitignoreFailed: t("mcp.report.gitignoreFailedPlain"),
          };
        }
        if (added.gitignoreUndoId) ignoreUndos.push(added.gitignoreUndoId);
        keyFacts = afterGitignoreAdd(keyFacts, added);
        showWritten();
      };
      if (keyId !== undefined) {
        showWritten();
      } else if (failed.length > 0) {
        // 单格失败：不出成功那一窗，同一个位置（格子正下方）说 `context7 写进 [Codex] 失败 · 原因`，
        // 第二行是写的那个文件（spec 2026-10-04-local-diagnostics R12）；提示条里不放详情
        const f = failed[0];
        const line = toastFor("write", {
          done: [],
          // 分不出原因的（core 给了原文）不说原因：空串，提示条只写失败句
          failed: itemsOf([f]).map((item) => ({ ...item, reason: mcpEntryReason(f) ?? "" })),
        });
        const path = locationOf(f.targetId)?.path;
        failCell(rowKeyAt(f.name, f.targetId), mcpColumnOf(f.targetId), f.message, {
          sentence: line.sentence,
          names: line.names,
          agents: line.agents,
          reason: line.reason,
          stats: path ? displayPath(path) : undefined,
        });
      } else if (created.length > 0 && moves.length > 0 && moveFailed !== null) {
        // 写进去了、另一格删除失败：现在两处都有，照实说（行上会挂 `两处都有`，抽屉里只留一处）；密钥已经写进
        // 项目文件的，那一句照样接在后面（这一条是格子下的说明，不带键）
        const c = created[0];
        const toTeam = mcpColumnOf(c.targetId) === CLAUDE_TEAM;
        failCell(
          rowKeyAt(c.name, c.targetId),
          mcpColumnOf(c.targetId),
          joinReasons(
            moveFailed
              ? t(toTeam ? "mcp.claude.writtenTeamKept" : "mcp.claude.writtenSelfKept", {
                  message: moveFailed,
                })
              : t(toTeam ? "mcp.claude.writtenTeamKeptPlain" : "mcp.claude.writtenSelfKeptPlain"),
            cellKeyHint(keyFacts).note,
          ) ?? "",
        );
      } else if (created.length > 0) {
        showWritten();
      }
    }
    await refresh();
    setOptimisticFor(keys, null);
    setOptimisticFor(
      claudeMovesFor(preview.actions).map((m) => cellKeyAt(m.name, m.locationId)),
      null,
    );
  };

  /// 撤销一次写入：core 只在文件仍等于写入后的样子时才从快照还原。改过了就撤不了——
  /// 撤销禁用、提示框说原因，另给「在访达中显示备份 ↗」作手动兜底（DESIGN「MCP 写入的撤销」）
  /// `one`：单格写入的撤销（那一格的键、行键与列）——撤成了那一窗直接消失、格子回原状并闪一下；
  /// 撤不了时说明也出在那一格下（单格删除的撤销给了 `at`：说明出在按下那一刻那一格的位置，那一行可能已不在）。
  /// 批量的锚在选择行里被按的那个点下（选择行已收起时 Matrix 退到那一列的列头）；
  /// 撤销的结果都有触发处，不落右下（右下只给后台自动规则）
  const undoWrite = async (
    undoId: string,
    keyId: string | undefined,
    text: ToastText,
    one?: { keys: string[]; rowKey: string; columnId: string; at?: AnchorRect },
    /// 撤成了、重扫之前接着做的（撤回追加进 .gitignore 的那几行）：重扫会跑自动同步规则，夹在中间可能把刚撤掉的
    /// 服务按「目标已被忽略」悄悄补回来，随后再撤掉忽略那一行，密钥就没人提醒地留在仓库里
    beforeRefresh?: () => Promise<void>,
  ): Promise<boolean> => {
    const single = one !== undefined;
    const at = one?.at;
    setUndo(null);
    // 按下的 `撤销` 原位忙碌（过了 0.3 秒门槛才出刻度 + 一句）；⌘Z 撤的也一样
    setUndoBusy(undoId);
    let report: McpUndoReport;
    try {
      report = await api.mcpUndoWrite(undoId);
    } catch (error) {
      onError(String(error));
      return false;
    } finally {
      setUndoBusy((prev) => (prev === undoId ? null : prev));
    }
    if (report.outcome === "undone") {
      await beforeRefresh?.();
      setKeyToast(null);
      setCellToast(null);
      if (at) setRowToast(null);
      await refresh();
      if (one) setFlash({ keys: one.keys, nonce: Date.now() });
      return true;
    }
    const backup = report.files.find((f) => f.backupPath !== null)?.backupPath ?? null;
    if (report.outcome === "changed") {
      const node = (
        <Toast
          {...text}
          action={{
            label: t("mcp.action.undo"),
            onClick: () => undefined,
            disabledReason: t("mcp.undo.changed"),
          }}
          secondary={
            backup === null
              ? undefined
              : { label: t("mcp.undo.revealBackup"), onClick: () => void reveal(backup) }
          }
          onDismiss={at ? dismissRow : single ? dismissCell : dismissKey}
        />
      );
      if (one && at) setRowToast({ rowKey: one.rowKey, at, node });
      else if (one)
        setCellToast({
          id: ++cellToastSeq.current,
          rowKey: one.rowKey,
          columnId: one.columnId,
          node,
        });
      else setKeyToast({ keyId: keyId ?? "all", node });
      return false;
    }
    // 没撤成：在撤销的入口那里说（那一格下 / 那个点下）
    if (one && at) {
      setRowToast({
        rowKey: one.rowKey,
        at,
        node: (
          <Toast
            kind="cannot"
            message={t("mcp.undo.failed", { message: report.message })}
            onDismiss={dismissRow}
            onClose={dismissRow}
          />
        ),
      });
      return false;
    }
    if (one) {
      failCell(one.rowKey, one.columnId, t("mcp.undo.failed", { message: report.message }));
      return false;
    }
    setKeyToast({
      keyId: keyId ?? "all",
      node: (
        <Toast
          kind="cannot"
          sentence="mcp.line.undoCannot"
          reason={report.message}
          onDismiss={dismissKey}
          onClose={dismissKey}
        />
      ),
    });
    return false;
  };

  /// 写入这些格。批量或跨域的先确认（锚在触发它的键 / 格下面）。
  /// `reversible`：写完再按一次同一个点恰好撤回（见 `Pane.reversible`）
  const write = async (selections: McpSelection[], keyId?: string, reversible = true) => {
    if (selections.length === 0) return;
    const anchor = anchorNow();
    // 按键的：确认框出来之前要先算影响——只锁按下的那一项，过了 0.3 秒门槛旁边出忙碌指示 + 一句
    if (keyId !== undefined) setKeyBusy({ keyId, label: () => t("mcp.write.checking") });
    let preview: McpPreview;
    try {
      preview = await api.proposeMcpSync(selections);
    } catch (error) {
      writeFault(
        error,
        selections.map((sel) => sel.targetId),
      );
      return;
    } finally {
      if (keyId !== undefined) setKeyBusy((prev) => (prev?.keyId === keyId ? null : prev));
    }
    if (preview.actions.length === 0) {
      // 动作为空不等于「都已经有了」：同名已存在、来源读不出、格式搬不过去也都是空动作
      const reason = preview.issues[0]?.message ?? t("mcp.write.nothingNew");
      if (keyId === undefined) {
        // 点格（含挑选浮层里挑了一份）：同一个位置（被点那一格正下方）说原因
        const s = selections[0];
        failCell(rowKeyAt(s.name, s.targetId), mcpColumnOf(s.targetId), reason);
      } else {
        // 按选择行里的点：浮在那个点下
        setKeyToast({
          keyId,
          node: (
            <Toast
              kind="cannot"
              sentence="mcp.line.writeCannot"
              reason={reason}
              onDismiss={dismissKey}
              onClose={dismissKey}
            />
          ),
        });
      }
      return;
    }
    const crossDomain = preview.actions.some((action) => action.crossDomain);
    if (keyId !== undefined || crossDomain) {
      setPane({ preview, crossDomain, anchor, keyId, reversible });
      return;
    }
    // 同域单格：乐观点亮 + 闪一下，不确认；写成出例行一行（被点的那一行里，紧跟名字）
    await apply(preview, false);
  };

  // ===== 修改生效范围：移动或复制整行（spec 2026-09-30-mcp-config-scope R3 R4） =====

  /// 这一行有没有能放到别处的：它这一页里有亮着的、不在 WeiboAP 里的一份（只从别处订阅来的行没有）
  const movable = (placed: McpPlacedRow) =>
    pageOf(placed).targets.some(
      (t) => t.harnessId !== "weiboap" && cellViewOf(placed, t.id, labelOf)?.dot === "linked",
    );

  /// 扫描里一份定义放到某个位置时的格（跨生效范围的也在）：确认框先说哪几份写不过去
  const cellAt: ScopeCellAt = (sourceId, name, targetId) => {
    const entry = overview?.entries.find((e) => e.sourceId === sourceId && e.name === name);
    const cell = entry?.cells.find((c) => c.targetId === targetId);
    return cell && entry ? { cell, unsupportedField: entry.unsupportedField ?? null } : undefined;
  };

  /// 确认框里选的去处在扫描里的那一页（只有 WeiboAP 的位置不算：那里的配置要到 WeiboAP 里改）
  const scopeTargetOf = (key: LocationKey): McpDomain | undefined =>
    domains.find((d) => d.key === key && d.targets.some((t) => t.harnessId !== "weiboap"));

  /// 生效范围格的 `修改`（或右键「修改生效范围…」）：出确认框；结果提示锚在按下那一刻那一格的位置
  const openScopeDialog = (placed: McpPlacedRow, trigger: HTMLElement) => {
    const r = trigger.getBoundingClientRect();
    setPick(null);
    setScopeDialog({
      rowKey: rowKeyOf(placed),
      at: { top: r.top, left: r.left, right: r.right, bottom: r.bottom },
    });
  };

  /// 一个去处为什么选不了（确认框里那颗胶囊灰着、悬停说原因）：已有同名、一份都放不过去、那里没有能写 MCP 的位置
  const targetBlocked = (
    placed: McpPlacedRow,
    key: LocationKey,
    claude: ClaudeCell | undefined,
  ): string | null => {
    const from = pageOf(placed);
    const to = scopeTargetOf(key);
    const name = mcpPlaceNameOf(key);
    if (to === undefined) return tSpaced("mcp.scope.noConfigPlace", { place: name });
    const plan = scopeMovePlan(placed, from, to, labelOf, mcpLocationSentence, claude, cellAt);
    return scopeMoveBlocked(placed, plan, from, to, name, labelOf);
  };

  /// 选中的几个去处（选不了的不算）并成一份计划，与几个去处在句子里的写法
  const scopePlan = (
    placed: McpPlacedRow,
    targets: ReadonlyArray<LocationKey>,
    claude: ClaudeCell | undefined,
    columns?: ReadonlySet<string>,
  ) => {
    const from = pageOf(placed);
    const tos = targets
      .filter((k) => targetBlocked(placed, k, claude) === null)
      .flatMap((k) => scopeTargetOf(k) ?? []);
    const plan = mergeScopePlans(
      tos.map((to) =>
        scopeMovePlan(placed, from, to, labelOf, mcpLocationSentence, claude, cellAt, columns),
      ),
      (id) => {
        const l = locationOf(id);
        return l ? mcpLocationSentence(l) : id;
      },
    );
    return { from, tos, plan, toLabel: scopeTargetsLabel(tos.map((to) => mcpPlaceNameOf(to.key))) };
  };

  /// 「写进哪些 agent」：选中的去处里能写的每个位置一项，默认勾着和现在一致的（同自动同步页的目标菜单）
  const scopeAgents = (placed: McpPlacedRow, targets: LocationKey[]) => {
    const from = pageOf(placed);
    const tos = targets
      .filter((k) => targetBlocked(placed, k, undefined) === null)
      .flatMap((k) => scopeTargetOf(k) ?? []);
    return scopeAgentOptions(placed, from, tos, labelOf, mcpLocationSentence, cellAt);
  };

  /// 确认框这一刻的样子：能不能做、后果几句、几个去处的写法；只勾了这一行在这边没有的 agent 时按加一份说
  const scopeView = (
    placed: McpPlacedRow,
    mode: ScopeMode,
    targets: LocationKey[],
    claude: ClaudeCell | undefined,
    columns: ReadonlySet<string>,
  ): ScopeChoiceView => {
    const { from, tos, plan, toLabel } = scopePlan(placed, targets, claude, columns);
    if (tos.length === 0)
      return { blocked: t("mcp.scope.pickScope"), lines: [], toLabel: "", mode };
    const now = effectiveScopeMode(mode, plan);
    return {
      blocked: plan.selections.length === 0 ? t("mcp.scope.nothingToMove") : null,
      lines: scopeChangeText(now, plan, locationOf, toLabel, mcpPlaceNameOf(from.key)),
      toLabel,
      mode: now,
    };
  };

  /// 确认了：移动时这边亮着的先画成空心；写进每个去处，移动时写成的那几份再从这边删掉
  const changeScope = (
    mode: ScopeMode,
    targets: LocationKey[],
    claude: ClaudeCell | undefined,
    columns: ReadonlySet<string>,
    gitignore: ScopeGitignore,
  ) => {
    const dialog = scopeDialog;
    if (dialog === null) return;
    setScopeDialog(null);
    const placed = table.rows.find((r) => rowKeyOf(r) === dialog.rowKey);
    if (placed === undefined) return;
    const { from, tos, plan, toLabel } = scopePlan(placed, targets, claude, columns);
    if (tos.length === 0 || plan.selections.length === 0) return;
    const now = effectiveScopeMode(mode, plan);
    // 新加的一份（`keep`）用的底子不从这边删
    const fromKeys = [
      ...new Set(
        plan.selections.filter((sel) => !sel.keep).map((sel) => cellKeyAt(sel.name, sel.sourceId)),
      ),
    ];
    setCellToast(null);
    setCellNotice(null);
    if (now === "move") setOptimisticFor(fromKeys, "missing");
    void enqueue(() =>
      applyScopeChange(now, placed, from, tos, toLabel, plan, fromKeys, dialog.at, gitignore),
    );
  };

  const applyScopeChange = async (
    mode: ScopeMode,
    placed: McpPlacedRow,
    from: McpDomain,
    tos: McpDomain[],
    toLabel: string,
    plan: ScopeMove,
    fromKeys: string[],
    at: AnchorRect,
    gitignore: ScopeGitignore,
  ) => {
    const rowKey = rowKeyOf(placed);
    // 结果出在右下：触发它的是确认框里的墨键，确认框一关键就没了（DESIGN「提示条放哪」：键随页面消失了 → 右下）
    const toName = toLabel;
    const toKey = tos.some((to) => to.key === GLOBAL_KEY) ? GLOBAL_KEY : (tos[0]?.key ?? "");
    const fromName = mcpPlaceNameOf(from.key);
    // 主行整句：`移到 CardBox filesystem` / `filesystem 加到 CardBox 失败`
    const line = mode === "move" ? "mcp.scope.toastMove" : "mcp.scope.toastAdd";
    const cannotLine = mode === "move" ? "mcp.scope.toastMoveCannot" : "mcp.scope.toastAddCannot";
    onBusy(true);
    let written: McpReport | null = null;
    let removed: McpReport | null = null;
    let problem: string | null = null;
    let created: McpReport["entries"] = [];
    try {
      const preview = await api.proposeMcpSync(plan.selections);
      if (preview.actions.length > 0) {
        // 密钥提醒（S19）：后端按来源与目标的 git 事实再判一次；勾了的只给「第一次暴露」的项目文件加
        written = await api.applyMcp(preview.planId, true, gitignore.add);
        created = written.entries.filter((e) => e.outcome === "created");
        // 移动：写成的那几份才从这边删；没写成的留着，不会两边都没了
        // 去了几处的同一份只删一次
        const drop = [
          ...new Map(
            plan.selections
              .filter(
                (sel) =>
                  !sel.keep &&
                  created.some((c) => c.name === sel.name && c.targetId === sel.targetId),
              )
              .map((sel) => [sel.sourceId, { locationId: sel.sourceId, name: sel.name }]),
          ).values(),
        ];
        if (mode === "move" && drop.length > 0) removed = await api.deleteMcpOriginal(drop);
      }
      // 分不出原因的（core 给了原文）只写失败句：空串（spec #239 第 43 条）
      const miss =
        written?.entries.find((e) => e.outcome === "failed") ??
        removed?.entries.find((e) => e.outcome !== "removed");
      problem = miss
        ? (mcpEntryReason(miss) ?? "")
        : created.length === 0
          ? (preview.issues[0]?.message ?? t("mcp.scope.nothingToMove"))
          : null;
    } catch {
      // 命令本身出错：原文已进日志（后端 `err`），提示条只写失败句
      problem = "";
    } finally {
      onBusy(false);
    }
    const flashKeys = created.map((e) => cellKeyAt(e.name, e.targetId));
    // 撤销后闪的是这边回来的那几格（复制时这边没动，不闪）
    const one = { keys: mode === "move" ? fromKeys : [], rowKey, columnId: "", at };
    const undoText: ToastText = {
      tier: "routine",
      kind: "success",
      sentence: line,
      place: toName,
      names: [placed.name],
      agents: [],
    };
    // ⌘Z：移动时先还原删掉的那几份，成了再拿掉写过去的那几份——中途撤不了就停，不会两边都没了。
    // 写过去的那几份不走写入的快照：删的时候又写过同一个文件（Claude Code 的用户级与项目本地配置都在
    // ~/.claude.json），写入那次的撤销号已经失效；直接从目标里删掉刚写的那几份。复制只有一次写入，照常撤
    const writeUndo = written?.undoId ?? null;
    const removeUndo = removed?.undoId ?? null;
    // 密钥提醒（S19）追加进 .gitignore 的那几行另有一个撤销号：配置撤回之后再撤它（先撤它的话，密钥还在文件里、
    // 却已不被忽略）。撤不回只多一行忽略，不拦前面的撤销，提示条说一声
    const ignoreUndo = written?.gitignoreUndoId ?? null;
    const undoIgnore = async () => {
      if (ignoreUndo === null) return;
      try {
        const back = await api.mcpUndoWrite(ignoreUndo);
        if (back.outcome !== "undone")
          setGlobalToast(
            <Toast
              kind="partial"
              sentence="mcp.scope.toastUndo"
              names={[placed.name]}
              reason={tSpaced("mcp.report.gitignoreUndoFailed", { message: back.message })}
              onDismiss={dismissGlobal}
              onClose={dismissGlobal}
            />,
          );
      } catch (error) {
        onError(String(error));
      }
    };
    /// 拿掉写过去的那几份；都拿掉了为 true
    const takeBack = async (): Promise<boolean> => {
      let ok = false;
      try {
        const back = await api.deleteMcpOriginal(
          created.map((e) => ({ locationId: e.targetId, name: e.name })),
        );
        const miss = back.entries.find((e) => e.outcome !== "removed");
        if (miss)
          setGlobalToast(
            <Toast
              kind="partial"
              sentence="mcp.scope.toastUndo"
              names={[placed.name]}
              reason={tSpaced("mcp.scope.takeBackFailed", { place: toName, message: miss.message })}
              onDismiss={dismissGlobal}
              onClose={dismissGlobal}
            />,
          );
        ok = miss === undefined;
      } catch (error) {
        onError(String(error));
      }
      await refresh();
      return ok;
    };
    setUndo(
      writeUndo === null
        ? null
        : removeUndo === null
          ? () => void undoWrite(writeUndo, undefined, undoText, one, undoIgnore)
          : () =>
              void (async () => {
                if ((await undoWrite(removeUndo, undefined, undoText, one)) && (await takeBack()))
                  await undoIgnore();
              })(),
    );
    // 密钥提醒（S19）：来源被忽略、目标也自动加进了 .gitignore 的，在原因的位置说「已加进 .gitignore」；
    // 确认框没对某个目标出过勾选（检查之后来源又变了）却把密钥第一次写进了仓库的、勾选护着的文件确认前被 `git add`
    // 了（issue #155）的，也说一声；按目标比对，确认框里说过的不再说（同「保留这份」）
    const keyNote = written ? keyHintNoteAsked(written, gitignore) : undefined;
    if (created.length === 0) {
      setGlobalToast(
        <Toast
          kind="cannot"
          sentence={cannotLine}
          place={toName}
          names={[placed.name]}
          reason={problem || undefined}
          onDismiss={dismissGlobal}
          onClose={dismissGlobal}
        />,
      );
    } else if (problem !== null) {
      setGlobalToast(
        <Toast
          kind="partial"
          sentence={line}
          place={toName}
          names={[placed.name]}
          reason={joinReasons(problem, keyNote)}
          onDismiss={dismissGlobal}
          onClose={dismissGlobal}
        />,
      );
    } else {
      // 右下 `✓ 移到 CardBox filesystem · 只在 CardBox 里能用了 · Claude Desktop 那份留在用户级`；动了团队共享的，
      // 句尾照旧说队友那边（同 Claude Code 两格互斥）。不给撤销键，⌘Z 照旧
      const team = (ids: string[]) => ids.some((id) => mcpColumnOf(id) === CLAUDE_TEAM);
      const trail = scopeMovedTrail(mode, toKey, toName, fromName, [
        ...plan.stays,
        ...plan.cant.map((c) => c.agent),
      ]);
      if (team(created.map((e) => e.targetId))) trail.push(teamGained());
      else if (mode === "move" && team(plan.selections.map((sel) => sel.sourceId)))
        trail.push(teamLost());
      setGlobalToast(
        <Toast
          kind="success"
          sentence={line}
          place={toName}
          names={[placed.name]}
          trail={trail}
          // 第三方模式那一份没写成：成功句后接那一句（`McpReportEntry.mirrorFailed`）；再接密钥提醒的那一句
          reason={joinReasons(mirrorFailedNote(created), keyNote)}
          onDismiss={dismissGlobal}
        />,
      );
    }
    await refresh();
    if (mode === "move") setOptimisticFor(fromKeys, null);
    // 放过去的那一行闪一下（目标生效范围不在表格里时没有那一行，只有提示条）
    if (flashKeys.length > 0) setFlash({ keys: flashKeys, nonce: Date.now() });
  };

  // ===== 删除：点 ●，或选择行全有时按下；确认之后从那个 agent 的配置里删掉（DESIGN「删除原件」MCP） =====

  /// 这一列的配置里有没有这一行（●）
  const holds = (p: McpDomain, name: string, targetId: string) => {
    const row = p.rows.find((r) => r.name === name);
    return row !== undefined && cellViewOf(row, targetId, labelOf)?.dot === "linked";
  };

  /// Claude Code 两格互斥（spec 2026-09-30-mcp-claude-self-team R4）：要写进（或刚写进）的这几项里，
  /// 同一个位置的另一格已经有的——写完要从那里删掉的那几项
  const claudeMovesFor = (items: ReadonlyArray<{ name: string; targetId: string }>) => {
    const out: McpRemoveItem[] = [];
    for (const item of items) {
      const sibling = claudeSibling(mcpColumnOf(item.targetId));
      const domain = locationOf(item.targetId)?.domain;
      if (sibling === null || domain === undefined) continue;
      const p = table.pages.find((page) => page.key === domain);
      const other = table.columns.find((c) => c.id === sibling)?.targets.get(domain);
      if (p === undefined || other === undefined || !holds(p, item.name, other.id)) continue;
      if (!out.some((m) => m.name === item.name && m.locationId === other.id))
        out.push({ locationId: other.id, name: item.name });
    }
    return out;
  };

  /// 这个位置里除了要删的那几列，还有同名定义的 agent（确认框说它们不受影响）
  const othersHolding = (p: McpDomain, names: string[], except: Set<string>): string[] => {
    const heads = columnNames(p.targets);
    return [
      ...new Set(
        p.targets
          .filter((t) => !except.has(t.id) && names.some((name) => holds(p, name, t.id)))
          .map((t) => heads.get(t.id) ?? t.label),
      ),
    ];
  };

  /// 点 ●：别的 agent 里还有同名定义就直接删（带撤销）；是这个位置里最后一份才锚在那一格下出确认框
  /// （DESIGN「表格」MCP 条：只有删完这一行就没了的才确认）
  const askDeleteOriginal = (p: McpDomain, row: McpDomainRow, target: McpLocation) => {
    const agent = columnNames(p.targets).get(target.id) ?? target.label;
    const r = cellElement(
      mcpRowKey(p.key, row.name),
      mcpColumnOf(target.id),
    )?.getBoundingClientRect();
    const others = othersHolding(p, [row.name], new Set([target.id]));
    const differs = differingSourceIds(row, new Set(p.targets.map((t) => t.id))).length > 0;
    const pane: DeletePane = {
      items: [{ locationId: target.id, name: row.name }],
      agent: { id: target.harnessId, name: mcpAgentName(target) },
      anchor: r ? { top: r.top, left: r.left, right: r.right, bottom: r.bottom } : undefined,
      text: deleteMcpOriginalConfirm({ agent, name: row.name, others }),
      undoable: others.length === 0 || differs,
    };
    if (others.length > 0) void deleteOriginal(pane);
    else setDeletePane(pane);
  };

  /// 选择行全有时按下（某一列或「所有位置」）：确认一次删这一批，锚在按下的那个点下。
  /// `全部` 下这一批可以分属几个位置：「别处还有没有」按每一项自己的位置算
  const askDeleteBatch = (table: McpTable, items: McpRemoveItem[], keyId: string) => {
    if (items.length === 0) return;
    const names = [...new Set(items.map((item) => item.name))];
    const agents = new Set<string>();
    const others = new Set<string>();
    let leaving = 0;
    let differs = false;
    for (const p of table.pages) {
      const mine = items.filter((item) => p.targets.some((t) => t.id === item.locationId));
      if (mine.length === 0) continue;
      const heads = columnNames(p.targets);
      const targets = p.targets.filter((t) => mine.some((item) => item.locationId === t.id));
      for (const t of targets) agents.add(heads.get(t.id) ?? t.label);
      const except = new Set(targets.map((t) => t.id));
      const here = [...new Set(mine.map((item) => item.name))];
      for (const agent of othersHolding(p, here, except)) others.add(agent);
      leaving += here.filter((name) => othersHolding(p, [name], except).length === 0).length;
      differs ||= here.some((name) => {
        const row = p.rows.find((r) => r.name === name);
        return (
          row !== undefined &&
          differingSourceIds(row, new Set(p.targets.map((t) => t.id))).length > 0
        );
      });
    }
    const pane: DeletePane = {
      items,
      keyId,
      anchor: anchorNow(),
      text: deleteMcpBatchConfirm({ agents: [...agents], names, others: [...others], leaving }),
      undoable: false,
    };
    // 有一行会删到这个位置里的最后一份才确认（也才给撤销）；每一行别处都还有一样的，直接删、不给撤销
    const emptiesARow = leaving > 0;
    pane.undoable = emptiesARow || differs;
    if (emptiesARow) setDeletePane(pane);
    else void deleteOriginal(pane);
  };

  /// 确认之后删。单格：那一格灰着（仍画 ●），删成了在按下那一刻那一格的位置出例行一行 + `撤销`，
  /// 没删成在同一个位置说原因。批量：格子同时画成空心、不闪，只锁按下的那一项；结果浮在那个点下，
  /// 一条提示条 + `撤销`（撤这一批）。删除后一律给 `撤销`（从快照原样还原）。与写进排同一个队
  const deleteOriginal = (del: DeletePane) => {
    setDeletePane(null);
    setCellNotice(null);
    setCellToast(null);
    const keyId = del.keyId;
    const keys = del.items.map((item) => cellKeyAt(item.name, item.locationId));
    if (keyId === undefined) {
      setOptimisticFor(keys, "linked");
      setPendingCells((prev) => new Set([...prev, ...keys]));
    } else {
      setOptimisticFor(keys, "missing");
      setKeyBusy({ keyId, label: () => batchBusyText("delete", keyAgent(keyId)) });
    }
    const one = del.items[0];
    const cannot = (reason: string | undefined) =>
      setRowToast({
        rowKey: rowKeyAt(one.name, one.locationId),
        at: del.anchor,
        node: (
          <Toast
            kind="cannot"
            sentence="mcp.line.deleteCannot"
            names={[one.name]}
            reason={reason}
            onDismiss={dismissRow}
            onClose={dismissRow}
          />
        ),
      });
    return enqueue(async () => {
      onBusy(true);
      let result: McpReport | null = null;
      try {
        result = await api.deleteMcpOriginal(del.items);
      } catch (error) {
        // 单格：命令本身出错的原文已进日志（后端 `err`），提示条只写失败句（spec #239「出错的时候」）
        if (keyId === undefined) cannot(undefined);
        else onError(String(error));
      } finally {
        onBusy(false);
        if (keyId === undefined)
          setPendingCells((prev) => {
            const next = new Set(prev);
            for (const k of keys) next.delete(k);
            return next;
          });
        else setKeyBusy((prev) => (prev?.keyId === keyId ? null : prev));
      }
      if (result !== null && keyId === undefined) {
        if (!result.entries.some((e) => e.outcome === "removed")) {
          cannot(result.entries[0]?.message ?? t("mcp.delete.noChange"));
        } else {
          // 删的是团队共享那一格：接一句提交之后队友那边的后果（spec 2026-09-30-mcp-claude-self-team R7）
          // 第三方模式那一份没删成时，成功句后接那一句
          const mirrorFailed = result.entries.find((e) => e.outcome === "removed")?.mirrorFailed;
          const base = del.resultText ?? deletedMcpOriginalToast(one.name, del.agent, mirrorFailed);
          const text =
            mcpColumnOf(one.locationId) === CLAUDE_TEAM
              ? { ...base, trail: [...(base.trail ?? []), teamLost()] }
              : base;
          const undoId = result.undoId;
          const at = {
            keys,
            rowKey: rowKeyAt(one.name, one.locationId),
            columnId: mcpColumnOf(one.locationId),
            at: del.anchor,
          };
          const undo =
            undoId && del.undoable ? () => void undoWrite(undoId, undefined, text, at) : null;
          setUndo(undo);
          setRowToast({
            rowKey: rowKeyAt(one.name, one.locationId),
            at: del.anchor,
            node: (
              <UndoToast
                undoId={undoId}
                {...text}
                action={
                  undo && del.undoKey !== false
                    ? { label: t("mcp.action.undo"), onClick: undo }
                    : undefined
                }
                onDismiss={dismissRow}
              />
            ),
          });
        }
      } else if (result !== null && keyId !== undefined) {
        const removed = result.entries.filter((e) => e.outcome === "removed");
        // 拿不掉的写法、已经不在的等以 skipped + 原因回来：和失败一样弹回、说原因
        const failed = result.entries.filter((e) => e.outcome !== "removed");
        setOptimisticFor(
          failed.map((e) => cellKeyAt(e.name, e.targetId)),
          null,
        );
        const text = toastFor("delete", {
          done: itemsOf(removed),
          failed: itemsOf(failed).map((item, i) => ({ ...item, reason: failed[i].message })),
        });
        const undoId = result.undoId;
        const undo =
          undoId && del.undoable && removed.length > 0
            ? () => void undoWrite(undoId, keyId, text)
            : null;
        setUndo(undo);
        setKeyToast({
          keyId,
          node: (
            <UndoToast
              undoId={undoId}
              {...text}
              // 写数量（`✓ 已从 ⎔ 删除 3 个`），名字在点的提示框里
              names={text.kind === "success" ? undefined : text.names}
              reading={
                text.kind === "success" ? (
                  <ToastCount n={removed.length} line="toast.count.mcp" />
                ) : undefined
              }
              action={undo ? { label: t("mcp.action.undo"), onClick: undo } : undefined}
              onDismiss={dismissKey}
              onClose={text.tier === "notice" ? dismissKey : undefined}
            />
          ),
        });
      }
      await refresh();
      setOptimisticFor(keys, null);
    });
  };

  /// 打开「保留这份」的确认框，同时问一次密钥提醒（只读）；问回来之前墨键灰着。问不出来（不该发生）按没有要提醒的算，
  /// 改的时候后端照样再判一次。确认框已换成别的、或已关掉，回来的就不要了
  const openKeep = (open: Omit<KeepPane, "hints" | "check">) => {
    keepCheckSeq.current += 1;
    const pane: KeepPane = { ...open, hints: null, check: keepCheckSeq.current };
    setKeepPane(pane);
    const settle = (hints: McpKeyHint[]) =>
      setKeepPane((now) => (now !== null && now.check === pane.check ? { ...now, hints } : now));
    api
      .checkMcpKeepKeyHints(pane.name, pane.keepId, pane.locationIds)
      .then(settle, () => settle([]));
  };

  /// 「保留这份」确认之后：其余几份改成选中的那一份（core 一处不成整次不动），右下提示条给撤销（⌘Z 同一个）。
  /// 改完重扫，这一行不再「N 份不一样」，抽屉里那一段跟着消失
  const keepCopy = (pane: KeepPane, gitignore: KeepGitignore) => {
    setKeepPane(null);
    const place = copyNameOf(pane.keepId);
    // 没能退回的那一处带着备份：给 `在访达中显示备份 ↗`
    const cannot = (reason: string | undefined, backup: string | null = null) =>
      setGlobalToast(
        <Toast
          kind="cannot"
          sentence="mcp.keep.toastCannot"
          place={place}
          names={[pane.name]}
          reason={reason}
          secondary={
            backup === null
              ? undefined
              : { label: t("mcp.undo.revealBackup"), onClick: () => void reveal(backup) }
          }
          onDismiss={dismissGlobal}
          onClose={dismissGlobal}
        />,
      );
    return enqueue(async () => {
      onBusy(true);
      let result: McpReport | null = null;
      try {
        // 密钥提醒（issue #147）：后端按选中那一份与要改写的几处的 git 事实再判一次；勾了的只给「第一次暴露」的加
        result = await api.keepMcpCopy(
          pane.name,
          pane.keepId,
          pane.locationIds,
          pane.revision,
          gitignore.add,
        );
      } catch {
        // 命令本身出错：原文已进日志（后端 `err`），提示条只写失败句
        cannot(undefined);
      } finally {
        onBusy(false);
      }
      if (result !== null) {
        // 没成的每一处都说：写到一半失败、又没能退回的那一处也是 failed（它其实改了）
        const failed = result.entries.filter((e) => e.outcome === "failed");
        const updated = result.entries.filter((e) => e.outcome === "updated");
        if (failed.length > 0) {
          cannot(
            listText(
              failed.map((e) =>
                t("mcp.keep.failedAt", { place: copyNameOf(e.targetId), message: e.message }),
              ),
              "semicolon",
            ),
            failed.find((e) => e.backupPath !== null)?.backupPath ?? null,
          );
        } else {
          const trail = updated.length > 0 ? [tn("mcp.keep.toastTrail", updated.length)] : [];
          const text: ToastText = {
            tier: "notice",
            kind: "success",
            sentence: "mcp.keep.toast",
            place,
            names: [pane.name],
            agents: [],
            trail,
          };
          const undoId = result.undoId;
          const one = { keys: [], rowKey: pane.rowKey, columnId: "", at: pane.anchor };
          const undo = undoId
            ? () =>
                void (async () => {
                  // 撤成了这一窗没用了；没撤成时说明出在这一行下，撤销记录已用掉，这一窗的键也不能再按
                  await undoWrite(undoId, undefined, text, one);
                  setGlobalToast(null);
                })()
            : null;
          setUndo(undo);
          setGlobalToast(
            <UndoToast
              undoId={undoId}
              kind="success"
              sentence="mcp.keep.toast"
              place={place}
              names={[pane.name]}
              trail={trail}
              // 第三方模式那一份没改成：成功句后接那一句（`McpReportEntry.mirrorFailed`）；密钥提醒：来源被忽略、
              // 自动加进了 .gitignore 的说「已加进 .gitignore」，确认框没出勾选（检查之后又变了）却第一次写进了仓库的也说
              reason={joinReasons(mirrorFailedNote(updated), keyHintNoteAsked(result, gitignore))}
              action={undo ? { label: t("mcp.action.undo"), onClick: undo } : undefined}
              onDismiss={dismissGlobal}
              onClose={dismissGlobal}
            />,
          );
        }
      }
      await refresh();
    });
  };

  /// 点一格：○＝写进（同域单格直接写），●＝确认后从这个 agent 的配置里删掉
  /// 列是 agent；落到这一行自己位置里这一列的配置位置上，判断在这一行自己那一页里做
  const onCell = (rowKey: string, columnId: string) => {
    const placed = table.rows.find((r) => rowKeyOf(r) === rowKey);
    const target = placed
      ? table.columns.find((c) => c.id === columnId)?.targets.get(placed.domainKey)
      : undefined;
    if (!placed || !target) return;
    const p = pageOf(placed);
    const row: McpDomainRow = placed;
    const view = cellViewOf(row, target.id, labelOf);
    if (view === null) return;
    // 位置无效（整份配置读不出来）：点格＝在访达中显示那个配置文件，交给用户自己去看
    if (view.issue === "invalidLocation") {
      void reveal(target.path);
      return;
    }
    if (!view.clickable) return;
    setCellNotice(null);
    // ●：先确认，再从这个 agent 的配置里删掉（是不是这一行的来源都一样）
    if (view.dot === "linked") {
      askDeleteOriginal(p, row, target);
      return;
    }
    const source = sourceForMissingTarget(row, target.id);
    if (source === null) {
      const choices = pickChoices(row, target.id);
      const trigger = cellElement(rowKey, columnId);
      if (choices.length < 2 || trigger === null) {
        // 走不到挑选（按理不会）：不替用户挑，格下说清为什么没写
        failCell(rowKey, columnId, ambiguousText(row.name));
        return;
      }
      // 有好几份不一样的同名定义：不替用户挑，也不另开页——锚在格子上出小浮层挑一份（再点一下收起）
      if (pick?.name === row.name && pick.targetId === target.id) {
        setPick(null);
        return;
      }
      openPick({ name: row.name, targetId: target.id, trigger, choices });
      return;
    }
    void write([{ sourceId: source.sourceId, name: row.name, targetId: target.id }]);
  };

  /// 格子本身（挑选浮层的锚）：那一行里第几列的那颗格
  const cellElement = (rowKey: string, columnId: string): HTMLElement | null => {
    const column = table.columns.findIndex((c) => c.id === columnId);
    const rowEl = document.querySelector(`[data-row="${CSS.escape(rowKey)}"]`);
    return rowEl?.querySelector<HTMLElement>(`[data-cell$=":${column}"]`) ?? null;
  };

  /// 打开挑选浮层，同时懒取各份的字段级差异（只要字段名；取不到就只说「配置不一样」）
  const openPick = (next: McpPick) => {
    setPick(next);
    const ids = next.choices.map((entry) => entry.sourceId);
    const settle = (diff: McpPick["diff"]) =>
      setPick((prev) =>
        prev?.name === next.name && prev.targetId === next.targetId ? { ...prev, diff } : prev,
      );
    api.mcpFieldDiff(next.name, ids).then(settle, () => settle(null));
  };

  /// 挑了一份：焦点先还给格子（跨域确认框锚在它下面），再照单格写入走
  const choose = (sourceId: string) => {
    if (pick === null) return;
    const { name, targetId, trigger } = pick;
    trigger.focus();
    setPick(null);
    void write([{ sourceId, name, targetId }]);
  };

  // 「配置文件」列（spec 2026-09-30-mcp-config-scope R1）：定义所在的配置文件路径（筛选框也搜它）
  const rowOriginPath = (row: McpDomainRow) => {
    const originId = mcpGroupOf(row);
    return locationOf(originId)?.path ?? originId;
  };
  /// 「配置文件」列里写的名字（spec #239 第 41 条）：位置名，与确认框、挑选浮层同一套（`Claude Code`、
  /// `CardBox · Claude Code 团队共享`）；完整路径在悬停、抽屉与右键菜单里
  const rowOriginName = (row: McpPlacedRow) => {
    const originId = mcpGroupOf(row);
    const location = locationOf(originId);
    return location ? mcpOriginName(mcpPlaceNameOf(location.domain), location) : originId;
  };
  // 筛选行右端不再有 `来源` 下拉：MCP 没有「来源」这件事了
  const bar = filterBar?.(null);

  // ===== 渲染 =====

  // `发现` 一面：页面头右端换成搜索框与 `粘贴 JSON`，没有筛选行（R4）；右下那一叠照常在
  // 装上了 MCP：这一页重扫（`我的` 里多出那一行）；撤销交给这一页的撤销栈（⌘Z），切回 `我的` 照样能撤
  if (face === "discover") {
    return (
      <>
        {install ? (
          <DiscoverFlow
            domain="mcp"
            context={install}
            onChanged={refresh}
            onUndoable={setUndo}
            onError={onError}
          />
        ) : null}
        <PageUndo run={() => undoRef.current?.()} can={canUndo} />
        {globalToast ? <CornerToast>{globalToast}</CornerToast> : null}
      </>
    );
  }

  /// 页面头右端只有 `自动同步`（R5）：生效范围里一个位置都没有（没有检测到项目）时不给
  const sourceKeys =
    locations.length > 0 ? (
      <SourceKeys manageLabel={autoSyncWord()} onManage={openManageSources} />
    ) : null;
  /// 表格还没有时的外框：页面头右端照常放筛选框 + `自动同步`（切页签、扫描完时页面头不跳）+ 一块空态
  const frame = {
    filterText,
    onFilterText: setFilterText,
    actions: sourceKeys,
    enabled: !manageOpen,
    bar,
  };
  /// 勾了 OpenCode 的说明（#115）：表格上方（筛选行下，`flush`）与两种空态上方（只勾了 OpenCode 时
  /// 一个配置位置都没有，正是最该说的时候）同一块
  const openCodePanel = (flush: boolean) => (
    <NoticePanel
      scope="section"
      mark={false}
      open={openCodeHint.visible}
      onClose={openCodeHint.dismiss}
      flush={flush}
      message={HINTS["mcp-opencode"]({ agents: [], skills: 0 })}
    />
  );
  /// 自动同步页（二级页，原来源管理页）：每个配置文件的自动同步规则；以前订阅的别处配置照旧能移除
  const managePage = manageOpen ? (
    <SourcesPage
      domain="mcp"
      places={places}
      initial={scopeKey as Location}
      placeName={mcpPlaceNameOf}
      modelOf={modelOf}
      version={overview}
      onChange={refresh}
      onClose={closeManage}
    />
  ) : null;
  if (!overview)
    return (
      <LocationFrame
        {...frame}
        empty={{ description: t("mcp.empty.reading"), busy: true, art: "scanning" }}
      />
    );

  /// 没有能用 MCP 的 agent 时空态里那颗键（spec #239 第 5 条）：到设置里显示 agent
  const settingsKey = onOpenSettings
    ? { label: t("mcp.empty.goSettings"), onClick: onOpenSettings }
    : undefined;
  // 一个配置位置都没有＝显示的 agent 里没有能用 MCP 的：说结果，再说装哪几个、去设置里显示（spec #239 第 5 条）
  if (overview.locations.length === 0) {
    return (
      <LocationFrame
        {...frame}
        hint={openCodePanel(false)}
        empty={{
          description: t("mcp.empty.noAgents"),
          hint: t("mcp.empty.noAgentsHint"),
          art: "noDirs",
          action: settingsKey,
        }}
      />
    );
  }

  // 项目列表是 Skills 与 MCP 的并集：选中的项目在 MCP 这边可能一个配置位置都没有（没开能写 MCP 的 agent）
  if (pages.length === 0) {
    return (
      <LocationFrame
        {...frame}
        hint={openCodePanel(false)}
        empty={{
          description:
            scopeKey === "all"
              ? t("mcp.empty.noPlaceAll")
              : multi
                ? t("mcp.empty.noPlaceMulti")
                : sourceKey === "global"
                  ? t("mcp.empty.noPlaceGlobal")
                  : t("mcp.empty.noneInProject"),
          hint: t("mcp.empty.noAgentsHint"),
          art: "noDirs",
          action: settingsKey,
        }}
      >
        {managePage}
      </LocationFrame>
    );
  }

  /// 这一行那一页里的列（差异只在一页里比）
  const targetIdsOf = (row: McpPlacedRow) => new Set(pageOf(row).targets.map((t) => t.id));
  /// 这一行在这一列的配置位置；这一行的位置里没有这一列（用户级行在 LOCAL 列上）就没有格
  const targetAt = (row: McpPlacedRow, column: McpColumn) => column.targets.get(row.domainKey);
  // 筛选框（⌘F）同时匹配名字、配置文件列里的位置名与完整路径
  const visible = table.rows.filter((row) =>
    matchesFilter(
      filterText,
      row.name,
      `${rowOriginName(row)}\n${displayPath(rowOriginPath(row))}`,
    ),
  );

  /// 格此刻画成什么：乐观更新的画成点下去之后的样子（写进 ●、删除空心），落定前不再可点。
  /// WeiboAP 里的定义不在格子上删
  const viewAt = (row: McpPlacedRow, targetId: string) => {
    const view = cellViewOf(row, targetId, labelOf);
    if (view === null) return null;
    const dot = optimistic.get(cellKey(rowKeyOf(row), mcpColumnOf(targetId)));
    if (dot !== undefined) return { ...view, dot, clickable: false, reason: undefined };
    if (view.dot === "linked" && locationOf(targetId)?.harnessId === "weiboap")
      return { ...view, clickable: false, reason: weiboRemove() };
    return view;
  };

  // ---- 列：第三层是这个位置下能用的条数 ----
  // 第三层与 `名称 N` 同一范围：随当前筛选（DESIGN「计数口径」）
  const columns = table.columns.map((column) => {
    const n = visible.filter((row) => {
      const target = targetAt(row, column);
      return target !== undefined && viewAt(row, target.id)?.dot === "linked";
    }).length;
    return {
      id: column.id,
      agentId: column.harnessId,
      name: column.name,
      scope: column.scope,
      nameTail: column.nameTail,
      group: column.group,
      count: n,
      tip: tn("mcp.column.added", n, { label: column.label }),
      note: mcpColumnNote(column),
    };
  });

  /// 这一空格上有几份不一样的同名定义可挑（能直接定下来源的记 1）
  const choiceCount = (row: McpPlacedRow, targetId: string) =>
    sourceForMissingTarget(row, targetId) === null ? pickChoices(row, targetId).length : 1;

  // ---- 行 ----
  const rows: MatrixRowView[] = visible.map((row) => {
    const key = rowKeyOf(row);
    const cells: Record<string, MatrixCellView | null> = {};
    const unsupportedAt: string[] = [];
    const unsupportedWhy = new Set<string>();
    const page = pageOf(row);
    for (const column of table.columns) {
      const target = targetAt(row, column);
      const view = target ? viewAt(row, target.id) : null;
      if (!target && table.places.size > 1) {
        // 多位置时这一行的位置没有这一列（用户级行在 LOCAL 列、项目行在 DESKTOP 列）：画 ⊘、悬停与按下说原因——
        // 与写不进去的格子同一个样子（2026-09-27 产品负责人：「悬停既然说了，就不用另一种样式了」）
        const blank = mcpBlankTip(table.places.get(row.domainKey) ?? "", column);
        cells[column.id] = {
          dot: "blocked",
          clickable: false,
          tip: blank.tip,
          tipDetail: blank.detail,
        };
        continue;
      }
      if (!target || view === null) {
        cells[column.id] = null;
        continue;
      }
      if (view.dot === "blocked" && !isAgentLimit(view.reasonKind)) {
        unsupportedAt.push(column.sentence);
        if (view.reason) unsupportedWhy.add(view.reason);
      }
      // 位置无效：原因 + 点一下在访达中显示那个配置文件
      const invalid = view.issue === "invalidLocation";
      // Claude Code 两格（R4 R6）：另一格已有时点 ○ 是挪过去；项目行的提示框第二行说写在哪、给谁用
      const place = table.places.get(row.domainKey) ?? "";
      const move =
        view.clickable &&
        view.dot !== "linked" &&
        claudeMovesFor([{ name: row.name, targetId: target.id }]).length > 0
          ? claudeMoveTip(column.id, place)
          : null;
      const where = view.clickable ? claudeWhereText(column.id, place, row.domainKey) : null;
      // 项目里团队共享格点了会写进（#115）：第二行末尾接「要在 Claude Code 里启用才生效」
      const writes = view.clickable && !invalid && view.dot !== "linked";
      // ⊘（写不过去）：第一行说人话，第二行写具体原因（spec #239 第 44 条）
      const blocked =
        view.dot === "blocked" && !view.clickable ? mcpBlockedTip(view, column.sentence) : null;
      cells[column.id] = {
        dot: view.dot,
        clickable: view.clickable || invalid,
        tip: invalid
          ? t("mcp.cell.invalidTip", { reason: view.reason ?? "" })
          : move
            ? move.verb
            : view.clickable
              ? view.dot === "linked"
                ? // 省略号只在会确认时写：删的是这个位置里最后一份
                  `${t("mcp.batch.removeFrom", { target: column.sentence })}${othersHolding(page, [row.name], new Set([target.id])).length > 0 ? "" : "…"}`
                : choiceCount(row, target.id) > 1
                  ? pickTip(row.name, choiceCount(row, target.id))
                  : t("mcp.cell.clickToWrite")
              : (blocked?.tip ?? view.reason ?? ""),
        tipDetail: invalid
          ? undefined
          : blocked
            ? blocked.detail
            : (withEnableNote(move?.detail ?? where, column.id, row.domainKey, writes) ??
              undefined),
        pending: pendingCells.has(cellKey(key, column.id)),
      };
    }
    const differing = differingSourceIds(row, targetIdsOf(row));
    const fields = differingFields(row, targetIdsOf(row));
    // 两处都有（R5）：同一个位置里 Claude Code 仅自己、团队共享都有这个服务——只有仅自己那份生效
    const selfAt = table.columns.find((c) => c.id === CLAUDE_SELF)?.targets.get(row.domainKey);
    const teamAt = table.columns.find((c) => c.id === CLAUDE_TEAM)?.targets.get(row.domainKey);
    const both =
      selfAt !== undefined &&
      teamAt !== undefined &&
      holds(page, row.name, selfAt.id) &&
      holds(page, row.name, teamAt.id);
    /// 抽屉里 `只留…`：删掉另一处，不确认；不给撤销键（点另一格就挪过去，⌘Z 照旧）。结果说「只留」不说「删除」——
    /// 它还在，只是只留在一处（2026-09-30 产品负责人：「提示语感觉不对，其实是从 project 移动到了 local」）；
    /// 删的是团队共享那份时句尾照旧接「提交后队友那边就没有了」（删除那一支按列统一接）
    const keepOnly = (keep: McpLocation, drop: McpLocation) =>
      void deleteOriginal({
        items: [{ locationId: drop.id, name: row.name }],
        agent: { id: drop.harnessId, name: mcpAgentName(drop) },
        text: deleteMcpOriginalConfirm({ agent: "Claude Code", name: row.name, others: [] }),
        resultText: {
          tier: "routine",
          kind: "success",
          sentence:
            mcpColumnOf(keep.id) === CLAUDE_TEAM
              ? "mcp.claude.keepTeamDone"
              : "mcp.claude.keepSelfDone",
          names: [row.name],
          agents: [],
        },
        undoable: true,
        undoKey: false,
        anchor: (() => {
          const r = cellElement(key, mcpColumnOf(keep.id))?.getBoundingClientRect();
          return r ? { top: r.top, left: r.left, right: r.right, bottom: r.bottom } : undefined;
        })(),
      });
    const transports = [
      ...new Set(row.entries.map(transportText).filter((t): t is string => t !== null)),
    ];
    const originId = mcpGroupOf(row);
    const originPath = rowOriginPath(row);
    const canMove = movable(row);
    const openMove = (trigger: HTMLElement) => openScopeDialog(row, trigger);
    return {
      key,
      name: row.name,
      place: table.places.get(row.domainKey),
      // 生效范围格（R3）：悬停这一行时值换成 `修改`，按下出确认框（移动或复制整行）
      placeAction: canMove
        ? { label: t("mcp.scope.editKey"), tip: t("mcp.scope.editTip"), onOpen: openMove }
        : undefined,
      // 配置文件（R1；spec #239 第 41 条）：写位置名，不写路径；悬停出位置名 + 完整路径与 `打开 ↗`，
      // 完整路径另在抽屉与右键「在访达中显示 · 拷贝路径」里
      origin: {
        id: originId,
        label: rowOriginName(row),
        path: originPath,
        onReveal: () => void reveal(originPath),
      },
      cells,
      // 差异是行级事实，不进格：名字后的纯文字记号 `2 份不一样`（12 ink-mute，不是键），提示框给差异字段名；
      // 点它拉开这一行的抽屉，字段级差异是抽屉里的一段。
      // 某列不支持只说明：同样是纯弱标识 + 提示框（原因同那一格：`Cursor 不支持用命令生成请求头`）
      mark: both ? (
        <Tag tone="weak" tip={t("mcp.both.tip")}>
          {t("mcp.both.tag")}
        </Tag>
      ) : differing.length > 0 ? (
        <span
          onMouseEnter={() => loadDiff(row.name, differing)}
          onFocus={() => loadDiff(row.name, differing)}
        >
          <Tag tone="weak" tip={diffTip(row.name, fields)}>
            {tn("mcp.differ.tag", differing.length)}
          </Tag>
        </span>
      ) : unsupportedAt.length > 0 ? (
        <Tag
          tone="weak"
          tip={
            unsupportedWhy.size > 0
              ? listText([...unsupportedWhy], "semicolon")
              : t("mcp.unsupported.tipOne", {
                  agents: listText(unsupportedAt),
                  name: row.name,
                })
          }
        >
          {/* 一列写 agent 名（`Codex 不支持`）；几列时只写处数，名字与原因在提示框里——
                158 宽的名称列放不下一串名字，截掉的会是「不支持」本身 */}
          {unsupportedAt.length === 1
            ? t("mcp.unsupported.tagOne", { agent: unsupportedAt[0] })
            : tn("mcp.unsupported.tagMany", unsupportedAt.length)}
        </Tag>
      ) : undefined,
      // 点服务名 / 记号 / 拉手拉开抽屉：传输（D7：服务的属性，不回答「能不能在这个 agent 用」）、命令或地址、
      // 原件 + 打开 ↗；几份不一样时末尾一段字段级差异（拉开时比对一次，要并排几份值，抽屉铺到最后一列）。
      // 表格一次只开一格，差异不再另开一格抽屉
      detail: (
        <>
          <div className="mx-kv">
            <span className="mx-kv__key">{t("mcp.detail.transport")}</span>
            <span className="mx-kv__value">
              {transports.join(" / ") || t("mcp.detail.transportNone")}
            </span>
            <McpEndpointRow
              name={row.name}
              locationId={originId}
              load={api.mcpEndpoint}
              reloadKey={overview}
            />
            {/* 几份不一样时各份的路径在下面那张表的「原件」列里，这里不再单列 */}
            {differing.length === 0 ? (
              <>
                <span className="mx-kv__key">{t("mcp.detail.origin")}</span>
                <span className="mx-kv__value">
                  <Mono path>{originPath}</Mono>
                  <RevealLink path={originPath} onReveal={() => void reveal(originPath)} />
                </span>
              </>
            ) : null}
          </div>
          {both && selfAt && teamAt ? (
            <div className="mx-keepone">
              <Button size="compact" onClick={() => keepOnly(selfAt, teamAt)}>
                {t("mcp.claude.keepSelf")}
              </Button>
              <Button size="compact" onClick={() => keepOnly(teamAt, selfAt)}>
                {t("mcp.claude.keepTeam")}
              </Button>
            </div>
          ) : null}
          {differing.length > 0 ? (
            <McpDiffSection
              name={row.name}
              locationIds={differing}
              load={api.mcpFieldDiff}
              labelOf={copyNameOf}
              pathOf={(id) => locationOf(id)?.path}
              revealPath={locationOf(differing[0])?.path}
              onReveal={(path) => void reveal(path)}
              reloadKey={overview}
              onKeep={(keepId, revision) =>
                openKeep({
                  name: row.name,
                  keepId,
                  locationIds: differing,
                  revision,
                  rowKey: key,
                  // WebKit 点键不给焦点：拿不到按下的那颗键时退到这一行（改完它还在）
                  anchor:
                    anchorNow() ??
                    (() => {
                      const r = document
                        .querySelector(`[data-row="${CSS.escape(key)}"]`)
                        ?.getBoundingClientRect();
                      return r
                        ? { top: r.top, left: r.left, right: r.right, bottom: r.bottom }
                        : undefined;
                    })(),
                })
              }
            />
          ) : null}
        </>
      ),
      detailWide: differing.length > 0,
      // 右键菜单：修改生效范围（＝生效范围格的 `修改`，键盘也够得着）、在访达中显示原件（＝点路径）、
      // 拷贝路径（＝展开区里可选中的路径）
      menu: () => [
        ...(canMove
          ? [
              {
                label: t("mcp.scope.menuEdit"),
                run: () => {
                  const cell = document
                    .querySelector(`[data-row="${CSS.escape(key)}"]`)
                    ?.querySelector<HTMLElement>(".mx-row__place");
                  if (cell) openMove(cell);
                },
              },
            ]
          : []),
        { label: t("mcp.menu.revealOrigin"), run: () => void reveal(originPath) },
        { label: t("mcp.menu.copyPath"), run: () => copyPath(originPath) },
      ],
      selectDisabledReason: blockedOf(pageOf(row), row),
    };
  });

  // ---- 选择态 ----
  const chosen = visible.filter((row) => selected.has(rowKeyOf(row)));
  // 各行按自己位置里这一列的配置位置算（`全部` 下选中的行可以分属几个位置）
  const missingAt = (column: McpColumn): McpSelection[] =>
    chosen.flatMap((row) => {
      const targetId = targetAt(row, column)?.id;
      if (targetId === undefined) return [];
      const view = viewAt(row, targetId);
      const source = sourceForMissingTarget(row, targetId);
      // ● 可点是删除，不是写进：不算缺的
      return view?.clickable === true && view.dot !== "linked" && source !== null
        ? [{ sourceId: source.sourceId, name: row.name, targetId }]
        : [];
    });
  /// 选中的行里这一列上能删的定义（WeiboAP 里的、正在落定的都不算）
  const deletableAt = (column: McpColumn): McpRemoveItem[] =>
    chosen.flatMap((row) => {
      const targetId = targetAt(row, column)?.id;
      return targetId !== undefined &&
        viewAt(row, targetId)?.dot === "linked" &&
        viewAt(row, targetId)?.clickable === true
        ? [{ locationId: targetId, name: row.name }]
        : [];
    });
  /// 选中的行在这一列上的格（没有格的行不算）
  const viewIn = (row: McpPlacedRow, column: McpColumn) => {
    const target = targetAt(row, column);
    return target ? viewAt(row, target.id) : null;
  };
  // 选择态：工具行里每个位置一项「● / ○ 名字」（DESIGN「MCP 格子只有两种」选择行）：
  // 点 ○ 写进缺的，点 ●（选中的都有了）确认一次、从那个 agent 删掉。写不过去、删不了的格不计入
  const columnChecks: Record<string, ColumnCheck> = {};
  const enabledPresses: {
    add: McpSelection[];
    remove: McpRemoveItem[];
    checked: boolean;
    agent: { id: string; name: string };
  }[] = [];
  for (const target of table.columns) {
    const cells = missingAt(target);
    const deletable = deletableAt(target);
    const present = chosen
      .filter((row) => viewIn(row, target)?.dot === "linked")
      .map((r) => r.name);
    // 还没有、又写不过去的；已经有了、却删不了的（WeiboAP 里的）
    const cant = chosen
      .filter((row) => {
        const v = viewIn(row, target);
        return (
          v !== null &&
          v.dot !== "linked" &&
          !cells.some((c) => c.name === row.name && targetAt(row, target)?.id === c.targetId)
        );
      })
      .map((r) => r.name);
    const stuck = present.filter((name) => !deletable.some((d) => d.name === name));
    const checked = cells.length === 0 && present.length > 0;
    const notes = [
      checked
        ? { names: stuck, why: t("mcp.batch.cantRemove", { target: target.label }) }
        : { names: cant, why: t("mcp.batch.cantWrite", { target: target.label }) },
    ];
    const disabledReason =
      (checked ? deletable.length : cells.length) > 0
        ? undefined
        : checked
          ? t("mcp.batch.disabledRemove", { target: target.label })
          : t("mcp.batch.disabledWrite", { target: target.label });
    if (disabledReason === undefined)
      enabledPresses.push({
        add: cells,
        remove: deletable,
        checked,
        agent: { id: target.group?.agentId ?? target.harnessId, name: target.name },
      });
    columnChecks[target.id] = {
      checked,
      label: checked
        ? t("mcp.batch.checkedRemove", { target: target.label })
        : t("mcp.batch.checkedWrite", { target: target.label }),
      tip: checked
        ? affectedTip(
            t("mcp.batch.removeFrom", { target: target.label }),
            deletable.map((d) => d.name),
            notes,
          )
        : affectedTip(
            t("mcp.batch.writeTo", { target: target.label }),
            cells.map((c) => c.name),
            notes,
          ),
      disabledReason,
      onToggle: () =>
        void (checked
          ? askDeleteBatch(table, deletable, target.id)
          : // 选中的里这一列原本就有能删的时，再按会连原有的一起删掉：只有撤销是准确的退路
            write(cells, target.id, deletable.length === 0)),
    };
  }
  // 「所有位置」：每个能改的位置都全有才打勾；点空框全部写进，点打勾确认一次、全部删掉
  const allChecked = enabledPresses.length > 0 && enabledPresses.every((p) => p.checked);
  const allAdd = enabledPresses.flatMap((p) => p.add);
  const allRemove = enabledPresses.flatMap((p) => p.remove);
  const uniqNames = (cells: { name: string }[]) => [...new Set(cells.map((c) => c.name))];
  // 键上只画这一下真会改到的 agent；Claude 合组的 Code / Local / Desktop 同一枚图标，按图标去重成一枚，
  // 读屏名与提示框写全各家（`写进 Claude Code、Claude Desktop、Codex`）；没有能改的时画全部列
  const pressAgents =
    enabledPresses.length > 0
      ? enabledPresses.map((p) => p.agent)
      : table.columns.map((c) => ({ id: c.group?.agentId ?? c.harnessId, name: c.name }));
  const agentNames = listText([...new Set(pressAgents.map((a) => a.name))]);
  const keyAgents = pressAgents
    .filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i)
    .map((a) => ({ id: a.id, name: a.id === "claude-code" ? "Claude" : a.name }));
  const allAgents: ColumnCheck = {
    checked: allChecked,
    label: allChecked
      ? t("mcp.batch.removeFrom", { target: agentNames })
      : t("mcp.batch.writeTo", { target: agentNames }),
    keyFace: {
      line: allChecked ? "mcp.keyFace.remove" : "mcp.keyFace.write",
      agents: keyAgents,
    },
    tip: allChecked
      ? affectedTip(
          t("mcp.batch.removeFrom", { target: agentNames }),
          uniqNames(allRemove),
          [],
          allRemove.length,
        )
      : affectedTip(
          t("mcp.batch.writeTo", { target: agentNames }),
          uniqNames(allAdd),
          [],
          allAdd.length,
        ),
    disabledReason: enabledPresses.length === 0 ? t("mcp.batch.disabledAll") : undefined,
    onToggle: () =>
      void (allChecked
        ? askDeleteBatch(table, allRemove, "all")
        : write(allAdd, "all", allRemove.length === 0)),
  };

  // 空态（DESIGN「位置页 › 空态」）：只说现状
  const query = filterText.trim();
  const empty =
    query !== "" ? (
      <TableEmpty
        text={t("mcp.empty.noMatch", { query })}
        action={{ label: t("mcp.empty.clearFilter"), onClick: () => setFilterText("") }}
      />
    ) : pages.every((page) => page.targets.some((target) => target.harnessId === "weiboap")) ? (
      <TableEmpty text={t("mcp.empty.noFullDefinition")} art="emptyFolder" />
    ) : (
      // 还没有 MCP：说结果、说哪些会出现在这里，给一颗 `前往发现`（spec #239 第 4、6 条）
      <TableEmpty
        text={
          scopeKey === "all"
            ? t("mcp.empty.noneAll")
            : multi
              ? t("mcp.empty.noneMulti")
              : pages[0].key === "global"
                ? t("mcp.empty.noneInPlace", { place: pages[0].label })
                : t("mcp.empty.noneInProject")
        }
        hint={t("mcp.empty.noneHint")}
        action={onDiscover ? { label: t("mcp.empty.goDiscover"), onClick: onDiscover } : undefined}
        art="emptyFolder"
      />
    );

  // 写进 WeiboAP 的那几处要额外说一句：它只收下定义，启用是它自己的事
  const paneHasWeibo =
    pane !== null &&
    pane.preview.actions.some((action) => locationOf(action.targetId)?.harnessId === "weiboap");

  // 修改生效范围的确认框开着时那一行（重扫后那一行没了就不画）
  const scopeDialogRow =
    scopeDialog === null ? undefined : table.rows.find((r) => rowKeyOf(r) === scopeDialog.rowKey);
  const scopeDialogFrom = scopeDialogRow === undefined ? undefined : pageOf(scopeDialogRow);

  // 带撤销的提示小窗读 UndoBusy（按下的 `撤销` 原位忙碌）
  const content = (
    <section className="mx-page mcp-tab">
      <Matrix
        columns={columns}
        originLabel={t("mcp.table.origin")}
        placeLabel={table.places.size > 0 ? t("mcp.table.place") : undefined}
        bar={bar}
        hint={openCodePanel(true)}
        rows={rows}
        nameLabel={t("mcp.table.name")}
        nameTip={t("mcp.table.nameTip")}
        nameCount={rows.length}
        dotWords="mcp"
        filterText={filterText}
        onFilterText={setFilterText}
        headActions={sourceKeys}
        selected={selected}
        onSelectionChange={(next) => {
          setSelected(next);
          if (next.size === 0) setKeyToast(null);
        }}
        allAgents={allAgents}
        columnChecks={columnChecks}
        onUndo={() => undoRef.current?.()}
        canUndo={canUndo}
        onCell={onCell}
        shortcuts={
          !manageOpen &&
          pane === null &&
          deletePane === null &&
          keepPane === null &&
          pick === null &&
          scopeDialog === null
        }
        empty={empty}
        flash={flash}
        cellNotice={cellNotice}
        onDismissCellNotice={dismissNotice}
        keyToast={keyToast}
        cellToast={cellToast}
        rowToast={rowToast}
        keyBusy={keyBusy && { keyId: keyBusy.keyId, label: keyBusy.label() }}
      />
      {globalToast ? <CornerToast>{globalToast}</CornerToast> : null}

      {/* 批量与跨域的那一道确认，锚在触发它的键 / 格下面。跳过的项目留在这里——它是做决定所需的信息 */}
      {pane !== null && (
        <Confirm
          title={tn("mcp.confirm.title", new Set(pane.preview.actions.map((a) => a.targetId)).size)}
          safetyNote={pane.crossDomain ? t("mcp.confirm.crossNote") : t("mcp.confirm.backupNote")}
          confirmLabel={t("mcp.confirm.write")}
          onConfirm={() => void apply(pane.preview, pane.crossDomain, pane.keyId, pane.reversible)}
          onCancel={() => setPane(null)}
        >
          <ul className="mcp-confirm-list">
            {pane.preview.actions.slice(0, 12).map((action) => (
              <li key={`${action.sourceId}|${action.targetId}|${action.name}`}>
                {action.name} → {copyNameOf(action.targetId)}
              </li>
            ))}
            {pane.preview.actions.length > 12 && (
              <li className="mcp-confirm-more">
                {tn("mcp.confirm.more", pane.preview.actions.length - 12)}
              </li>
            )}
          </ul>
          {paneHasWeibo && (
            <div className="mcp-confirm-note">
              {t("mcp.confirm.weiboNote", { agent: "WeiboAP" })}
            </div>
          )}
          {pane.preview.issues.map((issue, i) => (
            <div key={`${issue.locationId}|${issue.name ?? ""}|${i}`} className="mcp-confirm-note">
              {t("mcp.confirm.skipped", {
                name: issue.name ?? copyNameOf(issue.locationId),
                message: issue.message,
              })}
            </div>
          ))}
        </Confirm>
      )}

      {deletePane !== null && (
        <Confirm
          title={deletePane.text.title}
          confirmLabel={t("mcp.confirm.delete")}
          onConfirm={() => void deleteOriginal(deletePane)}
          onCancel={() => setDeletePane(null)}
        >
          <div className="mx-keeppaths__body">{deletePane.text.body}</div>
        </Confirm>
      )}

      {keepPane !== null && (
        <McpKeepConfirm
          // 换了一次「保留这份」就是新的确认框：勾选不跟着上一次
          key={`${keepPane.keepId}\u0000${keepPane.revision}`}
          title={t("mcp.keep.title", {
            place: copyNameOf(keepPane.keepId),
            name: keepPane.name,
          })}
          body={(() => {
            const others = keepPane.locationIds.filter((id) => id !== keepPane.keepId);
            return tn("mcp.keep.body", others.length, {
              places: listText(others.map(copyNameOf)),
            });
          })()}
          hints={keepPane.hints}
          onConfirm={(gitignore) => void keepCopy(keepPane, gitignore)}
          onCancel={() => setKeepPane(null)}
        />
      )}

      {scopeDialogRow !== undefined && scopeDialogFrom !== undefined ? (
        <McpScopeDialog
          name={scopeDialogRow.name}
          places={places}
          fromKey={scopeDialogFrom.key}
          fromName={mcpPlaceNameOf(scopeDialogFrom.key)}
          agents={(targets) => scopeAgents(scopeDialogRow, targets)}
          view={(mode, targets, columns) =>
            scopeView(scopeDialogRow, mode, targets, undefined, columns)
          }
          targetBlocked={(key) => targetBlocked(scopeDialogRow, key, undefined)}
          keyHints={(targets, columns) => {
            const { plan } = scopePlan(scopeDialogRow, targets, undefined, columns);
            return plan.selections.length > 0
              ? api.checkMcpKeyHints(plan.selections)
              : Promise.resolve([]);
          }}
          onConfirm={(mode, targets, columns, gitignore) =>
            changeScope(mode, targets, undefined, columns, gitignore)
          }
          onCancel={() => setScopeDialog(null)}
        />
      ) : null}

      {pick !== null && (
        <McpPickLayer pick={pick} labelOf={copyNameOf} onPick={choose} onClose={closePick} />
      )}

      {managePage}
    </section>
  );
  return <UndoBusy.Provider value={undoBusy}>{content}</UndoBusy.Provider>;
}
