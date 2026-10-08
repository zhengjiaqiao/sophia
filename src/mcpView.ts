import { listText, t, tn } from "./i18n.ts";
import {
  presentView,
  unportableText,
  viewOf,
  type McpCellView,
  type McpDotState,
} from "./mcpCellState.ts";
import { shortPath } from "./pathText.ts";
import type { AppFault } from "./backendError.ts";
import type {
  McpCell,
  McpDiff,
  McpEntry,
  McpFieldValue,
  McpLocation,
  McpOverview,
  McpReasonKind,
  McpUndoFileResult,
  McpUndoReport,
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

/// core 在格上兜底的两种原因（`reasonKind`）：不说具体原因，由 `viewOf` 换成「用了只有 X 支持的写法」
const isGenericKind = (kind: McpReasonKind | undefined) =>
  kind === "sourceLossy" || kind === "targetLossy";

/**
 * 格上用 core 给这一格的原因：按目标 agent 判断的那句（`Cursor 不支持用命令生成请求头`、
 * `Claude Desktop 不展开 ${…} 这类变量`）比笼统的一句准。core 只给了兜底那两种时不用
 */
export const ownCellReason = (cell: McpCell): string | undefined =>
  cell.reason !== null && !isGenericKind(cell.reasonKind) ? cell.reason : undefined;

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
            cellReason: ownCellReason(cell),
            cellReasonKind: cell.reasonKind,
            unsupportedField: entry.unsupportedField,
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
    cellReasonKind: found.cellReason === undefined ? undefined : found.cellReasonKind,
    unsupportedField: found.unsupportedField,
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

/**
 * 行上 `N 份不一样` 的 N：卷进差异的那几处里有几种不一样的定义（评审 2026-10-07，#261）。一样的几处
 * （彼此的格是 equal / sameEndpoint）算一份：三处一样、只有一处不同是 2 份，不是 4 处
 */
export function differingCopies(row: McpDomainRow, targetIds: Set<string>): number {
  const ids = differingSourceIds(row, targetIds);
  const group = new Map(ids.map((id) => [id, id]));
  const root = (id: string): string => {
    const up = group.get(id) ?? id;
    return up === id ? id : root(up);
  };
  for (const entry of row.entries) {
    if (!group.has(entry.sourceId)) continue;
    for (const cell of entry.cells) {
      if (!group.has(cell.targetId)) continue;
      if (cell.state !== "equal" && cell.state !== "sameEndpoint") continue;
      group.set(root(entry.sourceId), root(cell.targetId));
    }
  }
  return new Set(ids.map(root)).size;
}

/// 域名：用户级 / 项目 · <目录名>。侧栏、导入页、跨域说明共用这一份
export const mcpDomainLabel = (key: string): string => {
  if (key === "global") return t("mcp.domain.user");
  const path = key.startsWith("project:") ? key.slice("project:".length) : key;
  return t("mcp.domain.project", { name: path.split(/[\\/]/).filter(Boolean).pop() ?? path });
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
  tn("mcp.pick.title", count, { name });

/// 这种格的提示框
export const pickTip = (name: string, count: number): string => tn("mcp.pick.tip", count, { name });

const sameValue = (a: McpFieldValue, b: McpFieldValue) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 挑选浮层里一项的差异摘要：这一份与其他几份差在哪几个字段（`url 不同`，字段名写法同「只标差异」）。
 * 只列这一份独有的值；两份时就是全部不同的字段。三份以上一个独有的都没有（每个值都和另一份撞上），
 * 退回列出全部不同的字段。只给字段名，令牌、密钥的值一概不出现。
 */
export function pickDiffText(diff: McpDiff | null, sourceId: string): string {
  const fallback = diff?.dynamicAuth ? t("mcp.pick.dynamicAuth") : t("mcp.pick.different");
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
  return fields.length > 0
    ? t("mcp.pick.fieldsDiffer", { fields: listText(fields, "enum") })
    : fallback;
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
 * 数据只来自现有扫描：core 在 conflict 格上给的 `reasonKind` 只分两种——`urlDiffers`（能确定是 url）
 * 和 `configDiffers`（不知道是哪个字段）。后者返回空数组，调用方写「配置不一样」。
 * TODO(T3b)：core 给出字段级差异后，这里换成真实字段名列表。
 */
export function differingFields(row: McpDomainRow, targetIds: Set<string>): string[] {
  const fields = new Set<string>();
  let unknown = false;
  for (const entry of row.entries) {
    for (const cell of entry.cells) {
      if (cell.state !== "conflict" || !targetIds.has(cell.targetId)) continue;
      if (cell.reasonKind === "urlDiffers") fields.add("url");
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
// 行带上自己的位置（同一个服务在两处就是两行），列按 agent 归并。
// 位置 id 与 core 同一写法：用户级 `<harness>`，项目 `project:<路径>::<harness>`（Claude Code 的 Local 是
// `::claude-code:local`），id 的末段就是列——只有 Claude Code 例外（spec 2026-09-30-mcp-claude-self-team R1）：
// 用户级的 User 与项目的 Local 都是「仅自己」（`claude-code`），项目的 `.mcp.json` 是「团队共享」（`claude-code:team`）

/// Claude Code 的「仅自己」列：用户级配置、项目的本地配置
export const CLAUDE_SELF = "claude-code";
/// Claude Code 的「团队共享」列：项目的 `.mcp.json`
export const CLAUDE_TEAM = "claude-code:team";

/// 位置 id → 它归到哪一列
export function mcpColumnOf(locationId: string): string {
  const at = locationId.lastIndexOf("::");
  const tail = at < 0 ? locationId : locationId.slice(at + 2);
  if (tail === "claude-code:local") return CLAUDE_SELF;
  if (tail === "claude-code" && at >= 0) return CLAUDE_TEAM;
  return tail;
}

/// 一个配置位置在句子里的名字（改生效范围的菜单与提示条、自动同步页）：Claude Code 分仅自己 / 团队共享
/// （同表格列头），别家写 agent 名（Claude Desktop 照界面语言说，见 `mcpAgentName`）
export function mcpLocationSentence(l: { id: string; label: string; harnessId: string }): string {
  if (l.harnessId === "claude-code") {
    const column = mcpColumnOf(l.id);
    if (column === CLAUDE_SELF) return t("mcp.claude.selfSentence", { agent: "Claude Code" });
    if (column === CLAUDE_TEAM) return t("mcp.claude.teamSentence", { agent: "Claude Code" });
  }
  return mcpAgentName(l);
}

/// 一个配置位置是哪个 agent（格子原因句、提示条的 agent 图标）：位置名里 agent 那一段（`Claude Code`），
/// 不带 core 给的英文作用域（`Claude Code · User MCPs`，spec #239 第 42 条）。Claude Desktop 在句子里
/// 简体叫「Claude 桌面应用」（spec #239 第 48 条）；列头仍是它自己的名字（`groupClaudeColumns`）
export const mcpAgentName = (l: { label: string; harnessId?: string }): string =>
  l.harnessId === "claude-desktop" ? t("common.term.claudeDesktop") : l.label.split(" · ")[0];

/// MCP 页命令本身出错（扫描、撤销、删除、拷贝路径、在访达中显示）交给窗口顶上横幅的一条：一句是该处的失败句
/// `sentence`，原文进「!」；后端已经分好两层的（`[code] 一句`）照它的一句（spec #239「错误怎么分两层」，#302）
export const mcpCommandFault = (error: unknown, sentence: string): AppFault => ({
  text: String(error),
  fallback: sentence,
});

/// 一条写入 / 删除结果在提示条里能说的原因：分不出原因的（core 给了原文 `detail`）不说，只写失败句（spec #239 第 43 条，
/// DESIGN「文案表达 › 出错的时候」）——`原子写入失败` 这类兜底句与系统原文不进提示条，原文已进日志
export const mcpEntryReason = (entry: { message: string; detail?: string }): string | undefined =>
  entry.detail === undefined && entry.message !== "" ? entry.message : undefined;

/// 撤销没撤成（`failed`）时提示条说什么（#320）。一次撤销涉及几个文件、前面几份已还原、到某一份停下时，
/// 说清哪几份已还原、哪几份没有：`已还原 用户级 · Claude Code，用户级 · Codex 的配置文件之后又被改过`；没还原成的那份
/// 说得出原因时接在后面（`… 未还原 · 没有写入权限`），分不出的不说（原文已进日志）。没还原的那几份的完整路径进副行
/// （`paths`，提示条的 `stats`）。一份都没还原的照旧只说那一份的原因、不带副行。
/// `placeOf`：文件路径 → 句子里的名字（`mcpUndoPlaceOf`）；认不出的（`.gitignore`）写文件名
export function mcpUndoFailure(
  report: McpUndoReport,
  placeOf: (path: string) => string | undefined,
): { reason?: string; paths: string[] } {
  const restored = report.files.filter((f) => f.outcome === "restored" || f.outcome === "removed");
  const stopped = report.files.find((f) => f.outcome === "failed" || f.outcome === "changed");
  if (restored.length === 0 || stopped === undefined)
    return { reason: mcpEntryReason(report), paths: [] };
  const skipped = report.files.filter((f) => f.outcome === "skipped");
  const fileName = (path: string) => path.split(/[/\\]/).pop() ?? path;
  // 按文件去重（同一个文件只说一次），不按名字：两处同名时各说各的
  const paths = (files: McpUndoFileResult[]) => [...new Set(files.map((f) => f.targetPath))];
  const names = (files: McpUndoFileResult[], config: boolean) =>
    listText(
      paths(files).map((path) => {
        const place = placeOf(path);
        if (place === undefined) return fileName(path);
        return config ? t("mcp.undo.configOf", { agent: place }) : place;
      }),
      "and",
    );
  const done = names(restored, false);
  const left = [stopped, ...skipped];
  if (stopped.outcome === "changed" && skipped.length === 0)
    return {
      reason: t("mcp.undo.partialChanged", {
        restored: done,
        changed: names([stopped], true),
      }),
      paths: paths(left),
    };
  const sentence = t("mcp.undo.partialFailed", { restored: done, failed: names(left, true) });
  const why = mcpEntryReason(stopped);
  return { reason: why === undefined ? sentence : `${sentence} · ${why}`, paths: paths(left) };
}

/// 撤销结果里的一个文件在句子里叫什么（`mcpUndoFailure`）：与表格同一套位置名（`copyName`，`用户级 · Codex`、
/// `sophia · Codex`），项目、用户级分得开；Claude 桌面应用第三方模式那一份（`mirrors`）写
/// `用户级 · Claude 桌面应用（第三方模型）`。不是哪个位置的（`.gitignore`）为 undefined
export function mcpUndoPlaceOf(
  locations: readonly McpLocation[],
  copyName: (location: McpLocation) => string,
): (path: string) => string | undefined {
  return (path) => {
    const own = locations.find((l) => l.path === path);
    if (own) return copyName(own);
    const mirrored = locations.find((l) => l.mirrors?.includes(path));
    return mirrored ? t("mcp.undo.thirdPartyCopy", { name: copyName(mirrored) }) : undefined;
  };
}

/// 批量写入里没写成的那一处：`加到 Codex 失败 · 没有写入权限，没动`；分不出原因时只写 `加到 Codex 失败`
export function mcpFailedAt(location: string, entry: { message: string; detail?: string }): string {
  const message = mcpEntryReason(entry);
  return message === undefined
    ? t("mcp.write.failedAtPlain", { location })
    : t("mcp.write.failedAt", { location, message });
}

/// 写入的命令本身出错（不是某一处没写成）时交给窗口顶上横幅的那一条（spec #239 第 43 条）：后端给的是没有
/// `[code]` 前缀的原文时，一句换成该处的失败句（`加到 Codex 失败`），原文连同要写的文件完整路径进「!」；
/// 后端已经分好两层的原样交给横幅
export function mcpWriteFault(error: string, sentence: string, paths: readonly string[]): AppFault {
  if (/^\[[a-z_]+]/.test(error)) return { text: error };
  return { text: [error, ...paths].join("\n"), fallback: sentence };
}

/// 撤销「修改生效范围」时，去处那几份没删成：`从 CardBox 删除失败 · 没有写入权限，未改动`；分不出原因时只写
/// `从 CardBox 删除失败`（原文已进日志，提示条不放「!」）
export function mcpTakeBackFailed(
  place: string,
  entry: { message: string; detail?: string },
): string {
  const message = mcpEntryReason(entry);
  return message === undefined
    ? t("mcp.scope.takeBackFailedPlain", { place })
    : t("mcp.scope.takeBackFailed", { place, message });
}

/// ⊘ 格的提示框（spec #239 第 44 条）：第一行说人话，第二行写具体原因（SSE 传输、`${…}` 变量、字段名，
/// core 按目标 agent 给的那一句）。联网的 MCP 进不了 Claude Desktop 的配置文件：第一行直接说去哪加，不再要第二行
export function mcpBlockedTip(
  view: { reason?: string; reasonKind?: McpReasonKind },
  target: string,
): { tip: string; detail?: string } {
  if (view.reasonKind === "desktopRemote") return { tip: t("mcp.cell.desktopRemote") };
  const tip = t("mcp.batch.cantWrite", { target });
  return view.reason ? { tip, detail: view.reason } : { tip };
}

/// Claude Code 两格互斥（R4）：这一列在同一个位置里的另一格；别的列没有
export const claudeSibling = (columnId: string): string | null =>
  columnId === CLAUDE_SELF ? CLAUDE_TEAM : columnId === CLAUDE_TEAM ? CLAUDE_SELF : null;

/// 行键：位置 + 服务名（同名服务在一个位置里合成一行）
export const mcpRowKey = (domainKey: string, name: string) => `${domainKey}|${name}`;

export interface McpPlacedRow extends McpDomainRow {
  domainKey: string;
}

export interface McpColumn {
  /// 列 id：位置 id 的末段（`claude-code` / `claude-code:local` / `codex`）
  id: string;
  harnessId: string;
  /// 列头：一个品牌只有这一列时是品牌名（`Claude`），合组时是这一格自己的产品名（`Claude Code`，读屏与图标用）
  name: string;
  /// 列头第二行：合组时组里这一格的小标——产品名去掉品牌名（`Code` / `Desktop`），同一产品占两格时是
  /// Claude Code 的 `仅自己` / `团队共享`；别的列一般不写
  scope?: string;
  /// 合组列头（`groupBrandColumns`）：同一品牌的几列共用一个图标 + 品牌名，线下每格一个小标（`scope`）
  group?: McpColumnGroup;
  /// 这一格的产品在这里占不止一格（Claude Code 的仅自己 / 团队共享）
  split?: boolean;
  /// 列在句子里的名字（提示框、提示条、读屏）：`Claude Code 团队共享` / `Codex`
  sentence: string;
  /// 列头提示框与选择行用的名字：只有一个位置时是那个位置名（`Claude Code · Local MCPs`），否则同 `sentence`
  label: string;
  /// 位置 key → 这一列在那个位置的配置位置
  targets: Map<string, McpLocation>;
}

export interface McpTable {
  /// 并进来的各页（按范围的次序）
  pages: McpDomain[];
  /// 位置 key → 位置列里写的名字；每个位置都有（位置列一直在，R7 2026-09-30）
  places: Map<string, string>;
  columns: McpColumn[];
  rows: McpPlacedRow[];
}

/// 位置名：用户级 / 项目文件夹名（`添加 MCP 来源到 CardBox`）；WeiboAP agent 沿用侧栏的名字
export const mcpPlaceName = (page: McpDomain): string =>
  page.key === "global"
    ? t("mcp.domain.user")
    : page.targets.some((target) => target.harnessId === "weiboap")
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

/// 一个产品属于哪个品牌（core `list_harnesses`）：MCP 页按品牌合组
export interface McpProduct {
  id: string;
  name: string;
  brand: string;
  brandName: string;
}

/// `products`：已安装产品的品牌（#251）。还没读回来时为空，各列各自成列（Claude Code 两格照旧合组）
export function mergeMcpDomains(
  pages: ReadonlyArray<McpDomain>,
  products: ReadonlyArray<McpProduct> = [],
): McpTable {
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
    const sentence = scope
      ? `${col.name} ${scope}`
      : mcpAgentName({ label: col.name, harnessId: col.harnessId });
    const only = col.targets.size === 1 ? [...col.targets.values()][0] : undefined;
    return { ...col, scope, sentence, label: only?.label ?? sentence };
  });
  // 位置名每个位置都有（位置列一直在，R7 2026-09-30）；同名项目按短路径区分
  const places = new Map<string, string>();
  const names = pages.map(mcpPlaceName);
  pages.forEach((page, i) => {
    const dup = names.filter((n) => n === names[i]).length > 1 && page.key !== "global";
    places.set(
      page.key,
      dup ? `${names[i]} · ${shortPath(page.key.replace(/^project:/, ""))}` : names[i],
    );
  });
  return {
    pages: [...pages],
    places,
    columns: groupBrandColumns(columns, products),
    rows: pages.flatMap((page) => page.rows.map((row) => ({ ...row, domainKey: page.key }))),
  };
}

// ===== 按品牌合组的列头（#251；Claude Code 两格见 spec 2026-09-30-mcp-claude-self-team R1；
// DESIGN「MCP 支持哪些 agent › 列头」）=====

export interface McpColumnGroup {
  id: string;
  /// 组头的图标：组里第一格的产品
  agentId: string;
  /// 组头的名字：品牌名（经 `Cap` 显示为大写）
  name: string;
}

/// 合组里一格的小标：产品名去掉开头的品牌名（`Claude Desktop` → `Desktop`）；不以品牌名开头的写全名
const productTag = (name: string, brand: string) =>
  name.startsWith(`${brand} `) ? name.slice(brand.length + 1) : name;

/**
 * 列按品牌排在一起，位置在这个品牌第一列原来的位置；组里按产品先后，同一产品的仅自己在团队共享前。
 * - 一个品牌只有一列：列头写品牌名，不画组（只装了 Claude Code：`CLAUDE`）
 * - 一个品牌有几列：合组——品牌图标 + 品牌名，线下每格小标是去掉品牌名的产品名（`CODE` / `DESKTOP`）；
 *   Claude Code 在范围里有项目时占两格，这两格的小标是 `仅自己` / `团队共享`
 * 品牌名单还没读回来时每个产品自成一个品牌、名字取位置名（Claude Code 两格照旧合成 `CLAUDE CODE` 一组）
 */
export function groupBrandColumns(
  columns: McpColumn[],
  products: ReadonlyArray<McpProduct>,
): McpColumn[] {
  const brandOf = (c: McpColumn) => {
    const p = products.find((x) => x.id === c.harnessId);
    return p ?? { id: c.harnessId, name: c.name, brand: c.harnessId, brandName: c.name };
  };
  const harnessOrder = [...new Set(columns.map((c) => c.harnessId))];
  const rank = (c: McpColumn) =>
    harnessOrder.indexOf(c.harnessId) * 2 + (c.id === CLAUDE_TEAM ? 1 : 0);
  const brands = [...new Set(columns.map((c) => brandOf(c).brand))];
  return brands.flatMap((brand) => {
    const run = columns.filter((c) => brandOf(c).brand === brand).sort((x, y) => rank(x) - rank(y));
    const info = brandOf(run[0]);
    const split = (c: McpColumn) => run.filter((o) => o.harnessId === c.harnessId).length > 1;
    const group: McpColumnGroup | undefined =
      run.length > 1 ? { id: brand, agentId: run[0].harnessId, name: info.brandName } : undefined;
    return run.map((col): McpColumn => {
      const product = brandOf(col);
      if (!split(col)) {
        return group
          ? { ...col, name: product.name, scope: productTag(product.name, info.brandName), group }
          : { ...col, name: info.brandName, group: undefined };
      }
      const self = col.id === CLAUDE_SELF;
      return {
        ...col,
        name: product.name,
        scope: t(self ? "mcp.claude.selfScope" : "mcp.claude.teamScope"),
        group,
        split: true,
        sentence: t(self ? "mcp.claude.selfSentence" : "mcp.claude.teamSentence", {
          agent: product.name,
        }),
        label: t(self ? "mcp.claude.selfLabel" : "mcp.claude.teamLabel", { agent: product.name }),
      };
    });
  });
}

/// Claude Code 两格在项目行上的第二行说明（R6）：写在哪、给谁用；用户级的行不写
export function claudeWhereText(columnId: string, place: string, domainKey: string): string | null {
  if (domainKey === "global") return null;
  if (columnId === CLAUDE_SELF) return t("mcp.claude.whereSelf", { place });
  if (columnId === CLAUDE_TEAM) return t("mcp.claude.whereTeam", { place, file: ".mcp.json" });
  return null;
}

/// 项目里 Claude Code 团队共享格点了会写进（写进 / 挑一份写进 / 挪过来）时，提示框第二行末尾接的一句（#115）：
/// Claude Code 对项目 `.mcp.json` 里的服务第一次会问要不要用，写进去之后还要在那边启用才生效。
/// 仅自己（本地配置、用户级）与别的 agent 写进去就生效、点了是删的格子，原样返回
export function withEnableNote(
  detail: string | null,
  columnId: string,
  domainKey: string,
  writes: boolean,
): string | null {
  if (!writes || columnId !== CLAUDE_TEAM || domainKey === "global") return detail;
  const note = t("mcp.claude.enableNote");
  return detail === null ? note : `${detail} · ${note}`;
}

/// 设置里 `显示的 agent` 勾了 OpenCode：MCP 页还写不了它（core `mcp::supports`），没有它的列，筛选行下说一声（#115）
export const openCodeNoticeWanted = (shown: readonly string[]): boolean =>
  shown.includes("opencode");

/// 挪到另一格时提示框的两行（R4）：`挪到团队共享` + 会动哪两处
export function claudeMoveTip(
  columnId: string,
  place: string,
): { verb: string; detail: string } | null {
  if (columnId === CLAUDE_TEAM)
    return {
      verb: t("mcp.claude.moveToTeam"),
      detail: t("mcp.claude.moveToTeamDetail", { place, file: ".mcp.json" }),
    };
  if (columnId === CLAUDE_SELF)
    return {
      verb: t("mcp.claude.moveToSelf"),
      detail: t("mcp.claude.moveToSelfDetail", { place, file: ".mcp.json" }),
    };
  return null;
}

/// 挪完、删掉团队共享那份之后纸窗接的一句（R4 R7）：改的是本机的 `.mcp.json`，提交之后队友那边才变
/// 成了的几条里第一条「第三方模式那一份没写成」的整句（`McpReportEntry.mirrorFailed`，spec 2026-10-05-mcp-claude-3p）：
/// 成功的提示条借 `reason` 的位置接它。没有就是 undefined
export const mirrorFailedNote = (
  entries: ReadonlyArray<{ outcome: string; mirrorFailed?: string }>,
): string | undefined =>
  entries.find(
    (e) =>
      (e.outcome === "created" || e.outcome === "removed" || e.outcome === "updated") &&
      e.mirrorFailed,
  )?.mirrorFailed;

export const teamGained = () => t("mcp.claude.teamGained");
export const teamLost = () => t("mcp.claude.teamLost");

// ===== 第一批新加的三家（DESIGN「MCP 支持哪些 agent」，spec 2026-09-27-mcp-batch1 R5 R6）=====

/// 列头提示框另起的一行：项目位置下的 Copilot 列说一句它也读 Claude Code 的 `.mcp.json`——
/// Copilot 的项目格只反映 `.github/mcp.json`，一个服务可能在 Copilot 里能用、格子却是 ○
export function mcpColumnNote(
  column: Pick<McpColumn, "harnessId" | "targets"> & Partial<Pick<McpColumn, "id" | "split">>,
): string | undefined {
  // Claude Code 两格（合组时）：说存在哪、所以谁能用（2026-09-30 产品负责人：「悬浮提示里是不是可以告诉用户是存在哪里的，
  // 就是能够简单的解释为什么仅自己用」）。只看用户级时只有一格，没有要区分的，不写
  if (column.split && column.id === CLAUDE_SELF)
    return t("mcp.column.selfNote", { file: "~/.claude.json" });
  if (column.split && column.id === CLAUDE_TEAM)
    return t("mcp.column.teamNote", { file: ".mcp.json" });
  if (column.harnessId !== "github-copilot") return undefined;
  return [...column.targets.keys()].some((key) => key !== "global")
    ? t("mcp.column.copilotNote", { copilot: "Copilot", claude: "Claude Code" })
    : undefined;
}

/// 多位置时这一行的位置没有这一列（空着、不可点）的提示框。只有用户级的产品（Claude Desktop）没有项目级：直说
/// （列在句子里的名字，Claude Desktop 照界面语言说「Claude 桌面应用」，见 `mcpAgentName`）
export function mcpBlankTip(
  place: string,
  column: Pick<McpColumn, "id" | "harnessId" | "sentence"> & Partial<Pick<McpColumn, "targets">>,
): { tip: string; detail?: string } {
  // 只在用户级有配置位置的产品（Claude Desktop）：它没有项目级，不按产品名特判
  const userOnly =
    column.targets !== undefined && [...column.targets.keys()].every((key) => key === "global");
  if (userOnly) return { tip: t("mcp.blank.noProjectLevel", { agent: column.sentence }) };
  // 用户级本来就只给自己：团队共享只在项目里；写在哪个文件是第二行（spec #239 第 44 条）
  if (column.id === CLAUDE_TEAM)
    return {
      tip: t("mcp.blank.teamProjectOnly"),
      detail: t("mcp.blank.teamProjectFile", { file: ".mcp.json" }),
    };
  return { tip: t("mcp.blank.noLocation", { place, column: column.sentence }) };
}

// ===== 修改生效范围：移动或复制整行（spec 2026-09-30-mcp-config-scope R3 R4）=====

export type ScopeMode = "move" | "copy";
/// Claude Code 在项目里写到哪一格：仅自己（本地配置）/ 团队共享（.mcp.json）
export type ClaudeCell = "self" | "team";

/// 移动 / 加一份到另一个生效范围的计划：每个亮着的 agent 一项（源是它自己在这边的那份，写进目标那一级同一个
/// agent 的配置）；移动时写成之后从这边删掉。目标那一级没有它的配置位置的、确认框里没勾的留在原处（加一份时就是不加过去）。
/// 确认框里多勾的（这一行在这边没有的 agent）从这一行现有的一份转写过去，是新加的一份：`keep`，移动时不牵连原处
export interface ScopeMove {
  /// 要写进目标的几项（移动时不带 `keep` 的 `sourceId` 就是写成之后要从这边删掉的那一份）
  selections: Array<{ sourceId: string; name: string; targetId: string; keep?: true }>;
  /// 留在原处 / 不加过去的：列在句子里的名字（`Claude Desktop`）——目标那一级没有它的配置位置，或确认框里没勾
  stays: string[];
  /// 有位置、但这份配置写不过去的（扫描时就知道：`Codex 不支持迁移字段 cwd`）：也留在原处，原因照实说
  cant: Array<{ agent: string; reason: string }>;
}

/// 扫描里一份定义放到某个位置时的格（跨生效范围的格也在扫描里：`overview.entries[].cells`）
export type ScopeCellAt = (
  sourceId: string,
  name: string,
  targetId: string,
) => { cell: McpCell; unsupportedField?: string | null } | undefined;

/// 这一格写到目标那一级时落到哪一列：Claude Code 到用户级一律仅自己（用户级只有这一种）；到项目时按确认框里选的
/// `仅自己 ｜ 团队共享`（不给就跟着原来那一格）；其余同列
const destColumn = (column: string, toKey: string, claude?: ClaudeCell) => {
  if (column !== CLAUDE_SELF && column !== CLAUDE_TEAM) return column;
  if (toKey === "global") return CLAUDE_SELF;
  return claude === undefined ? column : claude === "team" ? CLAUDE_TEAM : CLAUDE_SELF;
};

const writable = (location: McpLocation) => location.harnessId !== "weiboap";

/// 这一行在这边亮着的几份
const litSources = (row: McpDomainRow, from: McpDomain, labelOf: (id: string) => string) =>
  from.targets.filter((source) => cellViewOf(row, source.id, labelOf)?.dot === "linked");

/// 扫描说这一份写不过去时的原因；能写（或扫描里没有这一格）时为 null
const cantReason = (
  row: McpDomainRow,
  source: McpLocation,
  dest: McpLocation,
  nameOf: (location: McpLocation) => string,
  cellAt?: ScopeCellAt,
): string | null => {
  const at = cellAt?.(source.id, row.name, dest.id);
  if (at === undefined || at.cell.state === "missing") return null;
  return ownCellReason(at.cell) ?? unportableText(row.name, nameOf(source), at.unsupportedField);
};

/// `columns`：确认框「写进哪些 agent」里勾着的列（不给＝默认：这一行在用的，按 `destColumn` 落到目标那一级）
export function scopeMovePlan(
  row: McpDomainRow,
  from: McpDomain,
  to: McpDomain,
  labelOf: (locationId: string) => string,
  nameOf: (location: McpLocation) => string,
  claude?: ClaudeCell,
  cellAt?: ScopeCellAt,
  columns?: ReadonlySet<string>,
): ScopeMove {
  const selections: ScopeMove["selections"] = [];
  const stays: string[] = [];
  const cant: ScopeMove["cant"] = [];
  const lit = litSources(row, from, labelOf);
  const destOf = (column: string) =>
    to.targets.find((t) => writable(t) && mcpColumnOf(t.id) === column);
  const own = (source: McpLocation) => destColumn(mcpColumnOf(source.id), to.key, claude);
  const want = columns ?? new Set(lit.filter(writable).map(own));
  for (const source of lit) {
    // WeiboAP 的配置要到 WeiboAP 里改：写不进也删不掉，留在原处
    const dest = writable(source) && want.has(own(source)) ? destOf(own(source)) : undefined;
    // 没勾的、目标那一级没有的、两份落到同一处（项目里仅自己、团队共享都有）：只动第一份，另一份留着，不替用户丢掉
    if (dest === undefined || selections.some((sel) => sel.targetId === dest.id)) {
      stays.push(nameOf(source));
      continue;
    }
    // 扫描已经知道写不过去的（这一家不支持那种写法）：不等写入失败，确认框里先说
    const why = cantReason(row, source, dest, nameOf, cellAt);
    if (why !== null) {
      cant.push({ agent: nameOf(source), reason: why });
      continue;
    }
    selections.push({ sourceId: source.id, name: row.name, targetId: dest.id });
  }
  // 多勾的：这一行在这边没有那一列，从现有的、能写过去的一份转写（新加的一份，移动时不删那一份）
  for (const column of want) {
    const dest = destOf(column);
    if (dest === undefined || selections.some((sel) => sel.targetId === dest.id)) continue;
    if (lit.some((source) => writable(source) && own(source) === column)) continue;
    const base = lit.find(
      (source) => writable(source) && cantReason(row, source, dest, nameOf, cellAt) === null,
    );
    if (base !== undefined)
      selections.push({ sourceId: base.id, name: row.name, targetId: dest.id, keep: true });
    else {
      const first = lit.find(writable);
      if (first !== undefined)
        cant.push({
          agent: nameOf(dest),
          reason: cantReason(row, first, dest, nameOf, cellAt) ?? t("mcp.scope.cantWrite"),
        });
    }
  }
  return { selections, stays, cant };
}

/// 确认框「写进哪些 agent」的一项：去处能写的一个配置位置（同自动同步页的目标菜单；spec 2026-09-30-mcp-config-scope R4）
export interface ScopeAgentOption {
  /// 列（`claude-code` / `claude-code:team` / `codex` …）：几个去处同一列算一项
  id: string;
  iconId: string;
  label: string;
  /// 去不了选中的生效范围：灰着、说原因（没选去处时都能勾）
  blocked: string | null;
}

/// 「写进哪些 agent」：选中的去处里能写 MCP 的每个位置一项（顺序同表格列），这一行在用、却去不了的也列上灰着；
/// `defaults` 是默认勾着的——和现在一致（这一行在用、去得了的）。没选去处时按现在所在的生效范围列
export function scopeAgentOptions(
  row: McpDomainRow,
  from: McpDomain,
  tos: ReadonlyArray<McpDomain>,
  labelOf: (locationId: string) => string,
  nameOf: (location: McpLocation) => string,
  cellAt?: ScopeCellAt,
): { options: ScopeAgentOption[]; defaults: string[] } {
  const lit = litSources(row, from, labelOf);
  // 还没选去处（或没改）：按这一行现在所在的生效范围列出能写的每个位置，勾着的是在用的——菜单不随去处跳
  if (tos.length === 0) {
    const here = new Map<string, McpLocation>();
    for (const location of [...from.targets.filter(writable), ...lit])
      if (!here.has(mcpColumnOf(location.id))) here.set(mcpColumnOf(location.id), location);
    const options = [...here].map(([column, location]) => ({
      id: column,
      iconId: location.harnessId,
      label: mcpLocationSentence(location),
      blocked: writable(location) ? null : t("mcp.scope.weiboapOnly", { agent: "WeiboAP" }),
    }));
    const mine = new Set(lit.filter(writable).map((s) => mcpColumnOf(s.id)));
    return {
      options,
      defaults: options.filter((o) => o.blocked === null && mine.has(o.id)).map((o) => o.id),
    };
  }
  const toGlobal = tos.some((to) => to.key === "global");
  const places = new Map<string, McpLocation>();
  for (const location of [...tos.flatMap((to) => to.targets.filter(writable)), ...lit])
    if (!places.has(mcpColumnOf(location.id))) places.set(mcpColumnOf(location.id), location);
  const options = [...places].map(([column, location]) => {
    const one = new Set([column]);
    const went = tos.some(
      (to) =>
        scopeMovePlan(row, from, to, labelOf, nameOf, undefined, cellAt, one).selections.length > 0,
    );
    let blocked: string | null = null;
    if (!went) {
      const reach = tos.some((to) =>
        to.targets.some((t) => writable(t) && mcpColumnOf(t.id) === column),
      );
      const firstCant = tos
        .flatMap((to) => scopeMovePlan(row, from, to, labelOf, nameOf, undefined, cellAt, one).cant)
        .find(() => true);
      blocked = !writable(location)
        ? t("mcp.scope.weiboapOnly", { agent: "WeiboAP" })
        : !reach
          ? column === CLAUDE_TEAM
            ? t("mcp.blank.teamProjectOnly")
            : toGlobal
              ? t("mcp.scope.noUserLevel")
              : t("mcp.scope.noProjectLevel")
          : (firstCant?.reason ?? t("mcp.scope.cantWrite"));
    }
    return {
      id: column,
      iconId: location.harnessId,
      label: mcpLocationSentence(location),
      blocked,
    };
  });
  const mine = new Set(
    lit.filter(writable).map((s) => destColumn(mcpColumnOf(s.id), toGlobal ? "global" : "project")),
  );
  return {
    options,
    defaults: options.filter((o) => o.blocked === null && mine.has(o.id)).map((o) => o.id),
  };
}

/// 移动但一份都不从这边挪（只勾了这一行在这边没有的 agent）：其实是加一份，句子、墨键按加一份说
export const effectiveScopeMode = (mode: ScopeMode, plan: ScopeMove): ScopeMode =>
  mode === "move" && plan.selections.every((sel) => sel.keep) ? "copy" : mode;

/// 确认框里这个目标为什么不能选；能选时为 null
export function scopeMoveBlocked(
  row: McpDomainRow,
  plan: ScopeMove,
  from: McpDomain,
  to: McpDomain,
  toName: string,
  labelOf: (locationId: string) => string,
): string | null {
  if (to.key === from.key) return t("mcp.scope.alreadyIn", { place: toName });
  const taken = to.rows.some(
    (r) =>
      r.name === row.name && to.targets.some((t) => cellViewOf(r, t.id, labelOf)?.dot === "linked"),
  );
  if (taken) return t("mcp.scope.taken", { place: toName, name: row.name });
  if (plan.selections.length === 0 && plan.cant.length > 0) return plan.cant[0].reason;
  if (plan.selections.length === 0)
    return plan.stays.length > 0
      ? t(to.key === "global" ? "mcp.scope.agentsNoUserLevel" : "mcp.scope.agentsNoProjectLevel", {
          agents: listText(plan.stays),
        })
      : t("mcp.scope.nothingToMove");
  return null;
}

/// 句子里的 agent 名：Claude Code 不分格（格在另一句里说）
const agentWord = (l: McpLocation) =>
  l.harnessId === "claude-code" ? "Claude Code" : mcpLocationSentence(l);

/// 确认框里的后果（灰字，一句一行）：哪些 agent 写过去、原处删不删、哪些留在原处，动到团队共享时说队友那边
export function scopeChangeText(
  mode: ScopeMode,
  plan: ScopeMove,
  locationOf: (id: string) => McpLocation | undefined,
  toName: string,
  fromName: string,
): string[] {
  const agents = listText([
    ...new Set(
      plan.selections.flatMap((sel) => {
        const l = locationOf(sel.targetId);
        return l ? [agentWord(l)] : [];
      }),
    ),
  ]);
  const stays = listText(plan.stays);
  const lines = [
    mode === "move"
      ? t("mcp.scope.consMove", { agents, place: toName, from: fromName })
      : t("mcp.scope.consAdd", { agents, place: toName, from: fromName }),
  ];
  if (plan.stays.length > 0)
    lines.push(
      mode === "move"
        ? t("mcp.scope.consStays", { agents: stays, from: fromName })
        : t("mcp.scope.consNotAdded", { agents: stays }),
    );
  for (const c of plan.cant)
    lines.push(
      mode === "move"
        ? t("mcp.scope.consCantMove", { agent: c.agent, reason: c.reason, from: fromName })
        : t("mcp.scope.consCantAdd", { agent: c.agent, reason: c.reason }),
    );
  const team = (ids: string[]) => ids.some((id) => mcpColumnOf(id) === CLAUDE_TEAM);
  if (team(plan.selections.map((sel) => sel.targetId)))
    lines.push(t("mcp.scope.consTeamWrite", { place: toName, gained: teamGained() }));
  else if (mode === "move" && team(plan.selections.map((sel) => sel.sourceId)))
    lines.push(t("mcp.scope.consTeamDrop", { from: fromName, lost: teamLost() }));
  return lines;
}

/// 做完之后提示条接的一句：移到用户级＝所有项目都能用；移到项目＝只在那里；复制＝那里也能用；留下的照实说
export function scopeMovedTrail(
  mode: ScopeMode,
  toKey: string,
  toName: string,
  fromName: string,
  stays: string[],
): string[] {
  const out = [
    toKey === "global"
      ? t("mcp.scope.trailAllProjects")
      : mode === "move"
        ? t("mcp.scope.trailOnly", { place: toName })
        : t("mcp.scope.trailAlso", { place: toName }),
  ];
  const names = listText(stays);
  if (stays.length > 0)
    out.push(
      mode === "move"
        ? t("mcp.scope.trailStays", { agents: names, from: fromName })
        : t("mcp.scope.trailNotAdded", { agents: names }),
    );
  return out;
}

// ===== 多个去处（2026-09-30 产品负责人：「生效范围是不是应该支持多选」——只在几个项目里用、不要全局）=====

/// 确认框里选的是什么（2026-09-30 产品负责人：「所有项目（用户级）｜ 只在这些项目」单选 + 项目勾选）：
/// - 所有项目：这一行在用户级＝没改；在项目＝移到用户级
/// - 只在这些项目：勾着这一行现在所在的项目＝在别的勾上的项目**加一份**（原来的「复制」），没勾它＝**移到**勾上的项目；
///   一个都没勾、或只勾着它自己＝没改
export type ScopeIntent = { mode: ScopeMode; targets: string[] } | { blocked: string };

export function scopeIntent(
  fromKey: string,
  all: boolean,
  projects: ReadonlyArray<string>,
): ScopeIntent {
  if (all)
    return fromKey === "global" ? { blocked: noChange() } : { mode: "move", targets: ["global"] };
  if (projects.length === 0) return { blocked: t("mcp.scope.noProject") };
  const targets = projects.filter((k) => k !== fromKey);
  if (targets.length === 0) return { blocked: noChange() };
  return { mode: projects.includes(fromKey) ? "copy" : "move", targets };
}

/// 没改的时候墨键上的字
export const noChange = () => t("mcp.scope.noChange");

/// 几个去处在句子里的写法：至多两个写名字（`CardBox、weibo_assistant`），多了写 `3 个项目`
export function scopeTargetsLabel(names: ReadonlyArray<string>): string {
  return names.length <= 2 ? listText(names) : tn("mcp.scope.projectsCount", names.length);
}

/// 几个去处的计划并成一份：写进每个去处的都算；留在原处 / 写不过去的，只算一个去处都没去成的那几份
/// （移动时去成了任何一处，这边那份就删掉）
export function mergeScopePlans(
  plans: ReadonlyArray<ScopeMove>,
  nameOfSource: (sourceId: string) => string,
): ScopeMove {
  const selections = plans.flatMap((p) => p.selections);
  // 新加的一份（`keep`）用的底子不算「去了」：它自己那一格没勾时照样留在原处
  const went = new Set(
    selections.filter((sel) => !sel.keep).map((sel) => nameOfSource(sel.sourceId)),
  );
  const stays = [...new Set(plans.flatMap((p) => p.stays))].filter((n) => !went.has(n));
  const cant: ScopeMove["cant"] = [];
  for (const c of plans.flatMap((p) => p.cant))
    if (!went.has(c.agent) && !cant.some((x) => x.agent === c.agent)) cant.push(c);
  return { selections, stays, cant };
}
