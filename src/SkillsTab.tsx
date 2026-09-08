import { useEffect, useState } from "react";
import { api } from "./api";
import DomainView, { join, type UnlinkTarget } from "./DomainView";
import ImportDialog from "./ImportDialog";
import {
  actionId,
  type CellRef,
  type DomainPage,
  type DomainRow,
  type Outcome,
  type Overview,
  type PlannedAction,
  type SyncReport,
} from "./types";

function outcomeText(o: Outcome): string {
  switch (o.status) {
    case "created":
      return "已创建";
    case "removed":
      return "已删除";
    case "skipped":
      return "跳过";
    case "failed":
      return `失败：${o.reason}`;
  }
}

/// 选择状态的键：域 + 本体位置 + skill
const rowKey = (page: DomainPage, row: DomainRow) => `${page.key}|${row.sourceId}|${row.skill}`;

/// 一行展开成它在本域各目标上的格
const cellsOf = (row: DomainRow): CellRef[] =>
  row.cells.map((c) => ({ sourceId: row.sourceId, skill: row.skill, targetId: c.targetId }));

export interface SkillsTabProps {
  overview: Overview | null;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  /// 侧栏选中：`"all"` 或某个 DomainPage.key
  selectedKey: string;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}

/// 域页容器：常驻工具栏 + 筛选行 + 选择操作条，下面按侧栏选中渲染一个或全部域
export default function SkillsTab({
  overview,
  busy,
  onBusy,
  selectedKey,
  onRefresh,
  onError,
}: SkillsTabProps) {
  const [report, setReport] = useState<SyncReport | null>(null);
  // 暂态提示：说明为什么没动作、某个格为什么不能点
  const [notice, setNotice] = useState<string | null>(null);
  // 结果框里按 skill 的说明：本体去向、失败条数
  const [notes, setNotes] = useState<string[]>([]);
  const [confirmClean, setConfirmClean] = useState(false);
  // 待确认的清链动作与它们所属的行；行、格、批量三条路径都汇到这里
  const [pendingUnlink, setPendingUnlink] = useState<{
    actions: PlannedAction[];
    rows: { page: DomainPage; row: DomainRow }[];
  } | null>(null);
  // 选中的行，默认为空；键见 rowKey
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Shift 区间选择的锚点：域 key → 上次点击的行键
  const [anchor, setAnchor] = useState<Map<string, string>>(new Map());
  // 筛选：skill 名子串（大小写不敏感）+ 每个域各自高亮的本体位置（空 = 不筛）
  const [filterText, setFilterText] = useState("");
  const [filterSources, setFilterSources] = useState<Map<string, Set<string>>>(new Map());
  const [importOpen, setImportOpen] = useState(false);

  // 结果框是暂态的：6 秒后自行消失；带 skill 说明时留久一点
  useEffect(() => {
    if (!report) return;
    const timer = setTimeout(
      () => {
        setReport(null);
        setNotes([]);
      },
      notes.length > 0 ? 15000 : 6000,
    );
    return () => clearTimeout(timer);
  }, [report, notes]);

  // 提示同样是暂态的
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  // 确认弹窗开着时按 Esc 关闭，等同取消
  useEffect(() => {
    if (!confirmClean && pendingUnlink === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setConfirmClean(false);
      setPendingUnlink(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmClean, pendingUnlink]);

  // 结果、确认与弹层只属于当次选择；选择与筛选跨侧栏切换保留
  useEffect(() => {
    setReport(null);
    setNotes([]);
    setNotice(null);
    setConfirmClean(false);
    setPendingUnlink(null);
    setImportOpen(false);
  }, [selectedKey]);

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

  /// 把清链结果按行归拢：全成功时说明本体去向，有失败时指回上面的逐条结果
  const unlinkNote = (report: SyncReport, row: DomainRow): string | null => {
    const entries = report.entries.filter(
      (e) =>
        e.action.itemName === row.skill && row.cells.some((c) => c.path === e.action.targetPath),
    );
    if (entries.length === 0) return null;
    const failed = entries.filter((e) => e.outcome.status !== "removed").length;
    if (failed > 0) return `「${row.skill}」有 ${failed} 条软链未能删除，见上方。`;
    if (row.own) {
      const dir = overview?.sources.find((s) => s.id === row.sourceId)?.path ?? row.sourceId;
      return `「${row.skill}」的软链已清除；本体仍在 ${join(dir, row.skill)}，点击表格里的本体位置可在 Finder 中定位，删掉本体后它才会从列表消失。`;
    }
    // 单格清除时行里可能还留着别的链接，行不会消失
    const linked = row.cells.filter((c) => c.state === "linked").length;
    return entries.length === linked
      ? `「${row.skill}」的软链已清除，已从列表移除。`
      : `「${row.skill}」的软链已清除，它在其他 harness 下的链接还在。`;
  };

  const run = async (
    subset: PlannedAction[],
    cleanBroken: boolean,
    rows: { page: DomainPage; row: DomainRow }[] = [],
  ) => {
    onBusy(true);
    setConfirmClean(false);
    setPendingUnlink(null);
    try {
      const result = await api.applyAll(subset, cleanBroken);
      setReport(result);
      setNotes(
        rows.map(({ row }) => unlinkNote(result, row)).filter((t): t is string => t !== null),
      );
    } catch (e) {
      onError(String(e));
    } finally {
      onBusy(false);
    }
    await onRefresh();
  };

  // 建链不需要确认
  const link = async (cells: CellRef[]) => {
    try {
      const acts = await api.proposeLinks(cells);
      if (acts.length === 0) {
        setNotice("没有需要建立的链接");
        return;
      }
      await run(acts, false);
    } catch (e) {
      onError(String(e));
    }
  };

  // 清链先算动作再进确认弹窗；行一起带上，执行后据此写说明
  const askUnlink = async (targets: UnlinkTarget[]) => {
    try {
      const acts = await api.proposeUnlinks(targets.flatMap((t) => t.cells ?? cellsOf(t.row)));
      if (acts.length === 0) {
        setNotice("没有可清除的软链接");
        return;
      }
      setConfirmClean(false);
      setPendingUnlink({ actions: acts, rows: targets.map(({ page, row }) => ({ page, row })) });
    } catch (e) {
      onError(String(e));
    }
  };

  if (!overview) return <p>扫描中…</p>;

  const pages =
    selectedKey === "all"
      ? overview.domains
      : overview.domains.filter((d) => d.key === selectedKey);
  const broken = pages.flatMap((p) => p.broken);
  // 引入只对单个域有意义：「全部」页没有确定的目标域
  const importPage = selectedKey === "all" ? null : (pages[0] ?? null);

  /// 该行在本域是否有可取消的链接（已链接且目标不是整目录链接）
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

  // 选中行的全部格；建链按它算
  const chosenCells: CellRef[] = chosen.flatMap(({ rows }) => rows.flatMap(cellsOf));
  // 可清链的行：选中、且有可清除的格。本体在本域的行也算，只清它在其他 harness 下的链接
  const clearableRows: UnlinkTarget[] = chosen.flatMap(({ page, rows }) =>
    rows.filter((row) => hasUnlinkable(page, row)).map((row) => ({ page, row })),
  );

  // 缺失按格算：一行在多个目标上缺失就算多处。
  // 多个 harness 共用一个目录时各自成列，按 cell.path 去重，同一处只算一次
  const missingPaths = new Set<string>();
  for (const { rows } of chosen) {
    for (const row of rows) {
      for (const cell of row.cells) if (cell.state === "missing") missingPaths.add(cell.path);
    }
  }
  const missing = missingPaths.size;

  return (
    <section>
      <div className="toolbar">
        <button
          onClick={() => setImportOpen(true)}
          disabled={busy || importPage === null}
          title={importPage === null ? "请先在侧栏选一个域" : "引入 skill 到本域"}
        >
          引入…
        </button>
        <button
          onClick={() => {
            setPendingUnlink(null);
            setConfirmClean(true);
          }}
          disabled={busy || broken.length === 0}
          title={broken.length === 0 ? "没有坏链" : "删除指向已不存在位置的软链接"}
        >
          清理坏链（{broken.length}）
        </button>
        <button onClick={() => void onRefresh()} disabled={busy}>
          刷新
        </button>
      </div>

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
          <span>已选 {chosenCount} 个 skill</span>
          <button
            onClick={() => void link(chosenCells)}
            disabled={busy || missing === 0}
            title={missing === 0 ? "选中的行里没有缺失的链接" : "给选中行缺失的 harness 建链"}
          >
            补齐缺失（{missing} 处）
          </button>
          <button
            onClick={() => void askUnlink(clearableRows)}
            disabled={busy || clearableRows.length === 0}
            title={
              clearableRows.length === 0
                ? "选中的行里没有可清除的软链接"
                : "清除选中行在本域各 harness 下的软链接"
            }
          >
            清除软链（{clearableRows.length} 个）
          </button>
          <button className="link" onClick={() => setSelected(new Set())}>
            取消选择
          </button>
        </div>
      )}

      {/* 结果框与提示浮在窗口右下角，同时出现时上下排开 */}
      <div className="floating">
        {notice && (
          <div className="report">
            <div className="report-head">
              <span>{notice}</span>
              <button className="link" onClick={() => setNotice(null)}>
                关闭
              </button>
            </div>
          </div>
        )}
        {report && (
          <div className="report">
            <div className="report-head">
              <span>本次结果（{report.entries.length} 条）</span>
              <button
                className="link"
                onClick={() => {
                  setReport(null);
                  setNotes([]);
                }}
              >
                关闭
              </button>
            </div>
            <ul>
              {report.entries.map((e) => (
                <li key={actionId(e.action)}>
                  {outcomeText(e.outcome)} · {e.action.targetPath}
                </li>
              ))}
            </ul>
            {notes.length > 0 && (
              <ul className="notes">
                {notes.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {pages.length === 0 ? (
        <p>没有可用的目标目录。</p>
      ) : (
        pages.map((page) => (
          <DomainView
            key={page.key}
            overview={overview}
            page={page}
            rows={visibleRows(page)}
            busy={busy}
            activeSources={filterSources.get(page.key) ?? new Set()}
            onToggleSource={(sourceId) => toggleSourceFilter(page, sourceId)}
            isSelected={(row) => isSelected(page, row)}
            onToggle={(row, shiftKey, ordered) => toggleRow(page, row, shiftKey, ordered)}
            onSelectAll={(want) => setPageAll(page, want)}
            onChange={onRefresh}
            onError={onError}
            onLink={link}
            onUnlink={askUnlink}
            onNotice={setNotice}
          />
        ))
      )}
      {confirmClean && (
        <div className="modal-backdrop" onClick={() => setConfirmClean(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="toolbar">
              <h2>清理坏链</h2>
            </div>
            <p>只删除链接本身，不删除任何真实文件。</p>
            <div className="toolbar">
              <button onClick={() => void run(broken, true)} disabled={busy}>
                确认删除
              </button>
              <button onClick={() => setConfirmClean(false)}>取消</button>
            </div>
          </div>
        </div>
      )}
      {pendingUnlink !== null && (
        <div className="modal-backdrop" onClick={() => setPendingUnlink(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="toolbar">
              <h2>清除软链</h2>
            </div>
            <p>
              将删除 {pendingUnlink.actions.length}{" "}
              条软链接，只删链接本身，不删任何真实文件。本体在本域的 skill 只清链接，本体目录不动。
            </p>
            <div className="toolbar">
              <button
                onClick={() => void run(pendingUnlink.actions, false, pendingUnlink.rows)}
                disabled={busy}
              >
                确认删除
              </button>
              <button onClick={() => setPendingUnlink(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
      {importOpen && importPage !== null && (
        <ImportDialog
          overview={overview}
          page={importPage}
          onClose={() => setImportOpen(false)}
          onChange={onRefresh}
          onReport={(r) => {
            setNotes([]);
            setReport(r);
          }}
          onError={onError}
          onNotice={setNotice}
        />
      )}
    </section>
  );
}
