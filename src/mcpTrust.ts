/// MCP 写进之后还要用户在 agent 自己的界面里点「信任」的那几家（#256，画板「国产 agent 与国内网络」第 6 屏）。
/// 现在只有 WorkBuddy：别人写进 `~/.workbuddy/mcp.json` 的条目它不会自动连，要在「自定义连接器」里点「信任」；
/// 它的信任跟命令、参数、环境变量名绑在一起，所以 Sophia 每次写进、改写一条都提示一次。Sophia 不替用户点、
/// 不碰它的批准文件、不算它的指纹。哪几家要点只记在 core 的 MCP agent 表（`mcp::trust_app`），经 `list_harnesses`
/// 的 `mcpTrust` 传来；打开它用命令 `mcp_open_trust_app`。这里只有各家「去哪点」的文案。
/// 纯逻辑：造句与判断，不产 JSX、不碰 api
import { listText, t, type MessageKey } from "./i18n.ts";

export interface TrustAgentRef {
  /// harness id
  id: string;
  /// 显示名
  name: string;
  /// 写进以后要在它里面点「信任」（core `mcp::trust_app`，`HarnessStatus.mcpTrust`）
  trust: boolean;
}

/// 右下那一窗要的：主句、第二行（在它里面去哪点）、要打开的那一家
export interface TrustNotice {
  /// 要打开的 agent（harness id，交给 `api.mcpOpenTrustApp`）
  agentId: string;
  /// 它的显示名（`打开 WorkBuddy`）
  app: string;
  sentence: string;
  where: string;
}

/// 写进（新加一份）与改写（保留这份改了已有的那一条）：改写要重新点
export type TrustOp = "write" | "rewrite";

/// 要点信任的 agent → 它界面里去哪点（目录键）。只是文案；要不要点看 `TrustAgentRef.trust`
const WHERE: Record<string, MessageKey> = {
  workbuddy: "mcp.trust.whereWorkBuddy",
};

/// 一次操作写成了（新加或改写）的那几处的 agent（可重复、可缺）→ 右下那一窗；没写到要点信任的 agent 时为 null。
/// 几个 agent 一起加时主句合并说一次：加到的都写上（按出现先后、去重），信任只说要点的那一家
export function trustNoticeFor(
  op: TrustOp,
  agents: ReadonlyArray<TrustAgentRef | undefined>,
): TrustNotice | null {
  const seen: TrustAgentRef[] = [];
  for (const a of agents) if (a && !seen.some((s) => s.id === a.id)) seen.push(a);
  const trusting = seen.filter((a) => a.trust);
  if (trusting.length === 0) return null;
  const app = trusting[0];
  const params = {
    agents: listText(seen.map((a) => a.name)),
    app: listText(trusting.map((a) => a.name)),
  };
  return {
    agentId: app.id,
    app: app.name,
    sentence: t(op === "write" ? "mcp.trust.added" : "mcp.trust.rewritten", params),
    where: app.id in WHERE ? t(WHERE[app.id]) : "",
  };
}

/// 停在这一格上时提示框的第二行：这一家要点信任时，有（●）的说以后改过也要点、写在哪；没有（○，点了写进）的说写进以后要点。
/// 别的 agent 为 null
export function trustCellNote(agent: TrustAgentRef, present: boolean, path: string): string | null {
  if (!agent.trust) return null;
  const app = agent.name;
  return present ? t("mcp.trust.cellPresent", { app, path }) : t("mcp.trust.afterWrite", { app });
}
