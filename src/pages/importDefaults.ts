/// 两张添加页（skill / MCP）共用的纯逻辑：默认目标、记住上次的目标、按列切、同名来源的区分片段、
/// 全选三态与主动作的字。
/// 不碰 api、不产 JSX。

/// 这个来源上次添加时勾上的目标，以及连续几次点的是同一组
export interface ImportMemory {
  last: string[];
  streak: number;
}

const STORE = "sophia.import.memory";

/// localStorage 可能整个不可用（隐私模式、被清）：读不到就当没有上次
function readAll(): Record<string, ImportMemory> {
  try {
    const raw = window.localStorage.getItem(STORE);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, ImportMemory>)
      : {};
  } catch {
    return {};
  }
}

export function loadImportMemory(key: string): ImportMemory | null {
  const found = readAll()[key];
  return found && Array.isArray(found.last) ? found : null;
}

export function saveImportMemory(key: string, memory: ImportMemory) {
  try {
    window.localStorage.setItem(STORE, JSON.stringify({ ...readAll(), [key]: memory }));
  } catch {
    // 存不下就下次回到默认，不打扰用户
  }
}

/// 默认目标（DESIGN「默认值」③）：这个来源上次用的目标（只留现在还在的）；
/// 没有上次、或上次的都不在了，则可选的前两个
export function defaultTargets(available: string[], last: string[] | undefined): string[] {
  const kept = (last ?? []).filter((id) => available.includes(id));
  return kept.length > 0 ? kept : available.slice(0, 2);
}

export const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/// 切成若干竖排的列，按列读（字母序竖着看比横着跳舒服）
export function columnsOf<T>(list: T[], count: number): T[][] {
  const per = Math.ceil(list.length / count);
  return Array.from({ length: count }, (_, i) => list.slice(i * per, (i + 1) * per)).filter(
    (col) => col.length > 0,
  );
}

/// 同名来源分不清时（真机里三个「WeiboAP · 外部」），挑出每条路径里能区分它的**那一级**。
///
/// 从结尾往前找：第一个「别的路径在同一位置（从结尾数）上都不是它」的分量就是答案——
/// 共有的结尾（通常是 `skills`）自然被跳过。找不到单独一级能区分的（极少见），退回整条路径。
/// 返回与输入同序；只有一条时返回空串（不需要区分）
export function distinguishingSegments(paths: string[]): string[] {
  if (paths.length < 2) return paths.map(() => "");
  const parts = paths.map((p) => p.split(/[/\\]+/).filter(Boolean));
  const at = (ps: string[], k: number) => ps[ps.length - 1 - k];
  return parts.map((mine, i) => {
    for (let k = 0; k < mine.length; k += 1) {
      const c = at(mine, k);
      if (parts.every((other, j) => j === i || at(other, k) !== c)) return c;
    }
    return paths[i];
  });
}

/// 全选框的三态，照实算（DESIGN「添加页」：全选就是全部，**同名行也算在内**）：
/// 列表里可勾的全勾上 `true`，勾了一部分 `"mixed"`，一个没勾 `false`
export function selectAllState(pickable: string[], chosen: string[]): boolean | "mixed" {
  const on = pickable.filter((name) => chosen.includes(name)).length;
  if (pickable.length > 0 && on === pickable.length) return true;
  return on > 0 ? "mixed" : false;
}

/// 按一下全选：已经全勾上就全部取消（只动列表里这些），否则把列表里的全部勾上
export function toggleAll(pickable: string[], chosen: string[]): string[] {
  return selectAllState(pickable, chosen) === true
    ? chosen.filter((name) => !pickable.includes(name))
    : [...new Set([...chosen, ...pickable])];
}

/// 主动作的字：含替换时写明这次会替换几个（`添加 38 个（替换 1 个）`），不含时照旧
export function addLabel(count: number, replacing: number): string {
  return replacing > 0 ? `添加 ${count} 个（替换 ${replacing} 个）` : `添加 ${count} 个`;
}
