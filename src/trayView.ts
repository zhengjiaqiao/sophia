/// 菜单栏面板里 Codex 那一行要显示什么（docs/specs/2026-09-21-tray.md）。
/// 纯函数：面板与「模型」页说同一句话，所以文案一律取自 modelsView。
import { enableDisabledReason, routerUnavailable, statusSentence } from "./modelsView.ts";
import type { GatewayState } from "./types.ts";

export interface TrayToggle {
  /// 反色＝已启用（DESIGN：用反色表示"现在开着"）
  on: boolean;
  label: "已启用" | "启用";
  /// 按不动的原因；能按则为 null。禁用必须同时说原因（DESIGN §按钮）
  disabledReason: string | null;
}

export interface TrayRow {
  /// 这台机器不支持模型注入时整行不出现
  visible: boolean;
  status: string;
  toggle: TrayToggle;
  /// 开关按不动、得先去「模型」页把事情办完：面板给一条过去的路
  needsSetup: boolean;
  /// 「重启 Codex」只在有改动等着生效时出现：平时摆着是噪音，还多一个误触的机会。
  /// 启用和停用都算——停用之后 Codex 的列表同样要重启才会变回去
  showRestart: boolean;
}

/// 「重启 Codex」确认那一行的话：说会发生什么，让用户读完就知道后果（DESIGN：破坏性靠信息承担分量）
export const RESTART_CONSEQUENCE = "会中断 Codex 里进行中的对话";

export function trayRow(state: GatewayState): TrayRow {
  const selectedCount = state.provider.models.filter((m) => m.selected).length;
  // 已启用时永远能关：停用不依赖密钥和模型还在不在
  const disabledReason = state.enabled ? null : enableDisabledReason(state, selectedCount);
  const status = routerUnavailable(state)
    ? "已经启用，但本机路由没在跑，这会儿连官方模型也用不了"
    : !state.enabled && state.needsCodexRestart
      ? // 模型页的那句在这里只会说「还没启用」，像是什么都没发生
        "已经停用，要重启 Codex，它的模型列表才会变回只有官方模型"
      : statusSentence(state, selectedCount);
  return {
    visible: state.supported,
    status,
    toggle: {
      on: state.enabled,
      label: state.enabled ? "已启用" : "启用",
      disabledReason,
    },
    needsSetup: disabledReason !== null,
    showRestart: state.needsCodexRestart,
  };
}
