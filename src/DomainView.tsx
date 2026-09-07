import { useState } from "react";
import { api } from "./api";
import ImportDialog from "./ImportDialog";
import { compareBy, STATE_RANK, toggleSort, type SortState } from "./sort";
import type { CellState, DomainPage, DomainRow, Overview, Pick } from "./types";

export interface DomainViewProps {
  overview: Overview;
  page: DomainPage;
  busy: boolean;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
}

const CELL_SYMBOL: Record<CellState, string> = {
  linked: "✓",
  missing: "○",
  broken: "✗",
  foreign: "→",
  duplicate: "⚠",
  unwritable: "–",
};
const CELL_TEXT: Record<CellState, string> = {
  linked: "已链接",
  missing: "未同步",
  broken: "坏链",
  foreign: "指向别处",
  duplicate: "已存在同名条目",
  unwritable: "整目录链接到其他本体位置",
};

/// 没有格子的行排在所有状态之后
const ABSENT_RANK = STATE_RANK.unwritable + 1;

const pickText = (pick: Pick): string => (pick === "all" ? "全部" : `${pick.only.length} 个`);

/// 一个域的整页：已引入来源标签行、行×目标的表格、坏链表
export default function DomainView({ overview, page, busy, onChange, onError }: DomainViewProps) {
  // 表头排序；null = 后端原序（skill 名再本体位置）
  const [sort, setSort] = useState<SortState | null>(null);
  // 引入弹层：null = 关闭；string 为预选的本体位置 id，"" 为不预选
  const [importing, setImporting] = useState<string | null>(null);
  // 待确认拆分整目录链接的目标 id
  const [confirmSplit, setConfirmSplit] = useState<string | null>(null);

  const targetIds = page.targets.map((t) => t.id);
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
        {page.imported.map((im) => (
          <span className="tag" key={im.sourceId} title={im.sourceId}>
            {labelOf(im.sourceId)} · {pickText(im.pick)}
            <button className="link" disabled={busy} onClick={() => setImporting(im.sourceId)}>
              编辑
            </button>
            <button
              className="link"
              disabled={busy}
              onClick={() => void run(() => api.removeSource(targetIds, im.sourceId))}
            >
              移除
            </button>
          </span>
        ))}
        <button disabled={busy} onClick={() => setImporting("")}>
          引入来源…
        </button>
      </div>

      {page.targets.length === 0 ? (
        <p>该域下没有可用的目标目录。</p>
      ) : (
        <table className="matrix">
          <thead>
            <tr>
              <th>{sortHeader("skill", "skill")}</th>
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
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={`${row.sourceId}|${row.skill}`}
                className={row.enabled ? undefined : "disabled"}
              >
                <td>
                  <label>
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      disabled={busy}
                      onChange={(e) =>
                        void run(() =>
                          api.setPick(targetIds, row.sourceId, row.skill, e.target.checked),
                        )
                      }
                    />
                    {row.skill}
                  </label>
                </td>
                <td className="path" title={row.sourceId}>
                  {labelOf(row.sourceId)}
                </td>
                {page.targets.map((target) => {
                  const cell = cellOf(row, target.id);
                  return (
                    <td
                      className={cell ? `cell ${cell.state}` : "cell"}
                      key={target.id}
                      title={cell ? `${CELL_TEXT[cell.state]}：${cell.path}` : undefined}
                    >
                      {cell ? CELL_SYMBOL[cell.state] : ""}
                    </td>
                  );
                })}
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
          onError={onError}
        />
      )}
    </div>
  );
}
