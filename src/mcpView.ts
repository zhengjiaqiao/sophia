import { viewOf, type McpCellView, type McpDotState } from "./mcpCellState.ts";
import type { McpEntry, McpLocation, McpOverview } from "./types.ts";

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

/**
 * 一行在一列上的圆点。同名服务合并成一行后，这一列上每个来源各有一个格，
 * 要合成一个圆点：先看「来源就是这一列」，再看「这儿也有一份一样的」，
 * 再看「这儿还没有」，最后才是两种不可点的异常。
 *
 * `conflict` 不参与（spec R2）：它说的是「这一列自己也持有同名条目」，
 * 而那一列自己的条目就在同一行里、带着 `own`，圆点由它画。差异是行级事实，
 * 交给 `differingSourceIds` 做成方标签。
 */
export function cellViewOf(
  row: McpDomainRow,
  targetId: string,
  labelOf: (locationId: string) => string,
): McpCellView | null {
  const cells = row.entries.flatMap((entry) => {
    const cell = entry.cells.find((candidate) => candidate.targetId === targetId);
    return cell === undefined ? [] : [{ sourceId: entry.sourceId, state: cell.state }];
  });
  // 无格态：这一行在这一列没有格，例如来源属于另一个域
  if (cells.length === 0) return null;
  // conflict 在这里就被摘掉，类型上也进不了 viewOf
  const dots = cells.filter(
    (cell): cell is { sourceId: string; state: McpDotState } => cell.state !== "conflict",
  );
  const pick = (...states: McpDotState[]) => dots.find((cell) => states.includes(cell.state));
  const found =
    pick("own") ??
    pick("equal", "sameEndpoint") ??
    pick("missing") ??
    pick("invalid", "unsupported");
  if (found === undefined) {
    // 只剩 conflict：说明这一列自己持有一份不一样的定义。扫描保证它自己那条
    // 带 own 的条目也在同一行里，走不到这儿；真走到了也照 own 画，别画成「还没有」
    return {
      dot: "own",
      clickable: false,
      reason: `${labelOf(targetId)} 里也有一份 ${row.name}，只是和别处那份不一样`,
      issue: "differentCopies",
    };
  }
  return viewOf(found.state, {
    service: row.name,
    location: labelOf(targetId),
    source: labelOf(found.sourceId),
  });
}

/**
 * 本行在本域里互不一致的那几处副本（spec R2）。返回位置 id，顺序按行内出现的先后。
 * 非空即在服务名后挂「N 份不一样」的方标签，并进待处理栏。
 */
export function differingSourceIds(row: McpDomainRow, targetIds: Set<string>): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  for (const entry of row.entries) {
    for (const cell of entry.cells) {
      if (cell.state !== "conflict" || !targetIds.has(cell.targetId)) continue;
      add(entry.sourceId);
      add(cell.targetId);
    }
  }
  return ids;
}

/// 域名：全局 / 项目 · <目录名>。侧栏、引入页、跨域说明共用这一份
export const mcpDomainLabel = (key: string): string => {
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
        : mcpDomainLabel(key),
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
