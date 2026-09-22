import type { GatewayProvider, GatewayProviderModel, GatewayState } from "./types.ts";

/**
 * 页面上的一个**工具**（Codex、以后可能还有别的）。
 *
 * 后端今天只支持 Codex，这一层不是为了现在就多支持一个，而是**别让版面和文案
 * 写死一个工具**：标题、空态、提示条、限制说明都从这里取名字，加第二个工具时
 * 只改这张表，不用回去翻每一句话。
 */
export interface ModelsTool {
  /// `AgentIcon` 的 id
  id: string;
  /// 显示名，**不大写**——它是被谈论的对象（DESIGN §1.2）
  name: string;
  /// 用这个工具的第三方模型要知道的事（全文）。只在挑模型时有用：进模型下拉第三方分组头的提示框
  limitations: string;
  /// 第三方分组头上那一句短的（DESIGN「模型页」：限制说明放进下拉的第三方组头）
  pickerNote: string;
}

export const CODEX: ModelsTool = {
  id: "codex",
  name: "Codex",
  limitations:
    "Codex 仍会用官方模型生成会话标题，第一条消息会发给官方；自动审阅在第三方会话里用不了；网页搜索这类工具在第三方模型上也用不了。",
  pickerNote: "只支持文本对话与工具调用，不支持图片输入",
};

/// 页面按这张表一个工具一块。今天只有一个，但版面不假设只有一个
export const MODELS_TOOLS: ModelsTool[] = [CODEX];

export interface ParsedBackendError {
  code: string;
  message: string;
}

const ERROR_PREFIX = /^\[([a-z_]+)]\s*/;

/**
 * 后端错误形如 `[code] message`；剥离前缀，只展示后半段。
 * `[changed]` 的正文本身已经在说明“配置已变化，请重试”，同样剥离前缀原样展示即可。
 * 读不出前缀（例如非字符串异常）时把整段原文当作 internal 展示。
 */
export function parseBackendError(text: string): ParsedBackendError {
  const match = ERROR_PREFIX.exec(text);
  if (!match) return { code: "internal", message: text };
  return { code: match[1], message: text.slice(match[0].length) };
}

/// 已启用但路由没在跑：官方模型也可能受影响，需要在页面顶部提醒
export function routerUnavailable(state: GatewayState): boolean {
  return state.enabled && !state.router.running;
}

/// 一家网关的显示名。后端新建时会用地址里的主机名起名，这里只兜取不到名字的底
export function providerLabel(provider: GatewayProvider): string {
  if (provider.name) return provider.name;
  try {
    return new URL(provider.baseUrl).host || provider.id;
  } catch {
    return provider.id;
  }
}

/// 列表与片上显示的模型名：用户改过的显示名 > 网关给的 slug > 原始 id
export function modelLabel(model: GatewayProviderModel): string {
  return model.displayName || model.slug || model.id;
}

/// 这一家已选的模型，顺序保持网关给的顺序
export function selectedModels(provider: GatewayProvider): GatewayProviderModel[] {
  return provider.models.filter((model) => model.selected);
}

/// 全部网关加起来已选了几个模型。启动页那句人话与「启用」的可用性都按这个数算
export function totalSelected(state: GatewayState): number {
  return state.providers.reduce((sum, provider) => sum + selectedModels(provider).length, 0);
}

/**
 * 网关管理页上每一家右端那句（等宽）：这一家一共拉到多少个可以选的模型。
 * 一个都没拉到时返回空串，那时候旁边的方标签已经把话说了。
 */
export function providerCatalogHint(provider: GatewayProvider): string {
  return provider.models.length === 0 ? "" : `${provider.models.length} 个可选`;
}

/// 主页面「生效的模型」里的一条：这个模型、它属于哪一家网关、以及它在工具里显示成什么
export interface EffectiveModel {
  provider: GatewayProvider;
  model: GatewayProviderModel;
  /**
   * 工具的模型选择器里**实际**显示的名字。
   * 两家网关的已选模型显示名相同时，后端会自动加上「 · 网关名」
   * （docs/gateway-commands.md）；这一页叫「生效的模型」，那就得照抄那条规则，
   * 否则页面上写的和 Codex 里看到的对不上。
   */
  label: string;
}

/**
 * 全部网关里已选的模型，按网关顺序摊平。主页面只展示它——
 * 网关本身（地址、密钥、增删）搬去配置页了（第三轮反馈）。
 */
export function effectiveModels(state: GatewayState): EffectiveModel[] {
  const rows = state.providers.flatMap((provider) =>
    selectedModels(provider).map((model) => ({ provider, model })),
  );
  const times = new Map<string, number>();
  for (const row of rows) {
    const name = modelLabel(row.model);
    times.set(name, (times.get(name) ?? 0) + 1);
  }
  return rows.map((row) => {
    const name = modelLabel(row.model);
    const collides = (times.get(name) ?? 0) > 1;
    return { ...row, label: collides ? `${name} · ${providerLabel(row.provider)}` : name };
  });
}

/**
 * 「生效的模型」那块空着时说清**为什么空、下一步做什么**，而不是一律「还没选模型」。
 * 三种空是三件不同的事，混成一句用户就不知道该去哪儿（DESIGN「说结果，不说机制」）。
 * 一家网关都没有那一种不走这里——那时整块换成空态，直接把人送去配置页。
 */
export function emptyEffectiveText(state: GatewayState): string {
  const pulled = state.providers.some((provider) => provider.models.length > 0);
  if (pulled) return "还没选模型";
  return state.providers.some((provider) => provider.hasKey)
    ? "还没拉到模型列表——到「配置网关」里再存一次就会拉"
    : "网关还没有密钥——到「配置网关」里填上就能拉到模型列表";
}

/**
 * 这一家现在删不得的原因；能删则返回 null。
 *
 * 已启用时删掉**最后一家还在发布模型**的网关，后端会拒（`invalid`，见
 * docs/gateway-commands.md 的 `gateway_remove_provider`）。与其让用户按完确认才撞上
 * 一句错误，不如在确认弹窗里就把下一步说清楚——禁用的动作必须同时给出原因（§3）。
 */
export function removeProviderBlockedReason(
  state: GatewayState,
  provider: GatewayProvider,
  tool: ModelsTool = CODEX,
): string | null {
  if (!state.enabled) return null;
  if (selectedModels(provider).length === 0) return null;
  const others = state.providers.some(
    (other) => other.id !== provider.id && selectedModels(other).length > 0,
  );
  return others
    ? null
    : `它是最后一家还在给 ${tool.name} 发模型的网关；先点「已启用」停用，再回来删`;
}

/**
 * 「启用」按钮不可用时的原因；可用则返回 null。
 * 优先级：待接管 > 冲突 > 一家网关都没有 > 一个密钥都没存 > 未选模型 > 选了模型的那几家缺密钥。
 *
 * 最后那条排在选模型之后是没办法的事：多家网关时，缺密钥只挡着**有模型要发布**的那几家
 * （见 docs/gateway-commands.md 的 `gateway_enable`），所以得先知道选了哪些。
 * 一个密钥都没存那一条留在前面——那时还没有模型可选，先说密钥才是下一步。
 *
 * 菜单栏面板（`trayView.ts`）也用这个函数，两边说同一句话。
 */
export function enableDisabledReason(state: GatewayState, selectedCount: number): string | null {
  if (state.takeover !== null) return "本机当前由 agents-manager 启用，请先接管";
  if (state.conflict) return state.conflict;
  if (state.providers.length === 0) return "先添加一个网关";
  if (!state.providers.some((provider) => provider.hasKey)) return "请先保存网关密钥";
  if (selectedCount === 0) return "请先勾选至少一个模型";
  const noKey = state.providers.filter(
    (provider) => selectedModels(provider).length > 0 && !provider.hasKey,
  );
  if (noKey.length > 0) return `${noKey.map(providerLabel).join("、")} 还没有密钥`;
  return null;
}

/// 「恢复」按钮可用：已启用，或后台服务还装着（哪怕当前未启用）
export function canRestore(state: GatewayState): boolean {
  return state.enabled || state.router.installed;
}

/// 「重启 Codex」不设禁用态：结束进程不依赖我们的路由装没装上，
/// 一个进程都没找到也不算失败（R6 修订 v2、AC7′），所以这里没有对应的 reason 函数。

/**
 * 按筛选词过滤（大小写不敏感，匹配 id / slug / displayName），已选模型排在前面，
 * 其余保持原有相对顺序不变。
 */
export function sortAndFilterModels(
  models: GatewayProviderModel[],
  query: string,
): GatewayProviderModel[] {
  const term = query.trim().toLowerCase();
  const filtered =
    term === ""
      ? models
      : models.filter(
          (model) =>
            model.id.toLowerCase().includes(term) ||
            model.slug.toLowerCase().includes(term) ||
            model.displayName.toLowerCase().includes(term),
        );
  // Array.prototype.sort 是稳定排序，同为已选/未选的模型保持原有顺序。
  return [...filtered].sort((a, b) => Number(b.selected) - Number(a.selected));
}

// ===== 重启生效（DESIGN「模型页」：按钮即状态） =====

/// 「重启生效」键的提示框：只写点击的后果与代价。
/// 检测只认 Codex 桌面应用（与编辑器插件）拉起的后台进程，终端里的 `codex` 不认也不重启，
/// 所以写明「桌面应用」——否则用户会以为终端里那个也跟着换了配置（⑫）
export const RESTART_TIP = "重启 Codex 桌面应用让改动生效，进行中的对话会中断";

/// 确认框正文：不重复提示框原话。进行中的对话数查不到（Codex 没有对外暴露），写通用的后果
export const RESTART_CONSEQUENCE = "会结束 Codex 正在运行的进程，进行中的对话会中断";

/// 重启完重读状态，键还在：Codex 还在用旧配置。原样说出来，不假装成功（⑫）
export const RESTART_STILL_STALE = "Codex 还在用旧配置，稍后再试一次";

/**
 * 「重启生效」那一格（DESIGN「点了重启生效之后」）：
 * - idle：`needsCodexRestart` 为真时显示键，否则什么都没有
 * - restarting：键位原地换成 14px 转盘 + 「正在重启 Codex」；`spinning` 为 false 时转盘在做
 *   阻尼停转，停稳后换上结果
 * - done：一行例行成功 `✓ 已生效`，约 4 秒后淡出
 *
 * 失败不是这一格的状态：黑块「没重启 Codex」+ 原因 + `再试一次` 挂在整行下面，格子回到 idle
 * （键还在就还能点）
 */
export type RestartPhase =
  { kind: "idle" } | { kind: "restarting"; spinning: boolean } | { kind: "done" };

/// 已生效那行停多久（含末尾 120ms 淡出）
export const RESTART_DONE_MS = 4000;
/// 键显示着时轻查一次状态的间隔：外部重启了 Codex，键要自己消失
export const RESTART_POLL_MS = 5000;

/// 键要不要显示：状态说要重启、且此刻没在重启 / 刚报完结果
export function showRestartKey(state: GatewayState, phase: RestartPhase): boolean {
  return state.needsCodexRestart && phase.kind === "idle";
}

/// 只在键显示着时轮询；键消失即停，不做常驻进程监控
export function shouldPollRestart(state: GatewayState | null, phase: RestartPhase): boolean {
  return state !== null && state.needsCodexRestart && phase.kind === "idle";
}

// ===== 模型框与选择器 =====

/// 模型框尾端的等宽读数：全部网关一共拉到几个可选模型
export function availableCount(state: GatewayState): number {
  return state.providers.reduce((sum, provider) => sum + provider.models.length, 0);
}

/// 进网关页那一刻记下的「已经有的模型」，回来时和它比，差出来的就是新拉到的
export function modelKeys(state: GatewayState): Set<string> {
  const keys = new Set<string>();
  for (const provider of state.providers) {
    for (const model of provider.models) keys.add(`${provider.id}|${model.id}`);
  }
  return keys;
}

/// 从网关页 `选模型 ›` 回来时这一家新拉到的模型 id（各闪一次）。这一家是新加的就全算新的
export function newModelIds(
  state: GatewayState,
  before: Set<string>,
  providerId: string,
): string[] {
  const provider = state.providers.find((p) => p.id === providerId);
  if (!provider) return [];
  return provider.models.filter((m) => !before.has(`${providerId}|${m.id}`)).map((m) => m.id);
}

/// 路由没在跑、且启动时自愈过一次仍没起来，才出页级横幅（DESIGN「路由服务没在跑」）
export function showRouterBanner(state: GatewayState, healAttempted: boolean): boolean {
  return healAttempted && routerUnavailable(state);
}

// ===== 模型的待处理（顶栏收件箱的「模型」段，T3 的待处理页渲染） =====

/**
 * 模型页里要用户拿主意、且不在某一行上就地出现的事（DESIGN「全局收件箱」）：
 * - `takeover`：Codex 正由 agents-manager 管着 → `接管`
 * - `configChanged`：Codex 升级后 Sophia 写进去的模型列表对不上了，要重新写一次 → `重新写入`
 * - `unreachable`：某家网关连不上 → `再试一次`（网关页那一行同时就地显示）
 *
 * 「改动要重启 Codex 才生效」不进来——它已在 agent 行上就地出现，一件事只在一处说。
 * 「路由没在跑」也不进来——它影响整页、忽略毫无意义，走模型页页级横幅。
 *
 * 形状（给待处理页）：
 * - `key`：稳定、可持久化的忽略依据。**状况一变 key 就变**（Codex 升了版本、网关换了失败原因），
 *   忽略过的会自然重新提示——与 skill 的 issueKey 同一思路，但模型的 key 不进 core 的忽略表
 *   （那边的 IssueKind 是跨语言契约），由待处理页自己记
 * - `parts`：句子拆段，`subject: true` 的是对象名（墨色），其余是连接词（灰）
 * - `sentence`：整句，给读屏与提示框
 * - `action`：一个动作；`kind` 决定调哪个命令（App 的 `resolveModelIssue` 照它执行）
 * - `providerId`：只有 `unreachable` 有，给「再试一次」和跳回网关页那一行
 */
export type ModelIssueKind = "takeover" | "configChanged" | "unreachable";

export interface ModelIssue {
  kind: ModelIssueKind;
  key: string;
  parts: Array<{ text: string; subject?: boolean }>;
  sentence: string;
  action: { kind: "takeover" | "rewrite" | "retry"; label: string };
  providerId?: string;
}

/// 类别名：待处理页左列记号的提示框
export const MODEL_ISSUE_LABEL: Record<ModelIssueKind, string> = {
  takeover: "由别的工具管理",
  configChanged: "配置被外部改过",
  unreachable: "网关连不上",
};

const issue = (
  kind: ModelIssueKind,
  key: string,
  parts: ModelIssue["parts"],
  action: ModelIssue["action"],
  providerId?: string,
): ModelIssue => ({
  kind,
  key,
  parts,
  sentence: parts.map((p) => p.text).join(""),
  action,
  ...(providerId === undefined ? {} : { providerId }),
});

export function modelIssues(state: GatewayState | null, tool: ModelsTool = CODEX): ModelIssue[] {
  if (state === null || !state.supported) return [];
  const out: ModelIssue[] = [];
  if (state.takeover !== null) {
    out.push(
      issue(
        "takeover",
        `model:takeover:${state.takeover.baseUrl}`,
        [
          { text: tool.name, subject: true },
          { text: " 正由 " },
          { text: "agents-manager", subject: true },
          { text: " 管理，接过来才能在这里改" },
        ],
        { kind: "takeover", label: "接管" },
      ),
    );
  }
  if (state.codex.drift) {
    out.push(
      issue(
        "configChanged",
        `model:config:${state.codex.version}`,
        [
          { text: tool.name, subject: true },
          { text: ` 升到 ${state.codex.version} 后，Sophia 写进去的模型列表对不上了` },
        ],
        { kind: "rewrite", label: "重新写入" },
      ),
    );
  }
  for (const provider of state.providers) {
    if (!provider.unreachable) continue;
    out.push(
      issue(
        "unreachable",
        `model:unreachable:${provider.id}:${provider.unreachable}`,
        [
          { text: providerLabel(provider), subject: true },
          { text: ` 连不上：${provider.unreachable}` },
        ],
        { kind: "retry", label: "再试一次" },
        provider.id,
      ),
    );
  }
  return out;
}

// ===== 面板宽度：模型页右沿对齐 MCP 主视图（DESIGN 第 5 轮裁决） =====

/// MCP 面板的列：名称 280、传输 72、每个 agent 88，横线止于最后一列 + 24
const MCP_NAME_W = 280;
const MCP_TRANSPORT_W = 72;
const MCP_AGENT_W = 88;
const PANEL_TAIL = 24;
/// 模型页：agent 列固定 324，列间 24，生效模型列填满剩下的、最少 360
export const MODELS_AGENT_W = 324;
const MODELS_GAP = 24;
const MODELS_BOX_MIN = 360;

/// MCP 主视图面板总宽（含右侧 24）：`n` 是它显示的 agent 列数
export function mcpPanelWidth(n: number): number {
  return MCP_NAME_W + MCP_TRANSPORT_W + MCP_AGENT_W * Math.max(0, n) + PANEL_TAIL;
}

/// 模型页「生效模型」列宽：让面板右沿与 MCP 面板右沿对齐；太窄时取最小 360
export function modelsBoxWidth(n: number): number {
  return Math.max(MODELS_BOX_MIN, mcpPanelWidth(n) - MODELS_AGENT_W - MODELS_GAP - PANEL_TAIL);
}
