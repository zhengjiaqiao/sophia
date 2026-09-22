import type { Dot } from "./cellState";

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

/// agent 列按格子排序时的次序：能用的在前，越靠后越需要处理，没有格的排最后。
/// 按画出来的记号排，不按后端状态排——Skills 与 MCP 共用一张表（Matrix），
/// 两边的后端状态不同，但记号是同一套
export const DOT_RANK: Record<Dot, number> = {
  own: 0,
  linked: 0,
  missing: 1,
  broken: 2,
  blocked: 3,
  wholeLinked: 4,
  readOnly: 5,
  none: 6,
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
