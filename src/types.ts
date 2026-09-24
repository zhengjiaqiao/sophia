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
  /// SKILL.md frontmatter 里的 description；读不到时缺省（core 序列化时省略）
  description?: string;
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
  /// 目标整个目录链接到别的本体位置，逐项都无法写入。**不是**「目录只读」
  | "wholeLinked"
  /// 目标目录存在但无法写入。**扫描永远不产出这个状态**：判定它要实际试写一次，
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

/// 侧栏排序用的项目时间（core `activity::ProjectTimes`），毫秒时间戳；取不到为 null
export interface ProjectTimes {
  path: string;
  /// 最近一次有 agent 在项目里干活：Claude Code 会话记录与项目里各 agent 目录取较晚的，
  /// 都没有时用项目文件夹的修改时间
  lastActive: number | null;
  /// 项目文件夹的创建时间；取不到时用加入 Sophia 的时间，再没有用文件夹修改时间
  created: number | null;
}

/// 一个格：本体位置 id + skill + 目标 id。目标 id 决定域；格不必已出现在表里（导入弹层用）
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
  /// 目录里普通文件最新的修改时间（Unix 毫秒）；没有文件或读不到时为 null
  modified?: number | null;
}

/// 需要用户拿主意的问题类别，与 store.rs 的 IssueKind 一一对应。
/// 「整目录链到别处」与「目录只读」必须分开：前者的动作是拆开，后者是再试一次
export type IssueKind =
  | "duplicateSource"
  | "brokenLink"
  | "readOnlyTarget"
  | "wholeLinkedTarget"
  /// MCP：几个位置各有一份同名配置、连的地址不一样 → 看两边差在哪
  | "differentCopies"
  /// MCP：某个位置的配置文件这次读不出来 → 去看看
  | "invalidLocation";

/// 服务端存着的删除计划：plan 只用来渲染确认弹窗，执行凭 planId。
/// 计划不经前端往返——in_git（仓库里的不代删）是道安全闸门，
/// 让它在前端转一圈就等于可以被改掉
export interface PlannedDeletion {
  planId: string;
  plan: DeleteSourcePlan;
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

/// 一条自动同步规则：该本体位置下的全部 skill（各目标的排除名单除外）持续补齐到这些目标
export interface AutoLink {
  /// 归一化后的本体位置路径，与 Source.id / Source.path 可直接比较
  source: string;
  targets: string[];
  /// 按目标 id 记的排除名单：在这个目标上手动清除过、不再自动链接的 skill。
  /// 为空时 core 省略这个字段
  targetExcluded?: Record<string, string[]>;
  /// 建规则那一刻本体位置里已有的 skill，规则不补建它们（只管以后新出现的）。
  /// 由 core 拍快照，前端不传；升级前的旧规则在首次扫描迁移前为 null
  baseline?: string[] | null;
  /// 规则生效之后才加进来的目标，各自在加进来那一刻的 baseline（优先于 baseline）。
  /// 由 core 拍，前端不传；为空时 core 省略这个字段
  targetBaselines?: Record<string, string[]>;
}

/// 来源管理页一行的共同部分（core `subscriptions::SourceSummary`）
export interface SourceSummary {
  /// 与 Source.id 相同；记录里有、这次没发现的来源用记录的路径
  id: string;
  /// 完整路径，给提示框
  path: string;
  /// 来源名；同名来源的区分片段由前端 `originNames` 算（与主视图同一个起名函数）
  label: string;
  /// 主目录写成 `~` 的路径
  shortPath: string;
  /// 按名排序
  skills: string[];
  skillCount: number;
}

/// 这个位置已订阅的一个来源
export interface SubscribedSource extends SourceSummary {
  /// 原件就在这个位置里：永远算已订阅，不能移除
  own: boolean;
  /// 能不能开「以后新出现的自动添加」（外部位置不能）
  canAutoLink: boolean;
  /// 规则在这个位置开着；开关与改目标沿用 setAutoLink / removeAutoLinkTargets（source 传 path）
  autoLink: boolean;
  /// 规则在这个位置的目标 id（Target.id）
  autoTargets: string[];
}

export interface DomainName {
  key: string;
  label: string;
}

/// `+ 来源` 里的一个候选
export interface CandidateSource extends SourceSummary {
  /// 在哪些位置订阅着（只有「其他项目在用的」有）
  usedIn: DomainName[];
}

/// `list_sources` 的返回
export interface SourceList {
  /// 已订阅的来源：自己的在前，其余按名
  subscribed: SubscribedSource[];
  /// 其他项目在用的：别的位置订阅过、这里还没有的
  elsewhere: CandidateSource[];
  /// 检测到的其余来源
  detected: CandidateSource[];
}

/// 移除来源时会撤掉的一条软链
export interface RemovalLink {
  /// null：这个 agent 的整个 skill 目录就是指向该来源的一条软链
  skill: string | null;
  targetId: string;
  /// agent 名（Target.label）
  agent: string;
}

/// `plan_remove_source` 的返回；links 为空表示一条都没链
export interface SourceRemoval {
  sourceId: string;
  links: RemovalLink[];
}

export interface HarnessStatus {
  id: string;
  displayName: string;
  enabled: boolean;
  /// 这台机器上装没装。设置页默认只列已安装的，其余收在「显示未安装的 N 个」
  /// 后面——所以后端返回全部 41 个而不只是已安装的
  installed: boolean;
}

/// `list_harnesses` 的返回：全部 agent，外加列表里最多显示几个（core 的 `MAX_SHOWN`）
export interface HarnessList {
  maxShown: number;
  harnesses: HarnessStatus[];
}

export interface McpLocation {
  id: string;
  label: string;
  harnessId: string;
  domain: string;
  path: string;
  selector?: string;
  /** 发现了配置位置，但不参与普通矩阵；导入时仍可作为目标。 */
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
  /// 只有这几个 agent（harness id）接得住它；缺省＝谁都接得住。目前只有用命令生成请求头的
  /// 服务有（`["claude-code", "codex"]`）。接不住的那一列格子是 `unsupported`，`cell.reason`
  /// 是「Cursor 不支持用命令生成请求头」
  onlyHarnesses?: string[];
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
  /// 每个位置（域 key）订阅着的、别的位置的来源 id：主视图把它们的全部服务也列成行
  subscribed?: Record<string, string[]>;
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
  /// `removed` 只出现在移除 MCP 来源、从格子上移除副本（`removeMcpCopies`）的报告里
  outcome: "created" | "removed" | "skipped" | "failed";
  message: string;
  backupPath: string | null;
  /// 只在从格子上移除副本成功的条目上有：移除的那份与来源原版是否一样。
  /// 一样时再点一次写回的就是同样的内容，不给撤销；不一样（`2 份不一样`）才给
  identical?: boolean;
}
export interface McpReport {
  entries: McpReportEntry[];
  /** 撤销这次写入用的 id（交给 `api.mcpUndoWrite`）；没有可撤销的写入时为 null。
   *  下一次写到同一文件、撤销过一次或应用退出后失效 */
  undoId: string | null;
}
/** 撤销单个文件的结果 */
export interface McpUndoFileResult {
  targetPath: string;
  /** 写入时留下的 `.mcp.bak`；新建文件的写入没有备份 */
  backupPath: string | null;
  outcome: "restored" | "removed" | "changed" | "unchanged" | "failed" | "skipped";
  message: string;
}
/** 撤销结果。`changed`：有文件写后又被改过，整体拒绝、没动任何文件 */
export interface McpUndoReport {
  outcome: "undone" | "changed" | "failed";
  message: string;
  files: McpUndoFileResult[];
}

/** 自动导入 MCP 的来源/目标位置引用；位置消失后仍保留足够信息以撤销规则。 */
export interface McpLocationRef {
  id: string;
  harnessId: string;
  domain: string;
  path: string;
  selector?: string;
}

/** 一条来源位置到同一域目标位置的 MCP 自动导入规则。 */
export interface McpAutoImportRule {
  source: McpLocationRef;
  targetDomain: string;
  targets: McpLocationRef[];
  /// 按目标（位置 id）记的排除名单：在这个目标上不再自动写入的服务名。
  /// 为空时 core 省略这个字段
  targetExcluded?: Record<string, string[]>;
  allowCrossDomain: boolean;
  /// 建规则那一刻来源位置里已有的 MCP 名，规则不补它们（只管以后新出现的）。
  /// 由 core 拍快照，前端不传；升级前的旧规则在首次扫描迁移前为 null
  baseline?: string[] | null;
  /// 规则生效之后才加进来的目标各自的 baseline（位置 id → 名字）
  targetBaselines?: Record<string, string[]>;
}

/// MCP 来源里的一个服务（core `mcp::sources::McpService`）
export interface McpService {
  name: string;
  /// false：哪儿都搬不过去（用了只有来源认得的写法）
  portable: boolean;
  /// `portable` 时只有这几个 agent（harness id）接得住；缺省＝谁都接得住。
  /// 显示的 agent 里一家都接不住才标 `搬不过去`
  onlyHarnesses?: string[];
}

/// MCP 来源管理页一行的共同部分：来源＝一处配置
export interface McpSourceSummary {
  /// 位置 id（McpLocation.id）
  id: string;
  /// `Claude Code · User`、`Cursor · Project`
  label: string;
  harnessId: string;
  domain: string;
  /// 它在哪：`全局` / 项目文件夹名（同名同处的带区分片段）
  place: string;
  /// 配置文件完整路径，给提示框
  path: string;
  /// 整份配置这次读不出来
  unreadable: boolean;
  /// 按名排序
  services: McpService[];
}

/// 这个位置已订阅的一处 MCP 配置
export interface McpSubscribedSource extends McpSourceSummary {
  /// 这个位置自己的配置：永远算已订阅，不能移除
  own: boolean;
  /// 「以后新出现的自动写进」在这个位置的目标 id；空＝关着。开关与改目标沿用 setMcpAutoImport
  autoTargets: string[];
}

export interface McpCandidateSource extends McpSourceSummary {
  /// 在哪些位置订阅着（只有「其他项目在用的」有）
  usedIn: DomainName[];
}

/// `list_mcp_sources` 的返回
export interface McpSourceList {
  subscribed: McpSubscribedSource[];
  elsewhere: McpCandidateSource[];
  detected: McpCandidateSource[];
}

/// 移除 MCP 来源时会拿掉的一项
export interface McpRemovalItem {
  name: string;
  targetId: string;
  /// 位置名（McpLocation.label）
  location: string;
}

/// `plan_remove_mcp_source` 的返回；items 为空表示没有写进这里的配置要撤
export interface McpSourceRemoval {
  sourceId: string;
  items: McpRemovalItem[];
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
  /** 创建后不变；带 providerId 的命令用它指明操作哪一家。一家都没有时为空串 */
  id: string;
  /** 显示名，可以改 */
  name: string;
  /** 网关短名（core `ProviderSettings::short_name`）：网关行的名字，也是撞名模型的后缀——与 Codex 目录里同一个。
   *  界面经 `gatewayShortName` 读它，不自己算 */
  shortName: string;
  baseUrl: string;
  /** 这家网关的协议："chat" 或 "responses" */
  protocol: string;
  hasKey: boolean;
  models: GatewayProviderModel[];
  /** 上次拉取模型失败的原因（「地址无法访问」「密钥无效，请换一个密钥」…）；null / 缺省表示上次成功或还没拉过 */
  unreachable?: string | null;
}
export interface GatewayRouter {
  installed: boolean;
  running: boolean;
  port: number;
  /// "chat" 或 "responses"。配置页只读展示，不给改
  protocol: string;
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
  /**
   * 第一家网关，等于 `providers[0]`。**兼容字段，新代码不要读**——
   * 模型页已经迁到 `providers`，只剩菜单栏面板的 `trayView.ts` 还在读它；
   * 那一处迁完，这个字段连同后端的兼容命令一起删（docs/gateway-commands.md）。
   */
  provider: GatewayProvider;
  /** 全部网关，按添加顺序。模型标识是「网关 id-模型名」，两家有同名模型也不相撞 */
  providers: GatewayProvider[];
  enabled: boolean;
  needsCodexRestart: boolean;
  router: GatewayRouter;
  codex: GatewayCodex;
  /** 非空：Codex 设置里有别的工具写的同名项或 provider，启用不可用 */
  conflict: string;
  takeover: GatewayTakeover | null;
}
/// gateway_upsert_provider 的返回值
export interface GatewayProviderSaved {
  providerId: string;
  state: GatewayState;
}
/// gateway_select_models 的入参：只带 id 与用户可编辑的显示名
export interface GatewaySelectedModel {
  id: string;
  displayName: string;
}

/// 与 core `mcp::McpFieldValue` 对应：某个位置上一个字段的值。凭据在 core 里就脱敏了，
/// 前端拿不到原文——`secret` 只有末 4 位（值太短时连末 4 位也没有）
export type McpFieldValue =
  { kind: "plain"; text: string } | { kind: "secret"; last4: string | null } | { kind: "absent" };
/// 同名服务在几个位置上的字段级差异（`mcp_field_diff`）。只列不同的字段
export interface McpDiff {
  name: string;
  /// 与请求同序；`fields[i].values[j]` 对应 `locationIds[j]`
  locationIds: string[];
  /// `field`：`transport` `url` `command` `args` `headersHelper`（生成请求头的命令，按凭据脱敏）
  /// `env.NAME` `headers.Name`
  fields: { field: string; values: McpFieldValue[] }[];
  /// 有的位置用命令生成请求头、有的没有：请求头没法逐字比对（`headers.*` 不列）。都用命令的照常比
  dynamicAuth: boolean;
  /// 读不出来的位置
  unreadable: string[];
}
