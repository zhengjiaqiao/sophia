import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import DomainView, { skillCellKey, skillRowKey, type BatchPress } from "./DomainView";
import { BATCH_BUSY_DELAY_MS, cellKey } from "./Matrix";
import { orphanRows, type OrphanRow } from "./orphanRows";
import { originNames, originText, type OriginName } from "./originName";
import { addedOrigins, newOriginKey, originMatches } from "./originFilter";
import SourcesPage from "./pages/SourcesPage";
import { AddedToast, AddSourcePage } from "./pages/AddSourcePage";
import { addedParts, type CandidateEntry } from "./pages/addSourceView";
import { skillSourcesModel } from "./pages/sourcesModel";
import type { DomainRef } from "./pages/sourcesView";
import { pathsOfKey } from "./issues";
import { shortDate } from "./dateText";
import { CELL_TOAST_DWELL_MS, Confirm, Empty, IconPlus, Toast, TOAST_DWELL_MS } from "./ui";
import type { ConfirmAnchor } from "./ui";
import {
  batchBusyText,
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
  DomainRow,
  Overview,
  SyncReport,
  Target,
} from "./types";

/// 还没扫描出页的位置的显示名：项目取文件夹名（`project:/…/CardBox` → `CardBox`）
const folderLabel = (key: string): string =>
  key === "global"
    ? "全局"
    : (key
        .replace(/^project:/, "")
        .split(/[/\\]+/)
        .filter(Boolean)
        .pop() ?? key);

/// 写不进去的典型原因。命中时说人话，否则原样转述 core 给的那句
const NO_WRITE = /permission denied|os error 13|read-?only|只读|权限/i;

/// 「只留这份」确认框要的全部：体检结果先拿到，确认框才写得出几条链接改指
interface KeepPane {
  kept: DomainRow;
  other: DomainRow;
  anchor: ConfirmAnchor;
  planId: string;
  /// 两份的来源名（同名来源带区分片段，与原件位置列同一写法）与完整路径
  keptName: OriginName;
  otherName: OriginName;
  keptPath: string;
  otherPath: string;
  /// 要改指到留下那份的链接条数
  relinked: number;
}

export interface SkillsTabProps {
  overview: Overview | null;
  /// 自动同步规则；关链前写排除、开链前恢复都靠它（规则本身只在来源管理页管理）
  autoLinks: AutoLink[];
  busy: boolean;
  onBusy: (busy: boolean) => void;
  /// 侧栏选中的 DomainPage.key
  selectedKey: string;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
  /// 新问题提示的「查看」：一条问题的 key（`issueKey(kind, paths)`，也收行键 `来源|skill`）。
  /// 收到新值就滚到涉及的那一行（格、或整列的列头）并闪一下；处理完回调 `onFocused`，
  /// 壳在那里把它清回 undefined，下次跳同一条才会再触发
  focusKey?: string;
  onFocused?: () => void;
  /// 本次运行里刚加的来源（`newOriginKey`，壳上记着，切页签不丢）：筛选片带 `新`
  newOrigins: ReadonlySet<string>;
  onNewOrigins: (keys: string[]) => void;
}

/// Skills 页：两行工具行（筛选框 + 来源筛选片）+ 表格（DomainView → Matrix）。
///
/// 反馈的位置（DESIGN「提示条的位置」）：
/// - 单格：乐观更新 + 格子闪一下；成功再出例行一行（被点的那一行里紧跟名字，一次一条，约 4 秒淡出），
///   `撤销` 与 ⌘Z 同一条路径、撤后这一行直接消失；失败不出这一行，弹回 + 格下小黑窗说原因
/// - 批量：一行提示条贴在被按下的键下方，右对齐该键；动词与键一致，键上读数随之翻转
/// - 只留这份：先出锚定确认；确认后直接删，例行一行贴在留下那一行下方（无撤销）
/// - 孤链（原件已不在的失效链接，照样成一行）：点格即清除、不确认；例行一行出在那一行里（无撤销）
/// - 整个文件夹是链接：点该列任一格出锚定确认（锚在那一格上），确认后拆开、重扫；没成格下小黑窗说原因
/// - 自动规则在背后做了事：右下例行一行，右沿对齐面板右沿 + 撤销
export default function SkillsTab({
  overview,
  autoLinks,
  busy,
  onBusy,
  selectedKey,
  onRefresh,
  onError,
  focusKey,
  onFocused,
  newOrigins,
  onNewOrigins,
}: SkillsTabProps) {
  // 选中的行键。默认一行不选，选择条不出现（DESIGN「默认值」）；切换侧栏的位置时清空——
  // 跨位置保留会让人回到一个位置时看见「自己没勾过」的行已经勾着
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState("");
  // 按来源筛选（工具行第二行的来源片）；空＝全部。点片单选，加完来源时一次选中新加的几片
  const [originFilter, setOriginFilter] = useState<string[]>([]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  // 添加来源页（工具行 / 空态的 `+ 来源`）开着没有
  const [addOpen, setAddOpen] = useState(false);
  const closeAdd = useCallback(() => setAddOpen(false), []);
  // 乐观更新：格键 → 点下去之后该画成的状态；重扫回来后撤掉
  const [optimistic, setOptimistic] = useState<Map<string, CellState>>(new Map());
  // 写失败（目录写不进去）的格：扫描不产出 readOnly，只有真的写失败之后由这里构造
  const [readOnly, setReadOnly] = useState<Set<string>>(new Set());
  // 批量写入真的慢（> BATCH_BUSY_DELAY_MS）时，触发项旁的忙碌指示 + 一句
  const [keyBusy, setKeyBusy] = useState<{ keyId: string; label: string } | null>(null);
  const [flash, setFlash] = useState<{ keys: string[]; nonce: number }>();
  const [cellNotice, setCellNotice] = useState<{
    rowKey: string;
    columnId: string;
    text: string;
  } | null>(null);
  const [keyToast, setKeyToast] = useState<{ keyId: string; node: ReactNode } | null>(null);
  // 单格成功的例行一行（出在被点的那一行里）：一个槽位，新的替换旧的（id 变了重挂、计时从头来）
  const [cellToast, setCellToast] = useState<{
    id: number;
    rowKey: string;
    node: ReactNode;
  } | null>(null);
  const cellToastSeq = useRef(0);
  const [rowToast, setRowToast] = useState<{ rowKey: string; node: ReactNode } | null>(null);
  const [globalToast, setGlobalToast] = useState<ReactNode>(null);
  // 加完来源、开始滑回主视图：加上的那几个（等这一轮渲染拿到重扫后的页再筛）；工具行下的例行一行
  const [justAdded, setJustAdded] = useState<CandidateEntry[] | null>(null);
  const [addedToast, setAddedToast] = useState<{ key: number; parts: string[] } | null>(null);
  // 孤链格：点下去就先画成没有这一格（清除的目标状态），做成重扫后数据自己对上，没成弹回
  const [orphanGone, setOrphanGone] = useState<Set<string>>(new Set());
  // 刚清完的孤链行：数据里已经没有它了，例行一行还要在它里面待满 4 秒，这期间照原样留着
  const [orphanGhost, setOrphanGhost] = useState<OrphanRow | null>(null);
  // 「只留这份」挂起未提交时藏起来的另一份（行键）
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [dupReadout, setDupReadout] = useState<Map<string, string>>(new Map());
  const [focus, setFocus] = useState<{ rowKeys: string[]; columnId?: string; nonce: number }>();
  const focusedRef = useRef<string | undefined>(undefined);

  // 最近一次可撤销的操作（⌘Z 与提示条里的「撤销」走同一个）
  const undoRef = useRef<(() => void) | null>(null);
  // 单格操作排队执行：连点几格时一格一格来，不和彼此抢
  const queue = useRef<Promise<void>>(Promise.resolve());
  const enqueue = (job: () => Promise<void>) => {
    queue.current = queue.current.then(job, job);
    return queue.current;
  };
  // 同名两份「只留这份」的确认框：点了按钮、体检过、等用户拍板
  const [keepPane, setKeepPane] = useState<KeepPane | null>(null);
  // 「拆开」的确认框：点了整个文件夹是链接那一列的某一格（锚在那一格上）
  const [splitPane, setSplitPane] = useState<{
    ref: CellRef;
    agent: string;
    anchor?: ConfirmAnchor;
  } | null>(null);

  const pages = overview === null ? [] : overview.domains.filter((d) => d.key === selectedKey);
  const page: DomainPage | null = pages[0] ?? null;

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
  const dismissAdded = useCallback(() => setAddedToast(null), []);

  // 提示与弹层只属于当次选择；选择与筛选跨侧栏切换保留
  useEffect(() => {
    setSourcesOpen(false);
    setKeepPane(null);
    setSplitPane(null);
    setKeyToast(null);
    setCellToast(null);
    setRowToast(null);
    setCellNotice(null);
    setAddedToast(null);
    setSelected(new Set());
    setOriginFilter([]);
    undoRef.current = null;
  }, [selectedKey]);

  // 加完来源滑回主视图（DESIGN「添加来源」）：重扫已完，列表筛到新来源——工具行里它们的片选中
  // （加了几个选几片，列表是并集），工具行下例行一行 `✓ 已添加 …`；这几片记成 `新`
  useEffect(() => {
    if (justAdded === null || !overview) return;
    setJustAdded(null);
    if (!page) return;
    onNewOrigins(justAdded.map((e) => newOriginKey(page.key, e.id)));
    const order = page.rows.map((r) => r.sourceId);
    const ids = addedOrigins(
      justAdded.map((e) => e.id),
      order,
    );
    let parts: string[];
    if (ids.length > 0) {
      // 名字与片同一个起名函数、同一组来源（DomainView 的筛选片）；数量＝列表里并集的行数
      const names = originNames(order, overview.sources);
      parts = addedParts(
        ids.map((id) => originText(names.get(id)!)),
        page.rows.filter((r) => originMatches(ids, [r.sourceId])).length,
        "skill",
      );
      setFilterText("");
      setOriginFilter(ids);
    } else {
      // 新来源在这个位置下一行都没有：没有片可选，只交代加上了
      parts = addedParts(
        justAdded.map((e) => e.name),
        justAdded.reduce((n, e) => n + e.count, 0),
        "skill",
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

  // 单格失败的小黑窗 8 秒后收起
  useEffect(() => {
    if (!cellNotice) return;
    const timer = setTimeout(() => setCellNotice(null), TOAST_DWELL_MS.cannot);
    return () => clearTimeout(timer);
  }, [cellNotice]);

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
  /// 动词带方向：没能加到 X / 没能从 X 移除（「开启 X」会读成操作应用本身）
  const reasonOf = (target: string, reason: string, what: "link" | "unlink"): string => {
    const agent = targetByPath(target)?.label ?? target;
    return NO_WRITE.test(reason)
      ? `${agent} 的 skills 目录写不进去`
      : `${what === "link" ? `没能加到 ${agent}` : `没能从 ${agent} 移除`}：${reason}`;
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

  /// 写失败里「目录写不进去」的那些格记下来：格子画成斜杠环，点它就是再试一次
  const noteReadOnly = (failed: { ref: CellRef; reason: string }[], retried: CellRef[]) =>
    setReadOnly((prev) => {
      const next = new Set(prev);
      for (const ref of retried) next.delete(skillCellKey(ref));
      for (const f of failed) if (/写不进去/.test(f.reason)) next.add(skillCellKey(f.ref));
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

  // ===== 单格：乐观更新 + 闪一下；成功出例行一行 =====

  /// 单格成功：被点的那一行里紧跟名字出 `✓ 加到 [Codex]`（行已说明对象，不重复名字），替换上一条。
  /// 不带撤销（DESIGN「单格操作出例行一行，不带撤销」：再点一下格子就恢复了，⌘Z 照旧可用）；
  /// 约 4 秒淡出，悬停不停表
  const showCellToast = (id: number, op: "link" | "unlink", ref: CellRef) => {
    const text = toastFor(op, { done: toastItems([ref]), omitNames: true });
    setCellToast({
      id,
      rowKey: skillRowKey(ref),
      node: <Toast {...text} dwellMs={CELL_TOAST_DWELL_MS} fadeOut onDismiss={dismissCell} />,
    });
  };

  /// `undoing`：这是撤销本身——做成了不再出例行一行，也不再留可撤销的操作
  const toggleCell = (ref: CellRef, from: CellState, undoing = false) => {
    const key = skillCellKey(ref);
    const rowKey = skillRowKey(ref);
    setCellNotice(null);

    // 失效的链接：点一下就是重新链接——先清掉指不到东西的那条，再建一条指向这一行的原件
    if (from === "broken") {
      const cell = findCell(ref);
      const stale = page?.broken.find((a) => a.targetPath === cell?.path);
      setOptimisticFor([ref], "linked");
      setFlash({ keys: [key], nonce: Date.now() });
      void enqueue(async () => {
        try {
          if (stale) await api.applyAll([stale], true);
          const result = await run("link", [ref]);
          if (result.failed.length > 0) {
            setCellNotice({ rowKey, columnId: ref.targetId, text: result.failed[0].reason });
          } else {
            // 重新链接没有可撤销的反面：出一行交代，不带撤销
            undoRef.current = null;
            showCellToast(++cellToastSeq.current, "link", ref);
          }
          await onRefresh();
        } catch (e) {
          setCellNotice({ rowKey, columnId: ref.targetId, text: String(e) });
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
          // 弹回 + 格下小黑窗说原因
          setOptimisticFor([ref], null);
          setCellNotice({ rowKey, columnId: ref.targetId, text: result.failed[0].reason });
        } else if (!undoing) {
          const back = op === "link" ? "linked" : "missing";
          const id = ++cellToastSeq.current;
          // ⌘Z 撤最新这一次；撤了这一行直接消失，不另出「已撤销」
          const undo = () => {
            if (undoRef.current === undo) undoRef.current = null;
            setCellToast((prev) => (prev?.id === id ? null : prev));
            toggleCell(ref, back, true);
          };
          undoRef.current = undo;
          showCellToast(id, op, ref);
        }
        await onRefresh();
      } catch (e) {
        setCellNotice({ rowKey, columnId: ref.targetId, text: String(e) });
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
    // 写不进去：再试一次就是再开一次
    else if (state === "readOnly") toggleCell(ref, "missing");
    // 整个文件夹是链接：先确认拆开（锚在被点的那一格上）
    else if (state === "wholeLinked") askSplit(ref);
  };

  // ===== 整个文件夹是链接：点该列任一格 → 锚定确认 → 拆开 =====

  const askSplit = (ref: CellRef) => {
    setCellNotice(null);
    const index = page?.targets.findIndex((t) => t.id === ref.targetId) ?? -1;
    const row = document.querySelector(`[data-row="${CSS.escape(skillRowKey(ref))}"]`);
    const r = row?.querySelectorAll(".mx-cell")[index]?.getBoundingClientRect();
    setSplitPane({
      ref,
      agent: targetOf(ref.targetId)?.label ?? "",
      anchor: r ? { top: r.top, left: r.left, right: r.right, bottom: r.bottom } : undefined,
    });
  };

  /// 确认之后拆开；做成了重扫（整列的记号自己变回逐格状态），没成就在被点那一格下说原因
  const confirmSplit = async (ref: CellRef) => {
    setSplitPane(null);
    onBusy(true);
    try {
      const report = await api.splitWholeLink(ref.targetId);
      const failed = report.entries.filter((e) => e.outcome.status === "failed");
      const first = failed[0]?.outcome;
      if (first && first.status === "failed") {
        const created = report.entries.filter((e) => e.outcome.status === "created").length;
        setCellNotice({
          rowKey: skillRowKey(ref),
          columnId: ref.targetId,
          text:
            created === 0
              ? `没拆开：${first.reason}`
              : `拆开了，但有 ${failed.length} 个没复制过来：${first.reason}`,
        });
      }
    } catch (e) {
      onError(String(e));
    } finally {
      onBusy(false);
    }
    await onRefresh();
  };

  // ===== 孤链：点格清除，不确认（链接本来就指向空处）；没有撤销——重建一条指向空处的链接没有意义 =====

  const clearOrphan = (orphan: OrphanRow, targetId: string) => {
    const link = orphan.links.find((l) => l.targetId === targetId);
    if (!link) return;
    const key = cellKey(orphan.key, targetId);
    setCellNotice(null);
    setOrphanGone((prev) => new Set(prev).add(key));
    setFlash({ keys: [key], nonce: Date.now() });
    void enqueue(async () => {
      try {
        const report = await api.applyAll([link.clear], true);
        const bad = report.entries.find((e) => e.outcome.status === "failed");
        if (bad && bad.outcome.status === "failed") {
          setCellNotice({
            rowKey: orphan.key,
            columnId: targetId,
            text: `没能清除：${bad.outcome.reason}`,
          });
        } else {
          undoRef.current = null;
          setOrphanGhost({ ...orphan, links: orphan.links.filter((l) => l.targetId !== targetId) });
          const text = toastFor("clear", {
            done: [{ name: orphan.skill, agent: agentRef(targetOf(targetId)) }],
            omitNames: true,
          });
          setCellToast({
            id: ++cellToastSeq.current,
            rowKey: orphan.key,
            node: (
              <Toast {...text} dwellMs={CELL_TOAST_DWELL_MS} holdOnHover onDismiss={dismissCell} />
            ),
          });
        }
        await onRefresh();
      } catch (e) {
        setCellNotice({ rowKey: orphan.key, columnId: targetId, text: String(e) });
      } finally {
        setOrphanGone((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    });
  };

  // ===== 批量：提示条贴在被按下的键下方 =====

  const toastItems = (refs: CellRef[]): ToastItem[] =>
    refs.map((ref) => ({ name: ref.skill, agent: agentRef(targetOf(ref.targetId)) }));

  const batch = async ({ keyId, op, cells }: BatchPress, undoing = false) => {
    if (cells.length === 0) return;
    setKeyToast(null);
    setCellToast(null);
    setCellNotice(null);
    // 格子同时变成新状态，不闪、不依次点亮；真的慢才在触发项旁出忙碌指示 + 一句（DESIGN「选择操作条」）
    setOptimisticFor(cells, op === "link" ? "linked" : "missing");
    const agent = keyId === "all" ? "所有 agent" : (targetOf(keyId)?.label ?? "");
    const slow = keyId
      ? setTimeout(
          () => setKeyBusy({ keyId, label: batchBusyText(op, agent) }),
          BATCH_BUSY_DELAY_MS,
        )
      : undefined;
    onBusy(true);
    let result: Awaited<ReturnType<typeof run>> | null = null;
    try {
      result = await run(op, cells);
    } catch (e) {
      onError(String(e));
    } finally {
      onBusy(false);
      clearTimeout(slow);
      setKeyBusy(null);
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
      const undo =
        done.length > 0 && !undoing
          ? () => {
              undoRef.current = null;
              void batch({ keyId, op: op === "link" ? "unlink" : "link", cells: done }, true);
            }
          : null;
      undoRef.current = undo;
      setKeyToast({
        keyId,
        node: (
          <Toast
            {...text}
            // 键行左侧空白窄：写数量，不逐个写名字（`✓ 加到 ✳ 1 个 · 撤销`）；名字在键的提示框里
            names={text.kind === "success" ? undefined : text.names}
            reading={text.kind === "success" ? `${done.length} 个` : undefined}
            action={undo ? { label: "撤销", onClick: undo } : undefined}
            onDismiss={dismissKey}
            onClose={text.tier === "notice" ? dismissKey : undefined}
          />
        ),
      });
    }
    await onRefresh();
    setOptimisticFor(cells, null);
  };

  // ===== 同名：只留这份 =====
  // DESIGN「页面还是弹层」：删用户的原件先确认（锚在按钮上），确认后直接删、不挂起；
  // 结果是例行一行、不带撤销——废纸篓只找得回文件夹，改指过的链接回不来

  const keepThis = async (kept: DomainRow, other: DomainRow, anchor: ConfirmAnchor) => {
    const sources = overview?.sources ?? [];
    // 与原件位置列同一套：按本域出现的来源算，同名来源才分得开
    const names = originNames(
      (page?.rows ?? [kept, other]).map((r) => r.sourceId),
      sources,
    );
    const nameOf = (id: string): OriginName => names.get(id) ?? { name: id, seg: "" };
    const source = sources.find((s) => s.id === kept.sourceId);
    const keptPath =
      source?.skills.find((k) => k.name === kept.skill)?.path ??
      `${source?.path ?? kept.sourceId}/${kept.skill}`;
    const rowKey = skillRowKey(kept);
    let planned;
    try {
      planned = await api.planDeleteSource(other.sourceId, other.skill);
    } catch (e) {
      onError(String(e));
      return;
    }
    if (planned.plan.inGit !== null) {
      setRowToast({
        rowKey,
        node: (
          <Toast
            kind="cannot"
            verb="没删掉"
            names={[other.skill]}
            reason={`另一份在 git 仓库 ${planned.plan.inGit} 里，交给 git 处理更稳妥，这里不代删`}
            onDismiss={() => setRowToast(null)}
            onClose={() => setRowToast(null)}
          />
        ),
      });
      return;
    }
    setKeepPane({
      kept,
      other,
      anchor,
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
    try {
      let report: SyncReport;
      try {
        report = await api.deleteSource(pane.planId);
      } catch {
        // 计划只存一份，悬停读数时可能被换掉了：重新体检一次再删（仓库里的照旧不代删）
        const again = await api.planDeleteSource(other.sourceId, other.skill);
        if (again.plan.inGit !== null)
          throw new Error(`它在 git 仓库 ${again.plan.inGit} 里，这里不代删`);
        report = await api.deleteSource(again.planId);
      }
      const bad = report.entries.find((e) => e.outcome.status === "failed");
      if (bad && bad.outcome.status === "failed") {
        setGlobalToast(
          <Toast
            kind="cannot"
            verb="没删掉"
            names={[other.skill]}
            reason={bad.outcome.reason}
            onDismiss={dismissGlobal}
            onClose={dismissGlobal}
          />,
        );
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
    setRowToast({
      rowKey: skillRowKey(kept),
      node: <Toast {...text} onDismiss={() => setRowToast(null)} />,
    });
  };

  /// 同名两份的读数：×2 的提示框要同时列两份，所以一次把同名的几份都取了（取过的不再取）
  const dupHover = (row: DomainRow) => {
    for (const copy of page?.rows.filter((r) => r.skill === row.skill) ?? [row]) readoutOf(copy);
  };
  const readoutOf = (row: DomainRow) => {
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

  // ===== 自动规则在背后做了事：右下例行一行 + 撤销；格子直接是新状态，不闪 =====

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
              undoRef.current = null;
              setGlobalToast(null);
              void batchRef.current({ keyId: "", op: "unlink", cells: refs }, true);
            }
          : null;
      undoRef.current = undo;
      const text = toastFor("autoLink", { done: items });
      setGlobalToast(
        <Toast
          {...text}
          names={items.length > 2 ? undefined : text.names}
          reading={items.length > 2 ? `${items.length} 个` : undefined}
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

  // ===== 新问题提示「查看」：滚到那一行并闪两下 =====

  useEffect(() => {
    if (focusKey === undefined) {
      focusedRef.current = undefined;
      return;
    }
    if (!overview || !page || focusedRef.current === focusKey) return;
    focusedRef.current = focusKey;
    // key 里带着涉及的全部路径（与 core 同公式、不取摘要）：原件路径 / 格路径认行，目标路径认列
    const paths = new Set(pathsOfKey(focusKey));
    const rowKeys: string[] = [];
    let columnId: string | undefined;
    for (const row of page.rows) {
      const own = overview.sources
        .find((s) => s.id === row.sourceId)
        ?.skills.find((k) => k.name === row.skill)?.path;
      const cell = row.cells.find((c) => paths.has(c.path));
      if (skillRowKey(row) === focusKey || (own !== undefined && paths.has(own)) || cell) {
        rowKeys.push(skillRowKey(row));
        if (cell) columnId = cell.targetId;
      }
    }
    // 孤链行：没有原件，靠链接自己的路径认
    for (const orphan of orphanRows(page)) {
      if (orphan.links.some((l) => paths.has(l.clear.targetPath))) rowKeys.push(orphan.key);
    }
    if (rowKeys.length === 0) columnId = page.targets.find((t) => paths.has(t.path))?.id;
    // 要跳的行被筛掉了：先清筛选，不然跳过去是空的
    if (rowKeys.length > 0) {
      setFilterText("");
      setOriginFilter([]);
    }
    setFocus({ rowKeys, columnId, nonce: Date.now() });
    onFocused?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, overview, page?.key]);

  // ===== 渲染 =====

  /// 添加来源页：加好后主视图重扫，滑回主视图；全加上时列表筛到新来源 + 例行一行（见上）
  const addPage = (domain: DomainRef, targets: Target[]) =>
    addOpen ? (
      <AddSourcePage
        model={skillSourcesModel(domain, targets)}
        domain={domain}
        onClose={closeAdd}
        onAdded={onRefresh}
        onAllAdded={setJustAdded}
      />
    ) : null;

  if (!overview) {
    return <Empty kind="scanning" description="正在读 skill 目录" art="horizon" />;
  }
  if (page === null) {
    return (
      <>
        <Empty
          kind="noAgentDirs"
          description="这个项目下还没有 agent 的 skill 目录"
          primary={{ label: "来源", icon: <IconPlus size={12} />, onClick: () => setAddOpen(true) }}
          art="folders"
        />
        {/* 这个位置还没有扫描出来的页：名字取项目文件夹名，没有列可当目标 */}
        {addPage({ key: selectedKey, label: folderLabel(selectedKey) }, [])}
      </>
    );
  }

  const query = filterText.trim().toLowerCase();
  const keepConfirm = keepPane
    ? keepThisConfirm({
        kept: { ...keepPane.keptName, path: keepPane.keptPath },
        other: { ...keepPane.otherName, path: keepPane.otherPath },
        skill: keepPane.kept.skill,
        relinked: keepPane.relinked,
      })
    : null;

  const visible = page.rows.filter(
    (row) =>
      (query === "" || row.skill.toLowerCase().includes(query)) &&
      originMatches(originFilter, [row.sourceId]),
  );
  const hiddenRows = hidden;
  // 孤链行：点过的格先去掉；刚清完、数据里已没有的那一行，例行一行还在时照留
  const liveOrphans = orphanRows(page).map((o) => ({
    ...o,
    links: o.links.filter((l) => !orphanGone.has(cellKey(o.key, l.targetId))),
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
        page={page}
        rows={visible}
        stateOf={stateOf}
        hiddenRows={hiddenRows}
        dupReadout={dupReadout}
        onDupHover={dupHover}
        onKeepThis={(kept, other, anchor) => void keepThis(kept, other, anchor)}
        orphans={orphans}
        onClearOrphan={clearOrphan}
        busy={busy}
        filterText={filterText}
        onFilterText={setFilterText}
        onClearFilter={() => {
          setFilterText("");
          setOriginFilter([]);
        }}
        originFilter={originFilter}
        onOriginFilter={setOriginFilter}
        isNewOrigin={(id) => newOrigins.has(newOriginKey(page.key, id))}
        onReveal={(path) => void api.revealInDir(path).catch((e) => onError(String(e)))}
        onSources={() => setSourcesOpen(true)}
        onAddSource={() => setAddOpen(true)}
        selected={selected}
        onSelectionChange={(next) => {
          setSelected(next);
          if (next.size === 0) setKeyToast(null);
        }}
        onCell={onCell}
        onBatch={(press) => void batch(press)}
        onUndo={() => undoRef.current?.()}
        shortcuts={!sourcesOpen && !addOpen}
        flash={flash}
        cellNotice={cellNotice}
        rowToast={rowToast}
        keyToast={keyToast}
        cellToast={cellToast}
        keyBusy={keyBusy}
        globalToast={globalToast}
        barToast={
          addedToast ? (
            <AddedToast key={addedToast.key} parts={addedToast.parts} onDismiss={dismissAdded} />
          ) : null
        }
        focus={focus}
      />

      {keepConfirm && keepPane ? (
        <Confirm
          title={keepConfirm.title}
          confirmLabel="只留这份"
          onConfirm={() => void confirmKeep(keepPane)}
          onCancel={() => setKeepPane(null)}
          anchor={keepPane.anchor}
        >
          {/* 标题下两行路径：决定删哪份的依据，不截断、太长就折行 */}
          <div className="mx-keeppaths">
            {keepConfirm.paths.map((p) => (
              <div key={p.label} className="mx-keeppaths__row">
                <span className="mx-keeppaths__label">{p.label}</span>
                <span className="mx-keeppaths__path">{p.path}</span>
              </div>
            ))}
          </div>
          <div className="mx-keeppaths__body">{keepConfirm.body}</div>
        </Confirm>
      ) : null}

      {splitPane ? (
        <Confirm
          title={splitConfirm(splitPane.agent).title}
          confirmLabel="拆开"
          onConfirm={() => void confirmSplit(splitPane.ref)}
          onCancel={() => setSplitPane(null)}
          anchor={splitPane.anchor}
        >
          {splitConfirm(splitPane.agent).body}
        </Confirm>
      ) : null}

      {addPage(page, page.targets)}

      {sourcesOpen && (
        <SourcesPage
          kind="skill"
          domain={page}
          targets={page.targets}
          onClose={() => setSourcesOpen(false)}
          onChange={onRefresh}
          onSourcesAdded={(ids) => onNewOrigins(ids.map((id) => newOriginKey(page.key, id)))}
        />
      )}
    </section>
  );
}
