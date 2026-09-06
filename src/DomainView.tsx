import type { Cell, CellState, Overview, Source, Target } from "./types";

export interface ViewProps {
  overview: Overview;
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

/// 项目路径末段作分组标题；末尾斜杠不算一段
const lastSegment = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;

interface Group {
  key: string;
  title: string;
  /// 全局组没有完整路径可挂
  path: string | null;
  targets: Target[];
}

/// 先"全局"一组，再按 targets 里项目首次出现的顺序各一组
function groupTargets(targets: Target[]): Group[] {
  const global: Group = { key: "global", title: "全局", path: null, targets: [] };
  const projects = new Map<string, Group>();
  for (const target of targets) {
    if (target.scope.type === "global") {
      global.targets.push(target);
      continue;
    }
    const { project } = target.scope;
    let group = projects.get(project);
    if (!group) {
      group = {
        key: `project:${project}`,
        title: lastSegment(project),
        path: project,
        targets: [],
      };
      projects.set(project, group);
    }
    group.targets.push(target);
  }
  const groups = [...projects.values()];
  return global.targets.length > 0 ? [global, ...groups] : groups;
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

export default function DomainView({ overview }: ViewProps) {
  const cells = new Map<string, Cell>();
  for (const cell of overview.cells) {
    cells.set(cellKey(cell.sourceId, cell.skill, cell.targetId), cell);
  }
  const rows = buildRows(overview.sources);
  const groups = groupTargets(overview.targets);

  if (groups.length === 0) return <p>没有可用的目标目录。</p>;

  return (
    <div>
      {groups.map((group) => {
        const groupRows = rows.filter((row) =>
          group.targets.some((target) => cells.has(cellKey(row.source.id, row.skill, target.id))),
        );
        return (
          <div className="domain-group" key={group.key}>
            <h2 title={group.path ?? undefined}>{group.title}</h2>
            <table className="matrix">
              <thead>
                <tr>
                  <th>skill</th>
                  <th>本体位置</th>
                  {group.targets.map((target) => (
                    <th key={target.id}>{target.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groupRows.map((row) => (
                  <tr key={`${row.source.id}|${row.skill}`}>
                    <td>{row.skill}</td>
                    <td className="path" title={row.source.path}>
                      {row.source.label}
                    </td>
                    {group.targets.map((target) => {
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
      })}
    </div>
  );
}
