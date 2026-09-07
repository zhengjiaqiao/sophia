import { useMemo, useState } from "react";
import { api } from "./api";
import { compareBy, STATE_RANK, toggleSort, type SortState } from "./sort";
import type { Cell, CellState, Overview, Source } from "./types";

export interface SourceViewProps {
  overview: Overview;
  source: Source;
  busy: boolean;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
}

const SYMBOL: Record<CellState, string> = {
  linked: "✓",
  missing: "○",
  broken: "✗",
  foreign: "→",
  duplicate: "⚠",
  unwritable: "–",
};

const STATE_TEXT: Record<CellState, string> = {
  linked: "已链接",
  missing: "缺失",
  broken: "坏链",
  foreign: "指向别处",
  duplicate: "已存在同名条目",
  unwritable: "整目录链接到其他本体位置",
};

const cellKey = (sourceId: string, skill: string, targetId: string) =>
  `${sourceId}|${skill}|${targetId}`;

/// 没有格子的行排在所有状态之后
const ABSENT_RANK = STATE_RANK.unwritable + 1;

/// 单个本体位置的卡片：两级勾选（目标 / skill）
export default function SourceView({ overview, source, busy, onChange, onError }: SourceViewProps) {
  // 待确认拆分的目标 id
  const [confirmSplit, setConfirmSplit] = useState<string | null>(null);
  // 表头排序；null = 后端原序
  const [sort, setSort] = useState<SortState | null>(null);

  const cells = useMemo(() => {
    const map = new Map<string, Cell>();
    for (const c of overview.cells) map.set(cellKey(c.sourceId, c.skill, c.targetId), c);
    return map;
  }, [overview]);

  // 写操作后统一重扫；失败只报错，不改本地状态
  const run = async (act: () => Promise<unknown>) => {
    try {
      await act();
      await onChange();
    } catch (e) {
      onError(String(e));
    }
  };

  const sync = overview.syncSet.sources[source.id];
  const picked = new Set(sync?.targets ?? []);
  const disabledSkills = new Set(sync?.disabledSkills ?? []);
  const columns = overview.targets.filter((t) => picked.has(t.id));

  const skills = sort
    ? [...source.skills].sort(
        compareBy((skill) => {
          if (sort.key === "skill") return skill;
          const cell = cells.get(cellKey(source.id, skill, sort.key));
          return cell ? STATE_RANK[cell.state] : ABSENT_RANK;
        }, sort.dir),
      )
    : source.skills;

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
    <div className="source-card">
      <h2>
        {source.label}
        {source.kind.type === "manual" && <span className="tag">手动添加</span>}
      </h2>
      <div className="path">{source.path}</div>

      <div className="target-picks">
        {overview.targets.map((target) => (
          <label key={target.id}>
            <input
              type="checkbox"
              checked={picked.has(target.id)}
              disabled={busy}
              onChange={(e) => {
                const ids = e.target.checked
                  ? [...picked, target.id]
                  : [...picked].filter((id) => id !== target.id);
                void run(() => api.setSourceTargets(source.id, ids));
              }}
            />
            {target.label}
          </label>
        ))}
      </div>

      <table className="matrix">
        <thead>
          <tr>
            <th>{sortHeader("skill", "skill")}</th>
            {columns.map((target) => (
              <th key={target.id}>
                {sortHeader(target.id, target.label)}
                {target.linkedWholeTo === source.id && (
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
          {skills.map((skill) => {
            const enabled = !disabledSkills.has(skill);
            return (
              <tr key={skill} className={enabled ? undefined : "disabled"}>
                <td>
                  <label>
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={busy}
                      onChange={(e) =>
                        void run(() => api.setSkillEnabled(source.id, skill, e.target.checked))
                      }
                    />
                    {skill}
                  </label>
                </td>
                {columns.map((target) => {
                  const cell = cells.get(cellKey(source.id, skill, target.id));
                  if (!cell) return <td className="cell" key={target.id} />;
                  return (
                    <td
                      className={`cell ${cell.state}`}
                      key={target.id}
                      title={`${STATE_TEXT[cell.state]}：${cell.path}`}
                    >
                      {SYMBOL[cell.state]}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
