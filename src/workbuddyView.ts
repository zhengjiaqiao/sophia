/// WorkBuddy 的第三方模型（spec #247「四」、#266）：模型页那一行的纯逻辑。纯函数，tests 直接测。
///
/// 和 Codex、Claude 一样经本机路由转接；Sophia 往 `~/.workbuddy/models.json` 写指向路由的条目，WorkBuddy 自动重读，
/// 所以这一行没有「重启生效」。官方模型它自己管，只能看（选模型浮层里官方组置灰）。
import { t } from "./i18n.ts";
import { enableNeedsModels } from "./modelsView.ts";
import { pickCounts, thirdPartyCount } from "./pickView.ts";
import type { AgentState } from "./shell/agentRegistry.ts";
import { workbuddyGateway } from "./types.ts";
import type { WorkBuddyGatewayView } from "./types.ts";

/// 注册表只读状态里的 WorkBuddy 那一份；状态还没读回来、或本机不支持是 null
export const workbuddyOf = (s: AgentState): WorkBuddyGatewayView | null =>
  s.gateway === null ? null : workbuddyGateway(s.gateway);

/// 那一行的第二行：一个没选 `还没选模型`；关着 `没接第三方模型`；开着按提供商计数 `Kimi 2 · DeepSeek 1`
export function workbuddyListStatus(s: AgentState): string {
  const view = workbuddyOf(s);
  if (view === null) return "";
  if (thirdPartyCount(view.models) === 0) return t("models.row.none");
  if (!view.enabled) return t("models.row.off");
  return pickCounts(view.models.picked) ?? t("models.row.none");
}

/// 开关按不动的原因（能按为 null）。开着时永远能关；关着时：models.json 读不懂 > 一个模型都没选
export function workbuddySwitchReason(view: WorkBuddyGatewayView): string | null {
  if (view.enabled) return null;
  if (view.conflict) return view.conflict;
  if (thirdPartyCount(view.models) === 0) return enableNeedsModels();
  return null;
}

/// 开关的提示框：拨下去会怎样（不用重开 WorkBuddy），再说 Sophia 要开着
export const workbuddySwitchTip = (on: boolean): string =>
  `${on ? t("models.workbuddy.switchOnTip") : t("models.workbuddy.switchOffTip")}${t("models.switch.keepRunning")}`;

/// 拨开关那一格的两句：写的时候（过了 0.3 秒门槛原位刻度旁）、没成（灰面板的主句）
export const workbuddySwitchText = (next: boolean): { busy: string; failed: string } =>
  next
    ? { busy: t("models.workbuddy.switching"), failed: t("models.workbuddy.switchFailed") }
    : {
        busy: t("models.workbuddy.switchingBack"),
        failed: t("models.workbuddy.switchBackFailed"),
      };

/// 行下一块说明（没有键）：开着、用户自带的可用模型名单挡住了 Sophia 加的模型（不替用户改名单）。没有为 null
export function workbuddyAllowListNote(
  view: WorkBuddyGatewayView,
): { message: string; reason: string } | null {
  if (!view.enabled || !view.workbuddy.hiddenByAllowList) return null;
  return {
    message: t("models.workbuddy.allowListHides"),
    reason: t("models.workbuddy.allowListReason"),
  };
}

/// 行下的待办条：开着、文件里却没有 Sophia 的条目了（被删掉、被改掉）+ `重新写入`；文件读不懂时主句换成那一种、
/// 原话跟在后面。没有为 null
export function workbuddyTodo(
  view: WorkBuddyGatewayView,
): { message: string; reason: string | null; label: string; busy: string } | null {
  if (!view.enabled || view.workbuddy.written) return null;
  const issue = view.workbuddy.fileIssue;
  return {
    message: issue ? t("models.workbuddy.fileBroken") : t("models.todo.drift"),
    reason: issue || null,
    label: t("models.issue.rewrite"),
    busy: t("models.todo.rewriting"),
  };
}
