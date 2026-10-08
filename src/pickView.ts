/// 模型页一层（#259，画板 9UGdeLt4rvg2dm8SpStvHo 第 1、1′、2 屏；DESIGN「### 模型」）：一个 agent 一行、行尾
/// `已选 N 个模型 ▾` 打开选模型浮层。这里是行与浮层的纯逻辑——按钮上的字、第二行按提供商的计数、浮层的搜索与分组、
/// 置灰组的原因、空态、勾选的乐观更新。纯函数，tests/pick-view.test.ts 直接测
import { t, tn } from "./i18n.ts";
import { OFFICIAL_PROVIDER } from "./types.ts";
import type {
  AgentModels,
  GatewayAgent,
  GatewayState,
  ModelRef,
  PickBlocked,
  PickGroup,
  PickedModel,
} from "./types.ts";

/// 模型页列不列这一家：本机支持第三方模型、且这个 agent 装了（不看设置，spec #247「三」）。
/// 还不知道（状态没读回来）为 null
export function agentInstalled(
  gateway: GatewayState | null,
  supported: boolean | null,
  agent: GatewayAgent,
): boolean | null {
  if (supported === false) return false;
  if (supported === null || gateway === null) return null;
  return gateway.agents.some((view) => view.agent === agent && view.installed);
}

/// 两个引用是不是同一个模型
export const sameRef = (a: ModelRef, b: ModelRef): boolean =>
  a.provider === b.provider && a.model === b.model;

export const isOfficial = (ref: ModelRef): boolean => ref.provider === OFFICIAL_PROVIDER;

/// 行尾按钮：一个都没选 `选模型`，否则 `已选 N 个模型`（数的是此刻生效的「已选」，含官方模型）
export function pickButtonLabel(models: AgentModels): string {
  const n = models.picked.length;
  return n === 0 ? t("models.pick.choose") : tn("models.pick.button", n);
}

/// 第二行：按提供商的计数 `官方 2 · Kimi 2 · DeepSeek 1`，按「已选」里第一次出现的先后；一个没选为 null
export function pickCounts(picked: ReadonlyArray<PickedModel>): string | null {
  if (picked.length === 0) return null;
  const counts = new Map<string, number>();
  for (const item of picked) {
    const name = isOfficial(item.ref) ? t("models.pick.official") : item.providerName;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, n]) => `${name} ${n}`).join(" · ");
}

/// 浮层 `已选` 页签上的数：「加入」飞行中的那几枚落地才加（只扣已经在「已选」里的——中途来了一份还没含它的
/// 旧状态时不多扣，走查 2026-10-07）
export function pickedTabCount(
  picked: ReadonlyArray<PickedModel>,
  flying: ReadonlyArray<ModelRef>,
): number {
  return picked.filter((item) => !flying.some((ref) => sameRef(ref, item.ref))).length;
}

/// 第三方模型选了几个（开关能不能打开看它：只有官方模型时没什么可接的）
export const thirdPartyCount = (models: AgentModels): number =>
  models.picked.filter((item) => !isOfficial(item.ref)).length;

/// 组名：官方组写 `官方`，别的是提供商名
export const groupName = (group: PickGroup): string =>
  group.provider === OFFICIAL_PROVIDER ? t("models.pick.official") : group.name;

/// 组头后面那一句：这一组为什么不能选（`agent` 是这一行的显示名）
export function blockedText(blocked: PickBlocked, agent: string): string {
  switch (blocked) {
    case "signedOut":
      return t("models.pick.signedOut", { agent });
    case "officialUnavailable":
      return t("models.pick.officialUnavailable");
    case "readOnly":
      return t("models.pick.readOnly", { agent });
    case "protocol":
      return t("models.pick.protocol", { agent });
  }
}

/// 浮层「全部」的搜索：按显示名与模型 id，不分大小写；组里一个不剩的不列。空串＝全部（含没有模型的组：
/// 改不了的、刚加还没启用的照样列出组头）
export function filterGroups(groups: ReadonlyArray<PickGroup>, query: string): PickGroup[] {
  const term = query.trim().toLowerCase();
  if (term === "") return groups.filter((group) => group.models.length > 0);
  return groups
    .map((group) => ({
      ...group,
      models: group.models.filter(
        (m) =>
          m.displayName.toLowerCase().includes(term) || m.ref.model.toLowerCase().includes(term),
      ),
    }))
    .filter((group) => group.models.length > 0);
}

/// 浮层的页签
export type PickTab = "all" | "picked";

/// 浮层里此刻要说的一句（替代列表的位置）：搜不到、「已选」还空着；没有为 null。
/// 一家提供商都没有另说（`noProviders`），它出在官方组下面、带 `添加模型提供商`
export function pickEmptyText(models: AgentModels, tab: PickTab, query: string): string | null {
  if (tab === "picked") {
    return models.picked.length === 0 ? t("models.pick.nonePicked") : null;
  }
  const term = query.trim();
  if (term !== "" && filterGroups(models.groups, term).length === 0) {
    return t("models.pick.noMatch", { query: term });
  }
  return null;
}

/// 一家模型提供商都没有：浮层「全部」里官方组下面那一句（带 `添加模型提供商`）
export const noProviders = (models: AgentModels): boolean => models.providers === 0;

/// 「已选」页签底部那一句：新选的排在最后；Claude 桌面应用还要说第一个是切过去时先用的
export const pickedFootnote = (agent: GatewayAgent): string =>
  agent === "claude" ? t("models.pick.footClaude") : t("models.pick.foot");

/// 勾选 / 取消之后先画的样子（DESIGN「勾选不闪」）：勾上追加到「已选」末尾、对应格打勾；取消从「已选」里拿掉。
/// 写盘在后台，做不成整份退回后端给的状态
export function pickOptimistic(
  models: AgentModels,
  ref: ModelRef,
  on: boolean,
  shown: { displayName: string; providerName: string },
): AgentModels {
  const has = models.picked.some((item) => sameRef(item.ref, ref));
  const picked = on
    ? has
      ? models.picked
      : [...models.picked, { ref, ...shown }]
    : models.picked.filter((item) => !sameRef(item.ref, ref));
  const groups = models.groups.map((group) => ({
    ...group,
    models: group.models.map((m) => (sameRef(m.ref, ref) ? { ...m, picked: on } : m)),
  }));
  return { ...models, picked, groups };
}

/// 这一下取消的是不是最后一个第三方模型（开着时＝关掉这一家，同今天的规则，不确认）
export function unpicksLast(models: AgentModels, ref: ModelRef): boolean {
  if (isOfficial(ref)) return false;
  const left = models.picked.filter((item) => !isOfficial(item.ref) && !sameRef(item.ref, ref));
  return thirdPartyCount(models) > 0 && left.length === 0;
}

// ----- 排序（#265，画板第 2 屏）-----

/// ⌥↑ / ⌥↓：把第 `index` 项挪 `delta` 格（±1）；到头不动返回 null，否则给新顺序与它的新位置（焦点跟着它走）
export function moveBy<T>(
  list: readonly T[],
  index: number,
  delta: number,
): { list: T[]; index: number } | null {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return null;
  return { list: moveTo(list, index, to), index: to };
}

/// 从 `from` 挪到 `to`（挪完之后它在的位置）
export function moveTo<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/// 拖动时排到第几个：`mids` 是拖动开始时各行的纵向中线（按顺序），指针越过别的行的中线就排到它后面
export function dropIndex(mids: readonly number[], from: number, y: number): number {
  return mids.filter((mid, i) => i !== from && mid < y).length;
}

/// 读屏报的位置：`第 2 个，共 5 个`（`index` 从 0 起）
export const positionText = (index: number, total: number): string =>
  t("models.pick.position", { n: index + 1, total });

/// 排序之后先画的样子：`order` 里的几项在「已选」里原来占的位置上换成新顺序，别的原地不动（同后端 `reorder`）
export function reorderOptimistic(
  models: AgentModels,
  order: ReadonlyArray<ModelRef>,
): AgentModels {
  const inOrder = (ref: ModelRef) => order.some((r) => sameRef(r, ref));
  const moved = order
    .map((ref) => models.picked.find((item) => sameRef(item.ref, ref)))
    .filter((item): item is PickedModel => item !== undefined);
  let at = 0;
  const picked = models.picked.map((item) => (inOrder(item.ref) ? (moved[at++] ?? item) : item));
  return { ...models, picked };
}
