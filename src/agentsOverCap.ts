/// 本机装的 agent 多于列表上限时，SKILLS 页筛选行下那块灰面板（issue #109；DESIGN-components「灰面板 NoticePanel」
/// 一次性说明：没有「!」、右端 × 能关）：`装了 6 个 agent，列表里最多显示 4 个 · Gemini CLI、OpenCode 没显示`。
///
/// 第一次打开时扫描到的 agent 自动勾上、最多 4 个（core `discovery::reconcile_shown`），多出来的用户不知道去哪找，
/// 这一句告诉他、给一颗 `去设置`。关掉＝这一批（装的这些 agent）不再提示；装的集合变了（又装了一个、卸了一个）再出。
/// 纯逻辑，壳（App）接名单与持久化，页面（SkillsTab）只管画
import { listText, tn } from "./i18n.ts";
import type { HarnessList } from "./types.ts";

export interface AgentsOverCap {
  /// 这一批的记号：装了哪些 agent（id 排序后连起来）。关掉时记它；装的集合变了记号就变
  key: string;
  /// 装了几个（品牌数：Claude Code 与 Claude Desktop 算一个，#251）
  installed: number;
  /// 列表里最多显示几个（core 的 `MAX_SHOWN`）
  max: number;
  /// 装了但列表里没显示的品牌（品牌的先后）：超出上限没勾上的，连同用户自己取消勾的
  hidden: string[];
}

/// 装了哪些 agent 的记号（按品牌，#251）
function installedKey(list: HarnessList): string {
  return list.brands
    .filter((h) => h.installed)
    .map((h) => h.id)
    .sort()
    .join("\n");
}

/// 装的多于上限时给出这一批；不多于（或名单还没读回来）为 null——不多于时从不出
export function agentsOverCapOf(list: HarnessList | null): AgentsOverCap | null {
  if (list === null) return null;
  const installed = list.brands.filter((b) => b.installed);
  if (installed.length <= list.maxShown) return null;
  const hidden = installed.filter((b) => !b.enabled).map((b) => b.name);
  // 装的超了上限、显示的必然不满全部（core 按上限整理过）；万一一个都没藏（设置被手改），没什么可说的
  if (hidden.length === 0) return null;
  return { key: installedKey(list), installed: installed.length, max: list.maxShown, hidden };
}

/// 该不该出：超了上限、且这一批没关过
export function overCapWanted(cap: AgentsOverCap | null, dismissed: string | null): boolean {
  return cap !== null && cap.key !== dismissed;
}

/// 关掉的记录还作不作数：装的集合一变就作废（卸了再装回同一个也再出），名单没读回来时照旧
export function keepDismissed(list: HarnessList | null, dismissed: string | null): string | null {
  if (list === null || dismissed === null) return dismissed;
  return installedKey(list) === dismissed ? dismissed : null;
}

/// 主句与原因：`装了 6 个 agent，列表里最多显示 4 个` · `Gemini CLI、OpenCode 没显示`
export function overCapText(cap: AgentsOverCap): { message: string; reason: string } {
  return {
    message: tn("skills.agentsOverCap.message", cap.installed, { max: cap.max }),
    reason: tn("skills.agentsOverCap.reason", cap.hidden.length, {
      names: listText(cap.hidden, "enum"),
    }),
  };
}

/// 关掉的那一批：本机记住（界面自己的偏好，不进 core 的设置；同「同名原件」提示条）
const STORE_KEY = "sophia.skills.agentsOverCapDismissed";

export function loadOverCapDismissed(): string | null {
  try {
    return window.localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

export function saveOverCapDismissed(key: string | null): void {
  try {
    if (key === null) window.localStorage.removeItem(STORE_KEY);
    else window.localStorage.setItem(STORE_KEY, key);
  } catch {
    // 存不下只是下次再提示一次
  }
}
