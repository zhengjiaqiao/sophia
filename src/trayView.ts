/// 菜单栏面板要显示什么（DESIGN「托盘面板」，画板 V4Layouts-tray）。纯函数，tests/tray-view.test.ts 直接测。
///
/// 面板**一个 agent 一块、一种能力一行**：块与行从外壳的 agent 注册表生成（`src/shell/agents.tsx`），
/// 与侧栏 `agent` 段、agent 页的节同一份名单与顺序；托盘不自己写一份 Codex 名单。
/// 能力行的文案与判断一律取自 modelsView，面板与 Codex 页说同一句话。
import { visibleAgents } from "./shell/agentRegistry.ts";
import type { AgentEntry, AgentState } from "./shell/agentRegistry.ts";
import {
  effectiveModels,
  enableDisabledReason,
  serviceLeftover,
  showLaunchKey,
  totalSelected,
} from "./modelsView.ts";
import type { GatewayState } from "./types.ts";

export { LAUNCH_TIP, RESTART_CONSEQUENCE, RESTART_TIP, UNINSTALL_TIP } from "./modelsView.ts";

// ===== 块与行：从 agent 注册表生成 =====

/// 面板里的一块：块头（图标 + 名字，不放控件）+ 这个 agent 在面板里画得出的能力行
export interface TrayBlock {
  id: string;
  name: string;
  /// 能力行：注册表里这个 agent 的节，按节序；只留面板有画法的（`drawable`）
  rows: { id: string; title: string }[];
}

/// 注册表 → 面板的块。`drawable` 是面板会画的能力行（按节 id，今天只有 `third-party-models`；
/// 以后的 `usage` 在面板里加一种画法即可）。可用且有节的 agent 才成块（同侧栏的入选条件），
/// 一行都画不出的 agent 不成块（空块头是噪音）
export function trayBlocks(
  registry: ReadonlyArray<AgentEntry>,
  s: AgentState,
  drawable: ReadonlySet<string>,
): TrayBlock[] {
  return visibleAgents(registry, s)
    .agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      rows: agent.sections
        .filter((section) => drawable.has(section.id))
        .map((section) => ({ id: section.id, title: section.title })),
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
  // 已启用时永远能关：停用不依赖密钥和模型还在不在
  const disabledReason = state.enabled ? null : enableDisabledReason(state, totalSelected(state));
  return {
    toggle: { on: state.enabled, disabledReason },
    showRestart: state.needsCodexRestart,
    showLaunch: showLaunchKey(state, { kind: "idle" }),
    showUninstall: serviceLeftover(state) && !state.needsCodexRestart,
  };
}

// ===== 在用的模型一行 =====

/// 在用的一个模型：名字（与 agent 页模型片同一个取名）+ 同名时的网关短名（不同名为 null）
export interface TrayModel {
  key: string;
  name: string;
  gateway: string | null;
}

/// 开着时 Codex 里在用的第三方模型，按网关顺序摊平。关着是空（这一行不出）。
/// 名字与同名后缀直接取 `effectiveModels`（agent 页模型片读的同一份）：友好名优先、跨服务商时保留前缀；
/// **只有两家网关的已选模型同名时**才在那个名字后加 ` · 网关短名`（core 给的 `shortName`，与 Codex 目录里同一个）——
/// `·` 只表示「这个名字的出处」，模型之间用 `、` 分（DESIGN「托盘面板」）
export function trayModels(state: GatewayState): TrayModel[] {
  if (!state.enabled) return [];
  return effectiveModels(state).map((m) => ({
    key: `${m.provider.id}|${m.model.id}`,
    name: m.name,
    gateway: m.suffix,
  }));
}

/// 模型名之间的分隔
export const MODEL_SEPARATOR = "、";

/// 一行放得下前几个名字：`widths` 是各名字（含同名后缀）的宽，`sep` 是 `、` 的宽，
/// `more(n)` 是末尾 `+n` 的宽（含它前面的间距），`max` 是行宽。全放得下就全放；
/// 放不下就尽量多放、末尾写 `+剩下的个数`。至少放一个（一个都放不下时由 CSS 截断那一个）
export function fitModelCount(
  widths: readonly number[],
  sep: number,
  more: (n: number) => number,
  max: number,
): number {
  const total = widths.reduce((sum, w, i) => sum + w + (i > 0 ? sep : 0), 0);
  if (total <= max) return widths.length;
  let used = 0;
  let fit = 0;
  for (let i = 0; i < widths.length; i++) {
    const next = used + widths[i] + (i > 0 ? sep : 0);
    const rest = widths.length - (i + 1);
    if (next + (rest > 0 ? more(rest) : 0) > max) break;
    used = next;
    fit = i + 1;
  }
  return Math.max(1, fit);
}
