import type { McpCellState, McpEntry, McpLocation, McpOverview } from "./types.ts";

export interface McpDomainRow {
  name: string;
  /** 同名服务的每一个真实来源；不能用任意一个来源掩盖其余状态。 */
  entries: McpEntry[];
}

export interface McpDomain {
  key: string;
  label: string;
  targets: McpLocation[];
  rows: McpDomainRow[];
}

export type McpCellSummary = {
  text: string;
  className: "own" | "equal" | "same-endpoint" | "conflict" | "invalid" | "unsupported" | "missing";
  defined: boolean;
};

/** 将同名来源在一个目标上的状态聚合为可读摘要；已确认的定义优先于不可比较的副本。 */
export function summarizeMcpCell(states: McpCellState[]): McpCellSummary {
  if (states.includes("conflict")) return { text: "差异", className: "conflict", defined: true };
  if (states.includes("sameEndpoint") || states.includes("equal") || states.includes("own")) {
    return { text: "已配置", className: "own", defined: true };
  }
  if (states.includes("invalid")) return { text: "配置无效", className: "invalid", defined: false };
  if (states.includes("unsupported")) {
    return { text: "格式不支持", className: "unsupported", defined: false };
  }
  return { text: "缺失", className: "missing", defined: false };
}

const domainLabel = (key: string): string => {
  if (key === "global") return "全局";
  const path = key.startsWith("project:") ? key.slice("project:".length) : key;
  return `项目 · ${path.split(/[\\/]/).filter(Boolean).pop() ?? path}`;
};

const weiboAgentLabel = (key: string): string => {
  const path = key.startsWith("project:") ? key.slice("project:".length) : key;
  return `WeiboAP · ${path.split(/[\\/]/).filter(Boolean).pop() ?? path}`;
};

const hasMissingTarget = (entry: McpEntry, targetIds: Set<string>) =>
  entry.cells.some((cell) => targetIds.has(cell.targetId) && cell.state === "missing");

/** 已在本域部分引入的来源，仍可向选中的缺失目标补齐。 */
export const canSupplement = (entry: McpEntry, targetIds: Set<string>) =>
  entry.reason === null && entry.transport !== "unsupported" && hasMissingTarget(entry, targetIds);

/** 指定目标上可安全迁移的来源。动态 helper/不支持的同名副本不在候选内。 */
export const supplementSourcesForTarget = (row: McpDomainRow, targetId: string) =>
  row.entries.filter((entry) => canSupplement(entry, new Set([targetId])));

/// 扫描结果中两个来源彼此明确为 equal，才可把它们视为同一份定义。
const equivalent = (a: McpEntry, b: McpEntry): boolean => {
  const aToB = a.cells.find((cell) => cell.targetId === b.sourceId)?.state;
  const bToA = b.cells.find((cell) => cell.targetId === a.sourceId)?.state;
  return aToB === "equal" && bToA === "equal";
};

/**
 * 为主表“补齐”选择安全的明确来源。
 * 多个能补齐的来源只有在扫描已证明完全等价时才自动使用；否则要求从引入弹窗选来源。
 */
export function sourceForMissing(row: McpDomainRow, targets: McpLocation[]): McpEntry | null {
  const targetIds = new Set(targets.map((target) => target.id));
  const candidates = row.entries.filter((entry) => canSupplement(entry, targetIds));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const allEquivalent = candidates.every((entry, index) =>
    candidates.slice(index + 1).every((other) => equivalent(entry, other)),
  );
  if (allEquivalent) {
    return candidates[0];
  }
  return null;
}

/**
 * 为一个缺失格选择来源。只有该格上的多个可迁移来源定义不等价时才要求用户选源。
 */
export function sourceForMissingTarget(row: McpDomainRow, targetId: string): McpEntry | null {
  const candidates = supplementSourcesForTarget(row, targetId);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  return candidates.every((entry, index) =>
    candidates.slice(index + 1).every((other) => equivalent(entry, other)),
  )
    ? candidates[0]
    : null;
}

const domainRows = (entries: McpEntry[]): McpDomainRow[] => {
  const rows = new Map<string, McpDomainRow>();
  for (const entry of entries) {
    const row = rows.get(entry.name);
    if (row) row.entries.push(entry);
    else rows.set(entry.name, { name: entry.name, entries: [entry] });
  }
  return [...rows.values()];
};

/// 按配置域派生表格内容；同名服务合并为一行，但保留本域每个真实来源。
export function mcpDomains(overview: McpOverview): McpDomain[] {
  const locationsByDomain = new Map<string, McpLocation[]>();
  for (const location of overview.locations) {
    const locations = locationsByDomain.get(location.domain);
    if (locations) locations.push(location);
    else locationsByDomain.set(location.domain, [location]);
  }
  const keys = [...locationsByDomain.keys()].sort((a, b) =>
    a === "global" ? -1 : b === "global" ? 1 : 0,
  );
  return keys.map((key) => {
    const targets = (locationsByDomain.get(key) ?? []).filter((location) => !location.matrixHidden);
    const targetIds = new Set(targets.map((target) => target.id));
    return {
      key,
      label: targets.some((target) => target.harnessId === "weiboap")
        ? weiboAgentLabel(key)
        : domainLabel(key),
      targets,
      rows: domainRows(
        overview.entries
          .filter((entry) => targetIds.has(entry.sourceId))
          .map((entry) => ({
            ...entry,
            cells: entry.cells.filter((cell) => targetIds.has(cell.targetId)),
          })),
      ),
    };
  });
}

/// 本域任一配置位置已有相同定义时，服务已被引入该域。
export function importedInDomain(entry: McpEntry, page: McpDomain): boolean {
  const targetIds = new Set(page.targets.map((target) => target.id));
  return entry.cells.some(
    (cell) =>
      targetIds.has(cell.targetId) &&
      (cell.state === "own" || cell.state === "equal" || cell.state === "sameEndpoint"),
  );
}
