import type {
  GatewayProvider,
  GatewayProviderModel,
  GatewayState,
  GatewayTakeover,
} from "./types.ts";

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
 * 一家网关的计数行（等宽）。
 * 数字带单位，「已选」与「共有」各占各的位置，不共用一个数（DESIGN「计数口径」）。
 */
export function providerFacts(provider: GatewayProvider): string {
  if (provider.models.length === 0) return "还没拉到模型列表";
  return `已选 ${selectedModels(provider).length} 个 · 共 ${provider.models.length} 个`;
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
): string | null {
  if (!state.enabled) return null;
  if (selectedModels(provider).length === 0) return null;
  const others = state.providers.some(
    (other) => other.id !== provider.id && selectedModels(other).length > 0,
  );
  return others ? null : "它是最后一家还在给 Codex 发模型的网关；先点「已启用」停用，再回来删";
}

/**
 * 启动页那行大字（display 28）：一眼回答「第三方模型现在开着没有」。
 * 细节让下面那句人话说，这一行只给结论。
 */
export function headline(state: GatewayState): string {
  return state.enabled ? "已经在用" : "还没启用";
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
 * 合成一句话说清「现在是什么样」。`needsCodexRestart` 也并进来，右边那个「重启 Codex」
 * 就是它的动作，所以不再单起一条（R7）。
 */
export function statusSentence(state: GatewayState, selectedCount: number): string {
  if (state.enabled) {
    const head =
      selectedCount > 0
        ? `${selectedCount} 个模型已经在 Codex 的模型列表里`
        : "已经启用，但一个模型都没选，Codex 的列表里还是只有官方模型";
    return state.needsCodexRestart ? `${head}，改动要重启 Codex 才生效` : head;
  }
  if (state.takeover !== null) {
    return "还没启用，Codex 现在只有官方模型——这台机器由 agents-manager 在管，接过来才能启用";
  }
  if (state.conflict) return `还没启用：${state.conflict}`;
  if (state.providers.length === 0) {
    return "还没启用，先添加一个网关——填上地址和密钥就能拉到它的模型列表";
  }
  if (!state.providers.some((provider) => provider.hasKey)) {
    return "还没启用，先到网关的「配置」里填上密钥";
  }
  if (selectedCount === 0) return "还没启用，先选几个模型";
  return `还没启用，选好的 ${selectedCount} 个模型点「启用」就会进 Codex 的模型列表`;
}

/**
 * 事实行（等宽）：版本号与端口是计数类事实，走等宽（spec R2、组件规范 §1.2）。
 * 读不出 Codex 版本时不编一个，只说路由。
 */
export function factsLine(state: GatewayState): string {
  const router = state.router.running
    ? `路由 127.0.0.1:${state.router.port} 运行中`
    : state.router.installed
      ? `路由 127.0.0.1:${state.router.port} 没在跑`
      : "路由未安装";
  return state.codex.version ? `Codex ${state.codex.version} · ${router}` : router;
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
