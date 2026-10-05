/// 同名原件的提示条（2026-09-30 产品负责人：「当同一个位置，出来两个 skill 的时候……顶部是不是也需要出现那种可关闭的提示条」）。
///
/// 同一个位置里同名的几份原件，agent 的目录里只能放一份，另几份用不上（格子是 ⊘）。处理在这一行的抽屉里
/// （`只留这份`），入口藏得深：表格上方出一条能关的提示条（同「有新版本」），`只看这些` 筛出这些行。
/// 没有「全部处理」——每一个都要人决定留哪份。关掉＝这一批不再提示；之后又出现新的同名才再出一次。
/// 纯逻辑，页面（SkillsTab）接状态与持久化。
import { shortDate } from "./dateText.ts";
import { t, tn } from "./i18n.ts";
import type { SkillCopyInfo } from "./types.ts";

/// 同名分组的键：位置 + skill 名（与 DomainView 的 ×2 同一个口径）
export const dupGroupKey = (row: { domainKey: string; skill: string }) =>
  `${row.domainKey}|${row.skill}`;

/// 当前范围里的同名分组：键 → 几份（只收两份及以上的；藏起来的行不算）。`locked`：这一份删不了（在应用包里）——
/// 一组里每一份都删不了时不算（用户什么都做不了，提示条不为它出）
export function dupGroupsOf<R extends { domainKey: string; skill: string }>(
  rows: ReadonlyArray<R>,
  hidden: (row: R) => boolean = () => false,
  locked: (row: R) => boolean = () => false,
): Map<string, number> {
  const counts = new Map<string, number>();
  const free = new Set<string>();
  for (const row of rows) {
    if (hidden(row)) continue;
    const key = dupGroupKey(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!locked(row)) free.add(key);
  }
  for (const [key, n] of counts) if (n < 2 || !free.has(key)) counts.delete(key);
  return counts;
}

/// 提示条该不该出：有同名、且其中至少一组不在关掉过的那一批里
export function dupStripWanted(
  groups: ReadonlyMap<string, number>,
  dismissed: ReadonlySet<string>,
): boolean {
  return [...groups.keys()].some((key) => !dismissed.has(key));
}

/// 提示条的一句：`2 个 skill 在同一个生效范围里有两份同名的，只能用上一份`（有一组超过两份时说「几份」）
export function dupStripSentence(groups: ReadonlyMap<string, number>): string {
  const many = [...groups.values()].some((n) => n > 2);
  return many ? tn("skills.dupStrip.many", groups.size) : tn("skills.dupStrip.two", groups.size);
}

/// `只看这些` 开着、同名的都只留了一份之后提示条那一句（列表照旧是按下那一刻那几行，`显示全部` 回到全部）
export const dupsDone = () => t("skills.dupStrip.done");

/// 关掉过的那一批：本机记住（界面自己的偏好，不进 core 的设置）
const STORE_KEY = "sophia.skills.dupDismissed";

export function loadDupDismissed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function saveDupDismissed(keys: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify([...keys]));
  } catch {
    // 存不下只是下次再提示一次
  }
}

// ===== 推荐保留哪份（2026-09-30 产品负责人：「保留哪份应该给出建议，如果完全一样，我建议保留 .agents 的，
// 如果有个版本更新，应该保留更新版本的」「比如有个推荐的标签，降低用户决策成本」）=====

export interface DupCopy {
  /// 行键（skillRowKey）
  key: string;
  /// 这份在 `.agents/skills`（通用仓库）里：多数 agent 直接读这里
  agentsStore: boolean;
  /// 还没取到读数时为 undefined
  info: SkillCopyInfo | undefined;
}

/// 这份原件的路径在不在 `.agents/skills` 里（用户级或项目的通用仓库）
export const inAgentsStore = (skillPath: string) =>
  /[\\/]\.agents[\\/]skills[\\/][^\\/]+[\\/]?$/.test(skillPath);

/// 同名几份里推荐留哪份：
/// - 内容一模一样（内容指纹都相同）：留通用仓库（`.agents/skills`）那份；一份都不在（或不止一份在）通用仓库时，
///   留改得最近的那份（2026-09-30 产品负责人真机：ego lite 两个版本各带一份、内容一样，原来「留哪份都一样」不推荐，
///   用户看不出该留哪份——旧版本的文件夹多半随应用更新被清掉，留新的更稳）
/// - 不一样：留改得最近的那份
/// - 时间读不到、或最近的不止一份时不推荐；读数还没齐时不推荐（不先猜一个再换）
export function recommendKeep(
  copies: ReadonlyArray<DupCopy>,
  now: Date = new Date(),
): { key: string; reason: string } | null {
  if (copies.length < 2 || copies.some((c) => c.info === undefined)) return null;
  const infos = copies.map((c) => c.info!);
  const two = copies.length === 2;
  const first = infos[0].content;
  const newest = newestOf(copies);
  if (first !== null && infos.every((i) => i.content === first)) {
    const store = copies.filter((c) => c.agentsStore);
    if (store.length === 1)
      return {
        key: store[0].key,
        reason: t(two ? "skills.advice.sameStoreTwo" : "skills.advice.sameStoreMany"),
      };
    return newest
      ? {
          key: newest.key,
          reason: t(two ? "skills.advice.sameNewerTwo" : "skills.advice.sameNewerMany", {
            date: shortDate(newest.at, now),
          }),
        }
      : null;
  }
  return newest
    ? {
        key: newest.key,
        reason: t(two ? "skills.advice.differentNewestTwo" : "skills.advice.differentNewestMany", {
          date: shortDate(newest.at, now),
        }),
      }
    : null;
}

/// 改得最近的那一份；时间读不到、或最近的不止一份时为 null
function newestOf(copies: ReadonlyArray<DupCopy>): { key: string; at: number } | null {
  const times = copies.map((c) => c.info?.modified ?? null);
  if (times.some((t) => t === null)) return null;
  const latest = Math.max(...(times as number[]));
  const newest = copies.filter((c) => c.info!.modified === latest);
  return newest.length === 1 ? { key: newest[0].key, at: latest } : null;
}

/// ×2 提示框、抽屉里的读数：`改于 9月20日 · 3 个文件`（改动时间读不到时只写文件数）
export function copyReadout(info: SkillCopyInfo, now: Date = new Date()): string {
  return [
    info.modified != null
      ? t("skills.readout.modified", { date: shortDate(info.modified, now) })
      : null,
    tn("skills.readout.files", info.entries),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/// 路径在某个应用包（`xxx.app`）里面：那是应用自己带的文件，删了会破坏它的签名，放回去 macOS 也不让（2026-09-30 真机：
/// 「只留这份」删掉了 ego lite.app 里旧版本的 ego-browser，撤销时 Operation not permitted，应用签名报 modified）。
/// 返回应用名（`ego lite`）；不在应用包里为 null
export function appBundleOf(path: string): string | null {
  const hit = path.split(/[\\/]/).find((part) => /\.app$/i.test(part));
  return hit ? hit.replace(/\.app$/i, "") : null;
}

/// `只留这份` 为什么按不了：要删的那一份在应用包里（core 同样拒绝）；按得了为 null
export function keepBlockedReason(otherPath: string): string | null {
  const app = appBundleOf(otherPath);
  return app === null ? null : t("skills.keep.inApp", { app });
}
