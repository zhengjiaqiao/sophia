/// 菜单栏面板里 Codex 那一行要显示什么（DESIGN「托盘面板」，画板 Tray）。
/// 纯函数：面板与「模型」页同一行的缩小版——`图标 + Codex + 开关 + [重启生效]`，没有状态句。
/// 文案与判断一律取自 modelsView，两边说同一句话。
import { enableDisabledReason, totalSelected } from "./modelsView.ts";
import type { GatewayState } from "./types.ts";

export { RESTART_CONSEQUENCE, RESTART_TIP } from "./modelsView.ts";

export interface TrayToggle {
  /// 开关现在开着没有
  on: boolean;
  /// 按不动的原因；能按则为 null。禁用必须同时说原因（进开关的提示框）
  disabledReason: string | null;
}

export interface TrayRow {
  /// 这台机器不支持模型注入时整行不出现
  visible: boolean;
  toggle: TrayToggle;
  /// 「重启生效」键：按钮即状态，只在改动等着生效时出现。启用和停用都算——
  /// 停用之后 Codex 的列表同样要重启才会变回去
  showRestart: boolean;
}

export function trayRow(state: GatewayState): TrayRow {
  // 已启用时永远能关：停用不依赖密钥和模型还在不在
  const disabledReason = state.enabled ? null : enableDisabledReason(state, totalSelected(state));
  return {
    visible: state.supported,
    toggle: { on: state.enabled, disabledReason },
    showRestart: state.needsCodexRestart,
  };
}
