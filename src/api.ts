import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  DomainInfo,
  HarnessStatus,
  Overview,
  PlannedAction,
  RowRef,
  SyncReport,
  SyncRule,
} from "./types";

export const api = {
  listDomains: () => invoke<DomainInfo[]>("list_domains"),
  scanAll: () => invoke<Overview>("scan_all"),
  /// 选中行在各自域的目标上缺失的格 → 建链动作
  proposeLinks: (rows: RowRef[]) => invoke<PlannedAction[]>("propose_links", { rows }),
  /// 选中行在各自域的目标上已链接的格 → 删链动作
  proposeUnlinks: (rows: RowRef[]) => invoke<PlannedAction[]>("propose_unlinks", { rows }),
  applyAll: (actions: PlannedAction[], cleanBroken: boolean) =>
    invoke<SyncReport>("apply_all", { actions, cleanBroken }),
  splitWholeLink: (targetId: string) => invoke<SyncReport>("split_whole_link", { targetId }),
  listManualSources: () => invoke<string[]>("list_manual_sources"),
  addManualSource: (path: string) => invoke<void>("add_manual_source", { path }),
  removeManualSource: (path: string) => invoke<void>("remove_manual_source", { path }),
  listManualProjects: () => invoke<string[]>("list_manual_projects"),
  addProject: (path: string) => invoke<void>("add_project", { path }),
  removeProject: (path: string) => invoke<void>("remove_project", { path }),
  listRules: () => invoke<SyncRule[]>("list_rules"),
  saveRules: (rules: SyncRule[]) => invoke<void>("save_rules", { rules }),
  planRule: (rule: SyncRule) => invoke<PlannedAction[]>("plan_rule", { rule }),
  applyRule: (actions: PlannedAction[], cleanBroken: boolean) =>
    invoke<SyncReport>("apply_rule", { actions, cleanBroken }),
  listSourceItems: (source: string) => invoke<string[]>("list_source_items", { source }),
  listHarnesses: () => invoke<HarnessStatus[]>("list_harnesses"),
  setHarnessEnabled: (id: string, enabled: boolean) =>
    invoke<void>("set_harness_enabled", { id, enabled }),
  /// 系统目录选择框；取消返回 null
  pickDirectory: async (title: string): Promise<string | null> => {
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  },
};
