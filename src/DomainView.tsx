import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { compareBy, STATE_RANK, toggleSort, type SortState } from "./sort";
import type { AutoLink, CellRef, CellState, DomainPage, DomainRow, Overview } from "./types";

/// 交给容器去清除的一批软链：行（用于结果说明）+ 要清的格，省略 cells = 整行
export interface UnlinkTarget {
  page: DomainPage;
  row: DomainRow;
  cells?: CellRef[];
}

export interface DomainViewProps {
  overview: Overview;
  page: DomainPage;
  /// 全部自动同步规则；本组件只列目标落在本域的那些
  autoLinks: AutoLink[];
  /// 经过筛选、要显示的行；排序在本组件里做
  rows: DomainRow[];
  busy: boolean;
  /// 高亮的本体位置筛选片（空 = 不筛）
  activeSources: Set<string>;
  onToggleSource: (sourceId: string) => void;
  isSelected: (row: DomainRow) => boolean;
  /// 行首复选框：交回当前显示顺序的行，供 Shift 区间选择算区间
  onToggle: (row: DomainRow, shiftKey: boolean, ordered: DomainRow[]) => void;
  onSelectAll: (selected: boolean) => void;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
  /// 把格交给容器：建链、清链（走确认条）、只说明原因
  onLink: (cells: CellRef[]) => Promise<void>;
  onUnlink: (targets: UnlinkTarget[]) => Promise<void>;
  onNotice: (text: string) => void;
}

const CELL_SYMBOL: Record<CellState, string> = {
  own: "●",
  linked: "✓",
  // 部分覆盖不用图标，渲染时显示 linked/total
  partial: "",
  missing: "○",
  broken: "✗",
  foreign: "⚠",
  duplicate: "⚠",
  unwritable: "–",
};
/// 不能点的格：title 与点击提示都用这段原因
const CELL_TEXT: Record<CellState, string> = {
  own: "本体在此，不是链接",
  linked: "整目录链接，先拆成逐项链接",
  partial: "部分已链接",
  missing: "未同步",
  broken: "坏链，请用清理坏链",
  // 两种状态对用户是一回事：这里已有同名的东西（本体或指向别处的软链），不会覆盖
  foreign: "已有同名条目（本体或指向别处的软链接），不会覆盖",
  duplicate: "已有同名条目（本体或指向别处的软链接），不会覆盖",
  unwritable: "整目录链接，先拆成逐项链接",
};

/// 一行展开成它在本域各目标上的格
const cellsOf = (row: DomainRow): CellRef[] =>
  row.cells.map((c) => ({ sourceId: row.sourceId, skill: row.skill, targetId: c.targetId }));

/// 没有格子的行排在所有状态之后
const ABSENT_RANK = STATE_RANK.unwritable + 1;

/// 拼路径：Windows 路径用反斜杠，其余用斜杠
export const join = (dir: string, name: string) =>
  `${dir}${dir.includes("\\") ? "\\" : "/"}${name}`;

/// 一个域的整页：筛选片、行×目标的表格、坏链表
export default function DomainView({
  overview,
  page,
  autoLinks,
  rows: visible,
  busy,
  activeSources,
  onToggleSource,
  isSelected,
  onToggle,
  onSelectAll,
  onChange,
  onError,
  onLink,
  onUnlink,
  onNotice,
}: DomainViewProps) {
  // 表头排序；null = 后端原序（skill 名再本体位置）
  const [sort, setSort] = useState<SortState | null>(null);
  // 待确认拆分整目录链接的目标 id
  const [confirmSplit, setConfirmSplit] = useState<string | null>(null);

  const labelOf = (sourceId: string) =>
    overview.sources.find((s) => s.id === sourceId)?.label ?? sourceId;

  // skill 自带本体真实路径；查不到时回退到「本体位置目录 + 名字」
  const skillPathOf = (sourceId: string, skill: string) => {
    const source = overview.sources.find((s) => s.id === sourceId);
    return (
      source?.skills.find((sk) => sk.name === skill)?.path ?? join(source?.path ?? sourceId, skill)
    );
  };

  const isExternal = (sourceId: string) =>
    overview.sources.find((s) => s.id === sourceId)?.kind.type === "external";

  const targetLabelOf = (targetId: string) =>
    page.targets.find((t) => t.id === targetId)?.label ?? targetId;

  // 只列目标落在本域的规则，且每条只保留本域的那部分目标
  const rules = autoLinks
    .map((rule) => ({
      rule,
      local: rule.targets.filter((id) => page.targets.some((t) => t.id === id)),
    }))
    .filter((r) => r.local.length > 0);

  /// 在系统文件管理器里定位并选中该 skill 的本体目录
  const reveal = async (path: string) => {
    try {
      await api.revealInDir(path);
    } catch (e) {
      onError(String(e));
    }
  };

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

  /// 有缺口的格：整格缺失，或多目录列上只覆盖了一部分
  const hasMissing = (row: DomainRow) =>
    row.cells.some((c) => c.state === "missing" || c.state === "partial");

  /// 有链接已到位的格（本体不算），且它的目标不是整目录链接
  const hasUnlinkable = (row: DomainRow) =>
    row.cells.some(
      (c) =>
        c.linked > 0 &&
        c.state !== "own" &&
        page.targets.find((t) => t.id === c.targetId)?.linkedWholeTo === null,
    );

  // 筛选片按本域全部行统计本体位置，筛选不改变片上的计数
  const counts = new Map<string, number>();
  for (const row of page.rows) counts.set(row.sourceId, (counts.get(row.sourceId) ?? 0) + 1);

  // 表头全选框只看可见行：全选则勾，部分选中则半选
  const allSelected = visible.length > 0 && visible.every((r) => isSelected(r));
  const someSelected = !allSelected && visible.some((r) => isSelected(r));
  const allRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const rows = sort
    ? [...visible].sort(
        compareBy((row: DomainRow) => {
          if (sort.key === "skill") return row.skill;
          if (sort.key === "source") return labelOf(row.sourceId);
          const cell = cellOf(row, sort.key);
          return cell ? STATE_RANK[cell.state] : ABSENT_RANK;
        }, sort.dir),
      )
    : visible;

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

      {counts.size > 0 && (
        <div className="tags">
          {[...counts].map(([sourceId, n]) => (
            <button
              className={activeSources.has(sourceId) ? "tag active" : "tag"}
              key={sourceId}
              title={sourceId}
              disabled={busy}
              onClick={() => onToggleSource(sourceId)}
            >
              {labelOf(sourceId)} · {n}
            </button>
          ))}
        </div>
      )}

      {rules.length > 0 && (
        <div className="auto-rules">
          {rules.map(({ rule, local }) => (
            <div className="auto-rule" key={rule.source}>
              <span>
                自动同步：{labelOf(rule.source)} → {local.map((id) => targetLabelOf(id)).join("、")}
                {rule.excluded.length > 0 && `（排除 ${rule.excluded.length}）`}
              </span>
              <button
                className="link"
                title="不再自动同步到本域的这些目标"
                disabled={busy}
                onClick={() => void run(() => api.removeAutoLinkTargets(rule.source, local))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

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
                  disabled={busy || visible.length === 0}
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
                    {/* 用 onClick 是为了拿到 shiftKey；选中态仍由上层状态决定 */}
                    <input
                      type="checkbox"
                      checked={isSelected(row)}
                      disabled={busy}
                      readOnly
                      onClick={(e) => onToggle(row, e.shiftKey, rows)}
                    />
                    {row.skill}
                  </label>
                </td>
                <td className="path">
                  <button
                    className="link"
                    title={skillPathOf(row.sourceId, row.skill)}
                    disabled={busy}
                    onClick={() => void reveal(skillPathOf(row.sourceId, row.skill))}
                  >
                    {isExternal(row.sourceId) && <span className="whole-link">外部</span>}
                    {labelOf(row.sourceId)}
                  </button>
                </td>
                {page.targets.map((target) => {
                  const cell = cellOf(row, target.id);
                  if (!cell) return <td className="cell" key={target.id} />;
                  const ref: CellRef = {
                    sourceId: row.sourceId,
                    skill: row.skill,
                    targetId: target.id,
                  };
                  const linkable = cell.state === "missing" || cell.state === "partial";
                  const unlinkable =
                    cell.linked > 0 && cell.state !== "own" && target.linkedWholeTo === null;
                  const reason = CELL_TEXT[cell.state];
                  const base = linkable ? "点击建链" : unlinkable ? "点击取消此链接" : reason;
                  // 部分覆盖单说；其余状态在多目录列上标明这一格代表几处
                  const title =
                    cell.state === "partial"
                      ? `${cell.total} 个目录中 ${cell.linked} 个已链接，点补齐补上其余`
                      : cell.total > 1
                        ? `${base}（共 ${cell.total} 处）`
                        : base;
                  return (
                    <td className={`cell ${cell.state}`} key={target.id}>
                      <button
                        className={`cell ${cell.state}`}
                        disabled={busy}
                        title={title}
                        onClick={() => {
                          if (linkable) void onLink([ref]);
                          else if (unlinkable) void onUnlink([{ page, row, cells: [ref] }]);
                          else onNotice(reason);
                        }}
                      >
                        {cell.state === "partial"
                          ? `${cell.linked}/${cell.total}`
                          : CELL_SYMBOL[cell.state]}
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
                    disabled={busy || !hasUnlinkable(row)}
                    title={
                      hasUnlinkable(row)
                        ? "清除它在本域所有 harness 下的软链接"
                        : "没有可清除的软链接"
                    }
                    onClick={() => void onUnlink([{ page, row }])}
                  >
                    清除软链
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
                    {page.targets.find((t) => t.dirs.includes(action.target))?.label ??
                      action.target}
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
    </div>
  );
}
