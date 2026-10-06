/// 设置「生效范围」一节的格子怎么分（spec 2026-10-05-skill-mcp-batch2「项目来源」）。纯逻辑，不碰 api、不产 JSX。
/// 用户级那一格一直在、不在这里；这里只分项目格

import type { ProjectScope } from "../types.ts";

export interface ScopeGroups {
  /// 上面的格子：勾着的，加上这一程刚取消勾的（留在原处，不一点就跳走）
  grid: ProjectScope[];
  /// 折进「不显示的 N 个」的：没勾的，展开后能勾回来
  folded: ProjectScope[];
}

/// 按 core 给的先后分两组。`kept`：这一程在上面取消勾的项目路径——格子留在原处、勾掉的样子，
/// 下次进设置才折进去（同「列表里的 agent」取消勾后行还在原处）
export function scopeGroups(
  projects: ReadonlyArray<ProjectScope>,
  kept: ReadonlySet<string>,
): ScopeGroups {
  const grid: ProjectScope[] = [];
  const folded: ProjectScope[] = [];
  for (const p of projects) (p.shown || kept.has(p.path) ? grid : folded).push(p);
  return { grid, folded };
}
