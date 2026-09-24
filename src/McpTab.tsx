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
  type MatrixCellView,
  type MatrixRowView,
  type ColumnCheck,
  type SourceChipItem,
} from "./Matrix";
import { affectedTip, Empty as TableEmpty } from "./DomainView";
import { AddedToast, AddSourcePage } from "./pages/AddSourcePage";
import { ManageSourcesKey, SourceListView, SourceRowView, useSources } from "./SourceRow";
import type { ContextMenuItem } from "./contextMenu";
import { usePageCommand } from "./shell/menuBus";
import { addedParts, type CandidateEntry } from "./pages/addSourceView";
import { mcpSourcesModel } from "./pages/sourcesModel";
import { addedOrigins, liveOrigins, originMatches } from "./originFilter";
import { MANAGE_SOURCES, mcpLocationName, sourceSlot, type DomainRef } from "./pages/sourcesView";
import { McpPickLayer, type McpPick } from "./McpPickLayer";
import { displayPath } from "./pathText";
import {
  cellViewOf,
  differingFields,
  differingSourceIds,
  mcpDomains,
  mcpGroupOf,
  mcpUndoShown,
  pickChoices,
  pickTip,
  sourceForMissing,
  sourceForMissingTarget,
  type McpDomain,
  type McpDomainRow,
} from "./mcpView";
import { AddButton, Confirm, CornerToast, Empty, Tag, Toast, ToastCount, Tooltip } from "./ui";
import { McpDiffPanel, McpEndpointRow, type McpDiffState } from "./McpDiffPanel";
import type { ConfirmAnchor, ToastProps } from "./ui";
import { batchBusyText, toastFor, type ToastItem, type ToastText } from "./toastText";
import { MCP_OWN_TIP } from "./cellTip";
import type { Dot } from "./cellState";
import type {
  McpUndoReport,
  McpEntry,
  McpLocation,
  McpOverview,
  McpPreview,
  McpReport,
  McpSelection,
} from "./types";
import "./McpTab.css";

/// MCP 页。**和 Skills 页是同一张表**（共享 `Matrix`），只是内容不同：
/// 行是 MCP 服务，列是配置位置，格是同一套状态点。
///
/// MCP 特有的差异：
/// 1. **格同样是开关，但只有副本能拿掉**——点空心写进一份，点实心（副本）从那个位置移除；
///    本行来源那一列是原件，不能在格子上移除（DESIGN「MCP 格子同样是开关：能写进，也能移除」）。
///    选择条上的键同 skill：未全有＝写进缺的，全有（打勾）＝全部移除
/// 2. **实心不是一条链接，是一份独立副本**——写进、移除都经 core 留快照：没人改过就能撤销，
///    改过了撤销禁用，改给「在访达中显示备份 ↗」作手动兜底。撤销按钮只在再点一次不能准确撤回时给
///    （`mcpUndoShown`）：移除了一份与原版不一样的副本、批量写进时选中的里原本已有一部分；`⌘Z` 始终可用
/// 3. **差异是行级、不是格级**——`2 份不一样` 挂在服务名后（安静键，提示框给差异字段名，D21）；
///    点它这一行就地展开不同的字段，再点收起。传输方式是服务的属性，在点服务名展开的行详情里（D7）
/// 4. **批量或跨域写入要确认一道**（跨域会把请求头和令牌一并复制过去）；同域单格写入、移除都不确认

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

/// WeiboAP 里的副本不在格子上移除（core 同样拒绝）
const WEIBO_REMOVE = "WeiboAP 里的配置要到 WeiboAP 里删";

/// 待确认的一次写入：批量与跨域确认，同域单格不确认
interface Pane {
  preview: McpPreview;
  crossDomain: boolean;
  anchor?: ConfirmAnchor;
  keyId?: string;
  /// 写完再按一次同一个键恰好撤回（见 `mcpUndoShown`）
  reversible: boolean;
}

/// 正在撤销的那一次（undoId）：带撤销的那一窗读它，按下的 `撤销` 原位忙碌
/// （过了 0.3 秒门槛才换成转圈 + 一句）。提示小窗在状态里存的是元素，靠 context 才看得到后来的变化
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
  // 按来源筛选（工具行第二行的来源片）；空＝全部。点片单选，加完来源时一次选中新加的几片
  const [originFilter, setOriginFilter] = useState<string[]>([]);
  // 添加来源页（页面头的 `+ 来源`、菜单「添加来源…」）开着没有
  const [addOpen, setAddOpen] = useState(false);
  const closeAdd = useCallback(() => setAddOpen(false), []);
  usePageCommand("add-source", () => setAddOpen(true));
  const [pane, setPane] = useState<Pane | null>(null);
  // 同名多份的空格：点它出的挑选浮层（锚在那一格上）
  const [pick, setPick] = useState<McpPick | null>(null);
  // 乐观更新：格键 → 点下去之后该画成的圆点（写进＝实心、移除＝空心）；重扫回来后撤掉
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
  const [globalToast, setGlobalToast] = useState<ReactNode>(null);
  // 加完来源、开始滑回主视图：加上的那几个（等这一轮渲染拿到重扫后的页再筛）；新来源片下的那一窗
  const [justAdded, setJustAdded] = useState<CandidateEntry[] | null>(null);
  const [addedToast, setAddedToast] = useState<{
    key: number;
    parts: string[];
    origins: string[];
  } | null>(null);
  // `2 份不一样` 的字段级差异：悬停时懒加载一次（api.mcpFieldDiff）；null＝读不到，退回「配置不一样」
  const [diffs, setDiffs] = useState<Map<string, string[] | null>>(new Map());
  const diffAsked = useRef<Set<string>>(new Set());
  // 点开了 `2 份不一样` 的那几行（服务名 → 比对结果）：就地展开字段级差异，再点收起
  const [openDiffs, setOpenDiffs] = useState<Map<string, McpDiffState>>(new Map());
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

  // 提示与弹层只属于当次选择；换一个位置时勾选与来源筛选清空
  useEffect(() => {
    setPane(null);
    setPick(null);
    setKeyToast(null);
    setCellToast(null);
    setCellNotice(null);
    setAddedToast(null);
    // 默认一行不选；换一个位置时清空，不把别处的勾选带过来
    setSelected(new Set());
    setOriginFilter([]);
    setUndo(null);
  }, [selectedKey]);

  const page: McpDomain | null = domains.find((d) => d.key === selectedKey) ?? null;

  // ---- 这个位置订阅的 MCP 来源：片首橙点、来源行（规则 + 移除）、添加来源页的候选 ----
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
    // 移除之后筛选回到 `全部`
    onRemoved: () => setOriginFilter([]),
    keys: !addOpen && pane === null && pick === null,
  });

  // 加完来源滑回主视图（同 Skills）：重扫已完，列表筛到新来源——它们的片选中（几个选几片，
  // 列表是并集），这几片正下方浮起 `✓ 已添加 … · 已筛选出它的 N 个 MCP`（说清楚列表为什么变少了）
  useEffect(() => {
    if (justAdded === null || !overview) return;
    setJustAdded(null);
    if (!page) return;
    const ids = addedOrigins(
      justAdded.map((e) => e.id),
      page.rows.flatMap((r) => r.entries.map((e) => e.sourceId)),
    );
    let parts: string[];
    if (ids.length > 0) {
      // 名字与片同一个写法（groupLabel）；数量＝列表里并集的行数
      parts = addedParts(
        ids.map((id) =>
          groupLabel(
            overview.locations.find((l) => l.id === id),
            id,
          ),
        ),
        page.rows.filter((r) =>
          originMatches(
            ids,
            r.entries.map((e) => e.sourceId),
          ),
        ).length,
        "MCP",
        true,
      );
      setFilterText("");
      setOriginFilter(ids);
    } else {
      // 新来源在这个位置下一行都没有：没有片可选，只交代加上了
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

  /// 点 `2 份不一样`：展开就懒取一次字段级差异，已展开就收起
  const toggleDiff = (name: string, locationIds: string[]) => {
    if (openDiffs.has(name)) {
      setOpenDiffs((prev) => {
        const next = new Map(prev);
        next.delete(name);
        return next;
      });
      return;
    }
    setOpenDiffs((prev) => new Map(prev).set(name, "loading"));
    // 取回来时这一行已经收起了就不再展开
    const settle = (value: McpDiffState) =>
      setOpenDiffs((prev) => (prev.has(name) ? new Map(prev).set(name, value) : prev));
    api.mcpFieldDiff(name, locationIds).then(
      (diff) => settle(diff),
      (e) => settle(new Error(String(e))),
    );
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
    // 有能移除的副本也能勾（选择条上打勾的键＝全部移除）
    if (p.targets.some((t) => t.harnessId !== "weiboap" && cellViewOf(row, t.id, labelOf)?.copy))
      return undefined;
    const targetIds = new Set(p.targets.map((target) => target.id));
    const anyMissing = row.entries.some((entry) =>
      entry.cells.some((cell) => targetIds.has(cell.targetId) && cell.state === "missing"),
    );
    if (!anyMissing) return `${row.name} 在这里没有能写进或移除的位置`;
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
  /// 写入排在前面的写入之后。`reversible`：写完再按一次同一个键恰好撤回（单格一律是）
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
    setOptimisticFor(keys, "linked");
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
      // 单格：那一格的键、行键与列（撤销后闪那一格；撤不了时说明出在那一格下）
      const one =
        single && created.length > 0
          ? { keys, rowKey: created[0].name, columnId: created[0].targetId }
          : undefined;
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
              // 写数量（`✓ 写进 ⎔ 2 个`），名字在键的提示框里
              names={text.kind === "success" ? undefined : text.names}
              reading={text.kind === "success" ? <ToastCount n={created.length} /> : undefined}
              // 再按一次同一个键就恰好撤回时不给 `撤销`（⌘Z 照旧可用）
              action={
                undo && mcpUndoShown("write", result.entries, reversible)
                  ? { label: "撤销", onClick: undo }
                  : undefined
              }
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
        // 不带撤销：再点那一格就是移除刚写的那一份（⌘Z 照旧可用）
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

  /// 从格子上移除副本（单格或按键）。不确认（⑪ 能撤销就不打断）：格子先画成空心，
  /// 单格闪一下；没移除的弹回，原因出在那一格 / 那颗键下。与写进排同一个队
  const removeCopies = (selections: McpSelection[], keyId?: string) => {
    if (selections.length === 0) return Promise.resolve();
    const keys = selections.map((sel) => cellKey(sel.name, sel.targetId));
    const single = keyId === undefined;
    setCellNotice(null);
    if (!single) setCellToast(null);
    setOptimisticFor(keys, "missing");
    if (single) setFlash({ keys, nonce: Date.now() });
    if (keyId) setKeyBusy({ keyId, label: batchBusyText("unlink", keyAgent(keyId)) });
    return enqueue(() => removeWrite(selections, keys, keyId));
  };

  const removeWrite = async (
    selections: McpSelection[],
    keys: string[],
    keyId: string | undefined,
  ) => {
    const single = keyId === undefined;
    onBusy(true);
    let result: McpReport | null = null;
    try {
      result = await api.removeMcpCopies(selections);
    } catch (error) {
      setOptimisticFor(keys, null);
      if (single) failCell(selections[0].name, selections[0].targetId, String(error));
      else onError(String(error));
    } finally {
      onBusy(false);
      setKeyBusy((prev) => (prev?.keyId === keyId ? null : prev));
    }
    if (result !== null) {
      const removed = result.entries.filter((e) => e.outcome === "removed");
      // 原件格、单独拿不掉的写法等以 skipped + 原因回来：和失败一样弹回、说原因
      const failed = result.entries.filter((e) => e.outcome !== "removed");
      setOptimisticFor(
        failed.map((e) => cellKey(e.name, e.targetId)),
        null,
      );
      const text = toastFor("unlink", {
        done: itemsOf(removed),
        failed: itemsOf(failed).map((item, i) => ({ ...item, reason: failed[i].message })),
      });
      const undoId = result.undoId;
      const one =
        single && removed.length > 0
          ? { keys, rowKey: removed[0].name, columnId: removed[0].targetId }
          : undefined;
      // 单格：`✓ 从 [Codex] 移除`（这一行已说明对象，不重复服务名）
      const rowText = one ? toastFor("unlink", { done: itemsOf(removed), omitNames: true }) : text;
      const undo =
        undoId && removed.length > 0 ? () => void undoWrite(undoId, keyId, rowText, one) : null;
      setUndo(undo);
      // 只有移除了一份与原版不一样的副本才给 `撤销`：再点只能写回原版（⌘Z 照旧可用）
      const action =
        undo && mcpUndoShown("remove", result.entries, true)
          ? { label: "撤销", onClick: undo }
          : undefined;
      if (keyId !== undefined) {
        setKeyToast({
          keyId,
          node: (
            <UndoToast
              undoId={undoId}
              {...text}
              names={text.kind === "success" ? undefined : text.names}
              reading={text.kind === "success" ? <ToastCount n={removed.length} /> : undefined}
              action={action}
              onDismiss={dismissKey}
              onClose={text.tier === "notice" ? dismissKey : undefined}
            />
          ),
        });
      } else if (one === undefined) {
        const f = failed[0];
        failCell(
          f?.name ?? selections[0].name,
          f?.targetId ?? selections[0].targetId,
          f?.message ?? "没移除",
        );
      } else {
        setCellToast({
          id: ++cellToastSeq.current,
          rowKey: one.rowKey,
          columnId: one.columnId,
          node: <UndoToast undoId={undoId} {...rowText} action={action} onDismiss={dismissCell} />,
        });
      }
    }
    await refresh();
    setOptimisticFor(keys, null);
  };

  /// 撤销一次写入：core 只在文件仍等于写入后的样子时才从快照还原。改过了就撤不了——
  /// 撤销禁用、提示框说原因，另给「在访达中显示备份 ↗」作手动兜底（DESIGN「MCP 写入的撤销」）
  /// `one`：单格写入的撤销（那一格的键、行键与列）——撤成了那一窗直接消失、格子回原状并闪一下；
  /// 撤不了时说明也出在那一格下
  const undoWrite = async (
    undoId: string,
    keyId: string | undefined,
    text: ToastText,
    one?: { keys: string[]; rowKey: string; columnId: string },
  ) => {
    const single = one !== undefined;
    setUndo(null);
    // 按下的 `撤销` 原位忙碌（过了 0.3 秒门槛才出转圈 + 一句）；⌘Z 撤的也一样
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
      setGlobalToast(null);
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
          onDismiss={single ? dismissCell : keyId !== undefined ? dismissKey : dismissGlobal}
        />
      );
      if (keyId !== undefined) setKeyToast({ keyId, node });
      else if (one)
        setCellToast({
          id: ++cellToastSeq.current,
          rowKey: one.rowKey,
          columnId: one.columnId,
          node,
        });
      else setGlobalToast(node);
      return;
    }
    // 没撤成：在撤销的入口那里说（那颗键下 / 那一格下），没有入口的才去右下
    if (one) {
      failCell(one.rowKey, one.columnId, `没撤销：${report.message}`);
      return;
    }
    const node = (
      <Toast
        kind="cannot"
        verb="没撤销"
        reason={report.message}
        onDismiss={keyId !== undefined ? dismissKey : dismissGlobal}
        onClose={keyId !== undefined ? dismissKey : dismissGlobal}
      />
    );
    if (keyId !== undefined) setKeyToast({ keyId, node });
    else setGlobalToast(node);
  };

  /// 写入这些格。批量或跨域的先确认（锚在触发它的键 / 格下面）。
  /// `reversible`：写完再按一次同一个键恰好撤回（见 `mcpUndoShown`）
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
      if (keyId === undefined && selections.length === 1) {
        const s = selections[0];
        failCell(s.name, s.targetId, reason);
      } else if (keyId !== undefined) {
        // 按键的：浮在那颗键下
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
      } else {
        setGlobalToast(
          <Toast
            kind="cannot"
            verb="没写进"
            reason={reason}
            onDismiss={dismissGlobal}
            onClose={dismissGlobal}
          />,
        );
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

  /// 点一格：空心＝写进（同域单格直接写），实心副本＝移除
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
    // 实心（副本）：从这个位置移除；行的来源是原件（core 同样拒绝原件格）
    if (view.copy) {
      void removeCopies([{ sourceId: mcpGroupOf(row), name: row.name, targetId: target.id }]);
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

  const openAdd = () => setAddOpen(true);
  /// 页面头右端：筛选框 + `+ 来源`（表格还没有时也照常放，切页签、扫描完时页面头不跳）
  const headActions = (
    <LocationActions
      filterText={filterText}
      onFilterText={setFilterText}
      actions={<AddButton noun="来源" onClick={openAdd} />}
      enabled={!addOpen}
    />
  );
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
        {addPage}
      </>
    );
  }

  const targetIds = new Set(page.targets.map((t) => t.id));
  const names = columnNames(page.targets);
  const heads = columnHeads(page.targets);
  const query = filterText.trim().toLowerCase();
  // 来源片＝有行的来源 + 已订阅但一个服务都没有的来源（选中它才找得到它的来源行）
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
  // 来源片：每个位置 · 这里有它的一份定义的行数（一行几份定义各算一次）
  const sourceCounts = new Map<string, number>();
  for (const row of page.rows) {
    for (const id of new Set(row.entries.map((e) => e.sourceId))) {
      sourceCounts.set(id, (sourceCounts.get(id) ?? 0) + 1);
    }
  }

  /// 格此刻画成什么：乐观更新的画成点下去之后的样子（写进实心、移除空心），落定前不再可点。
  /// WeiboAP 里的副本不在格子上移除
  const viewAt = (row: McpDomainRow, targetId: string) => {
    const view = cellViewOf(row, targetId, labelOf);
    if (view === null) return null;
    const dot = optimistic.get(cellKey(rowKeyOf(row), targetId));
    if (dot !== undefined)
      return { ...view, dot, clickable: false, copy: undefined, reason: undefined };
    if (view.copy && locationOf(targetId)?.harnessId === "weiboap")
      return { ...view, clickable: false, reason: WEIBO_REMOVE };
    return view;
  };

  // ---- 列：第三层是这个位置下能用的条数 ----
  // 第三层与 `名称 N` 同一范围：随当前筛选（DESIGN「计数口径」）
  const columns = page.targets.map((target) => {
    const n = visible.filter(
      (row) => viewAt(row, target.id)?.dot === "linked" || viewAt(row, target.id)?.dot === "own",
    ).length;
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
            ? view.copy
              ? `从 ${names.get(target.id) ?? target.label} 移除`
              : choiceCount(row, target.id) > 1
                ? pickTip(row.name, choiceCount(row, target.id))
                : "点一下写进"
            : view.dot === "own" && view.issue === undefined
              ? MCP_OWN_TIP
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
      // 差异是行级事实，不进格：安静键（能点，D21），提示框给差异字段名；点它这一行就地展开字段级差异。
      // 某列不支持只说明、不能点：纯弱标识 + 提示框（原因同那一格：`Cursor 不支持用命令生成请求头`）
      mark:
        differing.length > 0 ? (
          <span
            onMouseEnter={() => loadDiff(row.name, differing)}
            onFocus={() => loadDiff(row.name, differing)}
          >
            <Tooltip content={diffTip(row.name, fields)}>
              <button
                type="button"
                className="ss-btn ss-btn--quiet mcp-difftoggle"
                aria-expanded={openDiffs.has(row.name)}
                onClick={() => toggleDiff(row.name, differing)}
              >
                {`${differing.length} 份不一样`}
              </button>
            </Tooltip>
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
      panel: (() => {
        const diff = differing.length > 0 ? openDiffs.get(row.name) : undefined;
        if (diff === undefined) return undefined;
        const revealPath = locationOf(differing[0])?.path;
        return (
          <McpDiffPanel
            diff={diff}
            labelOf={labelOf}
            revealPath={revealPath}
            onReveal={(path) => void reveal(path)}
          />
        );
      })(),
      // 点服务名就地展开：传输（D7：服务的属性，不回答「能不能在这个 agent 用」）、命令或地址、原件 + 打开 ↗
      detail: (
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
      ),
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
      return view?.clickable === true && view.copy !== true && source !== null
        ? [{ sourceId: source.sourceId, name: row.name, targetId }]
        : [];
    });
  /// 选中的行里这一列上能移除的副本（原件、WeiboAP 里的、正在落定的都不算）
  const copiesAt = (targetId: string): McpSelection[] =>
    chosen.flatMap((row) =>
      viewAt(row, targetId)?.copy === true && viewAt(row, targetId)?.clickable === true
        ? [{ sourceId: mcpGroupOf(row), name: row.name, targetId }]
        : [],
    );
  // 选择态：工具行里每个位置一项「● / ○ 名字」，同 skill（DESIGN「MCP 格子同样是开关」）：
  // 点 ○ 写进缺的，点 ●（选中的都有了）全部移除。原件、写不过去的格不计入
  const columnChecks: Record<string, ColumnCheck> = {};
  const enabledPresses: { add: McpSelection[]; remove: McpSelection[]; checked: boolean }[] = [];
  for (const target of page.targets) {
    const cells = missingAt(target.id);
    const copies = copiesAt(target.id);
    const present = chosen.filter((row) => viewAt(row, target.id)?.dot === "linked").length;
    const own = chosen.filter((row) => viewAt(row, target.id)?.dot === "own").map((r) => r.name);
    // 还没有、又写不过去的；已经有了、却移除不了的（WeiboAP 里的）
    const cant = chosen
      .filter((row) => {
        const v = viewAt(row, target.id);
        return (
          v !== null &&
          v.dot !== "own" &&
          v.dot !== "linked" &&
          !cells.some((c) => c.name === row.name)
        );
      })
      .map((r) => r.name);
    const stuck = chosen
      .filter(
        (row) =>
          viewAt(row, target.id)?.dot === "linked" && !copies.some((c) => c.name === row.name),
      )
      .map((r) => r.name);
    const checked = cells.length === 0 && present > 0;
    const notes = [
      { names: own, why: `原件就在 ${target.label} 里` },
      checked
        ? { names: stuck, why: `无法从 ${target.label} 移除` }
        : { names: cant, why: `无法写进 ${target.label}` },
    ];
    const disabledReason =
      (checked ? copies.length : cells.length) > 0
        ? undefined
        : checked
          ? `都已写进，但无法从 ${target.label} 移除`
          : cant.length > 0
            ? `这几个都无法写进 ${target.label}`
            : "这几个就定义在这里";
    if (disabledReason === undefined) enabledPresses.push({ add: cells, remove: copies, checked });
    columnChecks[target.id] = {
      checked,
      label: checked ? `选中的都从 ${target.label} 移除` : `选中的都写进 ${target.label}`,
      tip: checked
        ? affectedTip(
            `从 ${target.label} 移除`,
            copies.map((c) => c.name),
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
          ? removeCopies(copies, target.id)
          : // 选中的里这一列原本就有副本时，再按会连原有的一起移除：只有撤销是准确的退路
            write(cells, target.id, copies.length === 0)),
    };
  }
  // 「所有位置」：每个能改的位置都全有才打勾；点空框全部写进，点打勾全部移除
  const allChecked = enabledPresses.length > 0 && enabledPresses.every((p) => p.checked);
  const allAdd = enabledPresses.flatMap((p) => p.add);
  const allRemove = enabledPresses.flatMap((p) => p.remove);
  const uniqNames = (cells: McpSelection[]) => [...new Set(cells.map((c) => c.name))];
  const allAgents: ColumnCheck = {
    checked: allChecked,
    label: allChecked ? "选中的都从所有位置移除" : "选中的都写进所有位置",
    tip: allChecked
      ? affectedTip("从所有位置移除", uniqNames(allRemove), [], allRemove.length)
      : affectedTip("写进所有还缺它的位置", uniqNames(allAdd), [], allAdd.length),
    disabledReason: enabledPresses.length === 0 ? "没有能写进或移除的" : undefined,
    onToggle: () =>
      void (allChecked
        ? removeCopies(allRemove, "all")
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
          onClick: () => {
            setFilterText("");
            setOriginFilter([]);
          },
        }}
      />
    ) : onlySource !== null && !sourceCounts.has(onlySource) ? (
      <TableEmpty
        text={`${groupLabel(locationOf(onlySource), onlySource)} 里还没有 MCP`}
        art="emptyFolder"
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

  // 片下那一块（sourceSlot）：`管理来源` 展开着出全部来源；否则恰好选中一个来源片出它的来源行（D3）
  const slot = sourceSlot(
    sources.listOpen,
    (sources.data?.rows ?? []).map((r) => r.id),
    activeOrigins,
  );
  const rowSource = slot?.kind === "row" ? sources.rowOf(slot.id) : undefined;
  const sourceRow =
    slot?.kind === "list" ? (
      <SourceListView
        state={sources}
        model={model}
        domain={domainRef}
        onReveal={(path) => void reveal(path)}
      />
    ) : rowSource ? (
      <SourceRowView
        state={sources}
        row={rowSource}
        model={model}
        domain={domainRef}
        onReveal={(path) => void reveal(path)}
      />
    ) : undefined;
  /// 来源片的右键菜单（D18）：管理来源（＝片后的 `管理来源`，列表已展开时不出）· 在访达中显示
  /// （＝来源行 `打开 ↗`）· 移除来源…（＝来源行 `×`）
  const chipMenu = (id: string, chip: HTMLElement): ContextMenuItem[] => {
    const row = sources.rowOf(id);
    const path = row?.path ?? locationOf(id)?.path;
    return [
      ...((sources.data?.rows.length ?? 0) > 0 && !sources.listOpen
        ? [{ label: MANAGE_SOURCES, run: () => sources.setListOpen(true) }]
        : []),
      ...(path ? [{ label: "在访达中显示", run: () => void reveal(path) }] : []),
      "separator",
      ...(row && !row.own
        ? [{ label: "移除来源…", run: () => void sources.askRemove(row, chip, chip, "start") }]
        : []),
    ];
  };
  const chip = (id: string, count: number): SourceChipItem => ({
    id,
    label: groupLabel(locationOf(id), id),
    path: locationOf(id)?.path,
    count,
    rule: sources.ruleOn(id),
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
          onSelect: (next) => {
            // 点任意一片：收起全部来源，回到「选中一片出这一行」
            sources.setListOpen(false);
            setOriginFilter(next);
          },
          items: [
            ...[...sourceCounts].map(([id, count]) => chip(id, count)),
            ...subscribedEmpty.map((r) => chip(r.id, 0)),
          ],
          tail: <ManageSourcesKey state={sources} />,
        }}
        sourceRow={sourceRow}
        rows={rows}
        nameLabel="名称"
        nameTip="定义住在哪一格由原件环表示"
        nameCount={rows.length}
        dotWords="mcp"
        filterText={filterText}
        onFilterText={setFilterText}
        headActions={<AddButton noun="来源" onClick={openAdd} />}
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
        shortcuts={!addOpen && pane === null && pick === null}
        empty={empty}
        flash={flash}
        cellNotice={cellNotice}
        onDismissCellNotice={dismissNotice}
        keyToast={keyToast}
        cellToast={cellToast}
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
          anchor={pane.anchor}
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

      {pick !== null && (
        <McpPickLayer
          pick={pick}
          labelOf={(id) => groupLabel(locationOf(id), id)}
          onPick={choose}
          onClose={closePick}
        />
      )}

      {sources.host}
      {addPage}
    </section>
  );
  return <UndoBusy.Provider value={undoBusy}>{content}</UndoBusy.Provider>;
}
