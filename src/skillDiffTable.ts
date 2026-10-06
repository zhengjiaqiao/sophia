import { keepBlockedReason } from "./dupNotice.ts";
import { t } from "./i18n.ts";
import { agentCopyKey, type PlacedAgentCopy } from "./skillsView.ts";

/// skill 同名几份的那张表（issue #111，画板 #105 第七稿第 2、3 节）：同名行抽屉里「N 份不一样」那一段，
/// 与 MCP 共用差异表 `DiffTable`——一行一份，行首位置名，只有「原件」一列（路径），行尾「只留这份」。
/// 纯数据，不碰 api、不画东西；画法在 `DomainView`

export interface SkillCopy {
  /// 这一份那一行的行键
  id: string;
  /// 行首位置名（原件位置名：`~/.agents`、`Claude Code`）
  place: string;
  /// 原件路径（「原件」那一列）
  path: string;
}

export interface SkillDiffRow extends SkillCopy {
  /// 「只留这份」挪走的另一份（行键）；不止两份时没有对家，为 null
  otherId: string | null;
  /// 「只留这份」按不了的原因（另一份在应用包里）；null＝能按
  keepBlocked: string | null;
}

export interface SkillDiffTable {
  rows: SkillDiffRow[];
  /// 行尾「只留这份」出不出：恰好两份（动作不变：留这份、挪走另一份）
  keep: boolean;
}

/// 同名的几份（与表格同序）→ 表：两份时每一行的对家就是另一份，另一份在应用包里时这一行的键禁用
export function skillDiffTable(copies: ReadonlyArray<SkillCopy>): SkillDiffTable {
  const keep = copies.length === 2;
  const rows = copies.map((copy, i) => {
    const other = keep ? copies[1 - i] : undefined;
    return {
      ...copy,
      otherId: other?.id ?? null,
      keepBlocked: other === undefined ? null : keepBlockedReason(other.path),
    };
  });
  return { rows, keep };
}

/// agent 自己目录里的那一份 → 表里的一行（issue #153）：行首 `Claude Code 自己的`，原件列是它的路径。
/// 接在表格里那几行之后，两份时同样能「只留这份」
export const agentCopyRow = (copy: PlacedAgentCopy): SkillCopy => ({
  id: agentCopyKey(copy),
  place: t("skills.dup.agentOwn", { agent: copy.agent }),
  path: copy.path,
});
