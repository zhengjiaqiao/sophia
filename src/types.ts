// 与 crates/core/src/models.rs 的 serde 输出一一对应（camelCase）
export type SourceKind =
  | { type: "universal" }
  | { type: "harnessGlobal"; harnessId: string }
  | { type: "projectStore"; project: string; projectLabel: string | null }
  | { type: "manual" }
  | { type: "external" };

/// 一个 skill 本体：名字 + 本体真实路径（常规位置为 目录/名字）
export interface Skill {
  name: string;
  path: string;
}

export interface Source {
  id: string;
  path: string;
  kind: SourceKind;
  label: string;
  skills: Skill[];
}

export type TargetScope =
  | { type: "global"; harnessId: string }
  | { type: "project"; project: string; projectLabel: string | null; harnessId: string };
export interface Target {
  id: string;
  label: string;
  path: string;
  scope: TargetScope;
  linkedWholeTo: string | null;
}

export type CellState =
  "own" | "linked" | "missing" | "broken" | "foreign" | "duplicate" | "unwritable";
export interface Cell {
  sourceId: string;
  skill: string;
  targetId: string;
  path: string;
  state: CellState;
}

/// 域页表格的一行：一个 (本体位置, skill) 在本域各目标上的状态
export interface DomainRow {
  sourceId: string;
  skill: string;
  /// 该行的本体位置属于本域（本域里的 skill 本体，不能整个删除）
  own: boolean;
  cells: Cell[];
}

/// 一个域（全局或某项目）的整页数据
export interface DomainPage {
  key: string;
  label: string;
  targets: Target[];
  rows: DomainRow[];
  broken: PlannedAction[];
}

export interface Overview {
  domains: DomainPage[];
  sources: Source[];
}

/// 一个格：本体位置 id + skill + 目标 id。目标 id 决定域；格不必已出现在表里（引入弹层用）
export interface CellRef {
  sourceId: string;
  skill: string;
  targetId: string;
}

export type ActionKind = "create" | "brokenLink" | "unlink";
export interface PlannedAction {
  kind: ActionKind;
  itemName: string;
  sourcePath: string;
  targetPath: string;
  target: string;
}
export type Outcome =
  | { status: "created" }
  | { status: "skipped" }
  | { status: "removed" }
  | { status: "failed"; reason: string };
export interface ReportEntry {
  action: PlannedAction;
  outcome: Outcome;
}
export interface SyncReport {
  entries: ReportEntry[];
}

/// 一条自动同步规则：该本体位置下的全部 skill（排除名单除外）持续补齐到这些目标
export interface AutoLink {
  /// 归一化后的本体位置路径，与 Source.id / Source.path 可直接比较
  source: string;
  targets: string[];
  /// 手动清除过、不再自动链接的 skill
  excluded: string[];
}

export interface HarnessStatus {
  id: string;
  displayName: string;
  enabled: boolean;
}

export const actionId = (a: PlannedAction): string => `${a.kind}|${a.targetPath}`;
