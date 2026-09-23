/// 来源管理页（DESIGN「来源管理页」）的纯逻辑：页名、行上的两行字、同名、移除的提示与确认造句、
/// `+ 来源` 浮层的分组。不碰 api、不产 JSX。
import type { CandidateSource, RemovalLink, SourceList, SubscribedSource } from "../types.ts";
import { joinWords } from "./importDefaults.ts";

/// 位置的最小描述：页面上只用得到 key 与显示名
export interface DomainRef {
  key: string;
  /// `全局` / `CardBox`
  label: string;
}

const isProject = (domain: DomainRef) => domain.key.startsWith("project:");

/// 页名：`CardBox 的来源`、`全局的来源`
export function sourcesTitle(domain: DomainRef): string {
  return joinWords(domain.label, "的来源");
}

/// 空态的一句现状：`CardBox 还没有来源`
export function noSourcesText(domain: DomainRef): string {
  return joinWords(domain.label, "还没有来源");
}

/// 行上的来源名与第二行灰字（不含 `· N 个 skill`）。
/// 项目自己的 skill 写成 `CardBox 自己的 skill` / `项目里`：它的来源名（`CardBox · 通用仓库`）
/// 读不出「这就是项目自己的」；全局里自己的来源（通用仓库、各 agent 的全局目录）照常写名字和路径。
/// 同名来源第二行写区分片段，否则写 `~` 开头的短路径
export function sourceLines(
  source: SubscribedSource,
  domain: DomainRef,
): { name: string; sub: string } {
  if (source.own && isProject(domain)) {
    return { name: joinWords(domain.label, "自己的 skill"), sub: "项目里" };
  }
  return { name: source.label, sub: source.segment || source.shortPath };
}

/// 第二行整句：`~/.agents/skills · 24 个 skill`
export function sourceSubtitle(source: SubscribedSource, domain: DomainRef): string {
  return `${sourceLines(source, domain).sub} · ${source.skillCount} 个 skill`;
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
  const head = names.slice(0, max).join("、");
  return names.length > max ? `${head} 等 ${names.length} 个` : head;
}

/// × 的提示框：`从 CardBox 移除 WeiboAP（不动原件）`
export function removeTitle(domain: DomainRef, name: string): string {
  return `${joinWords("从", domain.label, "移除", name)}（不动原件）`;
}

/// 自己的来源不能移除：× 禁用的原因
export function ownRemoveReason(domain: DomainRef): string {
  return joinWords("它的原件就在", domain.label, "里，删掉原件才会消失");
}

/// 移除确认的标题：`从 CardBox 移除 WeiboAP？`
export function removeConfirmTitle(domain: DomainRef, name: string): string {
  return `${joinWords("从", domain.label, "移除", name)}？`;
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
      `这 ${skills.length} 个 skill 在 ${agents.join("、")} 下的软链会撤掉：${listNames(skills)}`,
    );
  }
  if (whole.length > 0) {
    parts.push(`${whole.join("、")} 的整个 skill 文件夹是指向它的软链，也会撤掉`);
  }
  return parts.length > 0 ? parts.join("；") : "它的 skill 会从列表里拿掉，没有软链要撤";
}

/// `+ 来源` 浮层里的一项
export interface CandidateItem {
  /// 订阅时传给 core 的路径
  path: string;
  /// 第一行：来源名，同名的带区分片段
  name: string;
  /// 第二行灰字：`weibo_assistant 在用`；检测到的写短路径
  sub: string;
}

export interface CandidateGroup {
  title: string;
  items: CandidateItem[];
}

const candidateName = (c: CandidateSource) => (c.segment ? `${c.label} · ${c.segment}` : c.label);

/// `+ 来源` 浮层的候选分组：`其他项目在用的`、`检测到的`；空的组不出现
export function candidateGroups(
  list: Pick<SourceList, "elsewhere" | "detected">,
): CandidateGroup[] {
  const groups: CandidateGroup[] = [
    {
      title: "其他项目在用的",
      items: list.elsewhere.map((c) => ({
        path: c.path,
        name: candidateName(c),
        sub: `${c.usedIn.map((d) => d.label).join("、")} 在用`,
      })),
    },
    {
      title: "检测到的",
      items: list.detected.map((c) => ({ path: c.path, name: candidateName(c), sub: c.shortPath })),
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/// 两列按列读（字母序竖着看）：行数 = 一半向上取整
export function columnRows(count: number): number {
  return Math.max(1, Math.ceil(count / 2));
}
