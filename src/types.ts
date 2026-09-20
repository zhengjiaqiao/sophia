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
  /// 目录是否已存在；false 的目标照常成列，列头标「将新建目录」，建链时自动创建
  exists: boolean;
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
  /// 本域全部目标，即表格的列；目录尚不存在的也在其中（列头标「将新建目录」）
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

export interface McpLocation {
  id: string;
  label: string;
  harnessId: string;
  domain: string;
  path: string;
  selector?: string;
  /** 发现了配置位置，但不参与普通矩阵；引入时仍可作为目标。 */
  matrixHidden?: boolean;
}

export type McpCellState =
  "own" | "equal" | "sameEndpoint" | "missing" | "conflict" | "invalid" | "unsupported";
export interface McpCell {
  targetId: string;
  state: McpCellState;
  reason: string | null;
}
export interface McpEntry {
  sourceId: string;
  name: string;
  transport: "stdio" | "http" | "unsupported";
  reason: string | null;
  cells: McpCell[];
}
export interface McpIssue {
  locationId: string;
  name: string | null;
  message: string;
}
export interface McpOverview {
  locations: McpLocation[];
  entries: McpEntry[];
  issues: McpIssue[];
}
export interface McpSelection {
  sourceId: string;
  name: string;
  targetId: string;
}
export interface McpAction {
  sourceId: string;
  targetId: string;
  name: string;
  sourcePath: string;
  targetPath: string;
  crossDomain: boolean;
}
export interface McpPreview {
  planId: string;
  actions: McpAction[];
  issues: McpIssue[];
}
export interface McpReportEntry {
  name: string;
  targetId: string;
  outcome: "created" | "skipped" | "failed";
  message: string;
  backupPath: string | null;
}
export interface McpReport {
  entries: McpReportEntry[];
}

/** 自动引入 MCP 的来源/目标位置引用；位置消失后仍保留足够信息以撤销规则。 */
export interface McpLocationRef {
  id: string;
  harnessId: string;
  domain: string;
  path: string;
  selector?: string;
}

/** 一条来源位置到同一域目标位置的 MCP 自动引入规则。 */
export interface McpAutoImportRule {
  source: McpLocationRef;
  targetDomain: string;
  targets: McpLocationRef[];
  excluded: string[];
  allowCrossDomain: boolean;
}

export const actionId = (a: PlannedAction): string => `${a.kind}|${a.targetPath}`;

/// 与 gateway_* 命令的返回类型一一对应（camelCase），见 docs/gateway-commands.md
export interface GatewayProviderModel {
  id: string;
  slug: string;
  displayName: string;
  selected: boolean;
}
export interface GatewayProvider {
  baseUrl: string;
  hasKey: boolean;
  models: GatewayProviderModel[];
}
export interface GatewayRouter {
  installed: boolean;
  running: boolean;
  port: number;
  error: string;
}
export interface GatewayCodex {
  version: string;
  running: boolean;
  catalogVersion: string;
  drift: boolean;
}
/// 非空：本机当前由 agents-manager 启用，可以接管
export interface GatewayTakeover {
  baseUrl: string;
  selectedCount: number;
}
export interface GatewayState {
  supported: boolean;
  provider: GatewayProvider;
  enabled: boolean;
  needsCodexRestart: boolean;
  router: GatewayRouter;
  codex: GatewayCodex;
  /** 非空：Codex 设置里有别的工具写的同名项或 provider，启用不可用 */
  conflict: string;
  takeover: GatewayTakeover | null;
}
/// gateway_select_models 的入参：只带 id 与用户可编辑的显示名
export interface GatewaySelectedModel {
  id: string;
  displayName: string;
}
