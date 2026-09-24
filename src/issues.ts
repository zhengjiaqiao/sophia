/// skill 这一侧「要你拿主意」的问题：把散在几十行格子里的异常状况收成一张去重后的列表，
/// 给新问题的一次性提示用（DESIGN「没有收件箱、待处理页和「忽略」」）。问题本身一直在
/// 它那一行、那一格上就地显示与处理，这里只负责认出有哪几条、各自的 key。
/// 纯逻辑，不碰 api、不产 JSX。
///
/// 数据来源是 `viewOf` 的 `issue` 字段（组件规范 §8）：异常态画出来都在同一个环骨架上，
/// 但要拿的主意不同，所以先判状态、再归类。
import { viewOf } from "./cellState.ts";
import type { DomainPage, IssueKind, Overview } from "./types.ts";

/// key 里的分隔符，与 `store.rs` 的 `KEY_SEP` 是同一个 Unit Separator：路径里不会出现它
const KEY_SEP = "\u001f";

/// 类别 + 全部位置排序后拼接，与 core `store::issue_key` 同规则。
///
/// 两边必须同源：这既是去重依据（同一条状况会被多个格命中），也是「这条是不是已经看过」
/// 的判断依据（`api.markIssuesSeen` / `listSeenIssues` 存的就是它）。
/// 路径任一变化 → key 变化 → 自然再提示一次。
export function issueKey(kind: IssueKind, paths: string[]): string {
  return [kind, ...[...paths].sort()].join(KEY_SEP);
}

/// 从 key 里取回涉及的位置。core 的 key 不取摘要、直接留可读的路径串，
/// 「查看」跳到那一行时靠它认出是哪一行、哪一列
export function pathsOfKey(key: string): string[] {
  return key.split(KEY_SEP).slice(1);
}

/// 列表里的先后：同名本体最需要拿主意，排最前；目录不可写多半是一过性的，排最后。
/// 一次性提示只有一条时说的就是排在最前的那条，「查看」也跳到它
const KIND_RANK: Record<IssueKind, number> = {
  duplicateSource: 0,
  brokenLink: 1,
  wholeLinkedTarget: 2,
  readOnlyTarget: 3,
  differentCopies: 4,
  invalidLocation: 5,
};

/// 一条 skill 问题
export interface SkillIssue {
  kind: IssueKind;
  /// 见 `issueKey`
  key: string;
  /// 涉及的全部位置；key 就是由它算的
  paths: string[];
  /// 句子的主语：说 skill 的几类是 skill 名，说目录的（整个文件夹是链接、无法写入）是 agent 名
  subject: string;
  /// 相关 agent 的显示名；认不出列时为 null
  agent: string | null;
  /// 链接失效时：原件已经不在了（孤链，矩阵里成一行、点格清除）。其余类别恒为 false
  gone: boolean;
}

/// 后端路径是「目录 + 分隔符 + 条目名」，两种分隔符都认
/// （不用模板串：串里的反斜杠会让 lint-ui 取文案时引号配错对）
const join = (dir: string, name: string) => dir + (dir.includes("\\") ? "\\" : "/") + name;

const make = (
  kind: IssueKind,
  paths: string[],
  subject: string,
  agent: string | null,
  gone = false,
): SkillIssue => ({ kind, key: issueKey(kind, paths), paths, subject, agent, gone });

/// 遍历当前 overview 的所有格，收出需要用户拿主意的事。
///
/// **去重按 key 做**（类别 + 位置排序后拼接），和 core 的看过表对得上：同名本体会在
/// 每个 agent 下各命中一次，目录无法写入会在每个 skill 上各命中一次，只该算一条。
///
/// `domains` 用来只看其中几个域（「查看」要找这一条在哪个侧栏位置里）；不传看全部。
export function collectIssues(overview: Overview | null, domains?: DomainPage[]): SkillIssue[] {
  if (overview === null) return [];
  const out = new Map<string, SkillIssue>();
  const add = (issue: SkillIssue) => {
    // 先到的那条留着：按格收到的带着 skill 名与 agent 名
    if (!out.has(issue.key)) out.set(issue.key, issue);
  };
  for (const page of domains ?? overview.domains) collectPage(page, overview, add);
  return [...out.values()].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
}

function collectPage(page: DomainPage, overview: Overview, add: (issue: SkillIssue) => void) {
  for (const row of page.rows) {
    const source = overview.sources.find((s) => s.id === row.sourceId) ?? null;
    const ownPath =
      source?.skills.find((s) => s.name === row.skill)?.path ??
      join(source?.path ?? row.sourceId, row.skill);

    for (const cell of row.cells) {
      const target = page.targets.find((t) => t.id === cell.targetId);
      if (target === undefined) continue;
      const kind = viewOf(cell, target, target.label, row.skill).issue;
      if (kind === undefined) continue;

      switch (kind) {
        case "duplicateSource": {
          // pointsTo 为空是防御分支：判 foreign 的那一刻 core 手里正好是 real_path 的结果。
          // 真为空就只拿这一处的本体位置入 key，至少这一条不会和别的状况撞上
          const other = cell.pointsTo;
          add(make(kind, other === null ? [ownPath] : [ownPath, other], row.skill, target.label));
          break;
        }
        case "brokenLink":
          // 落在某一行格上的失效链接：原件还在，点格重新链接
          add(make(kind, [cell.path], row.skill, target.label));
          break;
        case "wholeLinkedTarget": {
          const whole = target.linkedWholeTo;
          add(
            make(
              kind,
              whole === null ? [target.path] : [target.path, whole],
              target.label,
              target.label,
            ),
          );
          break;
        }
        case "readOnlyTarget":
          add(make(kind, [target.path], target.label, target.label));
          break;
      }
    }
  }

  // 目录里那些没有对应行的失效链接：原件早就不在了（孤链）。与上面按格收到的 key 相同的
  // 会被去重掉，剩下的就是孤链
  for (const action of page.broken) {
    const target = page.targets.find((t) => t.path === action.target);
    add(make("brokenLink", [action.targetPath], action.itemName, target?.label ?? null, true));
  }
}
