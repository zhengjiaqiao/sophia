/// Claude（桌面应用）的第三方模型：模型页那一行与托盘那一行共用的纯逻辑（spec 2026-09-29 R41 R44、#259；
/// DESIGN「Claude 桌面应用那一行」）。纯函数，tests 直接测。
///
/// 两处（模型页那一行、托盘那一行）说同一句话：文案与判断只在这里写一份——取 Claude 那一份、不能切的情况、
/// 开关的禁用原因（按所在处说下一步）、开关提示框、重启确认正文按方向、键的提示框、行的第二行、
/// 开关旁那一位出哪颗键、行上的灰字（代价句）、行下的待办条。
import { productLabel } from "./brandsView.ts";
import { t } from "./i18n.ts";
import type { MessageKey } from "./i18n.ts";
import type { AgentState } from "./shell/agentRegistry.ts";
import { enableNeedsModels } from "./modelsView.ts";
import { pickCounts, thirdPartyCount } from "./pickView.ts";
import { claudeGateway } from "./types.ts";
import type { ClaudeGatewayView, GatewayState } from "./types.ts";

/// 注册表只读状态里的 Claude 那一份；状态还没读回来、或本机不支持是 null
export const claudeOf = (s: AgentState): ClaudeGatewayView | null =>
  s.gateway === null ? null : claudeGateway(s.gateway);

/// 不能切的情况（开关禁用）：列表行第二行说「是什么」（`row`），开关提示框说「怎么办」（`tip`），
/// 不重复同一句（DESIGN「不能切的情况」）。能切为 null
export function claudeUnavailable(view: ClaudeGatewayView): { row: string; tip: string } | null {
  const desktop = view.claude.desktop;
  if (!view.installed) {
    return {
      row: t("models.claude.notInstalled"),
      tip: t("models.claudePage.notInstalledTip"),
    };
  }
  if (desktop.managed) {
    return { row: t("models.claudePage.managedRow"), tip: t("models.claudePage.managedTip") };
  }
  if (desktop.tooOld) {
    return { row: t("models.claudePage.tooOldRow"), tip: t("models.claudePage.tooOldTip") };
  }
  return null;
}

/// 开着时的代价，写在明处（DESIGN：开关提示框、行上的代价句、托盘能力行下一行）。
/// 提示框与代价句里各是一整句（目录一句一个键），这一句只给托盘能力行下那一行
export const claudeAccountCost = () => t("models.claudePage.accountCost");

/// 这一家在模型页里的名字（注册表 `modelsName`、Claude 的页页面头共用这一处；托盘那一块仍叫 `Claude`）：
/// 这一行只改桌面应用，行名说清范围（DESIGN「### 模型」，2026-09-30）。产品名照界面语言（`Claude 桌面应用`，
/// 同设置与安装页，经 `productLabel`）
export const claudeModelsName = () => productLabel("claude-desktop", "Claude Desktop");

/// 模型页里 Claude 那一行的第二行（画板第 1、1′ 屏）：不能切时换成那一种情况；别家配置在生效时
/// `在用别的第三方配置`；一个没选 `还没选模型`；关着 `没接第三方模型`；开着按提供商计数
/// `PackyCode 1 · Kimi 1 · DeepSeek 1`。状态还没读回来是空串
export function claudeListStatus(s: AgentState): string {
  const view = claudeOf(s);
  if (view === null) return "";
  const blocked = claudeUnavailable(view);
  if (blocked) return blocked.row;
  if (view.claude.desktop.foreign !== null) return t("models.claudePage.foreignRow");
  if (thirdPartyCount(view.models) === 0) return t("models.row.none");
  if (!view.enabled) return t("models.row.off");
  return pickCounts(view.models.picked) ?? t("models.row.none");
}

/// 开关旁那一位（DESIGN「开关＝配置里开没开」、spec R49）：`重启生效` 与 `打开 Claude` 同一位、不同时出现，
/// `重启生效` 优先——在运行且有待生效；开着、装着、没在运行时出 `打开 Claude`（有待生效的它先写再打开）
export type ClaudeKeyKind = "restart" | "launch";

export function claudeKeyKind(view: ClaudeGatewayView): ClaudeKeyKind | null {
  const desktop = view.claude.desktop;
  if (desktop.needsRestart) return "restart";
  if (view.enabled && view.installed && !desktop.running) return "launch";
  return null;
}

// ===== 开关：禁用原因、提示框、拨下去的两句 =====

/// 开关按不动时说在哪一处：模型页那一行（`list`，接管条就在行下）、托盘那一行（`tray`，说去模型页）
export type ClaudeSwitchPlace = "list" | "tray";

/// 别家配置在生效时开关按下即出的那一句，按所在处说下一步（键表：用的时候才取文案）
const NEEDS_TAKEOVER: Record<ClaudeSwitchPlace, MessageKey> = {
  list: "models.claudePage.needsTakeover",
  tray: "models.claudePage.needsTakeoverTray",
};

/// 开关按不动的原因（「怎么办」那一句；能按为 null）。开着时永远能关——切回不依赖模型。
/// 顺序：不能切的三种情况 > 别家配置在生效 > 冲突 > 一个模型都没选（同 Codex 的 `enableDisabledReason`）。
/// 选了的那几家缺密钥不在这里预判：打开时后端点名是哪一家，原话出在行下
export function claudeSwitchReason(
  view: ClaudeGatewayView,
  place: ClaudeSwitchPlace = "list",
): string | null {
  if (view.enabled) return null;
  const blocked = claudeUnavailable(view);
  if (blocked) return blocked.tip;
  if (view.claude.desktop.foreign !== null) return t(NEEDS_TAKEOVER[place]);
  if (view.conflict) return view.conflict;
  if (thirdPartyCount(view.models) === 0) return enableNeedsModels();
  return null;
}

/// 开关的提示框：先说结果，再说要重开 Claude；没接时再说切过去后的限制（画板第 1′ 屏「开关的提示框」：
/// 限制跟「不登录 Claude 账号」那句放在一起，打开前就看得到）。行与托盘同一段
export const claudeSwitchTip = (on: boolean): string =>
  on
    ? `${t("models.claudePage.switchOnTip")}${t("models.switch.keepRunning")}`
    : `${t("models.claudePage.switchOffTip")}${t("models.switch.keepRunning")}\n${claudeLimitations()}`;

/// `重启 Claude？` 的正文，按方向（开着＝切过去、关着＝切回）
export const claudeRestartConsequence = (enabled: boolean): string =>
  enabled ? t("models.claudePage.restartToModels") : t("models.claudePage.restartToAccount");

/// `打开 Claude` 的提示框（DESIGN 原话，同 Codex 的 `launchTip`）：不打断任何东西，不确认
export const claudeLaunchTip = () => t("models.tip.launch", { app: "Claude" });
/// `重启生效` 的提示框：点下去的结果（打断的代价在确认正文里说）
export const claudeRestartTip = () => t("models.claudePage.restartTip");

/// 拨开关那一格的两句：写的时候（过了 0.3 秒门槛原位刻度旁）、没成（灰面板的主句）
export const claudeSwitchText = (next: boolean): { busy: string; failed: string } =>
  next
    ? { busy: t("models.claudePage.switching"), failed: t("models.claudePage.switchFailed") }
    : {
        busy: t("models.claudePage.switchingBack"),
        failed: t("models.claudePage.switchBackFailed"),
      };

/// 切过去后的限制（DESIGN 原话）：开关提示框里，打开之前就看得到
export const claudeLimitations = () => t("models.tool.claudeLimitations");

/// 开着时行上那一句灰字（代价句，画板第 1′ 屏「行上的灰字」）；关着时不出（①）
export const claudeTradeoff = () => t("models.claudePage.tradeoff");

// ===== 行内待办条、页面头下的灰面板 =====

/// 行下待办条的一条（画板第 1′ 屏「待办条挂在行下」：灰面板、键在右端，问题解决自动收起、不给「稍后」）
export interface ClaudeTodo {
  kind: "takeover" | "rewrite";
  message: string;
  /// 主句后同一行的一段；没有为 null（别家配置一律不写来源，主句已说清，不重复：DESIGN ①）
  reason: string | null;
  label: string;
  /// 执行时键位换成忙碌指示旁的一句
  busy: string;
}

/// 这一行下的待办条，按先后：别家配置在生效 + `接管`（只说主句，不写是谁的配置；开着之后又被别的工具改了指向
/// 也是这一条）> 被改掉了 + `重新写入`。路由那一条影响每一家，挂在页面头下（`routerTodo`），不在这里
export function claudeTodos(state: GatewayState): ClaudeTodo[] {
  const view = claudeGateway(state);
  const out: ClaudeTodo[] = [];
  if (view === null) return out;
  const { foreign, drift } = view.claude.desktop;
  if (foreign !== null) {
    out.push({
      kind: "takeover",
      message: t("models.desktop.foreign"),
      reason: null,
      label: t("models.issue.takeover"),
      busy: t("models.todo.takingOver"),
    });
  }
  if (drift) {
    out.push({
      kind: "rewrite",
      message: t("models.todo.drift"),
      reason: null,
      label: t("models.issue.rewrite"),
      busy: t("models.todo.rewriting"),
    });
  }
  return out;
}

/// 切回没做完（spec R34 `restoreUnfinished`，R32 进程中途没了）：行下灰面板 + `再试一次`。没有为 null
export function claudeHeadIssue(
  view: ClaudeGatewayView,
): { message: string; reason: string } | null {
  return view.claude.desktop.restoreUnfinished
    ? { message: claudeSwitchText(false).failed, reason: t("models.claudePage.unfinished") }
    : null;
}

/// `重新写入` 与切回没做完的 `再试一次`（spec R36）：桌面应用在运行时不能当场写，走 `重启生效`（先确认）
export const claudeViaRestart = (view: ClaudeGatewayView): boolean => view.claude.desktop.running;

/// 键（`重启生效` / `打开 Claude`）显示着、且此刻空闲才轻查：用户自己开了 / 重开了 Claude，键要自己消失
export function claudeShouldPoll(view: ClaudeGatewayView | null, idle: boolean): boolean {
  return view !== null && idle && claudeKeyKind(view) !== null;
}
