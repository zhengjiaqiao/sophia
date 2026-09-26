/// 项目列表（spec 2026-09-26-object-first-navigation R4 R10）：skill 与 MCP 两边自动发现的项目取并集，
/// 与当前在哪一页无关；按最近活跃 / 最近创建排序（项目筛选片与「更多」列表用）。项目只来自自动检测，没有手动添加的一路。
/// 纯逻辑，不碰 api、不产 JSX。用户级（`global`）不在列表里——它是范围滑槽的一档

import type { ProjectTimes } from "./types.ts";
import type { ScopeProject } from "./scopeView.ts";

export type ProjectSort = "active" | "created";

export const PROJECT_SORTS: ReadonlyArray<{ id: ProjectSort; label: string }> = [
  { id: "active", label: "最近活跃" },
  { id: "created", label: "最近创建" },
];

const PREFIX = "project:";

/// 路径末段当项目名
export const projectName = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/// 并集，先后是 skill 那边的首现顺序、再 MCP 独有的（排序前的次序，也是同一时间下的次序）。
/// 名字取 skill 那边的（agent 目录带显示名），没有再用 MCP 给的
export function unionProjects(
  skill: ReadonlyArray<{ key: string; label: string }>,
  mcp: ReadonlyArray<{ key: string; label: string }>,
): ScopeProject[] {
  const out: ScopeProject[] = [];
  const seen = new Set<string>();
  const add = (key: string, label: string) => {
    if (!key.startsWith(PREFIX) || seen.has(key)) return;
    seen.add(key);
    const path = key.slice(PREFIX.length);
    out.push({ key, label, path });
  };
  for (const d of skill) add(d.key, d.label);
  for (const d of mcp) add(d.key, d.label);
  return out;
}

/// 按所选时间从新到旧排；取不到时间的排最后，同一时间保持并集里的次序（Array.sort 稳定）
export function sortProjects(
  projects: ReadonlyArray<ScopeProject>,
  times: ReadonlyMap<string, ProjectTimes>,
  sort: ProjectSort,
): ScopeProject[] {
  const at = (p: ScopeProject): number | null => {
    const t = times.get(p.path);
    if (!t) return null;
    return sort === "active" ? t.lastActive : t.created;
  };
  return [...projects].sort((a, b) => {
    const x = at(a);
    const y = at(b);
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  });
}

const SORT_STORE = "sophia.sidebar.sort";

/// 上次选的排序；localStorage 不可用或存的不认识，就回到默认「最近活跃」
export function loadProjectSort(): ProjectSort {
  try {
    const raw = window.localStorage.getItem(SORT_STORE);
    return PROJECT_SORTS.some((s) => s.id === raw) ? (raw as ProjectSort) : "active";
  } catch {
    return "active";
  }
}

export function saveProjectSort(sort: ProjectSort) {
  try {
    window.localStorage.setItem(SORT_STORE, sort);
  } catch {
    // 存不下就下次回到默认，不打扰用户
  }
}
