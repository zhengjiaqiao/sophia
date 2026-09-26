import { presentView, viewOf, type McpCellView, type McpDotState } from "./mcpCellState.ts";
import { shortPath } from "./pathText.ts";
import type { McpDiff, McpEntry, McpFieldValue, McpLocation, McpOverview } from "./types.ts";

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
 * 一行在一列上的圆点。同名服务合并成一行后，这一列上每个来源各有一个格，要合成一个圆点：
 * - 这一列自己有一份定义（它是本行的来源 `mcpGroupOf`，或它自己的条目带 `own`，或别的来源看它是
 *   `equal` / `sameEndpoint` / `conflict`）：⦿、可点（点＝确认后从这个 agent 的配置里删掉）。
 *   是不是来源、和来源那份一不一样都不影响（DESIGN「MCP 格子只有两种：⦿ 有、○ 没有」）——
 *   差异是行级事实，交给 `differingSourceIds` 做成 `2 份不一样`
 * - 再看「这儿还没有」，最后才是两种不可点的异常
 */
export function cellViewOf(
  row: McpDomainRow,
  targetId: string,
  labelOf: (locationId: string) => string,
): McpCellView | null {
  const cells = row.entries.flatMap((entry) => {
    const cell = entry.cells.find((candidate) => candidate.targetId === targetId);
    return cell === undefined
      ? []
      : [
          {
            sourceId: entry.sourceId,
            state: cell.state,
            // 只有几家接得住的条目：搬不过去按目标 agent 判断，原因用 core 给这一格的那句
            cellReason:
              entry.onlyHarnesses !== undefined && cell.reason !== null ? cell.reason : undefined,
          },
        ];
  });
  // 无格态：这一行在这一列没有格，例如来源属于另一个域
  if (cells.length === 0) return null;
  const ctx = {
    service: row.name,
    location: labelOf(targetId),
    source: labelOf(mcpGroupOf(row)),
  };
  const holds = cells.some(
    (cell) =>
      cell.state === "own" ||
      cell.state === "equal" ||
      cell.state === "sameEndpoint" ||
      cell.state === "conflict",
  );
  if (targetId === mcpGroupOf(row) || holds) return presentView();
  // 剩下的这一列上都还没有定义；conflict 已在上面摘掉，类型上也进不了 viewOf
  const dots = cells.filter(
    (cell): cell is (typeof cells)[number] & { state: McpDotState } => cell.state !== "conflict",
  );
  const pick = (...states: McpDotState[]) => dots.find((cell) => states.includes(cell.state));
  const found = pick("missing") ?? pick("invalid", "unsupported");
  if (found === undefined) return null;
  return viewOf(found.state, {
    ...ctx,
    source: labelOf(found.sourceId),
    cellReason: found.cellReason,
  });
}

/**
 * 本行在本域里互不一致的那几处副本（spec R2）。返回位置 id，顺序按行内出现的先后。
 * 非空即在服务名后挂纯文字记号「N 份不一样」，点它拉开这一行的抽屉看差异。
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

/// 域名：用户级 / 项目 · <目录名>。侧栏、导入页、跨域说明共用这一份
export const mcpDomainLabel = (key: string): string => {
  if (key === "global") return "用户级";
  const path = key.startsWith("project:") ? key.slice("project:".length) : key;
  return `项目 · ${path.split(/[\\/]/).filter(Boolean).pop() ?? path}`;
};

const weiboAgentLabel = (key: string): string => {
  const path = key.startsWith("project:") ? key.slice("project:".length) : key;
  return `WeiboAP · ${path.split(/[\\/]/).filter(Boolean).pop() ?? path}`;
};

const hasMissingTarget = (entry: McpEntry, targetIds: Set<string>) =>
  entry.cells.some((cell) => targetIds.has(cell.targetId) && cell.state === "missing");

/** 已在本域部分导入的来源，仍可向选中的缺失目标补齐。 */
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
 * 多个能补齐的来源只有在扫描已证明完全等价时才自动使用；否则要求从导入弹窗选来源。
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

/**
 * 一个缺失格上能写的几份同名定义里**互不等价**的那几份（等价的只留第一份，顺序按行内先后）。
 * 多于一份就不替用户挑，点格出挑选浮层（DESIGN「MCP 同名多份时就地挑一份写进去」）。
 */
export function pickChoices(row: McpDomainRow, targetId: string): McpEntry[] {
  const out: McpEntry[] = [];
  for (const entry of supplementSourcesForTarget(row, targetId)) {
    if (!out.some((kept) => equivalent(kept, entry))) out.push(entry);
  }
  return out;
}

/// 挑选浮层的标题
export const pickTitle = (name: string, count: number): string =>
  `${name} 有 ${count} 份不一样的，写进哪一份？`;

/// 这种格的提示框
export const pickTip = (name: string, count: number): string =>
  `有 ${count} 份不一样的同名 ${name} · 点一下挑一份`;

const sameValue = (a: McpFieldValue, b: McpFieldValue) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 挑选浮层里一项的差异摘要：这一份与其他几份差在哪几个字段（`url 不同`，字段名写法同「只标差异」）。
 * 只列这一份独有的值；两份时就是全部不同的字段。三份以上一个独有的都没有（每个值都和另一份撞上），
 * 退回列出全部不同的字段。只给字段名，令牌、密钥的值一概不出现。
 */
export function pickDiffText(diff: McpDiff | null, sourceId: string): string {
  const fallback = diff?.dynamicAuth ? "认证头要到运行时才生成，无法逐字比对" : "配置不一样";
  if (diff === null) return fallback;
  const index = diff.locationIds.indexOf(sourceId);
  if (index < 0 || diff.unreadable.includes(sourceId)) return fallback;
  const readable = diff.locationIds
    .map((id, i) => ({ id, i }))
    .filter(({ id, i }) => i !== index && !diff.unreadable.includes(id))
    .map(({ i }) => i);
  const own = diff.fields
    .filter((f) => readable.every((i) => !sameValue(f.values[i], f.values[index])))
    .map((f) => f.field);
  const fields = own.length > 0 ? own : diff.fields.map((f) => f.field);
  return fields.length > 0 ? `${fields.join("、")} 不同` : fallback;
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
/// 行＝本域自己位置里的服务 ∪ 本域订阅着的别处来源（`overview.subscribed`）的**全部**服务；
/// 同名时自己的那份排在前面（来源列写它）。格只留本域的列
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
    const subscribed = new Set(overview.subscribed?.[key] ?? []);
    const own = overview.entries.filter((entry) => targetIds.has(entry.sourceId));
    const foreign = overview.entries.filter((entry) => subscribed.has(entry.sourceId));
    return {
      key,
      label: targets.some((target) => target.harnessId === "weiboap")
        ? weiboAgentLabel(key)
        : mcpDomainLabel(key),
      targets,
      rows: domainRows(
        [...own, ...foreign].map((entry) => ({
          ...entry,
          cells: entry.cells.filter((cell) => targetIds.has(cell.targetId)),
        })),
      ),
    };
  });
}

/**
 * 本行几份副本在**哪些字段**上不一样，给主视图 `2 份不一样` 的提示框用（DESIGN「材料与工艺」
 * MCP 两份不一样：提示框给差异字段名，`url 不同`）。
 *
 * 数据只来自现有扫描：core 在 conflict 格上给的 reason 只分两种——`URL 不同`（能确定是 url）
 * 和 `同名配置不同`（不知道是哪个字段）。后者返回空数组，调用方写「配置不一样」。
 * TODO(T3b)：core 给出字段级差异后，这里换成真实字段名列表。
 */
export function differingFields(row: McpDomainRow, targetIds: Set<string>): string[] {
  const fields = new Set<string>();
  let unknown = false;
  for (const entry of row.entries) {
    for (const cell of entry.cells) {
      if (cell.state !== "conflict" || !targetIds.has(cell.targetId)) continue;
      if (cell.reason === "URL 不同") fields.add("url");
      else unknown = true;
    }
  }
  // 有一处说不清是哪个字段，就不能只报 url——那等于说其余都一样
  return unknown ? [] : [...fields];
}

/// 行的来源位置（「来源」列写它）：第一份定义所在的位置（扫描按位置顺序产出条目，第一份就是「原件」那一格）
export const mcpGroupOf = (row: McpDomainRow): string => row.entries[0]?.sourceId ?? "";

// ===== 多位置（spec 2026-09-26-object-first-navigation R6 R7）=====
// 范围里可能不止一个位置（`全部` = 用户级 + 选中的项目）。每个位置一页（`McpDomain`），这里把几页并成一张表：
// 行带上自己的位置（同一个服务在两处就是两行），列按「agent + 是不是 Local」归并。
// 位置 id 与 core 同一写法：用户级 `<harness>`，项目 `project:<路径>::<harness>`（Claude Code 的 Local 是
// `::claude-code:local`），所以 id 的末段就是列：用户级的 User 与项目的 Project 同一列，Local 只有项目才有

/// 位置 id → 它归到哪一列
export function mcpColumnOf(locationId: string): string {
  const at = locationId.lastIndexOf("::");
  return at < 0 ? locationId : locationId.slice(at + 2);
}

/// 行键：位置 + 服务名（同名服务在一个位置里合成一行）
export const mcpRowKey = (domainKey: string, name: string) => `${domainKey}|${name}`;

export interface McpPlacedRow extends McpDomainRow {
  domainKey: string;
}

export interface McpColumn {
  /// 列 id：位置 id 的末段（`claude-code` / `claude-code:local` / `codex`）
  id: string;
  harnessId: string;
  /// 列头：位置名里 agent 那一段
  name: string;
  /// 列头第二行：同一个 agent 有两列（Local / Project）时才有，经 `Cap` 显示为 `LOCAL` / `PROJECT`；
  /// 一列里混着用户级的 User 与项目的 Project 时不写
  scope?: string;
  /// 列在句子里的名字（提示框、提示条、读屏）：`Claude Code local` / `Codex`
  sentence: string;
  /// 列头提示框与选择行用的名字：只有一个位置时是那个位置名（`Claude Code · Local MCPs`），否则同 `sentence`
  label: string;
  /// 位置 key → 这一列在那个位置的配置位置
  targets: Map<string, McpLocation>;
}

export interface McpTable {
  /// 并进来的各页（按范围的次序）
  pages: McpDomain[];
  /// 位置 key → 位置列里写的名字；只有一个位置时是空的（不出位置列）
  places: Map<string, string>;
  columns: McpColumn[];
  rows: McpPlacedRow[];
}

/// 位置名：用户级 / 项目文件夹名（`添加 MCP 来源到 CardBox`）；WeiboAP agent 沿用侧栏的名字
export const mcpPlaceName = (page: McpDomain): string =>
  page.key === "global"
    ? "用户级"
    : page.targets.some((t) => t.harnessId === "weiboap")
      ? page.label
      : (page.key
          .replace(/^project:/, "")
          .split(/[/\\]+/)
          .filter(Boolean)
          .pop() ?? page.label);

const headOf = (l: McpLocation) => l.label.split(" · ")[0];
const scopeOf = (l: McpLocation) =>
  l.label
    .split(" · ")[1]
    ?.replace(/ MCPs$/, "")
    .toLowerCase();

export function mergeMcpDomains(pages: ReadonlyArray<McpDomain>): McpTable {
  const byId = new Map<string, Omit<McpColumn, "scope" | "sentence" | "label">>();
  for (const page of pages) {
    for (const target of page.targets) {
      const id = mcpColumnOf(target.id);
      const col = byId.get(id) ?? {
        id,
        harnessId: target.harnessId,
        name: headOf(target),
        targets: new Map<string, McpLocation>(),
      };
      col.targets.set(page.key, target);
      byId.set(id, col);
    }
  }
  const raw = [...byId.values()];
  const columns = raw.map((col): McpColumn => {
    const clash = raw.filter((other) => other.name === col.name).length > 1;
    const scopes = new Set([...col.targets.values()].map(scopeOf));
    const scope = clash && scopes.size === 1 ? [...scopes][0] : undefined;
    const sentence = scope ? `${col.name} ${scope}` : col.name;
    const only = col.targets.size === 1 ? [...col.targets.values()][0] : undefined;
    return { ...col, scope, sentence, label: only?.label ?? sentence };
  });
  const places = new Map<string, string>();
  if (pages.length > 1) {
    const names = pages.map(mcpPlaceName);
    pages.forEach((page, i) => {
      const dup = names.filter((n) => n === names[i]).length > 1 && page.key !== "global";
      places.set(
        page.key,
        dup ? `${names[i]} · ${shortPath(page.key.replace(/^project:/, ""))}` : names[i],
      );
    });
  }
  return {
    pages: [...pages],
    places,
    columns,
    rows: pages.flatMap((page) => page.rows.map((row) => ({ ...row, domainKey: page.key }))),
  };
}
