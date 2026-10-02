/// 「你在哪」（spec 2026-09-26-object-first-navigation R3 R12；2026-09-27-skill-mcp-market R1–R3）：
/// 目的地、位置与每页看哪一面分开记。
/// - 目的地是侧栏选中的那一项（全栏只有一项）；
/// - 位置是 SKILLS / MCP 筛选行 `位置` 胶囊的状态，**两页各记各的**（2026-09-27 产品负责人：「skill 和 mcp 的筛选项，现在是绑定的」——
///   两页关心的东西不同，在 SKILLS 看某个项目不该把 MCP 也带过去），到模型页、设置时也记着；
/// - 面（`我的 ｜ 发现`）两页各记各的：切到别的页再回来，停在上次那一面。
/// 纯逻辑，不碰 api、不产 JSX，tests/shell-nav.test.ts 直接测。

export type Destination = "skills" | "mcp" | "models" | "usage" | "settings";
/// 有 `我的 ｜ 发现` 两面的目的地
export type ScopedDestination = "skills" | "mcp";
/// 页面头左端滑槽的两面：`我的`（已有的，表格）与 `发现`（外面有的）
export type Face = "mine" | "discover";

/// 项目的域 key：`project:<路径>`
export type ProjectKey = `project:${string}`;

/// 筛选行 `位置` 胶囊选的是什么（单选）：
/// `all`＝用户级 + 全部项目；`user`＝只看用户级；某个项目的域 key＝只看这个项目
export type Location = "all" | "user" | ProjectKey;

export interface Nav {
  destination: Destination;
  /// 两页各停在哪个位置
  location: Record<ScopedDestination, Location>;
  /// 两页各停在哪一面
  face: Record<ScopedDestination, Face>;
}

/// 用户级的域 key（界面上叫「用户级」，数据里仍是 `global`）
export const GLOBAL_KEY = "global";
const PROJECT_PREFIX = "project:";

/// 第一次启动落在 `SKILLS · 我的 · 全部`：一眼看全用户级与各项目
export const DEFAULT_NAV: Nav = {
  destination: "skills",
  location: { skills: "all", mcp: "all" },
  face: { skills: "mine", mcp: "mine" },
};

const both = (l: Location): Record<ScopedDestination, Location> => ({ skills: l, mcp: l });

const DESTINATIONS: ReadonlyArray<Destination> = ["skills", "mcp", "models", "usage", "settings"];
const FACES: ReadonlyArray<Face> = ["mine", "discover"];

export const isProjectKey = (v: unknown): v is ProjectKey =>
  typeof v === "string" && v.startsWith(PROJECT_PREFIX) && v.length > PROJECT_PREFIX.length;

const isLocation = (v: unknown): v is Location => v === "all" || v === "user" || isProjectKey(v);

const isScopedDestination = (d: Destination): d is ScopedDestination =>
  d === "skills" || d === "mcp";

const asObject = (raw: unknown): Record<string, unknown> | null =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;

const parseObject = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) return null;
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return null;
  }
};

/// 旧导航状态的范围（2026-09-26：页面头滑槽 `全部 ｜ 用户级 ｜ 项目级` + 项目筛选片）换算成位置（R3）：
/// `全部`、`项目级` 未选项目 → `全部`；选了项目 X → X；`用户级` → `用户级`；认不得 → `全部`。
/// X 已不在由 `resolveNav` 落回 `全部`（项目列表读回来之后）；旧的来源筛选不迁
export function migrateScope(scope: unknown): Location {
  const s = asObject(scope);
  if (!s) return "all";
  if (s.level === "user") return "user";
  if ((s.level === "all" || s.level === "project") && isProjectKey(s.project)) return s.project;
  return "all";
}

/// 存着的那一份认不认得：逐项取认得的，认不得的回到默认。旧形状（带 `scope`、没有 `location`）按 R3 换算
export function parseNav(raw: string | null): Nav {
  const o = parseObject(raw);
  if (!o) return DEFAULT_NAV;
  const destination = DESTINATIONS.includes(o.destination as Destination)
    ? (o.destination as Destination)
    : DEFAULT_NAV.destination;
  // 旧形状：两页共用一个位置（字符串）或更早的 `scope`——升级时两页都从它起步
  const lo = asObject(o.location);
  const location: Record<ScopedDestination, Location> = lo
    ? {
        skills: isLocation(lo.skills) ? lo.skills : "all",
        mcp: isLocation(lo.mcp) ? lo.mcp : "all",
      }
    : isLocation(o.location)
      ? both(o.location)
      : "scope" in o
        ? both(migrateScope(o.scope))
        : DEFAULT_NAV.location;
  const f = asObject(o.face) ?? {};
  const faceOfPage = (page: ScopedDestination): Face =>
    FACES.includes(f[page] as Face) ? (f[page] as Face) : "mine";
  return { destination, location, face: { skills: faceOfPage("skills"), mcp: faceOfPage("mcp") } };
}

export const serializeNav = (n: Nav): string => JSON.stringify(n);

/// 升级前的落点（`sophia.shell.place`：`{view, locationKey, tab, agentId}`）换算成新的：
/// 旧「全局」→ 用户级；旧某个项目 → 这个项目；旧 Codex 页 → 模型页；读不懂 → 默认。
/// 没有旧记忆返回 null（不需要迁移）
export function migrateFromPlace(raw: string | null): Nav | null {
  if (raw === null) return null;
  const o = parseObject(raw);
  if (!o) return DEFAULT_NAV;
  const destination: Destination =
    o.view === "agent"
      ? "models"
      : o.view === "settings"
        ? "settings"
        : o.tab === "mcp"
          ? "mcp"
          : "skills";
  const location: Location =
    o.locationKey === GLOBAL_KEY ? "user" : isProjectKey(o.locationKey) ? o.locationKey : "all";
  return { ...DEFAULT_NAV, destination, location: both(location) };
}

/// 记着的东西还在不在：选中的项目没了 → `全部`；模型页、用量页不存在（非 macOS）→ SKILLS。
/// `projects` / `modelsAvailable` / `usageAvailable` 为 null 表示还没读回来——没读回来之前不改，
/// 免得把还没扫到的项目当成不在了
export function resolveNav(
  n: Nav,
  projects: ReadonlyArray<string> | null,
  modelsAvailable: boolean | null,
  usageAvailable: boolean | null = null,
): Nav {
  let next = n;
  if (projects !== null) {
    const gone = (l: Location) => isProjectKey(l) && !projects.includes(l);
    if (gone(next.location.skills) || gone(next.location.mcp)) {
      next = {
        ...next,
        location: {
          skills: gone(next.location.skills) ? "all" : next.location.skills,
          mcp: gone(next.location.mcp) ? "all" : next.location.mcp,
        },
      };
    }
  }
  if (modelsAvailable === false && next.destination === "models") {
    next = { ...next, destination: "skills" };
  }
  if (usageAvailable === false && next.destination === "usage") {
    next = { ...next, destination: "skills" };
  }
  return next;
}

/// 这一屏涉及哪些位置（域 key，用户级在前）：全部＝用户级 + 全部项目；用户级＝只有它；某个项目＝只有它
export function locationsOf(location: Location, projects: ReadonlyArray<string>): string[] {
  if (location === "user") return [GLOBAL_KEY];
  if (location === "all") return [GLOBAL_KEY, ...projects];
  return [location];
}

/// 这一页此刻停在哪一面；模型页、设置没有面，算 `我的`
export const faceOf = (n: Nav): Face =>
  isScopedDestination(n.destination) ? n.face[n.destination] : "mine";

export const goDestination = (n: Nav, destination: Destination): Nav => ({ ...n, destination });

/// 这一页此刻的位置；模型页、设置没有位置，取 SKILLS 的（不会用来出表）
export const locationOf = (n: Nav): Location =>
  n.location[isScopedDestination(n.destination) ? n.destination : "skills"];

/// 点 `位置` 胶囊（或「更多」列表里的一项）：只改当前这一页的位置；不在 SKILLS / MCP 原样返回
export function goLocation(n: Nav, location: Location): Nav {
  if (!isScopedDestination(n.destination) || n.location[n.destination] === location) return n;
  return { ...n, location: { ...n.location, [n.destination]: location } };
}

/// 切 `我的 ｜ 发现`：只改当前这一页的那一面；已经在那一面（或不在 SKILLS / MCP）原样返回同一个对象
export function goFace(n: Nav, face: Face): Nav {
  if (!isScopedDestination(n.destination) || n.face[n.destination] === face) return n;
  return { ...n, face: { ...n.face, [n.destination]: face } };
}

const STORE = "sophia.shell.nav";
const OLD_STORE = "sophia.shell.place";

/// 上次停在哪：有新记录读新的（旧形状的就地换算）；没有就把升级前的旧落点换算一次（旧键不删）；都没有落默认
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
