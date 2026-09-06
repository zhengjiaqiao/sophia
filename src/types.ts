// 与 crates/core/src/models.rs 的 serde 输出一一对应（camelCase）
export type Domain = { type: "global" } | { type: "project"; path: string };
export interface DomainInfo {
  domain: Domain;
  label: string;
}

export type SourceKind =
  | { type: "universal" }
  | { type: "harnessGlobal"; harnessId: string }
  | { type: "projectStore"; project: string }
  | { type: "harnessExtra"; harnessId: string; label: string }
  | { type: "manual" };
export interface Source {
  id: string;
  path: string;
  kind: SourceKind;
  label: string;
  skills: string[];
}

export type TargetScope =
  { type: "global"; harnessId: string } | { type: "project"; project: string; harnessId: string };
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

export interface SourceSync {
  targets: string[];
  disabledSkills: string[];
}
export interface SyncSet {
  sources: Record<string, SourceSync>;
}

export interface Summary {
  sources: number;
  pendingMissing: number;
  broken: number;
}

export interface Overview {
  sources: Source[];
  targets: Target[];
  cells: Cell[];
  syncSet: SyncSet;
  summary: Summary;
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
