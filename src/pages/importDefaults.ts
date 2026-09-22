/// 两张添加页（skill / MCP）共用的纯逻辑：默认目标、记住上次的目标、按列切。
/// 不碰 api、不产 JSX。

/// 这个来源上次添加时点亮的目标，以及连续几次点的是同一组
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
