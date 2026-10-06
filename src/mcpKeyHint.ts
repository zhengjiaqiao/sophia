/// 密钥提醒接到移动 / 复制与自动同步规则（spec 2026-10-05-skill-mcp-batch2「密钥提醒（S19）」，issue #113）。
/// 纯逻辑：确认框出不出「同时加进 .gitignore」、提示条在原因的位置接哪一句。判断在 core（`keyhint::decide`）
import { listText, t } from "./i18n.ts";
import { keyHintTip, keyTrackedNote } from "./market/installView.ts";
import { projectName } from "./sidebarProjects.ts";
import type { McpKeyHint, McpReport } from "./types.ts";

/// 移动 / 复制的确认框：选中的去处里有「第一次暴露」（`remind`）的就出默认不勾的「同时加进 .gitignore」，
/// 返回它的提示框文字（同安装页一套：哪几个文件、不加会怎样、在哪个项目的 .gitignore 里加几行）；不出时为 null。
/// 来源已提交过、来源被忽略（写成后自动加）、目标不是仓库或已被忽略、没有密钥都不出。检查没回来先不出
export function scopeKeyHintTip(hints: ReadonlyArray<McpKeyHint> | null): string | null {
  const remind = (hints ?? []).filter((h) => h.hint === "remind");
  if (remind.length === 0) return null;
  const uniq = (xs: string[]) => [...new Set(xs)];
  return keyHintTip(
    uniq(remind.map((h) => h.gitignoreLine)),
    listText(uniq(remind.map((h) => projectName(h.project)))),
  );
}

/// 移动 / 复制的确认框：选中的去处里有目标文件已被 git 跟踪的（`tracked`，加进 .gitignore 也挡不住）——不出勾选，
/// 在勾选的位置说一句（同安装页 `keyTrackedNote`：只有一个目标、又没有同时出现的勾选时不点名，其余写出是哪几个）；
/// 没有时为 null
export function scopeTrackedNote(hints: ReadonlyArray<McpKeyHint> | null): string | null {
  const tracked = (hints ?? []).filter((h) => h.hint === "tracked");
  if (tracked.length === 0) return null;
  const withCheckbox = (hints ?? []).some((h) => h.hint === "remind");
  const targets = new Set(tracked.map((h) => h.targetId));
  return keyTrackedNote(
    [...new Set(tracked.map((h) => h.gitignoreLine))],
    withCheckbox || targets.size > 1,
  );
}

/// 确认时确认框里对哪几个目标（位置 id）说过什么：`remind` 出了勾选的，`tracked` 出了已被跟踪那一句的。按目标记：
/// 说过的提示条不再说，没说过的——检查之后又变了，比如勾选护着的那个文件确认前被 git add 了——照样说（issues #147、#155）；
/// 检查没回来（null）按都没说过
export function askedTargets(hints: ReadonlyArray<McpKeyHint> | null): {
  remind: string[];
  tracked: string[];
} {
  const of = (kind: McpKeyHint["hint"]) =>
    (hints ?? []).filter((h) => h.hint === kind).map((h) => h.targetId);
  return { remind: of("remind"), tracked: of("tracked") };
}

/// 写完那一窗在原因的位置接的一句（与别的原因用 ` · ` 连着，见 `joinReasons`）：来源被忽略、目标自动加进了
/// .gitignore 的说「已加进 .gitignore」；`unasked`（没问过用户：自动同步规则上没有勾选，或确认框里没出勾选——
/// 检查之后来源又变了）把密钥第一次写进仓库、没加的说「密钥会随仓库提交，没加进 .gitignore」——确认框里
/// 问过、用户自己没勾的不再说；写进了已被跟踪的文件、没问过用户的说「密钥会随仓库提交（这个文件已在仓库里）」——
/// 确认框里已经出过那句说明的不再说；没加成的说原因
export function keyHintNote(
  report: Pick<McpReport, "autoIgnored" | "keyExposed" | "keyTracked" | "gitignoreFailed">,
  unasked: boolean,
): string | undefined {
  return joinReasons(
    report.autoIgnored ? t("mcp.report.autoIgnored") : undefined,
    unasked && report.keyExposed ? t("mcp.report.keyExposed") : undefined,
    unasked && report.keyTracked ? t("mcp.report.keyTracked") : undefined,
    report.gitignoreFailed,
  );
}

/// 「保留这份」与修改生效范围的结果提示条（issues #147、#155）：同 `keyHintNote`，只是问没问过用户按目标算——确认框里对它出过勾选的
/// 不再说「没加进 .gitignore」，出过已被跟踪那一句的不再说那一句；没说过的（检查之后来源又变了、勾选护着的文件
/// 确认前被跟踪了）照样说
export function keyHintNoteAsked(
  report: Pick<
    McpReport,
    "autoIgnored" | "keyExposed" | "keyTracked" | "gitignoreFailed" | "ignorable" | "trackedTargets"
  >,
  asked: { remind: ReadonlyArray<string>; tracked: ReadonlyArray<string> },
): string | undefined {
  const unasked = (ids: ReadonlyArray<string> | undefined, seen: ReadonlyArray<string>) =>
    (ids ?? []).some((id) => !seen.includes(id));
  return keyHintNote(
    {
      ...report,
      keyExposed: Boolean(report.keyExposed) && unasked(report.ignorable, asked.remind),
      keyTracked: Boolean(report.keyTracked) && unasked(report.trackedTargets, asked.tracked),
    },
    true,
  );
}

type KeyFacts = Pick<
  McpReport,
  "autoIgnored" | "keyExposed" | "keyTracked" | "gitignoreFailed" | "ignorable"
>;

/// 点格子写入写成的那一条（产品负责人 2026-10-06）：原因位置接哪一句（同自动同步规则：没问过用户），给不给紧凑键
/// 「加进 .gitignore」——密钥第一次写进仓库、还能补加的（`ignorable`）才给；自动加了的、已被跟踪的只说
export function cellKeyHint(report: KeyFacts): { note: string | undefined; addGitignore: boolean } {
  return {
    note: keyHintNote(report, true),
    addGitignore: (report.ignorable ?? []).length > 0,
  };
}

/// 点了「加进 .gitignore」之后那一条的事实：加成了按「已加进 .gitignore」说、键收起；没加成照旧说会随仓库提交，
/// 接上没加成的原因，键也收起（不在提示条上反复重试）；写成之后文件又被跟踪了（`keyTracked`，加了也挡不住）
/// 改说「密钥会随仓库提交（这个文件已在仓库里）」
export function afterGitignoreAdd(
  report: KeyFacts,
  added: Pick<McpReport, "gitignoreFailed" | "keyTracked">,
): KeyFacts {
  const failed = added.gitignoreFailed !== undefined;
  const tracked = Boolean(added.keyTracked);
  return {
    ...report,
    autoIgnored: Boolean(report.autoIgnored) || (!failed && !tracked),
    keyExposed: failed ? report.keyExposed : false,
    keyTracked: Boolean(report.keyTracked) || tracked,
    gitignoreFailed: added.gitignoreFailed ?? report.gitignoreFailed,
    ignorable: [],
  };
}

/// 几句原因并在一处（提示条的 `reason` 只有一个位置），不互相遮住；都没有为 undefined
export const joinReasons = (
  ...parts: ReadonlyArray<string | null | undefined>
): string | undefined => parts.filter((x) => x).join(" · ") || undefined;
