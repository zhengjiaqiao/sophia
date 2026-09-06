import { useMemo, useState } from "react";
import { api } from "./api";
import type { Cell, CellState, Overview } from "./types";

export interface ViewProps {
  overview: Overview;
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

/// 按本体位置的卡片视图：一张卡片 = 一个本体位置，两级勾选（目标 / skill）
export default function SourceView({ overview, busy, onChange, onError }: ViewProps) {
  // 待确认拆分的目标 id
  const [confirmSplit, setConfirmSplit] = useState<string | null>(null);

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

  return (
    <>
      {overview.sources.map((source) => {
        const sync = overview.syncSet.sources[source.id];
        const picked = new Set(sync?.targets ?? []);
        const disabledSkills = new Set(sync?.disabledSkills ?? []);
        const columns = overview.targets.filter((t) => picked.has(t.id));

        return (
          <div className="source-card" key={source.id}>
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
                  <th>skill</th>
                  {columns.map((target) => (
                    <th key={target.id}>
                      {target.label}
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
                {source.skills.map((skill) => {
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
                              void run(() =>
                                api.setSkillEnabled(source.id, skill, e.target.checked),
                              )
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
      })}
    </>
  );
}
