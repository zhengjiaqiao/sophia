import { api } from "./api";
import type { Cell, CellState, Overview, Source, Target } from "./types";

export interface DomainViewProps {
  overview: Overview;
  domainKey: string;
  busy: boolean;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
}

/// 格子符号与状态文案，与按本体位置视图一致
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
  duplicate: "重复",
  unwritable: "不可写",
};

const cellKey = (sourceId: string, skill: string, targetId: string) =>
  `${sourceId}|${skill}|${targetId}`;

/// 项目路径末段作展示名；末尾斜杠不算一段
const lastSegment = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;

/// 目标所属域：全局，或所在项目
const targetDomainKey = (target: Target): string =>
  target.scope.type === "global" ? "global" : `project:${target.scope.project}`;

/// 本体位置所属域：项目通用仓库归它自己的项目，其余（通用仓库、harness 全局、手动）归全局
const sourceDomainKey = (source: Source): string =>
  source.kind.type === "projectStore" ? `project:${source.kind.project}` : "global";

export interface DomainEntry {
  key: string;
  label: string;
  /// 全局域没有完整路径可挂
  path: string | null;
}

/// 侧栏用的域列表：先"全局"，再按 targets 里项目首次出现的顺序
export function domainEntries(targets: Target[]): DomainEntry[] {
  const entries: DomainEntry[] = [{ key: "global", label: "全局", path: null }];
  const seen = new Set<string>();
  for (const target of targets) {
    if (target.scope.type !== "project") continue;
    const { project, projectLabel } = target.scope;
    if (seen.has(project)) continue;
    seen.add(project);
    entries.push({
      key: `project:${project}`,
      // 后端给了标签（如 agent 派生目录）就用它，否则退回路径末段
      label: projectLabel ?? lastSegment(project),
      path: project,
    });
  }
  return entries;
}

interface Row {
  source: Source;
  skill: string;
}

/// 所有 (本体位置, skill) 对，按 skill 名再按本体位置 label 排序
function buildRows(sources: Source[]): Row[] {
  const rows: Row[] = sources.flatMap((source) =>
    source.skills.map((skill) => ({ source, skill })),
  );
  return rows.sort(
    (a, b) => a.skill.localeCompare(b.skill) || a.source.label.localeCompare(b.source.label),
  );
}

/// 本体位置对本域的参与度：本域全部目标都在它的目标集合里 / 只在一部分 / 一个都不在
type Participation = "all" | "some" | "none";

/// 单个域的表：行是属于该域的本体位置的 (本体位置, skill)，列是该域下的目标目录；
/// 表上方每个本体位置一个复选框，控制它是否参与同步进本域；跨域同步在按本体位置视图处理
export default function DomainView({
  overview,
  domainKey,
  busy,
  onChange,
  onError,
}: DomainViewProps) {
  const targets = overview.targets.filter((t) => targetDomainKey(t) === domainKey);
  if (targets.length === 0) return <p>该域下没有可用的目标目录。</p>;
  const sources = overview.sources.filter((s) => sourceDomainKey(s) === domainKey);
  const allRows = buildRows(sources);
  if (allRows.length === 0) return <p>该域下没有本体位置。</p>;

  const cells = new Map<string, Cell>();
  for (const cell of overview.cells) {
    cells.set(cellKey(cell.sourceId, cell.skill, cell.targetId), cell);
  }
  const entry = domainEntries(overview.targets).find((e) => e.key === domainKey);

  const domainTargetIds = targets.map((t) => t.id);
  const pickedOf = (source: Source): string[] => overview.syncSet.sources[source.id]?.targets ?? [];
  const participation = new Map<string, Participation>(
    sources.map((source) => {
      const picked = new Set(pickedOf(source));
      const hit = domainTargetIds.filter((id) => picked.has(id)).length;
      return [source.id, hit === 0 ? "none" : hit === domainTargetIds.length ? "all" : "some"];
    }),
  );
  // 取消勾选（一个本域目标都没选）的本体位置，行不再显示；半选仍显示
  const rows = allRows.filter((row) => participation.get(row.source.id) !== "none");

  // 勾上 = 把本域全部目标并入该本体位置的目标集合，取消 = 从中去掉本域全部目标
  const toggle = async (source: Source, on: boolean) => {
    const picked = pickedOf(source);
    const ids = on
      ? [...new Set([...picked, ...domainTargetIds])]
      : picked.filter((id) => !domainTargetIds.includes(id));
    try {
      await api.setSourceTargets(source.id, ids);
      await onChange();
    } catch (e) {
      onError(String(e));
    }
  };

  return (
    <div className="domain-group">
      <h2 title={entry?.path ?? undefined}>{entry?.label ?? domainKey}</h2>
      <div className="target-picks">
        {sources.map((source) => {
          const state = participation.get(source.id);
          return (
            <label key={source.id} title={source.path}>
              <input
                type="checkbox"
                checked={state === "all"}
                ref={(el) => {
                  if (el) el.indeterminate = state === "some";
                }}
                disabled={busy}
                onChange={(e) => void toggle(source, e.target.checked)}
              />
              {source.label} ({source.skills.length})
            </label>
          );
        })}
      </div>
      {rows.length === 0 ? (
        <p>本域没有参与同步的本体位置。</p>
      ) : (
        <table className="matrix">
          <thead>
            <tr>
              <th>skill</th>
              <th>本体位置</th>
              {targets.map((target) => (
                <th key={target.id}>{target.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.source.id}|${row.skill}`}>
                <td>{row.skill}</td>
                <td className="path" title={row.source.path}>
                  {row.source.label}
                </td>
                {targets.map((target) => {
                  const cell = cells.get(cellKey(row.source.id, row.skill, target.id)) ?? null;
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
    </div>
  );
}
