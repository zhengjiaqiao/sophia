import type { GatewayProviderModel, GatewayState, GatewayTakeover } from "./types.ts";

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
  return `本机当前由 agents-manager 启用（网关 ${takeover.baseUrl}，已选 ${takeover.selectedCount} 个模型），可以由 SymSync 接管`;
}

/**
 * 「启用」按钮不可用时的原因；可用则返回 null。
 * 优先级：待接管 > 冲突 > 未保存密钥 > 未选模型。
 */
export function enableDisabledReason(state: GatewayState, selectedCount: number): string | null {
  if (state.takeover !== null) return "本机当前由 agents-manager 启用，请先接管";
  if (state.conflict) return state.conflict;
  if (!state.provider.hasKey) return "请先保存网关密钥";
  if (selectedCount === 0) return "请先勾选至少一个模型";
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
 * 合成一句话说清「现在是什么样」。`needsCodexRestart` 也并进来，右边那个「重启路由」
 * 不是它的动作，但这句话本身就是它要说的全部（R7）。
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
  if (!state.provider.hasKey) return "还没启用，先到「配置」里填上网关地址和密钥";
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

/// 「重启路由」不可用时的原因；可用则返回 null。服务还没装就没有东西可重启
export function restartDisabledReason(state: GatewayState): string | null {
  return state.router.installed ? null : "后台路由还没装上，启用之后才有得重启";
}

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
