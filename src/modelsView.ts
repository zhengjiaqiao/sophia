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
