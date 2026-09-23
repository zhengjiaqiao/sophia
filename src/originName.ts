/// 原件位置的显示名（DESIGN「「原件位置」列 12 行重复「通用仓库」」）：来源名；同名来源再带上区分片段。
///
/// 原件位置格、工具行来源筛选片、「只留这份」确认框共用这一份，三处写法一致。
/// 名字拆成两段给出：放不下时截来源名那段，区分片段完整保留（`ego… · 0.5.0.32`）。
import { distinguishingSegments } from "./pages/importDefaults.ts";

export interface OriginName {
  /// 来源名（`ego lite`）
  name: string;
  /// 区分片段（`0.5.0.32`）；来源名不重名时为空串
  seg: string;
}

/// 片段最多显示 10 个字符（内部 id 不整段露出来），完整值进提示框
const clip = (seg: string) => (seg.length > 10 ? `${seg.slice(0, 10)}…` : seg);

/// 给 `ids` 里每个来源算显示名。同名的一组用路径里能区分它们的那一级；
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
    group.forEach((id, i) =>
      out.set(id, { name: label, seg: segs[i] && segs[i] !== label ? clip(segs[i]) : "" }),
    );
  }
  return out;
}

/// 一整段的写法：`ego lite · 0.5.0.32`；不重名时就是来源名
export function originText(n: OriginName): string {
  return n.seg ? `${n.name} · ${n.seg}` : n.name;
}
