import {
  copyView,
  differentCopiesMessage,
  viewOf,
  type McpCellView,
  type McpDotState,
  type McpIssueKind,
} from "./mcpCellState.ts";
import { issueKey } from "./issues.ts";
import type {
  McpDiff,
  McpEntry,
  McpFieldValue,
  McpLocation,
  McpOverview,
  McpReportEntry,
} from "./types.ts";

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
 * - 这一列就是本行的来源（`mcpGroupOf`，「来源」列写的那一处）：原件环，不能点
 * - 这一列自己也有一份定义（它自己的条目带 `own`，或别的来源看它是 `equal` / `sameEndpoint` /
 *   `conflict`）：副本，实心、可点（点＝从这个位置移除）。和来源那份一不一样不影响能不能移除——
 *   差异是行级事实，交给 `differingSourceIds` 做成 `2 份不一样`；移除一份不一样的副本才给撤销
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
  if (targetId === mcpGroupOf(row)) return viewOf("own", ctx);
  const holds = cells.some(
    (cell) =>
      cell.state === "own" ||
      cell.state === "equal" ||
      cell.state === "sameEndpoint" ||
      cell.state === "conflict",
  );
  if (holds) return copyView();
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
 * 非空即在服务名后挂「N 份不一样」，可点就地展开差异。
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

/// 域名：全局 / 项目 · <目录名>。侧栏、导入页、跨域说明共用这一份
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

/**
 * 一次写进 / 移除的结果提示条给不给 `撤销`（DESIGN「撤销按钮与 skill 同一条规则」）：
 * 再点一次格子、再按一次同一个键就是准确反操作时不给（`⌘Z` 始终可用，不看这里）。
 * - `reversible`：再按一次恰好撤回——单格一律是；批量写进时选中的里原本一份副本都没有才是
 * - 移除了一份**与来源原版不一样**的副本（`identical === false`）：再点只能写回原版，
 *   改过的内容回不来，只有撤销（从快照原样还原）是准确的退路
 */
export function mcpUndoShown(
  op: "write" | "remove",
  entries: McpReportEntry[],
  reversible: boolean,
): boolean {
  if (!reversible) return true;
  return op === "remove" && entries.some((e) => e.outcome === "removed" && e.identical === false);
}

/// 行的来源位置（「来源」列写它）：第一份定义所在的位置（扫描按位置顺序产出条目，第一份就是「原件」那一格）
export const mcpGroupOf = (row: McpDomainRow): string => row.entries[0]?.sourceId ?? "";

/**
 * MCP 的一条「要你拿主意」的问题。它就地显示在那一行、那一格上；这里只给新问题的一次性提示
 * 认出有哪几条（DESIGN「没有收件箱、待处理页和「忽略」」）。
 *
 * 形状：
 * - `kind`：`differentCopies`（几个位置各有一份同名定义、内容不一样）/ `invalidLocation`
 *   （某个位置的配置文件、或其中一条这次读不出来）
 * - `key`：与 core `store::issue_key` 同公式（`issueKey(kind, paths)`），拿它比对看过的列表
 * - `title`：一句完整的话（行视角），直接显示
 * - `detailFields?`：只给 differentCopies——已知不一样的字段名（`["url"]`）；缺省＝说不清是哪个字段
 * - `locations`：涉及的位置（id / 位置名 / 配置文件路径），顺序即行内出现的先后
 * - `name`：服务名；位置整份读不出来时为 null
 * - `domain`：所在域的 key（`global` / `project:<路径>`），「查看」切侧栏用
 * - `paths`：涉及的位置；key 就是由它算的
 */
export interface McpIssueItem {
  kind: McpIssueKind;
  key: string;
  title: string;
  detailFields?: string[];
  locations: { id: string; label: string; path: string }[];
  name: string | null;
  domain: string;
  paths: string[];
}

/**
 * 收出 MCP 页要用户拿主意的事：读不出来的位置 / 条目，以及两份不一样的同名服务。
 *
 * `opts.domains` 只看这几个域；不给看全部。
 */
export function collectMcpIssues(
  overview: McpOverview | null,
  opts: { domains?: string[] } = {},
): McpIssueItem[] {
  if (overview === null) return [];
  const want = (domain: string) => opts.domains === undefined || opts.domains.includes(domain);
  const locationOf = (id: string) => overview.locations.find((l) => l.id === id);
  const refOf = (id: string) => {
    const l = locationOf(id);
    return { id, label: l?.label ?? id, path: l?.path ?? id };
  };
  const out: McpIssueItem[] = [];

  for (const issue of overview.issues) {
    const location = locationOf(issue.locationId);
    if (location === undefined || !want(location.domain)) continue;
    // key 必须和 core 的 store::issue_key 同源；条目名并进标识里，否则同一个文件里
    // 两条不同名的问题会算出同一个 key，看过一条就把另一条也吞了
    // 用加号拼而不是模板串：上面两处带反斜杠的模板串会让 lint-ui 的取文案正则配错对
    const ident = issue.name === null ? location.path : location.path + "#" + issue.name;
    out.push({
      kind: "invalidLocation",
      key: issueKey("invalidLocation", [ident]),
      title:
        issue.name === null
          ? (viewOf("invalid", { service: "", location: location.label, source: "" }).reason ?? "")
          : location.label + " 里的 " + issue.name + " 这次无法读取：" + issue.message,
      locations: [refOf(location.id)],
      name: issue.name,
      domain: location.domain,
      paths: [ident],
    });
  }

  for (const page of mcpDomains(overview)) {
    if (!want(page.key)) continue;
    const targetIds = new Set(page.targets.map((target) => target.id));
    for (const row of page.rows) {
      const ids = differingSourceIds(row, targetIds);
      if (ids.length === 0) continue;
      // 同上：与 core 同源。服务名并进去，否则同一组位置上的两个服务会撞 key
      const paths = [...ids.map((id) => locationOf(id)?.path ?? id), "#" + row.name];
      const fields = differingFields(row, targetIds);
      out.push({
        kind: "differentCopies",
        key: issueKey("differentCopies", paths),
        title: differentCopiesMessage(
          row.name,
          ids.map((id) => refOf(id).label),
        ),
        detailFields: fields.length > 0 ? fields : undefined,
        locations: ids.map(refOf),
        name: row.name,
        domain: page.key,
        paths,
      });
    }
  }

  return out;
}
