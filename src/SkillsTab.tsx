import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import DomainView, { skillCellKey, skillRowKey, type BatchPress } from "./DomainView";
import ImportPage from "./pages/ImportPage";
import { pathsOfKey } from "./pages/pendingIssues";
import { defer, type Deferred } from "./deferredCommit";
import { shortDate } from "./dateText";
import { Empty, Toast, TOAST_DWELL_MS } from "./ui";
import { toastFor, type FailedItem, type ToastItem, type ToastOp } from "./toastText";
import type {
  AutoLink,
  CellRef,
  CellState,
  DomainPage,
  DomainRow,
  Overview,
  PlannedAction,
  SyncReport,
  Target,
} from "./types";

/// 写不进去的典型原因。命中时说人话，否则原样转述 core 给的那句
const NO_WRITE = /permission denied|os error 13|read-?only|只读|权限/i;

export interface SkillsTabProps {
  overview: Overview | null;
  /// 自动同步规则；关链前写排除、开链前恢复都靠它（规则本身只在添加页管理）
  autoLinks: AutoLink[];
  busy: boolean;
  onBusy: (busy: boolean) => void;
  /// 侧栏选中的 DomainPage.key
  selectedKey: string;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
  /// 顶栏收件箱接管了待处理入口；这个口子留给壳，主视图不再有贴底待处理窗
  onOpenPending?: () => void;
  /// 待处理页「跳回」：一条待处理的 key（`issueKey(kind, paths)`，也收行键 `来源|skill`）。
  /// 收到新值就滚到涉及的那一行（格、或整列的列头）并闪一下；处理完回调 `onFocused`，
  /// 壳在那里把它清回 undefined，下次跳同一条才会再触发
  focusKey?: string;
  onFocused?: () => void;
}

/// Skills 页：工具行 + 按来源分组的表格（DomainView → Matrix）。
///
/// 反馈的位置（DESIGN「提示条的位置」）：
/// - 单格：乐观更新 + 格子闪一下，**不出提示条**；失败弹回 + 格下小黑窗说原因；撤销用 ⌘Z
/// - 批量：一行提示条贴在被按下的键下方，右对齐该键；动词与键一致，键上读数随之翻转
/// - 只留这份：黑窗提示条贴在留下那一行下方 + 撤销
/// - 自动规则在背后做了事：右下黑窗，右沿对齐面板右沿 + 撤销
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
}: SkillsTabProps) {
  // 选中的行键。默认一行不选，选择条不出现（DESIGN「默认值」）；切换侧栏的位置时清空——
  // 跨位置保留会让人回到一个位置时看见「自己没勾过」的行已经勾着
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState("");
  // 按来源筛选（工具行第二行的来源片）；null＝全部
  const [originFilter, setOriginFilter] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // 乐观更新：格键 → 点下去之后该画成的状态；重扫回来后撤掉
  const [optimistic, setOptimistic] = useState<Map<string, CellState>>(new Map());
  // 写失败（目录写不进去）的格：扫描不产出 readOnly，只有真的写失败之后由这里构造
  const [readOnly, setReadOnly] = useState<Set<string>>(new Set());
  const [pendingCells, setPendingCells] = useState<Set<string>>(new Set());
  const [busyRows, setBusyRows] = useState<Map<string, string>>(new Map());
  const [flash, setFlash] = useState<{ keys: string[]; nonce: number; stagger?: number }>();
  const [cellNotice, setCellNotice] = useState<{
    rowKey: string;
    columnId: string;
    text: string;
  } | null>(null);
  const [keyToast, setKeyToast] = useState<{ keyId: string; node: ReactNode } | null>(null);
  const [rowToast, setRowToast] = useState<{ rowKey: string; node: ReactNode } | null>(null);
  const [globalToast, setGlobalToast] = useState<ReactNode>(null);
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
  // 同名两份「只留这份」：另一份先藏起来，删除挂在 deferredCommit 上——提示条到期、被关掉、
  // 切走或窗口关闭（App 调 flushAll）时才真的删；撤销＝丢掉挂起的提交，链接也就不用改指回去
  // （DESIGN「页面还是弹层」：删原件不确认，删 + 撤销）。一次只挂一个
  const keepRef = useRef<Deferred | null>(null);

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

  // 切走之前把「只留这份」提交掉：提示条已经不在了，没有撤销的入口了
  useEffect(() => {
    return () => {
      void keepRef.current?.commit();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  // 提示与弹层只属于当次选择；选择与筛选跨侧栏切换保留
  useEffect(() => {
    setImportOpen(false);
    setKeyToast(null);
    setRowToast(null);
    setCellNotice(null);
    setSelected(new Set());
    setOriginFilter(null);
    undoRef.current = null;
  }, [selectedKey]);

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

  /// 这批格里仍在某条自动同步规则范围内的 skill：关掉前必须先写排除，
  /// 否则下一轮扫描立刻把链接补回来
  const toExclude = (cells: CellRef[]) => {
    const out = new Map<string, { source: string; skill: string }>();
    for (const c of cells) {
      const covered = autoLinks.some(
        (r) =>
          r.source === c.sourceId &&
          !r.excluded.includes(c.skill) &&
          r.targets.includes(c.targetId),
      );
      if (covered) out.set(`${c.sourceId}|${c.skill}`, { source: c.sourceId, skill: c.skill });
    }
    return [...out.values()];
  };
  /// 这批格里被规则覆盖、且在排除名单上的 skill：点开时放回规则里
  const toInclude = (cells: CellRef[]) => {
    const out = new Map<string, { source: string; skill: string }>();
    for (const c of cells) {
      const covered = autoLinks.some(
        (r) =>
          r.source === c.sourceId && r.excluded.includes(c.skill) && r.targets.includes(c.targetId),
      );
      if (covered) out.set(`${c.sourceId}|${c.skill}`, { source: c.sourceId, skill: c.skill });
    }
    return [...out.values()];
  };

  /// 这条没做成的原因，一句人话：说原因，不说「失败」
  const reasonOf = (target: string, reason: string, what: "开启" | "关掉" | "清除"): string => {
    const agent = targetByPath(target)?.label ?? target;
    return NO_WRITE.test(reason)
      ? `${agent} 的 skills 目录写不进去`
      : `${agent} 下没能${what}：${reason}`;
  };

  /// 执行一次开 / 关：返回每一格做成没做成。排除 / 恢复在动作之前写，顺序不能反
  const run = async (
    op: "link" | "unlink",
    cells: CellRef[],
  ): Promise<{ done: CellRef[]; failed: { ref: CellRef; reason: string }[] }> => {
    const actions = op === "link" ? await api.proposeLinks(cells) : await api.proposeUnlinks(cells);
    if (op === "link")
      for (const r of toInclude(cells)) await api.includeAutoLink(r.source, r.skill);
    else for (const r of toExclude(cells)) await api.excludeAutoLink(r.source, r.skill);
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
          reason: reasonOf(
            entry.action.target,
            entry.outcome.reason,
            op === "link" ? "开启" : "关掉",
          ),
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

  // ===== 单格：乐观更新，不出提示条 =====

  const toggleCell = (ref: CellRef, from: CellState) => {
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
            undoRef.current = null;
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
        } else {
          const back = op === "link" ? "linked" : "missing";
          undoRef.current = () => toggleCell(ref, back);
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
  };

  // ===== 批量：提示条贴在被按下的键下方 =====

  const toastItems = (refs: CellRef[]): ToastItem[] =>
    refs.map((ref) => ({ name: ref.skill, agent: agentRef(targetOf(ref.targetId)) }));

  const batch = async ({ keyId, op, cells }: BatchPress, undoing = false) => {
    if (cells.length === 0) return;
    setKeyToast(null);
    setCellNotice(null);
    const keys = cells.map(skillCellKey);
    const rows = [...new Set(cells.map(skillRowKey))];
    const sentence = `正在${op === "link" ? "开启" : "关闭"} ${cells.length} 个`;
    setOptimisticFor(cells, op === "link" ? "linked" : "missing");
    setPendingCells(new Set(keys));
    setBusyRows(new Map(rows.map((r) => [r, sentence])));
    onBusy(true);
    let result: Awaited<ReturnType<typeof run>> | null = null;
    try {
      result = await run(op, cells);
    } catch (e) {
      onError(String(e));
    } finally {
      onBusy(false);
      setPendingCells(new Set());
      setBusyRows(new Map());
    }
    if (result !== null) {
      noteReadOnly(result.failed, op === "link" ? cells : []);
      // 没成的先弹回；做成的依次闪一下——进度就是格子依次点亮
      setOptimisticFor(
        result.failed.map((f) => f.ref),
        null,
      );
      setFlash({ keys: result.done.map(skillCellKey), nonce: Date.now(), stagger: 40 });
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

  /// 真的删掉另一份（deferredCommit 到期时调）
  const deleteOther = async (other: DomainRow, planId: string) => {
    const key = skillRowKey(other);
    try {
      let report: SyncReport;
      try {
        report = await api.deleteSource(planId);
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
      }
    } catch (e) {
      onError(String(e));
    }
    await onRefresh();
    setHidden((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const keepThis = async (kept: DomainRow, other: DomainRow) => {
    // 上一次的还没提交：先提交它，一次只挂一个撤销
    await keepRef.current?.commit();
    const keptLabel = overview?.sources.find((s) => s.id === kept.sourceId)?.label ?? kept.sourceId;
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
    const otherKey = skillRowKey(other);
    const planId = planned.planId;
    const d = defer(`keep:${otherKey}`, () => deleteOther(other, planId));
    keepRef.current = d;
    setHidden((prev) => new Set(prev).add(otherKey));
    const undo = () => {
      d.undo();
      undoRef.current = null;
      setRowToast(null);
      setHidden((prev) => {
        const next = new Set(prev);
        next.delete(otherKey);
        return next;
      });
    };
    const commit = () => {
      setRowToast(null);
      void d.commit();
    };
    undoRef.current = undo;
    const n = planned.plan.affected.length;
    const text = toastFor("keepThis", { done: [{ name: kept.skill }], keepLabel: keptLabel });
    setRowToast({
      rowKey,
      node: (
        <Toast
          {...text}
          stats={n === 0 ? "另一份进废纸篓" : `另一份进废纸篓 · ${n} 条链接改指到这份`}
          action={{ label: "撤销", onClick: undo }}
          onDismiss={commit}
          onClose={commit}
        />
      ),
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

  // ===== 自动规则在背后做了事：右下黑窗 + 撤销，被开启的格依次闪一下 =====

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
      setFlash({ keys: refs.map(skillCellKey), nonce: Date.now(), stagger: 40 });
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

  // ===== 待处理页跳回：滚到那一行并闪一下 =====

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
    if (rowKeys.length === 0) columnId = page.targets.find((t) => paths.has(t.path))?.id;
    // 要跳的行被筛掉了：先清筛选，不然跳过去是空的
    if (rowKeys.length > 0) {
      setFilterText("");
      setOriginFilter(null);
    }
    setFocus({ rowKeys, columnId, nonce: Date.now() });
    onFocused?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, overview, page?.key]);

  // ===== 渲染 =====

  if (!overview) {
    return <Empty kind="scanning" description="正在读 skill 目录" />;
  }
  if (page === null) {
    return (
      <Empty
        kind="noAgentDirs"
        description="这个位置下还没有 agent 的 skill 目录"
        primary={{ label: "添加 skill", onClick: () => setImportOpen(true) }}
      />
    );
  }

  const query = filterText.trim().toLowerCase();
  const visible = page.rows.filter(
    (row) =>
      (query === "" || row.skill.toLowerCase().includes(query)) &&
      (originFilter === null || row.sourceId === originFilter),
  );
  const hiddenRows = hidden;

  return (
    <section className="mx-page">
      <DomainView
        overview={overview}
        page={page}
        rows={visible}
        stateOf={stateOf}
        pendingCells={pendingCells}
        busyRows={busyRows}
        hiddenRows={hiddenRows}
        dupReadout={dupReadout}
        onDupHover={dupHover}
        onKeepThis={(kept, other) => void keepThis(kept, other)}
        busy={busy}
        filterText={filterText}
        onFilterText={setFilterText}
        onClearFilter={() => {
          setFilterText("");
          setOriginFilter(null);
        }}
        originFilter={originFilter}
        onOriginFilter={setOriginFilter}
        onReveal={(path) => void api.revealInDir(path).catch((e) => onError(String(e)))}
        onImport={() => setImportOpen(true)}
        selected={selected}
        onSelectionChange={(next) => {
          setSelected(next);
          if (next.size === 0) setKeyToast(null);
        }}
        onCell={onCell}
        onBatch={(press) => void batch(press)}
        onUndo={() => undoRef.current?.()}
        shortcuts={!importOpen}
        flash={flash}
        cellNotice={cellNotice}
        rowToast={rowToast}
        keyToast={keyToast}
        globalToast={globalToast}
        focus={focus}
      />

      {importOpen && (
        <ImportPage
          overview={overview}
          page={page}
          autoLinks={autoLinks}
          onClose={() => setImportOpen(false)}
          onChange={onRefresh}
          onReport={(r) => {
            const created = r.entries.filter((e) => e.outcome.status === "created");
            const failed = r.entries.filter((e) => e.outcome.status === "failed");
            const item = (a: PlannedAction): ToastItem => ({
              name: a.itemName,
              agent: agentRef(targetByPath(a.target)),
            });
            const text = toastFor("link" satisfies ToastOp, {
              done: created.map((e) => item(e.action)),
              failed: failed.map((e) => ({
                ...item(e.action),
                reason:
                  e.outcome.status === "failed"
                    ? reasonOf(e.action.target, e.outcome.reason, "开启")
                    : "",
              })),
            });
            setGlobalToast(
              <Toast {...text} tier="notice" onDismiss={dismissGlobal} onClose={dismissGlobal} />,
            );
          }}
          onError={onError}
          onNotice={(text) =>
            setGlobalToast(
              <Toast
                kind="cannot"
                verb="没添加"
                reason={text}
                onDismiss={dismissGlobal}
                onClose={dismissGlobal}
              />,
            )
          }
        />
      )}
    </section>
  );
}
