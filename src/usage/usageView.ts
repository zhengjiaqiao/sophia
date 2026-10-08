/// 用量的前端取用（spec 2026-09-26-menubar-usage R10 R11；项扩成 agent 或模型提供商见 spec #322）。纯函数，tests 直接测。
/// 文字（倒计时、剩 / 用、过期、状态句）全在 core 的 `usage::format::usage_view` 里算好，这里只按项的键取出来，
/// 不另写一份规则。项的键：`agent:claude-code`、`agent:codex`、`provider:<提供商 id>`
import { t, tn } from "../i18n.ts";
import type { AgentState } from "../shell/agentRegistry.ts";
import type {
  AgentDisplay,
  UsageAgentId,
  UsageItemKey,
  UsageItemView,
  UsageSettings,
  UsageView,
} from "../types.ts";

/// agent 的项的键（同 core `UsageSubject::Agent` 的序列化）
export const agentItemKey = (agent: string): UsageItemKey => `agent:${agent}`;

/// 由项的键认出 agent；不是 agent 的项是 null
export function agentOfItemKey(key: UsageItemKey): UsageAgentId | null {
  const id = key.startsWith("agent:") ? key.slice("agent:".length) : null;
  return USAGE_AGENTS.find((a) => a.id === id)?.id ?? null;
}

/// 这个 agent 在托盘里的用量；没登录、用量还没读回来是 null
export const trayUsageOf = (s: AgentState, agent: string): UsageItemView | null =>
  s.usage?.items.find((u) => u.key === agentItemKey(agent)) ?? null;

/// 托盘块头名字后的弱字：「3 分钟前更新」，有读数就写（R10）；重置时间跟着各自的窗口
export const usageHeadNote = (s: AgentState, agent: string): string | null =>
  trayUsageOf(s, agent)?.updatedText ?? null;

/// 原因行右端那一处（2026-10-03 产品负责人）：`retry`＝「再试一次」，`retrying`＝刻度 +「正在读取」，
/// null＝什么都不给。能不能再试由后端按原因算好（`usage.retry`）；取到了（原因行没了）就正常画，不留「正在读取」
export function usageNoteAction(
  usage: UsageItemView,
  retrying: boolean,
): "retry" | "retrying" | null {
  if (usage.note === null) return null;
  if (retrying) return "retrying";
  return usage.retry ? "retry" : null;
}

/// 这个 agent 出不出用量行（托盘）/ 栏（用量页「当前用量」）：后端算好的 `items` 里有它就出——有用量来源的
/// （R10：Claude Code 已登录，或桌面应用有用量记录），加上装了 Claude 桌面应用、读不到数的 Claude（给「连接 Claude 用量」，
/// 票 #208）；用量还没读回来是 null（先不列）
export const usageShown = (s: AgentState, agent: UsageAgentId): boolean | null =>
  s.usage === null ? null : s.usage.items.some((u) => u.key === agentItemKey(agent));

// ===== 用量页（R11 R12） =====

/// 菜单栏最多显示几项，agent 与提供商合计（与 core 的 `MAX_MENU_BAR_ITEMS` 同一个数）
export const MAX_MENU_BAR_ITEMS = 2;

/// 有用量的 agent，顺序同 core 的 `AgentId::ALL`（页面顺序先按它排 agent）；名字是专名，原样
const USAGE_AGENTS: ReadonlyArray<{ id: UsageAgentId; name: string }> = [
  // `Claude`（产品负责人 2026-09-29）：额度属于 Claude 账号，命令行、桌面应用、claude.ai 共用；与托盘块名一致
  { id: "claude-code", name: "Claude" },
  { id: "codex", name: "Codex" },
];

export const usageAgentName = (id: string): string =>
  USAGE_AGENTS.find((a) => a.id === id)?.name ?? id;

/// 页面顺序（同 core 的 `page_order`）：先 agent（按 agent 表），再提供商（按后端排好的 `items` 里的先后）
function pageOrder(view: UsageView): UsageItemKey[] {
  return [
    ...USAGE_AGENTS.map((a) => agentItemKey(a.id)),
    ...view.items.filter((i) => i.kind === "provider").map((i) => i.key),
  ];
}

/// 这一项的名字：后端给的，后端没列（没登录了）就按 agent 表，再不行用键
export function usageItemName(view: UsageView, key: UsageItemKey): string {
  const item = view.items.find((i) => i.key === key);
  if (item) return item.name;
  const agent = agentOfItemKey(key);
  return agent ? usageAgentName(agent) : key;
}

/// 这一项取标志用的 id
export function usageItemBrand(view: UsageView, key: UsageItemKey): string {
  return view.items.find((i) => i.key === key)?.brand ?? agentOfItemKey(key) ?? key;
}

/// 菜单栏显示哪些项：选过就用选的，没选过取有用量来源的；按页面顺序，最多 2 项（R12、spec #322）；
/// 同 core 的 `effective_items`
export function menuBarAgents(view: UsageView): UsageItemKey[] {
  const chosen = view.settings.items ?? view.signedIn;
  return pageOrder(view)
    .filter((key) => chosen.includes(key))
    .slice(0, MAX_MENU_BAR_ITEMS);
}

export interface AgentChoice {
  /// 项的键
  id: UsageItemKey;
  /// 取标志用的 id
  brand: string;
  name: string;
  selected: boolean;
  /// 选满了、点不了的原因；能点是 null
  disabledReason: string | null;
}

/// 「显示哪些」的片：有用量来源的，加上选过的（没登录了也留着，好取消），按页面顺序
export function agentChoices(view: UsageView, max: number = MAX_MENU_BAR_ITEMS): AgentChoice[] {
  const chosen = menuBarAgents(view);
  const full = chosen.length >= max;
  return pageOrder(view)
    .filter((key) => view.signedIn.includes(key) || chosen.includes(key))
    .map((key) => {
      const selected = chosen.includes(key);
      return {
        id: key,
        brand: usageItemBrand(view, key),
        name: usageItemName(view, key),
        selected,
        disabledReason: full && !selected ? tn("usage.agents.maxShown", max) : null,
      };
    });
}

/// 点一项的片：没选过时从默认名单（有用量来源的）起算。存的是集合（菜单栏上的先后由页面顺序算），
/// 为了存下来稳定，agent 按 agent 表排在前、提供商照点的先后在后
export function toggleMenuBarAgent(
  settings: UsageSettings,
  signedIn: ReadonlyArray<UsageItemKey>,
  key: UsageItemKey,
): UsageSettings {
  const current = settings.items ?? [...signedIn];
  const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
  const ordered = [
    ...USAGE_AGENTS.map((a) => agentItemKey(a.id)).filter((k) => next.includes(k)),
    ...next.filter((k) => agentOfItemKey(k) === null),
  ];
  return { ...settings, items: ordered.slice(0, MAX_MENU_BAR_ITEMS) };
}

export interface WindowOption {
  /// `auto` / `none` 或窗口的 key
  id: string;
  label: string;
}

/// 这一项此刻拿到的窗口；配过、但此刻拿不到的窗口也列上（用 key 当名字），免得选中项凭空消失。
/// 提供商的窗口在 #325 接入后从它的读数里取
function windowOptions(view: UsageView, key: UsageItemKey, keep: string | null): WindowOption[] {
  const windows =
    view.state.agents
      .find((a) => agentItemKey(a.agent) === key)
      ?.reading?.windows.map((w) => ({
        id: w.key,
        label: w.label,
      })) ?? [];
  if (keep !== null && !windows.some((w) => w.id === keep)) windows.push({ id: keep, label: keep });
  return windows;
}

const displayOf = (settings: UsageSettings, key: UsageItemKey): AgentDisplay =>
  settings.perItem[key] ?? {
    primary: null,
    secondary: null,
    stacked: false,
    stackedSize: "small",
  };

/// 主窗口：「自动」（服务端标为起作用的窗口，没有就取用得最多的）+ 各窗口
export const primaryOptions = (view: UsageView, key: UsageItemKey): WindowOption[] => [
  { id: "auto", label: t("usage.window.auto") },
  ...windowOptions(view, key, displayOf(view.settings, key).primary),
];

/// 第二窗口：「无」+ 除主窗口外的各窗口（主窗口是「自动」时全列，
/// 选中的恰好是自动选出的那个时，菜单栏只画一个数）
export function secondaryOptions(view: UsageView, key: UsageItemKey): WindowOption[] {
  const d = displayOf(view.settings, key);
  return [
    { id: "none", label: t("usage.window.none") },
    ...windowOptions(view, key, d.secondary).filter((o) => o.id !== d.primary),
  ];
}

/// 这一项此刻拿到几个窗口；只有一个时不出「第二窗口」一行，除非以前选过
export const windowCount = (view: UsageView, key: UsageItemKey): number =>
  view.state.agents.find((a) => agentItemKey(a.agent) === key)?.reading?.windows.length ?? 0;

/// 选主窗口（`null`＝自动）；选成和第二窗口同一个时，第二窗口清成「无」
export function choosePrimary(
  settings: UsageSettings,
  key: UsageItemKey,
  primary: string | null,
): UsageSettings {
  const d = displayOf(settings, key);
  return setAgentDisplay(settings, key, {
    primary,
    secondary: primary !== null && d.secondary === primary ? null : d.secondary,
  });
}

export const agentDisplay = displayOf;

/// 改一项的显示方式；没配过的从默认值起，别的项不动
export function setAgentDisplay(
  settings: UsageSettings,
  key: UsageItemKey,
  patch: Partial<AgentDisplay>,
): UsageSettings {
  return {
    ...settings,
    perItem: { ...settings.perItem, [key]: { ...displayOf(settings, key), ...patch } },
  };
}
