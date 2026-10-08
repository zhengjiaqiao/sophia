/// 位置页来源的两种数据源（skill / MCP）：来源行（`SourceRow.tsx`）与添加来源页同一套骨架，
/// 这里把两边的命令与造句换成同一种行、目标、候选与移除，页面只认这一种形状。不产 JSX。
import { api } from "../api";
import { t, tn } from "../i18n.ts";
import { sourceNoun } from "../terms.ts";
import { mcpAgentName } from "../mcpView.ts";
import type { AutoRun, McpLocation, McpReport, McpService, SyncReport, Target } from "../types";
import type { ToastProps } from "../ui";
import type { ToastTier } from "../toastText";
import {
  addSourceTitle,
  noSkillCandidates,
  sameNameItems,
  type CandidateEntry,
} from "./addSourceView.ts";
import {
  candidateGroups,
  duplicateNames,
  mcpCandidateGroups,
  mcpOwnRemoveReason,
  mcpRemoveConfirmBody,
  mcpSourceLines,
  mcpSourceName,
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
export type ToastText = Pick<ToastProps, "kind" | "sentence" | "names" | "reason" | "tally"> & {
  tier: ToastTier;
};

/// 列表里的一行
/// MCP 的 `同名`：同名的服务在主视图合成一行（不像 skill 各成一行），两份不一样时行上标 `2 份不一样`
export const mcpSameNameTip = () => t("sources.mcp.sameNameTip");

export interface SourceRow {
  /// 行键，也是移除时交给 core 的来源 id
  id: string;
  name: string;
  /// 第二行：在哪（`~/.agents/skills`、`全局`）与数量（`24 个 skill`、`5 个 MCP`）；
  /// 放不下只截前一段
  sub: { where: string; count: string };
  /// 完整路径，给提示框
  path: string;
  /// 名字写的就是路径（MCP 这个生效范围自己的配置文件）：同上级 MCP 表格的「配置文件」格——等宽小字、留住文件名
  pathName?: boolean;
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
  /// 来源的种类 skill / MCP：规则句、目标小框的读数与无障碍名、数量各按种类取整句
  noun: "skill" | "MCP";
  /// 这件事叫什么（terms.sourceNoun）：skill `原件位置`，MCP `来源`
  word: string;
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

const ruleTitle = () => t("sources.rule.title");

/// 做完一批：全部成了是例行一行；有没成的说几个没成、第一个的原因。
/// `reasonKey`：skill 是 `有 N 处入口清除失败 · …`，MCP 是 `有 N 项移除失败 · …`
function removalToast(
  total: number,
  failed: string[],
  reasonKey: "sources.removal.failedLinks" | "sources.removal.failedItems",
): ToastText {
  if (failed.length === 0) {
    return { tier: "routine", kind: "success", sentence: "sources.removal.done" };
  }
  return {
    tier: "notice",
    kind: "partial",
    sentence: "sources.removal.partial",
    tally: { done: total - failed.length, failed: failed.length },
    // 分不出原因（core 给空串）只写主句；MCP 那条的原因来自写入报告，不会为空
    reason:
      reasonKey === "sources.removal.failedLinks" && !failed[0]
        ? tn("sources.removal.failedLinksPlain", failed.length)
        : tn(reasonKey, failed.length, { first: failed[0] }),
  };
}

/// skill：来源是一个放着 skill 的文件夹，目标是这个位置的 agent 列
export function skillSourcesModel(domain: DomainRef, targets: Target[]): SourcesModel {
  const open = targets.filter((tg) => tg.linkedWholeTo === null);
  return {
    title: sourcesTitle(domain),
    addTitle: addSourceTitle(domain, "skill"),
    emptyText: noSourcesText(domain),
    noun: "skill",
    word: sourceNoun("skills"),
    noTargetsReason: t("sources.skill.noTargetsReason"),
    targetsLabel: t("sources.skill.targetsLabel"),
    emptyItems: t("sources.skill.emptyItems"),
    ownRemoveReason: ownRemoveReason(domain),
    canPickFolder: true,
    noCandidates: noSkillCandidates(),
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
              ? { text: t("sources.tag.sameName"), tip: t("sources.skill.sameNameTip") }
              : undefined,
          })),
          targets: s.autoLink ? s.autoTargets : [],
          lastAuto: s.lastAuto ?? null,
          switchReason: s.canAutoLink ? undefined : t("sources.skill.switchNoAuto"),
          switchTitle: ruleTitle(),
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
      targets.map((tg) => ({
        id: tg.id,
        iconId: tg.scope.harnessId,
        label: tg.label,
        disabledReason:
          tg.linkedWholeTo === null
            ? undefined
            : t("sources.skill.wholeLinked", { label: tg.label }),
      })),
    pickable: () => open.map((tg) => tg.id),
    subscribe: (ref) => api.subscribeSource(domain.key, ref),
    pickFolder: () => api.pickDirectory(t("sources.skill.pickDialog")),
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
          targets.map((tg) => tg.id),
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
          return removalToast(report.entries.length, failed, "sources.removal.failedLinks");
        },
      };
    },
  };
}

/// 位置名；主视图里藏起来的那一处（还没建的 .mcp.json）说清点下去会发生什么
const mcpTargetLabel = (l: McpLocation) =>
  l.matrixHidden === true && l.selector === undefined
    ? t("sources.mcp.newFile", { name: mcpSourceName(l) })
    : mcpSourceName(l);

/// MCP：来源是一处配置，目标是这个位置的全部配置位置（包含主视图藏起来的；来源自己那处不能当目标）
export function mcpSourcesModel(domain: DomainRef, locations: McpLocation[]): SourcesModel {
  const nameOf = (id: string) => {
    const l = locations.find((x) => x.id === id);
    return l ? mcpSourceName(l) : id;
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
    if (tip !== null) {
      return { name: x.name, tag: { text: t("sources.tag.unsupported"), tip }, dim: true };
    }
    return sameName(x.name)
      ? { name: x.name, tag: { text: t("sources.tag.sameName"), tip: mcpSameNameTip() } }
      : { name: x.name };
  };
  return {
    title: mcpSourcesTitle(domain),
    addTitle: addSourceTitle(domain, "mcp"),
    emptyText: noMcpSourcesText(domain),
    noun: "MCP",
    word: sourceNoun("mcp"),
    noTargetsReason: t("sources.mcp.noTargetsReason"),
    targetsLabel: t("sources.mcp.targetsLabel"),
    emptyItems: t("sources.mcp.emptyItems"),
    ownRemoveReason: mcpOwnRemoveReason(domain),
    canPickFolder: false,
    noCandidates: t("sources.mcp.noCandidates"),
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
            pathName: s.own && s.harnessId !== "weiboap",
            items: s.services.map((x) => serviceItem(x, mcpAgentName(s), s.id, dupAmongSubscribed)),
            targets: s.autoTargets,
            lastAuto: s.lastAuto ?? null,
            switchReason: s.unreadable ? t("sources.mcp.unreadable") : undefined,
            switchTitle: crossDomain
              ? t("sources.mcp.crossDomainTitle", { rule: ruleTitle() })
              : ruleTitle(),
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
            items: i.services.map((x) => serviceItem(x, i.agent, i.id, takenBySubscribed)),
          })),
        })),
      };
    },
    targetsFor: (row) =>
      locations.map((l) => ({
        id: l.id,
        iconId: l.harnessId,
        label: mcpTargetLabel(l),
        disabledReason: l.id === row.id ? t("sources.mcp.selfTarget") : undefined,
      })),
    pickable: (row) =>
      locations.filter((l) => l.matrixHidden !== true && l.id !== row.id).map((l) => l.id),
    subscribe: (ref) => api.subscribeMcpSource(domain.key, ref),
    pickFolder: async () => null,
    previewFolder: () => Promise.reject(new Error(t("sources.mcp.noFolder"))),
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
            e.outcome === "removed"
              ? []
              : [
                  t("sources.mcp.removeFailedItem", {
                    name: e.name,
                    place: nameOf(e.targetId),
                    message: e.message,
                  }),
                ],
          );
          return removalToast(report.entries.length, failed, "sources.removal.failedItems");
        },
      };
    },
  };
}
