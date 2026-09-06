import type { Cell, CellState, Overview, Source, Target } from "./types";

export interface DomainViewProps {
  overview: Overview;
  domainKey: string;
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
    const { project } = target.scope;
    if (seen.has(project)) continue;
    seen.add(project);
    entries.push({ key: `project:${project}`, label: lastSegment(project), path: project });
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

/// 单个域的只读表：行是 (本体位置, skill)，列是该域下的目标目录
export default function DomainView({ overview, domainKey }: DomainViewProps) {
  const targets = overview.targets.filter((t) => targetDomainKey(t) === domainKey);
  if (targets.length === 0) return <p>该域下没有可用的目标目录。</p>;

  const cells = new Map<string, Cell>();
  for (const cell of overview.cells) {
    cells.set(cellKey(cell.sourceId, cell.skill, cell.targetId), cell);
  }
  const rows = buildRows(overview.sources).filter((row) =>
    targets.some((target) => cells.has(cellKey(row.source.id, row.skill, target.id))),
  );
  const entry = domainEntries(overview.targets).find((e) => e.key === domainKey);

  return (
    <div className="domain-group">
      <h2 title={entry?.path ?? undefined}>{entry?.label ?? domainKey}</h2>
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
    </div>
  );
}
