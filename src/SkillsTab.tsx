import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { MICRO_CAP, MONO } from "./ui/text";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import DomainView, { ActionButton, dim, type UnlinkTarget } from "./DomainView";
import ImportPage from "./pages/ImportPage";
import {
  collectIssues,
  formatBytes,
  readOnlyIssue,
  type DeleteChoice,
  type PendingIssue,
} from "./pages/pendingIssues";
import { AgentIcon, Chip, Confirm, Empty, Toast, type ToastKind } from "./ui";
import type {
  AutoLink,
  Cell,
  CellRef,
  DeleteSourcePlan,
  DomainPage,
  DomainRow,
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

/// 提示条的内容；一次操作只汇总成一句，新的替换旧的（§4.1）
interface Notice {
  kind: ToastKind;
  message: ReactNode;
  /// 副行等宽统计
  stats?: string;
  /// 「撤销」只在可逆时给；部分失败给「查看」跳待处理栏
  action?: { label: string; onClick: () => void };
}

/// 已经体检过、正等用户确认的一次删除。体检与真删是两次调用，中间隔着确认（§5）
interface Asking {
  planId: string;
  plan: DeleteSourcePlan;
  choice: DeleteChoice;
}

/// 选择操作条上的一片：**已选的 skill × 这个 agent**（DESIGN「选择操作条」）
interface AgentChip {
  target: Target;
  /// 可以关掉的格
  linked: CellRef[];
  /// 还没开的格
  missing: CellRef[];
  /// 非空即灰描边不可选，同时是鼠标悬停的原因
  disabledReason?: string;
}

/// 报告里第一条失败的原因；全成功时为 null
const firstFailure = (report: SyncReport): string | null => {
  for (const entry of report.entries) {
    if (entry.outcome.status === "failed") return entry.outcome.reason;
  }
  return null;
};

/// 删本体确认弹窗里那句「有多少条链接会因此失效」（§10 第 2 条）
const affectedLine = (plan: DeleteSourcePlan): string => {
  const n = plan.affected.length;
  if (n === 0) return "没有链接指向它。";
  if (plan.relinkTo !== null) return `${n} 条链接指向它，删完自动改指到留下的那一处。`;
  return `${n} 条链接指向它，删完这些链接就指不到东西了。`;
};

/// 选择操作条上的一片。`Chip` 的「不可选必须同时给原因」在类型上是个联合，
/// 条件禁用得分两支写，这一层只做那件事
function SelectionChip({
  icon,
  name,
  open,
  selected,
  title,
  disabledReason,
  onClick,
}: {
  icon?: ReactNode;
  name: string;
  /// 还没开的格数；大于 0 时片上写「开启 N」，点一下就是开它们
  open: number;
  selected: boolean;
  title: string;
  disabledReason?: string;
  onClick: () => void;
}) {
  // 计数走等宽，「开启」两个字是正文——等宽只给路径与计数（§1.2）
  const label = (
    <>
      {name}
      {open > 0 ? (
        <>
          {" "}
          开启 <span style={MONO}>{open}</span>
        </>
      ) : null}
    </>
  );
  return disabledReason === undefined ? (
    <Chip icon={icon} selected={selected} title={title} onClick={onClick}>
      {label}
    </Chip>
  ) : (
    <Chip icon={icon} disabled disabledReason={disabledReason}>
      {label}
    </Chip>
  );
}

export interface SkillsTabProps {
  overview: Overview | null;
  /// 自动同步规则；域页列出、关链前据此写排除
  autoLinks: AutoLink[];
  busy: boolean;
  onBusy: (busy: boolean) => void;
  /// 侧栏选中的 DomainPage.key
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
  // 同名本体选了「删 X 的」之后、确认之前停在这里
  const [asking, setAsking] = useState<Asking | null>(null);

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
    setAsking(null);
    setFocusPath(null);
    setCursor(0);
  }, [selectedKey]);

  const pages = overview === null ? [] : overview.domains.filter((d) => d.key === selectedKey);

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

  /// 收集与文案都取自 pendingIssues：待处理页与这条栏说的必须是同一句**行视角**的话，
  /// 不在这里另写一份（DESIGN「反馈」）
  const pending: PendingIssue[] = collectIssues(overview, pages);
  // 目录写不进去：扫描永远不产出这个状态，只有上一批操作真的写失败了才有。
  // 同一个目录下几个 skill 都写不进去说的是同一件事，按目标并成一条
  const failedTargets = new Map<string, CellRef[]>();
  for (const ref of writeFails) {
    const refs = failedTargets.get(ref.targetId);
    if (refs) refs.push(ref);
    else failedTargets.set(ref.targetId, [ref]);
  }
  for (const [targetId, refs] of failedTargets) {
    const target = targetOf(targetId);
    if (target) pending.push(readOnlyIssue(target, refs));
  }

  const open = pending.filter((p) => !ignored.has(p.key));
  const focusIndex = focusPath === null ? -1 : open.findIndex((p) => p.paths.includes(focusPath));
  const index = focusIndex >= 0 ? focusIndex : Math.min(cursor, Math.max(open.length - 1, 0));
  const current = open[index] ?? null;

  const ignore = async (issue: PendingIssue) => {
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

  /// 删本体第一步：只读体检，什么都不动，结果摆进确认弹窗（§10 第 2 条）
  const askDelete = async (choice: DeleteChoice) => {
    onBusy(true);
    try {
      const planned = await api.planDeleteSource(choice.sourceId, choice.skill);
      setAsking({ planId: planned.planId, plan: planned.plan, choice });
    } catch (e) {
      onError(String(e));
    } finally {
      onBusy(false);
    }
  };

  /// 删本体第二步：用户确认之后才真的删。与体检分成两次调用，合并就等于无确认删除
  const confirmDelete = async () => {
    if (asking === null) return;
    const { planId, plan, choice } = asking;
    setAsking(null);
    onBusy(true);
    try {
      const report = await api.deleteSource(planId);
      const reason = firstFailure(report);
      const affected = plan.affected.length;
      setNotice(
        reason === null
          ? {
              // 不给撤销：后端没有恢复命令，只能告诉他去哪儿找（DESIGN「删本体」）
              kind: "success",
              message: `把 ${choice.label} 里的 ${choice.skill} 移到了废纸篓，可以在访达里恢复`,
              stats:
                affected === 0
                  ? undefined
                  : plan.relinkTo !== null
                    ? `${affected} 条链接已改指到留下的那一处`
                    : `${affected} 条链接现在指不到东西了`,
            }
          : { kind: "cannot", message: reason },
      );
    } catch (e) {
      onError(String(e));
    } finally {
      onBusy(false);
    }
    await onRefresh();
  };

  /// 待处理栏里这一条自己的动作（DESIGN「反馈」：四类问题各自带动作，与待处理页一致）
  const actionsOf = (issue: PendingIssue): ReactNode => {
    switch (issue.kind) {
      case "duplicateSource":
        // 两个本体各自仍在列表里成行，这条栏只负责问删哪一个
        return issue.deletes.map((choice) => (
          <ActionButton key={choice.sourceId} size="compact" onClick={() => void askDelete(choice)}>
            删 {choice.label} 的
          </ActionButton>
        ));
      case "brokenLink":
        return issue.clear === null ? null : (
          <ActionButton
            size="compact"
            onClick={() => void clearBroken([issue.clear as PlannedAction])}
          >
            清除
          </ActionButton>
        );
      case "wholeLinkedTarget":
        // 「拆开」是 split_whole_link 唯一的入口（§8 约束 4）
        return issue.splitTargetId === null ? null : (
          <ActionButton size="compact" onClick={() => void split(issue.splitTargetId as string)}>
            拆开
          </ActionButton>
        );
      case "readOnlyTarget":
        return (
          <ActionButton size="compact" onClick={() => void link(issue.retry)}>
            再试一次
          </ActionButton>
        );
      default:
        // MCP 的两类不会走到 skill 的待处理栏
        return null;
    }
  };

  // ===== 渲染 =====

  if (!overview) return <Empty kind="scanning" />;

  // 导入只对单个域有意义：「全部」页没有确定的目标域
  const importPage = pages[0] ?? null;
  const broken = pages.flatMap((p) => p.broken);

  // 操作只作用于"选中且可见"的行
  const chosen = pages.map((page) => ({
    page,
    rows: visibleRows(page).filter((row) => isSelected(page, row)),
  }));
  const chosenCount = chosen.reduce((n, { rows }) => n + rows.length, 0);

  // 选择操作条的一排片：本域每个 agent 一片，状态由「已选的 skill 在这个 agent 下的格」
  // 决定（DESIGN「选择操作条」）。**不要退化成两个总按钮**——那丢掉了"针对某个 agent"这一维
  const agentChips: AgentChip[] = [];
  for (const { page, rows } of chosen) {
    if (rows.length === 0) continue;
    for (const target of page.targets) {
      const linked: CellRef[] = [];
      const missing: CellRef[] = [];
      // 本体就在这儿，以及四种异常态：开关都不碰它们，只影响这片可不可选
      let own = 0;
      let blocked = 0;
      for (const row of rows) {
        const cell = row.cells.find((c) => c.targetId === target.id);
        if (!cell) continue;
        const ref: CellRef = { sourceId: row.sourceId, skill: row.skill, targetId: target.id };
        if (cell.state === "linked") linked.push(ref);
        else if (cell.state === "missing") missing.push(ref);
        else if (cell.state === "own") own += 1;
        else blocked += 1;
      }
      const disabledReason =
        target.linkedWholeTo !== null
          ? `${target.label} 的 skills 目录整个链到了别处，要逐条开关得先拆开`
          : linked.length + missing.length > 0
            ? undefined
            : own > 0
              ? `选中的 skill 本体就在 ${target.label} 下，没有链接可开关`
              : blocked > 0
                ? `选中的 skill 在 ${target.label} 下另有情况挡着，点那一格看是什么`
                : `选中的 skill 在 ${target.label} 下没有格`;
      agentChips.push({ target, linked, missing, disabledReason });
    }
  }
  // 「全部」片对所有可点的片做同一件事：全开着就全关，有没开的就把没开的都开了
  const usableChips = agentChips.filter((c) => c.disabledReason === undefined);
  const allMissing = usableChips.flatMap((c) => c.missing);
  const allLinked = usableChips.flatMap((c) => c.linked);

  return (
    // 这一页自己铺满内容区，底部的待处理栏才贴得住窗口底边（App.css 的 .skills-tab）
    <section className="skills-tab">
      <div className="toolbar" style={dim(busy)}>
        <ActionButton
          onClick={() => setImportOpen(true)}
          disabled={importPage === null}
          disabledReason="请先在侧栏选一个位置"
          title="把 skill 导入这个位置"
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
          <span style={MICRO_CAP}>已选 {chosenCount} 个 skill</span>
          {/* 取消选择是 busy 的豁免项：它不写磁盘 */}
          <ActionButton variant="link" onClick={() => setSelected(new Set())}>
            取消选择
          </ActionButton>
          {/* 一排片，每片＝已选的 skill × 这个 agent；反色＝全开着，点一下全关 */}
          <span style={{ display: "flex", alignItems: "center", gap: 8, ...dim(busy) }}>
            <SelectionChip
              name="全部"
              open={allMissing.length}
              selected={usableChips.length > 0 && allMissing.length === 0}
              title={
                allMissing.length > 0
                  ? "在还没开启的 agent 下一次全开"
                  : "关掉选中的 skill 在各 agent 下的链接"
              }
              disabledReason={
                usableChips.length > 0 ? undefined : "选中的 skill 在这些 agent 下都没有可开关的格"
              }
              onClick={() => void (allMissing.length > 0 ? link(allMissing) : unlink(allLinked))}
            />
            {agentChips.map(({ target, linked, missing, disabledReason }) => (
              <SelectionChip
                key={target.id}
                icon={<AgentIcon id={target.scope.harnessId} name={target.label} />}
                name={target.label}
                open={missing.length}
                selected={disabledReason === undefined && missing.length === 0}
                title={
                  missing.length > 0
                    ? `在 ${target.label} 下开启还没开的那几个`
                    : `关掉选中的 skill 在 ${target.label} 下的链接`
                }
                disabledReason={disabledReason}
                onClick={() => void (missing.length > 0 ? link(missing) : unlink(linked))}
              />
            ))}
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

      {/* 待处理栏：贴着窗口底边（DESIGN「Layout」），一次一条，处理完跳下一条；
          完整列表在「待处理」页（§4.3） */}
      {current !== null && (
        <div className="pending-bar">
          <span style={{ fontSize: "var(--size-body)" }}>
            {current.subject}
            {current.text}
          </span>
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

      {/* 删本体是唯一会真丢内容的动作，确认一道，且弹窗要摆出做决定所需的全部事实（§5、§10） */}
      {asking !== null && (
        <Confirm
          title={`删掉 ${asking.choice.label} 里的 ${asking.choice.skill}`}
          body="本体目录会移到系统废纸篓，不是彻底删除。"
          warning={
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {/* 唯一会显示绝对路径的地方：用户正要据此判断删的是不是这一处（§4.5） */}
              <div style={MONO}>{asking.plan.path}</div>
              <div>
                {asking.plan.entries} 个条目 · {formatBytes(asking.plan.bytes)}
              </div>
              <div>{affectedLine(asking.plan)}</div>
              {asking.plan.inGit !== null && (
                <div>
                  它在 git 仓库 <span style={MONO}>{asking.plan.inGit}</span> 里。仓库里的东西交给
                  git 处理更稳妥，这里不代删。
                </div>
              )}
            </div>
          }
          confirmLabel="删到废纸篓"
          destructive
          onConfirm={() => void confirmDelete()}
          confirmDisabledReason={
            asking.plan.inGit === null
              ? undefined
              : `它在 git 仓库 ${asking.plan.inGit} 里，这里不代删`
          }
          cancelLabel={asking.plan.inGit === null ? "取消" : "知道了"}
          onCancel={() => setAsking(null)}
        />
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

      {importOpen && importPage !== null && overview !== null && (
        <ImportPage
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
