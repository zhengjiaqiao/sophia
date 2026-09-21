import type {
  GatewayProvider,
  GatewayProviderModel,
  GatewayState,
  GatewayTakeover,
} from "./types.ts";

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
  /// 用这个工具的第三方模型要知道的事。是事实不是某次操作的结果，常驻在它自己那一块里
  limitations: string;
}

export const CODEX: ModelsTool = {
  id: "codex",
  name: "Codex",
  limitations:
    "Codex 仍会用官方模型生成会话标题，第一条消息会发给官方；自动审阅在第三方会话里用不了；网页搜索这类工具在第三方模型上也用不了。",
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

/// 接管提议的文案
export function takeoverOfferText(takeover: GatewayTakeover): string {
  return `本机当前由 agents-manager 启用（网关 ${takeover.baseUrl}，已选 ${takeover.selectedCount} 个模型），可以由 Sophia 接管`;
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
 * 主页面上那句极简的网关事实，当进配置页的由头（第三轮反馈：网关内容不摊在主页面上）。
 * 数字带单位，家数与模型数各占各的位置（DESIGN「计数口径」）。
 */
export function gatewaySummary(state: GatewayState): string {
  if (state.providers.length === 0) return "还没有网关";
  const total = state.providers.reduce((sum, provider) => sum + provider.models.length, 0);
  return total === 0
    ? `${state.providers.length} 家网关 · 还没拉到模型`
    : `${state.providers.length} 家网关 · 共 ${total} 个模型可挑`;
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

/**
 * 副行那句人话（spec R2）。
 *
 * `enabled`、`router.running`、`codex.version` 是正交的三件事，**不并排三个徽标**——
 * 合成一句话说清「现在是什么样」。`needsCodexRestart` 也并进来，那一块右边的
 * 「重启 <工具>」就是它的动作，所以不再单起一条（R7）。
 *
 * 工具名从 `tool` 来，不写死在句子里。默认是 Codex：菜单栏面板（`trayView.ts`）
 * 调的是两参数的老形，两边仍然说同一句话。
 */
export function statusSentence(
  state: GatewayState,
  selectedCount: number,
  tool: ModelsTool = CODEX,
): string {
  if (state.enabled) {
    const head =
      selectedCount > 0
        ? `${selectedCount} 个模型已经在 ${tool.name} 的模型列表里`
        : `已经启用，但一个模型都没选，${tool.name} 的列表里还是只有官方模型`;
    return state.needsCodexRestart ? `${head}，改动要重启 ${tool.name} 才生效` : head;
  }
  if (state.takeover !== null) {
    return `还没启用，${tool.name} 现在只有官方模型——这台机器由 agents-manager 在管，接过来才能启用`;
  }
  if (state.conflict) return `还没启用：${state.conflict}`;
  if (state.providers.length === 0) {
    return "还没启用，先添加一个网关——填上地址和密钥就能拉到它的模型列表";
  }
  if (!state.providers.some((provider) => provider.hasKey)) {
    return "还没启用，先到网关的「配置」里填上密钥";
  }
  if (selectedCount === 0) return "还没启用，先选几个模型";
  return `还没启用，选好的 ${selectedCount} 个模型点「启用」就会进 ${tool.name} 的模型列表`;
}

/**
 * 事实行（等宽）：版本号与端口是计数类事实，走等宽（spec R2、组件规范 §1.2）。
 * 读不出工具版本时不编一个，只说路由。
 */
export function factsLine(state: GatewayState, tool: ModelsTool = CODEX): string {
  const router = state.router.running
    ? `路由 127.0.0.1:${state.router.port} 运行中`
    : state.router.installed
      ? `路由 127.0.0.1:${state.router.port} 没在跑`
      : "路由未安装";
  return state.codex.version ? `${tool.name} ${state.codex.version} · ${router}` : router;
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
