// 与 crates/core/src/models.rs 的 serde 输出一一对应（camelCase）
export type Domain = { type: "global" } | { type: "project"; path: string };
export interface DomainInfo {
  domain: Domain;
  label: string;
}

export type SourceKind =
  | { type: "universal" }
  | { type: "harnessGlobal"; harnessId: string }
  | { type: "projectStore"; project: string; projectLabel: string | null }
  | { type: "manual" };
export interface Source {
  id: string;
  path: string;
  kind: SourceKind;
  label: string;
  skills: string[];
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

export type CellState = "linked" | "missing" | "broken" | "foreign" | "duplicate" | "unwritable";
export interface Cell {
  sourceId: string;
  skill: string;
  targetId: string;
  path: string;
  state: CellState;
}

/// 某目标从某本体位置引入哪些 skill；条目存在即已引入
export type Pick = "all" | { only: string[] };
export interface SyncSet {
  /// 目标 id → 本体位置 id → 选择
  picks: Record<string, Record<string, Pick>>;
}

/// 域页表格的一行：一个 (本体位置, skill) 在本域各目标上的状态
export interface DomainRow {
  sourceId: string;
  skill: string;
  imported: boolean;
  linked: boolean;
  enabled: boolean;
  cells: Cell[];
}

export interface ImportedSource {
  sourceId: string;
  pick: Pick;
}

/// 一个域（全局或某项目）的整页数据
export interface DomainPage {
  key: string;
  label: string;
  targets: Target[];
  imported: ImportedSource[];
  rows: DomainRow[];
  broken: PlannedAction[];
  pendingMissing: number;
}

export interface Overview {
  domains: DomainPage[];
  sources: Source[];
  syncSet: SyncSet;
}

export type ActionKind = "create" | "alreadyLinked" | "conflict" | "sourceMissing" | "brokenLink";
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

export type Selection = "all" | { items: string[] };
export interface SyncRule {
  id: string;
  name: string;
  source: string;
  selection: Selection;
  targets: string[];
  lastRunAt: string | null;
}

export interface HarnessStatus {
  id: string;
  displayName: string;
  enabled: boolean;
}

export const actionId = (a: PlannedAction): string => `${a.kind}|${a.targetPath}`;
export const domainKey = (d: Domain): string =>
  d.type === "global" ? "global" : `project:${d.path}`;
