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
import Matrix, {
  cellKey,
  LocationActions,
  RevealLink,
  SourceKeys,
  type MatrixCellView,
  type MatrixRowView,
  type ColumnCheck,
  type SourceChipItem,
} from "./Matrix";
import { affectedTip, Empty as TableEmpty } from "./DomainView";
import { AddedToast, AddSourcePage } from "./pages/AddSourcePage";
import { SourcesPage } from "./pages/SourcesPage";
import { useSources } from "./SourceRow";
import type { ContextMenuItem } from "./contextMenu";
import { usePageCommand } from "./shell/menuBus";
import { addedParts, type CandidateEntry } from "./pages/addSourceView";
import { mcpSourcesModel } from "./pages/sourcesModel";
import {
  addedOrigins,
  dropOrigin,
  filterAfterAdd,
  liveOrigins,
  originMatches,
} from "./originFilter";
import { MANAGE_SOURCES, mcpLocationName, type DomainRef } from "./pages/sourcesView";
import { McpPickLayer, type McpPick } from "./McpPickLayer";
import { displayPath } from "./pathText";
import {
  cellViewOf,
  differingFields,
  differingSourceIds,
  mcpDomains,
  mcpGroupOf,
  pickChoices,
  pickTip,
  sourceForMissing,
  sourceForMissingTarget,
  type McpDomain,
  type McpDomainRow,
} from "./mcpView";
import { Confirm, CornerToast, Empty, Tag, Toast, ToastCount } from "./ui";
import { McpDiffSection, McpEndpointRow } from "./McpDiffPanel";
import type { ConfirmAnchor, ToastProps } from "./ui";
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
import type {
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
/// 1. **格子只有 ⦿ 有、○ 没有**（DESIGN「MCP 格子只有两种」）——点 ○ 写进一份；点 ⦿ 先确认、
///    再从那个 agent 的配置里删掉这一项（哪一格都一样，不分原件副本）。
///    选择条上的键：未全有＝写进缺的，全有＝确认一次、从那个 agent 删掉选中的这几项
/// 2. **⦿ 不是一条链接，是一份独立定义**——写进、删除都经 core 留快照：没人改过就能撤销，
///    改过了撤销禁用，改给「在访达中显示备份 ↗」作手动兜底。删除后一律给 `撤销`；写进只在
///    再按一次不能准确撤回时给（批量写进时选中的里这一列原本已有一部分）；`⌘Z` 始终可用
/// 3. **差异是行级、不是格级**——`2 份不一样` 是服务名后的纯文字记号（不是键，提示框给差异字段名）；
///    点它（或名字、拉手）拉开这一行的抽屉，不同的字段是抽屉里的一段。传输方式是服务的属性，也在抽屉里（D7）
/// 4. **批量或跨域写入要确认一道**（跨域会把请求头和令牌一并复制过去）；同域单格写入不确认，删除都确认

export interface McpTabProps {
  selectedKey: string;
  onError: (error: string) => void;
  /// 扫描、写入进行中：壳把后台重扫排到它结束之后（不锁页签、不锁项目切换）
  onBusy: (busy: boolean) => void;
  refreshKey: number;
  /// 每次扫描完回传一次（壳拿它算侧栏的项目并集，不用再自己扫一遍）
  onOverview?: (overview: McpOverview) => void;
}

/// 行键：同名服务在一个域里合成一行
const rowKeyOf = (row: McpDomainRow) => row.name;

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

/// 组名（「来源」列与筛选片）：定义所在的位置名，与 MCP 来源页同一个写法（`mcpLocationName`：
/// `Claude Code · User`、`Codex · Project`）
const groupLabel = (l: McpLocation | undefined, id: string): string =>
  l ? mcpLocationName(l) : id;

/// 位置名：全局 / 项目文件夹名（`添加 MCP 来源到 CardBox`）；WeiboAP agent 沿用侧栏的名字
const placeName = (page: McpDomain): string =>
  page.key === "global"
    ? "全局"
    : page.targets.some((t) => t.harnessId === "weiboap")
      ? page.label
      : (page.key
          .replace(/^project:/, "")
          .split(/[/\\]+/)
          .filter(Boolean)
          .pop() ?? page.label);

/// 还没有页的位置的名字：全局 / 项目文件夹名
const keyName = (key: string): string =>
  key === "global"
    ? "全局"
    : (key
        .replace(/^project:/, "")
        .split(/[/\\]+/)
        .filter(Boolean)
        .pop() ?? key);

/// 一个空格上有好几份不一样的同名定义能写：不替用户挑
const ambiguousText = (name: string) => `有好几份不一样的同名 ${name}，无法替你决定用哪一份`;

/// WeiboAP 里的定义不在格子上删（core 同样拒绝）
const WEIBO_REMOVE = "WeiboAP 里的配置要到 WeiboAP 里删";

/// 待确认的一次写入：批量与跨域确认，同域单格不确认
interface Pane {
  preview: McpPreview;
  crossDomain: boolean;
  anchor?: ConfirmAnchor;
  keyId?: string;
  /// 写完再按一次同一个点恰好撤回：是就不给 `撤销`（批量写进时选中的里这一列原本已有一部分才不是）
  reversible: boolean;
}

/// 待确认的删除：点了 ⦿（锚在那一格下），或选择行全有时按下的点（锚在那个点下）
interface DeletePane {
  /// 要删的每一项：哪个位置里的哪一个
  items: McpRemoveItem[];
  /// 选择行里按下的那个点（批量）；单格没有
  keyId?: string;
  /// 单格：那一列的 agent（提示条的图标）
  agent?: ToastAgentRef;
  anchor?: ConfirmAnchor;
  text: ReturnType<typeof deleteMcpOriginalConfirm>;
  /// 删完给不给 `撤销`：删到这个位置里的最后一份、或这一行各份不一样（再点 ○ 写回的是别的版本）才给；
  /// 别处还有一样的，再点 ○ 就是准确反操作，不给（DESIGN「表格」MCP 条）
  undoable: boolean;
}

/// 正在撤销的那一次（undoId）：带撤销的那一窗读它，按下的 `撤销` 原位忙碌
/// （过了 0.3 秒门槛才换成刻度 + 一句）。提示小窗在状态里存的是元素，靠 context 才看得到后来的变化
const UndoBusy = createContext<string | null>(null);

/// 带 `撤销` 的提示小窗：撤销在等 core 从快照还原时，只锁这颗文字链
function UndoToast({ undoId, ...props }: ToastProps & { undoId: string | null }) {
  const busy = useContext(UndoBusy);
  const action =
    props.action && undoId !== null && busy === undoId
      ? { ...props.action, busy: "正在撤销" }
      : props.action;
  return <Toast {...props} action={action} />;
}

/// 触发控件此刻的位置：点下去的那颗键 / 那一格还拿着焦点
const anchorNow = (): ConfirmAnchor | undefined => {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body) return undefined;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
};

export default function McpTab({
  selectedKey,
  onError,
  onBusy,
  refreshKey,
  onOverview,
}: McpTabProps) {
  const [overview, setOverview] = useState<McpOverview | null>(null);
  // 选中的行：域 key → 行键集合
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState("");
  // 来源筛选；空＝全部。多选纳入式，加完来源时一次选中新加的几个
  const [originFilter, setOriginFilter] = useState<string[]>([]);
  // 添加来源页（页面头的 `+ 来源`、菜单「添加来源…」、来源管理页的 `+ 来源`）开着没有；
  // 从来源管理页进去的，返回时回到来源管理页（同 Skills）
  const [addOpen, setAddOpen] = useState(false);
  const addFromManage = useRef(false);
  // 来源管理页（页面头的 `管理来源`、来源项右键「管理来源」）开着没有；回到它时新来源那几行闪一下
  const [manageOpen, setManageOpen] = useState(false);
  const [manageFlash, setManageFlash] = useState<string[]>([]);
  const openAdd = useCallback(() => {
    addFromManage.current = false;
    setAddOpen(true);
  }, []);
  const closeAdd = useCallback(() => {
    setAddOpen(false);
    if (addFromManage.current) {
      addFromManage.current = false;
      setManageOpen(true);
    }
  }, []);
  const closeManage = useCallback(() => setManageOpen(false), []);
  const addFromManagePage = useCallback(() => {
    setManageOpen(false);
    addFromManage.current = true;
    setAddOpen(true);
  }, []);
  usePageCommand("add-source", openAdd);
  const [pane, setPane] = useState<Pane | null>(null);
  // 删除的确认框（点了 ⦿，或选择行全有时按下）
  const [deletePane, setDeletePane] = useState<DeletePane | null>(null);
  // 同名多份的空格：点它出的挑选浮层（锚在那一格上）
  const [pick, setPick] = useState<McpPick | null>(null);
  // 乐观更新：格键 → 点下去之后该画成的圆点（写进＝⦿、删除＝空心）；重扫回来后撤掉
  const [optimistic, setOptimistic] = useState<Map<string, Dot>>(new Map());
  // 正在撤销的那一次（undoId）
  const [undoBusy, setUndoBusy] = useState<string | null>(null);
  const [pendingCells, setPendingCells] = useState<Set<string>>(new Set());
  // 批量写入进行中：按下的那一项（只锁它；过了 0.3 秒门槛旁边出忙碌指示 + 一句）
  const [keyBusy, setKeyBusy] = useState<{ keyId: string; label: string } | null>(null);
  const [flash, setFlash] = useState<{ keys: string[]; nonce: number }>();
  const [cellNotice, setCellNotice] = useState<{
    rowKey: string;
    columnId: string;
    text: string;
  } | null>(null);
  const [keyToast, setKeyToast] = useState<{ keyId: string; node: ReactNode } | null>(null);
  // 单格写成（浮在被点那一格下）：一个槽位，新的替换旧的
  const [cellToast, setCellToast] = useState<{
    id: number;
    rowKey: string;
    columnId: string;
    node: ReactNode;
  } | null>(null);
  const cellToastSeq = useRef(0);
  // 单格删除的结果：锚在按下那一刻那一格的位置（删完这一行可能就没了，不能再去找格子）
  const [rowToast, setRowToast] = useState<{
    rowKey: string;
    at?: ConfirmAnchor;
    node: ReactNode;
  } | null>(null);
  const [globalToast, setGlobalToast] = useState<ReactNode>(null);
  // 加完来源、开始滑回位置页：加上的那几个（等这一轮渲染拿到重扫后的页再筛）；新来源那几项下的那一窗
  const [justAdded, setJustAdded] = useState<CandidateEntry[] | null>(null);
  const [addedToast, setAddedToast] = useState<{
    key: number;
    parts: string[];
    origins: string[];
  } | null>(null);
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
  const dismissAdded = useCallback(() => setAddedToast(null), []);
  /// 单格失败：同一个位置（那一格正下方）说原因，替掉那一格的成功窗（一次只一条）
  const failCell = (rowKey: string, columnId: string, text: string) => {
    setCellToast(null);
    setCellNotice({ rowKey, columnId, text });
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
        return { name: e.name, agent: t ? { id: t.harnessId, name: t.label } : undefined };
      });
      const text = toastFor("autoWrite", { done: items });
      setGlobalToast(
        <Toast
          {...text}
          names={items.length > 2 ? undefined : text.names}
          reading={items.length > 2 ? <ToastCount n={items.length} /> : undefined}
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

  const domains = useMemo(() => (overview ? mcpDomains(overview) : []), [overview]);
  domainsRef.current = domains;

  // 提示与弹层只属于当次选择；换一个位置时勾选与来源筛选清空、收起来源管理页
  useEffect(() => {
    setManageOpen(false);
    setPane(null);
    setDeletePane(null);
    setPick(null);
    setKeyToast(null);
    setCellToast(null);
    setRowToast(null);
    setCellNotice(null);
    setAddedToast(null);
    // 默认一行不选；换一个位置时清空，不把别处的勾选带过来
    setSelected(new Set());
    setOriginFilter([]);
    setUndo(null);
  }, [selectedKey]);

  const page: McpDomain | null = domains.find((d) => d.key === selectedKey) ?? null;

  // ---- 这个位置订阅的 MCP 来源：来源管理页（规则 + 移除）、来源项的右键菜单、添加来源页的候选 ----
  const domainRef: DomainRef = page
    ? { key: page.key, label: placeName(page) }
    : { key: selectedKey, label: keyName(selectedKey) };
  const domainLocations = useMemo(
    () => (overview?.locations ?? []).filter((l) => l.domain === domainRef.key),
    [overview, domainRef.key],
  );
  const locationsKey = domainLocations.map((l) => `${l.id}:${l.matrixHidden ? 1 : 0}`).join("|");
  const model = useMemo(
    () => mcpSourcesModel(domainRef, domainLocations),
    // 位置按 id 比：重扫回来内容没变时不换模型，不重读
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [domainRef.key, domainRef.label, locationsKey],
  );
  const sources = useSources({
    model,
    domain: domainRef,
    version: overview,
    onChange: refresh,
    // 移除之后：正勾着它就从筛选里去掉，其余勾着的照旧
    onRemoved: (id) => setOriginFilter((prev) => dropOrigin(prev, id)),
    keys: !addOpen && !manageOpen && pane === null && deletePane === null && pick === null,
  });

  // 加完来源滑回位置页（同 Skills）：重扫已完。只加了一个就选中它（列表筛到它），它正下方浮起
  // `✓ 已添加 … · 已筛选出它的 N 个 MCP`；加了几个就停在 `全部`，新行的格闪一下。
  // 从来源管理页进去加的回到来源管理页，新来源那几行闪一下，位置页的筛选不动
  useEffect(() => {
    if (justAdded === null || !overview) return;
    setJustAdded(null);
    if (addFromManage.current) {
      setManageFlash(justAdded.map((e) => e.id));
      return;
    }
    if (!page) return;
    const ids = addedOrigins(
      justAdded.map((e) => e.id),
      page.rows.flatMap((r) => r.entries.map((e) => e.sourceId)),
    );
    let parts: string[];
    if (ids.length > 0) {
      // 名字与来源筛选同一个写法（groupLabel）；数量＝新来源的行数
      const added = page.rows.filter((r) =>
        originMatches(
          ids,
          r.entries.map((e) => e.sourceId),
        ),
      );
      const pick = filterAfterAdd(ids);
      parts = addedParts(
        ids.map((id) =>
          groupLabel(
            overview.locations.find((l) => l.id === id),
            id,
          ),
        ),
        added.length,
        "MCP",
        pick.length > 0,
      );
      setFilterText("");
      setOriginFilter(pick);
      // 停在 `全部`：新行混在全部里，格闪一下交代「就是这些」
      if (pick.length === 0)
        setFlash({
          keys: added.flatMap((r) => page.targets.map((t) => cellKey(rowKeyOf(r), t.id))),
          nonce: Date.now(),
        });
    } else {
      // 新来源在这个位置下一行都没有：来源筛选里没有它可选，只交代加上了
      parts = addedParts(
        justAdded.map((e) => e.name),
        justAdded.reduce((n, e) => n + e.count, 0),
        "MCP",
        false,
      );
    }
    setAddedToast({ key: Date.now(), parts, origins: ids });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justAdded, overview]);

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
    return fields.length > 0 ? `${fields.join("、")} 不同` : "配置不一样";
  };

  const locationOf = (id: string): McpLocation | undefined =>
    overview?.locations.find((location) => location.id === id);
  const labelOf = (id: string) => locationOf(id)?.label ?? id;

  const reveal = async (path: string) => {
    try {
      await api.revealInDir(path);
    } catch (e) {
      onError(String(e));
    }
  };
  /// 右键「拷贝路径」：完整路径进剪贴板（展开区里的路径同样能选中 ⌘C）
  const copyPath = (path: string) => void api.copyText(path).catch((e) => onError(String(e)));

  /// 这一行为什么勾不动。空值表示可勾
  const blockedOf = (p: McpDomain, row: McpDomainRow): string | undefined => {
    if (sourceForMissing(row, p.targets) !== null) return undefined;
    // 有能删的定义也能勾（选择条上全有的键＝全部删除）
    if (
      p.targets.some(
        (t) => t.harnessId !== "weiboap" && cellViewOf(row, t.id, labelOf)?.dot === "own",
      )
    )
      return undefined;
    const targetIds = new Set(p.targets.map((target) => target.id));
    const anyMissing = row.entries.some((entry) =>
      entry.cells.some((cell) => targetIds.has(cell.targetId) && cell.state === "missing"),
    );
    if (!anyMissing) return `${row.name} 在这里没有能写进或删除的位置`;
    // 「不支持」那行整行不可选：搬过去就不是原来那个了
    if (row.entries.every((entry) => entry.transport === "unsupported" || entry.reason !== null)) {
      return `${row.name} 用了只有 ${labelOf(row.entries[0].sourceId)} 支持的写法，写到别处就不是原来那个了`;
    }
    return ambiguousText(row.name);
  };

  // ===== 写入 =====

  const itemsOf = (entries: McpReport["entries"]): ToastItem[] =>
    entries.map((e) => {
      const l = locationOf(e.targetId);
      return { name: e.name, agent: l ? { id: l.harnessId, name: l.label } : undefined };
    });

  /// 按键忙碌那一句里的位置名：「所有 agent」或那一列的列头名
  const keyAgent = (keyId: string) =>
    keyId === "all"
      ? "所有 agent"
      : ((page ? columnNames(page.targets).get(keyId) : undefined) ?? labelOf(keyId));

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
    const keys = preview.actions.map((a) => cellKey(a.name, a.targetId));
    const single = keyId === undefined;
    setPane(null);
    // 批量开始时收起单格那一窗：一次只一条，撤销入口不混
    if (!single) setCellToast(null);
    setOptimisticFor(keys, "own");
    if (single) setPendingCells((prev) => new Set([...prev, ...keys]));
    if (keyId) setKeyBusy({ keyId, label: batchBusyText("write", keyAgent(keyId)) });
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
      onError(String(error));
    } finally {
      onBusy(false);
      setPendingCells((prev) => {
        const next = new Set(prev);
        for (const k of keys) next.delete(k);
        return next;
      });
      setKeyBusy((prev) => (prev?.keyId === keyId ? null : prev));
    }
    if (result !== null) {
      const created = result.entries.filter((e) => e.outcome === "created");
      const failed = result.entries.filter((e) => e.outcome === "failed");
      if (single)
        setFlash({ keys: created.map((e) => cellKey(e.name, e.targetId)), nonce: Date.now() });
      const text = toastFor("write", {
        done: itemsOf(created),
        failed: itemsOf(failed).map((item, i) => ({
          ...item,
          reason: `${labelOf(failed[i].targetId)} 那边没写成：${failed[i].message}`,
        })),
      });
      const undoId = result.undoId;
      // 单格：那一格的键、行键与列（撤销后闪那一格；撤不了时说明出在那一格下）。一份都没写成时
      // 仍锚在被点的那一格上（撤销的结果不落右下）
      const at = created[0] ?? preview.actions[0];
      const one = single && at ? { keys, rowKey: at.name, columnId: at.targetId } : undefined;
      // 单格所在的行已说明对象：只写 `✓ 写进 [Codex] · 撤销`（撤不了时的说明同样不重复服务名）
      const rowText = one ? toastFor("write", { done: itemsOf(created), omitNames: true }) : text;
      const undo = undoId ? () => void undoWrite(undoId, keyId, rowText, one) : null;
      setUndo(undo);
      if (keyId !== undefined) {
        setKeyToast({
          keyId,
          node: (
            <UndoToast
              undoId={undoId}
              {...text}
              // 写数量（`✓ 写进 ⎔ 2 个`），名字在点的提示框里
              names={text.kind === "success" ? undefined : text.names}
              reading={text.kind === "success" ? <ToastCount n={created.length} /> : undefined}
              // 再按一次同一个点就恰好撤回时不给 `撤销`（⌘Z 照旧可用）；选中的里这一列原本已有一部分时给
              action={undo && !reversible ? { label: "撤销", onClick: undo } : undefined}
              onDismiss={dismissKey}
              onClose={text.tier === "notice" ? dismissKey : undefined}
            />
          ),
        });
      } else if (failed.length > 0) {
        // 单格失败：不出成功那一窗，同一个位置（格子正下方）黑窗说原因
        const f = failed[0];
        failCell(f.name, f.targetId, f.message);
      } else if (created.length > 0) {
        // 单格写成：被点那一格正下方浮起 `✓ 写进 [Codex]`（不重复服务名），替换上一条。
        // 不带撤销：再点那一格就是删掉刚写的那一份（⌘Z 照旧可用）
        setCellToast({
          id: ++cellToastSeq.current,
          rowKey: created[0].name,
          columnId: created[0].targetId,
          node: <Toast {...rowText} onDismiss={dismissCell} />,
        });
      }
    }
    await refresh();
    setOptimisticFor(keys, null);
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
    one?: { keys: string[]; rowKey: string; columnId: string; at?: ConfirmAnchor },
  ) => {
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
      return;
    } finally {
      setUndoBusy((prev) => (prev === undoId ? null : prev));
    }
    if (report.outcome === "undone") {
      setKeyToast(null);
      setCellToast(null);
      if (at) setRowToast(null);
      await refresh();
      if (one) setFlash({ keys: one.keys, nonce: Date.now() });
      return;
    }
    const backup = report.files.find((f) => f.backupPath !== null)?.backupPath ?? null;
    if (report.outcome === "changed") {
      const node = (
        <Toast
          {...text}
          action={{
            label: "撤销",
            onClick: () => undefined,
            disabledReason: "写入之后文件又被改过，无法安全撤销",
          }}
          secondary={
            backup === null
              ? undefined
              : { label: "在访达中显示备份", onClick: () => void reveal(backup) }
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
      return;
    }
    // 没撤成：在撤销的入口那里说（那一格下 / 那个点下）
    if (one && at) {
      setRowToast({
        rowKey: one.rowKey,
        at,
        node: (
          <Toast
            kind="cannot"
            message={`没撤销：${report.message}`}
            onDismiss={dismissRow}
            onClose={dismissRow}
          />
        ),
      });
      return;
    }
    if (one) {
      failCell(one.rowKey, one.columnId, `没撤销：${report.message}`);
      return;
    }
    setKeyToast({
      keyId: keyId ?? "all",
      node: (
        <Toast
          kind="cannot"
          verb="没撤销"
          reason={report.message}
          onDismiss={dismissKey}
          onClose={dismissKey}
        />
      ),
    });
  };

  /// 写入这些格。批量或跨域的先确认（锚在触发它的键 / 格下面）。
  /// `reversible`：写完再按一次同一个点恰好撤回（见 `Pane.reversible`）
  const write = async (selections: McpSelection[], keyId?: string, reversible = true) => {
    if (selections.length === 0) return;
    const anchor = anchorNow();
    // 按键的：确认框出来之前要先算影响——只锁按下的那一项，过了 0.3 秒门槛旁边出忙碌指示 + 一句
    if (keyId !== undefined) setKeyBusy({ keyId, label: "正在查看影响" });
    let preview: McpPreview;
    try {
      preview = await api.proposeMcpSync(selections);
    } catch (error) {
      onError(String(error));
      return;
    } finally {
      if (keyId !== undefined) setKeyBusy((prev) => (prev?.keyId === keyId ? null : prev));
    }
    if (preview.actions.length === 0) {
      // 动作为空不等于「都已经有了」：同名已存在、来源读不出、格式搬不过去也都是空动作
      const reason = preview.issues[0]?.message ?? "这些位置上都已经有了，没有要新增的";
      if (keyId === undefined) {
        // 点格（含挑选浮层里挑了一份）：同一个位置（被点那一格正下方）说原因
        const s = selections[0];
        failCell(s.name, s.targetId, reason);
      } else {
        // 按选择行里的点：浮在那个点下
        setKeyToast({
          keyId,
          node: (
            <Toast
              kind="cannot"
              verb="没写进"
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

  // ===== 删除：点 ⦿，或选择行全有时按下；确认之后从那个 agent 的配置里删掉（DESIGN「删除原件」MCP） =====

  /// 这一列的配置里有没有这一行（⦿）
  const holds = (p: McpDomain, name: string, targetId: string) => {
    const row = p.rows.find((r) => rowKeyOf(r) === name);
    return row !== undefined && cellViewOf(row, targetId, labelOf)?.dot === "own";
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

  /// 点 ⦿：别的 agent 里还有同名定义就直接删（带撤销）；是这个位置里最后一份才锚在那一格下出确认框
  /// （DESIGN「表格」MCP 条：只有删完这一行就没了的才确认）
  const askDeleteOriginal = (p: McpDomain, row: McpDomainRow, target: McpLocation) => {
    const agent = columnNames(p.targets).get(target.id) ?? target.label;
    const r = cellElement(p, rowKeyOf(row), target.id)?.getBoundingClientRect();
    const others = othersHolding(p, [row.name], new Set([target.id]));
    const differs = differingSourceIds(row, new Set(p.targets.map((t) => t.id))).length > 0;
    const pane: DeletePane = {
      items: [{ locationId: target.id, name: row.name }],
      agent: { id: target.harnessId, name: target.label },
      anchor: r ? { top: r.top, left: r.left, right: r.right, bottom: r.bottom } : undefined,
      text: deleteMcpOriginalConfirm({ agent, name: row.name, others }),
      undoable: others.length === 0 || differs,
    };
    if (others.length > 0) void deleteOriginal(pane);
    else setDeletePane(pane);
  };

  /// 选择行全有时按下（某一列或「所有位置」）：确认一次删这一批，锚在按下的那个点下
  const askDeleteBatch = (p: McpDomain, items: McpRemoveItem[], keyId: string) => {
    if (items.length === 0) return;
    const heads = columnNames(p.targets);
    const targets = p.targets.filter((t) => items.some((item) => item.locationId === t.id));
    const names = [...new Set(items.map((item) => item.name))];
    const except = new Set(targets.map((t) => t.id));
    const pane: DeletePane = {
      items,
      keyId,
      anchor: anchorNow(),
      text: deleteMcpBatchConfirm({
        agents: [...new Set(targets.map((t) => heads.get(t.id) ?? t.label))],
        names,
        others: othersHolding(p, names, except),
        leaving: names.filter((name) => othersHolding(p, [name], except).length === 0).length,
      }),
      undoable: false,
    };
    // 有一行会删到这个位置里的最后一份才确认（也才给撤销）；每一行别处都还有一样的，直接删、不给撤销
    const emptiesARow = names.some((name) => othersHolding(p, [name], except).length === 0);
    const differs = names.some((name) => {
      const row = p.rows.find((r) => rowKeyOf(r) === name);
      return (
        row !== undefined && differingSourceIds(row, new Set(p.targets.map((t) => t.id))).length > 0
      );
    });
    pane.undoable = emptiesARow || differs;
    if (emptiesARow) setDeletePane(pane);
    else void deleteOriginal(pane);
  };

  /// 确认之后删。单格：那一格灰着（仍画 ⦿），删成了在按下那一刻那一格的位置出例行一行 + `撤销`，
  /// 没删成在同一个位置说原因。批量：格子同时画成空心、不闪，只锁按下的那一项；结果浮在那个点下，
  /// 一条提示条 + `撤销`（撤这一批）。删除后一律给 `撤销`（从快照原样还原）。与写进排同一个队
  const deleteOriginal = (del: DeletePane) => {
    setDeletePane(null);
    setCellNotice(null);
    setCellToast(null);
    const keyId = del.keyId;
    const keys = del.items.map((item) => cellKey(item.name, item.locationId));
    if (keyId === undefined) {
      setOptimisticFor(keys, "own");
      setPendingCells((prev) => new Set([...prev, ...keys]));
    } else {
      setOptimisticFor(keys, "missing");
      setKeyBusy({ keyId, label: batchBusyText("delete", keyAgent(keyId)) });
    }
    const one = del.items[0];
    const cannot = (reason: string) =>
      setRowToast({
        rowKey: one.name,
        at: del.anchor,
        node: (
          <Toast
            kind="cannot"
            verb="没删掉"
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
        if (keyId === undefined) cannot(String(error));
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
          cannot(result.entries[0]?.message ?? "没有改动");
        } else {
          const text = deletedMcpOriginalToast(one.name, del.agent);
          const undoId = result.undoId;
          const at = { keys, rowKey: one.name, columnId: one.locationId, at: del.anchor };
          const undo =
            undoId && del.undoable ? () => void undoWrite(undoId, undefined, text, at) : null;
          setUndo(undo);
          setRowToast({
            rowKey: one.name,
            at: del.anchor,
            node: (
              <UndoToast
                undoId={undoId}
                {...text}
                action={undo ? { label: "撤销", onClick: undo } : undefined}
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
          failed.map((e) => cellKey(e.name, e.targetId)),
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
              reading={text.kind === "success" ? <ToastCount n={removed.length} /> : undefined}
              action={undo ? { label: "撤销", onClick: undo } : undefined}
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

  /// 点一格：○＝写进（同域单格直接写），⦿＝确认后从这个 agent 的配置里删掉
  const onCell = (p: McpDomain, rowKey: string, targetId: string) => {
    const row = p.rows.find((r) => rowKeyOf(r) === rowKey);
    const target = p.targets.find((t) => t.id === targetId);
    if (!row || !target) return;
    const view = cellViewOf(row, target.id, labelOf);
    if (view === null) return;
    // 位置无效（整份配置读不出来）：点格＝在访达中显示那个配置文件，交给用户自己去看
    if (view.issue === "invalidLocation") {
      void reveal(target.path);
      return;
    }
    if (!view.clickable) return;
    setCellNotice(null);
    // ⦿：先确认，再从这个 agent 的配置里删掉（是不是这一行的来源都一样）
    if (view.dot === "own") {
      askDeleteOriginal(p, row, target);
      return;
    }
    const source = sourceForMissingTarget(row, target.id);
    if (source === null) {
      const choices = pickChoices(row, target.id);
      const trigger = cellElement(p, rowKey, target.id);
      if (choices.length < 2 || trigger === null) {
        // 走不到挑选（按理不会）：不替用户挑，格下说清为什么没写
        failCell(row.name, target.id, ambiguousText(row.name));
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
  const cellElement = (p: McpDomain, rowKey: string, targetId: string): HTMLElement | null => {
    const column = p.targets.findIndex((t) => t.id === targetId);
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

  // ===== 渲染 =====

  /// 这个位置订阅了来源才有 `管理来源`（一个都没订阅时不出：空态已有 `+ 来源`）
  const subscribed = (sources.data?.rows.length ?? 0) > 0;
  const openManage = subscribed
    ? () => {
        setManageFlash([]);
        setManageOpen(true);
      }
    : undefined;
  const sourceKeys = <SourceKeys onManage={openManage} onAdd={openAdd} />;
  /// 页面头右端：筛选框 + `管理来源` + `+ 来源`（表格还没有时也照常放，切页签、扫描完时页面头不跳）
  const headActions = (
    <LocationActions
      filterText={filterText}
      onFilterText={setFilterText}
      actions={sourceKeys}
      enabled={!addOpen && !manageOpen}
    />
  );
  /// 来源管理页（二级页，同添加来源页的骨架）：来源的路径、规则、移除都在这里
  const managePage = manageOpen ? (
    <SourcesPage
      sources={sources}
      domain="mcp"
      placeName={domainRef.label}
      onClose={closeManage}
      onAdd={addFromManagePage}
      flashIds={manageFlash}
    />
  ) : null;
  /// 添加来源页：在机面里推入（侧栏留着）；加好后重扫，滑回；全加上时列表筛到新来源 + 那几片下一窗
  const addPage = addOpen ? (
    <AddSourcePage
      model={model}
      domain={domainRef}
      onClose={closeAdd}
      onAdded={refresh}
      onAllAdded={setJustAdded}
    />
  ) : null;

  if (!overview)
    return (
      <>
        {headActions}
        <Empty kind="scanning" description="正在读 MCP 配置" art="scanning" />
      </>
    );

  if (overview.locations.length === 0) {
    return (
      <>
        {headActions}
        <Empty
          kind="noAgentDirs"
          description="没找到 Claude Code、Codex 或 Cursor 的 MCP 配置文件"
          hint="只看文件里的配置；Claude.ai 的连接器和内置 MCP 不在其中"
          art="noDirs"
        />
      </>
    );
  }

  // 侧栏是 Skills 与 MCP 的并集：选中的项目在 MCP 这边可能一个配置位置都没有（没开能写 MCP 的 agent）
  if (page === null) {
    return (
      <>
        {headActions}
        <Empty
          kind="noAgentDirs"
          description={
            selectedKey === "global"
              ? "这个位置下还没有可用的 MCP 配置位置"
              : "这个项目里还没有 MCP"
          }
          hint="装了并显示 Claude Code、Codex 或 Cursor，这里才有能写 MCP 的位置"
          art="noDirs"
        />
        {sources.host}
        {managePage}
        {addPage}
      </>
    );
  }

  const targetIds = new Set(page.targets.map((t) => t.id));
  const names = columnNames(page.targets);
  const heads = columnHeads(page.targets);
  const query = filterText.trim().toLowerCase();
  // 来源筛选＝有行的来源 + 已订阅但一个服务都没有的来源（选中它，空态里有 `在访达中显示 ↗`）
  const rowOrigins = page.rows.flatMap((row) => row.entries.map((e) => e.sourceId));
  const subscribedEmpty = (sources.data?.rows ?? []).filter((r) => !rowOrigins.includes(r.id));
  const activeOrigins = liveOrigins(originFilter, [
    ...rowOrigins,
    ...subscribedEmpty.map((r) => r.id),
  ]);
  const visible = page.rows.filter(
    (row) =>
      (query === "" || row.name.toLowerCase().includes(query)) &&
      originMatches(
        activeOrigins,
        row.entries.map((e) => e.sourceId),
      ),
  );
  // 每个来源在这里有几行（一行几份定义各算一次）：来源筛选的顺序、空态判断用
  const sourceCounts = new Map<string, number>();
  for (const row of page.rows) {
    for (const id of new Set(row.entries.map((e) => e.sourceId))) {
      sourceCounts.set(id, (sourceCounts.get(id) ?? 0) + 1);
    }
  }

  /// 格此刻画成什么：乐观更新的画成点下去之后的样子（写进 ⦿、删除空心），落定前不再可点。
  /// WeiboAP 里的定义不在格子上删
  const viewAt = (row: McpDomainRow, targetId: string) => {
    const view = cellViewOf(row, targetId, labelOf);
    if (view === null) return null;
    const dot = optimistic.get(cellKey(rowKeyOf(row), targetId));
    if (dot !== undefined) return { ...view, dot, clickable: false, reason: undefined };
    if (view.dot === "own" && locationOf(targetId)?.harnessId === "weiboap")
      return { ...view, clickable: false, reason: WEIBO_REMOVE };
    return view;
  };

  // ---- 列：第三层是这个位置下能用的条数 ----
  // 第三层与 `名称 N` 同一范围：随当前筛选（DESIGN「计数口径」）
  const columns = page.targets.map((target) => {
    const n = visible.filter((row) => viewAt(row, target.id)?.dot === "own").length;
    const head = heads.get(target.id) ?? { name: target.label };
    return {
      id: target.id,
      agentId: target.harnessId,
      name: head.name,
      scope: head.scope,
      count: n,
      tip: `${target.label} · ${n} 个已加上`,
    };
  });

  /// 这一空格上有几份不一样的同名定义可挑（能直接定下来源的记 1）
  const choiceCount = (row: McpDomainRow, targetId: string) =>
    sourceForMissingTarget(row, targetId) === null ? pickChoices(row, targetId).length : 1;

  // ---- 行 ----
  const rows: MatrixRowView[] = visible.map((row) => {
    const key = rowKeyOf(row);
    const cells: Record<string, MatrixCellView | null> = {};
    const unsupportedAt: string[] = [];
    const unsupportedWhy = new Set<string>();
    for (const target of page.targets) {
      const view = viewAt(row, target.id);
      if (view === null) {
        cells[target.id] = null;
        continue;
      }
      if (view.dot === "blocked") {
        unsupportedAt.push(names.get(target.id) ?? target.label);
        if (view.reason) unsupportedWhy.add(view.reason);
      }
      // 位置无效：原因 + 点一下在访达中显示那个配置文件
      const invalid = view.issue === "invalidLocation";
      cells[target.id] = {
        dot: view.dot,
        clickable: view.clickable || invalid,
        tip: invalid
          ? `${view.reason ?? ""} · 点一下在访达中显示`
          : view.clickable
            ? view.dot === "own"
              ? // 省略号只在会确认时写：删的是这个位置里最后一份
                `从 ${names.get(target.id) ?? target.label} 删除${othersHolding(page, [row.name], new Set([target.id])).length > 0 ? "" : "…"}`
              : choiceCount(row, target.id) > 1
                ? pickTip(row.name, choiceCount(row, target.id))
                : "点一下写进"
            : (view.reason ?? ""),
        pending: pendingCells.has(cellKey(key, target.id)),
      };
    }
    const differing = differingSourceIds(row, targetIds);
    const fields = differingFields(row, targetIds);
    const transports = [
      ...new Set(row.entries.map(transportText).filter((t): t is string => t !== null)),
    ];
    const originId = mcpGroupOf(row);
    const originPath = locationOf(originId)?.path ?? originId;
    return {
      key,
      name: row.name,
      // 来源：定义住在哪个配置文件；悬停出完整路径与打开 ↗
      origin: {
        id: originId,
        label: groupLabel(locationOf(originId), originId),
        path: originPath,
        onReveal: () => void reveal(originPath),
      },
      cells,
      // 差异是行级事实，不进格：名字后的纯文字记号 `2 份不一样`（12 ink-mute，不是键），提示框给差异字段名；
      // 点它拉开这一行的抽屉，字段级差异是抽屉里的一段。
      // 某列不支持只说明：同样是纯弱标识 + 提示框（原因同那一格：`Cursor 不支持用命令生成请求头`）
      mark:
        differing.length > 0 ? (
          <span
            onMouseEnter={() => loadDiff(row.name, differing)}
            onFocus={() => loadDiff(row.name, differing)}
          >
            <Tag tone="weak" tip={diffTip(row.name, fields)}>
              {`${differing.length} 份不一样`}
            </Tag>
          </span>
        ) : unsupportedAt.length > 0 ? (
          <Tag
            tone="weak"
            tip={
              unsupportedWhy.size > 0
                ? [...unsupportedWhy].join("；")
                : `${unsupportedAt.join("、")} 不支持 ${row.name} 的写法`
            }
          >
            {/* 一列写 agent 名（`Codex 不支持`）；几列时只写处数，名字与原因在提示框里——
                158 宽的名称列放不下一串名字，截掉的会是「不支持」本身 */}
            {unsupportedAt.length === 1
              ? `${unsupportedAt[0]} 不支持`
              : `${unsupportedAt.length} 处不支持`}
          </Tag>
        ) : undefined,
      // 点服务名 / 记号 / 拉手拉开抽屉：传输（D7：服务的属性，不回答「能不能在这个 agent 用」）、命令或地址、
      // 原件 + 打开 ↗；几份不一样时末尾一段字段级差异（拉开时比对一次，要并排几份值，抽屉铺到最后一列）。
      // 表格一次只开一格，差异不再另开一格抽屉
      detail: (
        <>
          <div className="mx-kv">
            <span className="mx-kv__key">传输</span>
            <span className="mx-kv__value">{transports.join(" / ") || "不支持的写法"}</span>
            <McpEndpointRow name={row.name} locationId={originId} load={api.mcpEndpoint} />
            <span className="mx-kv__key">原件</span>
            <span className="mx-kv__value">
              <span className="mx-mono ss-selectable">{displayPath(originPath)}</span>
              <RevealLink path={originPath} onReveal={() => void reveal(originPath)} />
            </span>
          </div>
          {differing.length > 0 ? (
            <McpDiffSection
              name={row.name}
              locationIds={differing}
              load={api.mcpFieldDiff}
              labelOf={labelOf}
              revealPath={locationOf(differing[0])?.path}
              onReveal={(path) => void reveal(path)}
            />
          ) : null}
        </>
      ),
      detailWide: differing.length > 0,
      // 右键菜单：在访达中显示原件（＝`打开 ↗`）、拷贝路径（＝展开区里可选中的路径）
      menu: () => [
        { label: "在访达中显示原件", run: () => void reveal(originPath) },
        { label: "拷贝路径", run: () => copyPath(originPath) },
      ],
      selectDisabledReason: blockedOf(page, row),
    };
  });

  // ---- 选择态 ----
  const chosen = visible.filter((row) => selected.has(rowKeyOf(row)));
  const missingAt = (targetId: string): McpSelection[] =>
    chosen.flatMap((row) => {
      const view = viewAt(row, targetId);
      const source = sourceForMissingTarget(row, targetId);
      // ⦿ 可点是删除，不是写进：不算缺的
      return view?.clickable === true && view.dot !== "own" && source !== null
        ? [{ sourceId: source.sourceId, name: row.name, targetId }]
        : [];
    });
  /// 选中的行里这一列上能删的定义（WeiboAP 里的、正在落定的都不算）
  const deletableAt = (targetId: string): McpRemoveItem[] =>
    chosen.flatMap((row) =>
      viewAt(row, targetId)?.dot === "own" && viewAt(row, targetId)?.clickable === true
        ? [{ locationId: targetId, name: row.name }]
        : [],
    );
  // 选择态：工具行里每个位置一项「⦿ / ○ 名字」（DESIGN「MCP 格子只有两种」选择行）：
  // 点 ○ 写进缺的，点 ⦿（选中的都有了）确认一次、从那个 agent 删掉。写不过去、删不了的格不计入
  const columnChecks: Record<string, ColumnCheck> = {};
  const enabledPresses: { add: McpSelection[]; remove: McpRemoveItem[]; checked: boolean }[] = [];
  for (const target of page.targets) {
    const cells = missingAt(target.id);
    const deletable = deletableAt(target.id);
    const present = chosen
      .filter((row) => viewAt(row, target.id)?.dot === "own")
      .map((r) => r.name);
    // 还没有、又写不过去的；已经有了、却删不了的（WeiboAP 里的）
    const cant = chosen
      .filter((row) => {
        const v = viewAt(row, target.id);
        return v !== null && v.dot !== "own" && !cells.some((c) => c.name === row.name);
      })
      .map((r) => r.name);
    const stuck = present.filter((name) => !deletable.some((d) => d.name === name));
    const checked = cells.length === 0 && present.length > 0;
    const notes = [
      checked
        ? { names: stuck, why: `无法从 ${target.label} 删除` }
        : { names: cant, why: `无法写进 ${target.label}` },
    ];
    const disabledReason =
      (checked ? deletable.length : cells.length) > 0
        ? undefined
        : checked
          ? `都已写进，但无法从 ${target.label} 删除`
          : `这几个都无法写进 ${target.label}`;
    if (disabledReason === undefined)
      enabledPresses.push({ add: cells, remove: deletable, checked });
    columnChecks[target.id] = {
      checked,
      label: checked ? `选中的都从 ${target.label} 删除` : `选中的都写进 ${target.label}`,
      tip: checked
        ? affectedTip(
            `从 ${target.label} 删除`,
            deletable.map((d) => d.name),
            notes,
          )
        : affectedTip(
            `写进 ${target.label}`,
            cells.map((c) => c.name),
            notes,
          ),
      disabledReason,
      onToggle: () =>
        void (checked
          ? askDeleteBatch(page, deletable, target.id)
          : // 选中的里这一列原本就有能删的时，再按会连原有的一起删掉：只有撤销是准确的退路
            write(cells, target.id, deletable.length === 0)),
    };
  }
  // 「所有位置」：每个能改的位置都全有才打勾；点空框全部写进，点打勾确认一次、全部删掉
  const allChecked = enabledPresses.length > 0 && enabledPresses.every((p) => p.checked);
  const allAdd = enabledPresses.flatMap((p) => p.add);
  const allRemove = enabledPresses.flatMap((p) => p.remove);
  const uniqNames = (cells: { name: string }[]) => [...new Set(cells.map((c) => c.name))];
  const allAgents: ColumnCheck = {
    checked: allChecked,
    label: allChecked ? "选中的都从所有位置删除" : "选中的都写进所有位置",
    tip: allChecked
      ? affectedTip("从所有位置删除", uniqNames(allRemove), [], allRemove.length)
      : affectedTip("写进所有还缺它的位置", uniqNames(allAdd), [], allAdd.length),
    disabledReason: enabledPresses.length === 0 ? "没有能写进或删除的" : undefined,
    onToggle: () =>
      void (allChecked
        ? askDeleteBatch(page, allRemove, "all")
        : write(allAdd, "all", allRemove.length === 0)),
  };

  // 空态（DESIGN「位置页 › 空态」）：`+ 来源` 已在页面头，空态里不重复，只说现状
  const onlySource = activeOrigins.length === 1 ? activeOrigins[0] : null;
  const empty =
    query !== "" ? (
      <TableEmpty
        text={`没有名字里带「${filterText.trim()}」的服务`}
        action={{
          label: "清除筛选",
          compact: true,
          onClick: () => {
            setFilterText("");
            setOriginFilter([]);
          },
        }}
      />
    ) : onlySource !== null && !sourceCounts.has(onlySource) ? (
      // 只选了这一个来源、它里面一个服务都没有：往这份配置里放的入口就在这里（`在访达中显示 ↗`，浅键）
      <TableEmpty
        text={`${groupLabel(locationOf(onlySource), onlySource)} 里还没有 MCP`}
        art="emptyFolder"
        action={(() => {
          const path = locationOf(onlySource)?.path ?? sources.rowOf(onlySource)?.path;
          return path
            ? { label: "在访达中显示", leave: true, onClick: () => void reveal(path) }
            : undefined;
        })()}
      />
    ) : page.targets.some((target) => target.harnessId === "weiboap") ? (
      <TableEmpty text="这里没有能复制的完整定义，从别处添加一份过来" art="emptyFolder" />
    ) : (
      <TableEmpty
        text={
          page.key === "global" ? `${page.label} 还没有自己的 MCP 配置` : "这个项目里还没有 MCP"
        }
        art="emptyFolder"
      />
    );

  /// 来源项的右键菜单（D18）：管理来源（＝页面头的 `管理来源`）· 在访达中显示（＝来源管理页那一行的
  /// `打开 ↗`）· 移除来源…（＝那一行的 `×`，来源自己那一处没有这一项）
  const chipMenu = (id: string, chip: HTMLElement): ContextMenuItem[] => {
    const row = sources.rowOf(id);
    const path = row?.path ?? locationOf(id)?.path;
    return [
      ...(openManage ? [{ label: MANAGE_SOURCES, run: openManage }] : []),
      ...(path ? [{ label: "在访达中显示", run: () => void reveal(path) }] : []),
      "separator",
      ...(row && !row.own
        ? [{ label: "移除来源…", run: () => void sources.askRemove(row, chip, chip, "start") }]
        : []),
    ];
  };
  const chip = (id: string): SourceChipItem => ({
    id,
    label: groupLabel(locationOf(id), id),
    count: sourceCounts.get(id) ?? 0,
    path: locationOf(id)?.path ?? sources.rowOf(id)?.path,
    menu: (el) => chipMenu(id, el),
  });

  // 写进 WeiboAP 的那几处要额外说一句：它只收下定义，启用是它自己的事
  const paneHasWeibo =
    pane !== null &&
    pane.preview.actions.some((action) => locationOf(action.targetId)?.harnessId === "weiboap");

  // 带撤销的提示小窗读 UndoBusy（按下的 `撤销` 原位忙碌）
  const content = (
    <section className="mx-page mcp-tab">
      <Matrix
        columns={columns}
        originLabel="来源"
        sources={{
          selected: activeOrigins,
          onSelect: setOriginFilter,
          items: [...sourceCounts.keys(), ...subscribedEmpty.map((r) => r.id)].map(chip),
        }}
        rows={rows}
        nameLabel="名称"
        nameTip="⦿ 是这个 agent 的配置里有这一项，点它删掉（先确认、可撤销）。agent 自带的和插件带的 MCP 不在这里"
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
        onCell={(rowKey, columnId) => onCell(page, rowKey, columnId)}
        shortcuts={!addOpen && !manageOpen && pane === null && deletePane === null && pick === null}
        empty={empty}
        flash={flash}
        cellNotice={cellNotice}
        onDismissCellNotice={dismissNotice}
        keyToast={keyToast}
        cellToast={cellToast}
        rowToast={rowToast}
        keyBusy={keyBusy}
        barToast={
          addedToast
            ? {
                id: addedToast.key,
                node: (
                  <AddedToast
                    key={addedToast.key}
                    parts={addedToast.parts}
                    onDismiss={dismissAdded}
                  />
                ),
                origins: addedToast.origins,
              }
            : null
        }
      />
      {globalToast ? <CornerToast>{globalToast}</CornerToast> : null}

      {/* 批量与跨域的那一道确认，锚在触发它的键 / 格下面。跳过的项目留在这里——它是做决定所需的信息 */}
      {pane !== null && (
        <Confirm
          title={`写进 ${new Set(pane.preview.actions.map((a) => a.targetId)).size} 个位置？`}
          safetyNote={
            pane.crossDomain
              ? "有几处要写到另一个位置去：完整定义里可能带着请求头或令牌，会一并复制过去"
              : "已经存在的同名配置不会被覆盖；写进已有文件前会先备份"
          }
          confirmLabel="写进去"
          onConfirm={() => void apply(pane.preview, pane.crossDomain, pane.keyId, pane.reversible)}
          onCancel={() => setPane(null)}
        >
          <ul className="mcp-confirm-list">
            {pane.preview.actions.slice(0, 12).map((action) => (
              <li key={`${action.sourceId}|${action.targetId}|${action.name}`}>
                {action.name} → {labelOf(action.targetId)}
              </li>
            ))}
            {pane.preview.actions.length > 12 && (
              <li className="mcp-confirm-more">还有 {pane.preview.actions.length - 12} 处</li>
            )}
          </ul>
          {paneHasWeibo && (
            <div className="mcp-confirm-note">
              写进 WeiboAP 的只是定义，还要在它里面启用；已经开着的会话可能要重开。
            </div>
          )}
          {pane.preview.issues.map((issue, i) => (
            <div key={`${issue.locationId}|${issue.name ?? ""}|${i}`} className="mcp-confirm-note">
              跳过 {issue.name ?? labelOf(issue.locationId)}：{issue.message}
            </div>
          ))}
        </Confirm>
      )}

      {deletePane !== null && (
        <Confirm
          title={deletePane.text.title}
          confirmLabel="删除"
          onConfirm={() => void deleteOriginal(deletePane)}
          onCancel={() => setDeletePane(null)}
        >
          <div className="mx-keeppaths__body">{deletePane.text.body}</div>
        </Confirm>
      )}

      {pick !== null && (
        <McpPickLayer
          pick={pick}
          labelOf={(id) => groupLabel(locationOf(id), id)}
          onPick={choose}
          onClose={closePick}
        />
      )}

      {sources.host}
      {managePage}
      {addPage}
    </section>
  );
  return <UndoBusy.Provider value={undoBusy}>{content}</UndoBusy.Provider>;
}
