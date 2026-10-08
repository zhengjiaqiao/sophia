/// 提示条文案：一次操作的结果 → `Toast` 要的「整句 + 图标 + 名字」（DESIGN「提示条分两档」
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
///   sentence: MessageKey;   // 整句的目录键：`{agents}`（图标组）、`{names}`（名字）由 Toast 填
///   names: string[]; agents: { id: string; name: string }[];
///   reason?: string; tally?: { done: number; failed: number };
/// }
/// ```
///
/// 返回值可以直接展开给 `<Toast {...text} />`（再补 `action` / `onClose` / `onDismiss`）。
///
/// 规则：
/// - **一个操作 × 成功 / 做不成 / 部分失败，各一句整句**（`LINE_KEY`，2026-09-30 为多语言改：
///   英文语序不同，不在代码里拼「动词 + 图标 + 后半截动词」）。**动词与触发动作一致，带方向**：
///   `加到 [图标] 名字` / `从 [图标] 移除 名字` / 写进 / 清除 / 拆开 / 只留 / 自动加到 / 自动写进。
///   「开启 Claude Code」读成操作应用本身，所以 skill 与 agent 的关系一律带方向（DESIGN 冲突表）；
///   全部没成的是自己的一句，名字在最前、句尾是 `失败`：`pdf 加到 [Codex] 失败`
///   （2026-09-29 产品负责人：失败句一律「…失败」，不用「没 + 动词」——`没更新` 读起来像状态）
/// - 单格已在行里写着对象时省名字（`omitNames`，只对成功）：用不带 `{names}` 的一句（`加到 [图标]`）
/// - 档位（① 严重程度决定打断程度）：**所有成功**一律例行 `routine`——含自动规则在背后做的事、
///   确认过的删除（只留这份）的结果；黑窗 `notice` 只给要停下来看的：做不成、部分失败
/// - 名字去重、保序；多于两个由 `Toast` 自己写成 `+N`，这里不截
/// - agent 图标按 id 去重、保序

import { listText, t, tn, type MessageKey } from "./i18n.ts";
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
  /// MCP：写进的是项目里的配置（不是用户级）。写进 Copilot 的项目文件要多说一句信任文件夹
  project?: boolean;
  /// 做成了、但有一句要交代的（MCP：Claude Desktop 第三方模式那一份没写成，`McpReportEntry.mirrorFailed`）：
  /// 成功句后接这一句，用失败原因的位置与样式（`reason`）
  note?: string;
  /// 做成了、另有一句平常的交代（MCP：DeepSeek Harness 另有全机补丁时以哪一个为准，`McpReportEntry.note`）：
  /// 与「什么时候生效」同一处（`trail`），同一句只说一次
  trail?: string;
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
  /// keepThis：留下的是 agent 自己目录里的那一份（issue #153），`keepLabel` 是整句说法 `Claude Code 自己那份`，
  /// 名字写成 `Claude Code 自己那份 defuddle`（不再接「的」）
  keepOwn?: boolean;
  /// 对象已经写在旁边时省掉名字（单格的一窗浮在被点那一格下，行已说明对象：`✓ 加到 [Codex]`）。
  /// 只对成功：失败与部分失败的句子少不了名字
  omitNames?: boolean;
}

export type ToastTier = "notice" | "routine";
export type ToastTextKind = "success" | "cannot" | "partial";

interface ToastTextBase {
  tier: ToastTier;
  kind: ToastTextKind;
  names: string[];
  /// 句中的生效范围名（`Toast` 的 `place`）
  place?: string;
  agents: ToastAgentRef[];
  reason?: string;
  tally?: { done: number; failed: number };
  /// 名字后接的读数：MCP 写进之后什么时候生效（`重启 Claude Desktop 后生效`），只在成功时有
  trail?: string[];
}

/// 主行一律是整句（`Toast` 的 `sentence`：目录键，`{agents}`、`{names}` 由 Toast 填）
export type ToastText = ToastTextBase & { sentence: MessageKey };

/// 一个操作的三种整句：成功、全部没成（`cannot`）、部分失败。`bare` 是省名字的成功句（单格）。
/// 句子里 `{agents}` 是图标组、`{names}` 是名字（批量时是数量）
interface LineKeys {
  success: MessageKey;
  bare?: MessageKey;
  cannot: MessageKey;
  partial: MessageKey;
}

const LINE_KEY: Record<ToastOp, LineKeys> = {
  link: {
    success: "toast.line.success.link",
    bare: "toast.line.success.linkBare",
    cannot: "toast.line.cannot.link",
    partial: "toast.line.partial.link",
  },
  unlink: {
    success: "toast.line.success.unlink",
    bare: "toast.line.success.unlinkBare",
    cannot: "toast.line.cannot.unlink",
    partial: "toast.line.partial.unlink",
  },
  write: {
    success: "toast.line.success.write",
    bare: "toast.line.success.writeBare",
    cannot: "toast.line.cannot.write",
    partial: "toast.line.partial.write",
  },
  delete: {
    success: "toast.line.success.delete",
    cannot: "toast.line.cannot.delete",
    partial: "toast.line.partial.delete",
  },
  clear: {
    success: "toast.line.success.clear",
    bare: "toast.line.success.clearBare",
    cannot: "toast.line.cannot.clear",
    partial: "toast.line.partial.clear",
  },
  split: {
    success: "toast.line.success.split",
    cannot: "toast.line.cannot.split",
    partial: "toast.line.partial.split",
  },
  keepThis: {
    success: "toast.line.success.keepThis",
    cannot: "toast.line.cannot.keepThis",
    partial: "toast.line.partial.keepThis",
  },
  autoLink: {
    success: "toast.line.success.autoLink",
    cannot: "toast.line.cannot.autoLink",
    partial: "toast.line.partial.autoLink",
  },
  autoWrite: {
    success: "toast.line.success.autoWrite",
    cannot: "toast.line.cannot.autoWrite",
    partial: "toast.line.partial.autoWrite",
  },
};

/// 名单的连接（`Codex、Claude Code` / `Codex, Claude Code, and Cursor`）
const listOf = (names: readonly string[]) => listText(names);

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
  const line = LINE_KEY[op];
  const namesOf = (items: ToastItem[]) =>
    uniq(
      items.map((i) =>
        op === "keepThis" && input.keepLabel
          ? input.keepOwn
            ? t("toast.keepThis.nameOfOwn", { copy: input.keepLabel, skill: i.name })
            : t("toast.keepThis.nameOf", { label: input.keepLabel, skill: i.name })
          : i.name,
      ),
    );

  if (done.length === 0 && failed.length > 0) {
    return {
      tier: "notice",
      kind: "cannot",
      sentence: line.cannot,
      // 只留这份：名字写 skill 本身（`defuddle 删掉另一份失败`），不带留下的那份的来源
      names: op === "keepThis" ? uniq(failed.map((i) => i.name)) : namesOf(failed),
      agents: agentsOf(failed),
      reason: failed[0].reason,
    };
  }
  if (failed.length > 0) {
    return {
      tier: "notice",
      kind: "partial",
      sentence: line.partial,
      names: namesOf(done),
      agents: agentsOf(done),
      reason: failed[0].reason,
      tally: { done: done.length, failed: failed.length },
    };
  }
  const trail = op === "write" || op === "autoWrite" ? mcpEffectTrail(done) : [];
  // 成了但有一句要交代的（第三方模式那一份没写成）：第一句，接在原因的位置
  const note = done.find((item) => item.note)?.note;
  return {
    // 成功一律例行一行（DESIGN「提示条分两档」：黑块只给失败）
    tier: "routine",
    kind: "success",
    sentence: input.omitNames && line.bare ? line.bare : line.success,
    names: input.omitNames ? [] : namesOf(done),
    agents: agentsOf(done),
    ...(trail.length ? { trail } : {}),
    ...(note ? { reason: note } : {}),
  };
}

/// MCP 写进之后什么时候生效（DESIGN「MCP 支持哪些 agent › 写进之后什么时候生效」）：例行提示条在原句后
/// 接一句，只在第一批新加的三家——Claude Desktop 只在启动时读配置；Gemini CLI、Copilot CLI 新开会话才读；
/// Copilot 的项目文件还要在 Copilot 里信任这个文件夹。现有三家不接。几家一起写进时按出现先后、同一句只说一次
export function mcpEffectTrail(items: ToastItem[]): string[] {
  const out: string[] = [];
  const push = (text: string) => {
    if (!out.includes(text)) out.push(text);
  };
  for (const item of items) {
    if (item.trail) push(item.trail);
    switch (item.agent?.id) {
      case "claude-desktop":
        push(t("toast.trail.restartClaudeDesktop"));
        break;
      case "gemini-cli":
        push(t("toast.trail.newSession"));
        break;
      case "github-copilot":
        push(t("toast.trail.newSession"));
        if (item.project) push(t("toast.trail.trustCopilotFolder"));
        break;
    }
  }
  return out;
}

/// 「只留这份」确认框（DESIGN「页面还是弹层」「贴底栏「defuddle 有两份原件，删掉哪个？」」）：
/// 标题问留哪份；标题下两行路径已说清哪份留下、哪份进废纸篓，正文只说受影响的 agent
/// （`原来使用 Claude Code 那份的 agent 将改用留下的这一份。`，#274）：不说链接条数；没有要改用的就不写正文。
/// 来源名用原件位置列的写法（`originNames`）：同名来源带区分片段（`ego lite · 0.5.1.11`）。
/// `paths` 是标题下的两行：`留下` / `移到废纸篓` + 那一份的完整路径（主目录写 `~`，不截断）
/// `own`：这一方是 agent 自己目录里的那一份（issue #153），`name` 是整句说法 `Claude Code 自己那份`——
/// 句子里不再接「的」「那份」（`只留 Claude Code 自己那份 canvas-design？`）
export function keepThisConfirm(input: {
  kept: OriginName & { path: string; own?: boolean };
  other: OriginName & { path: string; own?: boolean };
  skill: string;
  relinked: number;
}): { title: string; body: string; paths: { label: string; path: string }[] } {
  const origin = originText(input.other);
  return {
    title: input.kept.own
      ? t("toast.keepThisConfirm.titleOwn", { copy: originText(input.kept), skill: input.skill })
      : t("toast.keepThisConfirm.title", { origin: originText(input.kept), skill: input.skill }),
    body:
      input.relinked === 0
        ? ""
        : input.other.own
          ? t("toast.keepThisConfirm.relinkedOwn", { copy: origin })
          : t("toast.keepThisConfirm.relinked", { origin }),
    paths: [
      { label: t("toast.keepThisConfirm.keptLabel"), path: displayPath(input.kept.path) },
      { label: t("toast.keepThisConfirm.trashLabel"), path: displayPath(input.other.path) },
    ],
  };
}

/// 删除 skill 原件的确认框（DESIGN「删除原件」）：说后果，不说机制——只说删除后哪些 agent 受影响，
/// 不写软链接、条数，也不写「移到废纸篓」（删除就是进废纸篓，#274）。
/// - 别处没有同名原件：`删除后，Codex 和 Claude Code 将无法使用它。`
/// - 别处有：`删除后，Claude Code 将改用 ~/.agents 中的同名 graduate，Codex 将无法使用它。`
/// 不写「可以撤销」（产品负责人：「可以撤销可以去掉」——删完的提示条上有 `撤销`，这里不预告）
/// `ownAgents` 是直接读原件所在目录的 agent（这一行里画 ⦿ 的列）；`linkAgents` 是有链接指向它的 agent。
/// 不写路径行：删的是哪一份，标题和点的那一行已经说了（产品负责人：「下面放个链接更是不明所以」）
export function deleteOriginalConfirm(input: {
  skill: string;
  /// 指向它的链接条数（只用来判断有没有要改用别处同名原件的 agent，不写进句子）
  links: number;
  /// 别处同名原件的来源名；没有就是链接一并删除
  relinkTo?: string;
  /// 直接读原件所在目录的 agent（去重、保序）
  ownAgents: string[];
  /// 有链接指向它的 agent（去重、保序）
  linkAgents: string[];
}): { title: string; body: string } {
  // 按有没有改用别处同名原件、有没有将无法使用它的 agent，每种组合一整句，不在代码里拼带标点的从句
  const names = (xs: readonly string[]) => listText(xs, "and");
  let body: string;
  if (input.relinkTo !== undefined && input.links > 0) {
    const moved = {
      agents: names(input.linkAgents),
      source: input.relinkTo,
      skill: input.skill,
    };
    const own = input.ownAgents.filter((a) => !input.linkAgents.includes(a));
    body =
      own.length === 0
        ? t("toast.deleteOriginal.relinked", moved)
        : t("toast.deleteOriginal.relinkedLost", { ...moved, names: names(own) });
  } else {
    const all = [...new Set([...input.ownAgents, ...input.linkAgents])];
    body = all.length === 0 ? "" : t("toast.deleteOriginal.lost", { names: names(all) });
  }
  return { title: t("toast.deleteOriginal.title", { skill: input.skill }), body };
}

/// 删完 skill 原件的例行一行：`✓ 已删除 defuddle · 在废纸篓里`。不带撤销——从废纸篓找回，确认框已说清
export function deletedOriginalToast(skill: string, undoable = false): ToastText {
  return {
    tier: "routine",
    kind: "success",
    sentence: "toast.line.deleteOriginal.success",
    names: [skill],
    agents: [],
    // 能撤销时后面跟 `撤销`，不再说去处；挪不进暂存处（跨磁盘）直接进了废纸篓，照实说
    ...(undoable ? {} : { reason: t("toast.deleted.inTrash") }),
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
      sentence: "toast.line.restore.cannot",
      names: [skill],
      agents: [],
      reason: input.failed[0] ?? "",
    };
  if (input.failed.length > 0)
    return {
      tier: "notice",
      kind: "partial",
      sentence: "toast.line.restore.partial",
      names: [skill],
      agents: [],
      reason: tn("toast.restored.linksFailed", input.failed.length, { reason: input.failed[0] }),
    };
  return {
    tier: "routine",
    kind: "success",
    sentence: "toast.line.restore.success",
    names: [skill],
    agents: [],
  };
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
  const params = { agent: input.agent, others: listOf(input.others) };
  return {
    title: t("toast.deleteMcp.title", { agent: input.agent, name: input.name }),
    body:
      input.others.length > 0
        ? t("toast.deleteMcp.bodyOthers", params)
        : t("toast.deleteMcp.bodyLast", params),
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
  const agents = listOf(input.agents);
  const listed = listOf(input.names.slice(0, BATCH_NAMES));
  const shown =
    input.names.length > BATCH_NAMES
      ? tn("toast.deleteMcpBatch.namesMore", input.names.length, { names: listed })
      : listed;
  // 后果分三种（会删到最后一份的：没有 / 全部 / 一部分）× 别处有没有同名定义，各一整句；
  // 英文不必照中文的「，」「；」接法
  const params = { names: shown, agents, others: listOf(input.others) };
  const kept = input.others.length > 0;
  let body: string;
  if (input.leaving === 0)
    body = t(
      kept ? "toast.deleteMcpBatch.bodyPlainKept" : "toast.deleteMcpBatch.bodyPlain",
      params,
    );
  else if (input.leaving >= input.names.length)
    body = t(kept ? "toast.deleteMcpBatch.bodyAllKept" : "toast.deleteMcpBatch.bodyAll", params);
  else
    body = tn(
      kept ? "toast.deleteMcpBatch.bodySomeKept" : "toast.deleteMcpBatch.bodySome",
      input.leaving,
      params,
    );
  return {
    title: tn("toast.deleteMcpBatch.title", input.names.length, { agents }),
    body,
  };
}

/// 删完一项 MCP 定义的例行一行：`✓ 已从 [Codex] 删除 weibo-search`（调用方另给 `撤销`，一律给）。
/// `note`：第三方模式那一份没删成的那一句（`McpReportEntry.mirrorFailed`）
export function deletedMcpOriginalToast(
  name: string,
  agent?: ToastAgentRef,
  note?: string,
): ToastText {
  return toastFor("delete", { done: [{ name, agent, note }] });
}

/// 「拆开」确认框（DESIGN「没有收件箱、待处理页和「忽略」」表：整个文件夹是链接，点该列任一格）：
/// 标题问拆哪个 agent 的文件夹，正文说后果
export function splitConfirm(agent: string): { title: string; body: string } {
  return {
    title: t("toast.split.title", { agent }),
    body: t("toast.split.body"),
  };
}

const BUSY_KEY = {
  link: "toast.busy.link",
  unlink: "toast.busy.unlink",
  write: "toast.busy.write",
  delete: "toast.busy.delete",
} as const;

/// 批量写入真的慢时触发项旁的那一句（DESIGN「忙碌指示」）：`正在加到 Codex` / `正在从 Codex 移除` /
/// `正在写进 Codex` / `正在从 Codex 删除`（MCP）。agent 为「所有 agent」时照样拼
export function batchBusyText(op: "link" | "unlink" | "write" | "delete", agent: string): string {
  return t(BUSY_KEY[op], { agent });
}

/// 删原件之后「有链接没处理好」的那一句：有原因就带上，分不出原因（core 给空串）只写主句
export function linksFailedLine(
  kind: "trashRelink" | "trashClear" | "relink" | "clear",
  count: number,
  reason: string,
): string {
  if (!reason) {
    switch (kind) {
      case "trashRelink":
        return tn("skills.delete.trashRelinkFailedPlain", count);
      case "trashClear":
        return tn("skills.delete.trashClearFailedPlain", count);
      case "relink":
        return tn("skills.delete.relinkFailedPlain", count);
      case "clear":
        return tn("skills.delete.clearFailedPlain", count);
    }
  }
  switch (kind) {
    case "trashRelink":
      return tn("skills.delete.trashRelinkFailed", count, { reason });
    case "trashClear":
      return tn("skills.delete.trashClearFailed", count, { reason });
    case "relink":
      return tn("skills.delete.relinkFailed", count, { reason });
    case "clear":
      return tn("skills.delete.clearFailed", count, { reason });
  }
}

/// 清掉坏链 / 孤儿链接失败的那一句：同上，原因为空只写主句
export function clearFailedLine(reason: string): string {
  return reason ? t("skills.orphan.clearFailed", { reason }) : t("skills.orphan.clearFailedPlain");
}

/// 拆开整个文件夹没做成的那一句：没有一个拆出来是整件失败，有的拆出来了是部分失败；原因为空只写主句
export function splitFailedLine(created: number, failed: number, reason: string): string {
  if (created === 0) {
    return reason ? t("skills.split.failed", { reason }) : t("skills.split.failedPlain");
  }
  return reason
    ? tn("skills.split.partial", failed, { reason })
    : tn("skills.split.partialPlain", failed);
}
