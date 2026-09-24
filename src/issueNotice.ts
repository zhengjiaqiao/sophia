/// 新问题只提示一次（DESIGN「没有收件箱、待处理页和「忽略」」）：每次扫描后，
/// 把三类问题（skill、MCP、模型）里**还没提示过**的收成一个右下黑窗。
/// 点 `查看` 或 `×` 都把这次提示里的全部 key 记为看过；没点就退出，下次打开再提示。
///
/// 这里只放纯逻辑：哪些 key 算新、怎么造句、已有提示时新问题怎么合进去。不碰 api、不产 JSX。
import type { SkillIssue } from "./issues.ts";
import type { McpIssueItem } from "./mcpView.ts";
import type { ModelIssue } from "./modelsView.ts";

/// 问题在哪个页签上就地显示；`查看` 切到这里
export type IssueSegment = "skills" | "mcp" | "models";

/// 提示里的一条
export interface NoticeIssue {
  /// 看过表的 key（skill / MCP 见 `issueKey`，模型见 `ModelIssue.key`）
  key: string;
  segment: IssueSegment;
  /// 句子的主语，提示里加粗：skill 名、服务名、agent 名、网关名
  subject: string;
  /// 主语之后的那半句
  rest: string;
}

/// 两份写「在两处」，更多写数字（中西文之间一个空格）
const inPlaces = (n: number) => (n === 2 ? "在两处" : `在 ${n} 处`);

/// skill 问题 → 提示条目。**无法写入不算**：它只由写入失败当场产生，当场已经报过
export function skillNotices(issues: SkillIssue[]): NoticeIssue[] {
  return issues.flatMap((issue): NoticeIssue[] => {
    const at = { key: issue.key, segment: "skills" as const, subject: issue.subject };
    switch (issue.kind) {
      case "duplicateSource":
        return [{ ...at, rest: "有两份" }];
      case "brokenLink":
        if (issue.gone) return [{ ...at, rest: "的链接指向的原件不在了" }];
        return [{ ...at, rest: issue.agent ? `在 ${issue.agent} 下的链接失效了` : "的链接失效了" }];
      case "wholeLinkedTarget":
        return [{ ...at, rest: "的 skills 文件夹整个是链接" }];
      default:
        return [];
    }
  });
}

/// MCP 问题 → 提示条目
export function mcpNotices(issues: McpIssueItem[]): NoticeIssue[] {
  return issues.map((issue) => {
    const at = { key: issue.key, segment: "mcp" as const };
    if (issue.kind === "differentCopies") {
      return {
        ...at,
        subject: issue.name ?? "",
        rest: `${inPlaces(issue.locations.length)}不一样`,
      };
    }
    const where = issue.locations[0]?.label ?? "";
    return issue.name === null
      ? { ...at, subject: where, rest: "的配置文件无法读取" }
      : { ...at, subject: issue.name, rest: `在 ${where} 里无法读取` };
  });
}

/// 模型问题 → 提示条目。句子由 `modelIssues` 造好，以主语开头
export function modelNotices(issues: ModelIssue[]): NoticeIssue[] {
  return issues.map((issue) => ({
    key: issue.key,
    segment: "models",
    subject: issue.subject,
    rest: issue.sentence.slice(issue.subject.length).trim(),
  }));
}

/// 这一刻该提示的：当前问题里没看过的。
///
/// `shown` 是正在显示的那个提示里的 key（按显示顺序）。已有提示时又发现新问题，
/// **合进同一个窗**：原来那几条排在前面、顺序不变（`查看` 跳去的第一条不会被新来的顶掉），
/// 新的接在后面。已经不存在了的（问题在行上解决了）自然去掉；一条都不剩就不提示。
export function unseenNotices(
  current: NoticeIssue[],
  seen: ReadonlySet<string>,
  shown: readonly string[] = [],
): NoticeIssue[] {
  const fresh = new Map<string, NoticeIssue>();
  for (const issue of current) {
    if (!seen.has(issue.key) && !fresh.has(issue.key)) fresh.set(issue.key, issue);
  }
  const kept = shown.flatMap((key) => {
    const issue = fresh.get(key);
    return issue === undefined ? [] : [issue];
  });
  const keptKeys = new Set(kept.map((issue) => issue.key));
  return [...kept, ...[...fresh.values()].filter((issue) => !keptKeys.has(issue.key))];
}

/// 提示窗的主行：一条时按类别造句（`defuddle 有两份`），多条时 `发现 N 处需要你处理`。
/// `lead` 加粗（主语，或多条时的动词「发现」），`rest` 常规字重
export function noticeLine(issues: NoticeIssue[]): { lead: string; rest: string } | null {
  if (issues.length === 0) return null;
  if (issues.length === 1) return { lead: issues[0].subject, rest: issues[0].rest };
  return { lead: "发现", rest: `${issues.length} 处需要你处理` };
}
