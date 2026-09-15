import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  AutoLink,
  CellRef,
  HarnessStatus,
  Overview,
  PlannedAction,
  SyncReport,
  McpOverview,
  McpPreview,
  McpReport,
  McpSelection,
  McpAutoImportRule,
} from "./types";

export const api = {
  scanAll: () => invoke<Overview>("scan_all"),
  /// 这些格里缺失的 → 建链动作
  proposeLinks: (cells: CellRef[]) => invoke<PlannedAction[]>("propose_links", { cells }),
  /// 这些格里已链接且目标非整目录链接的 → 删链动作
  proposeUnlinks: (cells: CellRef[]) => invoke<PlannedAction[]>("propose_unlinks", { cells }),
  applyAll: (actions: PlannedAction[], cleanBroken: boolean) =>
    invoke<SyncReport>("apply_all", { actions, cleanBroken }),
  splitWholeLink: (targetId: string) => invoke<SyncReport>("split_whole_link", { targetId }),
  listManualSources: () => invoke<string[]>("list_manual_sources"),
  addManualSource: (path: string) => invoke<void>("add_manual_source", { path }),
  removeManualSource: (path: string) => invoke<void>("remove_manual_source", { path }),
  listManualProjects: () => invoke<string[]>("list_manual_projects"),
  addProject: (path: string) => invoke<void>("add_project", { path }),
  removeProject: (path: string) => invoke<void>("remove_project", { path }),
  listAutoLinks: () => invoke<AutoLink[]>("list_auto_links"),
  /// 新建或合并该本体位置的规则（目标取并集）
  setAutoLink: (source: string, targets: string[]) =>
    invoke<void>("set_auto_link", { source, targets }),
  removeAutoLink: (source: string) => invoke<void>("remove_auto_link", { source }),
  /// 只撤该规则的部分目标；目标去空则整条规则删除
  removeAutoLinkTargets: (source: string, targets: string[]) =>
    invoke<void>("remove_auto_link_targets", { source, targets }),
  /// 该 skill 不再自动链接（手动清除过）
  excludeAutoLink: (source: string, skill: string) =>
    invoke<void>("exclude_auto_link", { source, skill }),
  includeAutoLink: (source: string, skill: string) =>
    invoke<void>("include_auto_link", { source, skill }),
  listHarnesses: () => invoke<HarnessStatus[]>("list_harnesses"),
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
  proposeMcpSync: (selections: McpSelection[]) =>
    invoke<McpPreview>("propose_mcp_sync", { selections }),
  applyMcp: (planId: string, allowCrossDomain: boolean) =>
    invoke<McpReport>("apply_mcp", { planId, allowCrossDomain }),
  listMcpAutoImports: () => invoke<McpAutoImportRule[]>("list_mcp_auto_imports"),
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
};
