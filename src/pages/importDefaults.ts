/// 来源管理页与主视图共用的纯逻辑：自动添加的默认目标、记住上次的目标、同名来源的区分片段、专名拼句。
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

/// 按钮与说明里的专名不靠空格断词（DESIGN「按钮」）：汉字之间不加空格，中西文之间一个空格。
/// `只留通用仓库的`、`只留 WeiboAP 的`
export function joinWords(...words: string[]): string {
  const latin = /[A-Za-z0-9]/;
  return words.reduce((acc, word) => {
    if (acc === "" || word === "") return acc + word;
    const gap = latin.test(acc[acc.length - 1]) !== latin.test(word[0]) ? " " : "";
    return acc + gap + word;
  }, "");
}
