/// `发现` 列表与介绍页的纯逻辑（spec 2026-09-27-skill-mcp-market R5 R5B R7 R16；DESIGN「发现与安装」）：
/// 表头、排序、`✓ 已安装` 的判断、灰面板那一句、来历行的读数、MCP 的连接方式与要填的。
/// 不碰 api、不碰 DOM，node:test 直接测（tests/market-discover.test.ts）
import { relativeTime } from "../dateText.ts";
import { listText, locale, t, tn } from "../i18n.ts";
import { fieldText } from "./installView.ts";
import type {
  LocationKey,
  MarketFallback,
  McpDefinitionInput,
  McpFieldSpec,
  McpRow,
  SkillRow,
  SkillList,
} from "../types.ts";

/// GitHub 限流时在触发处说的那一句（R16）
export const rateLimited = () => t("market.rateLimited");

/// 装过的人：中文一万以下写整数，一万起写 `12.4 万`（去掉末尾的 .0）；其他语言按 `Intl` 的紧凑写法（`12K`）
export function formatInstalls(n: number, lang: string = locale()): string {
  const { text, wan } = installsParts(n, lang);
  return wan ? t("market.installs.wan", { value: text }) : text;
}

/// 数字部分与是否按「万」写（中文一万起）：`12.4` + 万 / `812`。非中文语言没有「万」，数字交给 `Intl`
function installsParts(n: number, lang: string): { text: string; wan: boolean } {
  if (!Number.isFinite(n) || n < 0) return { text: "0", wan: false };
  if (!lang.startsWith("zh")) {
    return {
      text: new Intl.NumberFormat(lang, { notation: "compact" }).format(Math.round(n)),
      wan: false,
    };
  }
  if (n < 10_000) return { text: String(Math.round(n)), wan: false };
  const value = Math.round(n / 1_000) / 10;
  const text = value >= 1_000 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return { text, wan: true };
}

/// 来历行的「装过的人」：`6.2 万人装过` / `812 人装过`。数字文本是格式化后的，`count` 传原数以选单复数
export function installsText(n: number, lang: string = locale()): string {
  const { text, wan } = installsParts(n, lang);
  const count = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  return tn(wan ? "market.installs.peopleWan" : "market.installs.people", count, { value: text });
}

/// 装过了没有：`installedIn` 非空＝装过（`安装` 换成状态 `✓ 已安装`，R5）
export function isInstalled(row: { installedIn: ReadonlyArray<LocationKey> }): boolean {
  return row.installedIn.length > 0;
}

/// skill 列表按装过的人从多到少排；一样多时保持原来的先后（稳定）。不改入参
export function sortSkills<T extends { installs: number }>(items: ReadonlyArray<T>): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.installs - a.item.installs || a.index - b.index)
    .map(({ item }) => item);
}

/// skills.sh 不到 2 个字直接报错：这时列热门
export const MIN_SKILL_QUERY = 2;

/// 实际拿去搜 skill 的词：去掉首尾空白；不到 2 个字当没输入（列热门）
export function skillQuery(query: string): string {
  const q = query.trim();
  return [...q].length < MIN_SKILL_QUERY ? "" : q;
}

/// skill 列表的表头：没输入（或不到 2 个字）时 `热门 N`，输入后 `搜索结果 N`（R5）
export function skillHeader(query: string, count: number): { label: string; count: number } {
  return {
    label: t(skillQuery(query) === "" ? "market.header.popular" : "market.header.results"),
    count,
  };
}

/// 热门列表上方那一句：取自哪、多久前（旧缓存不冒充刚更新的榜单）。
/// `热门排行 · 3 分钟前更新`（2026-09-30 产品负责人真机：不写「来自 skills.sh」）；还没取到过在线榜单时 `随包附带的列表`
export function popularText(popular: SkillList["popular"], now: Date = new Date()): string {
  if (popular?.source !== "online") return t("market.popular.bundled");
  if (popular.updatedAt == null) return t("market.popular.online");
  return t("market.popular.updatedAt", { time: relativeTime(popular.updatedAt * 1000, now, true) });
}

/// 一行的身份：列表刷新后介绍页据它找回同一条（装完 `installedIn` 会变）
export function skillKey(row: Pick<SkillRow, "repo" | "name" | "path">): string {
  return `${row.repo}\u0000${row.path ?? ""}\u0000${row.name}`;
}
export function mcpKey(row: Pick<McpRow, "id">): string {
  return row.id;
}

/// skill 来自谁（#307）：`owner/repo` 的作者那一段。列表 `来自` 一列、来历行的第一层只写它
export function repoOwner(repo: string): string {
  const cut = repo.indexOf("/");
  return cut > 0 ? repo.slice(0, cut) : repo;
}

/// 介绍页 / 安装页来历行的第一段（#307）：第一层 `来自 anthropics`；第二层（悬停，等宽）是精确值
/// `anthropics/skills · skills/pdf`（仓库与仓库内路径；还不知道路径或在仓库根时只有仓库）
export function skillOrigin(repo: string, path: string | null): { from: string; exact: string } {
  return {
    from: t("market.origin.from", { owner: repoOwner(repo) }),
    exact: path ? `${repo} · ${path}` : repo,
  };
}

/// 位置的名字：`global` → `用户级`；`project:<路径>` → 项目文件夹名
export function placeName(key: LocationKey): string {
  if (key === "global") return t("market.place.user");
  const path = key.startsWith("project:") ? key.slice("project:".length) : key;
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/// 介绍页来历行下的那一句：`装在 用户级、CardBox`；没装过为 null。用户级排最前，其余按原先后
export function installedLine(keys: ReadonlyArray<LocationKey>): string | null {
  if (keys.length === 0) return null;
  const ordered = [...keys.filter((k) => k === "global"), ...keys.filter((k) => k !== "global")];
  const names: string[] = [];
  for (const key of ordered) {
    const name = placeName(key);
    if (!names.includes(name)) names.push(name);
  }
  return t("market.installed.at", { places: listText(names, "enum") });
}

/// 列表上方灰面板的那一句（R16）：
/// - 限流：后端给的原因（`skills.sh 限流了，约 1 分钟后再试`），没有时 `skills.sh 暂时限流，稍后再试` 等
/// - 有上次的缓存：`现在无法连接 skills.sh，显示的是上次的结果 · 6 小时前`
/// - 没有缓存（随包数据）：`现在无法连接 skills.sh，显示的是随包附带的列表`
/// - 不是连不上（spec 2026-10-04-local-diagnostics R10）：原因换掉「现在无法连接 …」——
///   `skills.sh 返回的内容读不懂，显示的是上次的结果 · 10:42`
/// 画板写的是「连不上」；文案语域（D24）的旧词表里「连不上」换成「无法连接」
export function fallbackText(fallback: MarketFallback, now: Date = new Date()): string {
  const { service } = fallback;
  const reason = fallback.reason || null;
  if (fallback.rateLimited) return reason ?? t("market.fallback.limited", { service });
  if (fallback.cachedAt === null) {
    return reason === null
      ? t("market.fallback.bundled", { service })
      : t("market.fallback.bundledBecause", { reason });
  }
  const time = relativeTime(fallback.cachedAt * 1000, now, true);
  return reason === null
    ? t("market.fallback.cached", { service, time })
    : t("market.fallback.cachedBecause", { reason, time });
}

/// Tauri 通道与 JS 运行时自己抛的原始错误的样子：`TypeError: fetch failed`、`Command x not found`、
/// `invalid args …`。命令层返回的 Err 一律是整句话（系统错误是包在句子里的），不会以这几种开头
const RAW_ERROR =
  /^\s*(?:\w*Error\b|Command\b|invalid args\b|missing required\b|unknown command\b)/i;

/// 命令本身抛出来的错：后端约定是一句给用户看的话，不看它用哪种文字写；
/// 是空的或原始错误的样子时换成 `fallback`
export function errorText(error: unknown, fallback: string): string {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return text.trim() === "" || RAW_ERROR.test(text) ? fallback : text;
}

// ── MCP ──

/// MCP 一行后面的弱标识（R7）：要在浏览器里登录的远程服务器（`signIn`）`需要登录`；
/// 否则有密钥要填 `要填密钥`（#276）；都不是为 null
export function mcpNeeds(entry: Pick<McpRow, "fields" | "signIn">): string | null {
  if (entry.signIn) return t("market.mcp.needsSignIn");
  if (entry.fields.some((f) => f.secret)) return t("market.mcp.needsKey");
  return null;
}

/// 远程还是本机命令
export function isRemote(def: Pick<McpDefinitionInput, "transport">): boolean {
  return def.transport !== "stdio";
}

/// 命令行：`npx -y @playwright/mcp@latest`
export function commandLine(def: Pick<McpDefinitionInput, "command" | "args">): string {
  return [def.command ?? "", ...(def.args ?? [])].filter((part) => part !== "").join(" ");
}

/// 介绍页事实行 `运行方式`（#276）：`本地运行` / `在线服务`，命令与地址（`text`）进悬停
export function mcpConnection(def: McpDefinitionInput): { kind: string; text: string } {
  if (isRemote(def)) return { kind: t("market.mcp.connRemote"), text: def.url ?? "" };
  return { kind: t("market.mcp.connLocal"), text: commandLine(def) };
}

/// 介绍页事实行 `要填的`：每项标签（同安装页 `fieldText`：有说明用说明，没有退回键名）+ 等宽键名 +
/// `必填 · 密钥`；没有要填的时说 `不用填`（要登录时补一句）
export function mcpFieldFacts(
  entry: Pick<McpRow, "fields" | "signIn">,
): { key: string; label: string; keyed: boolean; note: string }[] | string {
  if (entry.fields.length === 0)
    return entry.signIn ? t("market.mcp.noFieldsSignIn") : t("market.mcp.noFields");
  return entry.fields.map((f: McpFieldSpec) => {
    const { label, keyed } = fieldText(f);
    const note = [
      f.required ? t("market.field.required") : t("market.field.optional"),
      f.secret ? t("market.field.secret") : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return { key: f.key, label, keyed, note };
  });
}

/// 来历行末尾那个标记：精选 / 官方目录
export function mcpSourceLabel(source: string): string {
  return source === "registry" ? t("market.mcp.sourceRegistry") : t("market.mcp.sourceCurated");
}

// ── 离开键 ──

/// 仓库在 GitHub 上的页：有路径时指到那个文件夹（分支不知道时用 HEAD）
export function githubUrl(repo: string, path: string | null, branch?: string | null): string {
  const base = `https://github.com/${repo}`;
  if (!path) return base;
  return `${base}/tree/${branch ?? "HEAD"}/${path.replace(/^\/+/, "")}`;
}
