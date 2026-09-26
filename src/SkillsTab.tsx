import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import DomainView, { skillCellKey, type BatchPress } from "./DomainView";
import { cellKey, SourceKeys } from "./Matrix";
import { LocationFrame } from "./LocationFrame";
import { NO_PROJECTS, NO_PROJECTS_HINT, usePlacePick } from "./ScopeBar";
import {
  columnOfTarget,
  folderLabel,
  mergeSkillPages,
  refAt,
  refRowKey,
  skillRowKey,
  type PlacedOrphan,
  type SkillRow,
} from "./skillsView";
import { originNames, originText, type OriginName } from "./originName";
import { addedOrigins } from "./originFilter";
import { matchesFilter } from "./rowFilter";
import { AddedToast, AddSourcePage } from "./pages/AddSourcePage";
import { SourcesPage } from "./pages/SourcesPage";
import { addedParts, type CandidateEntry } from "./pages/addSourceView";
import { skillSourcesModel } from "./pages/sourcesModel";
import type { DomainRef } from "./pages/sourcesView";
import { useSources } from "./SourceRow";
import { usePageCommand } from "./shell/menuBus";
import { shortDate } from "./dateText";
import { Confirm, CornerToast, HintStrip, Mono, Toast, ToastCount } from "./ui";
import { HINTS, useHint } from "./hints";
import type { AnchorRect } from "./layerPlace.ts";
import {
  batchBusyText,
  deletedOriginalToast,
  deleteOriginalConfirm,
  restoredOriginalToast,
  keepThisConfirm,
  splitConfirm,
  toastFor,
  type FailedItem,
  type ToastItem,
} from "./toastText";
import type {
  AutoLink,
  CellRef,
  CellState,
  DomainPage,
  Overview,
  SyncReport,
  Target,
} from "./types";

const NO_TARGETS: Target[] = [];

/// 无法写入的典型原因。命中时说人话，否则原样转述 core 给的那句
const NO_WRITE = /permission denied|os error 13|read-?only|只读|权限/i;

/// 「只留这份」确认框要的全部：体检结果先拿到，确认框才写得出几条链接改指
interface KeepPane {
  kept: SkillRow;
  other: SkillRow;
  /// 按下那一刻「只留这份」的位置：结果锚在这里
  at: AnchorRect;
  planId: string;
  /// 两份的来源名（同名来源带区分片段，与原件位置列同一写法）与完整路径
  keptName: OriginName;
  otherName: OriginName;
  keptPath: string;
  otherPath: string;
  /// 要改指到留下那份的链接条数
  relinked: number;
}

/// 删除原件的确认框（DESIGN「删除原件」）：点原件格、体检过、等用户拍板
interface DeletePane {
  ref: CellRef;
  /// 按下那一刻那一格的位置：确认框与结果都锚在这里（删完这一行就没了，不能再去找格子）
  anchor?: AnchorRect;
  planId: string;
  /// 链接是改指到别处的同名原件（否则是一起清掉）
  relink: boolean;
  text: ReturnType<typeof deleteOriginalConfirm>;
}

/// 确认框里标题下的路径行（`留下` / `移到废纸篓` + 完整路径，不截断、太长就折行）与一句后果
/// 不给 `paths` 的（删原件）只有那一句后果
const confirmPaths = (text: { body: string; paths?: { label: string; path: string }[] }) => (
  <>
    {text.paths ? (
      <div className="mx-keeppaths">
        {text.paths.map((p) => (
          <div key={p.label} className="mx-keeppaths__row">
            <span className="mx-keeppaths__label">{p.label}</span>
            <span className="mx-keeppaths__path">
              <Mono inherit>{p.path}</Mono>
            </span>
          </div>
        ))}
      </div>
    ) : null}
    <div className="mx-keeppaths__body">{text.body}</div>
  </>
);

export interface SkillsTabProps {
  overview: Overview | null;
  /// 自动同步规则；关链前写排除、开链前恢复都靠它（规则本身在来源管理页上管理）
  autoLinks: AutoLink[];
  /// 写入进行中：壳把后台重扫排到它结束之后（不锁页签、不锁项目切换）
  onBusy: (busy: boolean) => void;
  /// 范围里的位置（DomainPage.key，见 shell/nav `locationsOf`）：一个时与改版前的单一位置页相同；
  /// 不止一个时并成一张表、名称后多一列 `位置`（spec 2026-09-26-object-first-navigation R6 R7）
  locations: ReadonlyArray<string>;
  /// 范围本身（档 + 选中的项目）：它变了才清空勾选、收起来源页（见 shell/nav `scopeKeyOf`）
  scopeKey: string;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
  /// 壳的错误横幅开着（机面顶上的灰面板）：新手提示让位
  banner?: boolean;
  /// bar 插槽（R4 的项目筛选片）：壳传进来，原样交给 DomainView / LocationFrame
  scopeBar?: ReactNode;
}

/// 位置页的 skills 页签：页面头右端筛选框 + `管理来源` + `+ 来源`，表格（DomainView → Matrix）。
/// 添加来源页与来源管理页都在机面里推入一页（侧栏留着），位置页在下面不卸载——回来时筛选、滚动、
/// 拉开的抽屉照旧。
///
/// 反馈的位置（DESIGN「反馈的两种形态」「提示条的位置」）：全是浮起的提示小窗，锚在触发处
/// - 单格：乐观更新 + 格子闪一下；成功浮在被点那一格正下方（不带撤销，⌘Z 照旧，约 4 秒淡出）；
///   失败弹回，同一个位置出黑窗说原因
/// - 批量：浮在被按下的键正下方，右对齐该键；动词与键一致，键上读数随之翻转
/// - 只留这份：先出锚定确认；确认后直接删，结果浮在留下那一行下方（无撤销；没删掉同一个位置）
/// - 原件格：先体检、出锚定确认（锚在那一格下）；确认后删原件，结果浮在那一格原来的位置下（无撤销）
/// - 孤链（原件已不在的失效链接，照样成一行）：点格即清除、不确认；结果浮在那一格下（无撤销）
/// - 整个文件夹是链接：点该列任一格出锚定确认（锚在那一格上），确认后拆开、重扫；没成那一格下说原因
/// - 自动规则在背后做了事：右下（壳上那一叠）+ 撤销
export default function SkillsTab({
  overview,
  autoLinks,
  onBusy,
  locations,
  scopeKey,
  onRefresh,
  onError,
  banner = false,
  scopeBar,
}: SkillsTabProps) {
  // 选中的行键。默认一行不选，选择条不出现（DESIGN「默认值」）；切换侧栏的位置时清空——
  // 跨位置保留会让人回到一个位置时看见「自己没勾过」的行已经勾着
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState("");
  // 添加来源页（页面头的 `+ 来源`、菜单「添加来源…」、来源管理页的 `+ 来源`）开着没有；
  // 从来源管理页进去的，返回时回到来源管理页
  const [addOpen, setAddOpen] = useState(false);
  const addFromManage = useRef(false);
  // 来源管理页（页面头的 `管理来源`）开着没有
  const [manageOpen, setManageOpen] = useState(false);
  // 从来源管理页进去加完、回到来源管理页时，新来源那几行闪一下
  const [manageFlash, setManageFlash] = useState<string[]>([]);
  const locationsKey = locations.join("\n");
  const closeAdd = useCallback(() => {
    setAddOpen(false);
    if (addFromManage.current) {
      addFromManage.current = false;
      setManageOpen(true);
    }
  }, []);
  const closeManage = useCallback(() => setManageOpen(false), []);
  /// 来源管理页里按 `+ 来源`：收起它、推入添加来源页；加完（或返回）回到来源管理页
  const addFromManagePage = useCallback(() => {
    setManageOpen(false);
    addFromManage.current = true;
    setAddOpen(true);
  }, []);
  // 乐观更新：格键 → 点下去之后该画成的状态；重扫回来后撤掉
  const [optimistic, setOptimistic] = useState<Map<string, CellState>>(new Map());
  // 写失败（目录无法写入）的格：扫描不产出 readOnly，只有真的写失败之后由这里构造
  const [readOnly, setReadOnly] = useState<Set<string>>(new Set());
  // 批量写入进行中：按下的那一项（只锁它；过了 0.3 秒门槛旁边出忙碌指示 + 一句）
  const [keyBusy, setKeyBusy] = useState<{ keyId: string; label: string } | null>(null);
  // 点了「只留这份」、正在体检的那一行（键原位忙碌）
  const [keepBusy, setKeepBusy] = useState<string | null>(null);
  // 点了原件格、正在体检的那一格（过了 0.3 秒门槛那一格下方出忙碌指示 + 一句）
  const [originBusy, setOriginBusy] = useState<{
    rowKey: string;
    columnId: string;
    label: string;
  } | null>(null);
  // 确认了「拆开」、正在拆的那一格（过了 0.3 秒门槛那一格下方出忙碌指示 + 一句）
  const [splitBusy, setSplitBusy] = useState<{
    rowKey: string;
    columnId: string;
    /// 正在拆的那个文件夹（`全部` 下同一列可以是几个位置的几个文件夹）
    targetId: string;
    label: string;
  } | null>(null);
  const [flash, setFlash] = useState<{ keys: string[]; nonce: number }>();
  const [cellNotice, setCellNotice] = useState<{
    rowKey: string;
    columnId: string;
    text: string;
  } | null>(null);
  const [keyToast, setKeyToast] = useState<{ keyId: string; node: ReactNode } | null>(null);
  // 单格成功（浮在被点那一格下）：一个槽位，新的替换旧的（id 变了重挂、计时从头来）
  const [cellToast, setCellToast] = useState<{
    id: number;
    rowKey: string;
    columnId: string;
    node: ReactNode;
  } | null>(null);
  const cellToastSeq = useRef(0);
  // 一行的结果（只留这份、删原件）：锚在按下那一刻「只留这份」/ 那一格的位置
  const [rowToast, setRowToast] = useState<{
    rowKey: string;
    at?: AnchorRect;
    node: ReactNode;
  } | null>(null);
  const [globalToast, setGlobalToast] = useState<ReactNode>(null);
  // 加完来源、开始滑回位置页：加上的那几个（等这一轮渲染拿到重扫后的页再筛）；新来源那几项下的那一窗
  const [justAdded, setJustAdded] = useState<CandidateEntry[] | null>(null);
  const [addedToast, setAddedToast] = useState<{
    key: number;
    parts: string[];
  } | null>(null);
  // 孤链格：点下去就先画成没有这一格（清除的目标状态），做成重扫后数据自己对上，没成弹回
  const [orphanGone, setOrphanGone] = useState<Set<string>>(new Set());
  // 刚清完的孤链行：数据里已经没有它了，那一窗还锚在它那一格上待满 4 秒，这期间照原样留着
  const [orphanGhost, setOrphanGhost] = useState<PlacedOrphan | null>(null);
  // 「只留这份」挂起未提交时藏起来的另一份（行键）
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [dupReadout, setDupReadout] = useState<Map<string, string>>(new Map());

  // 最近一次可撤销的操作（⌘Z、菜单「撤销」与提示条里的「撤销」走同一个）；
  // 有没有可撤的同时报给菜单（没有时「撤销」灰着）
  const undoRef = useRef<(() => void) | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const setUndo = useCallback((fn: (() => void) | null) => {
    undoRef.current = fn;
    setCanUndo(fn !== null);
  }, []);
  // 单格操作排队执行：连点几格时一格一格来，不和彼此抢
  const queue = useRef<Promise<void>>(Promise.resolve());
  const enqueue = (job: () => Promise<void>) => {
    queue.current = queue.current.then(job, job);
    return queue.current;
  };
  // 同名两份「只留这份」的确认框：点了按钮、体检过、等用户拍板
  const [keepPane, setKeepPane] = useState<KeepPane | null>(null);
  // 删除原件的确认框：点了原件格（锚在那一格下）
  const [deletePane, setDeletePane] = useState<DeletePane | null>(null);
  // 「拆开」的确认框：点了整个文件夹是链接那一列的某一格（锚在那一格上）
  const [splitPane, setSplitPane] = useState<{
    ref: CellRef;
    agent: string;
  } | null>(null);

  // 范围里各位置的页（按范围的次序：用户级在前）；还没扫描出页的位置不在里面
  const pages =
    overview === null
      ? []
      : locations.flatMap((key) => overview.domains.find((d) => d.key === key) ?? []);
  const view = useMemo(
    () => mergeSkillPages(pages),
    // 页随每一轮扫描换新；范围不变时只跟着扫描结果走
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overview, locationsKey],
  );
  // 来源管理页、添加来源页作用于哪个位置（R8）：`管理来源`、`+ 来源`、菜单「添加来源…」在不止一个位置时先选位置
  const place = usePlacePick({
    locations,
    scopeKey,
    nameOf: (key) =>
      view.places.get(key) ?? pages.find((p) => p.key === key)?.label ?? folderLabel(key),
    onAdd: () => {
      addFromManage.current = false;
      setAddOpen(true);
    },
    onManage: () => {
      setManageFlash([]);
      setManageOpen(true);
    },
  });
  const { multi, sourceKey } = place;
  usePageCommand("add-source", () => place.openAdd());
  // 选过的位置不在范围里了（后台重扫后项目没了）：收起开着的来源页，不让它悄悄作用到别处
  useEffect(() => {
    if (sourceKey !== null) return;
    setAddOpen(false);
    setManageOpen(false);
  }, [sourceKey]);
  const sourcePage: DomainPage | null = pages.find((p) => p.key === sourceKey) ?? null;

  // ---- 来源管理页、添加来源页那个位置订阅的来源：来源管理页（规则 + 移除）、添加来源页的候选 ----
  // 还没扫描出页的位置：名字取项目文件夹名，没有列可当目标
  const domainRef: DomainRef = sourcePage
    ? { key: sourcePage.key, label: sourcePage.label }
    : { key: sourceKey ?? "global", label: folderLabel(sourceKey ?? "global") };
  const targets = sourcePage?.targets ?? NO_TARGETS;
  const targetsKey = targets.map((t) => `${t.id}:${t.linkedWholeTo ?? ""}`).join("|");
  const model = useMemo(
    () => skillSourcesModel(domainRef, targets),
    // 目标按 id 比：重扫回来内容没变时不换模型，不重读
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [domainRef.key, domainRef.label, targetsKey],
  );
  const sources = useSources({
    model,
    domain: domainRef,
    version: overview,
    onChange: onRefresh,
    // R9 去掉了按来源筛选：移除来源之后不用再更新筛选状态
    onRemoved: () => undefined,
    keys: !addOpen && !manageOpen,
  });

  // ---- 新手提示（DESIGN「新手提示条」）：首次扫描两条按结果二选一 ----
  // 扫描完成＝壳拿到了 overview（它只在一轮扫描真正结束时才给，扫描中是 null，没有半截的中间态）。
  // 盖着添加来源页 / 来源管理页时位置页不在眼前，不算到达；回来再出
  const onPage = !addOpen && !manageOpen;
  const hasSkills = view.rows.length > 0;
  const noSkills = overview !== null && view.rows.length === 0 && view.orphans.length === 0;
  // 让位：壳的错误横幅、确认框（只留这份、拆开、移除来源）开着
  const hintBlocked =
    banner || keepPane !== null || deletePane !== null || splitPane !== null || sources.confirming;
  const skillsHint = useHint("first-scan-skills", {
    eligible: onPage && hasSkills,
    blocked: hintBlocked,
  });
  const emptyHint = useHint("first-scan-empty", {
    eligible: onPage && noSkills,
    blocked: hintBlocked,
  });
  const learnedCell = skillsHint.learned;
  // 提示句用的现场数据：这一轮读了哪些 agent 的目录（有目录的列）、表里几个 skill（＝列头 `名称 N`）
  const hintCtx = {
    agents: view.columns
      .filter((c) => [...c.targets.values()].some((t) => t.exists))
      .map((c) => c.label),
    skills: view.rows.length,
  };

  const targetOf = (targetId: string): Target | null =>
    pages.flatMap((p) => p.targets).find((t) => t.id === targetId) ?? null;
  const targetByPath = (path: string): Target | null =>
    pages.flatMap((p) => p.targets).find((t) => t.path === path) ?? null;
  const agentRef = (target: Target | null) =>
    target ? { id: target.scope.harnessId, name: target.label } : undefined;
  const findCell = (ref: CellRef) => {
    for (const p of pages) {
      const row = p.rows.find((r) => r.sourceId === ref.sourceId && r.skill === ref.skill);
      const cell = row?.cells.find((c) => c.targetId === ref.targetId);
      if (cell) return cell;
    }
    return null;
  };
  const stateOf = (ref: CellRef, actual: CellState): CellState => {
    const key = skillCellKey(ref);
    return optimistic.get(key) ?? (readOnly.has(key) ? "readOnly" : actual);
  };

  // ---- 提示条：各自到点消失。回调要稳定，否则 Toast 的计时器每次渲染都重来 ----
  const dismissKey = useCallback(() => setKeyToast(null), []);
  const dismissGlobal = useCallback(() => setGlobalToast(null), []);
  const dismissCell = useCallback(() => setCellToast(null), []);
  const dismissNotice = useCallback(() => setCellNotice(null), []);
  const dismissRow = useCallback(() => setRowToast(null), []);
  const dismissAdded = useCallback(() => setAddedToast(null), []);
  /// 单格失败：弹回之后同一个位置（那一格正下方）说原因，替掉那一格的成功窗（一次只一条）
  const failCell = (rowKey: string, columnId: string, text: string) => {
    setCellToast(null);
    setCellNotice({ rowKey, columnId, text });
  };

  // 提示与弹层只属于当次选择；换了范围（切档、切项目）时勾选清空、收起来源页。
  // 按范围本身认，不按位置集合：「项目级 · 全部」下后台重扫多出一个项目，不该清掉手上正做的事
  useEffect(() => {
    setManageOpen(false);
    setAddOpen(false);
    addFromManage.current = false;
    setKeepPane(null);
    setDeletePane(null);
    setSplitPane(null);
    setKeyToast(null);
    setCellToast(null);
    setRowToast(null);
    setCellNotice(null);
    setAddedToast(null);
    setSelected(new Set());
    setUndo(null);
  }, [scopeKey]);

  // 加完来源滑回位置页（DESIGN「添加来源」）：重扫已完，R9 去掉了按来源筛选——不再筛，只把新行的格
  // 闪一下交代「就是这些」，浮起 `✓ 已添加 … · N 个 skill`。从来源管理页进去加的回到来源管理页，
  // 位置页的筛选不动
  useEffect(() => {
    if (justAdded === null || !overview) return;
    setJustAdded(null);
    if (addFromManage.current) {
      setManageFlash(justAdded.map((e) => e.id));
      return;
    }
    // 加在哪个位置，就闪那个位置的新行
    if (sourcePage === null) return;
    const placed = view.rows.filter((r) => r.domainKey === sourceKey);
    const order = placed.map((r) => r.sourceId);
    const ids = addedOrigins(
      justAdded.map((e) => e.id),
      order,
    );
    let parts: string[];
    if (ids.length > 0) {
      // 名字与来源列同一个起名函数、同一组来源（DomainView）；数量＝新来源的行数
      const names = originNames(order, overview.sources);
      const added = placed.filter((r) => ids.includes(r.sourceId));
      parts = addedParts(
        ids.map((id) => originText(names.get(id)!)),
        added.length,
        "skill",
        false,
      );
      setFilterText("");
      setFlash({
        keys: added.flatMap((r) =>
          view.columns.flatMap((c) => {
            const ref = refAt(r, c);
            return ref ? [skillCellKey(ref)] : [];
          }),
        ),
        nonce: Date.now(),
      });
    } else {
      // 新来源在这个位置下一行都没有：只交代加上了
      parts = addedParts(
        justAdded.map((e) => e.name),
        justAdded.reduce((n, e) => n + e.count, 0),
        "skill",
        false,
      );
    }
    setAddedToast({ key: Date.now(), parts });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justAdded, overview]);

  useEffect(() => {
    if (!overview) return;
    // 读数跟着这一轮扫描，文件可能变了
    setDupReadout(new Map());
  }, [overview]);

  // ===== 规则：排除 / 恢复 =====

  /// 规则在这个目标上排除了这个 skill（排除名单按目标记，只管这一格）
  const excludedAt = (r: AutoLink, target: string, skill: string) =>
    r.targetExcluded?.[target]?.includes(skill) ?? false;
  /// 这批格里仍在某条自动同步规则范围内的格：关掉前必须先写排除，
  /// 否则下一轮扫描立刻把链接补回来
  const toExclude = (cells: CellRef[]) => {
    const out = new Map<string, { source: string; target: string; skill: string }>();
    for (const c of cells) {
      const covered = autoLinks.some(
        (r) =>
          r.source === c.sourceId &&
          !excludedAt(r, c.targetId, c.skill) &&
          r.targets.includes(c.targetId),
      );
      if (covered)
        out.set(`${c.sourceId}|${c.targetId}|${c.skill}`, {
          source: c.sourceId,
          target: c.targetId,
          skill: c.skill,
        });
    }
    return [...out.values()];
  };
  /// 这批格里被规则覆盖、且在这个目标的排除名单上的：点开时放回规则里
  const toInclude = (cells: CellRef[]) => {
    const out = new Map<string, { source: string; target: string; skill: string }>();
    for (const c of cells) {
      const covered = autoLinks.some(
        (r) =>
          r.source === c.sourceId &&
          excludedAt(r, c.targetId, c.skill) &&
          r.targets.includes(c.targetId),
      );
      if (covered)
        out.set(`${c.sourceId}|${c.targetId}|${c.skill}`, {
          source: c.sourceId,
          target: c.targetId,
          skill: c.skill,
        });
    }
    return [...out.values()];
  };

  /// 这条没做成的原因，一句人话：说原因，不说「失败」
  /// 动词带方向：没加到 X / 没从 X 移除（「开启 X」会读成操作应用本身）
  const reasonOf = (target: string, reason: string, what: "link" | "unlink"): string => {
    const agent = targetByPath(target)?.label ?? target;
    return NO_WRITE.test(reason)
      ? `无法写入 ${agent} 的 skills 目录`
      : `${what === "link" ? `没加到 ${agent}` : `没从 ${agent} 移除`}：${reason}`;
  };

  /// 执行一次开 / 关：返回每一格做成没做成。排除 / 恢复在动作之前写，顺序不能反
  const run = async (
    op: "link" | "unlink",
    cells: CellRef[],
  ): Promise<{ done: CellRef[]; failed: { ref: CellRef; reason: string }[] }> => {
    const actions = op === "link" ? await api.proposeLinks(cells) : await api.proposeUnlinks(cells);
    if (op === "link")
      for (const r of toInclude(cells)) await api.includeAutoLink(r.source, r.target, r.skill);
    else for (const r of toExclude(cells)) await api.excludeAutoLink(r.source, r.target, r.skill);
    const report = actions.length === 0 ? { entries: [] } : await api.applyAll(actions, false);
    const byPath = new Map(report.entries.map((e) => [e.action.targetPath, e]));
    const done: CellRef[] = [];
    const failed: { ref: CellRef; reason: string }[] = [];
    for (const ref of cells) {
      const cell = findCell(ref);
      const entry = cell ? byPath.get(cell.path) : undefined;
      if (entry === undefined) {
        // 没有动作：已经是想要的样子了（别处刚改过），算做成
        done.push(ref);
      } else if (entry.outcome.status === "failed") {
        failed.push({
          ref,
          reason: reasonOf(entry.action.target, entry.outcome.reason, op),
        });
      } else {
        done.push(ref);
      }
    }
    return { done, failed };
  };

  /// 写失败里「无法写入目录」的那些格记下来：格子画成斜杠环，点它就是再试一次
  const noteReadOnly = (failed: { ref: CellRef; reason: string }[], retried: CellRef[]) =>
    setReadOnly((prev) => {
      const next = new Set(prev);
      for (const ref of retried) next.delete(skillCellKey(ref));
      for (const f of failed) if (/^无法写入/.test(f.reason)) next.add(skillCellKey(f.ref));
      return next;
    });

  const setOptimisticFor = (cells: CellRef[], state: CellState | null) =>
    setOptimistic((prev) => {
      const next = new Map(prev);
      for (const ref of cells) {
        if (state === null) next.delete(skillCellKey(ref));
        else next.set(skillCellKey(ref), state);
      }
      return next;
    });

  // ===== 单格：乐观更新 + 闪一下；成功浮一窗 =====

  /// 单格成功：被点那一格正下方浮起 `✓ 加到 [Codex]`（格子所在的行已说明对象，不重复名字），
  /// 替换上一条。不带撤销（DESIGN「单格操作不带撤销」：再点一下格子就恢复了，⌘Z 照旧可用）；
  /// 约 4 秒淡出，悬停停表
  const showCellToast = (id: number, op: "link" | "unlink", ref: CellRef) => {
    const text = toastFor(op, { done: toastItems([ref]), omitNames: true });
    setCellToast({
      id,
      rowKey: refRowKey(ref),
      columnId: columnOfTarget(ref.targetId),
      node: <Toast {...text} onDismiss={dismissCell} />,
    });
  };

  /// `undoing`：这是撤销本身——做成了不再出例行一行，也不再留可撤销的操作
  const toggleCell = (ref: CellRef, from: CellState, undoing = false) => {
    const key = skillCellKey(ref);
    const rowKey = refRowKey(ref);
    const columnId = columnOfTarget(ref.targetId);
    setCellNotice(null);

    // 失效的链接：点一下就是重新链接——先清掉指不到东西的那条，再建一条指向这一行的原件
    if (from === "broken") {
      const cell = findCell(ref);
      const stale = view.broken.find((a) => a.targetPath === cell?.path);
      setOptimisticFor([ref], "linked");
      setFlash({ keys: [key], nonce: Date.now() });
      void enqueue(async () => {
        try {
          if (stale) await api.applyAll([stale], true);
          const result = await run("link", [ref]);
          if (result.failed.length > 0) {
            failCell(rowKey, columnId, result.failed[0].reason);
          } else {
            // 重新链接没有可撤销的反面：出一行交代，不带撤销
            setUndo(null);
            learnedCell();
            showCellToast(++cellToastSeq.current, "link", ref);
          }
          await onRefresh();
        } catch (e) {
          failCell(rowKey, columnId, String(e));
        } finally {
          setOptimisticFor([ref], null);
        }
      });
      return;
    }

    const op: "link" | "unlink" = from === "linked" ? "unlink" : "link";
    setOptimisticFor([ref], op === "link" ? "linked" : "missing");
    setFlash({ keys: [key], nonce: Date.now() });
    void enqueue(async () => {
      try {
        const result = await run(op, [ref]);
        noteReadOnly(result.failed, op === "link" ? [ref] : []);
        if (result.failed.length > 0) {
          // 弹回 + 同一个位置（格子正下方）的黑窗说原因
          setOptimisticFor([ref], null);
          failCell(rowKey, columnId, result.failed[0].reason);
        } else if (!undoing) {
          // 点过一格、写成了：`first-scan-skills` 教的就是这件事
          learnedCell();
          const back = op === "link" ? "linked" : "missing";
          const id = ++cellToastSeq.current;
          // ⌘Z 撤最新这一次；撤了那一窗直接消失，不另出「已撤销」
          const undo = () => {
            if (undoRef.current === undo) setUndo(null);
            setCellToast((prev) => (prev?.id === id ? null : prev));
            toggleCell(ref, back, true);
          };
          setUndo(undo);
          showCellToast(id, op, ref);
        }
        await onRefresh();
      } catch (e) {
        failCell(rowKey, columnId, String(e));
      } finally {
        setOptimisticFor([ref], null);
      }
    });
  };

  const onCell = (ref: CellRef) => {
    const cell = findCell(ref);
    if (!cell) return;
    const state = stateOf(ref, cell.state);
    if (state === "linked" || state === "missing" || state === "broken") toggleCell(ref, state);
    // 无法写入：再试一次就是再开一次
    else if (state === "readOnly") toggleCell(ref, "missing");
    // 整个文件夹是链接：先确认拆开（锚在被点的那一格上）
    else if (state === "wholeLinked") askSplit(ref);
    // 原件：先体检、再确认删原件（锚在被点的那一格下）
    else if (state === "own") void askDeleteOriginal(ref);
  };

  /// 那一格此刻在视口里的矩形（确认框、结果的锚）
  const cellAnchorOf = (ref: CellRef): AnchorRect | undefined => {
    const index = view.columns.findIndex((c) => c.id === columnOfTarget(ref.targetId));
    const row = document.querySelector(`[data-row="${CSS.escape(refRowKey(ref))}"]`);
    const r = row?.querySelectorAll(".mx-cell")[index]?.getBoundingClientRect();
    return r ? { top: r.top, left: r.left, right: r.right, bottom: r.bottom } : undefined;
  };

  // ===== 整个文件夹是链接：点该列任一格 → 锚定确认 → 拆开 =====

  const askSplit = (ref: CellRef) => {
    // 这个文件夹正在拆：它的下一次点击不再弹确认（`全部` 下同一列里别的位置是别的文件夹）
    if (splitBusy?.targetId === ref.targetId) return;
    setCellNotice(null);
    setSplitPane({
      ref,
      agent: targetOf(ref.targetId)?.label ?? "",
    });
  };

  /// 确认之后拆开；做成了重扫（整列的记号自己变回逐格状态），没成就在被点那一格下说原因。
  /// 要复制整个文件夹，可能真要等：只锁这一列的格（再点不弹确认），过了 0.3 秒门槛被点那一格
  /// 下方出忙碌指示 + 一句；别的列、别的行照常能点
  const confirmSplit = async (ref: CellRef) => {
    const agent = splitPane?.agent ?? targetOf(ref.targetId)?.label ?? "";
    setSplitPane(null);
    setCellNotice(null);
    setCellToast(null);
    setSplitBusy({
      rowKey: refRowKey(ref),
      columnId: columnOfTarget(ref.targetId),
      targetId: ref.targetId,
      label: `正在拆开 ${agent} 的 skills 文件夹`,
    });
    onBusy(true);
    try {
      const report = await api.splitWholeLink(ref.targetId);
      const failed = report.entries.filter((e) => e.outcome.status === "failed");
      const first = failed[0]?.outcome;
      if (first && first.status === "failed") {
        const created = report.entries.filter((e) => e.outcome.status === "created").length;
        failCell(
          refRowKey(ref),
          columnOfTarget(ref.targetId),
          created === 0
            ? `没拆开：${first.reason}`
            : `拆开了，但有 ${failed.length} 个没复制过来：${first.reason}`,
        );
      } else {
        // 做成了：例行一行 `✓ 拆开 [Codex] 的 skills 文件夹`，浮在被点那一格正下方；
        // 不带撤销（DESIGN「拆开」不是可逆的开关，撤销挂不上）
        const text = toastFor("split", {
          done: [{ name: "的 skills 文件夹", agent: agentRef(targetOf(ref.targetId)) }],
        });
        setCellToast({
          id: ++cellToastSeq.current,
          rowKey: refRowKey(ref),
          columnId: columnOfTarget(ref.targetId),
          node: <Toast {...text} onDismiss={dismissCell} />,
        });
      }
    } catch (e) {
      onError(String(e));
    } finally {
      onBusy(false);
      setSplitBusy(null);
    }
    await onRefresh();
  };

  // ===== 孤链：点格清除，不确认（链接本来就指向空处）；没有撤销——重建一条指向空处的链接没有意义 =====

  const clearOrphan = (orphan: PlacedOrphan, targetId: string) => {
    const link = orphan.links.find((l) => l.targetId === targetId);
    if (!link) return;
    const columnId = columnOfTarget(targetId);
    const key = cellKey(orphan.key, columnId);
    setCellNotice(null);
    setOrphanGone((prev) => new Set(prev).add(key));
    setFlash({ keys: [key], nonce: Date.now() });
    void enqueue(async () => {
      try {
        const report = await api.applyAll([link.clear], true);
        const bad = report.entries.find((e) => e.outcome.status === "failed");
        if (bad && bad.outcome.status === "failed") {
          failCell(orphan.key, columnId, `没清除：${bad.outcome.reason}`);
        } else {
          setUndo(null);
          learnedCell();
          setOrphanGhost({ ...orphan, links: orphan.links.filter((l) => l.targetId !== targetId) });
          const text = toastFor("clear", {
            done: [{ name: orphan.skill, agent: agentRef(targetOf(targetId)) }],
            omitNames: true,
          });
          setCellToast({
            id: ++cellToastSeq.current,
            rowKey: orphan.key,
            columnId,
            node: <Toast {...text} onDismiss={dismissCell} />,
          });
        }
        await onRefresh();
      } catch (e) {
        failCell(orphan.key, columnId, String(e));
      } finally {
        setOrphanGone((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    });
  };

  // ===== 批量：结果浮在被按下的键正下方 =====

  const toastItems = (refs: CellRef[]): ToastItem[] =>
    refs.map((ref) => ({ name: ref.skill, agent: agentRef(targetOf(ref.targetId)) }));

  /// 按下一个键：格子同时变成新状态（不闪、不依次点亮），写入排在前面的写入之后（连按几个键
  /// 一个一个来，不和彼此抢）。只锁按下的那一项；过了 0.3 秒门槛它旁边出忙碌指示 + 一句
  /// （DESIGN「选择操作条」「反馈的两种形态 › 忙碌」）
  const batch = (press: BatchPress, undoing = false) => {
    const { keyId, op, cells } = press;
    if (cells.length === 0) return Promise.resolve();
    setKeyToast(null);
    setCellToast(null);
    setCellNotice(null);
    setOptimisticFor(cells, op === "link" ? "linked" : "missing");
    // 选择行的键是 agent 列 id
    const agent =
      keyId === "all" ? "所有 agent" : (view.columns.find((c) => c.id === keyId)?.label ?? "");
    if (keyId) setKeyBusy({ keyId, label: batchBusyText(op, agent) });
    return enqueue(() => batchWrite(press, undoing));
  };

  const batchWrite = async ({ keyId, op, cells, reversible }: BatchPress, undoing: boolean) => {
    onBusy(true);
    let result: Awaited<ReturnType<typeof run>> | null = null;
    try {
      result = await run(op, cells);
    } catch (e) {
      onError(String(e));
    } finally {
      onBusy(false);
      setKeyBusy((prev) => (prev?.keyId === keyId ? null : prev));
    }
    if (result !== null) {
      noteReadOnly(result.failed, op === "link" ? cells : []);
      // 没成的弹回；做成的保持新状态，结果由提示条交代
      setOptimisticFor(
        result.failed.map((f) => f.ref),
        null,
      );
      const done = result.done;
      const text = toastFor(op, {
        done: toastItems(done),
        failed: result.failed.map<FailedItem>((f) => ({
          ...toastItems([f.ref])[0],
          reason: f.reason,
        })),
      });
      // `⌘Z` 始终撤这一次；提示条上的 `撤销` 只在再按一次同一个点撤不回原样时给（BatchPress.reversible）
      const undo =
        done.length > 0 && !undoing
          ? () => {
              setUndo(null);
              void batch(
                { keyId, op: op === "link" ? "unlink" : "link", cells: done, reversible: true },
                true,
              );
            }
          : null;
      setUndo(undo);
      // 结果锚在触发处：选择行里被按的那个点；撤销右下那一窗里的自动规则（keyId 空）的，仍出在右下
      const corner = keyId === "";
      const dismiss = corner ? dismissGlobal : dismissKey;
      const node = (
        <Toast
          {...text}
          // 写数量，不逐个写名字（`✓ 加到 ✳ 1 个`）；名字在点的提示框里
          names={text.kind === "success" ? undefined : text.names}
          reading={text.kind === "success" ? <ToastCount n={done.length} /> : undefined}
          action={undo && !reversible ? { label: "撤销", onClick: undo } : undefined}
          onDismiss={dismiss}
          onClose={text.tier === "notice" ? dismiss : undefined}
        />
      );
      if (corner) setGlobalToast(node);
      else setKeyToast({ keyId, node });
    }
    await onRefresh();
    setOptimisticFor(cells, null);
  };

  // ===== 原件格：删原件（DESIGN「删除原件」） =====
  // 删用户的原件先确认（锚在那一格下）；确认后直接删、不挂起；结果是例行一行、不带撤销——
  // 原件从废纸篓找回，确认框已说清；清掉或改指过的链接回不来

  /// 点原件格：先体检（这一格过了 0.3 秒门槛才出忙碌），再弹确认框说清后果（DESIGN「删除原件」）
  const askDeleteOriginal = async (ref: CellRef) => {
    const rowKey = refRowKey(ref);
    const columnId = columnOfTarget(ref.targetId);
    // 这一格正在体检：这一下不重复发
    if (originBusy?.rowKey === rowKey && originBusy.columnId === columnId) return;
    setCellNotice(null);
    setCellToast(null);
    const anchor = cellAnchorOf(ref);
    setOriginBusy({ rowKey, columnId, label: "正在查看影响" });
    let planned;
    try {
      planned = await api.planDeleteSource(ref.sourceId, ref.skill);
    } catch (e) {
      onError(String(e));
      return;
    } finally {
      setOriginBusy((prev) =>
        prev?.rowKey === rowKey && prev.columnId === columnId ? null : prev,
      );
    }
    const { plan } = planned;
    // 链接的后果：改指到哪个来源的那份；或一起清掉的链接在哪几个 agent 里（按链接所在目录认列）
    const sources = overview?.sources ?? [];
    const relinkId =
      plan.relinkTo === null
        ? undefined
        : sources.find((s) => s.skills.some((k) => k.path === plan.relinkTo))?.id;
    const relinkName =
      relinkId === undefined
        ? undefined
        : originNames([...view.rows.map((r) => r.sourceId), relinkId], sources).get(relinkId);
    const allTargets = overview?.domains.flatMap((d) => d.targets) ?? [];
    const linkAgents = [
      ...new Set(
        plan.affected.flatMap((link) => {
          const dir = link.path.replace(/[/\\][^/\\]*$/, "");
          const label = allTargets.find((t) => t.path === dir)?.label;
          return label ? [label] : [];
        }),
      ),
    ];
    // 直接读原件所在目录的 agent：这一行里画 ⦿ 的列
    const row = view.rows.find((r) => skillRowKey(r) === rowKey);
    const ownAgents = [
      ...new Set(
        (row?.cells ?? [])
          .filter((c) => c.state === "own")
          .flatMap((c) => targetOf(c.targetId)?.label ?? []),
      ),
    ];
    setDeletePane({
      ref,
      anchor,
      planId: planned.planId,
      relink: plan.relinkTo !== null,
      text: deleteOriginalConfirm({
        skill: ref.skill,
        links: plan.affected.length,
        relinkTo:
          plan.relinkTo === null ? undefined : relinkName ? originText(relinkName) : plan.relinkTo,
        ownAgents,
        linkAgents,
      }),
    });
  };

  /// 确认之后：这一行先藏起来、删完重扫再放开；结果浮在那一格原来的位置下
  const confirmDeleteOriginal = async (pane: DeletePane) => {
    setDeletePane(null);
    const { ref } = pane;
    const rowKey = refRowKey(ref);
    setHidden((prev) => new Set(prev).add(rowKey));
    const cannot = (reason: string) => (
      <Toast
        kind="cannot"
        verb="没删掉"
        names={[ref.skill]}
        reason={reason}
        onDismiss={dismissRow}
        onClose={dismissRow}
      />
    );
    let node: ReactNode = null;
    try {
      let result: Awaited<ReturnType<typeof api.deleteSource>>;
      try {
        // 用户在确认框里确认了删它：原件在不在 git 仓库里都删（DESIGN「删除原件」）
        result = await api.deleteSource(pane.planId, true);
      } catch {
        // 计划只存一份，悬停读数时可能被换掉了：重新体检一次再删
        const again = await api.planDeleteSource(ref.sourceId, ref.skill);
        result = await api.deleteSource(again.planId, true);
      }
      const { report, undoId } = result;
      const [first, ...links] = report.entries;
      const failed = links.filter((e) => e.outcome.status === "failed");
      const bad = failed[0]?.outcome;
      // 界面上没有别的退路：能撤销就给 `撤销`（DESIGN「删除原件」）
      const undo =
        undoId === null
          ? undefined
          : {
              label: "撤销",
              onClick: () => void undoDeleteOriginal(undoId, ref.skill, rowKey, pane.anchor),
            };
      if (first?.outcome.status === "failed") node = cannot(first.outcome.reason);
      else if (bad && bad.status === "failed")
        // 原件已删，但有链接没处理好：逐条上报的结果汇成一句，不偷偷跳过
        node = (
          <Toast
            kind="partial"
            verb="已删除"
            names={[ref.skill]}
            reason={`${undoId === null ? "在废纸篓里，" : ""}${failed.length} 条链接没${pane.relink ? "改指" : "清掉"}：${bad.reason}`}
            action={undo}
            onDismiss={dismissRow}
            onClose={dismissRow}
          />
        );
      else
        node = (
          <Toast
            {...deletedOriginalToast(ref.skill, undoId !== null)}
            action={undo}
            onDismiss={dismissRow}
          />
        );
    } catch (e) {
      node = cannot(String(e));
    }
    await onRefresh();
    setHidden((prev) => {
      const next = new Set(prev);
      next.delete(rowKey);
      return next;
    });
    if (node !== null) setRowToast({ rowKey, at: pane.anchor, node });
  };

  /// 撤销删原件（删原件与只留这份共用）：原件放回原处、链接复原，重扫后在原来那一格下说结果
  const undoDeleteOriginal = async (
    undoId: string,
    skill: string,
    rowKey: string,
    at: AnchorRect | undefined,
  ) => {
    dismissRow();
    let text: ReturnType<typeof restoredOriginalToast>;
    try {
      const report = await api.undoDeleteSource(undoId);
      const [first, ...links] = report.entries;
      const reasons = (entries: typeof links) =>
        entries.flatMap((e) => (e.outcome.status === "failed" ? [e.outcome.reason] : []));
      text = restoredOriginalToast(skill, {
        bodyBack: first?.outcome.status !== "failed",
        failed: first?.outcome.status === "failed" ? reasons([first]) : reasons(links),
      });
    } catch (e) {
      text = restoredOriginalToast(skill, { bodyBack: false, failed: [String(e)] });
    }
    await onRefresh();
    setRowToast({
      rowKey,
      at,
      node: (
        <Toast
          {...text}
          onDismiss={dismissRow}
          onClose={text.kind === "success" ? undefined : dismissRow}
        />
      ),
    });
  };

  // ===== 同名：只留这份 =====
  // DESIGN「页面还是弹层」：删用户的原件先确认（锚在按钮上），确认后直接删、不挂起；
  // 结果是例行一行 + `撤销`（2026-09-25 起：另一份放回原处、改指过的链接指回去）

  const keepThis = async (kept: SkillRow, other: SkillRow, at: AnchorRect) => {
    const sources = overview?.sources ?? [];
    // 与原件位置列同一套：按表里出现的来源算，同名来源才分得开
    const names = originNames(
      view.rows.map((r) => r.sourceId),
      sources,
    );
    const nameOf = (id: string): OriginName => names.get(id) ?? { name: id, seg: "" };
    const source = sources.find((s) => s.id === kept.sourceId);
    const keptPath =
      source?.skills.find((k) => k.name === kept.skill)?.path ??
      `${source?.path ?? kept.sourceId}/${kept.skill}`;
    const rowKey = skillRowKey(kept);
    // 同一行正在体检：这一下不重复发
    if (keepBusy === rowKey) return;
    // 点下去到确认框出来之间要体检：键原位忙碌（过了 0.3 秒门槛才出刻度），只锁这一颗
    setKeepBusy(rowKey);
    let planned;
    try {
      planned = await api.planDeleteSource(other.sourceId, other.skill);
    } catch (e) {
      onError(String(e));
      return;
    } finally {
      setKeepBusy((prev) => (prev === rowKey ? null : prev));
    }
    if (planned.plan.inGit !== null) {
      setRowToast({
        rowKey,
        at,
        node: (
          <Toast
            kind="cannot"
            verb="没删掉"
            names={[other.skill]}
            reason={`另一份在 git 仓库 ${planned.plan.inGit} 里，交给 git 处理更稳妥，这里不代删`}
            onDismiss={dismissRow}
            onClose={dismissRow}
          />
        ),
      });
      return;
    }
    setKeepPane({
      kept,
      other,
      at,
      planId: planned.planId,
      keptName: nameOf(kept.sourceId),
      otherName: nameOf(other.sourceId),
      keptPath,
      otherPath: planned.plan.path,
      relinked: planned.plan.affected.length,
    });
  };

  /// 确认之后：立即删掉另一份（先藏起来，删完重扫再放开）
  const confirmKeep = async (pane: KeepPane) => {
    setKeepPane(null);
    const { kept, other } = pane;
    const otherKey = skillRowKey(other);
    setHidden((prev) => new Set(prev).add(otherKey));
    let ok = false;
    let undoId: string | null = null;
    try {
      let report: SyncReport;
      try {
        ({ report, undoId } = await api.deleteSource(pane.planId));
      } catch {
        // 计划只存一份，悬停读数时可能被换掉了：重新体检一次再删（仓库里的照旧不代删）
        const again = await api.planDeleteSource(other.sourceId, other.skill);
        if (again.plan.inGit !== null)
          throw new Error(`它在 git 仓库 ${again.plan.inGit} 里，这里不代删`);
        ({ report, undoId } = await api.deleteSource(again.planId));
      }
      const bad = report.entries.find((e) => e.outcome.status === "failed");
      if (bad && bad.outcome.status === "failed") {
        // 没删掉：同「只留这份」的结果，浮在留下那一行下方
        setRowToast({
          rowKey: skillRowKey(kept),
          at: pane.at,
          node: (
            <Toast
              kind="cannot"
              verb="没删掉"
              names={[other.skill]}
              reason={bad.outcome.reason}
              onDismiss={dismissRow}
              onClose={dismissRow}
            />
          ),
        });
      } else ok = true;
    } catch (e) {
      onError(String(e));
    }
    await onRefresh();
    setHidden((prev) => {
      const next = new Set(prev);
      next.delete(otherKey);
      return next;
    });
    if (!ok) return;
    const text = toastFor("keepThis", {
      done: [{ name: kept.skill }],
      keepLabel: originText(pane.keptName),
    });
    const keptKey = skillRowKey(kept);
    const id = undoId;
    setRowToast({
      rowKey: keptKey,
      at: pane.at,
      node: (
        <Toast
          {...text}
          action={
            id === null
              ? undefined
              : {
                  label: "撤销",
                  onClick: () => void undoDeleteOriginal(id, other.skill, keptKey, pane.at),
                }
          }
          onDismiss={dismissRow}
        />
      ),
    });
  };

  /// 同名两份的读数：×2 的提示框要同时列两份，所以一次把同名的几份都取了（取过的不再取）
  const dupHover = (row: SkillRow) => {
    for (const copy of view.rows.filter(
      (r) => r.domainKey === row.domainKey && r.skill === row.skill,
    ))
      readoutOf(copy);
  };
  const readoutOf = (row: SkillRow) => {
    const key = skillRowKey(row);
    if (dupReadout.has(key)) return;
    // 先占位，悬停来回扫时不重复体检
    setDupReadout((prev) => new Map(prev).set(key, ""));
    void api
      .planDeleteSource(row.sourceId, row.skill)
      .then((planned) =>
        setDupReadout((prev) =>
          new Map(prev).set(
            key,
            // `改于 9月20日 · 3 个文件`；改动时间读不到时只写文件数
            [
              planned.plan.modified != null ? `改于 ${shortDate(planned.plan.modified)}` : null,
              `${planned.plan.entries} 个文件`,
            ]
              .filter((part): part is string => part !== null)
              .join(" · "),
          ),
        ),
      )
      .catch(() => undefined);
  };

  // ===== 自动规则在背后做了事：右下（壳上那一叠）+ 撤销；格子直接是新状态，不闪 =====

  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const batchRef = useRef(batch);
  batchRef.current = batch;
  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void> = [];
    void listen<SyncReport>("auto-linked", ({ payload }) => {
      const created = payload.entries.filter((e) => e.outcome.status === "created");
      if (created.length === 0) return;
      const all = pagesRef.current;
      const refs: CellRef[] = [];
      const items: ToastItem[] = [];
      for (const e of created) {
        const target = all.flatMap((p) => p.targets).find((t) => t.path === e.action.target);
        items.push({ name: e.action.itemName, agent: agentRef(target ?? null) });
        const row = all
          .flatMap((p) => p.rows)
          .find(
            (r) =>
              r.skill === e.action.itemName && r.cells.some((c) => c.path === e.action.targetPath),
          );
        if (row && target)
          refs.push({ sourceId: row.sourceId, skill: row.skill, targetId: target.id });
      }
      const undo =
        refs.length > 0
          ? () => {
              setUndo(null);
              setGlobalToast(null);
              void batchRef.current(
                { keyId: "", op: "unlink", cells: refs, reversible: true },
                true,
              );
            }
          : null;
      setUndo(undo);
      const text = toastFor("autoLink", { done: items });
      setGlobalToast(
        <Toast
          {...text}
          names={items.length > 2 ? undefined : text.names}
          reading={items.length > 2 ? <ToastCount n={items.length} /> : undefined}
          action={undo ? { label: "撤销", onClick: undo } : undefined}
          onDismiss={dismissGlobal}
          onClose={dismissGlobal}
        />,
      );
    }).then((un) => (disposed ? un() : unlistens.push(un)));
    return () => {
      disposed = true;
      unlistens.forEach((un) => un());
    };
    // 监听只注册一次；读当前页走 ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== 渲染 =====

  /// 添加来源页：在机面里推入（侧栏留着）；加好后位置页重扫，滑回；全加上时列表筛到新来源 + 那几项下一窗
  const addPage = addOpen ? (
    <AddSourcePage
      model={model}
      domain={domainRef}
      onClose={closeAdd}
      onAdded={async () => {
        // 加上了至少一个来源：`first-scan-empty` 教的就是这件事
        emptyHint.learned();
        await onRefresh();
      }}
      onAllAdded={setJustAdded}
    />
  ) : null;
  /// 这个位置订阅了来源才有 `管理来源`（一个都没订阅时不出：空态已有 `+ 来源`）
  /// 不止一个位置时总是给：先选位置，那个位置没订阅来源时来源管理页自己出空态
  const subscribed = (sources.data?.rows.length ?? 0) > 0;
  const openManage = multi || subscribed ? place.openManage : undefined;
  const placePicker = place.picker;
  /// 来源管理页（二级页，同添加来源页的骨架）：来源的路径、规则、移除都在这里。
  /// 开着时最后一个来源被移除，它自己出空态，不跟着收起
  const managePage = manageOpen ? (
    <SourcesPage
      sources={sources}
      domain="skills"
      placeName={domainRef.label}
      onClose={closeManage}
      onAdd={addFromManagePage}
      flashIds={manageFlash}
    />
  ) : null;
  /// 页面头右端：筛选框 + `管理来源` + `+ 来源`（表格还没有时也照常放，页面头不跳）。
  /// 范围里一个位置都没有（项目级下没有检测到项目）时不给：没有地方可加
  const sourceKeys =
    locations.length > 0 ? <SourceKeys onManage={openManage} onAdd={place.openAdd} /> : null;

  if (!overview) {
    return (
      <LocationFrame
        filterText={filterText}
        onFilterText={setFilterText}
        actions={sourceKeys}
        enabled={!addOpen && !manageOpen}
        bar={scopeBar}
        empty={{ description: "正在读 skill 目录", busy: true, art: "scanning" }}
      />
    );
  }
  /// 空态里说的地方：一个位置写它的名字，几个位置合起来说
  const placeLabel = multi ? "这几个位置" : domainRef.label;
  if (locations.length === 0) {
    // 项目级下一个项目都没有：没有位置，也就没有来源可管
    return (
      <LocationFrame
        filterText={filterText}
        onFilterText={setFilterText}
        actions={null}
        enabled={!addOpen && !manageOpen}
        bar={scopeBar}
        empty={{ description: NO_PROJECTS, hint: NO_PROJECTS_HINT, art: "noDirs" }}
      />
    );
  }
  if (pages.length === 0) {
    // 范围里没有一个位置扫描出页（没有 agent 目录）：`+ 来源` 已在页面头，空态不重复
    return (
      <LocationFrame
        filterText={filterText}
        onFilterText={setFilterText}
        actions={sourceKeys}
        enabled={!addOpen && !manageOpen}
        bar={scopeBar}
        empty={{
          description: `${placeLabel} 下还没有 agent 的 skill 目录`,
          hint: "加上第一个 skill 时会自动创建",
          art: "noDirs",
        }}
        hint={
          <HintStrip open={emptyHint.visible} onDismiss={emptyHint.dismiss}>
            {HINTS["first-scan-empty"](hintCtx)}
          </HintStrip>
        }
      >
        {sources.host}
        {placePicker}
        {managePage}
        {addPage}
      </LocationFrame>
    );
  }

  const keepConfirm = keepPane
    ? keepThisConfirm({
        kept: { ...keepPane.keptName, path: keepPane.keptPath },
        other: { ...keepPane.otherName, path: keepPane.otherPath },
        skill: keepPane.kept.skill,
        relinked: keepPane.relinked,
      })
    : null;

  const reveal = (path: string) => void api.revealInDir(path).catch((e) => onError(String(e)));
  // 筛选框（⌘F）同时匹配名字与来源名（R9）：来源名要跟「来源」列显示的一致（同名来源带区分片段），
  // 与 DomainView 同一个起名函数、同一组来源
  const originNamesMap = originNames(
    [...new Set(view.rows.map((row) => row.sourceId))],
    overview.sources,
  );
  const originLabelOf = (id: string) =>
    originText(
      originNamesMap.get(id) ?? {
        name: overview.sources.find((s) => s.id === id)?.label ?? id,
        seg: "",
      },
    );
  const visible = view.rows.filter((row) =>
    matchesFilter(filterText, row.skill, originLabelOf(row.sourceId)),
  );
  const hiddenRows = hidden;
  // 孤链行：点过的格先去掉；刚清完、数据里已没有的那一行，例行一行还在时照留
  const liveOrphans = view.orphans.map((o) => ({
    ...o,
    links: o.links.filter((l) => !orphanGone.has(cellKey(o.key, columnOfTarget(l.targetId)))),
  }));
  const ghost =
    orphanGhost !== null &&
    cellToast?.rowKey === orphanGhost.key &&
    !liveOrphans.some((o) => o.key === orphanGhost.key)
      ? orphanGhost
      : null;
  const orphans = ghost ? [...liveOrphans, ghost] : liveOrphans;

  return (
    <section className="mx-page">
      <DomainView
        overview={overview}
        view={view}
        placeLabel={placeLabel}
        rows={visible}
        stateOf={stateOf}
        hiddenRows={hiddenRows}
        dupReadout={dupReadout}
        onDupHover={dupHover}
        onKeepThis={(kept, other, at) => void keepThis(kept, other, at)}
        keepBusy={keepBusy}
        orphans={orphans}
        onClearOrphan={clearOrphan}
        filterText={filterText}
        onFilterText={setFilterText}
        onClearFilter={() => setFilterText("")}
        bar={scopeBar}
        onReveal={reveal}
        onCopyPath={(path) => void api.copyText(path).catch((e) => onError(String(e)))}
        onAddSource={place.openAdd}
        onManageSources={openManage}
        selected={selected}
        onSelectionChange={(next) => {
          setSelected(next);
          if (next.size === 0) setKeyToast(null);
        }}
        onCell={onCell}
        onBatch={(press) => void batch(press)}
        onUndo={() => undoRef.current?.()}
        canUndo={canUndo}
        shortcuts={!addOpen && !manageOpen}
        flash={flash}
        cellNotice={cellNotice}
        onDismissCellNotice={dismissNotice}
        rowToast={rowToast}
        keyToast={keyToast}
        cellToast={cellToast}
        keyBusy={keyBusy}
        cellBusy={splitBusy ?? originBusy}
        hint={
          <HintStrip open={skillsHint.visible} onDismiss={skillsHint.dismiss} flush>
            {HINTS["first-scan-skills"](hintCtx)}
          </HintStrip>
        }
        emptyHint={
          <HintStrip open={emptyHint.visible} onDismiss={emptyHint.dismiss}>
            {HINTS["first-scan-empty"](hintCtx)}
          </HintStrip>
        }
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
              }
            : null
        }
      />
      {globalToast ? <CornerToast>{globalToast}</CornerToast> : null}

      {keepConfirm && keepPane ? (
        <Confirm
          title={keepConfirm.title}
          confirmLabel="只留这份"
          onConfirm={() => void confirmKeep(keepPane)}
          onCancel={() => setKeepPane(null)}
        >
          {/* 标题下两行路径：决定删哪份的依据，不截断、太长就折行 */}
          {confirmPaths(keepConfirm)}
        </Confirm>
      ) : null}

      {deletePane ? (
        <Confirm
          title={deletePane.text.title}
          confirmLabel="删除"
          onConfirm={() => void confirmDeleteOriginal(deletePane)}
          onCancel={() => setDeletePane(null)}
        >
          {confirmPaths(deletePane.text)}
        </Confirm>
      ) : null}

      {splitPane ? (
        <Confirm
          title={splitConfirm(splitPane.agent).title}
          confirmLabel="拆开"
          onConfirm={() => void confirmSplit(splitPane.ref)}
          onCancel={() => setSplitPane(null)}
        >
          {splitConfirm(splitPane.agent).body}
        </Confirm>
      ) : null}

      {sources.host}
      {placePicker}
      {managePage}
      {addPage}
    </section>
  );
}
