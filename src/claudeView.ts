/// Claude（桌面应用）的第三方模型：列表行、Claude 的页、托盘那一行共用的纯逻辑（spec 2026-09-29 R41 R42 R44；
/// DESIGN「Claude 的页：桌面应用」）。纯函数，tests 直接测。
///
/// 三处（Claude 的页、列表行、托盘那一行）说同一句话：文案与判断只在这里写一份——取 Claude 那一份、不能切的情况、
/// 开关的禁用原因（按所在处说下一步）、开关提示框两段、重启确认正文按方向、键的提示框、列表行的现状句、
/// 开关旁那一位出哪颗键；页里的能力名、已选、代价句、行内待办条。
import { t } from "./i18n.ts";
import type { MessageKey } from "./i18n.ts";
import type { AgentState } from "./shell/agentRegistry.ts";
import {
  enableNeedsModels,
  listNeedsModels,
  chipLabel,
  gatewayShortName,
  listModelNames,
  noUsableKeyReason,
  selectedKeyReason,
  selectedModels,
  routerTodo,
  splitModelId,
} from "./modelsView.ts";
import type { EffectiveModel, ModelsTool } from "./modelsView.ts";
import { claudeGateway, withAgentGateway } from "./types.ts";
import type { ClaudeGatewayView, GatewayProviderModel, GatewayState } from "./types.ts";

/// 注册表只读状态里的 Claude 那一份；状态还没读回来、或本机不支持是 null
export const claudeOf = (s: AgentState): ClaudeGatewayView | null =>
  s.gateway === null ? null : claudeGateway(s.gateway);

/// 这一家已选了几个模型（全部网关加起来）
export const claudeSelectedCount = (view: ClaudeGatewayView): number =>
  view.providers.reduce(
    (sum, provider) => sum + provider.models.filter((model) => model.selected).length,
    0,
  );

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

/// 开着时的代价，写在明处（DESIGN：开关提示框、页里的代价句、托盘能力行下一行）。
/// 提示框与代价句里各是一整句（目录一句一个键），这一句只给托盘能力行下那一行
export const claudeAccountCost = () => t("models.claudePage.accountCost");

/// 这一家在模型页里的名字（注册表 `modelsName`、Claude 的页页面头共用这一处；托盘那一块仍叫 `Claude`）：
/// 这一行只改桌面应用，行名说清范围（DESIGN「### 模型」，2026-09-30）
export const CLAUDE_MODELS_NAME = "Claude Desktop";

/// 模型列表页里 Claude 那一行的第二行（DESIGN「列表页」，2026-09-30）：同 Codex 只写已选的模型名（`listModelNames`），
/// 不加 `桌面应用 · ` 前缀、不接代价句；别家配置在生效时 `正在用别的第三方配置`；不能切时换成那一种情况。
/// 状态还没读回来是空串
export function claudeListStatus(s: AgentState): string {
  const view = claudeOf(s);
  if (view === null) return "";
  const blocked = claudeUnavailable(view);
  if (blocked) return blocked.row;
  if (view.claude.desktop.foreign !== null) return t("models.claudePage.foreignRow");
  return listModelNames(claudePicked(view).map((row) => row.label));
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

/// 开关按不动时说在哪一处：Claude 的页（`page`，接管条就在下面）、模型列表页那一行（`list`，要「进去」）、
/// 托盘那一行（`tray`，托盘里「进去」指代不清，说去模型页）
export type ClaudeSwitchPlace = "page" | "list" | "tray";

/// 别家配置在生效时开关按下即出的那一句，按所在处说下一步（键表：用的时候才取文案）
const NEEDS_TAKEOVER: Record<ClaudeSwitchPlace, MessageKey> = {
  page: "models.claudePage.needsTakeover",
  list: "models.listRow.needsTakeover",
  tray: "models.claudePage.needsTakeoverTray",
};

/// 开关按不动的原因（「怎么办」那一句；能按为 null）。开着时永远能关——切回不依赖密钥和模型。
/// 顺序：不能切的三种情况 > 别家配置在生效 > 冲突 > 没有网关 > 一个密钥都没存 > 没选模型 > 选了模型的那几家缺密钥
/// （同 Codex 的 `enableDisabledReason`）。列表页上挑不了模型，没选模型时说 `先进去选好模型再打开`
export function claudeSwitchReason(
  view: ClaudeGatewayView,
  place: ClaudeSwitchPlace = "page",
): string | null {
  if (view.enabled) return null;
  const blocked = claudeUnavailable(view);
  if (blocked) return blocked.tip;
  if (view.claude.desktop.foreign !== null) return t(NEEDS_TAKEOVER[place]);
  if (view.conflict) return view.conflict;
  const needsModels = place === "list" ? listNeedsModels() : enableNeedsModels();
  if (view.providers.length === 0) return needsModels;
  const none = noUsableKeyReason(view.providers);
  if (none) return none;
  if (claudeSelectedCount(view) === 0) return needsModels;
  return selectedKeyReason(view.providers);
}

/// 开关的提示框：先说结果，再说要重开 Claude（DESIGN 两段原话；页、列表行、托盘同一段）
export const claudeSwitchTip = (on: boolean): string =>
  `${on ? t("models.claudePage.switchOnTip") : t("models.claudePage.switchOffTip")}${t("models.switch.keepRunning")}`;

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

// ===== 网关区块 =====

/// 网关抽屉里的限制说明（DESIGN 原话；只在挑的时候有用）
export const claudeLimitations = () => t("models.tool.claudeLimitations");

/// 网关区块里的这一家（名字用模型页里的 `Claude Desktop`，写删网关被挡住的原因，限制说明进抽屉）。Claude 的开关不改用户看得懂的某个文件，
/// 没有 `configPath` 要说
export const CLAUDE_TOOL: ModelsTool = {
  id: "claude-code",
  name: CLAUDE_MODELS_NAME,
  configPath: "",
  // getter：用的时候才取文案，模块加载时不定死语言
  get limitations() {
    return claudeLimitations();
  },
};

// ===== 已选、代价句 =====

/// `已选` 一行：这一家已选的模型，按网关顺序摊平；名字的写法、撞名后缀同 Codex 的 `effectiveModels`
/// （那个函数读 Codex 那一份，这里读 Claude 自己的网关）
export function claudePicked(view: ClaudeGatewayView): EffectiveModel[] {
  const rows = view.providers.flatMap((provider) =>
    selectedModels(provider).map((model) => ({ provider, model })),
  );
  const vendors = new Set(rows.map((row) => splitModelId(row.model.id).vendor ?? ""));
  const keepVendor = vendors.size > 1;
  const nameOf = (model: GatewayProviderModel) => chipLabel(model, keepVendor);
  const times = new Map<string, number>();
  for (const row of rows) {
    const name = nameOf(row.model);
    times.set(name, (times.get(name) ?? 0) + 1);
  }
  return rows.map((row) => {
    const name = nameOf(row.model);
    const suffix = (times.get(name) ?? 0) > 1 ? gatewayShortName(row.provider) : null;
    return { ...row, name, suffix, label: suffix === null ? name : `${name} · ${suffix}` };
  });
}

/// 开着时 `已选` 下那一句灰字（代价句，DESIGN 原话）；关着时不出（①）。`已选` 下不另加说明（2026-09-30）
export const claudeTradeoff = () => t("models.claudePage.tradeoff");

/// 勾选 / 取消一个模型之后先画的样子（同 Codex 的 `selectModel`）：只改这一家这一个模型。开着时去掉的是最后一个
/// → `turnsOff`、开关画成关（等同关掉，后端开着时不许已选变空，调用方先切回再清）
export function claudeSelectModel(
  state: GatewayState,
  providerId: string,
  modelId: string,
  selected: boolean,
): { next: GatewayState; turnsOff: boolean } {
  const view = claudeGateway(state);
  if (view === null) return { next: state, turnsOff: false };
  const providers = view.providers.map((provider) =>
    provider.id !== providerId
      ? provider
      : {
          ...provider,
          models: provider.models.map((model) =>
            model.id === modelId ? { ...model, selected } : model,
          ),
        },
  );
  const moved: ClaudeGatewayView = { ...view, providers };
  const turnsOff = view.enabled && claudeSelectedCount(moved) === 0;
  return {
    next: withAgentGateway(state, { ...moved, enabled: turnsOff ? false : view.enabled }),
    turnsOff,
  };
}

// ===== 行内待办条、页面头下的灰面板 =====

/// 行内待办条的一条（DESIGN「每家的页 › 行内待办条」：灰面板满宽、键在右端控件列，问题解决自动收起、不给「稍后」）
export interface ClaudeTodo {
  kind: "router" | "takeover" | "rewrite";
  message: string;
  /// 主句后同一行的一段；没有为 null（别家配置一律不写来源，主句已说清，不重复：DESIGN ①）
  reason: string | null;
  label: string;
  /// 执行时键位换成忙碌指示旁的一句
  busy: string;
}

/// 这一页的行内待办条，按先后：路由没在跑（自愈过一次仍没起来才出）> 别家配置在生效 + `接管`
/// （只说主句，不写是谁的配置；开着之后又被别的工具改了指向也是这一条）> 被改掉了 + `重新写入`。
/// 不做「重开后在登录页点……」那一条（spec R42 已定事项 3：连同 deploymentMode 一起写好，重开直接进入）
export function claudeTodos(state: GatewayState, healed: boolean): ClaudeTodo[] {
  const view = claudeGateway(state);
  const out: ClaudeTodo[] = [];
  // 路由那一条：没在跑，或打开 Sophia 时没接上（另一个 Sophia 在运行、端口都被占）——与 Codex 的页同一条（routerTodo）。
  // 原因：没接上时是那一种；路由没在跑时自愈失败的原话由页面接上（`routerFailure`）
  const router = routerTodo(state, healed, null);
  if (router !== null) out.push({ kind: "router", ...router });
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

/// 切回没做完（spec R34 `restoreUnfinished`，R32 进程中途没了）：页面头下灰面板 + `再试一次`。没有为 null
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
