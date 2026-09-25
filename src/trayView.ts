/// 菜单栏面板要显示什么（DESIGN「托盘面板」，画板 V4Layouts-tray）。纯函数，tests/tray-view.test.ts 直接测。
///
/// 面板**一个 agent 一块、一种能力一行**：块与行从外壳的 agent 注册表生成（`src/shell/agents.tsx`），
/// 与侧栏 `agent` 段、agent 页的节同一份名单与顺序；托盘不自己写一份 Codex 名单。
/// 能力行的文案与判断一律取自 modelsView，面板与 Codex 页说同一句话。
import { visibleAgents } from "./shell/agentRegistry.ts";
import type { ComponentType } from "react";
import type { AgentEntry, AgentState, TrayRowProps } from "./shell/agentRegistry.ts";
import { codexKeyKind, switchDisabledReason } from "./modelsView.ts";
import type { GatewayState } from "./types.ts";

export { LAUNCH_TIP, RESTART_CONSEQUENCE, RESTART_TIP, UNINSTALL_TIP } from "./modelsView.ts";

// ===== 块与行：从 agent 注册表生成 =====

/// 面板里的一块：块头（图标 + 名字，不放控件）+ 这个 agent 在面板里画得出的能力行
export interface TrayBlock {
  id: string;
  name: string;
  /// 能力行：注册表里这个 agent 的节，按节序；只留带 `trayRow` 画法的
  rows: { id: string; title: string; Row: ComponentType<TrayRowProps> }[];
}

/// 注册表 → 面板的块。行的画法就在注册表的节上（`trayRow`，今天只有 `third-party-models`；
/// 以后的 `usage` 给那一节配一个即可，面板不改）。可用且有节的 agent 才成块（同侧栏的入选条件），
/// 一行都画不出的 agent 不成块（空块头是噪音）
export function trayBlocks(registry: ReadonlyArray<AgentEntry>, s: AgentState): TrayBlock[] {
  return visibleAgents(registry, s)
    .agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      rows: agent.sections.flatMap((section) =>
        section.trayRow ? [{ id: section.id, title: section.title, Row: section.trayRow }] : [],
      ),
    }))
    .filter((block) => block.rows.length > 0);
}

/// 面板手里只有模型状态：据此给注册表的只读状态（支不支持第三方模型＝后端说的 `supported`）
export const trayAgentState = (state: GatewayState | null): AgentState => ({
  gateway: state,
  modelsSupported: state ? state.supported : null,
});

// ===== `第三方模型` 一行 =====

export interface TrayToggle {
  /// 开关现在开着没有
  on: boolean;
  /// 按不动的原因；能按则为 null。禁用必须同时说原因（进开关的提示框）
  disabledReason: string | null;
}

export interface TrayRow {
  toggle: TrayToggle;
  /// 「重启生效」键：按钮即状态，只在改动等着生效时出现。启用和停用都算——
  /// 停用之后 Codex 的列表同样要重启才会变回去
  showRestart: boolean;
  /// 「启动 Codex」：开着、Codex 桌面应用没在跑（与 Codex 页同一规则，`showLaunchKey`）
  showLaunch: boolean;
  /// 「卸下后台服务」：停用后服务仍在才出现（与 Codex 页同一规则）。三颗键占同一位，
  /// 和「重启生效」同时该出现时让位给重启
  showUninstall: boolean;
}

export function trayRow(state: GatewayState): TrayRow {
  // 与 Codex 页同一个判断（modelsView）：开着时永远能关；三颗键占同一位
  const key = codexKeyKind(state, { kind: "idle" });
  return {
    toggle: { on: state.enabled, disabledReason: switchDisabledReason(state) },
    showRestart: key === "restart",
    showLaunch: key === "launch",
    showUninstall: key === "uninstall",
  };
}
