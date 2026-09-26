/// 添加来源（DESIGN「来源：订阅、来源行、添加来源 › 添加来源」）的纯逻辑：标题与造句、
/// 同名标记、第二行写什么、选的文件夹那一行能不能勾、勾了哪些要加、`添加 N 个来源`、
/// 加完的提示。不碰 api、不产 JSX。
/// 内容（AddSourcePanel）与容器（现在是二级页 AddSourcePage）共用这里的造句。
import { joinWords } from "./importDefaults.ts";
import type { DomainRef } from "./sourcesView.ts";

/// 页名：`添加来源到 CardBox`、`添加来源到全局`、`添加 MCP 来源到 CardBox`（专名与汉字之间一个空格，
/// 汉字之间不加：`joinWords`）
export function addSourceTitle(domain: DomainRef, kind: "skill" | "mcp"): string {
  return joinWords(kind === "mcp" ? "添加 MCP 来源到" : "添加来源到", domain.label);
}

/// 顶部 `选择文件夹…` 右侧的灰字
export const PICK_HINT = "选 skill 所在的文件夹，只认带 SKILL.md 的子目录";

/// 选的文件夹那一组的小标题
export const PICKED_HEAD = "你选的文件夹";

/// 建议的来源的区域标签
export const SUGGESTED_LABEL = "建议的来源";

/// 没有建议的来源时 `建议的来源` 下的一句（skill；顶部的 `选择文件夹…` 照常）
export const NO_SKILL_CANDIDATES = "别处还没有可加的来源";

/// 选的文件夹里一个带 SKILL.md 的子目录都没有：那一行第三行写它，`添加来源` 禁用
export const FOLDER_WITHOUT_SKILLS = "这个文件夹里没有 skill，只认带 SKILL.md 的子目录";

/// `同名` 标签的悬停说明
export const SAME_NAME_TIP = "加进来后两份都在列表里，到行上只留一份";

/// 第二行外露的名字之间的分隔（与移除确认里列名字同一个顿号）
export const NAME_SEP = "、";

/// 选的文件夹已经在这个位置的来源里：`它已经在 CardBox 的来源里`
export function alreadySubscribedText(domain: DomainRef): string {
  return joinWords("它已经在", domain.label, "的来源里");
}

/// 第二行的数量：`39 个 skill` / `3 个 MCP`（同来源管理页）
export const countText = (count: number, noun: string) => joinWords(`${count} 个`, noun);

/// 来源行里的一个名字，与名字后的标签（`同名` / `搬不过去`）
export interface PreviewItem {
  name: string;
  tag?: { text: string; tip: string };
  dim?: boolean;
}

/// 候选的 skill 名：与已订阅来源里的 skill 同名的挂 `同名`
export function sameNameItems(skills: string[], subscribed: string[][]): PreviewItem[] {
  const taken = new Set(subscribed.flat());
  return skills.map((name) =>
    taken.has(name) ? { name, tag: { text: "同名", tip: SAME_NAME_TIP } } : { name },
  );
}

/// 一张来源行
export interface CandidateEntry {
  /// 订阅时交给 core 的：skill 是路径，MCP 是位置 id；也是选中键
  ref: string;
  /// 加上之后它的来源 id：主视图筛选片与来源管理页的行都以它为键（skill 是 Source.id，MCP 是位置 id）
  id: string;
  name: string;
  sub: string;
  /// 完整路径（第二行只写短路径）
  title?: string;
  count: number;
  items: PreviewItem[];
}

/// 选的文件夹：预览回来之前是 loading；already＝它已经是这个位置订阅的来源
export type PickedState =
  | { status: "loading"; ref: string; name: string; sub: string }
  | { status: "ready"; entry: CandidateEntry; already: boolean }
  | { status: "failed"; ref: string; name: string; sub: string; reason: string };

export const pickedRef = (picked: PickedState): string =>
  picked.status === "ready" ? picked.entry.ref : picked.ref;

/// 来源行的第二行：与来源管理页第二行一字不差的 `出处 · 39 个 skill`，尾部接外露的 skill 名
/// （顿号连写；一行放不下由样式以 `…` 截断）。一个名字都没有时只写前半段
export function rowMeta(sub: string, count: number, noun: string, items: PreviewItem[]): string {
  const head = `${sub} · ${countText(count, noun)}`;
  return items.length === 0 ? head : `${head} · ${items.map((i) => i.name).join(NAME_SEP)}`;
}

/// 来源行的第二行：出处与外露的名字，或者一句说明（读文件夹时转圈）
export type SourceLine =
  { kind: "meta"; text: string } | { kind: "loading" } | { kind: "message"; text: string };

/// 选的文件夹那一行的复选框为什么不能勾（第二行与提示框写同一句）；能勾时 null
export function pickedBlocked(picked: PickedState, domain: DomainRef): string | null {
  if (picked.status === "loading") return "正在读文件夹";
  if (picked.status === "failed") return `无法读取这个文件夹：${picked.reason}`;
  if (picked.already) return alreadySubscribedText(domain);
  if (picked.entry.count === 0) return FOLDER_WITHOUT_SKILLS;
  return null;
}

/// 选的文件夹那一行的第二行
export function pickedLine(picked: PickedState, domain: DomainRef, noun: string): SourceLine {
  if (picked.status === "loading") return { kind: "loading" };
  const blocked = pickedBlocked(picked, domain);
  if (blocked !== null || picked.status !== "ready") {
    return { kind: "message", text: blocked ?? "" };
  }
  const { sub, count, items } = picked.entry;
  return { kind: "meta", text: rowMeta(sub, count, noun, items) };
}

/// 勾了的里要加的，按列表的先后：选的文件夹（能勾时）在前，再是建议的来源
export function checkedEntries(
  checked: ReadonlySet<string>,
  picked: PickedState | null,
  candidates: CandidateEntry[],
  domain: DomainRef,
): CandidateEntry[] {
  const first =
    picked !== null &&
    picked.status === "ready" &&
    pickedBlocked(picked, domain) === null &&
    checked.has(picked.entry.ref)
      ? [picked.entry]
      : [];
  const rest = candidates.filter((c) => checked.has(c.ref) && !first.some((f) => f.ref === c.ref));
  return [...first, ...rest];
}

/// 一个没勾时 `添加来源` 禁用的原因
export const NOTHING_CHECKED = "先勾选要加的来源";

/// 底部主动作：`添加 3 个来源`；一个没勾时写 `添加来源`（禁用，提示框 NOTHING_CHECKED）
export const addLabel = (count: number) => (count === 0 ? "添加来源" : `添加 ${count} 个来源`);

/// 全加上、滑回主视图时新来源片下浮起的那一窗，动词 `已添加` 之后用 ` · ` 隔开的几段。
/// 列表筛到了新来源（`filtered`）时要说清楚列表为什么变少了：一个来源
/// `WeiboAP · 已筛选出它的 39 个 skill`，几个 `2 个来源 · 已筛选出它们的 41 个 skill`
/// （MCP 写 `3 个 MCP`）；新来源在这个位置下一行都没有、没筛时只交代加上了：`WeiboAP · 39 个 skill`。
/// names：新来源在筛选片上的名字（与片同一个起名函数）；count：列表里这几片的并集有几行
export function addedParts(
  names: string[],
  count: number,
  noun: string,
  filtered: boolean,
): string[] {
  const one = names.length === 1;
  const what = one ? names[0] : `${names.length} 个来源`;
  const counted = countText(count, noun);
  return [what, filtered ? `已筛选出${one ? "它" : "它们"}的 ${counted}` : counted];
}

/// 逐个加完之后的提示条（全成不出提示，直接滑回）：全没成＝做不成，部分成＝部分失败。
/// 名字只写没加上的；原因取第一个（几个原因相同时就是那一句）
export function addFailureToast(
  done: string[],
  failed: { name: string; reason: string }[],
): {
  kind: "cannot" | "partial";
  verb: string;
  names: string[];
  tally?: { done: number; failed: number };
  reason: string;
} | null {
  if (failed.length === 0) return null;
  const names = failed.map((f) => f.name);
  const reason = failed[0].reason;
  return done.length === 0
    ? { kind: "cannot", verb: "没添加", names, reason }
    : {
        kind: "partial",
        verb: "没添加",
        names,
        tally: { done: done.length, failed: failed.length },
        reason,
      };
}
