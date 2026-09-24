/// 「你在哪」（DESIGN「壳：侧栏 + 一块机面」「默认落点」，裁决 D1 D2）：侧栏全栏只有一项选中，
/// 它就是机面里正在显示的那一页。纯逻辑，不碰 api、不产 JSX，tests/shell-place.test.ts 直接测。
///
/// 三种目的地：位置页（`全局` 或一个项目，页内按 domain 分页签：`skills ｜ mcp`，见 domains.ts）、
/// agent 页（按 agent 注册表，今天只有 Codex）、设置。
/// 位置与页签**不随目的地丢掉**：停在 Codex 页时仍记着上次的位置和页签——`⌘1` / `⌘2` 与
/// 「添加来源…」要「回到上次停的位置」。

import { FIRST_DOMAIN, isDomain, type DomainId } from "./domains.ts";

/// 位置页的页签＝domain 的 id（存 id 不存序号）
export type LocationTab = DomainId;
export type View = "location" | "agent" | "settings";

export interface Place {
  view: View;
  /// 上次停的位置：`global` 或 `project:<路径>`（Skills 与 MCP 两边同一套域 key）
  locationKey: string;
  /// 上次停的页签
  tab: LocationTab;
  /// 上次停的 agent（view 为 agent 时生效）
  agentId: string;
}

export const GLOBAL_KEY = "global";

/// 第一次启动落在 `全局 · skills`：扫描一完就是用户已经装着的 skill（D2）
export const DEFAULT_PLACE: Place = {
  view: "location",
  locationKey: GLOBAL_KEY,
  tab: FIRST_DOMAIN,
  agentId: "codex",
};

const STORE = "sophia.shell.place";

/// 存着的那一份认不认得：字段缺了、类型不对都回到默认，逐项取认得的
export function parsePlace(raw: string | null): Place {
  if (!raw) return DEFAULT_PLACE;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return DEFAULT_PLACE;
  }
  if (typeof v !== "object" || v === null) return DEFAULT_PLACE;
  const o = v as Record<string, unknown>;
  const view: View =
    o.view === "agent" || o.view === "settings" || o.view === "location" ? o.view : "location";
  const locationKey =
    typeof o.locationKey === "string" &&
    (o.locationKey === GLOBAL_KEY || o.locationKey.startsWith("project:"))
      ? o.locationKey
      : GLOBAL_KEY;
  // domain 表里没有了（改了表）就落第一个
  const tab: LocationTab = isDomain(o.tab) ? o.tab : FIRST_DOMAIN;
  const agentId = typeof o.agentId === "string" && o.agentId ? o.agentId : DEFAULT_PLACE.agentId;
  return { view, locationKey, tab, agentId };
}

export const serializePlace = (p: Place): string => JSON.stringify(p);

/// 上次停在哪；本机记录不可用（隐私模式、被清）就落默认
export function loadPlace(): Place {
  try {
    return parsePlace(window.localStorage.getItem(STORE));
  } catch {
    return DEFAULT_PLACE;
  }
}

export function savePlace(p: Place) {
  try {
    window.localStorage.setItem(STORE, serializePlace(p));
  } catch {
    // 存不下就下次落默认，不打扰用户
  }
}

/// 记着的目的地还在不在：项目被移除了就落 `全局`（页签不变）；agent 页不存在（非 macOS、
/// 读不到模型状态）就落位置页。`projects` / `agents` 为 null 表示还没读回来——没读回来之前不改，
/// 免得一个只在 MCP 里出现的项目在 MCP 扫描回来之前就被当成「不在了」
export function resolvePlace(
  p: Place,
  projects: ReadonlyArray<string> | null,
  agents: ReadonlyArray<string> | null,
): Place {
  let next = p;
  if (
    projects !== null &&
    next.locationKey !== GLOBAL_KEY &&
    !projects.includes(next.locationKey)
  ) {
    next = { ...next, locationKey: GLOBAL_KEY };
  }
  if (agents !== null && next.view === "agent" && !agents.includes(next.agentId)) {
    next = { ...next, view: "location" };
  }
  return next;
}

/// 侧栏里哪一项是选中的：全栏只有一项（位置页时是那个位置，agent 页时是那个 agent，设置时是设置）
export type SidebarSelection =
  { kind: "location"; key: string } | { kind: "agent"; id: string } | { kind: "settings" };

export function selectionOf(p: Place): SidebarSelection {
  if (p.view === "agent") return { kind: "agent", id: p.agentId };
  if (p.view === "settings") return { kind: "settings" };
  return { kind: "location", key: p.locationKey };
}

export const goLocation = (p: Place, key: string): Place => ({
  ...p,
  view: "location",
  locationKey: key,
});
export const goTab = (p: Place, tab: LocationTab): Place => ({ ...p, view: "location", tab });
export const goAgent = (p: Place, agentId: string): Place => ({ ...p, view: "agent", agentId });
export const goSettings = (p: Place): Place => ({ ...p, view: "settings" });
