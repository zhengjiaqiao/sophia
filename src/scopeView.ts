/// 筛选行（spec 2026-09-27-skill-mcp-market R2；DESIGN「位置页 › 筛选行」）的纯逻辑：
/// - `位置` 胶囊：`全部` `用户级` + 最近活跃的前几个项目（至多 6 个，这一行放不下时提前收进 `更多 ▾`，不折行）；
///   从「更多」里选中的那个替换最后一个位置，保证选中项始终看得见；
/// - `来源` 下拉：只列当前位置里有的来源（带条数）；换了位置、原来选的来源不在了，回到 `全部`。
/// 不碰 api、不产 JSX，tests/scope-view.test.ts 直接测。

import { locale } from "./i18n.ts";

export interface ScopeProject {
  /// 域 key：`project:<路径>`
  key: string;
  label: string;
  path: string;
}

/// 一行里最多露出几个项目片（`全部` `用户级` 与 `更多` 不算）
export const MAX_CHIPS = 6;

/// `ordered` 已按最近活跃排好；`limit` 是这一行放得下几个项目片（默认 6）。
/// 返回露出的片与收进「更多」的项目（都保持原来的先后）。选中的项目不在前 `limit` 个里时替换最后一个；
/// 一个都放不下时也露出选中的那一个（选中项始终看得见）
export function chipProjects(
  ordered: ReadonlyArray<ScopeProject>,
  selected: string | null,
  limit: number = MAX_CHIPS,
): { chips: ScopeProject[]; more: ScopeProject[] } {
  const n = Math.max(0, Math.min(limit, MAX_CHIPS));
  const top = ordered.slice(0, n);
  const picked = selected === null ? undefined : ordered.slice(n).find((p) => p.key === selected);
  const chips = picked ? [...top.slice(0, Math.max(0, n - 1)), picked] : top;
  return { chips, more: ordered.filter((p) => !chips.includes(p)) };
}

/// 量出来的这一行（`FilterRow` 在隐藏的量尺里量真实的胶囊）
export interface ChipMetrics {
  /// 胶囊能用的宽：整行宽减去右端的 `来源` 下拉与它左边的间隔
  width: number;
  /// 行首标签 + 8 + `全部` + 间隔 + `用户级`：任何时候都在
  fixed: number;
  /// 胶囊间隔（6）
  gap: number;
  /// `更多 ▾` 那一颗的宽
  more: number;
  /// 某个项目片的宽；量尺里没有它时给 0（不会发生：量尺里放的就是候选的那几个）
  widthOf: (key: string) => number;
}

/// 这一行放得下几个项目片（0–6）：从 6 个往下试，连同要不要 `更多` 一起算，放得下为止
export function fitChips(
  ordered: ReadonlyArray<ScopeProject>,
  selected: string | null,
  m: ChipMetrics,
): number {
  for (let n = Math.min(MAX_CHIPS, ordered.length); n > 0; n -= 1) {
    const { chips, more } = chipProjects(ordered, selected, n);
    const used =
      m.fixed +
      chips.reduce((sum, p) => sum + m.gap + m.widthOf(p.key), 0) +
      (more.length > 0 ? m.gap + m.more : 0);
    if (used <= m.width) return n;
  }
  return 0;
}

/// 量尺里要量哪几个项目：前 6 个，加上不在前 6 个里的选中项
export function measuredProjects(
  ordered: ReadonlyArray<ScopeProject>,
  selected: string | null,
): ScopeProject[] {
  const top = ordered.slice(0, MAX_CHIPS);
  const picked =
    selected === null ? undefined : ordered.slice(MAX_CHIPS).find((p) => p.key === selected);
  return picked ? [...top, picked] : top;
}

/// 「更多」里的搜索：名字或路径里有就算，不分大小写；空查询全留
export function matchProject(p: ScopeProject, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return p.label.toLowerCase().includes(q) || p.path.toLowerCase().includes(q);
}

/// 来源下拉的一项：来源名（与表格「来源」列同一个写法）+ 这个位置里有几行
export interface SourceOption {
  label: string;
  count: number;
}

/// 当前位置里有哪些来源：每一行的来源名 → 按行数从多到少，同数按名字
export function sourceOptions(labels: ReadonlyArray<string>): SourceOption[] {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, locale()));
}

/// 此刻生效的来源筛选：选过的还在当前位置里就是它，不在了（换了位置、来源被移除）回到 `全部`（null）
export const resolveSource = (
  picked: string | null,
  options: ReadonlyArray<SourceOption>,
): string | null => (picked !== null && options.some((o) => o.label === picked) ? picked : null);
