import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import ImportDialog from "./ImportDialog";
import { compareBy, STATE_RANK, toggleSort, type SortState } from "./sort";
import type { CellRef, CellState, DomainPage, DomainRow, Overview, SyncReport } from "./types";

export interface DomainViewProps {
  overview: Overview;
  page: DomainPage;
  busy: boolean;
  isSelected: (row: DomainRow) => boolean;
  onToggle: (row: DomainRow) => void;
  onSelectAll: (selected: boolean) => void;
  onChange: () => Promise<void>;
  onReport: (report: SyncReport) => void;
  onError: (message: string) => void;
  /// 把格交给容器：建链、删链（走确认条）、只说明原因
  onLink: (cells: CellRef[]) => Promise<void>;
  onUnlink: (cells: CellRef[]) => Promise<void>;
  onNotice: (text: string) => void;
}

const CELL_SYMBOL: Record<CellState, string> = {
  own: "●",
  linked: "✓",
  missing: "○",
  broken: "✗",
  foreign: "→",
  duplicate: "⚠",
  unwritable: "–",
};
/// 不能点的格：title 与点击提示都用这段原因
const CELL_TEXT: Record<CellState, string> = {
  own: "本体在此，不是链接",
  linked: "整目录链接，先拆成逐项链接",
  missing: "未同步",
  broken: "坏链，请用清理坏链",
  foreign: "指向别处的软链，不归本工具管理",
  duplicate: "已有同名真实条目，不会覆盖",
  unwritable: "整目录链接，先拆成逐项链接",
};

/// 一行展开成它在本域各目标上的格
const cellsOf = (row: DomainRow): CellRef[] =>
  row.cells.map((c) => ({ sourceId: row.sourceId, skill: row.skill, targetId: c.targetId }));

/// 没有格子的行排在所有状态之后
const ABSENT_RANK = STATE_RANK.unwritable + 1;

/// 一个域的整页：来源标签行、行×目标的表格、坏链表
export default function DomainView({
  overview,
  page,
  busy,
  isSelected,
  onToggle,
  onSelectAll,
  onChange,
  onReport,
  onError,
  onLink,
  onUnlink,
  onNotice,
}: DomainViewProps) {
  // 表头排序；null = 后端原序（skill 名再本体位置）
  const [sort, setSort] = useState<SortState | null>(null);
  // 引入弹层：null = 关闭；string 为预选的本体位置 id，"" 为不预选
  const [importing, setImporting] = useState<string | null>(null);
  // 待确认拆分整目录链接的目标 id
  const [confirmSplit, setConfirmSplit] = useState<string | null>(null);

  const labelOf = (sourceId: string) =>
    overview.sources.find((s) => s.id === sourceId)?.label ?? sourceId;

  // 写操作后统一重扫；失败只报错，不改本地状态
  const run = async (act: () => Promise<unknown>) => {
    try {
      await act();
      await onChange();
    } catch (e) {
      onError(String(e));
    }
  };

  const cellOf = (row: DomainRow, targetId: string) =>
    row.cells.find((c) => c.targetId === targetId) ?? null;

  const hasMissing = (row: DomainRow) => row.cells.some((c) => c.state === "missing");

  /// 有已链接的格，且它的目标不是整目录链接
  const hasUnlinkable = (row: DomainRow) =>
    row.cells.some(
      (c) =>
        c.state === "linked" &&
        page.targets.find((t) => t.id === c.targetId)?.linkedWholeTo === null,
    );

  // 标签行按行统计本域出现过的本体位置
  const counts = new Map<string, number>();
  for (const row of page.rows) counts.set(row.sourceId, (counts.get(row.sourceId) ?? 0) + 1);

  // 表头全选框：全勾则勾，部分勾则半选
  const allSelected = page.rows.length > 0 && page.rows.every((r) => isSelected(r));
  const someSelected = !allSelected && page.rows.some((r) => isSelected(r));
  const allRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const rows = sort
    ? [...page.rows].sort(
        compareBy((row: DomainRow) => {
          if (sort.key === "skill") return row.skill;
          if (sort.key === "source") return labelOf(row.sourceId);
          const cell = cellOf(row, sort.key);
          return cell ? STATE_RANK[cell.state] : ABSENT_RANK;
        }, sort.dir),
      )
    : page.rows;

  const sortHeader = (key: string, label: string) => (
    <button
      className={sort?.key === key ? "sort active" : "sort"}
      onClick={() => setSort((prev) => toggleSort(prev, key))}
    >
      {label}
      {sort?.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
    </button>
  );

  return (
    <div className="domain-group">
      <h2>{page.label}</h2>

      <div className="tags">
        {[...counts].map(([sourceId, n]) => (
          <button
            className="tag"
            key={sourceId}
            title={sourceId}
            disabled={busy}
            onClick={() => setImporting(sourceId)}
          >
            {labelOf(sourceId)} · {n} 个
          </button>
        ))}
        <button disabled={busy} onClick={() => setImporting("")}>
          引入…
        </button>
      </div>

      {page.targets.length === 0 ? (
        <p>该域下没有可用的目标目录。</p>
      ) : (
        <table className="matrix">
          <thead>
            <tr>
              <th>
                <input
                  ref={allRef}
                  type="checkbox"
                  checked={allSelected}
                  disabled={busy}
                  onChange={() => onSelectAll(!allSelected)}
                />
                {sortHeader("skill", "skill")}
              </th>
              <th>{sortHeader("source", "本体位置")}</th>
              {page.targets.map((target) => (
                <th key={target.id}>
                  {sortHeader(target.id, target.label)}
                  {target.linkedWholeTo !== null && (
                    <>
                      <span className="whole-link">整目录链接</span>
                      {confirmSplit === target.id ? (
                        <span className="confirm">
                          <button
                            disabled={busy}
                            onClick={() => {
                              setConfirmSplit(null);
                              void run(() => api.splitWholeLink(target.id));
                            }}
                          >
                            确认
                          </button>
                          <button disabled={busy} onClick={() => setConfirmSplit(null)}>
                            取消
                          </button>
                        </span>
                      ) : (
                        <button disabled={busy} onClick={() => setConfirmSplit(target.id)}>
                          拆成逐项链接
                        </button>
                      )}
                    </>
                  )}
                </th>
              ))}
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.sourceId}|${row.skill}`}>
                <td>
                  <label>
                    <input
                      type="checkbox"
                      checked={isSelected(row)}
                      disabled={busy}
                      onChange={() => onToggle(row)}
                    />
                    {row.skill}
                  </label>
                </td>
                <td className="path" title={row.sourceId}>
                  {labelOf(row.sourceId)}
                </td>
                {page.targets.map((target) => {
                  const cell = cellOf(row, target.id);
                  if (!cell) return <td className="cell" key={target.id} />;
                  const ref: CellRef = {
                    sourceId: row.sourceId,
                    skill: row.skill,
                    targetId: target.id,
                  };
                  const linkable = cell.state === "missing";
                  const unlinkable = cell.state === "linked" && target.linkedWholeTo === null;
                  const reason = CELL_TEXT[cell.state];
                  const title = linkable ? "点击建链" : unlinkable ? "点击取消此链接" : reason;
                  return (
                    <td className={`cell ${cell.state}`} key={target.id}>
                      <button
                        className={`cell ${cell.state}`}
                        disabled={busy}
                        title={title}
                        onClick={() => {
                          if (linkable) void onLink([ref]);
                          else if (unlinkable) void onUnlink([ref]);
                          else onNotice(reason);
                        }}
                      >
                        {CELL_SYMBOL[cell.state]}
                      </button>
                    </td>
                  );
                })}
                <td className="row-actions">
                  <button
                    disabled={busy || !hasMissing(row)}
                    title={hasMissing(row) ? "给缺失的 harness 建链" : "没有缺失的链接"}
                    onClick={() => void onLink(cellsOf(row))}
                  >
                    补齐
                  </button>
                  <button
                    disabled={busy || row.own || !hasUnlinkable(row)}
                    title={
                      row.own
                        ? "本体在本域，不能删除；可逐个取消某个 harness 下的链接"
                        : hasUnlinkable(row)
                          ? "删除它在本域所有 harness 下的链接"
                          : "没有可删除的链接"
                    }
                    onClick={() => void onUnlink(cellsOf(row))}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {page.broken.length > 0 && (
        <div className="broken-section">
          <div className="toolbar">
            <span>坏链（{page.broken.length}）</span>
          </div>
          <table className="matrix">
            <thead>
              <tr>
                <th>链接名</th>
                <th>目标目录</th>
                <th>指向</th>
              </tr>
            </thead>
            <tbody>
              {page.broken.map((action) => (
                <tr key={action.targetPath}>
                  <td>{action.itemName}</td>
                  <td className="path" title={action.target}>
                    {page.targets.find((t) => t.path === action.target)?.label ?? action.target}
                  </td>
                  <td className="path" title={action.sourcePath}>
                    {action.sourcePath}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {importing !== null && (
        <ImportDialog
          overview={overview}
          page={page}
          initialSourceId={importing || undefined}
          onClose={() => setImporting(null)}
          onChange={onChange}
          onReport={onReport}
          onError={onError}
          onNotice={onNotice}
        />
      )}
    </div>
  );
}
