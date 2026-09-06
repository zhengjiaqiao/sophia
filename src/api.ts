import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  Domain,
  DomainInfo,
  HarnessStatus,
  Matrix,
  PlannedAction,
  SyncReport,
  SyncRule,
} from "./types";

export const api = {
  listDomains: () => invoke<DomainInfo[]>("list_domains"),
  scanDomain: (domain: Domain) => invoke<Matrix>("scan_domain", { domain }),
  propose: (domain: Domain) => invoke<PlannedAction[]>("propose", { domain }),
  apply: (actions: PlannedAction[], cleanBroken: boolean, domain: Domain) =>
    invoke<SyncReport>("apply", { actions, cleanBroken, domain }),
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
