/// 孤链成行（DESIGN「没有收件箱、待处理页和「忽略」」那张表：链接失效，原件已不在）。
///
/// 扫描把 agent 目录里解析不到的链接都算成了清除动作（`DomainPage.broken`）。原件还在的那些
/// 落在某一行的格上（虚线环，点一下重新链接）；**没有哪一行的格对得上的**就是孤链——原件早就不在了，
/// 矩阵里照样给它成一行：名字 + 原件位置写「不在了」，该 agent 格是虚线环，点格＝清除这条链接。
/// 同一个名字在几个 agent 下都有孤链，合成一行、各格各清各的。
///
/// 纯逻辑，不碰 api、不产 JSX。
import type { DomainPage, PlannedAction } from "./types.ts";

/// 孤链行的行键前缀。真行的键是「来源路径|skill」，来源路径不会以它开头
export const ORPHAN_KEY_PREFIX = "orphan|";

/// 原件位置格里写的字（`ink-faint`）
export const ORPHAN_ORIGIN = "不在了";

/// 孤链格的提示框：不确认——链接本来就指向空处
export const ORPHAN_TIP = "原件不在了，点一下清除这条链接";

/// 一条孤链：在哪一列、清它要执行的动作（原样交给 `api.applyAll([clear], true)`）
export interface OrphanLink {
  targetId: string;
  clear: PlannedAction;
}

export interface OrphanRow {
  key: string;
  skill: string;
  /// 原件原来在哪（链接指向的那个已经不存在的位置），给原件位置格的提示框
  pointedTo: string;
  links: OrphanLink[];
}

export function orphanRows(page: DomainPage): OrphanRow[] {
  // 已经落在某一行格上的链接不算孤链：那一格自己画虚线环、点一下重新链接
  const covered = new Set(page.rows.flatMap((row) => row.cells.map((cell) => cell.path)));
  const out = new Map<string, OrphanRow>();
  for (const action of page.broken) {
    if (action.kind !== "brokenLink" || covered.has(action.targetPath)) continue;
    // 找不到列就没有格可放：不硬塞进别的列
    const target = page.targets.find((t) => t.path === action.target);
    if (target === undefined) continue;
    const key = ORPHAN_KEY_PREFIX + action.itemName;
    const row = out.get(key) ?? {
      key,
      skill: action.itemName,
      pointedTo: action.sourcePath,
      links: [],
    };
    if (!row.links.some((link) => link.targetId === target.id)) {
      row.links.push({ targetId: target.id, clear: action });
    }
    out.set(key, row);
  }
  return [...out.values()];
}
