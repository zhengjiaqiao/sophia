import { mcpLocationSentence } from "./mcpView.ts";
import type { McpDiff, McpFieldValue, McpIssue, McpLocation } from "./types.ts";

/// MCP「N 份不一样」那一段的表（issue #114，画板 #105 第七稿第 2 节）：行优先，一行一份。
/// 纯数据，不碰 api、不画东西；画法在 `McpDiffPanel`（差异表 `DiffTable`）

export interface McpDiffTableRow {
  /// 位置 id
  id: string;
  /// 与 `McpDiffTable.fields` 同序
  values: McpFieldValue[];
  /// 「保留这份」做不成时挡住它的那一处与原因；null＝做得成
  blocked: McpIssue | null;
}

export interface McpDiffTable {
  /// 不一样的字段（「原件」列不在这里，由面板放在最前）
  fields: string[];
  rows: McpDiffTableRow[];
  /// 行尾「保留这份」出不出：读得出来的至少两份（只剩一份没什么可统一的）
  keep: boolean;
}

/// 差异 → 行优先的表：读得出来的每一处一行（读不出来的不成行，由面板另写一句灰字），列是不一样的字段
export function mcpDiffTable(diff: McpDiff): McpDiffTable {
  const unreadable = new Set(diff.unreadable);
  const rows = diff.locationIds.flatMap((id, i) =>
    unreadable.has(id)
      ? []
      : [
          {
            id,
            values: diff.fields.map((field) => field.values[i]),
            blocked: diff.keepBlocked?.[i] ?? null,
          },
        ],
  );
  return { fields: diff.fields.map((field) => field.field), rows, keep: rows.length >= 2 };
}

/// 表里与确认框里的一份叫什么：`用户级 · Claude Code`、`sophia · Claude Code 团队共享`。
/// 用户级只有一格 Claude Code，不写仅自己；项目里 Claude Code 两格要分开说
export function mcpCopyName(
  place: string,
  location: Pick<McpLocation, "id" | "label" | "harnessId" | "domain">,
): string {
  const agent =
    location.domain === "global" ? location.label.split(" · ")[0] : mcpLocationSentence(location);
  return `${place} · ${agent}`;
}

/// 表格「配置文件」列里的值（spec #239 第 41 条，画板第 8 屏）：与确认框、挑选浮层同一套名字，只是用户级不写
/// `用户级 ·`——`Claude Code`、`CardBox · Claude Code 团队共享`。完整路径在悬停、抽屉与右键菜单里
export function mcpOriginName(
  place: string,
  location: Pick<McpLocation, "id" | "label" | "harnessId" | "domain">,
): string {
  return location.domain === "global"
    ? location.label.split(" · ")[0]
    : mcpCopyName(place, location);
}
