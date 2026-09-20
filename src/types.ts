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
  | "own"
  | "linked"
  | "missing"
  | "broken"
  | "foreign"
  | "duplicate"
  /// 目标整个目录链接到别的本体位置，逐项写不进去。**不是**「目录只读」
  | "wholeLinked"
  /// 目标目录存在但写不进去。**扫描永远不产出这个状态**：判定它要实际试写一次，
  /// 每轮扫描都试写代价太大。只在上层真的写失败之后由上层构造
  | "readOnly";
export interface Cell {
  sourceId: string;
  skill: string;
  targetId: string;
  path: string;
  state: CellState;
  /// 这一格上的软链解析后落在哪（`real_path` 的结果）。只有 linked / foreign 有值，
  /// 其余状态是 null。foreign 的提示条要靠它说出「指向哪个本体」
  pointsTo: string | null;
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

export type ActionKind = "create" | "brokenLink" | "unlink" | "deleteSource";
export interface PlannedAction {
  kind: ActionKind;
  itemName: string;
  sourcePath: string;
  targetPath: string;
  target: string;
}

/// 链接写成绝对路径还是相对路径
export type LinkStyle = "absolute" | "relative";

/// 一条指向某本体的链接，以及改指时该怎么写
export interface AffectedLink {
  path: string;
  style: LinkStyle;
}

/// 删一个 skill 本体之前的全部事实，够渲染确认弹窗做决定
export interface DeleteSourcePlan {
  /// 要删的本体目录
  path: string;
  /// 目录里的条目总数（递归，不含目录自身）
  entries: number;
  /// 目录里普通文件的字节数之和（软链不跟随）
  bytes: number;
  /// 各目标目录里指向它（或它内部）的软链，连同改指时要写的形式
  affected: AffectedLink[];
  /// 所在 git 仓库的根；null 表示不在仓库里。非 null 时一律不代删
  inGit: string | null;
  /// 别处同名的另一个本体；删完把 affected 改指到它。null 表示没有别处可指
  relinkTo: string | null;
}

/// 待处理栏里四类需要用户拿主意的问题，与 store.rs 的 IssueKind 一一对应。
/// 「整目录链到别处」与「目录只读」必须分开：前者的动作是拆开，后者是再试一次
export type IssueKind = "duplicateSource" | "brokenLink" | "readOnlyTarget" | "wholeLinkedTarget";

/// 服务端存着的删除计划：plan 只用来渲染确认弹窗，执行凭 planId。
/// 计划不经前端往返——in_git（仓库里的不代删）是道安全闸门，
/// 让它在前端转一圈就等于可以被改掉
export interface PlannedDeletion {
  planId: string;
  plan: DeleteSourcePlan;
}

/// 与 store.rs 的 IgnoredIssue 对应
export interface IgnoredIssue {
  kind: IssueKind;
  key: string;
  /// 忽略时间，RFC 3339 的 UTC 写法，可直接按字典序排
  at: string;
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
