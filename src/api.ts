import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { showCopiesAsLinked } from "./cellState.ts";
import { createGatewayGate } from "./gatewayGate.ts";
import type {
  Appearance,
  AutoLink,
  CellRef,
  CopyRef,
  GatewayAgent,
  ProviderPreset,
  ProviderAdded,
  ProviderPreview,
  ProviderRow,
  GatewayState,
  ModelRef,
  QuitFailure,
  QuitPreview,
  HarnessList,
  ProjectScope,
  LanguageSetting,
  Overview,
  PlannedAction,
  PlannedDeletion,
  SkillCopyInfo,
  SourceList,
  SourceSummary,
  SourceRemoval,
  SyncReport,
  McpOverview,
  McpPreview,
  McpKeyHint,
  McpReport,
  McpUndoReport,
  McpRemoveItem,
  McpSelection,
  McpDiff,
  McpEndpoint,
  McpRemovalItem,
  McpSourceList,
  McpSourceRemoval,
  ProjectTimes,
  // 发现与安装
  InstallOutcome,
  McpInstallRequest,
  McpList,
  McpParseResult,
  McpTargetCheck,
  ReportCountKind,
  ReportSettings,
  ResolvedLink,
  SkillInstallPreview,
  SkillInstallRequest,
  SkillList,
  SkillReadme,
  SkillUpdateSettings,
  UiLanguage,
  UpdateCheck,
  UpdateTarget,
  UsageItemKey,
  ConnectStart,
  UsageSettings,
  UsageView,
} from "./types";

// PlannedDeletion 定义在 types.ts（与 serde 一一对应）；
// 这里再导出一次，调用方从 api.ts 或 types.ts 引都行
export type { PlannedDeletion } from "./types";

/// 重启 Codex 的结果（与 Rust 的 RestartReport 一一对应）：结束了几个后台进程；桌面应用退出后重新打开了没有
/// （它自己拉起的后台进程随它一起退，`terminated` 可以是 0）
export type GatewayRestartReport = { terminated: number; pids: number[]; reopened: boolean };

/// 模型状态的读写排先后（走查 f08：后台轻查拿到的旧状态盖掉勾选的乐观更新），规则见 gatewayGate.ts
const gate = createGatewayGate();
const readGateway = () => invoke<GatewayState>("gateway_state");
const writeGateway = (command: string, args?: Record<string, unknown>) =>
  gate.write(() => invoke<GatewayState>(command, args), readGateway);

export const api = {
  /// Sophia 放的副本在界面上按已链画（`showCopiesAsLinked`）
  scanAll: () => invoke<Overview>("scan_all").then(showCopiesAsLinked),
  /// 这些格里缺失的 → 建链动作
  proposeLinks: (cells: CellRef[]) => invoke<PlannedAction[]>("propose_links", { cells }),
  /// 这些格里已链接且目标非整目录链接的 → 删链动作
  proposeUnlinks: (cells: CellRef[]) => invoke<PlannedAction[]>("propose_unlinks", { cells }),
  applyAll: (actions: PlannedAction[], cleanBroken: boolean) =>
    invoke<SyncReport>("apply_all", { actions, cleanBroken }),
  splitWholeLink: (targetId: string) => invoke<SyncReport>("split_whole_link", { targetId }),
  /// 同名几份里一份的读数（只读，不留删除计划）：`×2` 的提示框与推荐保留哪份
  skillCopyInfo: (sourceId: string, skill: string) =>
    invoke<SkillCopyInfo>("skill_copy_info", { sourceId, skill }),
  /// 删本体前的只读体检；计划留在后端，前端拿到的只用来摆给用户确认
  planDeleteSource: (sourceId: string, skill: string) =>
    invoke<PlannedDeletion>("plan_delete_source", { sourceId, skill }),
  /// 同名两份里有一份在 agent 自己目录里时的「只留这份」体检（issue #153）：挪走 `drop`、留下 `keep`，
  /// 指向 `drop` 的链接改指到 `keep`。一方是原件位置里的那一份（`sourceId`），或 agent 目录下的那一份（`targetId`）。
  /// 计划同 `planDeleteSource` 留在后端，确认后照样 `deleteSource`
  planKeepCopy: (skill: string, keep: CopyRef, drop: CopyRef) =>
    invoke<PlannedDeletion>("plan_keep_copy", { skill, keep, drop }),
  /// 执行用户已确认的删除计划；planId 用后即弃，不能重放
  /// `inGitConfirmed`：删原件的确认框已写明原件在 git 仓库里、用户仍确认了（只留这份不传，仓库里的不代删）
  /// 结果带撤销 id：原件挪进了暂存处才有（跨磁盘退回直接进废纸篓时为 null）
  deleteSource: (planId: string, inGitConfirmed = false) =>
    invoke<{ report: SyncReport; undoId: string | null }>("delete_source", {
      planId,
      inGitConfirmed,
    }),
  /// 撤销最近一次删原件：原件放回原处、链接复原；过期（又删了别的、重开过）时报错
  undoDeleteSource: (undoId: string) => invoke<SyncReport>("undo_delete_source", { undoId }),
  /// 来源管理页：这个位置（DomainPage.key）已订阅的来源与 `+ 来源` 的两组候选。只读
  listSources: (domain: string) => invoke<SourceList>("list_sources", { domain }),
  /// 在这个位置订阅一个来源（候选的 path，或用户选的文件夹）；只记订阅，不建链
  subscribeSource: (domain: string, path: string) =>
    invoke<void>("subscribe_source", { domain, path }),
  /// 添加来源弹窗：选好的文件夹订阅之前的只读预览（只认带 SKILL.md 的子目录）
  previewSourceFolder: (path: string) => invoke<SourceSummary>("preview_source_folder", { path }),
  /// 移除前的只读清单：会撤掉的软链。原件在这个位置里的来源 reject，错误信息就是给用户看的原因
  planRemoveSource: (domain: string, sourceId: string) =>
    invoke<SourceRemoval>("plan_remove_source", { domain, sourceId }),
  /// 撤掉软链、删订阅记录与规则里本位置的目标；原件不动。执行时按当下重新算清单
  removeSource: (domain: string, sourceId: string) =>
    invoke<SyncReport>("remove_source", { domain, sourceId }),
  listManualSources: () => invoke<string[]>("list_manual_sources"),
  addManualSource: (path: string) => invoke<void>("add_manual_source", { path }),
  removeManualSource: (path: string) => invoke<void>("remove_manual_source", { path }),
  /// 侧栏排序用的项目时间，按传入顺序返回；只读
  projectTimes: (paths: string[]) => invoke<ProjectTimes[]>("project_times", { paths }),
  listAutoLinks: () => invoke<AutoLink[]>("list_auto_links"),
  /// 新建或合并该本体位置的规则（目标取并集）
  setAutoLink: (source: string, targets: string[]) =>
    invoke<void>("set_auto_link", { source, targets }),
  removeAutoLink: (source: string) => invoke<void>("remove_auto_link", { source }),
  /// 只撤该规则的部分目标；目标去空则整条规则删除
  removeAutoLinkTargets: (source: string, targets: string[]) =>
    invoke<void>("remove_auto_link_targets", { source, targets }),
  /// 该 skill 不再自动链接到这个目标（在这一格手动清除过）；别的目标不受影响
  excludeAutoLink: (source: string, target: string, skill: string) =>
    invoke<void>("exclude_auto_link", { source, target, skill }),
  includeAutoLink: (source: string, target: string, skill: string) =>
    invoke<void>("include_auto_link", { source, target, skill }),
  listHarnesses: () => invoke<HarnessList>("list_harnesses"),
  /// 设置「生效范围」的项目格（自动检测的与手动选的，存在的才列）
  listProjects: () => invoke<ProjectScope[]>("list_projects"),
  /// `+ 项目` / 应用菜单「添加项目…」：选的文件夹记下、默认勾上。当不了项目的 reject，错误信息就是给用户看的那句
  addProject: (path: string) => invoke<void>("add_project", { path }),
  /// 勾上 / 取消勾一个项目；取消勾只是不显示，链接不动
  setProjectShown: (path: string, shown: boolean) =>
    invoke<void>("set_project_shown", { path, shown }),
  setHarnessEnabled: (id: string, enabled: boolean) =>
    invoke<void>("set_harness_enabled", { id, enabled }),
  /// 看过的新手提示 id（存在 settings.json 的 seenHints；旧文件没有＝空）
  listSeenHints: () => invoke<string[]>("list_seen_hints"),
  /// 记下一条看过的新手提示；core 去重、空串忽略
  markHintSeen: (id: string) => invoke<void>("mark_hint_seen", { id }),
  /// 系统目录选择框；取消返回 null
  pickDirectory: async (title: string): Promise<string | null> => {
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  },
  /// 在系统文件管理器里定位并选中该路径
  revealInDir: (path: string) => revealItemInDir(path),
  /// 文字进系统剪贴板（右键「拷贝路径」）。不用 navigator.clipboard：原生右键菜单的项在菜单关掉之后才执行，
  /// 已不在网页的用户手势里，WKWebView 会拒绝写入；原生剪贴板插件没有这个限制
  copyText: (text: string) => writeText(text),
  /// 技术原文去隐私（家目录、密钥、网址里的查询参数等），复制详情前先过它；规则只在 core 的 `redact` 一份
  redactText: (text: string) => invoke<string>("redact_text", { text }),
  /// 开发版的故意出错入口：`page:<页>` 等；正式版恒为 null
  debugFault: () => invoke<string | null>("debug_fault"),
  /// 自动上报（spec 2026-10-04-reporting-feedback R6、R7、R8）：设置「关于」里那一行与开关；
  /// 网页侧的异常记一次次数，带了原文再收一条错误事件（后端去隐私）。内部版没有这三个命令
  /// （`available` 读不到就当不能上报）
  reportSettings: () => invoke<ReportSettings>("report_settings"),
  setAutoReport: (enabled: boolean) => invoke<void>("set_auto_report", { enabled }),
  reportCountFrontend: (kind: ReportCountKind, text?: string) =>
    invoke<void>("report_count_frontend", { kind, text }),
  /// 上次是不是意外退出的（崩溃、被强制结束、断电；一次启动一次）
  lastExitUnexpected: () => invoke<boolean>("last_exit_unexpected"),
  /// 这次启动时设置文件坏了、已另存并重置（spec S7；一次启动一次）
  settingsRepaired: () => invoke<boolean>("settings_repaired"),
  /// 应用内反馈（spec 2026-10-04-reporting-feedback R12）：传一张已压好的 JPEG，回截图 id。
  /// 字节走原始请求体（不转 JSON 数组，后端转 base64 再发）。界面的进度只按时间模拟（交给 socket 的字节一开始
  /// 就接近 100%，真机 2026-10-05），后端不报进度。
  /// 失败时拒绝的值是原因名（`FeedbackFailure`）。内部版没有这两个命令
  feedbackUploadShot: (bytes: Uint8Array) => invoke<string>("feedback_upload_shot", bytes),
  /// 发反馈：草稿 id（32 位小写 hex，重试复用，接收服务据它去重）、写的话、已传上去的截图 id、
  /// 出错页带来的已去隐私的错误详情（后端再过一遍、附上诊断内容）
  feedbackSend: (id: string, text: string, shots: string[], attached?: string) =>
    invoke<void>("feedback_send", { id, text, shots, attached: attached ?? null }),
  scanMcp: () => invoke<McpOverview>("scan_mcp"),
  /// 同名服务在这几个位置上哪些字段不一样（只读；凭据已在 core 脱敏）
  mcpFieldDiff: (name: string, locationIds: string[]) =>
    invoke<McpDiff>("mcp_field_diff", { name, locationIds }),
  /// 行详情的 `命令` / `地址`：服务 `name` 在 `locationId` 那一处的定义（只读；凭据已在 core 脱敏）。
  /// 读不出来是 null，那一行不写
  mcpEndpoint: (name: string, locationId: string) =>
    invoke<McpEndpoint | null>("mcp_endpoint", { name, locationId }),
  proposeMcpSync: (selections: McpSelection[]) =>
    invoke<McpPreview>("propose_mcp_sync", { selections }),
  /// 写进项目文件的后端一律按密钥提醒处理。`addToGitignore`：只有移动 / 复制的确认框给（勾没勾「同时加进 .gitignore」）；
  /// 格子里的写入不给，按没勾——报告里的 `ignorable` 交给 `addMcpGitignore`
  applyMcp: (planId: string, allowCrossDomain: boolean, addToGitignore?: boolean) =>
    invoke<McpReport>("apply_mcp", {
      planId,
      allowCrossDomain,
      addToGitignore: addToGitignore ?? null,
    }),
  /// 密钥提醒（S19）：这几条写进项目文件时各目标的提醒（只读），移动 / 复制的确认框据此出不出勾选
  checkMcpKeyHints: (selections: McpSelection[]) =>
    invoke<McpKeyHint[]>("check_mcp_key_hints", { selections }),
  /// 点格子写入的提示条上的「加进 .gitignore」：那次写入报告里的 `ignorable`。撤销号在 `gitignoreUndoId`
  addMcpGitignore: (targetIds: string[]) => invoke<McpReport>("add_mcp_gitignore", { targetIds }),
  /// 从 agent 的配置里删掉 MCP 定义（单格或批量）：每项只删那个位置（locationId）里 name 的定义，
  /// 别处的同名定义不动。拿不掉的以 skipped + 原因回来；一批一个撤销（`undoId`），交给 `mcpUndoWrite`
  deleteMcpOriginal: (items: McpRemoveItem[]) =>
    invoke<McpReport>("delete_mcp_original", { items }),
  /// 「保留这份」：以 keepId 那一处的 name 为准，改写 locationIds 里其余几处（各 agent 专属字段不动）。
  /// 一处不成整次不动（没成的 failed + 原因，其余 skipped）；写成的一次撤销（`undoId`），交给 `mcpUndoWrite`
  /// 密钥提醒接到「保留这份」（issue #147）：`addToGitignore` 是确认框里勾没勾「同时加进 .gitignore」，
  /// 追加的那几行进同一次撤销（`undoId`）
  keepMcpCopy: (
    name: string,
    keepId: string,
    locationIds: string[],
    revision: string,
    addToGitignore: boolean,
  ) => invoke<McpReport>("keep_mcp_copy", { name, keepId, locationIds, revision, addToGitignore }),
  /// 密钥提醒（S19，issue #147）：「保留这份」要改写的项目文件各自的提醒（只读），确认框据此出不出勾选
  checkMcpKeepKeyHints: (name: string, keepId: string, locationIds: string[]) =>
    invoke<McpKeyHint[]>("check_mcp_keep_key_hints", { name, keepId, locationIds }),
  /// 撤销一次 MCP 写入；id 不存在或已过期时 reject「撤销记录不存在或已过期」
  mcpUndoWrite: (undoId: string) => invoke<McpUndoReport>("mcp_undo_write", { undoId }),
  /// 打开要在里面点「信任」的 agent（#256：写进 WorkBuddy 之后的 `打开 WorkBuddy ↗`）；只认 core 名单里的
  mcpOpenTrustApp: (harnessId: string) => invoke<void>("mcp_open_trust_app", { harnessId }),
  setMcpAutoImport: (
    sourceId: string,
    targetDomain: string,
    targetIds: string[],
    allowCrossDomain: boolean,
  ) =>
    invoke<void>("set_mcp_auto_import", {
      sourceId,
      targetDomain,
      targetIds,
      allowCrossDomain,
    }),
  removeMcpAutoImport: (sourceId: string, targetDomain: string) =>
    invoke<void>("remove_mcp_auto_import", { sourceId, targetDomain }),
  /// MCP 来源管理页：这个位置（域 key）已订阅的来源与 `+ 来源` 的两组候选。只读
  listMcpSources: (domain: string) => invoke<McpSourceList>("list_mcp_sources", { domain }),
  /// 在这个位置订阅一处 MCP 配置（位置 id）；只记订阅，不写配置
  subscribeMcpSource: (domain: string, sourceId: string) =>
    invoke<void>("subscribe_mcp_source", { domain, sourceId }),
  /// 移除前的只读清单：本位置与它一致的那几份（服务名 × 位置）。自己的配置 reject，错误信息就是原因
  planRemoveMcpSource: (domain: string, sourceId: string) =>
    invoke<McpSourceRemoval>("plan_remove_mcp_source", { domain, sourceId }),
  /// 只拿掉确认过的那几项（执行前逐项重校验，改过的跳过），再删订阅记录与往这里写的规则
  removeMcpSource: (domain: string, sourceId: string, items: McpRemovalItem[]) =>
    invoke<McpReport>("remove_mcp_source", { domain, sourceId, items }),
  gatewayState: () => gate.read(readGateway),
  /** `修复权限`：经系统密码框把 Sophia 管的这份文件改回当前账户所有，返回重读的状态；用户取消抛 `[cancelled] ` */
  gatewayFixFileOwner: (path: string) => writeGateway("gateway_fix_file_owner", { path }),
  /** `打开文件 ↗`：用默认应用打开 Sophia 管的这份文件 */
  gatewayOpenFile: (path: string) => invoke<void>("gateway_open_file", { path }),
  /** 服务商预设的名单（内置数据，不联网；spec S1） */
  gatewayPresets: () => invoke<ProviderPreset[]>("gateway_presets"),
  // ----- 各 agent 的「已选」（#259）：从全局模型提供商名单里选，开着的那一家当场跟上 -----
  /** 勾上（追加到这一家「已选」末尾）或取消一个；取消最后一个第三方模型＝关掉这一家 */
  gatewayPick: (agent: GatewayAgent, model: ModelRef, on: boolean) =>
    writeGateway("gateway_pick", { agent, model, on }),
  /** 排序（#265）：「已选」里看得见的几项的新顺序，看不见的原地不动 */
  gatewayReorderPicks: (agent: GatewayAgent, order: ModelRef[]) =>
    writeGateway("gateway_reorder_picks", { agent, order }),
  /** 「恢复默认顺序」（#265）：官方的在前、按它自己的顺序，第三方的按启用先后 */
  gatewayRestoreOrder: (agent: GatewayAgent) => writeGateway("gateway_restore_order", { agent }),
  /** 打开这一家。Claude：桌面应用不在运行时当场写，在运行时只记下（desktop.pending） */
  gatewayEnable: (agent: GatewayAgent) => writeGateway("gateway_enable", { agent }),
  /** 关掉这一家（Claude：切回账号；在运行时只记下） */
  gatewayRestore: (agent: GatewayAgent) => writeGateway("gateway_restore", { agent }),
  /** 接管别家的生效配置（Codex：agents-manager；Claude：别的工具写进桌面应用的第三方配置） */
  gatewayTakeover: (agent: GatewayAgent) => writeGateway("gateway_takeover", { agent }),
  /** 打开 Claude 桌面应用：有待生效的先写（写失败不打开），再等它在运行（上限 20 秒） */
  gatewayLaunchClaude: () => writeGateway("gateway_launch_claude"),
  /** 重启 Claude 桌面应用让改动生效：退出（最多 15 秒，没退出是 desktop_busy、什么都不写）→ 写 → 重新打开。
   *  会打断正在用的桌面应用，调用前先向用户确认 */
  gatewayRestartClaude: () => writeGateway("gateway_restart_claude"),
  /// 重新接上（路由没在跑、没接上时的 `重启路由` / `再试一次`）：起路由，端口被别的程序占着就换一个，按「开着」写设置；
  /// 不重启 Codex、Claude
  gatewayRestart: () => writeGateway("gateway_restart"),
  /// 结束 Codex 的后台进程，下次启动才读到新配置；terminated 为 0 表示 Codex 当时没在跑
  gatewayRestartCodex: () => invoke<GatewayRestartReport>("gateway_restart_codex"),
  /// 按应用标识打开 Codex 桌面应用；只发出请求，等它起来要自己轮询 `codex.running`
  gatewayLaunchCodex: () => invoke<void>("gateway_launch_codex"),

  // ----- 全局模型提供商（#252）：名单与密钥；启用只进这一家的已启用名单，agent 要用在「选模型」里勾（2026-10-08），
  // 名单变了开着的 agent 跟上 -----
  providersList: () => invoke<ProviderRow[]>("providers_list"),
  /// 添加弹窗：用表单里的地址与密钥拉模型列表、按默认规则先勾好。只读，不写设置与密钥
  providersPreview: (input: { baseUrl: string; key: string; preset?: string }) =>
    invoke<ProviderPreview>("providers_preview", input),
  /// 添加弹窗框底手填 id：用表单里的密钥先试一次（调不通抛 `[代码] 原因`）。不写任何文件
  providersProbeDraft: (input: { apiBase: string; key: string; preset?: string; model: string }) =>
    invoke<void>("providers_probe_draft", input),
  /// 加一家：先用密钥拉模型，再启用（`enabled` 是弹窗里勾定的；不传按默认规则）；
  /// 名称空的取地址主体，同名拒绝
  providersAdd: (input: {
    name: string;
    baseUrl: string;
    key: string;
    preset?: string;
    enabled?: string[];
  }) => invoke<{ added: ProviderAdded; providers: ProviderRow[] }>("providers_add", input),
  /// 改名称、地址；`key` 不空时先用它拉模型，再一并存
  providersEdit: (input: { id: string; name: string; baseUrl: string; key?: string }) =>
    invoke<ProviderRow[]>("providers_edit", input),
  providersRefetch: (id: string) => invoke<ProviderRow[]>("providers_refetch", { id }),
  /// 勾上前先试调一次（调不通抛 `[代码] 原因`）；取消不试，从各 agent 的「已选」里拿掉
  providersSetEnabled: (id: string, model: string, on: boolean) =>
    invoke<ProviderRow[]>("providers_set_enabled", { id, model, on }),
  /// 手填 id：先试一下，通了才加进列表并启用
  providersAddTyped: (id: string, model: string) =>
    invoke<ProviderRow[]>("providers_add_typed", { id, model }),
  /// 删掉一家与它的密钥
  providersRemove: (id: string) => invoke<ProviderRow[]>("providers_remove", { id }),
  /// 菜单栏面板用：把主窗口带到前面；`page` 给了就切过去，`error` 给了就在那一页上说
  trayOpenMain: (page: "models" | "settings" | null, error: string | null) =>
    invoke<void>("tray_open_main", { page, error }),
  /// 面板高度由内容决定：量好了报给后端去调窗口
  traySetHeight: (height: number) => invoke<void>("tray_set_height", { height }),
  trayHide: () => invoke<void>("tray_hide"),
  /// 退出前问一次：要不要确认、确认框里说什么（都没开着就不确认，直接 `appQuit`）
  quitPreview: () => invoke<QuitPreview>("quit_preview"),
  /// 退出：Codex 改回并重启、Claude 切回官方、停路由，都做成了就退出（这次调用不会返回）。
  /// 有没做成的就不退出、返回那几家（说明后果后用户点 `退出` 走 `appExitNow`）。进度经 `quit-progress` 事件
  appQuit: () => invoke<QuitFailure[]>("app_quit"),
  /// 直接退出（收尾已经做过）
  appExitNow: () => invoke<void>("app_exit_now"),
  /// 开机启动（系统登录项）开着没有：以系统为准
  autostartGet: () => invoke<boolean | null>("autostart_get"),
  /// 打开 / 关掉开机启动；返回改完之后系统里的真实状态
  autostartSet: (on: boolean) => invoke<boolean>("autostart_set", { on }),
  /// 应用菜单里跟着界面灰 / 亮的三项（`撤销` `筛选` `返回`，DESIGN「应用菜单」）
  setMenuState: (state: { undo: boolean; filter: boolean; back: boolean }) =>
    invoke<void>("set_menu_state", { state }),

  // ── 发现与安装 ──
  // spec 2026-09-27-skill-mcp-market；命令在 src-tauri/src/market.rs。联网失败降级为结果里的 `fallback`，
  // 命令本身的 Err 是一句给用户看的中文（限流为 `GitHub 暂时限流，稍后再试`）
  /// 默认读热门缓存；后台更新与手动强刷显式传参数。
  marketPopular: (options?: { refresh?: boolean; force?: boolean }) =>
    invoke<SkillList>("market_popular", options),
  /// skills.sh 搜索；停 300ms 再调由调用方做
  marketSearchSkills: (query: string) => invoke<SkillList>("market_search_skills", { query }),
  /// MCP 精选
  marketMcpCurated: (query?: string) => invoke<McpList>("market_mcp_curated", { query }),
  /// 精选里匹配的 + 官方目录
  marketSearchMcp: (query: string, cachedOnly = false) =>
    invoke<McpList>("market_search_mcp", { query, cachedOnly }),
  /// 介绍页正文；取不到时抛错，界面写 `说明读取失败`。只走 raw，不占 GitHub 接口次数。
  /// branch 为 null 取默认分支；path 为 null（搜索结果）时按 name（行的 skillId，没有就用名字）找文件夹，
  /// 结果的 `path` / `branch` 是实际取到的，安装时带上
  marketSkillReadme: (
    repo: string,
    branch: string | null,
    path: string | null,
    name: string | null = null,
  ) => invoke<SkillReadme>("market_skill_readme", { repo, branch, path, name }),
  /// MCP 介绍页的 README（08B）：传行的 repository 与 homepage；取不到时抛错，界面只留两行事实
  marketMcpReadme: (repository: string | null, homepage: string | null) =>
    invoke<SkillReadme>("market_mcp_readme", { repository, homepage }),
  /// 解析粘贴的链接并列出里面的 skill；认不出时抛 `只认 GitHub 上的仓库或文件夹链接`（不发请求）。
  /// 会下载整包（留在后端内存里给随后的安装用），结果带下载地址与大小
  marketResolveLink: (input: string) => invoke<ResolvedLink>("market_resolve_link", { input }),
  /// 安装页的计划：落点、同名拒绝、直接读取的 agent、下载地址与大小。
  /// request.branch 可为空串（取默认分支，结果的 branch 是实际的）；paths 可只写 skill 名
  marketPlanSkillInstall: (request: SkillInstallRequest) =>
    invoke<SkillInstallPreview>("market_plan_skill_install", { request }),
  /// 装 skill；结果的 undoId 交给 marketUndo
  marketInstallSkill: (request: SkillInstallRequest) =>
    invoke<InstallOutcome>("market_install_skill", { request }),
  /// 「写进哪些 agent」每一行的检查；values 可以传空
  marketPlanMcpInstall: (request: McpInstallRequest) =>
    invoke<McpTargetCheck[]>("market_plan_mcp_install", { request }),
  /// 写 MCP 定义；撤销用 mcpUndoWrite(report.undoId)
  marketInstallMcp: (request: McpInstallRequest) =>
    invoke<McpReport>("market_install_mcp", { request }),
  /// 解析粘贴的 MCP 配置；解析不了不抛错，看结果的 error
  marketParseMcpJson: (text: string) => invoke<McpParseResult>("market_parse_mcp_json", { text }),
  /// 查更新：force=false（打开 SKILLS 页）不到时候就返回上一次的结果；`立即检查` 传 true。
  /// 限流：force 时抛 `GitHub 暂时限流，稍后再试`，否则返回上一次的结果 + fallback.rateLimited
  marketCheckUpdates: (force: boolean) => invoke<UpdateCheck>("market_check_updates", { force }),
  /// 更新；有本地改过的，确认后才传 overwriteModified=true
  marketUpdateSkills: (targets: UpdateTarget[], overwriteModified: boolean) =>
    invoke<InstallOutcome>("market_update_skills", { targets, overwriteModified }),
  /// 撤销一次装或更新
  marketUndo: (undoId: string) => invoke<SyncReport>("market_undo", { undoId }),
  /// 提示条按 ×：传此刻各个 UpdateInfo.remoteTreeSha
  marketDismissUpdates: (treeShas: string[]) =>
    invoke<void>("market_dismiss_updates", { treeShas }),
  /// 设置 `自动检查 skill 更新` 那一行
  skillUpdateSettings: () => invoke<SkillUpdateSettings>("skill_update_settings"),
  setAutoCheckSkillUpdates: (enabled: boolean) =>
    invoke<void>("set_auto_check_skill_updates", { enabled }),
  /// 外观（spec 2026-09-30-language-and-theme R2）：写进设置并当场设到所有窗口
  appearance: () => invoke<Appearance>("appearance"),
  setAppearance: (value: Appearance) => invoke<void>("set_appearance", { value }),
  /// 界面语言（spec 2026-09-30-language-and-theme R1 R2 R12）：改了写进设置、当场换掉（后端发 `locale-changed`）
  uiLanguage: () => invoke<UiLanguage>("ui_language"),
  setUiLanguage: (value: LanguageSetting) => invoke<UiLanguage>("set_ui_language", { value }),
  /// 用量视图（托盘、用量页）。`opened`：刚打开，顺带补取一次（结果经 `usage-changed` 到）；
  /// 收到事件或按分钟重画时传 false。非 macOS 返回 null
  usageView: (opened: boolean) => invoke<UsageView | null>("usage_view", { opened }),
  /// 存用量设置，调度与菜单栏立即生效；菜单栏最多 2 项（agent 与提供商合计），超了报错
  usageSetSettings: (settings: UsageSettings) => invoke<void>("usage_set_settings", { settings }),
  /// 手动刷新。给了项的键（`agent:codex`、`provider:<id>`）是原因行旁的「再试一次」：只取它，不等最短间隔（限流退避照守），
  /// 这一轮跑完才返回（新数照常经 `usage-changed` 到）；为空刷全部，仍受最短间隔约束、发出即返回
  usageRefresh: (key: UsageItemKey | null) => invoke<void>("usage_refresh", { key }),
  /// 「连接 Claude 用量」（票 #208）：找不到 Claude Code 且没确认安装时回 `needsInstall`（先问一句，确认后带
  /// `allowInstall` 再调）；过程的每一步经 `usage-changed` 送达
  usageConnect: (allowInstall: boolean) => invoke<ConnectStart>("usage_connect", { allowInstall }),
  /// 等授权时点「取消」：回到点之前的样子
  usageConnectCancel: () => invoke<void>("usage_connect_cancel"),
  /// 「没看到授权页 · 再打开 ↗」
  usageConnectReopen: () => invoke<void>("usage_connect_reopen"),
};
