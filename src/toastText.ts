/// 提示条文案：一次操作的结果 → `Toast` 要的「动词 + 图标 + 名字」（DESIGN「提示条分两档」
/// 「视觉优先：文字只负责名字和动词」）。纯逻辑，不产 JSX、不碰 api；T1 的两张表、
/// T2 的壳、T3 的二级页共用这一份，别处不另写一套造句。
///
/// 签名（T2 / T3 照这个调）：
///
/// ```ts
/// toastFor(op: ToastOp, input: ToastInput): ToastText
///
/// type ToastOp = "link" | "unlink" | "write" | "delete" | "clear" | "split" | "keepThis"
///              | "autoLink" | "autoWrite"
/// interface ToastInput {
///   done: ToastItem[];      // 做成了的：每项一个名字 + 可选 agent
///   failed?: FailedItem[];  // 没做成的：同上 + 一句能行动的原因
///   keepLabel?: string;     // keepThis 专用：留下的那份在哪（「通用仓库」）
/// }
/// interface ToastText {
///   tier: "notice" | "routine"; kind: "success" | "cannot" | "partial";
///   verb: string; verbTail?: string; names: string[]; agents: { id: string; name: string }[];
///   reason?: string; tally?: { done: number; failed: number };
/// }
/// ```
///
/// 返回值可以直接展开给 `<Toast {...text} />`（再补 `action` / `onClose` / `onDismiss`）。
///
/// 规则：
/// - **动词必填且与触发动作一致，带方向**：`加到 [图标] 名字` / `从 [图标] 移除 名字`（后半截动词
///   在 `verbTail`，Toast 写在图标之后）/ 写进 / 清除 / 拆开 / 只留 / 自动加到 / 自动写进。
///   「开启 Claude Code」读成操作应用本身，所以 skill 与 agent 的关系一律带方向（DESIGN 冲突表）；
///   全部没成时用**否定动词**（`没加上` `没移除`）——失败里写「加到」会被一眼读成已加上
/// - 档位（① 严重程度决定打断程度）：**所有成功**一律例行 `routine`——含自动规则在背后做的事、
///   确认过的删除（只留这份）的结果；黑窗 `notice` 只给要停下来看的：做不成、部分失败
/// - 名字去重、保序；多于两个由 `Toast` 自己写成 `+N`，这里不截
/// - agent 图标按 id 去重、保序

import { originText, type OriginName } from "./originName.ts";
import { displayPath } from "./pathText.ts";

export type ToastOp =
  /// skill：加到某个 agent（建链）
  | "link"
  /// skill：从某个 agent 移除（删链）
  | "unlink"
  /// MCP：把一份定义写进某个位置（只新增）
  | "write"
  /// MCP：从某个 agent 的配置里删掉一项（确认过，结果带撤销）
  | "delete"
  /// 清掉失效的链接
  | "clear"
  /// 把整个文件夹是链接的目录拆开
  | "split"
  /// 同名两份：只留这份，另一份删掉（先确认，结果带撤销，见「删除原件」）
  | "keepThis"
  /// 自动规则在背后加上了几个（⑨⑬ 自动发生的事要交代）
  | "autoLink"
  /// MCP 自动规则在背后写进了几个
  | "autoWrite";

export interface ToastAgentRef {
  /// harness id，决定图标
  id: string;
  /// 显示名，读屏用
  name: string;
}

export interface ToastItem {
  /// skill 名 / MCP 服务名 / 目录名
  name: string;
  agent?: ToastAgentRef;
}

export interface FailedItem extends ToastItem {
  /// 一句能行动的原因（「无法写入 Codex 的 skills 目录」），不是错误码
  reason: string;
}

export interface ToastInput {
  done: ToastItem[];
  failed?: FailedItem[];
  /// keepThis：留下的那份所在的来源名，拼进名字里（`通用仓库 的 defuddle`）
  keepLabel?: string;
  /// 对象已经写在旁边时省掉名字（单格的一窗浮在被点那一格下，行已说明对象：`✓ 加到 [Codex]`）
  omitNames?: boolean;
}

export type ToastTier = "notice" | "routine";
export type ToastTextKind = "success" | "cannot" | "partial";

export interface ToastText {
  tier: ToastTier;
  kind: ToastTextKind;
  verb: string;
  /// 动词后半截（写在 agent 图标之后）：`从 [图标] 移除`
  verbTail?: string;
  names: string[];
  agents: ToastAgentRef[];
  reason?: string;
  tally?: { done: number; failed: number };
}

const VERB: Record<ToastOp, string> = {
  link: "加到",
  unlink: "从",
  write: "写进",
  delete: "已从",
  clear: "清除",
  split: "拆开",
  keepThis: "只留",
  autoLink: "自动加到",
  autoWrite: "自动写进",
};

/// 全部没成时的否定动词
const NOT_VERB: Record<ToastOp, string> = {
  link: "没加上",
  unlink: "没移除",
  write: "没写进",
  delete: "没删掉",
  clear: "没清除",
  split: "没拆开",
  keepThis: "没删掉",
  autoLink: "没自动加上",
  autoWrite: "没自动写进",
};

/// 部分失败的汇总：`加上 2 ✓ · 1 ⊘` / `移除 2 ✓ · 1 ⊘`（没有名字跟着，用不带方向的动词）
const PARTIAL_VERB: Partial<Record<ToastOp, string>> = {
  link: "加上",
  unlink: "移除",
  delete: "删除",
  autoLink: "自动加上",
};

/// 带方向的动词后半截：`从 [图标] 移除` / `已从 [图标] 删除`
const VERB_TAIL: Partial<Record<ToastOp, string>> = { unlink: "移除", delete: "删除" };

const uniq = (xs: string[]) => [...new Set(xs)];

const agentsOf = (items: ToastItem[]): ToastAgentRef[] => {
  const out: ToastAgentRef[] = [];
  for (const item of items) {
    if (item.agent && !out.some((a) => a.id === item.agent?.id)) out.push(item.agent);
  }
  return out;
};

export function toastFor(op: ToastOp, input: ToastInput): ToastText {
  const done = input.done;
  const failed = input.failed ?? [];
  const namesOf = (items: ToastItem[]) =>
    input.omitNames
      ? []
      : uniq(
          items.map((i) =>
            op === "keepThis" && input.keepLabel ? `${input.keepLabel} 的 ${i.name}` : i.name,
          ),
        );

  if (done.length === 0 && failed.length > 0) {
    return {
      tier: "notice",
      kind: "cannot",
      verb: NOT_VERB[op],
      names: namesOf(failed),
      agents: agentsOf(failed),
      reason: failed[0].reason,
    };
  }
  if (failed.length > 0) {
    return {
      tier: "notice",
      kind: "partial",
      verb: PARTIAL_VERB[op] ?? VERB[op],
      names: namesOf(done),
      agents: agentsOf(done),
      reason: failed[0].reason,
      tally: { done: done.length, failed: failed.length },
    };
  }
  return {
    // 成功一律例行一行（DESIGN「提示条分两档」：黑块只给失败）
    tier: "routine",
    kind: "success",
    verb: VERB[op],
    verbTail: VERB_TAIL[op],
    names: namesOf(done),
    agents: agentsOf(done),
  };
}

/// 「只留这份」确认框（DESIGN「页面还是弹层」「贴底栏「defuddle 有两份原件，删掉哪个？」」）：
/// 标题问留哪份；正文写哪份进废纸篓、几条链接改指，没有要改指的就不写后半句。
/// 来源名用原件位置列的写法（`originNames`）：同名来源带区分片段（`ego lite · 0.5.1.11`）。
/// `paths` 是标题下的两行：`留下` / `移到废纸篓` + 那一份的完整路径（主目录写 `~`，不截断）
export function keepThisConfirm(input: {
  kept: OriginName & { path: string };
  other: OriginName & { path: string };
  skill: string;
  relinked: number;
}): { title: string; body: string; paths: { label: string; path: string }[] } {
  const trash = `${originText(input.other)} 那份移到废纸篓`;
  return {
    title: `只留 ${originText(input.kept)} 的 ${input.skill}？`,
    body: input.relinked > 0 ? `${trash}，${input.relinked} 条链接改指到这一份` : trash,
    paths: [
      { label: "留下", path: displayPath(input.kept.path) },
      { label: "移到废纸篓", path: displayPath(input.other.path) },
    ],
  };
}

/// 删除 skill 原件的确认框（DESIGN「删除原件」）：说后果，不说机制——删了之后哪些 agent 用不了它、
/// 链接怎么处理、能不能找回。
/// - 别处没有同名原件：`删除后 Codex、Claude Code 都不能再用它：指向它的 2 条软链接一并删除`
/// - 别处有：`删除后 Claude Code 改用 通用仓库 里的同名 graduate（2 条软链接改指过去）；Codex 不能再用它`
/// 不写「可以撤销」（产品负责人：「可以撤销可以去掉」——删完的提示条上有 `撤销`，这里不预告）
/// `ownAgents` 是直接读原件所在目录的 agent（这一行里画 ⦿ 的列）；`linkAgents` 是有链接指向它的 agent。
/// 不写路径行：删的是哪一份，点的那一行已经说了（产品负责人：「这个不需要提示吧」）
export function deleteOriginalConfirm(input: {
  skill: string;
  /// 指向它的链接条数
  links: number;
  /// 别处同名原件的来源名；没有就是链接一并删除
  relinkTo?: string;
  /// 直接读原件所在目录的 agent（去重、保序）
  ownAgents: string[];
  /// 有链接指向它的 agent（去重、保序）
  linkAgents: string[];
}): { title: string; body: string } {
  const list = (names: string[]) => names.join("、");
  const lose = (names: string[]) =>
    names.length > 1 ? `${list(names)} 都不能再用它` : `${list(names)} 不能再用它`;
  const sentences: string[] = [];
  if (input.relinkTo !== undefined && input.links > 0) {
    const moved = `删除后 ${list(input.linkAgents)} 改用 ${input.relinkTo} 里的同名 ${input.skill}（${input.links} 条软链接改指过去）`;
    const own = input.ownAgents.filter((a) => !input.linkAgents.includes(a));
    sentences.push(own.length > 0 ? `${moved}；${lose(own)}` : moved);
  } else {
    const all = [...new Set([...input.ownAgents, ...input.linkAgents])];
    const head = all.length > 0 ? `删除后 ${lose(all)}` : "";
    sentences.push(input.links > 0 ? `${head}：指向它的 ${input.links} 条软链接一并删除` : head);
  }
  return {
    title: `删除 ${input.skill}？`,
    body: sentences.filter((x) => x !== "").join("。"),
  };
}

/// 删完 skill 原件的例行一行：`✓ 已删除 defuddle · 在废纸篓里`。不带撤销——从废纸篓找回，确认框已说清
export function deletedOriginalToast(skill: string, undoable = false): ToastText {
  return {
    tier: "routine",
    kind: "success",
    verb: "已删除",
    names: [skill],
    agents: [],
    // 能撤销时后面跟 `撤销`，不再说去处；挪不进暂存处（跨磁盘）直接进了废纸篓，照实说
    ...(undoable ? {} : { reason: "在废纸篓里" }),
  };
}

/// 撤销删原件之后的一行：全回来了 `✓ 已恢复 defuddle`；原件回来了、有链接没回来是部分失败；
/// 原件都没放回是做不成。`failed` 是撤销报告里没成的那几步的原因（第一条是原件本身时 `bodyBack` 为 false）
export function restoredOriginalToast(
  skill: string,
  input: { bodyBack: boolean; failed: string[] },
): ToastText {
  if (!input.bodyBack)
    return {
      tier: "notice",
      kind: "cannot",
      verb: "没恢复",
      names: [skill],
      agents: [],
      reason: input.failed[0] ?? "",
    };
  if (input.failed.length > 0)
    return {
      tier: "notice",
      kind: "partial",
      verb: "已恢复",
      names: [skill],
      agents: [],
      reason: `${input.failed.length} 条链接没恢复：${input.failed[0]}`,
    };
  return { tier: "routine", kind: "success", verb: "已恢复", names: [skill], agents: [] };
}

/// 点 ⦿ 的确认框（DESIGN「删除原件」MCP；MCP 格子不分原件副本，点哪一格 ⦿ 都是它）：
/// 标题 `从 Codex 删除 weibo-search？`；正文说后果 `删除后 Codex 不能再用它`，这个位置别的 agent 里
/// 还有同名定义时接 `；Claude Code 里的那份不受影响`，没有时接 `，这个 MCP 也会从列表里移除`
/// （产品负责人：「这个位置里就没有它了，应该是这个 mcp 会从列表里移除」）。不写路径、不写「可以撤销」
export function deleteMcpOriginalConfirm(input: {
  agent: string;
  name: string;
  /// 这个位置里还有同名定义的别的 agent（去重、保序）
  others: string[];
}): { title: string; body: string } {
  const after =
    input.others.length > 0
      ? `；${input.others.join("、")} 里的那份不受影响`
      : "，这个 MCP 也会从列表里移除";
  return {
    title: `从 ${input.agent} 删除 ${input.name}？`,
    body: `删除后 ${input.agent} 不能再用它${after}`,
  };
}

/// 批量删除时正文里最多列几个名字，其余写 `等 N 个`（标题已有总数）
const BATCH_NAMES = 12;

/// 选择行全有（⦿）时按下的确认框（DESIGN「表格」MCP 条「选择行」）：确认一次删一批。
/// 标题 `从 Codex 删除 3 个 MCP？`；正文先列名字，再说后果（同单格：`删除后 Codex 不能再用它们`，
/// 这个位置别的 agent 里还有其中哪个的同名定义时接 `；Claude Code 里的同名定义不受影响`；
/// 会删到最后一份的：全部是 `，这些 MCP 也会从列表里移除`，一部分是 `；其中 2 个会从列表里移除`）
export function deleteMcpBatchConfirm(input: {
  /// 要从哪几个 agent 删（去重、保序；按「所有位置」时不止一个）
  agents: string[];
  /// 要删的服务名（去重、保序）
  names: string[];
  /// 这个位置里还留着其中某个同名定义的别的 agent（去重、保序）
  others: string[];
  /// 其中删完就会从列表里移除（这个位置里没有别的同名定义）的个数
  leaving: number;
}): { title: string; body: string } {
  const agents = input.agents.join("、");
  const shown =
    input.names.slice(0, BATCH_NAMES).join("、") +
    (input.names.length > BATCH_NAMES ? ` 等 ${input.names.length} 个` : "");
  const kept = input.others.length > 0 ? `；${input.others.join("、")} 里的同名定义不受影响` : "";
  const leaving =
    input.leaving === 0
      ? ""
      : input.leaving >= input.names.length
        ? "，这些 MCP 也会从列表里移除"
        : `；其中 ${input.leaving} 个会从列表里移除`;
  return {
    title: `从 ${agents} 删除 ${input.names.length} 个 MCP？`,
    body: `${shown}。删除后 ${agents} 不能再用它们${leaving}${kept}`,
  };
}

/// 删完一项 MCP 定义的例行一行：`✓ 已从 [Codex] 删除 weibo-search`（调用方另给 `撤销`，一律给）
export function deletedMcpOriginalToast(name: string, agent?: ToastAgentRef): ToastText {
  return toastFor("delete", { done: [{ name, agent }] });
}

/// 「拆开」确认框（DESIGN「没有收件箱、待处理页和「忽略」」表：整个文件夹是链接，点该列任一格）：
/// 标题问拆哪个 agent 的文件夹，正文说后果
export function splitConfirm(agent: string): { title: string; body: string } {
  return {
    title: `拆开 ${agent} 的 skills 文件夹？`,
    body: "把链接换成真文件夹，里面的内容原样复制过来",
  };
}

/// 批量写入真的慢时触发项旁的那一句（DESIGN「忙碌指示」）：`正在加到 Codex` / `正在从 Codex 移除` /
/// `正在写进 Codex` / `正在从 Codex 删除`（MCP）。agent 为「所有 agent」时照样拼
export function batchBusyText(op: "link" | "unlink" | "write" | "delete", agent: string): string {
  if (op === "unlink") return `正在从 ${agent} 移除`;
  if (op === "delete") return `正在从 ${agent} 删除`;
  return `正在${op === "link" ? "加到" : "写进"} ${agent}`;
}
