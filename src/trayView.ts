/// 菜单栏面板要显示什么（DESIGN「托盘面板」，画板 V4Layouts-tray）。纯函数，tests/tray-view.test.ts 直接测。
///
/// 面板**一个 agent 一块、一种能力一行**：块与行从外壳的 agent 注册表生成（`src/shell/agents.tsx`），
/// 与侧栏 `agent` 段、agent 页的节同一份名单与顺序；托盘不自己写一份 Codex 名单。
/// 能力行的文案与判断一律取自 modelsView，面板与 Codex 页说同一句话。
import type { ComponentType } from "react";
import { availableSections } from "./shell/agentRegistry.ts";
import type { AgentEntry, AgentState, TrayRowProps } from "./shell/agentRegistry.ts";
import { claudeKeyKind, claudeSwitchReason } from "./claudeView.ts";
import type { ClaudeKeyKind } from "./claudeView.ts";
import { codexKeyKind, switchDisabledReason } from "./modelsView.ts";
import { codexGateway } from "./types.ts";
import type { ClaudeGatewayView, GatewayState, UsageView } from "./types.ts";

export {
  launchTimeout,
  launchTip,
  restartConsequence,
  restartTip,
  uninstallTip,
} from "./modelsView.ts";

// ===== 块与行：从 agent 注册表生成 =====

/// 面板里的一块：块头（图标 + 名字 + 一段弱字，不放控件）+ 这个 agent 在面板里画得出的能力行
export interface TrayBlock {
  id: string;
  name: string;
  /// 块头名字后的弱字（注册表的 `headNote`，用量的重置时间）；没有是 null
  note: string | null;
  /// 能力行：注册表里这个 agent 的节，按节序；只留带 `trayRow` 画法的
  rows: { id: string; title: string; Row: ComponentType<TrayRowProps> }[];
}

/// 注册表 → 面板的块。行的画法就在注册表的节上（`trayRow`：`usage`、`third-party-models`），面板不认得
/// 具体哪一节。此刻可用的 agent 才成块（还不知道的先不出）；块里只画此刻可用的节（节级 `available`：
/// Claude 没登录时没有 `用量` 一行），一行都画不出的 agent 不成块（空块头是噪音）。
/// 不走 visibleAgents：那是模型页的入选条件，只进托盘的节在这里也要成行
export function trayBlocks(registry: ReadonlyArray<AgentEntry>, s: AgentState): TrayBlock[] {
  return registry
    .filter((agent) => agent.available(s) === true)
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      note: agent.headNote?.(s) ?? null,
      rows: availableSections(agent, s).flatMap((section) =>
        section.trayRow ? [{ id: section.id, title: section.title, Row: section.trayRow }] : [],
      ),
    }))
    .filter((block) => block.rows.length > 0);
}

/// 面板手里的模型状态与用量视图 → 注册表的只读状态（支不支持第三方模型＝后端说的 `supported`）
export const trayAgentState = (
  state: GatewayState | null,
  usage: UsageView | null = null,
): AgentState => ({
  gateway: state,
  modelsSupported: state ? state.supported : null,
  usage,
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
    toggle: { on: codexGateway(state).enabled, disabledReason: switchDisabledReason(state) },
    showRestart: key === "restart",
    showLaunch: key === "launch",
    showUninstall: key === "uninstall",
  };
}

// ===== Claude 块的 `第三方模型` 一行（spec 2026-09-29 R44；DESIGN「托盘面板」「Claude 的页：桌面应用」） =====
//
// 判断与文案（开关提示框、重启确认正文、键的提示框、拨开关的两句）取自 claudeView：与 Claude 的页、列表行说同一句话

export interface TrayClaudeRow {
  toggle: TrayToggle;
  /// 开关左边 12 那一位：`重启生效` / `打开 Claude`（同一位、不同时出现，`重启生效` 优先）；没有是 null
  key: ClaudeKeyKind | null;
  /// 开着：能力行下一行灰字 `账号里的对话暂时看不到`（代价写在明处）
  cost: boolean;
}

export function trayClaudeRow(view: ClaudeGatewayView): TrayClaudeRow {
  return {
    // 按不动时说「怎么办」；别家配置在生效时说去模型页接管（托盘里「进去」指代不清）
    toggle: { on: view.enabled, disabledReason: claudeSwitchReason(view, "tray") },
    key: claudeKeyKind(view),
    cost: view.enabled,
  };
}
