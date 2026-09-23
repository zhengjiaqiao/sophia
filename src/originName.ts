/// 来源的显示名（DESIGN「来源名全应用一个写法」）：来源名；同名来源再带上区分片段。
///
/// 全应用只有这一个起名函数：主视图的「来源」列与筛选片、「只留这份」确认框、
/// 来源管理页的行名与移除确认、`+ 来源` 浮层的候选都用它，写法一致。
/// 名字拆成两段给出：放不下时截来源名那段，区分片段完整保留（`ego… · 0.5.0.32`）。
import { distinguishingSegments } from "./pages/importDefaults.ts";

export interface OriginName {
  /// 来源名（`ego lite`）
  name: string;
  /// 区分片段（`0.5.0.32`、`1776…`）；来源名不重名时为空串
  seg: string;
}

/// 片段整段不超过这么长就整段写
const CAP = 10;
/// 要截短时至少留这么多个字符，读起来像编号（`1776…`）
const MIN = 4;
/// 词与词之间的分隔：去掉共有开头时退到它后面，片段从一个词的开头读起。
/// 不含 `.`：版本号 `0.5.0.32` 要整段读
const SEP = /[_\-\s]/;

/// 同名一组的区分段 → 显示用片段（与输入同序，空串原样返回、不参与比较）。
/// - 先去掉几段共有的开头，退到最后一个分隔符之后：`agent_1776…` 与 `agent_1787…` 共有
///   `agent_17`，去掉 `agent_`；
/// - 剩下的不超过 10 个字符整段写，否则截到能与同组其余区分的最短长度（至少 4 个字符）加 `…`；
/// - 组里只有一段（其余的片段就是名字本身）时没有可比的，截到 10 个字符
export function shortSegments(segs: string[]): string[] {
  const chars = segs.map((s) => Array.from(s));
  const live = chars.filter((c) => c.length > 0);
  let head = 0;
  if (live.length >= 2) {
    const shortest = Math.min(...live.map((c) => c.length));
    let common = 0;
    while (common < shortest && live.every((c) => c[common] === live[0][common])) common += 1;
    for (let k = Math.min(common, shortest - 1); k > 0; k -= 1) {
      if (SEP.test(live[0][k - 1])) {
        head = k;
        break;
      }
    }
  }
  return chars.map((mine) => {
    if (mine.length === 0) return "";
    const rest = mine.slice(head);
    if (rest.length <= CAP) return rest.join("");
    let need = 0;
    for (const other of live) {
      if (other === mine) continue;
      const theirs = other.slice(head);
      let k = 0;
      while (k < rest.length && rest[k] === theirs[k]) k += 1;
      need = Math.max(need, k + 1);
    }
    const keep = live.length >= 2 ? Math.max(MIN, need) : CAP;
    return keep >= rest.length ? rest.join("") : `${rest.slice(0, keep).join("")}…`;
  });
}

/// 给 `ids` 里每个来源算显示名。同名的一组用路径里能区分它们的那一级，再按 `shortSegments` 截短；
/// 区分片段就是名字本身（WeiboAP/skills 对 WeiboAP/agent_…/skills）时不重复写。
/// 查不到来源的 id 原样当名字
export function originNames(
  ids: Iterable<string>,
  sources: { id: string; label: string; path: string }[],
): Map<string, OriginName> {
  const sourceOf = (id: string) => sources.find((s) => s.id === id);
  const byLabel = new Map<string, string[]>();
  for (const id of new Set(ids)) {
    const label = sourceOf(id)?.label ?? id;
    byLabel.set(label, [...(byLabel.get(label) ?? []), id]);
  }
  const out = new Map<string, OriginName>();
  for (const [label, group] of byLabel) {
    const segs = distinguishingSegments(group.map((id) => sourceOf(id)?.path ?? id));
    const short = shortSegments(segs.map((s) => (s === label ? "" : s)));
    group.forEach((id, i) => out.set(id, { name: label, seg: short[i] }));
  }
  return out;
}

/// 一整段的写法：`ego lite · 0.5.0.32`；不重名时就是来源名
export function originText(n: OriginName): string {
  return n.seg ? `${n.name} · ${n.seg}` : n.name;
}
