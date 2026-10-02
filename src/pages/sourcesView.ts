/// 位置页来源（来源片、来源行、添加来源页）的纯逻辑：行上的两行字、同名、移除的提示与确认造句、
/// 添加来源页的候选分组。不碰 api、不产 JSX。
import type {
  CandidateSource,
  McpCandidateSource,
  McpRemovalItem,
  McpSourceList,
  McpSubscribedSource,
  RemovalLink,
  SourceList,
  SubscribedSource,
} from "../types.ts";
import { listText, t, tn, tSpaced } from "../i18n.ts";
import { autoSyncWord } from "../terms.ts";
import { originNames, originText } from "../originName.ts";
import { configPathText } from "../pathText.ts";
import { mcpLocationSentence } from "../mcpView.ts";
import { unportableText } from "../mcpCellState.ts";

/// 位置的最小描述：页面上只用得到 key 与显示名
export interface DomainRef {
  key: string;
  /// `全局` / `CardBox`
  label: string;
}

const isProject = (domain: DomainRef) => domain.key.startsWith("project:");

/// 页名：`CardBox 的来源`、`用户级的来源`
export function sourcesTitle(domain: DomainRef): string {
  return tSpaced("sources.title", { place: domain.label });
}

/// 空态的一句现状：`CardBox 还没有来源`
export function noSourcesText(domain: DomainRef): string {
  return tSpaced("sources.empty", { place: domain.label });
}

/// 行名：与主视图同一个起名函数（`originNames`），按这个位置已订阅的来源成组——
/// 主视图的行也正是这些来源的 skill，同名来源的区分片段两处一样（`WeiboAP · 1776…`）。
/// 项目自己的仓库就写它的来源名 `CardBox · 通用仓库`
export function sourceNames(subscribed: SubscribedSource[]): Map<string, string> {
  const names = originNames(
    subscribed.map((s) => s.id),
    subscribed,
  );
  return new Map(subscribed.map((s) => [s.id, originText(names.get(s.id)!)]));
}

/// 第二行：短路径与数量两段（`~/.agents/skills` · `24 个 skill`）。区分片段已在行名里，不放第二行。
/// 拆成两段给页面：路径长了只截路径，数量完整保留
export function sourceSubtitle(source: SubscribedSource): { where: string; count: string } {
  return { where: source.shortPath, count: tn("sources.count.skill", source.skillCount) };
}

/// 在两个以上已订阅来源里都有的 skill 名：展开区里这些名字后面挂 `同名`
export function duplicateNames(subscribed: SubscribedSource[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const source of subscribed) {
    for (const name of new Set(source.skills)) {
      if (seen.has(name)) dup.add(name);
      seen.add(name);
    }
  }
  return dup;
}

/// 名字列表至多写 5 个，多了写 `前 5 个 等 N 个`
export const LISTED_MAX = 5;

export function listNames(names: string[], max = LISTED_MAX): string {
  const head = listText(names.slice(0, max), "enum");
  return names.length > max ? tn("sources.list.more", names.length, { head }) : head;
}

/// 位置页页面头的 `管理来源`（按下进来源管理页）与来源项右键菜单的第一项
export const manageSources = () => t("sources.manage.skills");
/// × 的提示框：`从 CardBox 移除 WeiboAP（不动原件）`（名字与汉字相接的空格见 `tSpaced`）
export function removeTitle(domain: DomainRef, name: string): string {
  return tSpaced("sources.removeTitle", { place: domain.label, name });
}

/// 自己的来源不能移除：× 禁用的原因
export function ownRemoveReason(domain: DomainRef): string {
  return tSpaced("sources.ownRemove", { place: domain.label });
}

/// 移除确认的标题：`从 CardBox 移除 WeiboAP？`
export function removeConfirmTitle(domain: DomainRef, name: string): string {
  return tSpaced("sources.removeConfirm", { place: domain.label, name });
}

/// 移除确认的正文：会撤掉哪些软链（DESIGN：这是用户要权衡的，才提软链）。
/// - 逐个 skill 的：`这 5 个 skill 在 Claude Code、Codex 下的软链会撤掉：excalidraw、notion…`，
///   多于 5 个写「等 N 个」
/// - 整个 skill 文件夹就是指向它的一条软链的 agent 另起一句
/// - 一条都没有：`它的 skill 会从列表里拿掉，没有软链要撤`
export function removeConfirmBody(links: RemovalLink[]): string {
  const uniq = (xs: string[]) => [...new Set(xs)];
  const perSkill = links.filter((l) => l.skill !== null);
  const whole = uniq(links.filter((l) => l.skill === null).map((l) => l.agent));
  const parts: string[] = [];
  if (perSkill.length > 0) {
    const skills = uniq(perSkill.map((l) => l.skill as string));
    const agents = uniq(perSkill.map((l) => l.agent));
    parts.push(
      tn("sources.removeBody.perSkill", skills.length, {
        agents: listText(agents, "enum"),
        skills: listNames(skills),
      }),
    );
  }
  if (whole.length > 0) {
    parts.push(t("sources.removeBody.whole", { agents: listText(whole, "enum") }));
  }
  return parts.length > 0 ? listText(parts, "semicolon") : t("sources.removeBody.none");
}

/// 添加来源页 `建议的来源` 里的一行
export interface CandidateItem {
  /// 订阅时传给 core 的路径
  path: string;
  /// 第一行：来源名，同名的带区分片段
  name: string;
  /// 第二行灰字：`weibo_assistant 在用`；检测到的写短路径
  sub: string;
  /// 行里外露 / 展开的：它的全部 skill 名（按名排序）
  skills: string[];
}

export interface CandidateGroup {
  title: string;
  items: CandidateItem[];
}

/// 第二行灰字：`weibo_assistant 在用`
const usedInText = (c: { usedIn: { label: string }[] }) =>
  t("sources.candidate.usedIn", {
    places: listText(
      c.usedIn.map((d) => d.label),
      "enum",
    ),
  });

/// 添加来源页 `建议的来源` 的分组：`其他项目在用的`、`检测到的`；空的组不出现。
/// 候选名用同一个起名函数，按页面上的全部来源（已订阅的连同候选）成组：
/// 已订阅了一个 WeiboAP 时，候选里的另一个也带上区分片段
export function candidateGroups(
  list: Pick<SourceList, "subscribed" | "elsewhere" | "detected">,
): CandidateGroup[] {
  const all = [...list.subscribed, ...list.elsewhere, ...list.detected];
  const names = originNames(
    all.map((s) => s.id),
    all,
  );
  const candidateName = (c: CandidateSource) => originText(names.get(c.id)!);
  const groups: CandidateGroup[] = [
    {
      title: t("sources.group.elsewhere"),
      items: list.elsewhere.map((c) => ({
        path: c.path,
        name: candidateName(c),
        sub: usedInText(c),
        skills: c.skills,
      })),
    },
    {
      title: t("sources.group.detected"),
      items: list.detected.map((c) => ({
        path: c.path,
        name: candidateName(c),
        sub: c.shortPath,
        skills: c.skills,
      })),
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}

// ===== MCP 来源管理页（DESIGN「来源管理页 › MCP 同一套」）：来源＝一处配置 =====

/// MCP 的这一页叫「自动同步」（原「管理来源」，spec 2026-09-30-mcp-config-scope R5）：生效范围在页面头下的胶囊里，
/// 页名不跟着变
export function mcpSourcesTitle(_domain: DomainRef): string {
  return autoSyncWord();
}

/// 空态的一句现状：`CardBox 还没有写了 MCP 的配置文件`
export function noMcpSourcesText(domain: DomainRef): string {
  return tSpaced("sources.mcpEmpty", { place: domain.label });
}

/// 位置名写法 `Claude Code · User`（与 core `mcp::sources::source_label` 同一规则）：
/// 去掉 `MCPs` 这类泛称；只有 agent 名的补上作用域，全局 `User`、项目 `Project`；WeiboAP 不补
export function mcpLocationName(location: {
  label: string;
  harnessId: string;
  domain: string;
}): string {
  const base = location.label.replace(/ MCPs$/, "");
  if (base.includes(" · ") || location.harnessId === "weiboap") return base;
  return `${base} · ${location.domain === "global" ? "User" : "Project"}`;
}

/// 行上的名字与第二行灰字（不含 `· N 个 MCP`）。这个生效范围自己的配置文件（R5）：名字写路径（同表格的「配置文件」列），
/// 第二行写是谁的哪一格（`Claude Code 仅自己` / `Codex`）；以前订阅的别处配置照旧写它的名字与它在哪
export function mcpSourceLines(
  source: McpSubscribedSource,
  domain: DomainRef,
): { name: string; sub: string } {
  if (source.own && source.harnessId !== "weiboap") {
    const root = isProject(domain) ? domain.key.slice("project:".length) : undefined;
    return { name: configPathText(source.path, root), sub: mcpLocationSentence(source) };
  }
  return { name: source.label, sub: source.place };
}

/// 第二行两段：`全局` · `5 个 MCP`（与 skill 那边同一种形状）
export function mcpSourceSubtitle(
  source: McpSubscribedSource,
  domain: DomainRef,
): { where: string; count: string } {
  return {
    where: mcpSourceLines(source, domain).sub,
    count: tn("sources.count.mcp", source.services.length),
  };
}

/// 自己的配置不能移除：× 禁用的原因
export function mcpOwnRemoveReason(domain: DomainRef): string {
  return tSpaced("sources.mcpOwn", { place: domain.label });
}

/// 不支持的服务（哪儿都放不过去）：行尾 `不支持` 标签的提示框
export function stuckTip(service: string, source: string): string {
  return unportableText(service, source);
}

/// 一个 MCP 服务在这里放不放得过去（DESIGN「「不支持」按目标 agent 判断，不按服务一刀切」，D24 起
/// 界面词由 `搬不过去` 改为 `不支持`）：哪儿都放不过去（`!portable`），或者只有几家接得住
/// （`onlyHarnesses`，用命令生成请求头的服务）而显示的目标里一家都接不住，才标 `不支持`。
/// 返回标签的提示框；放得过去返回 null。
/// `targets`：这里能写进的位置（来源自己那一处不算）；名字取 agent 那一段（`Cursor · User` → `Cursor`）
export function mcpStuckTip(
  service: { name: string; portable: boolean; onlyHarnesses?: string[] },
  source: string,
  targets: { label: string; harnessId: string; domain: string }[],
): string | null {
  if (!service.portable) return stuckTip(service.name, source);
  const only = service.onlyHarnesses;
  if (only === undefined || targets.some((tg) => only.includes(tg.harnessId))) return null;
  const agents = [...new Set(targets.map((tg) => mcpLocationName(tg).split(" · ")[0]))];
  return agents.length > 0
    ? t("sources.stuck.noHeaderCommand")
    : t("sources.stuck.noPlace", { service: service.name });
}

/// 移除确认的正文：会拿掉哪些配置（服务名 × 位置）。
/// - `这 2 个服务在 Codex · Project、Claude Code · Project 里的那份会拿掉：docs、search`，多于 5 个写「等 N 个」
/// - 一项都没有：`它的服务会从列表里拿掉，没有写进这里的配置要撤`
/// 与来源已经不一样了的那几份不在清单里，也不会动
export function mcpRemoveConfirmBody(
  items: McpRemovalItem[],
  locationName: (targetId: string) => string,
): string {
  if (items.length === 0) return t("sources.mcpRemoveBody.none");
  const names = [...new Set(items.map((i) => i.name))];
  const places = [...new Set(items.map((i) => locationName(i.targetId)))];
  return tn("sources.mcpRemoveBody.some", names.length, {
    places: listText(places, "enum"),
    names: listNames(names),
  });
}

/// 添加 MCP 来源页 `建议的来源` 里的一行：订阅时传位置 id
export interface McpCandidateItem {
  id: string;
  name: string;
  /// 第二行灰字：`CardBox 在用`；检测到的写它在哪
  sub: string;
  /// 行里外露 / 展开的：它的全部服务
  services: McpCandidateSource["services"];
}

/// 添加 MCP 来源页 `建议的来源` 的分组：`其他项目在用的`、`检测到的`；空的组不出现
export function mcpCandidateGroups(
  list: Pick<McpSourceList, "elsewhere" | "detected">,
): { title: string; items: McpCandidateItem[] }[] {
  const item = (c: McpCandidateSource, sub: string) => ({
    id: c.id,
    name: c.label,
    sub,
    services: c.services,
  });
  return [
    {
      title: t("sources.group.elsewhere"),
      items: list.elsewhere.map((c) => item(c, usedInText(c))),
    },
    {
      title: t("sources.group.detected"),
      // 服务数写在行右端，第二行只写在哪
      items: list.detected.map((c) => item(c, c.place)),
    },
  ].filter((g) => g.items.length > 0);
}
