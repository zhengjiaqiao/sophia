/// Skills 的位置集合 → 一张表（spec 2026-09-26-object-first-navigation R6 R7）。
///
/// 范围里可能不止一个位置（`全部` = 用户级 + 选中的项目）。每个位置是一页（`DomainPage`）；
/// 这里把几页并成一张表：行带上自己的位置（同一个 skill 装在两处就是两行，不合并），
/// 列按 agent 归并（Codex 在用户级与 CardBox 的两个目标同一列），（行，列）落到这一行自己位置的目标上。
/// 只有一个位置时与那一页一一对应，不出位置列。
///
/// 目标 id 本身带位置（core `discovery` / `skills` 同一写法）：用户级是 `<harness>`，
/// 项目是 `project:<路径>::<harness>`。所以 `CellRef` 不用改，写入 api 也不用改——
/// 一批格可以跨位置，core 按每一格自己的目标 id 去写。
///
/// 纯逻辑，不碰 api、不产 JSX。
import { orphanRows, ORPHAN_KEY_PREFIX, type OrphanRow } from "./orphanRows.ts";
import { shortPath } from "./pathText.ts";
import type { CellRef, CellState, DomainPage, DomainRow, PlannedAction, Target } from "./types.ts";

export const GLOBAL_KEY = "global";
const PROJECT_PREFIX = "project:";
const SEP = "::";

/// 目标所在的位置（域 key）
export function domainOfTarget(targetId: string): string {
  if (!targetId.startsWith(PROJECT_PREFIX)) return GLOBAL_KEY;
  const at = targetId.lastIndexOf(SEP);
  return at < 0 ? targetId : targetId.slice(0, at);
}

/// 目标归到哪一列：按 agent（harness id）归并
export function columnOfTarget(targetId: string): string {
  const at = targetId.lastIndexOf(SEP);
  return at < 0 ? targetId : targetId.slice(at + SEP.length);
}

/// 还没扫描出页的位置的显示名：项目取文件夹名（`project:/…/CardBox` → `CardBox`）
export const folderLabel = (key: string): string =>
  key === GLOBAL_KEY
    ? "用户级"
    : (key
        .replace(/^project:/, "")
        .split(/[/\\]+/)
        .filter(Boolean)
        .pop() ?? key);

export interface SkillRow extends DomainRow {
  domainKey: string;
}

/// 孤链行，带上它所在的位置
export interface PlacedOrphan extends OrphanRow {
  domainKey: string;
}

export interface SkillColumn {
  /// 列 id：agent 的 harness id
  id: string;
  agentId: string;
  label: string;
  /// 位置 key → 这个 agent 在那个位置的目标（按页的次序）
  targets: Map<string, Target>;
}

export interface SkillsView {
  /// 位置 key → 位置列里写的名字；只有一个位置时是空的（不出位置列）
  places: Map<string, string>;
  columns: SkillColumn[];
  rows: SkillRow[];
  orphans: PlacedOrphan[];
  /// 各位置扫到的失效链接（点失效格重新链接时，先清掉的那条）
  broken: PlannedAction[];
}

/// 行键：位置 + 本体位置 + skill（同一个 skill 在两个位置是两行）
export const skillRowKey = (row: { domainKey: string; sourceId: string; skill: string }) =>
  `${row.domainKey}|${row.sourceId}|${row.skill}`;

/// 一格所在那一行的键：位置从目标 id 里读
export const refRowKey = (ref: CellRef) =>
  skillRowKey({
    domainKey: domainOfTarget(ref.targetId),
    sourceId: ref.sourceId,
    skill: ref.skill,
  });

/// 位置列里的名字：同名项目带短路径区分（与「更多」列表同一个短路径）
function placeNames(pages: ReadonlyArray<DomainPage>): Map<string, string> {
  const out = new Map<string, string>();
  if (pages.length < 2) return out;
  const count = new Map<string, number>();
  for (const p of pages) count.set(p.label, (count.get(p.label) ?? 0) + 1);
  for (const p of pages) {
    const dup = (count.get(p.label) ?? 0) > 1 && p.key !== GLOBAL_KEY;
    out.set(p.key, dup ? `${p.label} · ${shortPath(p.key.slice(PROJECT_PREFIX.length))}` : p.label);
  }
  return out;
}

export function mergeSkillPages(pages: ReadonlyArray<DomainPage>): SkillsView {
  const columns = new Map<string, SkillColumn>();
  for (const page of pages) {
    for (const target of page.targets) {
      const id = target.scope.harnessId;
      const col = columns.get(id) ?? { id, agentId: id, label: target.label, targets: new Map() };
      col.targets.set(page.key, target);
      columns.set(id, col);
    }
  }
  return {
    places: placeNames(pages),
    columns: [...columns.values()],
    rows: pages.flatMap((page) => page.rows.map((row) => ({ ...row, domainKey: page.key }))),
    orphans: pages.flatMap((page) =>
      orphanRows(page).map((o) => ({
        ...o,
        key: `${ORPHAN_KEY_PREFIX}${page.key}|${o.skill}`,
        domainKey: page.key,
      })),
    ),
    broken: pages.flatMap((page) => page.broken),
  };
}

/// 这一行在这一列的格：这一行自己位置里这个 agent 的目标；那个位置没有这个 agent、或这一行在它上面没有格，就是 null
export function refAt(row: SkillRow, column: SkillColumn): CellRef | null {
  const target = column.targets.get(row.domainKey);
  if (!target || !row.cells.some((c) => c.targetId === target.id)) return null;
  return { sourceId: row.sourceId, skill: row.skill, targetId: target.id };
}

/// 选中的行 × 一列（选择行里那一点）：按各行自己位置的格分成能加的、能移除的、原件、受阻
export function columnPress(
  rows: ReadonlyArray<SkillRow>,
  column: SkillColumn,
  stateOf: (ref: CellRef, actual: CellState) => CellState,
): { linked: CellRef[]; missing: CellRef[]; own: string[]; blocked: string[]; targets: Target[] } {
  const linked: CellRef[] = [];
  const missing: CellRef[] = [];
  const own: string[] = [];
  const blocked: string[] = [];
  const targets = new Set<Target>();
  for (const row of rows) {
    const ref = refAt(row, column);
    if (ref === null) continue;
    targets.add(column.targets.get(row.domainKey)!);
    const actual = row.cells.find((c) => c.targetId === ref.targetId)!.state;
    const s = stateOf(ref, actual);
    if (s === "linked") linked.push(ref);
    else if (s === "missing") missing.push(ref);
    else if (s === "own") own.push(row.skill);
    else blocked.push(row.skill);
  }
  return { linked, missing, own, blocked, targets: [...targets] };
}
