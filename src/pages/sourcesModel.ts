/// 位置页来源的两种数据源（skill / MCP）：来源行（`SourceRow.tsx`）与添加来源页同一套骨架，
/// 这里把两边的命令与造句换成同一种行、目标、候选与移除，页面只认这一种形状。不产 JSX。
import { api } from "../api";
import type { AutoRun, McpLocation, McpReport, McpService, SyncReport, Target } from "../types";
import type { ToastProps } from "../ui";
import type { ToastTier } from "../toastText";
import {
  NO_SKILL_CANDIDATES,
  addSourceTitle,
  sameNameItems,
  type CandidateEntry,
} from "./addSourceView.ts";
import {
  candidateGroups,
  duplicateNames,
  mcpCandidateGroups,
  mcpLocationName,
  mcpOwnRemoveReason,
  mcpRemoveConfirmBody,
  mcpSourceLines,
  mcpSourceSubtitle,
  mcpSourcesTitle,
  noMcpSourcesText,
  noSourcesText,
  ownRemoveReason,
  removeConfirmBody,
  sourceNames,
  sourceSubtitle,
  sourcesTitle,
  mcpStuckTip,
  type DomainRef,
} from "./sourcesView.ts";

/// 提示条的内容；到点消失与关闭由页面补上。`tier` 是页面自己的（notice 档才给 ×），Toast 只看 kind
export type ToastText = Pick<ToastProps, "kind" | "verb" | "names" | "reason" | "tally"> & {
  tier: ToastTier;
};

/// 列表里的一行
/// MCP 的 `同名`：同名的服务在主视图合成一行（不像 skill 各成一行），两份不一样时行上标 `2 份不一样`
export const MCP_SAME_NAME_TIP =
  "这里已有同名的服务，加进来后在主视图同一行；两份不一样时行上会标出来";

export interface SourceRow {
  /// 行键，也是移除时交给 core 的来源 id
  id: string;
  name: string;
  /// 第二行：在哪（`~/.agents/skills`、`全局`）与数量（`24 个 skill`、`5 个 MCP`）；
  /// 放不下只截前一段
  sub: { where: string; count: string };
  /// 完整路径，给提示框
  path: string;
  /// 这个位置自己的：不能移除
  own: boolean;
  /// 展开区：名字，与行尾的标签（`同名` / `搬不过去`）
  items: { name: string; tag?: { text: string; tip: string }; dim?: boolean }[];
  /// 规则此刻的目标 id；空＝关着
  targets: string[];
  /// 规则在这个位置最近一次真正加上 / 写进了东西的执行；没有为 null（目标框的提示框写它）
  lastAuto: AutoRun | null;
  /// 开关打不开的原因（关着时才用）；undefined＝能开
  switchReason?: string;
  /// 开关的提示框
  switchTitle: string;
  /// 规则认这个来源的什么：skill 是路径，MCP 是位置 id
  ruleRef: string;
  /// MCP：来源在别的位置（写过去要允许跨域）
  crossDomain: boolean;
}

/// 目标浮层里的一项
export interface TargetOption {
  id: string;
  /// 图标用的 agent id
  iconId: string;
  label: string;
  disabledReason?: string;
}

/// 添加来源页 `建议的来源` 的一组
export interface CandidateGroup {
  title: string;
  items: CandidateEntry[];
}

export interface SourcesData {
  rows: SourceRow[];
  groups: CandidateGroup[];
}

export interface SourcesModel {
  /// 页名：`CardBox 的来源` / `CardBox 的 MCP 来源`
  title: string;
  /// 添加来源页的页名：`添加来源到「CardBox」` / `添加 MCP 来源到「CardBox」`
  addTitle: string;
  emptyText: string;
  /// 数量单位与开关的无障碍名里用：skill / MCP
  noun: string;
  /// 开关开着时行上写的：`自动加到` / `自动写进`
  ruleOn: string;
  /// 最近一次自动执行的动词：`2 分钟前 · 加到 3 个` / `… · 写进 3 个`
  ranVerb: string;
  /// 目标小框的提示与浮层的名字
  targetsTitle: string;
  /// 目标图标认不出来时小框里写 `N 个 agent` / `N 个位置`
  targetUnit: string;
  /// 没有能当目标的时，开关打不开的原因
  noTargetsReason: string;
  targetsLabel: string;
  /// 展开区没有东西时写的
  emptyItems: string;
  /// 自己的来源 × 禁用的原因
  ownRemoveReason: string;
  /// 添加来源页里有没有「选择文件夹…」
  canPickFolder: boolean;
  /// 添加来源页没有建议的来源时，`建议的来源` 下写的
  noCandidates: string;
  /// 记住上次目标用的 key
  memoryKey: (rowId: string) => string;
  load: () => Promise<SourcesData>;
  /// 这一行的目标浮层
  targetsFor: (row: SourceRow) => TargetOption[];
  /// 打开开关时默认目标从这些里挑（先后即优先）
  pickable: (row: SourceRow) => string[];
  subscribe: (ref: string) => Promise<void>;
  /// 选择文件夹：返回选中的路径，取消为 null
  pickFolder: () => Promise<string | null>;
  /// 选好的文件夹订阅之前的只读预览；`rows` 是已订阅的来源（标 `同名` 用）。
  /// `id` 是 core 认出的来源 id：与已订阅的某行相同＝已经在这里了
  previewFolder: (path: string, rows: SourceRow[]) => Promise<CandidateEntry>;
  /// 把规则的目标从 `prev` 改成 `next`；`next` 为空＝关掉
  setTargets: (row: SourceRow, next: string[], prev: string[]) => Promise<void>;
  /// 移除前的清单：确认框正文，以及确认后要执行的那一步（返回提示条内容，不含名字）
  planRemove: (row: SourceRow) => Promise<{ body: string; commit: () => Promise<ToastText> }>;
}

const RULE_TITLE = "只管以后新出现的，现有的不变";

/// 做完一批：全部成了是例行一行；有没成的说几个没成、第一个的原因
function removalToast(total: number, failed: string[], what: string): ToastText {
  if (failed.length === 0) return { tier: "routine", kind: "success", verb: "已移除" };
  return {
    tier: "notice",
    kind: "partial",
    verb: "移除",
    tally: { done: total - failed.length, failed: failed.length },
    reason: `有 ${failed.length} ${what}：${failed[0]}`,
  };
}

/// skill：来源是一个放着 skill 的文件夹，目标是这个位置的 agent 列
export function skillSourcesModel(domain: DomainRef, targets: Target[]): SourcesModel {
  const open = targets.filter((t) => t.linkedWholeTo === null);
  return {
    title: sourcesTitle(domain),
    addTitle: addSourceTitle(domain, "skill"),
    emptyText: noSourcesText(domain),
    noun: "skill",
    ruleOn: "自动加到",
    ranVerb: "加到",
    targetsTitle: "改自动加到的 agent",
    targetUnit: "个 agent",
    noTargetsReason: "这里还没有能加到的 agent",
    targetsLabel: "自动加到的 agent",
    emptyItems: "文件夹里现在没有 skill",
    ownRemoveReason: ownRemoveReason(domain),
    canPickFolder: true,
    noCandidates: NO_SKILL_CANDIDATES,
    memoryKey: (id) => `skill|${domain.key}|${id}`,
    load: async () => {
      const list = await api.listSources(domain.key);
      const dups = duplicateNames(list.subscribed);
      const names = sourceNames(list.subscribed);
      const taken = list.subscribed.map((s) => s.skills);
      // 候选按路径订阅；加上之后它在主视图筛选片、来源管理页行上的键是来源 id
      const idOf = new Map([...list.elsewhere, ...list.detected].map((c) => [c.path, c.id]));
      return {
        rows: list.subscribed.map((s) => ({
          id: s.id,
          name: names.get(s.id) ?? s.label,
          sub: sourceSubtitle(s),
          path: s.path,
          own: s.own,
          items: s.skills.map((name) => ({
            name,
            tag: dups.has(name)
              ? { text: "同名", tip: "两份都在列表里，到行上只留一份" }
              : undefined,
          })),
          targets: s.autoLink ? s.autoTargets : [],
          lastAuto: s.lastAuto ?? null,
          switchReason: s.canAutoLink ? undefined : "外部来源看不到以后新出现的 skill",
          switchTitle: RULE_TITLE,
          ruleRef: s.path,
          crossDomain: false,
        })),
        groups: candidateGroups(list).map((g) => ({
          title: g.title,
          items: g.items.map((i) => ({
            ref: i.path,
            id: idOf.get(i.path) ?? i.path,
            name: i.name,
            sub: i.sub,
            title: i.path,
            count: i.skills.length,
            items: sameNameItems(i.skills, taken),
          })),
        })),
      };
    },
    targetsFor: () =>
      targets.map((t) => ({
        id: t.id,
        iconId: t.scope.harnessId,
        label: t.label,
        disabledReason:
          t.linkedWholeTo === null
            ? undefined
            : `${t.label} 的 skills 文件夹整个是链接，拆开后才能逐个开关`,
      })),
    pickable: () => open.map((t) => t.id),
    subscribe: (ref) => api.subscribeSource(domain.key, ref),
    pickFolder: () => api.pickDirectory("选择放着 skill 的文件夹"),
    previewFolder: async (path, rows) => {
      const s = await api.previewSourceFolder(path);
      return {
        id: s.id,
        ref: path,
        name: s.label,
        sub: s.shortPath,
        title: s.path,
        count: s.skills.length,
        items: sameNameItems(
          s.skills,
          rows.map((r) => r.items.map((i) => i.name)),
        ),
      };
    },
    setTargets: async (row, next, prev) => {
      if (next.length === 0) {
        await api.removeAutoLinkTargets(
          row.ruleRef,
          targets.map((t) => t.id),
        );
        return;
      }
      const added = next.filter((id) => !prev.includes(id));
      const removed = prev.filter((id) => !next.includes(id));
      if (added.length > 0) await api.setAutoLink(row.ruleRef, added);
      if (removed.length > 0) await api.removeAutoLinkTargets(row.ruleRef, removed);
    },
    planRemove: async (row) => {
      const removal = await api.planRemoveSource(domain.key, row.id);
      return {
        body: removeConfirmBody(removal.links),
        commit: async () => {
          const report: SyncReport = await api.removeSource(domain.key, row.id);
          const failed = report.entries.flatMap((e) =>
            e.outcome.status === "failed" ? [e.outcome.reason] : [],
          );
          return removalToast(report.entries.length, failed, "条软链没撤掉");
        },
      };
    },
  };
}

/// 位置名；主视图里藏起来的那一处（还没建的 .mcp.json）说清点下去会发生什么
const mcpTargetLabel = (l: McpLocation) =>
  l.matrixHidden === true && l.selector === undefined
    ? `${mcpLocationName(l)}（新建 .mcp.json）`
    : mcpLocationName(l);

/// MCP：来源是一处配置，目标是这个位置的全部配置位置（包含主视图藏起来的；来源自己那处不能当目标）
export function mcpSourcesModel(domain: DomainRef, locations: McpLocation[]): SourcesModel {
  const nameOf = (id: string) => {
    const l = locations.find((x) => x.id === id);
    return l ? mcpLocationName(l) : id;
  };
  /// 展开后的一行服务：搬不过去（哪儿都搬不过去，或这里显示的位置一家都接不住）才标签 + 变淡
  /// 一个服务名与名字后的标签：搬不过去优先（这一份用不上），否则与别的来源同名的挂 `同名`
  /// （同 skill：添加页候选与来源管理页的行都标；MCP 同名的服务在主视图合成一行）
  const serviceItem = (
    x: McpService,
    source: string,
    sourceId: string,
    sameName: (name: string) => boolean,
  ) => {
    const tip = mcpStuckTip(
      x,
      source,
      locations.filter((l) => l.id !== sourceId),
    );
    if (tip !== null) return { name: x.name, tag: { text: "不支持", tip }, dim: true };
    return sameName(x.name)
      ? { name: x.name, tag: { text: "同名", tip: MCP_SAME_NAME_TIP } }
      : { name: x.name };
  };
  return {
    title: mcpSourcesTitle(domain),
    addTitle: addSourceTitle(domain, "mcp"),
    emptyText: noMcpSourcesText(domain),
    noun: "MCP",
    ruleOn: "自动写进",
    ranVerb: "写进",
    targetsTitle: "改自动写进的位置",
    targetUnit: "个位置",
    noTargetsReason: "这里还没有能写进的位置",
    targetsLabel: "自动写进的位置",
    emptyItems: "配置里现在没有服务",
    ownRemoveReason: mcpOwnRemoveReason(domain),
    canPickFolder: false,
    noCandidates: "别处还没有能加进来的 MCP 配置",
    memoryKey: (id) => `mcp|${domain.key}|${id}`,
    load: async () => {
      const list = await api.listMcpSources(domain.key);
      // 已订阅的来源里每个服务名出现几次：来源之间同名、候选与已订阅同名，都挂 `同名`
      const seen = new Map<string, number>();
      for (const s of list.subscribed)
        for (const name of new Set(s.services.map((x) => x.name)))
          seen.set(name, (seen.get(name) ?? 0) + 1);
      const dupAmongSubscribed = (name: string) => (seen.get(name) ?? 0) > 1;
      const takenBySubscribed = (name: string) => seen.has(name);
      return {
        rows: list.subscribed.map((s) => {
          const crossDomain = s.domain !== domain.key;
          return {
            id: s.id,
            name: mcpSourceLines(s, domain).name,
            sub: mcpSourceSubtitle(s, domain),
            path: s.path,
            own: s.own,
            items: s.services.map((x) => serviceItem(x, s.label, s.id, dupAmongSubscribed)),
            targets: s.autoTargets,
            lastAuto: s.lastAuto ?? null,
            switchReason: s.unreadable ? "无法读取它的配置，修好之后才能打开" : undefined,
            switchTitle: crossDomain
              ? `${RULE_TITLE}；写到这里会把请求头和令牌一并复制过来`
              : RULE_TITLE,
            ruleRef: s.id,
            crossDomain,
          };
        }),
        groups: mcpCandidateGroups(list).map((g) => ({
          title: g.title,
          items: g.items.map((i) => ({
            ref: i.id,
            id: i.id,
            name: i.name,
            sub: i.sub,
            count: i.services.length,
            items: i.services.map((x) => serviceItem(x, i.name, i.id, takenBySubscribed)),
          })),
        })),
      };
    },
    targetsFor: (row) =>
      locations.map((l) => ({
        id: l.id,
        iconId: l.harnessId,
        label: mcpTargetLabel(l),
        disabledReason: l.id === row.id ? "这就是来源本身，不能写进自己" : undefined,
      })),
    pickable: (row) =>
      locations.filter((l) => l.matrixHidden !== true && l.id !== row.id).map((l) => l.id),
    subscribe: (ref) => api.subscribeMcpSource(domain.key, ref),
    pickFolder: async () => null,
    previewFolder: () => Promise.reject(new Error("MCP 来源不从文件夹添加")),
    setTargets: (row, next) =>
      next.length === 0
        ? api.removeMcpAutoImport(row.ruleRef, domain.key)
        : api.setMcpAutoImport(row.ruleRef, domain.key, next, row.crossDomain),
    planRemove: async (row) => {
      const removal = await api.planRemoveMcpSource(domain.key, row.id);
      return {
        body: mcpRemoveConfirmBody(removal.items, nameOf),
        commit: async () => {
          const report: McpReport = await api.removeMcpSource(domain.key, row.id, removal.items);
          const failed = report.entries.flatMap((e) =>
            e.outcome === "removed" ? [] : [`${e.name}（${nameOf(e.targetId)}）${e.message}`],
          );
          return removalToast(report.entries.length, failed, "项没拿掉");
        },
      };
    },
  };
}
