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
/// core 扫描结果里的格状态：比 `CellState` 多一种 `copied`——那里建不了链接时 Sophia 放的、
/// 记录在案的副本（core `CellState::Copied`）。对用户它就是已链，界面上不出现「副本」
/// （spec #194 修订 2026-10-06）：`api.scanAll` 收到就换成 `linked`（`showCopiesAsLinked`），
/// 之后的界面代码只见 `CellState`
export type ScannedCellState = CellState | "copied";
export interface Cell {
  sourceId: string;
  skill: string;
  targetId: string;
  path: string;
  state: CellState;
  /// 这一格上的软链解析后落在哪（`real_path` 的结果）。只有 linked / foreign（及 core 的 copied）有值，
  /// 其余状态是 null。foreign 的提示条要靠它说出「指向哪个本体」；副本格给的是它对应的原件
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
  /// agent 自己目录里的同名 skill（issue #153），见 `AgentCopy`
  agentCopies: AgentCopy[];
}

/// agent 自己目录里的一份同名 skill（core `AgentCopy`，issue #153）：某一格因「那里已有同名的」被挡住，
/// 占着的是一个真实文件夹、又不是这一位置里任何一行的原件——表格里没有它那一行，同名行抽屉的差异表单列它
export interface AgentCopy {
  skill: string;
  /// 它所在的目标（agent 目录）
  targetId: string;
  /// 目标目录下的 `<skill>`
  path: string;
}

/// 「只留这份」的一方（core `CopyRef`，issue #153）：某个原件位置里的那一份，或 agent 目录下不在任何原件位置里的那一份
export type CopyRef = { sourceId: string } | { targetId: string };

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

/// `placeCopy` / `updateCopy`：建不了链接时改放副本、原件变了更新副本（core 内部区分，
/// 界面上与 `create` 一样是「加上」）
export type ActionKind =
  "create" | "brokenLink" | "unlink" | "deleteSource" | "placeCopy" | "updateCopy";
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
  /// 别处同名的另一个本体；删完把 affected 改指到它。null 表示没有别处可指——affected 一起清掉
  relinkTo: string | null;
  /// Sophia 为它放的副本所在（core `DeleteSourcePlan.copies`）：默认随原件一起删、同一次撤销。
  /// 对用户与链接一样算「哪些 agent 会失去它」，界面上不说是副本（spec #194 修订）
  copies: string[];
  /// 目录里普通文件最新的修改时间（Unix 毫秒）；没有文件或读不到时为 null
  modified?: number | null;
}

/// 服务端存着的删除计划：plan 只用来渲染确认弹窗，执行凭 planId。
/// 计划不经前端往返——in_git（仓库里的不代删）是道安全闸门，
/// 让它在前端转一圈就等于可以被改掉
/// 同名几份里一份的读数（core `SkillCopyInfo`）：文件数、最近修改（毫秒）、内容指纹（两份相同＝一模一样）
export interface SkillCopyInfo {
  entries: number;
  modified: number | null;
  content: string | null;
}
export interface PlannedDeletion {
  planId: string;
  plan: DeleteSourcePlan;
}

export type Outcome =
  | { status: "created" }
  | { status: "skipped" }
  | { status: "removed" }
  | { status: "failed"; reason: string };
/// 失败的机器可读类别（core `FailKind`）：前端按它分支，不认原因句的文字。只有建链 / 删链的失败会填。
/// `linkUnsupported`（这里建不了链接）core 通常已自动改放副本、结果是做成了；只在没改成时出现，按原句转述
export type FailKind = "noWrite" | "diskFull" | "missing" | "linkUnsupported";
export interface ReportEntry {
  action: PlannedAction;
  outcome: Outcome;
  failKind?: FailKind;
  /// 失败的技术原文（系统的错误原句，后端已去隐私；spec S18）
  detail?: string;
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
  /// 按位置（域 key）记的最近一次真正建上了链的自动执行。由 core 记，前端不传；为空时省略
  lastAuto?: Record<string, AutoRun>;
}

/// 自动规则一次执行的结果（core `models::AutoRun`）：什么时候（毫秒时间戳）、加上了几格
export interface AutoRun {
  at: number;
  added: number;
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
  /// 规则在这个位置最近一次真正加上了链的执行；从没加上过为 null
  lastAuto: AutoRun | null;
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

/// 设置「生效范围」里的一格项目（core `discovery::ProjectScope`）：自动检测的与手动选的长得一样
export interface ProjectScope {
  /// 项目文件夹；停上去的提示框给它
  path: string;
  /// 格子上的名字：文件夹名
  name: string;
  /// 勾着没有：勾着的才出现在筛选行与「切换项目…」浮层里
  shown: boolean;
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
  /** 写这个位置时跟着写的附属文件（Claude Desktop 第三方模式那一份）；矩阵状态只看 path，没有时缺省。 */
  mirrors?: string[];
}

export type McpCellState =
  "own" | "equal" | "sameEndpoint" | "missing" | "conflict" | "invalid" | "unsupported";
/// 格上原因句的种类（core `McpReasonKind`）：前端按它分支，不比对 `reason` 的文字。
/// 只有 core 给了原因句的格才有
export type McpReasonKind =
  | "targetUnreadable"
  | "sameUrlDynamicAuth"
  | "urlDiffers"
  | "configDiffers"
  | "sourceLossy"
  | "targetLossy"
  | "desktopRemote"
  | "desktopVariables"
  | "geminiVariables"
  | "headersHelper"
  | "crossAgentVariables"
  | "sseUnsupported"
  | "codexClientFields"
  | "clientFields";
export interface McpCell {
  targetId: string;
  state: McpCellState;
  reason: string | null;
  reasonKind?: McpReasonKind;
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
  /// `reason` 说的是「不支持迁移字段 X」时的 X（core `unsupported_field`）：界面上那一句说字段，不从原因句里抠
  unsupportedField?: string;
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
/// 要删的一项：从 `locationId` 这个位置的配置里删掉 `name`（core `McpRemoveItem`）
export interface McpRemoveItem {
  locationId: string;
  name: string;
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
  /// `removed` 只出现在移除 MCP 来源、从 agent 的配置里删定义（`deleteMcpOriginal`）的报告里；
  /// `updated` 只出现在「保留这份」（`keepMcpCopy`）的报告里
  outcome: "created" | "removed" | "updated" | "skipped" | "failed";
  message: string;
  backupPath: string | null;
  /** 这一条成了，但 Claude Desktop 第三方模式那一份（`McpLocation.mirrors`）没写成：整句原因，在成功条目下显示 */
  mirrorFailed?: string;
  /** 没写成、又分不出原因（spec #239 第 43 条）：系统原文。给了就说明 `message` 是兜底句（`原子写入失败`），提示条不说它 */
  detail?: string;
}
export interface McpReport {
  entries: McpReportEntry[];
  /** 撤销这次写入用的 id（交给 `api.mcpUndoWrite`）；没有可撤销的写入时为 null。
   *  下一次写到同一文件、撤销过一次或应用退出后失效 */
  undoId: string | null;
  /** 勾了「同时加进 .gitignore」、配置写成了，`.gitignore` 却没写成：整句原因 */
  gitignoreFailed?: string;
  /** 密钥提醒（移动 / 复制、自动同步）：来源被忽略，写成之后目标也自动加进了 `.gitignore` */
  autoIgnored?: boolean;
  /** 密钥提醒：像密钥的值第一次写进 git 仓库里的项目文件、没加进 `.gitignore`（自动同步规则、格子写入遇到 `remind`） */
  keyExposed?: boolean;
  /** `keyExposed` 里还能补加进 `.gitignore` 的位置 id：格子写入的提示条据此给「加进 .gitignore」（`api.addMcpGitignore`） */
  ignorable?: string[];
  /** 密钥提醒：像密钥的值写进了已被 git 跟踪的项目文件（`tracked`，加进 `.gitignore` 也挡不住） */
  keyTracked?: boolean;
  /** `keyTracked` 是哪几个目标（位置 id）：「保留这份」的提示条按目标比对确认框里出过那一句的 */
  trackedTargets?: string[];
  /** 撤销这次追加进 `.gitignore` 的那几行用的 id（与 `undoId` 分开记：移动的撤销不走写入的快照） */
  gitignoreUndoId?: string;
}
/** 移动 / 复制写进项目文件的一个目标这次的密钥提醒（core `McpKeyHint`） */
export interface McpKeyHint {
  targetId: string;
  hint: KeyHint;
  /** 目标所在项目的根：`.gitignore` 加在这里 */
  project: string;
  /** 在项目根 `.gitignore` 里写成的那一行（`.cursor/mcp.json`） */
  gitignoreLine: string;
}
/** 撤销单个文件的结果 */
export interface McpUndoFileResult {
  targetPath: string;
  /** 写入前留下的备份（在 Sophia 数据目录的 backups/ 下）；新建文件的写入没有备份 */
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
  /// 最近一次真正写进去了东西的自动执行。由 core 记，前端不传；没有时省略
  lastAuto?: AutoRun;
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
  /// 这个位置的规则最近一次真正写进去了东西的执行；从没写进过为 null
  lastAuto: AutoRun | null;
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
  /// 网关在模型列表里给的上下文长度（token）；没给为 null / 缺省
  contextWindow?: number | null;
  /// 用户手动填的（sophia-dev#117）：刷新列表不冲掉；取消勾选就移除
  manual?: boolean;
}
/// 一家网关的密钥状态（后端 `KeyStatus`）：读不出不等于没有
export type GatewayKeyStatus = "set" | "missing" | "unreadable";
/// 服务商预设（core `provider_presets`，spec S1）：选一家只填密钥。`openai` 是 Sophia 现在接得上的地址；
/// 只有 `anthropic` 的那几家界面上标「暂不支持」
export interface PresetEndpoint {
  apiBase: string;
  /** "chat" | "responses"；Anthropic 地址没有 */
  protocol?: string;
}
export interface ProviderPreset {
  id: string;
  name: string;
  website: string;
  keysUrl?: string;
  /** "cn" 国内 / "global" 海外 */
  region: string;
  openai: PresetEndpoint | null;
  anthropic: PresetEndpoint | null;
  note?: string;
}
export interface GatewayProvider {
  /** 创建后不变，只在这一家（agent）里唯一；带 providerId 的命令用它指明操作哪一个网关 */
  id: string;
  /** 显示名，可以改 */
  name: string;
  /** 网关短名（core `ProviderSettings::short_name`）：网关行的名字，也是撞名模型的后缀——与 Codex 目录里同一个。
   *  界面经 `gatewayShortName` 读它，不自己算 */
  shortName: string;
  baseUrl: string;
  /** 这家网关的协议："chat" 或 "responses" */
  protocol: string;
  /** 从哪个服务商预设建的（`ProviderPreset.id`，spec S1）；手填的为 null / 缺省 */
  preset?: string | null;
  /** 密钥：有 / 没有 / 读不出（密钥文件没有读取权限、损坏，或还在钥匙串里没迁完） */
  key: GatewayKeyStatus;
  /** 读不出时的原因（当前语言的一句话，写全）；其余为 null */
  keyProblem?: string | null;
  models: GatewayProviderModel[];
  /** 上次拉取模型失败的原因（「地址无法访问」「密钥无效，请换一个密钥」…）；null / 缺省表示上次成功或还没拉过 */
  unreachable?: string | null;
  /** 那次失败的技术原文（请求、状态码、返回的错误；已去隐私），网关行 `详情` 里给；没有为 null / 缺省 */
  unreachableDetail?: string | null;
  /** `unreachable` 是真实调用（转发的请求、勾选前的试调）被拒了密钥记下的（#144）：重拉模型列表清不掉，
   *  行尾不出 `再试一次`，换密钥走铅笔 `编辑` */
  keyRejectedOnCall?: boolean;
  /** `unreachable` 的原因是密钥被拒（拉列表或真实调用都算）：网络是通的，网关行不写「无法连接」，只写原因 */
  keyInvalid?: boolean;
}
/// 网关的家（spec 2026-09-29「家」）：模型页里的一个 agent，也是网关数据的归属单位。
/// 与注册表 id 不同：注册表里 Claude 那一项的 id 是 `claude-code`，它用 `AgentEntry.gateway` 指到这里的 `claude`
export type GatewayAgent = "codex" | "claude";
/// 本机路由：两家共用一个，在 Sophia 进程里跑（spec 2026-10-03-gateway-in-app）
export interface GatewayRouter {
  /// 本进程里的路由在 `port` 上跑着
  running: boolean;
  port: number;
  error: string;
}
/// 路由端口的说明（打开 Sophia 时接上的结果，spec 2026-10-03-gateway-in-app R4、R13）：
/// 另一个 Sophia 占着端口（没换，Codex 设置改回了原样）/ 端口被别的程序占着、换到了 `to`（正在运行的要重启生效）/
/// 端口范围里全被别的程序占着（Codex 设置改回了原样）
export type GatewayPortNotice =
  | { code: "another_sophia"; port: number }
  | { code: "port_moved"; from: number; to: number }
  | { code: "ports_busy" };
export interface GatewayCodex {
  version: string;
  running: boolean;
  catalogVersion: string;
  drift: boolean;
  /// 装着的 Codex 桌面应用（包 id `com.openai.codex`）的显示名：2026-09-30 起是 `ChatGPT`；没装为空
  appName: string;
}
/// 非空：本机当前由 agents-manager 启用，可以接管
export interface GatewayTakeover {
  baseUrl: string;
  selectedCount: number;
}
/// Codex 接第三方模型的接法：借用内置的 openai 服务商（要 OpenAI 登录），或独立服务商（不用登录）
export type GatewayHookupMode = "builtin" | "provider";
/// 选这种接法的原因（spec 2026-10-03-codex-hookup-auto R2）
export type GatewayModeReason = "signedIn" | "apiKey" | "unknown" | "signedOut";
/// Codex 那一家特有的
export interface GatewayCodexView {
  /// 用户开着 Codex 的第三方模型（模型页开关的选择）；`enabled` 是 Codex 设置此刻指着路由。
  /// 两者不同只在打开 Sophia 时没接上（见 `GatewayState.portNotice`）
  wanted: boolean;
  /// 按钮即状态：Codex 启动时加载的配置与现在不同
  needsRestart: boolean;
  app: GatewayCodex;
  takeover: GatewayTakeover | null;
  /// 接法：Codex 设置指着路由时是写着的那一种，否则是上次写的
  mode: GatewayHookupMode;
  /// 选这种接法的原因；还没判断过为 null
  modeReason: GatewayModeReason | null;
}
/// 别家写进 Claude 桌面应用、正在生效的第三方配置（别的配置工具或用户自己配的）。界面不写来源，后端也不给名字
export interface GatewayClaudeForeign {
  id: string;
}
/// Claude 桌面应用这一侧（spec R34）
export interface GatewayClaudeDesktop {
  /// 没装时为 null
  version: string | null;
  tooOld: boolean;
  /// 由组织统一配置
  managed: boolean;
  running: boolean;
  /// 桌面应用配置里写着 Sophia 的
  applied: boolean;
  /// 想要的值与写入的值不同（待生效）
  pending: boolean;
  /// = running && pending：键位出 `重启生效`
  needsRestart: boolean;
  /// Sophia 写进去的被改掉了或上次没写完（`重新写入`）
  drift: boolean;
  /// 切回没做完（`再试一次`）
  restoreUnfinished: boolean;
  foreign: GatewayClaudeForeign | null;
}
/// Claude 桌面应用菜单里的一项（profile 的 `inferenceModels`）
export interface GatewayClaudeProfileModel {
  id: string;
  labelOverride: string;
}
/// Claude 那一家特有的
export interface GatewayClaudeView {
  /// Sophia 的 profile 里实际写着的 `inferenceModels`（文件里的顺序；profile 不存在时为空）：已选全部、按已选顺序，
  /// `labelOverride` 是模型片上的名字。Sophia 不设默认模型（2026-09-30），界面不读它，给命令行与核对用
  profileModels: GatewayClaudeProfileModel[];
  desktop: GatewayClaudeDesktop;
}
/// 一家的状态（spec 契约 §6 `AgentGatewayView`）
export interface AgentGatewayView {
  agent: GatewayAgent;
  /// Codex：读得到 Codex 版本；Claude：桌面应用已安装
  installed: boolean;
  /// 这一家的网关，按添加顺序。模型标识是「网关 id-模型名」，同一家里两个网关有同名模型也不相撞
  providers: GatewayProvider[];
  /// 开关。Codex：设置文件指向路由；Claude：想要的值（写没写进桌面应用看 `claude.desktop`）
  enabled: boolean;
  /// 非空：这一家的设置里有别的工具写的同名项，打开不可用
  conflict: string;
  /// 只在 Codex 那一份上有
  codex?: GatewayCodexView;
  /// 只在 Claude 那一份上有
  claude?: GatewayClaudeView;
}
export type CodexGatewayView = AgentGatewayView & { agent: "codex"; codex: GatewayCodexView };
export type ClaudeGatewayView = AgentGatewayView & { agent: "claude"; claude: GatewayClaudeView };
/// 模型页的状态（gateway_state 等命令的返回）
export interface GatewayState {
  supported: boolean;
  router: GatewayRouter;
  /// 路由端口的说明；没有为 null
  portNotice: GatewayPortNotice | null;
  /// 顺序 codex、claude；`supported: false` 时为空
  agents: AgentGatewayView[];
  /// 读不到第三方模型的状态（spec 2026-10-04-local-diagnostics R11）：哪个文件、哪一种；其余字段照能读到的给。没有为缺省
  unreadable?: GatewayUnreadable;
}

/// 读不了的那一份文件：`permission` 没权限（给 `修复权限`）、`format` 格式有误（给 `打开文件 ↗`）、`other`
export interface GatewayUnreadable {
  kind: "permission" | "format" | "other";
  /// 完整路径（修复、打开按它做）；状态整个读不回来时为空串
  path: string;
  /// 格式有误的那一行（从 1 数）
  line: number | null;
  /// 当前语言的一句：`~/.codex/config.toml 不归你的账户所有，读不了（多半是用 sudo 运行过 Codex）`；没有为空串
  reason: string;
  /// 技术原文（已去隐私），`详情` 里给
  detail: string;
}

/// 退出前要不要确认、确认框里说什么（`quit_preview`，spec 2026-10-03-gateway-in-app R5、R6）
export interface QuitPreview {
  /// Codex 设置正指着路由：退出会改回并重启 Codex
  codex: boolean;
  /// Codex 桌面应用在运行
  codexAppRunning: boolean;
  /// 终端里有交互式 `codex` 在运行：它不会被重启，要用户自己重启
  codexTerminal: boolean;
  /// Claude 桌面应用处在 Sophia 写入的第三方模式：退出会切回官方
  claude: boolean;
  /// Claude 桌面应用在运行
  claudeRunning: boolean;
}
/// 退出收尾进行到哪一步（`quit-progress` 事件的 `step`）
export type QuitStep = "restartingCodex" | "restartingClaude";
/// 退出收尾里没做成的一家（`app_quit` 返回）：`code` 如 `desktop_busy`，`message` 是后端按当前语言写好的原因
export interface QuitFailure {
  agent: GatewayAgent;
  code: string;
  message: string;
}

/// 某一家的状态；不支持（非 macOS）或还没有时为 null
export function agentGateway(state: GatewayState, agent: GatewayAgent): AgentGatewayView | null {
  return state.agents.find((view) => view.agent === agent) ?? null;
}

const EMPTY_CODEX: CodexGatewayView = {
  agent: "codex",
  installed: false,
  providers: [],
  enabled: false,
  conflict: "",
  codex: {
    wanted: false,
    needsRestart: false,
    app: { version: "", running: false, catalogVersion: "", drift: false, appName: "" },
    takeover: null,
    mode: "builtin",
    modeReason: null,
  },
};

/// Codex 那一家。Codex 页与 Codex 托盘行只在支持时出现，后端总给这一份；缺了（不支持）按关着、什么都没有算
export function codexGateway(state: GatewayState): CodexGatewayView {
  const view = agentGateway(state, "codex");
  if (view === null) return EMPTY_CODEX;
  return { ...view, agent: "codex", codex: view.codex ?? EMPTY_CODEX.codex };
}

/// Claude 那一家；不支持时为 null
export function claudeGateway(state: GatewayState): ClaudeGatewayView | null {
  const view = agentGateway(state, "claude");
  if (view === null || view.claude === undefined) return null;
  return { ...view, agent: "claude", claude: view.claude };
}

/// 换掉某一家的状态（乐观更新用：勾选、拨开关先画成做成之后的样子），其余原样
export function withAgentGateway(state: GatewayState, next: AgentGatewayView): GatewayState {
  return {
    ...state,
    agents: state.agents.map((view) => (view.agent === next.agent ? next : view)),
  };
}

/// 这一家开着没有（侧栏 `模型` 的橙点、托盘图标：任一家开着就亮）
export function gatewayOn(state: GatewayState | null, agent: GatewayAgent): boolean {
  return state !== null && agentGateway(state, agent)?.enabled === true;
}

/// gateway_upsert_provider 的返回值
export interface GatewayProviderSaved {
  providerId: string;
  /// 勾了同步、另一家因此加了 / 改了的那一个网关的 id；没同步为 null
  otherProviderId: string | null;
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
  /// 与 `locationIds` 一一对应：「保留这份」做不成时挡住它的第一处与原因；做得成为 null（core `prepare_keep` 同一套判断）
  keepBlocked: (McpIssue | null)[];
  /// 这几处定义此刻的指纹：「保留这份」确认后原样带回，用户看过之后谁被改了 core 就不动
  revision: string;
}
/// MCP 行详情 `命令` / `地址` 那一行（`mcp_endpoint`）：服务在一处的定义怎么连。凭据已在 core 脱敏
export interface McpEndpoint {
  /// `command`：stdio 的命令 + 参数；`url`：HTTP 的地址
  kind: "command" | "url";
  text: string;
}

// ── 发现与安装 ──
// spec 2026-09-27-skill-mcp-market。与 core `sophia_core::market` 及 `src-tauri/src/market.rs`
// 一一对应（serde camelCase）；要改字段先改 Rust，再改这里。时刻一律是 unix 秒

/// 域 key：`global` / `project:<路径>`
export type LocationKey = string;

/// 发现 · skill 列表条目（core `SkillListing`）
export interface SkillListing {
  name: string;
  /// `owner/repo`
  repo: string;
  /// 仓库内路径；搜索结果不带时为 null，介绍页 / 安装前由后端补上
  path: string | null;
  /// 装过的人
  installs: number;
}
/// 联网来源连不上 / 被限流时的降级说明（R16 灰面板）
export interface MarketFallback {
  /// `skills.sh` / `MCP 目录` / `GitHub`
  service: string;
  /// 显示的是哪一刻的缓存；null＝随包数据
  cachedAt: number | null;
  /// 被限流（GitHub、skills.sh、MCP 目录都可能）：说限流，不自动重试
  rateLimited: boolean;
  /// 为什么（spec 2026-10-04-local-diagnostics R10）：`skills.sh 返回的内容读不懂` 等一句；只是连不上为 null / 缺省
  reason?: string | null;
  /// 技术原文（请求、状态码、返回体开头；已去隐私），灰面板 `详情` 里给
  detail?: string | null;
}
/// 发现 · skill 的一行：`installedIn` 非空时 `安装` 换成 `✓ 已安装`。
/// `skillId` 是 skills.sh 的 id（在线榜单、搜索结果会有，与显示名不一定相同，如 `react:components` / `reactcomponents`）：
/// `path` 为空时把它交给介绍页（`marketSkillReadme` 的 name）或安装页（`paths` 里只写它）找文件夹
export type SkillRow = SkillListing & { skillId: string | null; installedIn: LocationKey[] };
export interface SkillList {
  items: SkillRow[];
  fallback: MarketFallback | null;
  /// 热门榜单来源；搜索结果为 null。可选以兼容旧预览数据。
  popular?: {
    source: "bundled" | "online";
    updatedAt: number | null;
    refreshNeeded: boolean;
  } | null;
}

export type McpTransport = "stdio" | "http" | "sse";
/// 一份给定的 MCP 定义（core `McpDefinitionInput`）；值里可以有 `${KEY}` 占位
export interface McpDefinitionInput {
  /// 粘贴的单个服务器对象没有名字时为空串，界面要用户补
  name: string;
  transport: McpTransport;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  url?: string | null;
  headers?: Record<string, string>;
  /// 上面装不下、原样保留的字段（Gemini 的 `trust`、Codex 的 `startup_timeout_sec`……）；只有 `dialect` 那一家接得住
  extra?: Record<string, unknown>;
  /// 按粘贴的写法认出的出处（harness id，或表外的 `zed`、`vscode`）；认不出为 null
  dialect?: string | null;
}
/// 安装页「要填的」一项；`key` 就是定义里 `${KEY}` 的名字
export interface McpFieldSpec {
  key: string;
  kind: "env" | "header" | "arg";
  required: boolean;
  /// 密钥：框遮住，可按眼睛看一眼
  secret: boolean;
  description?: string | null;
}
/// 发现 · MCP 条目（core `McpCatalogEntry`）
export interface McpCatalogEntry {
  name: string;
  /// 发布方（小灰字）
  publisher: string;
  description: string;
  definition: McpDefinitionInput;
  fields: McpFieldSpec[];
  homepage?: string | null;
  /// 精选写出处，官方目录写 `registry`
  source: string;
  /// 要在浏览器里登录才能用（远程 OAuth）：列表的「要填」写 `需要登录`
  signIn: boolean;
}
export type McpRow = McpCatalogEntry & {
  /// 行的身份：精选 `curated:<名字>`，官方目录是目录里的全名（`io.github.brave/brave-search-mcp-server`）
  id: string;
  /// 源码仓库（GitHub 网址，可带 `/tree/<分支>/<子目录>`）：介绍页交给 `marketMcpReadme`
  repository: string | null;
  installedIn: LocationKey[];
};
/// 没输入时只有 `curated`；搜索时 `registry` 是官方目录那一节
export interface McpList {
  curated: McpRow[];
  registry: McpRow[];
  fallback: MarketFallback | null;
  searchCache?: { updatedAt: number | null; refreshNeeded: boolean } | null;
}

/// 介绍页正文：SKILL.md（或 MCP 的 README）原文，frontmatter 由前端去掉
export interface SkillReadme {
  text: string;
  /// 实际用的分支
  branch: string;
  /// 实际取到的文件夹（仓库内路径，仓库根为空串）；搜索结果没有路径时由这里补上
  path: string;
  pageUrl: string;
}

/// 粘贴链接认出来之后（R6）
export interface ResolvedLink {
  /// `owner/repo`
  repo: string;
  branch: string;
  skills: { name: string; path: string }[];
  /// 贴底 `从 codeload.github.com 下载 · main · 2.1 MB`
  downloadUrl: string;
  sizeBytes: number | null;
}

/// 装 skill 的请求（core `SkillInstallRequest`）
export interface SkillInstallRequest {
  repo: string;
  /// 分支；空串＝取仓库的默认分支
  branch: string;
  /// 仓库内各 skill 文件夹的路径；不知道路径（搜索结果）时写 skill 名，后端按包里的文件夹补上
  paths: string[];
  /// 装到哪个位置；不能是「全部」
  location: LocationKey;
  /// 给哪些 agent 建链接
  harnessIds: string[];
}
export interface InstallItem {
  name: string;
  path: string;
  /// 落点 `<storeDir>/<name>`
  dest: string;
  /// 不能装的原因（`用户级的通用仓库里已经有 pdf`）
  blocked: string | null;
}
/// 装 skill 的计划（core `InstallPlan`）
export interface InstallPlan {
  location: LocationKey;
  /// 这个位置的通用仓库 `.agents/skills`
  storeDir: string;
  /// 还不存在，装时创建并成为这个位置的来源
  createsStore: boolean;
  items: InstallItem[];
  /// 直接读 `.agents/skills` 的 agent：勾选行后写 `直接读取，不用链接`
  directReaders: string[];
  links: PlannedAction[];
  /// 其余要靠链接的 agent（勾没勾都列）：目录与里面已有同名东西的 skill 名（M14：那一行不能勾）
  agentDirs: AgentDir[];
}
/// 一个要靠链接才读得到的 agent 在这个位置的 skill 目录（core `AgentDir`）
export interface AgentDir {
  harnessId: string;
  dir: string;
  /// 这次勾了它
  chosen: boolean;
  /// 这个目录已经有同名东西的 skill 名：不覆盖、不建链接
  taken: string[];
}
/// 装上了、但没给某个勾了的 agent 链上（core `Unlinked`）
export interface Unlinked {
  harnessId: string;
  name: string;
  /// `那里已有同名的`，或建链接失败的那一句
  reason: string;
}
/// 安装页（R9）：计划 + 贴底的下载地址与大小
export interface SkillInstallPreview {
  plan: InstallPlan;
  /// 实际用的分支（请求里分支为空时取的默认分支）
  branch: string;
  downloadUrl: string;
  sizeBytes: number | null;
}
/// Sophia 记下的安装来历（core `InstallRecord`，存 installs.json）
export interface InstallRecord {
  name: string;
  location: LocationKey;
  repo: string;
  branch: string;
  path: string;
  treeSha: string;
  /// 装下那一版排除杂项（`.DS_Store`、`__pycache__` 等）后的指纹；这一项加上之前记下的没有
  contentSha?: string;
  commitSha: string;
  installedAt: number;
}
/// 装 / 更新的结果（core `InstallOutcome`）；`undoId` 交给 `marketUndo`
export interface InstallOutcome {
  installed: string[];
  /// skill 名 → 原因
  failed: Record<string, string>;
  links: SyncReport;
  /// 装上了但没链上的 agent（勾了、那里已有同名的或建链接失败）
  unlinked: Unlinked[];
  records: InstallRecord[];
  undoId: string | null;
}

/// 把给定的定义写进一个位置的若干 agent（core `McpInstallRequest`）
export interface McpInstallRequest {
  definitions: McpDefinitionInput[];
  location: LocationKey;
  harnessIds: string[];
  /// 要填的值：key → 值。只写进目标配置文件，不要存、不要打日志
  values: Record<string, string>;
  /// 项目位置里 Claude Code 写到哪一格（spec 2026-09-30-mcp-claude-self-team R8）：`self` 本地配置（缺省）、
  /// `team` 项目的 `.mcp.json`；用户级忽略
  claudeCodeScope?: ClaudeCodeScope;
  /// 勾了「同时加进 .gitignore」（密钥提醒 S19）：写成之后把提醒为 `remind` 的项目文件加进项目根的 `.gitignore`
  addToGitignore?: boolean;
}
export type ClaudeCodeScope = "self" | "team";
/// 密钥提醒的五种结果（core `KeyHint`；spec 2026-10-05-skill-mcp-batch2「密钥提醒（S19）」）：
/// 不处理 / 不处理（来源已提交过）/ 目标加进 `.gitignore` 并在提示条里说 / 默认不勾的「同时加进 .gitignore」/
/// 目标文件已被跟踪（不出勾选、不追加，说一句）
export type KeyHint = "quiet" | "sourceCommitted" | "autoIgnore" | "remind" | "tracked";
/// 「写进哪些 agent」一行的检查结果（core `McpTargetCheck`）
export interface McpTargetCheck {
  harnessId: string;
  locationId: string | null;
  /// 这个位置的配置文件完整路径：安装页勾选行悬停 `写入 <路径>`；这个位置没有时为 null
  configPath: string | null;
  /// `same`：已有同名且一样的，跳过、不算失败
  status: "ok" | "partial" | "blocked" | "same";
  writes: string[];
  reason: string | null;
  /// `重启 Claude Desktop 后生效`
  note: string | null;
  /// 往 git 仓库里的项目文件写像密钥的值时为 `remind`；那个文件已被跟踪时为 `tracked`
  keyHint: KeyHint;
  /// `remind` / `tracked` 时这个文件在项目根 `.gitignore` 里写成的那一行（`.cursor/mcp.json`、`/.mcp.json`），其余为 null
  gitignoreLine: string | null;
}
/// 粘贴 JSON 的解析结果（R8）；解析不了时 `error` 说哪一行
export interface McpParseResult {
  servers: McpDefinitionInput[];
  error: { line: number | null; message: string } | null;
}

/// 一个有新版本的 skill（core `UpdateInfo`）
export interface UpdateInfo {
  name: string;
  location: LocationKey;
  dir: string;
  repo: string;
  branch: string;
  /// 「看改动」：`https://github.com/{repo}/commits/{branch}/{path}`
  path: string;
  origin: "sophia" | "skillLock";
  localTreeSha: string | null;
  recordedTreeSha: string;
  /// 按 × 时记下的就是它
  remoteTreeSha: string;
  locallyModified: boolean;
  /// 改过的文件（相对 skill 文件夹）
  changedFiles: string[];
}
export interface UpdateTarget {
  location: LocationKey;
  name: string;
}
/// 查更新的结果（R14 / R15）
export interface UpdateCheck {
  updates: UpdateInfo[];
  checkedAt: number | null;
  /// 提示条该不该出
  stripVisible: boolean;
  fallback: MarketFallback | null;
}
/// 设置 `自动检查 skill 更新` 那一行
/// 外观：跟随系统 / 浅色 / 深色（core `store::Appearance`）
export type Appearance = "system" | "light" | "dark";

/// 界面语言设置：跟随系统 / 简体 / 繁體 / English（core `store::Language`）
export type LanguageSetting = "system" | "zh-Hans" | "zh-Hant" | "en";

/// 界面语言：设置里存的，和此刻实际用的（`跟随系统` 已按系统首选语言解析；core `i18n::Lang`）
export interface UiLanguage {
  setting: LanguageSetting;
  resolved: "zh-Hans" | "zh-Hant" | "en";
}

export interface SkillUpdateSettings {
  autoCheck: boolean;
  lastCheck: number | null;
}

/// 设置「关于」里 `使用统计和错误报告` 那一行（src-tauri/src/report.rs `ReportSettings`）
export interface ReportSettings {
  autoReport: boolean;
  /// 这份构建、这次运行能不能上报（有接收服务地址、没设 DO_NOT_TRACK）；不能时不画开关
  available: boolean;
  /// 有没有接收服务能收反馈（有地址就有；DO_NOT_TRACK 不管它）
  feedback: boolean;
}

/// 上传截图、发送反馈没成的原因（core `report::feedback::Failure`）
export type FeedbackFailure =
  "network" | "rateLimited" | "server" | "tooLarge" | "shotExpired" | "other";

/// 网页侧报给自动上报的两种异常（core `report::Kind::from_frontend`）
export type ReportCountKind = "pageFault" | "uncaught";

// ===== 菜单栏用量（spec 2026-09-26-menubar-usage 第 6 节；与 crates/core/src/usage 一一对应） =====

/// 有用量的 agent，与 agent 注册表、`AgentIcon` 的 id 一致
export type UsageAgentId = "claude-code" | "codex";
/// `desktopHistory`：Claude 桌面应用记在本机的用量历史（命令行不可用时读；只有百分比，没有重置时间）
export type UsageSource = "getUsage" | "rollout" | "appServer" | "desktopHistory";
export type UsageSeverity = "normal" | "warning" | "critical";
export interface UsageWindow {
  /// `session`、`weekly`、`model:<显示名>`、`minutes:<N>`；设置里记主 / 第二窗口用它
  key: string;
  /// 「5 小时」「本周」「本周 · Fable」
  label: string;
  /// 已用 0–100
  usedPercent: number;
  resetsAt: number | null;
  windowMinutes: number | null;
  severity: UsageSeverity;
  active: boolean;
}
export interface UsageReading {
  agent: UsageAgentId;
  source: UsageSource;
  observedAt: number;
  windows: UsageWindow[];
  plan: string | null;
}
export type UsageStatus =
  | { kind: "ok" }
  | { kind: "notInstalled" }
  | { kind: "notSignedIn" }
  | { kind: "noPlanLimits" }
  | { kind: "rateLimited"; until: number }
  | { kind: "failing"; reason: string };
export interface AgentUsage {
  agent: UsageAgentId;
  status: UsageStatus;
  reading: UsageReading | null;
  attemptedAt: number | null;
}
export interface UsageState {
  agents: AgentUsage[];
}
export type UsageDisplayMode = "remaining" | "used";
export type StackedSize = "small" | "medium" | "large";
export type UsageRefresh = "auto" | "off" | "5" | "10" | "15";
/// 每个 agent 在菜单栏上怎么显示（叠放与字号也跟着 agent 走）
export interface AgentDisplay {
  /// 主窗口的 key；null＝自动
  primary: string | null;
  /// 第二窗口的 key；null＝无
  secondary: string | null;
  /// 选了第二窗口时上下两行（否则一行「5h 87% | 7d 13%」）
  stacked: boolean;
  stackedSize: StackedSize;
}
export interface UsageSettings {
  menuBarEnabled: boolean;
  displayMode: UsageDisplayMode;
  /// 菜单栏显示哪些 agent（有序，最多 3 个）；null＝没配过，取已登录的
  agents: UsageAgentId[] | null;
  perAgent: Partial<Record<UsageAgentId, AgentDisplay>>;
  refresh: UsageRefresh;
}
/// 托盘里一个窗口：名字、刻度、文字（剩余 / 已用按设置换算好）
export interface TrayWindowRow {
  label: string;
  percentText: string;
  gaugePercent: number;
  /// 服务端判为紧张：加粗（不用颜色）
  emphasize: boolean;
  /// 「4 小时 19 分后重置」「6 天后重置」；已经重置过或没给是 null
  resetText: string | null;
}
/// 托盘里一个 agent 的用量（块头后的过期弱字、一窗口一行、一句状态）
export interface TrayUsage {
  agent: UsageAgentId;
  /// 块头名字后的「3 分钟前更新」；读数来自 Claude 桌面应用时是「来自 Claude 桌面应用 · 3 小时前」；
  /// 还没有读数、或桌面应用的读数超过 24 小时（原因行里说了多少天）是 null
  updatedText: string | null;
  windows: TrayWindowRow[];
  note: string | null;
  /// 原因行右端给不给「再试一次」：后端按原因算好（版本可能太旧、没有回应、没能启动、认不出、没找到才给）；
  /// 有 `connect` 时不给
  retry: boolean;
  /// 「连接 Claude 用量」那一处（只 Claude 有，票 #208）：命令行不可用时原因行右端的键，或连接进行到哪、失败的出口；
  /// 命令行正常时 null。句子在 `note`
  connect: ConnectAction | null;
}

/// 原因行右端「连接 Claude 用量」那一处（core `usage::format::ConnectAction`）
export type ConnectAction =
  /// 默认键「连接 Claude 用量」
  | { kind: "offer" }
  /// 键原位忙碌「正在安装 Claude Code」（不可取消）
  | { kind: "installing" }
  /// 句首刻度 +「在浏览器里登录并点授权」，右端「取消」；`reopen` 时下一句「没看到授权页 · 再打开 ↗」
  | { kind: "waiting"; reopen: boolean }
  /// 授权完成、在取首轮用量：键原位忙碌「正在读取」，不可取消
  | { kind: "finishing" }
  /// 失败：右端总有「再试一次」；`detail` 挂在句首「!」上，`manualInstall` 是句后「手动安装 ↗」打开的地址
  /// （后端给，null 不出这颗键）
  | {
      kind: "failed";
      detail: string | null;
      manualInstall: string | null;
    };

/// 点「连接 Claude 用量」的结果（gateway `usage::connect::ConnectStart`）
export type ConnectStart = "started" | "needsInstall" | "busy";
export interface MenuBarSegment {
  agent: UsageAgentId;
  lines: string[];
  stale: boolean;
  stackedSize: StackedSize;
}
export interface MenuBarView {
  /// 空：只有 Sophia 图标（菜单栏显示关着）
  segments: MenuBarSegment[];
}
/// 托盘、用量页要画的一份视图，文字全在 core 里算好
export interface UsageView {
  state: UsageState;
  settings: UsageSettings;
  /// 有用量来源的 agent（登录了，或 Claude 命令行没登录但有桌面应用的记录）；名字沿用「已登录」
  signedIn: UsageAgentId[];
  tray: TrayUsage[];
  /// 用量页的预览：打开菜单栏显示后会是的样子（开关关着也照样算）
  menuBar: MenuBarView;
}
