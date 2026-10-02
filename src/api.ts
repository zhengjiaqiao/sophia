import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type {
  Appearance,
  AutoLink,
  CellRef,
  GatewayAgent,
  GatewayProviderSaved,
  GatewaySelectedModel,
  GatewayState,
  HarnessList,
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
  ResolvedLink,
  SkillInstallPreview,
  SkillInstallRequest,
  SkillList,
  SkillReadme,
  SkillUpdateSettings,
  UiLanguage,
  UpdateCheck,
  UpdateTarget,
  UsageAgentId,
  UsageSettings,
  UsageView,
} from "./types";

// PlannedDeletion 定义在 types.ts（与 serde 一一对应）；
// 这里再导出一次，调用方从 api.ts 或 types.ts 引都行
export type { PlannedDeletion } from "./types";

/// 重启 Codex 的结果（与 Rust 的 RestartReport 一一对应）：结束了几个后台进程；桌面应用退出后重新打开了没有
/// （它自己拉起的后台进程随它一起退，`terminated` 可以是 0）
export type GatewayRestartReport = { terminated: number; pids: number[]; reopened: boolean };

export const api = {
  scanAll: () => invoke<Overview>("scan_all"),
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
  applyMcp: (planId: string, allowCrossDomain: boolean) =>
    invoke<McpReport>("apply_mcp", { planId, allowCrossDomain }),
  /// 从 agent 的配置里删掉 MCP 定义（单格或批量）：每项只删那个位置（locationId）里 name 的定义，
  /// 别处的同名定义不动。拿不掉的以 skipped + 原因回来；一批一个撤销（`undoId`），交给 `mcpUndoWrite`
  deleteMcpOriginal: (items: McpRemoveItem[]) =>
    invoke<McpReport>("delete_mcp_original", { items }),
  /// 撤销一次 MCP 写入；id 不存在或已过期时 reject「撤销记录不存在或已过期」
  mcpUndoWrite: (undoId: string) => invoke<McpUndoReport>("mcp_undo_write", { undoId }),
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
  gatewayState: () => invoke<GatewayState>("gateway_state"),
  // ----- 网关按家各管（spec 2026-09-29 R39、R40）：带 agent 的命令只动这一家；`sync` / `alsoOther` 决定另一家跟不跟 -----
  /** id 省略是新建；key 省略表示不动已存的密钥，带了就先向网关校验。
   *  `sync`：另一家同一地址的网关一起加 / 一起改（新建时另一家已有同一地址的就不加第二份） */
  gatewayUpsertProvider: (input: {
    agent: GatewayAgent;
    id?: string;
    name?: string;
    baseUrl: string;
    key?: string;
    sync: boolean;
  }) => invoke<GatewayProviderSaved>("gateway_upsert_provider", input),
  /** 连同钥匙串里的密钥一起删，删了回不来：调用前先向用户确认。
   *  `alsoOther`：另一家同一地址的网关连同密钥一起删（另一家因此已选为空且开着则随之关掉） */
  gatewayRemoveProvider: (agent: GatewayAgent, id: string, alsoOther: boolean) =>
    invoke<GatewayState>("gateway_remove_provider", { agent, id, alsoOther }),
  /** 带过来：把 `from` 有、`agent` 没有同一地址的网关复制过来（模型全未选，密钥一并复制）；不联网、不确认 */
  gatewayCopyProviders: (agent: GatewayAgent, from: GatewayAgent) =>
    invoke<GatewayState>("gateway_copy_providers", { agent, from }),
  /** 失败时后端已把原因记到这个网关的 unreachable 上，再照常抛错 */
  gatewayFetchModels: (agent: GatewayAgent, providerId: string) =>
    invoke<GatewayState>("gateway_fetch_models", { agent, providerId }),
  /** 「再试一次」：按 id 重拉这个网关。拉取本身失败（auth / network）不抛错——原因已记在
   *  它的 unreachable 上，返回最新状态让那一行显示「无法连接」；其余错误照常抛 */
  gatewayRetryProvider: async (agent: GatewayAgent, providerId: string): Promise<GatewayState> => {
    try {
      return await invoke<GatewayState>("gateway_fetch_models", { agent, providerId });
    } catch (error) {
      if (/^\[(auth|network)\] /.test(String(error))) {
        return invoke<GatewayState>("gateway_state");
      }
      throw error;
    }
  },
  /** 这一家这个网关的完整勾选，不影响别的网关与另一家 */
  gatewaySelectModels: (
    agent: GatewayAgent,
    providerId: string,
    selected: GatewaySelectedModel[],
  ) => invoke<GatewayState>("gateway_select_models", { agent, providerId, selected }),
  /** 打开这一家。Claude：桌面应用不在运行时当场写，在运行时只记下（desktop.pending） */
  gatewayEnable: (agent: GatewayAgent) => invoke<GatewayState>("gateway_enable", { agent }),
  /** 关掉这一家（Claude：切回账号；在运行时只记下） */
  gatewayRestore: (agent: GatewayAgent) => invoke<GatewayState>("gateway_restore", { agent }),
  /** 接管别家的生效配置（Codex：agents-manager；Claude：别的工具写进桌面应用的第三方配置） */
  gatewayTakeover: (agent: GatewayAgent) => invoke<GatewayState>("gateway_takeover", { agent }),
  /** 打开 Claude 桌面应用：有待生效的先写（写失败不打开），再等它在运行（上限 20 秒） */
  gatewayLaunchClaude: () => invoke<GatewayState>("gateway_launch_claude"),
  /** 重启 Claude 桌面应用让改动生效：退出（最多 15 秒，没退出是 desktop_busy、什么都不写）→ 写 → 重新打开。
   *  会打断正在用的桌面应用，调用前先向用户确认 */
  gatewayRestartClaude: () => invoke<GatewayState>("gateway_restart_claude"),
  /// 重启我们自己装的 launchd 路由服务；不重启 Codex。界面上不给按钮，命令留着
  gatewayRestart: () => invoke<GatewayState>("gateway_restart"),
  /// 结束 Codex 的后台进程，下次启动才读到新配置；terminated 为 0 表示 Codex 当时没在跑
  gatewayRestartCodex: () => invoke<GatewayRestartReport>("gateway_restart_codex"),
  /** 勾上一个模型之前试调用一次（发一条极短的请求，不写任何东西）；调不通时抛出原因 */
  gatewayProbeModel: (agent: GatewayAgent, providerId: string, modelId: string) =>
    invoke<void>("gateway_probe_model", { agent, providerId, modelId }),
  /// 按应用标识打开 Codex 桌面应用；只发出请求，等它起来要自己轮询 `codex.running`
  gatewayLaunchCodex: () => invoke<void>("gateway_launch_codex"),
  /// 菜单栏面板用：把主窗口带到前面；`page` 给了就切过去，`error` 给了就在那一页上说
  trayOpenMain: (page: "models" | "settings" | null, error: string | null) =>
    invoke<void>("tray_open_main", { page, error }),
  /// 面板高度由内容决定：量好了报给后端去调窗口
  traySetHeight: (height: number) => invoke<void>("tray_set_height", { height }),
  trayHide: () => invoke<void>("tray_hide"),
  trayQuit: () => invoke<void>("tray_quit"),
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
  /// 介绍页正文；取不到时抛错，界面写 `现在取不到说明`。只走 raw，不占 GitHub 接口次数。
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
  /// 设置 `skill 更新` 一节
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
  /// 存用量设置，调度与菜单栏立即生效；菜单栏最多 3 个 agent，超了报错
  usageSetSettings: (settings: UsageSettings) => invoke<void>("usage_set_settings", { settings }),
  /// 手动刷新（agent 为空刷全部），仍受最短间隔与限流约束
  usageRefresh: (agent: UsageAgentId | null) => invoke<void>("usage_refresh", { agent }),
};
