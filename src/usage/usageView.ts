/// 用量的前端取用（spec 2026-09-26-menubar-usage R10 R11）。纯函数，tests 直接测。
/// 文字（倒计时、剩 / 用、过期、状态句）全在 core 的 `usage::format::usage_view` 里算好，这里只按 agent 取出来，
/// 不另写一份规则。
import { t, tn } from "../i18n.ts";
import type { AgentState } from "../shell/agentRegistry.ts";
import type { AgentDisplay, TrayUsage, UsageAgentId, UsageSettings, UsageView } from "../types.ts";

/// 这个 agent 在托盘里的用量；没登录、用量还没读回来是 null
export const trayUsageOf = (s: AgentState, agent: string): TrayUsage | null =>
  s.usage?.tray.find((u) => u.agent === agent) ?? null;

/// 托盘块头名字后的弱字：「3 分钟前更新」，有读数就写（R10）；重置时间跟着各自的窗口
export const usageHeadNote = (s: AgentState, agent: string): string | null =>
  trayUsageOf(s, agent)?.updatedText ?? null;

/// 原因行右端那一处（2026-10-03 产品负责人）：`retry`＝「再试一次」，`retrying`＝刻度 +「正在读取」，
/// null＝什么都不给。能不能再试由后端按原因算好（`usage.retry`）；取到了（原因行没了）就正常画，不留「正在读取」
export function usageNoteAction(usage: TrayUsage, retrying: boolean): "retry" | "retrying" | null {
  if (usage.note === null) return null;
  if (retrying) return "retrying";
  return usage.retry ? "retry" : null;
}

/// 这个 agent 出不出用量行（托盘）/ 栏（用量页「当前用量」）：后端算好的 `tray` 里有它就出——有用量来源的
/// （R10：Claude Code 已登录，或桌面应用有用量记录），加上装了 Claude 桌面应用、读不到数的 Claude（给「连接 Claude 用量」，
/// 票 #208）；用量还没读回来是 null（先不列）
export const usageShown = (s: AgentState, agent: UsageAgentId): boolean | null =>
  s.usage === null ? null : s.usage.tray.some((u) => u.agent === agent);

// ===== 用量页（R11 R12） =====

/// 菜单栏最多显示几个 agent（与 core 的 `MAX_MENU_BAR_AGENTS` 同一个数）
export const MAX_MENU_BAR_AGENTS = 3;

/// 有用量的 agent，顺序同 core 的 `AgentId::ALL`（默认名单按它排）；名字是专名，原样
const USAGE_AGENTS: ReadonlyArray<{ id: UsageAgentId; name: string }> = [
  // `Claude`（产品负责人 2026-09-29）：额度属于 Claude 账号，命令行、桌面应用、claude.ai 共用；与托盘块名一致
  { id: "claude-code", name: "Claude" },
  { id: "codex", name: "Codex" },
];

export const usageAgentName = (id: UsageAgentId): string =>
  USAGE_AGENTS.find((a) => a.id === id)?.name ?? id;

/// 菜单栏显示哪些 agent：配过就用配的，没配过取已登录的（最多 3 个，R12）；同 core 的 `effective_agents`
export function menuBarAgents(view: UsageView): UsageAgentId[] {
  const configured = view.settings.agents;
  const list =
    configured ?? USAGE_AGENTS.map((a) => a.id).filter((id) => view.signedIn.includes(id));
  return list.slice(0, MAX_MENU_BAR_AGENTS);
}

export interface AgentChoice {
  id: UsageAgentId;
  name: string;
  selected: boolean;
  /// 选满了、点不了的原因；能点是 null
  disabledReason: string | null;
}

/// 「显示哪些 agent」的片：已登录的，加上配过的（没登录了也留着，好取消），按注册表顺序
export function agentChoices(view: UsageView, max: number = MAX_MENU_BAR_AGENTS): AgentChoice[] {
  const chosen = menuBarAgents(view);
  const full = chosen.length >= max;
  return USAGE_AGENTS.filter((a) => view.signedIn.includes(a.id) || chosen.includes(a.id)).map(
    (a) => {
      const selected = chosen.includes(a.id);
      return {
        id: a.id,
        name: a.name,
        selected,
        disabledReason: full && !selected ? tn("usage.agents.maxShown", max) : null,
      };
    },
  );
}

/// 点一个 agent 的片：没配过时从默认名单（已登录的）起算，存成按注册表顺序的名单
export function toggleMenuBarAgent(
  settings: UsageSettings,
  signedIn: ReadonlyArray<UsageAgentId>,
  id: UsageAgentId,
): UsageSettings {
  const current =
    settings.agents ?? USAGE_AGENTS.map((a) => a.id).filter((a) => signedIn.includes(a));
  const next = current.includes(id) ? current.filter((a) => a !== id) : [...current, id];
  const ordered = USAGE_AGENTS.map((a) => a.id).filter((a) => next.includes(a));
  return { ...settings, agents: ordered.slice(0, MAX_MENU_BAR_AGENTS) };
}

export interface WindowOption {
  /// `auto` / `none` 或窗口的 key
  id: string;
  label: string;
}

/// 这个 agent 此刻拿到的窗口；配过、但此刻拿不到的窗口也列上（用 key 当名字），免得选中项凭空消失
function windowOptions(view: UsageView, agent: UsageAgentId, keep: string | null): WindowOption[] {
  const windows =
    view.state.agents
      .find((a) => a.agent === agent)
      ?.reading?.windows.map((w) => ({
        id: w.key,
        label: w.label,
      })) ?? [];
  if (keep !== null && !windows.some((w) => w.id === keep)) windows.push({ id: keep, label: keep });
  return windows;
}

const displayOf = (settings: UsageSettings, agent: UsageAgentId): AgentDisplay =>
  settings.perAgent[agent] ?? {
    primary: null,
    secondary: null,
    stacked: false,
    stackedSize: "small",
  };

/// 主窗口：「自动」（服务端标为起作用的窗口，没有就取用得最多的）+ 各窗口
export const primaryOptions = (view: UsageView, agent: UsageAgentId): WindowOption[] => [
  { id: "auto", label: t("usage.window.auto") },
  ...windowOptions(view, agent, displayOf(view.settings, agent).primary),
];

/// 第二窗口：「无」+ 除主窗口外的各窗口（主窗口是「自动」时全列，
/// 选中的恰好是自动选出的那个时，菜单栏只画一个数）
export function secondaryOptions(view: UsageView, agent: UsageAgentId): WindowOption[] {
  const d = displayOf(view.settings, agent);
  return [
    { id: "none", label: t("usage.window.none") },
    ...windowOptions(view, agent, d.secondary).filter((o) => o.id !== d.primary),
  ];
}

/// 这个 agent 此刻拿到几个窗口；只有一个时不出「第二窗口」一行，除非以前选过
export const windowCount = (view: UsageView, agent: UsageAgentId): number =>
  view.state.agents.find((a) => a.agent === agent)?.reading?.windows.length ?? 0;

/// 选主窗口（`null`＝自动）；选成和第二窗口同一个时，第二窗口清成「无」
export function choosePrimary(
  settings: UsageSettings,
  agent: UsageAgentId,
  primary: string | null,
): UsageSettings {
  const d = displayOf(settings, agent);
  return setAgentDisplay(settings, agent, {
    primary,
    secondary: primary !== null && d.secondary === primary ? null : d.secondary,
  });
}

export const agentDisplay = displayOf;

/// 改一个 agent 的显示方式；没配过的从默认值起，别的 agent 不动
export function setAgentDisplay(
  settings: UsageSettings,
  agent: UsageAgentId,
  patch: Partial<AgentDisplay>,
): UsageSettings {
  return {
    ...settings,
    perAgent: { ...settings.perAgent, [agent]: { ...displayOf(settings, agent), ...patch } },
  };
}
