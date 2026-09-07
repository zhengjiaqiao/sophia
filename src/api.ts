import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  DomainInfo,
  HarnessStatus,
  Overview,
  PlannedAction,
  SyncReport,
  SyncRule,
} from "./types";

export const api = {
  listDomains: () => invoke<DomainInfo[]>("list_domains"),
  scanAll: () => invoke<Overview>("scan_all"),
  setPick: (targetIds: string[], sourceId: string, skill: string, enabled: boolean) =>
    invoke<void>("set_pick", { targetIds, sourceId, skill, enabled }),
  /// skills 传 null 表示引入全部
  importSource: (targetIds: string[], sourceId: string, skills: string[] | null) =>
    invoke<void>("import_source", { targetIds, sourceId, skills }),
  removeSource: (targetIds: string[], sourceId: string) =>
    invoke<void>("remove_source", { targetIds, sourceId }),
  proposeAll: () => invoke<PlannedAction[]>("propose_all"),
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
