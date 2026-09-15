import type { CellState } from "./types";

export type SortDir = "asc" | "desc";
export interface SortState {
  key: string;
  dir: SortDir;
}

/// 点同一列翻转方向，点新列从升序开始
export function toggleSort(prev: SortState | null, key: string): SortState {
  if (prev && prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
  return { key, dir: "asc" };
}

/// 目标列按状态排序时的次序：好的在前，越靠后越需要处理
export const STATE_RANK: Record<CellState, number> = {
  own: 0,
  linked: 0,
  // 部分覆盖与缺失一样等着补齐，排在一起
  partial: 1,
  missing: 1,
  broken: 2,
  foreign: 3,
  duplicate: 4,
  unwritable: 5,
};

/// 取值比较器：字符串走 localeCompare，数字按大小。Array.sort 本身稳定，同值保持原序
export function compareBy<T>(
  get: (row: T) => string | number,
  dir: SortDir,
): (a: T, b: T) => number {
  const sign = dir === "asc" ? 1 : -1;
  return (a, b) => {
    const x = get(a);
    const y = get(b);
    const diff =
      typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : Number(x) - Number(y);
    return diff * sign;
  };
}
