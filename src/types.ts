// 与 crates/core/src/models.rs、skills.rs 的 serde 输出一一对应（camelCase）
export type Domain = { type: "global" } | { type: "project"; path: string };
export interface DomainInfo {
  domain: Domain;
  label: string;
}

export type CellState =
  "home" | "linked" | "missing" | "broken" | "foreign" | "duplicateHome" | "inaccessible";
export interface Column {
  id: string;
  label: string;
  path: string;
  universal: boolean;
}
export interface Cell {
  columnId: string;
  path: string;
  state: CellState;
}
export interface SkillRow {
  name: string;
  home: string | null;
  externalHome: boolean;
  cells: Cell[];
  ambiguous: boolean;
}
export interface Summary {
  skills: number;
  missing: number;
  broken: number;
  ambiguous: number;
}
export interface Matrix {
  domain: Domain;
  columns: Column[];
  rows: SkillRow[];
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
