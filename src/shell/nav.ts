/// 「你在哪」（spec 2026-09-26-object-first-navigation R3 R4 R12）：目的地与范围分开记。
/// 目的地是侧栏选中的那一项（全栏只有一项）；范围是 SKILLS / MCP 页面头滑槽与项目筛选片的状态，
/// 两页共用一个，到模型页、设置时也记着——回到 SKILLS 仍是上次的范围。
/// 纯逻辑，不碰 api、不产 JSX，tests/shell-nav.test.ts 直接测。

export type Destination = "skills" | "mcp" | "models" | "settings";
export type ScopeLevel = "all" | "user" | "project";

export interface Scope {
  level: ScopeLevel;
  /// 选中的那个项目（域 key `project:<路径>`）；null＝这一档里的全部。`user` 档恒为 null
  project: string | null;
}

export interface Nav {
  destination: Destination;
  scope: Scope;
}

/// 用户级的域 key（界面上叫「用户级」，数据里仍是 `global`）
export const GLOBAL_KEY = "global";
const PROJECT_PREFIX = "project:";

/// 第一次启动落在 `SKILLS · 全部`：一眼看全用户级与各项目
export const DEFAULT_NAV: Nav = { destination: "skills", scope: { level: "all", project: null } };

const DESTINATIONS: ReadonlyArray<Destination> = ["skills", "mcp", "models", "settings"];
const LEVELS: ReadonlyArray<ScopeLevel> = ["all", "user", "project"];

const isProjectKey = (v: unknown): v is string =>
  typeof v === "string" && v.startsWith(PROJECT_PREFIX) && v.length > PROJECT_PREFIX.length;

const scopeOf = (level: ScopeLevel, project: string | null): Scope => ({
  level,
  project: level === "user" ? null : project,
});

const asObject = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/// 存着的那一份认不认得：逐项取认得的，认不得的回到默认
export function parseNav(raw: string | null): Nav {
  const o = asObject(raw);
  if (!o) return DEFAULT_NAV;
  const destination = DESTINATIONS.includes(o.destination as Destination)
    ? (o.destination as Destination)
    : DEFAULT_NAV.destination;
  const s = typeof o.scope === "object" && o.scope !== null ? (o.scope as Record<string, unknown>) : {};
  const level = LEVELS.includes(s.level as ScopeLevel) ? (s.level as ScopeLevel) : "all";
  const project = isProjectKey(s.project) ? s.project : null;
  return { destination, scope: scopeOf(level, project) };
}

export const serializeNav = (n: Nav): string => JSON.stringify(n);

/// 升级前的落点（`sophia.shell.place`：`{view, locationKey, tab, agentId}`）换算成新的：
/// 旧「全局」→ 用户级；旧某个项目 → 项目级并选中它；旧 Codex 页 → 模型页；读不懂 → 默认。
/// 没有旧记忆返回 null（不需要迁移）
export function migrateFromPlace(raw: string | null): Nav | null {
  if (raw === null) return null;
  const o = asObject(raw);
  if (!o) return DEFAULT_NAV;
  const destination: Destination =
    o.view === "agent"
      ? "models"
      : o.view === "settings"
        ? "settings"
        : o.tab === "mcp"
          ? "mcp"
          : "skills";
  const scope: Scope =
    o.locationKey === GLOBAL_KEY
      ? scopeOf("user", null)
      : isProjectKey(o.locationKey)
        ? scopeOf("project", o.locationKey)
        : DEFAULT_NAV.scope;
  return { destination, scope };
}

/// 记着的东西还在不在：选中的项目没了 → 同一档的全部；模型页不存在（非 macOS）→ SKILLS。
/// `projects` / `modelsAvailable` 为 null 表示还没读回来——没读回来之前不改，免得把还没扫到的项目当成不在了
export function resolveNav(
  n: Nav,
  projects: ReadonlyArray<string> | null,
  modelsAvailable: boolean | null,
): Nav {
  let next = n;
  if (projects !== null && next.scope.project !== null && !projects.includes(next.scope.project)) {
    next = { ...next, scope: scopeOf(next.scope.level, null) };
  }
  if (modelsAvailable === false && next.destination === "models") {
    next = { ...next, destination: "skills" };
  }
  return next;
}

/// 这一屏涉及哪些位置（域 key，用户级在前）：
/// 全部＝用户级 + 全部项目（点了某个项目＝用户级 + 它）；用户级＝只有它；项目级＝全部项目（点了＝只有它）
export function locationsOf(scope: Scope, projects: ReadonlyArray<string>): string[] {
  const picked = scope.project !== null ? [scope.project] : [...projects];
  if (scope.level === "user") return [GLOBAL_KEY];
  if (scope.level === "project") return picked;
  return [GLOBAL_KEY, ...picked];
}

export const goDestination = (n: Nav, destination: Destination): Nav => ({ ...n, destination });

/// 切档：用户级不带项目；全部与项目级之间保留选中的项目
export const goLevel = (n: Nav, level: ScopeLevel): Nav => ({
  ...n,
  scope: scopeOf(level, n.scope.project),
});

/// 点项目筛选片（null＝这一档里的全部）
export const goProject = (n: Nav, project: string | null): Nav => ({
  ...n,
  scope: scopeOf(n.scope.level, project),
});

const STORE = "sophia.shell.nav";
const OLD_STORE = "sophia.shell.place";

/// 上次停在哪：有新记录读新的；没有就把升级前的旧记录换算一次（旧键不删）；都没有落默认
export function loadNav(): Nav {
  try {
    const raw = window.localStorage.getItem(STORE);
    if (raw !== null) return parseNav(raw);
    return migrateFromPlace(window.localStorage.getItem(OLD_STORE)) ?? DEFAULT_NAV;
  } catch {
    return DEFAULT_NAV;
  }
}

export function saveNav(n: Nav) {
  try {
    window.localStorage.setItem(STORE, serializeNav(n));
  } catch {
    // 存不下就下次落默认，不打扰用户
  }
}
