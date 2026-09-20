import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import DomainView, { ActionButton, dim, type UnlinkTarget } from "./DomainView";
import ImportDialog from "./ImportDialog";
import { viewOf } from "./cellState";
import { issueKey } from "./pages/pendingIssues";
import { Empty, Toast, type ToastKind } from "./ui";
import type {
  AutoLink,
  Cell,
  CellRef,
  DomainPage,
  DomainRow,
  IssueKind,
  Overview,
  PlannedAction,
  ReportEntry,
  SyncReport,
  Target,
} from "./types";

/// 选择状态的键：域 + 本体位置 + skill
const rowKey = (page: DomainPage, row: DomainRow) => `${page.key}|${row.sourceId}|${row.skill}`;

/// 一行展开成它在本域各目标上的格
const cellsOf = (row: DomainRow): CellRef[] =>
  row.cells.map((c) => ({ sourceId: row.sourceId, skill: row.skill, targetId: c.targetId }));

/// 与 crates/core/src/store.rs 的 `IgnoredIssue::key_for` 同构：类别 + 全部路径排序后
/// 用 Unit Separator 拼起来。core 那边**不取摘要、直接留可读路径串**，所以前端算得出
/// 同一个 key，`list_ignored` 返回的记录才对得上具体某一条状况

/// 写不进去的典型原因。命中时说人话（§8 的语料），否则原样转述 core 给的那句
const NO_WRITE = /permission denied|os error 13|read-?only|只读|权限/i;

/// 区域标签档（§1.2）
const LABEL: CSSProperties = {
  fontFamily: "var(--font-cond)",
  fontSize: "var(--size-label)",
  fontWeight: 600,
  letterSpacing: "var(--track-label)",
  textTransform: "uppercase",
};
const MONO: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: "var(--size-mono)" };

/// 待处理栏：主视图底部常驻一条，一次一条，处理完跳下一条（§4.3）
const PENDING_BAR: CSSProperties = {
  position: "sticky",
  bottom: 0,
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  marginTop: 16,
  padding: "9px 0",
  borderTop: "1px solid var(--ink)",
  background: "var(--canvas)",
};

/// 提示条的内容；一次操作只汇总成一句，新的替换旧的（§4.1）
interface Notice {
  kind: ToastKind;
  message: ReactNode;
  /// 副行等宽统计
  stats?: string;
  /// 「撤销」只在可逆时给；部分失败给「查看」跳待处理栏
  action?: { label: string; onClick: () => void };
}

/// 待处理栏里的一条：要用户拿主意，且带得出自己的动作
interface Pending {
  key: string;
  kind: IssueKind;
  /// 一句完整的话，来自 cellState.viewOf，不在这里另写一份
  message: string;
  /// 组 key 的路径，忽略时原样交给后端
  paths: string[];
  /// 链接失效：要清掉的那条
  broken?: PlannedAction;
  /// 整目录链到别处：拆开哪一列
  splitTargetId?: string;
  /// 目录写不进去：再试一次要用的格
  retry?: CellRef;
}

export interface SkillsTabProps {
  overview: Overview | null;
  /// 自动同步规则；域页列出、关链前据此写排除
  autoLinks: AutoLink[];
  busy: boolean;
  onBusy: (busy: boolean) => void;
  /// 侧栏选中：`"all"` 或某个 DomainPage.key
  selectedKey: string;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
  /// 打开「待处理」二级页面；App 壳接上之前先按不动（T10）
  onOpenPending?: () => void;
}

/// 域页容器：工具栏 + 筛选行 + 选择操作条 + 各域矩阵 + 底部待处理栏
export default function SkillsTab({
  overview,
  autoLinks,
  busy,
  onBusy,
  selectedKey,
  onRefresh,
  onError,
  onOpenPending,
}: SkillsTabProps) {
  const [notice, setNotice] = useState<Notice | null>(null);
  // 选中的行，默认为空；键见 rowKey
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Shift 区间选择的锚点：域 key → 上次点击的行键
  const [anchor, setAnchor] = useState<Map<string, string>>(new Map());
  // 筛选：skill 名子串（大小写不敏感）+ 每个域各自高亮的本体位置（空 = 不筛）
  const [filterText, setFilterText] = useState("");
  const [filterSources, setFilterSources] = useState<Map<string, Set<string>>>(new Map());
  const [importOpen, setImportOpen] = useState(false);
  // 已忽略的状况；key 与 settings.json 里落盘的那份同构
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  // 待处理栏当前停在第几条
  const [cursor, setCursor] = useState(0);
  // 「查看」把待处理栏直接翻到这条路径那一项
  const [focusPath, setFocusPath] = useState<string | null>(null);
  // 目录写不进去：扫描永远不产出这个状态，只有真的写失败之后才由这里构造（§8）。
  // 存的是格本身，「再试一次」要原样把它再交给 propose_links
  const [writeFails, setWriteFails] = useState<CellRef[]>([]);

  // 后端扫描后按规则自动补的链，用同一条提示条汇总
  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void> = [];
    void listen<SyncReport>("auto-linked", ({ payload }) => {
      const n = payload.entries.filter((e) => e.outcome.status === "created").length;
      if (n === 0) return;
      setNotice({ kind: "success", message: `自动同步开启了 ${n} 处`, stats: `${n} 条链接` });
    }).then((un) => (disposed ? un() : unlistens.push(un)));
    return () => {
      disposed = true;
      unlistens.forEach((un) => un());
    };
  }, []);

  // 忽略过的状况跨重启仍然静音，进来先把它们取回来
  useEffect(() => {
    void api
      .listIgnored()
      .then((list) => setIgnored(new Set(list.map((i) => i.key))))
      .catch((e) => onError(String(e)));
    // 只在挂载时取一次；之后的增量由「忽略」自己维护
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 重扫后高亮的本体位置在该域已没有行（比如它的链接刚被清光）→ 自动取消这个筛选，
  // 否则表格会莫名其妙地空着
  useEffect(() => {
    if (!overview) return;
    setFilterSources((prev) => {
      let changed = false;
      const next = new Map<string, Set<string>>();
      for (const [key, ids] of prev) {
        const page = overview.domains.find((d) => d.key === key);
        const present = new Set(page?.rows.map((r) => r.sourceId) ?? []);
        const kept = new Set([...ids].filter((id) => present.has(id)));
        if (kept.size !== ids.size) changed = true;
        if (kept.size > 0) next.set(key, kept);
      }
      return changed ? next : prev;
    });
  }, [overview]);

  // 提示与弹层只属于当次选择；选择与筛选跨侧栏切换保留
  useEffect(() => {
    setNotice(null);
    setImportOpen(false);
    setFocusPath(null);
    setCursor(0);
  }, [selectedKey]);

  const pages =
    overview === null
      ? []
      : selectedKey === "all"
        ? overview.domains
        : overview.domains.filter((d) => d.key === selectedKey);

  const targetOf = (targetId: string): Target | null =>
    pages.flatMap((p) => p.targets).find((t) => t.id === targetId) ?? null;
  const targetByPath = (path: string): Target | null =>
    pages.flatMap((p) => p.targets).find((t) => t.path === path) ?? null;
  const agentOf = (path: string) => targetByPath(path)?.label ?? path;
  const findCell = (ref: CellRef): Cell | null => {
    for (const page of pages) {
      for (const row of page.rows) {
        if (row.sourceId !== ref.sourceId || row.skill !== ref.skill) continue;
        // 同一个本体位置可能在多个域里各有一行，认准带着这个目标的那一行
        const cell = row.cells.find((c) => c.targetId === ref.targetId);
        if (cell) return cell;
      }
    }
    return null;
  };

  /// 经过筛选、要显示出来的行；顺序仍是后端原序，排序由 DomainView 做
  const visibleRows = (page: DomainPage): DomainRow[] => {
    const query = filterText.trim().toLowerCase();
    const sources = filterSources.get(page.key);
    return page.rows.filter(
      (row) =>
        (query === "" || row.skill.toLowerCase().includes(query)) &&
        (sources === undefined || sources.size === 0 || sources.has(row.sourceId)),
    );
  };

  const isSelected = (page: DomainPage, row: DomainRow) => selected.has(rowKey(page, row));

  /// 点行首复选框：Shift 时把锚点到本行之间（按当前显示顺序）的行都设成本次的状态
  const toggleRow = (page: DomainPage, row: DomainRow, shiftKey: boolean, ordered: DomainRow[]) => {
    const key = rowKey(page, row);
    const want = !selected.has(key);
    const anchorKey = anchor.get(page.key);
    const from =
      shiftKey && anchorKey !== undefined
        ? ordered.findIndex((r) => rowKey(page, r) === anchorKey)
        : -1;
    const to = ordered.findIndex((r) => rowKey(page, r) === key);
    const span =
      from >= 0 && to >= 0 ? ordered.slice(Math.min(from, to), Math.max(from, to) + 1) : [row];
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of span) {
        if (want) next.add(rowKey(page, r));
        else next.delete(rowKey(page, r));
      }
      return next;
    });
    setAnchor((prev) => new Map(prev).set(page.key, key));
  };

  /// 表头复选框：只作用于当前可见行
  const setPageAll = (page: DomainPage, want: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const row of visibleRows(page)) {
        if (want) next.add(rowKey(page, row));
        else next.delete(rowKey(page, row));
      }
      return next;
    });

  const toggleSourceFilter = (page: DomainPage, sourceId: string) =>
    setFilterSources((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(page.key) ?? []);
      if (set.has(sourceId)) set.delete(sourceId);
      else set.add(sourceId);
      next.set(page.key, set);
      return next;
    });

  const clearFilter = () => {
    setFilterText("");
    setFilterSources(new Map());
  };

  // ===== 操作 =====

  /// 这批格里，被自动同步规则覆盖、且当前在排除名单上的 skill。
  /// 点开时要把它们放回规则里（§12 第四行）：否则链接建着、却仍被标记排除，
  /// 下一轮自动同步不再维护它
  const toInclude = (cells: CellRef[]) => {
    const seen = new Set<string>();
    const out: { source: string; skill: string }[] = [];
    for (const c of cells) {
      const id = `${c.sourceId}|${c.skill}`;
      if (seen.has(id)) continue;
      const covered = autoLinks.some(
        (r) =>
          r.source === c.sourceId && r.excluded.includes(c.skill) && r.targets.includes(c.targetId),
      );
      if (!covered) continue;
      seen.add(id);
      out.push({ source: c.sourceId, skill: c.skill });
    }
    return out;
  };

  /// 这批格里，仍在某条自动同步规则范围内的 skill：关掉前必须先写排除，
  /// 否则下一轮扫描立刻把链接补回来（§5）
  const toExclude = (cells: CellRef[]) => {
    const seen = new Set<string>();
    const out: { source: string; skill: string }[] = [];
    for (const c of cells) {
      const id = `${c.sourceId}|${c.skill}`;
      if (seen.has(id)) continue;
      const covered = autoLinks.some(
        (r) =>
          r.source === c.sourceId &&
          !r.excluded.includes(c.skill) &&
          r.targets.includes(c.targetId),
      );
      if (!covered) continue;
      seen.add(id);
      out.push({ source: c.sourceId, skill: c.skill });
    }
    return out;
  };

  /// 执行一批动作。排除/恢复在动作之前写，顺序不能反
  const apply = async (
    actions: PlannedAction[],
    opts: {
      cleanBroken?: boolean;
      exclude?: { source: string; skill: string }[];
      include?: { source: string; skill: string }[];
    } = {},
  ): Promise<SyncReport | null> => {
    onBusy(true);
    try {
      for (const r of opts.exclude ?? []) await api.excludeAutoLink(r.source, r.skill);
      for (const r of opts.include ?? []) await api.includeAutoLink(r.source, r.skill);
      return await api.applyAll(actions, opts.cleanBroken ?? false);
    } catch (e) {
      onError(String(e));
      return null;
    } finally {
      onBusy(false);
    }
  };

  /// 这条没做成的原因，一句人话：说原因，不说「失败」（§4.1）
  const failureText = (entry: ReportEntry, what: "开启" | "关掉"): string => {
    const agent = agentOf(entry.action.target);
    const reason = entry.outcome.status === "failed" ? entry.outcome.reason : "";
    return NO_WRITE.test(reason)
      ? `${agent} 的 skills 目录写不进去`
      : `${agent} 下没能${what}：${reason}`;
  };

  /// 开启：**成功句在这里汇总**，不向 viewOf 要。
  /// 按 §4.1 一次操作只出一句——三个格开启只该出「在 3 个 agent 下开启了 X」，不是三条提示条
  const link = async (cells: CellRef[]) => {
    const missing = cells.filter((c) => findCell(c)?.state === "missing");
    let actions: PlannedAction[];
    try {
      actions = await api.proposeLinks(cells);
    } catch (e) {
      onError(String(e));
      return;
    }
    if (actions.length === 0) {
      // 这句话只对「真的已经都开着」成立；四种异常态在点格那一刻就被 viewOf 拦下了
      setNotice({ kind: "cannot", message: "选中的这些格已经开着了，没有要新开的" });
      return;
    }
    // 目录还不存在的那些目标：建链时顺手建出来，提示条要说这件事
    const newDirs = new Set(
      actions.map((a) => a.target).filter((p) => targetByPath(p)?.exists === false),
    );
    const include = toInclude(missing);
    const report = await apply(actions, { include });
    setWriteFails([]);
    if (report !== null) {
      const ok = report.entries.filter((e) => e.outcome.status === "created");
      const bad = report.entries.filter((e) => e.outcome.status === "failed");
      // 写不进去的那些进待处理栏：扫描永远不产出 readOnly，只有真的写失败之后才由这里构造（§8）。
      // 别的原因（比如路径被别的进程占住）不属于这四类问题，只在提示条里说一次
      const noWrite = bad.filter(
        (e) => e.outcome.status === "failed" && NO_WRITE.test(e.outcome.reason),
      );
      setWriteFails(
        noWrite
          .map((e) => missing.find((c) => findCell(c)?.path === e.action.targetPath))
          .filter((c): c is CellRef => c !== undefined),
      );
      const skills = new Set(report.entries.map((e) => e.action.itemName));
      const one = [...skills][0];
      const undo = () => void unlink(missing, include);
      if (bad.length === 0) {
        const created = newDirs.size;
        const message =
          ok.length === 1
            ? created > 0
              ? `${agentOf(ok[0].action.target)} 下还没有 skills 目录，已经建出来，并把 ${one} 链了进去`
              : `在 ${agentOf(ok[0].action.target)} 下开启了 ${one}`
            : skills.size === 1
              ? `在 ${ok.length} 个 agent 下开启了 ${one}`
              : `在 ${ok.length} 处开启了 ${skills.size} 个 skill`;
        setNotice({
          kind: "success",
          message,
          stats:
            created > 0 ? `新建了 ${created} 个目录 · ${ok.length} 条链接` : `${ok.length} 条链接`,
          action: { label: "撤销", onClick: undo },
        });
      } else if (ok.length === 0) {
        setNotice({ kind: "cannot", message: failureText(bad[0], "开启") });
      } else {
        setNotice({
          kind: "partial",
          message: `开启了 ${ok.length} 个，${bad.length} 个没成——${failureText(bad[0], "开启")}`,
          // 「查看」只在这条确实进了待处理栏时才给，不给一个跳不到地方的动作
          action:
            noWrite.length > 0
              ? {
                  label: "查看",
                  onClick: () => setFocusPath(targetByPath(noWrite[0].action.target)?.path ?? null),
                }
              : undefined,
        });
      }
    }
    await onRefresh();
  };

  /// 关掉：可逆，所以不确认（§5），提示条里给撤销
  const unlink = async (cells: CellRef[], reInclude: { source: string; skill: string }[] = []) => {
    let actions: PlannedAction[];
    try {
      actions = await api.proposeUnlinks(cells);
    } catch (e) {
      onError(String(e));
      return;
    }
    if (actions.length === 0) {
      setNotice({ kind: "cannot", message: "这些格上没有可以关掉的链接" });
      return;
    }
    const exclude = [...toExclude(cells), ...reInclude];
    const report = await apply(actions, { exclude });
    if (report !== null) {
      const ok = report.entries.filter((e) => e.outcome.status === "removed");
      const bad = report.entries.filter((e) => e.outcome.status === "failed");
      const skills = new Set(report.entries.map((e) => e.action.itemName));
      const one = [...skills][0];
      const tail = exclude.length > 0 ? "，已不再自动同步" : "";
      if (bad.length === 0) {
        const message =
          ok.length === 1
            ? `关掉了 ${one} 在 ${agentOf(ok[0].action.target)} 下的链接${tail}`
            : skills.size === 1
              ? `关掉了 ${one} 在 ${ok.length} 个 agent 下的链接${tail}`
              : `关掉了 ${ok.length} 条链接${tail}`;
        setNotice({
          kind: "success",
          message,
          stats: `${ok.length} 条链接`,
          action: { label: "撤销", onClick: () => void link(cells) },
        });
      } else if (ok.length === 0) {
        setNotice({ kind: "cannot", message: failureText(bad[0], "关掉") });
      } else {
        setNotice({
          kind: "partial",
          // 关不掉不属于待处理栏的四类问题，所以这里没有「查看」可跳
          message: `关掉了 ${ok.length} 个，${bad.length} 个没成——${failureText(bad[0], "关掉")}`,
        });
      }
    }
    await onRefresh();
  };

  const unlinkTargets = (targets: UnlinkTarget[]) =>
    unlink(targets.flatMap((t) => t.cells ?? cellsOf(t.row)));

  /// 清掉失效的链接：删掉零损失，所以不确认、也不给撤销（§5）
  const clearBroken = async (actions: PlannedAction[]) => {
    const report = await apply(actions, { cleanBroken: true });
    if (report !== null) {
      const ok = report.entries.filter((e) => e.outcome.status === "removed").length;
      setNotice({ kind: "success", message: `清掉了 ${ok} 条指向不存在位置的链接` });
    }
    await onRefresh();
  };

  const split = async (targetId: string) => {
    onBusy(true);
    try {
      await api.splitWholeLink(targetId);
      setNotice({
        kind: "success",
        message: `拆开了 ${targetOf(targetId)?.label ?? targetId} 的 skills 目录，现在可以逐条开关了`,
      });
    } catch (e) {
      onError(String(e));
    } finally {
      onBusy(false);
    }
    await onRefresh();
  };

  // ===== 待处理栏 =====

  /// 文案一律取自 cellState.viewOf：这里造一个只用来问它的格，不另写一份映射
  const askView = (target: Target, skill: string, state: Cell["state"], path: string) =>
    viewOf(
      { sourceId: "", skill, targetId: target.id, path, state, pointsTo: null },
      target,
      target.label,
      skill,
    );

  const pending: Pending[] = [];
  for (const page of pages) {
    // 链接失效：以 page.broken 为准——本体已经被删掉的断链没有行，只出现在这张表里
    for (const act of page.broken) {
      const target = targetByPath(act.target);
      const message = target
        ? (askView(target, act.itemName, "broken", act.targetPath).reason ?? "")
        : `${act.target} 下这条链接指向一个不存在的地方，先清掉它`;
      pending.push({
        key: issueKey("brokenLink", [act.targetPath]),
        kind: "brokenLink",
        message: `${act.itemName} · ${message}`,
        paths: [act.targetPath],
        broken: act,
      });
    }
    // 整目录链到别处：一列一条，不是一格一条——同一列上几十行说的是同一件事
    for (const target of page.targets) {
      if (target.linkedWholeTo === null) continue;
      pending.push({
        key: issueKey("wholeLinkedTarget", [target.path, target.linkedWholeTo]),
        kind: "wholeLinkedTarget",
        message: askView(target, "", "wholeLinked", target.path).reason ?? "",
        paths: [target.path, target.linkedWholeTo],
        splitTargetId: target.id,
      });
    }
    // 同名本体指向别处：一格一条，用户要在两个本体之间拿主意
    for (const row of page.rows) {
      for (const cell of row.cells) {
        const target = page.targets.find((t) => t.id === cell.targetId);
        if (!target) continue;
        const view = viewOf(cell, target, target.label, row.skill);
        if (view.issue !== "duplicateSource") continue;
        const paths = [cell.path, cell.pointsTo].filter((p): p is string => p !== null);
        pending.push({
          key: issueKey("duplicateSource", paths),
          kind: "duplicateSource",
          message: view.reason ?? "",
          paths,
        });
      }
    }
  }
  // 目录写不进去：上一批操作里真的写失败了才有
  for (const ref of writeFails) {
    const target = targetOf(ref.targetId);
    if (!target) continue;
    pending.push({
      key: issueKey("readOnlyTarget", [target.path]),
      kind: "readOnlyTarget",
      message: askView(target, ref.skill, "readOnly", target.path).reason ?? "",
      paths: [target.path],
      retry: ref,
    });
  }

  const open = pending.filter((p) => !ignored.has(p.key));
  const focusIndex = focusPath === null ? -1 : open.findIndex((p) => p.paths.includes(focusPath));
  const index = focusIndex >= 0 ? focusIndex : Math.min(cursor, Math.max(open.length - 1, 0));
  const current = open[index] ?? null;

  const ignore = async (issue: Pending) => {
    try {
      const key = await api.ignoreIssue(issue.kind, issue.paths);
      // 本地算的和后端落盘的都记上：路径规范化真有出入时，界面也不会继续提示
      setIgnored((prev) => new Set(prev).add(key).add(issue.key));
      setFocusPath(null);
      setCursor(0);
    } catch (e) {
      onError(String(e));
    }
  };

  /// 待处理栏里这一条自己的动作（§4.3：三类问题各自带动作）
  const actionsOf = (issue: Pending): ReactNode => {
    if (issue.broken) {
      return (
        <ActionButton
          size="compact"
          onClick={() => void clearBroken([issue.broken as PlannedAction])}
        >
          清除
        </ActionButton>
      );
    }
    if (issue.splitTargetId) {
      // 「拆开」是 split_whole_link 唯一的入口（§8 约束 4）
      return (
        <ActionButton size="compact" onClick={() => void split(issue.splitTargetId as string)}>
          拆开
        </ActionButton>
      );
    }
    if (issue.retry) {
      return (
        <ActionButton size="compact" onClick={() => void link([issue.retry as CellRef])}>
          再试一次
        </ActionButton>
      );
    }
    return null;
  };

  // ===== 渲染 =====

  if (!overview) return <Empty kind="scanning" />;

  // 引入只对单个域有意义：「全部」页没有确定的目标域
  const importPage = selectedKey === "all" ? null : (pages[0] ?? null);
  const broken = pages.flatMap((p) => p.broken);

  /// 该行在本域是否有可关掉的链接（已链接且目标不是整目录链到别处）
  const hasUnlinkable = (page: DomainPage, row: DomainRow) =>
    row.cells.some(
      (c) =>
        c.state === "linked" &&
        page.targets.find((t) => t.id === c.targetId)?.linkedWholeTo === null,
    );

  // 操作只作用于"选中且可见"的行
  const chosen = pages.map((page) => ({
    page,
    rows: visibleRows(page).filter((row) => isSelected(page, row)),
  }));
  const chosenCount = chosen.reduce((n, { rows }) => n + rows.length, 0);
  const chosenCells: CellRef[] = chosen.flatMap(({ rows }) => rows.flatMap(cellsOf));
  // 可关掉的行：选中、且有可关掉的格。本体在本域的行也算，只关它在别的 agent 下的链接
  const clearableRows: UnlinkTarget[] = chosen.flatMap(({ page, rows }) =>
    rows.filter((row) => hasUnlinkable(page, row)).map((row) => ({ page, row })),
  );

  // 缺失按格算：一行在多个目标上缺失就算多处。
  // 多个 agent 共用一个目录时各自成列，按 cell.path 去重，同一处只算一次
  const missingPaths = new Set<string>();
  for (const { rows } of chosen) {
    for (const row of rows) {
      for (const cell of row.cells) if (cell.state === "missing") missingPaths.add(cell.path);
    }
  }
  const missing = missingPaths.size;

  return (
    <section>
      <div className="toolbar" style={dim(busy)}>
        <ActionButton
          onClick={() => setImportOpen(true)}
          disabled={importPage === null}
          disabledReason="请先在侧栏选一个位置"
          title="把 skill 引入这个位置"
        >
          导入 skill
        </ActionButton>
        <ActionButton
          onClick={() => void clearBroken(broken)}
          disabled={broken.length === 0}
          disabledReason="没有指向不存在位置的链接"
          title="一次清掉本域全部失效的链接"
        >
          清除失效的（{broken.length}）
        </ActionButton>
      </div>

      {/* 筛选输入框不受 busy 约束（§6），所以它不在上面那个置灰的容器里 */}
      <div className="toolbar filters">
        <input
          type="search"
          placeholder="筛选 skill"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
      </div>

      {chosenCount > 0 && (
        <div className="toolbar selection">
          <span style={LABEL}>已选 {chosenCount} 个 skill</span>
          {/* 取消选择是 busy 的豁免项：它不写磁盘 */}
          <ActionButton variant="link" onClick={() => setSelected(new Set())}>
            取消选择
          </ActionButton>
          <span style={{ display: "flex", gap: 8, ...dim(busy) }}>
            <ActionButton
              size="compact"
              onClick={() => void link(chosenCells)}
              disabled={missing === 0}
              disabledReason="选中的行在这些 agent 下都已经开着了"
              title="在选中行还没开启的 agent 下开启"
            >
              开启（{missing}）
            </ActionButton>
            <ActionButton
              size="compact"
              onClick={() => void unlinkTargets(clearableRows)}
              disabled={clearableRows.length === 0}
              disabledReason="选中的行上没有可以关掉的链接"
              title="关掉选中行在本域各 agent 下的链接"
            >
              关掉（{clearableRows.length}）
            </ActionButton>
          </span>
        </div>
      )}

      {pages.length === 0 ? (
        <Empty
          kind="noAgentDirs"
          description="这个位置下还没有可用的 agent 目录。"
          primary={{ label: "导入 skill", onClick: () => setImportOpen(true) }}
        />
      ) : (
        pages.map((page) => (
          <DomainView
            key={page.key}
            overview={overview}
            page={page}
            autoLinks={autoLinks}
            rows={visibleRows(page)}
            busy={busy}
            activeSources={filterSources.get(page.key) ?? new Set()}
            onToggleSource={(sourceId) => toggleSourceFilter(page, sourceId)}
            onClearSources={() =>
              setFilterSources((prev) => {
                const next = new Map(prev);
                next.delete(page.key);
                return next;
              })
            }
            filtered={filterText.trim() !== "" || (filterSources.get(page.key)?.size ?? 0) > 0}
            onClearFilter={clearFilter}
            onImport={() => setImportOpen(true)}
            isSelected={(row) => isSelected(page, row)}
            onToggle={(row, shiftKey, ordered) => toggleRow(page, row, shiftKey, ordered)}
            onSelectAll={(want) => setPageAll(page, want)}
            onChange={onRefresh}
            onError={onError}
            onLink={link}
            onUnlink={unlinkTargets}
            onNotice={(text) => setNotice({ kind: "cannot", message: text })}
          />
        ))
      )}

      {/* 待处理栏：一次一条，处理完跳下一条；完整列表在「待处理」页（§4.3） */}
      {current !== null && (
        <div style={PENDING_BAR}>
          <span style={{ fontSize: "var(--size-body)" }}>{current.message}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8, ...dim(busy) }}>
            {actionsOf(current)}
            <ActionButton variant="link" onClick={() => void ignore(current)}>
              忽略
            </ActionButton>
          </span>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
            {onOpenPending ? (
              <ActionButton variant="link" onClick={onOpenPending}>
                待处理 {open.length}
              </ActionButton>
            ) : (
              <span style={{ ...MONO, color: "var(--ink-mute)" }}>待处理 {open.length}</span>
            )}
            {open.length > 1 && (
              <>
                <ActionButton
                  variant="link"
                  onClick={() => {
                    setFocusPath(null);
                    setCursor((index - 1 + open.length) % open.length);
                  }}
                >
                  上一条
                </ActionButton>
                <span style={{ ...MONO, color: "var(--ink-mute)" }}>
                  {index + 1} / {open.length}
                </span>
                <ActionButton
                  variant="link"
                  onClick={() => {
                    setFocusPath(null);
                    setCursor((index + 1) % open.length);
                  }}
                >
                  下一条
                </ActionButton>
              </>
            )}
          </span>
        </div>
      )}

      {notice && (
        <Toast
          kind={notice.kind}
          message={notice.message}
          stats={notice.stats}
          action={notice.action}
          onDismiss={() => setNotice(null)}
          onClose={() => setNotice(null)}
        />
      )}

      {importOpen && importPage !== null && (
        <ImportDialog
          overview={overview}
          page={importPage}
          autoLinks={autoLinks}
          onClose={() => setImportOpen(false)}
          onChange={onRefresh}
          onReport={(r) => {
            const n = r.entries.filter((e) => e.outcome.status === "created").length;
            setNotice({ kind: "success", message: `开启了 ${n} 处`, stats: `${n} 条链接` });
          }}
          onError={onError}
          onNotice={(text) => setNotice({ kind: "cannot", message: text })}
        />
      )}
    </section>
  );
}
