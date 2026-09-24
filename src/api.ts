import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  AutoLink,
  CellRef,
  GatewayProviderSaved,
  GatewaySelectedModel,
  GatewayState,
  HarnessList,
  Overview,
  PlannedAction,
  PlannedDeletion,
  SourceList,
  SourceSummary,
  SourceRemoval,
  SyncReport,
  McpOverview,
  McpPreview,
  McpReport,
  McpUndoReport,
  McpSelection,
  McpDiff,
  McpEndpoint,
  McpRemovalItem,
  McpSourceList,
  McpSourceRemoval,
  ProjectTimes,
} from "./types";

// PlannedDeletion 定义在 types.ts（与 serde 一一对应）；
// 这里再导出一次，调用方从 api.ts 或 types.ts 引都行
export type { PlannedDeletion } from "./types";

/// 结束了几个 Codex 后台进程（与 Rust 的 RestartReport 一一对应）
export type GatewayRestartReport = { terminated: number; pids: number[] };

export const api = {
  scanAll: () => invoke<Overview>("scan_all"),
  /// 这些格里缺失的 → 建链动作
  proposeLinks: (cells: CellRef[]) => invoke<PlannedAction[]>("propose_links", { cells }),
  /// 这些格里已链接且目标非整目录链接的 → 删链动作
  proposeUnlinks: (cells: CellRef[]) => invoke<PlannedAction[]>("propose_unlinks", { cells }),
  applyAll: (actions: PlannedAction[], cleanBroken: boolean) =>
    invoke<SyncReport>("apply_all", { actions, cleanBroken }),
  splitWholeLink: (targetId: string) => invoke<SyncReport>("split_whole_link", { targetId }),
  /// 删本体前的只读体检；计划留在后端，前端拿到的只用来摆给用户确认
  planDeleteSource: (sourceId: string, skill: string) =>
    invoke<PlannedDeletion>("plan_delete_source", { sourceId, skill }),
  /// 执行用户已确认的删除计划；planId 用后即弃，不能重放
  deleteSource: (planId: string) => invoke<SyncReport>("delete_source", { planId }),
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
  /// 把这些问题记为看过（新问题只提示一次，看过即止）；已看过的保持原样。
  /// key 是字符串，两种格式互不相撞（core `store::SeenIssue` 是准）：
  /// - skill / MCP：`issues.ts › issueKey(kind, paths)`，即 `<IssueKind>\u001f<位置…>`
  /// - 模型：`model\u001f<类别>\u001f<细节…>`，段间都用 `\u001f`：
  ///   `model\u001ftakeover\u001f<baseUrl>`、`model\u001fconfigChanged\u001f<Codex 版本>`、
  ///   `model\u001funreachable\u001f<providerId>\u001f<原因>`
  markIssuesSeen: (keys: string[]) => invoke<void>("mark_issues_seen", { keys }),
  /// 看过的全部 key；不在里面的就是新问题
  listSeenIssues: () => invoke<string[]>("list_seen_issues"),
  listManualSources: () => invoke<string[]>("list_manual_sources"),
  addManualSource: (path: string) => invoke<void>("add_manual_source", { path }),
  removeManualSource: (path: string) => invoke<void>("remove_manual_source", { path }),
  listManualProjects: () => invoke<string[]>("list_manual_projects"),
  addProject: (path: string) => invoke<void>("add_project", { path }),
  removeProject: (path: string) => invoke<void>("remove_project", { path }),
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
  /// 系统目录选择框；取消返回 null
  pickDirectory: async (title: string): Promise<string | null> => {
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  },
  /// 在系统文件管理器里定位并选中该路径
  revealInDir: (path: string) => revealItemInDir(path),
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
  /// 从格子上移除 MCP 副本（可批量）：`sourceId` 是行的来源（原件），`targetId` 是副本所在位置。
  /// 原件那一格、单独拿不掉的写法等以 `skipped` + 原因返回；成功的条目带 `identical`，
  /// 撤销（`undoId`）交给 `mcpUndoWrite`
  removeMcpCopies: (selections: McpSelection[]) =>
    invoke<McpReport>("remove_mcp_copies", { selections }),
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
  /// key 为空表示不改密钥；带新密钥时后端先向网关校验
  gatewaySaveProvider: (baseUrl: string, key: string) =>
    invoke<GatewayState>("gateway_save_provider", { baseUrl, key }),
  gatewayFetchModels: () => invoke<GatewayState>("gateway_fetch_models"),
  gatewaySelectModels: (selected: GatewaySelectedModel[]) =>
    invoke<GatewayState>("gateway_select_models", { selected }),
  // ----- 多家网关：带 providerId 的版本。上面不带 id 的三个作用在第一家上，界面迁完后删 -----
  /** id 省略是新建；key 省略表示不动已存的密钥，带了就先向网关校验 */
  gatewayUpsertProvider: (input: { id?: string; name?: string; baseUrl: string; key?: string }) =>
    invoke<GatewayProviderSaved>("gateway_upsert_provider", input),
  /** 连同钥匙串里的密钥一起删，删了回不来：调用前先向用户确认 */
  gatewayRemoveProvider: (id: string) => invoke<GatewayState>("gateway_remove_provider", { id }),
  /** 失败时后端已把原因记到这一家的 unreachable 上，再照常抛错 */
  gatewayFetchModelsOf: (providerId: string) =>
    invoke<GatewayState>("gateway_fetch_models", { providerId }),
  /** 「再试一次」：按 id 重拉这一家。拉取本身失败（auth / network）不抛错——原因已记在
   *  这一家的 unreachable 上，返回最新状态让那一行显示「无法连接」；其余错误照常抛 */
  gatewayRetryProvider: async (providerId: string): Promise<GatewayState> => {
    try {
      return await invoke<GatewayState>("gateway_fetch_models", { providerId });
    } catch (error) {
      if (/^\[(auth|network)\] /.test(String(error))) {
        return invoke<GatewayState>("gateway_state");
      }
      throw error;
    }
  },
  gatewaySelectModelsOf: (providerId: string, selected: GatewaySelectedModel[]) =>
    invoke<GatewayState>("gateway_select_models", { providerId, selected }),
  gatewayEnable: () => invoke<GatewayState>("gateway_enable"),
  gatewayRestore: () => invoke<GatewayState>("gateway_restore"),
  /// 重启我们自己装的 launchd 路由服务；不重启 Codex。界面上不给按钮，命令留着
  gatewayRestart: () => invoke<GatewayState>("gateway_restart"),
  /// 结束 Codex 的后台进程，下次启动才读到新配置；terminated 为 0 表示 Codex 当时没在跑
  gatewayRestartCodex: () => invoke<GatewayRestartReport>("gateway_restart_codex"),
  /// 按应用标识打开 Codex 桌面应用；只发出请求，等它起来要自己轮询 `codex.running`
  gatewayLaunchCodex: () => invoke<void>("gateway_launch_codex"),
  /// 菜单栏面板用：把主窗口带到前面；`page` 给了就切过去，`error` 给了就在那一页上说
  trayOpenMain: (page: "models" | "settings" | null, error: string | null) =>
    invoke<void>("tray_open_main", { page, error }),
  /// 面板高度由内容决定：量好了报给后端去调窗口
  traySetHeight: (height: number) => invoke<void>("tray_set_height", { height }),
  trayHide: () => invoke<void>("tray_hide"),
  trayQuit: () => invoke<void>("tray_quit"),
  gatewayTakeover: () => invoke<GatewayState>("gateway_takeover"),
  /// 应用菜单里跟着界面灰 / 亮的三项（`撤销` `筛选` `返回`，DESIGN「应用菜单」）
  setMenuState: (state: { undo: boolean; filter: boolean; back: boolean }) =>
    invoke<void>("set_menu_state", { state }),
};
