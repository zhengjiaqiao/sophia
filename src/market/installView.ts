/// 安装页、从链接安装、粘贴 MCP 配置（spec 2026-09-27-skill-mcp-market R6 R8 R9 R10 R11；DESIGN「发现与安装 ›
/// 安装页」「从链接安装 · 粘贴 MCP 配置」）的纯逻辑：位置的默认值与落点行、勾选行的默认与记忆、每一行后面那一句、
/// 贴底的去向、主动作的禁用原因、链接的就地识别、JSON 的占位与连接方式、装完那一窗的文案。
/// 不碰 api、不产 JSX，tests/market-install-view.test.ts 直接测。

import { listText, locale, t, tn, type Lang } from "../i18n.ts";
import type { Location } from "../shell/nav.ts";
import { displayPath } from "../pathText.ts";
import { mirrorFailedNote } from "../mcpView.ts";
import { trustNoticeFor, type TrustNotice } from "../mcpTrust.ts";
import {
  mcpEffectTrail,
  type ToastAgentRef,
  type ToastItem,
  type ToastText,
} from "../toastText.ts";
import type {
  AgentDir,
  InstallItem,
  InstallOutcome,
  LocalText,
  LocationKey,
  McpCatalogEntry,
  McpDefinitionInput,
  McpFieldSpec,
  McpParseResult,
  McpReport,
  McpTargetCheck,
  ResolvedLink,
} from "../types.ts";

/// 一个 agent：harness id + 显示名（原样大小写）
export type AgentRef = ToastAgentRef;

/// 一个已安装的产品：能不能装 skill（有 skill 目录）、能不能写 MCP（core `mcp::supports`）、属于哪个品牌，由 core 给
export interface InstallAgent extends AgentRef {
  skills: boolean;
  mcp: boolean;
  /// MCP 写进以后要在它里面点「信任」（core `mcp::trust_app`）
  mcpTrust: boolean;
  /// 它的 skill 在用户级 / 项目里落进哪一列（core `discovery::skill_columns`：同一品牌共用一处的是同一个列 id）；
  /// 没有这一级为 null
  skillUser: string | null;
  skillProject: string | null;
  /// 合成一行时这一行代表的产品（勾选行的默认勾按它们认）；没合成的就是它自己
  members?: string[];
  brand: string;
  brandName: string;
}

export type InstallKind = "skill" | "mcp";

/// 用户级的域 key
export const USER_LOCATION: LocationKey = "global";

// ───────────────────────── 位置 ─────────────────────────

/// 默认装到哪（R9）：取当前 `我的` 的位置；`全部` 时是用户级
export function defaultInstallLocation(mine: Location): LocationKey {
  return mine === "all" || mine === "user" ? USER_LOCATION : mine;
}

/// 域 key → 筛选行的位置写法（`global` ↔ `user`），给复用的 `FilterRow`
export function navOfLocation(key: LocationKey): Location {
  return key === USER_LOCATION ? "user" : (key as Location);
}

/// 筛选行的位置写法 → 域 key；`全部` 不是合法的落点，当用户级
export function locationOfNav(location: Location): LocationKey {
  return defaultInstallLocation(location);
}

/// 项目的路径（域 key `project:<路径>`）；用户级为 null
export function projectPathOf(key: LocationKey): string | null {
  return key.startsWith("project:") ? key.slice("project:".length) : null;
}

/// 文件夹名（与 core 的 `dir_name` 同一种取法）
export function dirName(path: string): string {
  return (
    path
      .split(/[/\\]+/)
      .filter(Boolean)
      .pop() ?? path
  );
}

/// 这个位置的通用仓库（显示写法，主目录写 `~`）：`~/.agents/skills` / `<项目>/.agents/skills`
export function storeDisplay(key: LocationKey): string {
  const project = projectPathOf(key);
  if (project === null) return "~/.agents/skills";
  return displayPath(`${project.replace(/[\\/]+$/, "")}/.agents/skills`);
}

/// 落点：装一个时写名字；装好几个时写 `<名字>`
export function landingPath(key: LocationKey, name: string | null): string {
  return `${storeDisplay(key)}/${name ?? t("market.install.namePlaceholder")}`;
}

/// 位置的名字：`用户级` / 项目名（`labelOf` 给了就用它——同名项目按筛选行的区分写法）
export function placeName(key: LocationKey, labelOf?: (key: LocationKey) => string | undefined) {
  const project = projectPathOf(key);
  if (project === null) return t("market.place.user");
  return labelOf?.(key) ?? dirName(project);
}

/// 位置胶囊下面两行（画板第 6 屏，#275）：先一句结果（13 `ink`）——用户级 `所有项目都能用`、项目
/// `只在 CardBox 中能用`；再一行落点路径（等宽 12 `ink-faint`，常显：安装是往磁盘写文件，点之前要看得到落点）。
/// `labelOf` 给了就用它取项目名（同名项目按筛选行的区分写法）
export function landingParts(
  key: LocationKey,
  name: string | null,
  labelOf?: (key: LocationKey) => string | undefined,
): { result: string; path: string } {
  const result =
    projectPathOf(key) === null
      ? t("market.install.landingUser")
      : t("market.install.landingProject", { project: placeName(key, labelOf) });
  return { result, path: landingPath(key, name) };
}

/// 悬停项目胶囊的提示框：这个位置的完整落点（完整路径，不写 `~`）
export function landingTip(projectPath: string, name: string | null): string {
  const shown = name ?? t("market.install.namePlaceholder");
  return `${projectPath.replace(/[\\/]+$/, "")}/.agents/skills/${shown}`;
}

// ───────────────────────── 给谁用 ─────────────────────────

/// 勾选行列哪些 agent、按什么先后（画板 06 / 09）：设置里 `显示的 agent` 在前（按名单的先后），
/// 其余已安装的在后（按品牌的先后）。名单按品牌（#251）：勾着 Claude 时 Claude Code 与 Claude Desktop 都在里面。
/// skill 只列在 `location` 有 skill 文件夹的（不列 Claude Desktop；装到项目时不列没有项目级的 Kimi 桌面版），
/// 同一品牌共用一处的合成一行（id 是那一列的 id，名字写品牌名），MCP 只列能写 MCP 的——都看 core 给的标记
export function agentRows(
  kind: InstallKind,
  agents: ReadonlyArray<InstallAgent>,
  shown: ReadonlyArray<string>,
  location: LocationKey = USER_LOCATION,
): InstallAgent[] {
  const usable = kind === "mcp" ? agents.filter((a) => a.mcp) : skillRows(agents, location);
  const listed = (a: InstallAgent) => a.members ?? [a.id];
  const head = shown
    .map((id) => usable.find((a) => listed(a).includes(id)))
    .filter((a, i, all): a is InstallAgent => a !== undefined && all.indexOf(a) === i);
  return [...head, ...usable.filter((a) => !head.includes(a))];
}

/// skill 勾选行：按这个位置的 skill 文件夹（列 id）归并，同一处只出一行
function skillRows(agents: ReadonlyArray<InstallAgent>, location: LocationKey): InstallAgent[] {
  const groups = new Map<string, InstallAgent[]>();
  for (const a of agents) {
    if (!a.skills) continue;
    const column = location === USER_LOCATION ? a.skillUser : a.skillProject;
    if (column === null || column === undefined) continue;
    groups.set(column, [...(groups.get(column) ?? []), a]);
  }
  return [...groups].map(([column, members]) => ({
    ...members[0],
    id: column,
    name: members.length > 1 ? members[0].brandName : members[0].name,
    members: members.map((a) => a.id),
  }));
}

/// 默认勾哪些（R9 R10）：设置里 `显示的 agent`（2026-09-27 产品负责人：「默认应该只勾选用户在设置里勾选的
/// agent」——不再记上次的选择，每次打开都一样）。名单按品牌给出产品，同一品牌的一起勾
export function defaultChecked(
  rows: ReadonlyArray<AgentRef & { members?: string[] }>,
  shown: ReadonlyArray<string>,
): string[] {
  return rows
    .filter((a) => (a.members ?? [a.id]).some((id) => shown.includes(id)))
    .map((a) => a.id);
}

/// 要装的 skill 那里全都已有同名的 agent（M14）：链不上，勾选行不能勾。还没选要装的（`names` 为空）时一个都不算
export function takenAgents(
  dirs: ReadonlyArray<AgentDir> | undefined,
  names: ReadonlyArray<string>,
): string[] {
  if (!dirs || names.length === 0) return [];
  return dirs.filter((d) => names.every((n) => d.taken.includes(n))).map((d) => d.harnessId);
}

/// 勾选行（skill）的样子（M14，同 MCP「一个都写不过去的不能勾」）：那里已有同名的不能勾、名字后就地说原因
/// `那里已经有一个同名的 pdf，不会覆盖`；只有一部分被占的照样能勾，装完那一窗说哪个没链上
export function skillRowView(
  dirs: ReadonlyArray<AgentDir> | undefined,
  id: string,
  names: ReadonlyArray<string>,
): { disabledReason?: string; note?: string } {
  if (!takenAgents(dirs, names).includes(id)) return {};
  const reason = t("market.install.takenNote", { name: listText(names) });
  return { disabledReason: reason, note: reason };
}

/// 勾选行（MCP）的样子：一个都写不过去的不能勾、就地说原因；部分写不过去的能勾、说清只写哪几个；
/// 已有一样的照样能勾、说会跳过；勾上的再说生效时机（`重启 Claude Desktop 后生效`）。
/// 能勾的行带上这个位置的配置文件（主目录写 `~`）：悬停这一行出 `写入 ~/.codex/config.toml`（#276，第二层）
export interface McpRowView {
  disabledReason?: string;
  note?: string;
  path?: string;
  /// 原因背后的精确值（无法保留的字段名）：第二层，悬停这一行时出（#321）
  detail?: string;
}

export const sameNote = () => t("market.mcp.sameNote");

export function mcpRowView(check: McpTargetCheck | undefined, checked: boolean): McpRowView {
  if (!check) return {};
  const state = mcpRowState(check, checked);
  const view = check.detail ? { ...state, detail: check.detail } : state;
  return check.configPath && view.disabledReason === undefined
    ? { ...view, path: displayPath(check.configPath) }
    : view;
}

function mcpRowState(check: McpTargetCheck, checked: boolean): McpRowView {
  switch (check.status) {
    case "blocked": {
      const reason = check.reason ?? t("market.mcp.cannotWrite");
      return { disabledReason: reason, note: reason };
    }
    case "same":
      return { note: sameNote() };
    case "partial": {
      const parts = [check.reason, checked ? check.note : null].filter(Boolean) as string[];
      return parts.length > 0 ? { note: parts.join(" · ") } : {};
    }
    case "ok":
      return checked && check.note ? { note: check.note } : {};
  }
}

/// 勾上的里面真会写的（能写或部分能写）有几个：一个都没有时 `安装` 不能按
export function writableCount(
  checks: ReadonlyArray<McpTargetCheck> | null,
  checked: ReadonlyArray<string>,
): number {
  if (!checks) return checked.length;
  return checks.filter(
    (c) => checked.includes(c.harnessId) && (c.status === "ok" || c.status === "partial"),
  ).length;
}

/// 密钥提醒（S19）：勾着、写得过去的 agent 里要把像密钥的值写进 git 仓库里的项目文件（`remind`）的那几个文件
/// （在项目根 `.gitignore` 里会加的行，按检查结果的先后、去重）。非空就出默认不勾的「同时加进 .gitignore」，
/// 放在 `要填的` 最后（没有那一块时放在 `给谁用` 最后）。检查没回来先不出
export function mcpKeyHint(
  checks: ReadonlyArray<McpTargetCheck> | null,
  checked: ReadonlyArray<string>,
): string[] {
  const files: string[] = [];
  for (const c of checks ?? []) {
    if (!checked.includes(c.harnessId)) continue;
    if (c.status !== "ok" && c.status !== "partial") continue;
    if (c.keyHint !== "remind" || !c.gitignoreLine || files.includes(c.gitignoreLine)) continue;
    files.push(c.gitignoreLine);
  }
  return files;
}

/// 目标文件已被 git 跟踪（`tracked`）的那几个文件：加进 .gitignore 也挡不住，不出勾选，在勾选的位置说一句
/// （`keyTrackedNote`）。挑法同 `mcpKeyHint`（勾着、写得过去、按检查结果的先后去重）
export function mcpTrackedFiles(
  checks: ReadonlyArray<McpTargetCheck> | null,
  checked: ReadonlyArray<string>,
): string[] {
  const files: string[] = [];
  for (const c of checks ?? []) {
    if (!checked.includes(c.harnessId)) continue;
    if (c.status !== "ok" && c.status !== "partial") continue;
    if (c.keyHint !== "tracked" || !c.gitignoreLine || files.includes(c.gitignoreLine)) continue;
    files.push(c.gitignoreLine);
  }
  return files;
}

/// 已被跟踪的那一句（产品负责人 2026-10-06）：只有一个文件、又没有同时出现的勾选（`withCheckbox`）时不点名
/// （「这个文件」）；有勾选同时出现、或文件不止一个时写出是哪几个（去掉开头的 `/`，同 `keyHintTip`），
/// 不然读着像在说全部。`named` 给「目标不止一个」用（同名文件在几个项目里，文件只有一个）。
/// 确认框（`scopeTrackedNote`）与安装页共用
export function keyTrackedNote(files: ReadonlyArray<string>, named: boolean = false): string {
  if (files.length === 1 && !named) return t("market.install.trackedOne");
  const params = { files: listText(files.map(unanchored)) };
  return files.length === 1
    ? t("market.install.trackedNamed", params)
    : t("market.install.trackedMany", params);
}

/// 写进 .gitignore 的行去掉锚在项目根的开头 `/`：列给人看时读着像项目里的相对路径
const unanchored = (line: string) => line.replace(/^\//, "");

/// 「同时加进 .gitignore」的提示框：哪几个文件在 git 仓库里、不加会怎样、勾上在哪个项目的 .gitignore 里加几行。
/// 中文的「这一行 / 这几行」按个数分两个键（中文没有单复数形，`tn` 分不出一个）。
/// `files` 是写进 .gitignore 的行，锚在项目根的带开头的 `/`（`/.mcp.json`）；列出来时去掉它，读着像项目里的
/// 相对路径，不像绝对路径（写进去的仍带）。确认框（`scopeKeyHintTip`）与安装页共用
export function keyHintTip(files: ReadonlyArray<string>, project: string): string {
  const params = { files: listText(files.map(unanchored)), project };
  return files.length === 1
    ? t("market.install.gitignoreTipOne", params)
    : t("market.install.gitignoreTipMany", params);
}

// ───────────────────────── 贴底 ─────────────────────────

/// 大小：按 1000 进（与访达一致），一位小数：`2.1 MB` `850 KB` `320 B`
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const shown = value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, "");
  return `${shown} ${units[unit]}`;
}

/// 下载地址里的分支（codeload：`…/tar.gz/refs/heads/<分支>`）
export function branchOfUrl(url: string): string | null {
  const m = /\/refs\/heads\/(.+)$/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

const hostOf = (url: string): string | null => {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1] : null;
};

/// 下载从哪来：安装页的计划（`SkillInstallPreview`）或读链接的结果（`ResolvedLink`）都带这几样
export interface DownloadSource {
  downloadUrl: string;
  sizeBytes: number | null;
  /// 实际用的分支；没有时从下载地址里认
  branch?: string | null;
}

/// 贴底左边一句（skill，#275）：`从 GitHub 下载 · 2.1 MB`。大小在计划回来之前不知道，先只写前半句
export function downloadLine(source: DownloadSource | null): string {
  const parts = [t("market.install.download")];
  if (source?.sizeBytes != null) parts.push(formatSize(source.sizeBytes));
  return parts.join(" · ");
}

/// 悬停贴底那一句（第二层）：下载地址的主机名与分支（`codeload.github.com · 分支 main`，两样都等宽）。
/// 分支：计划给的 → 下载地址里认的 → 调用方知道的；都不知道时只给主机名
export function downloadTip(
  source: DownloadSource | null,
  branch: string | null,
): { host: string; branch: string | null } {
  const host = (source ? hostOf(source.downloadUrl) : null) ?? "codeload.github.com";
  const b = (source?.branch || null) ?? (source ? branchOfUrl(source.downloadUrl) : null) ?? branch;
  return { host, branch: b };
}

// ───────────────────────── 主动作的禁用原因 ─────────────────────────

export const noAgent = () => t("market.install.noAgent");
export const noSkill = () => t("market.install.noSkill");
export const noServer = () => t("market.install.noServer");
export const checkingAgents = () => t("market.install.checking");

/// 计划还在路上（M14 复审）：不知道哪个 agent 那里已有同名的，`安装` 先不能按、也不交给后端。
/// 出计划出错的不算——计划永远不会来，照旧能按，由后端装的时候再判一次。
/// `stale`：手里的计划（或出错）是换位置之前的，还没清掉，不作数
export const skillPlanPending = (preview: unknown, planError: unknown, stale = false) =>
  stale || (preview === null && planError === null);

/// skill 的 `安装` 能不能按：计划还没回来 → `正在检查各 agent`；要装的都被拒 → 第一条原因（`用户级的通用仓库里已经有 pdf`）；一个没选；一个 agent 没勾
export function skillInstallBlock(input: {
  /// 这次要装的（计划里对应的项；计划还没回来时为空）
  items: ReadonlyArray<Pick<InstallItem, "blocked">>;
  /// 选了几个（安装页恒为 1）
  selected: number;
  agents: number;
  /// 计划还没回来（`skillPlanPending`）
  checking?: boolean;
}): string | null {
  if (input.selected === 0) return noSkill();
  if (input.checking) return checkingAgents();
  const open = input.items.filter((i) => i.blocked === null);
  if (input.items.length > 0 && open.length === 0) return input.items[0].blocked;
  if (input.agents === 0) return noAgent();
  return null;
}

/// 要填的一项有没有值（去掉首尾空白）
const filled = (values: Readonly<Record<string, string>>, key: string) =>
  (values[key] ?? "").trim() !== "";

/// MCP 的 `安装` / `添加 M 个` 能不能按
export function mcpInstallBlock(input: {
  /// 要写的定义；粘贴 MCP 配置时是勾上的那几个
  names: ReadonlyArray<string>;
  checked: ReadonlyArray<string>;
  checks: ReadonlyArray<McpTargetCheck> | null;
  fields: ReadonlyArray<McpFieldSpec>;
  values: Readonly<Record<string, string>>;
}): string | null {
  if (input.names.length === 0) return noServer();
  const unnamed = input.names.findIndex((n) => n.trim() === "");
  if (unnamed >= 0) return t("market.mcp.needName");
  if (input.checked.length === 0) return noAgent();
  const missing = input.fields.find((f) => f.required && !filled(input.values, f.key));
  if (missing) return t("market.mcp.needField", { label: fieldText(missing).label });
  if (input.checks && writableCount(input.checks, input.checked) === 0) {
    const same = input.checks.some(
      (c) => input.checked.includes(c.harnessId) && c.status === "same",
    );
    const what =
      input.names.length === 1 ? input.names[0] : tn("market.mcp.theseServers", input.names.length);
    return t(same ? "market.mcp.blockSame" : "market.mcp.blockAll", { what });
  }
  return null;
}

// ───────────────────────── 从链接安装 ─────────────────────────

export const linkUnrecognized = () => t("market.link.unrecognized");

export interface GithubLink {
  /// `owner/repo`
  repo: string;
  branch: string | null;
  path: string | null;
}

const isGithubHost = (h: string) => /^(www\.)?github\.com$/i.test(h);
const validOwner = (o: string) => /^[A-Za-z0-9-]{1,39}$/.test(o) && !o.startsWith("-");
const validRepo = (r: string) => /^[A-Za-z0-9._-]{1,100}$/.test(r) && r !== "." && r !== "..";

function decodeSegment(seg: string): string | null {
  let text: string;
  try {
    text = decodeURIComponent(seg);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (text === "" || text === "." || text === ".." || /[/\\\u0000-\u001f]/.test(text)) return null;
  return text;
}

/// 就地认链接（与 core `market::link::parse` 同一套写法，认不出就不发请求，R6）：
/// `owner/repo`、`https://github.com/owner/repo`、`…/tree/<分支>[/<路径>]`、指向 `SKILL.md` 的 `…/blob/…`
export function parseGithubLink(input: string): GithubLink | null {
  const s = input.trim();
  if (s === "" || /\s/.test(s)) return null;
  let rest = s;
  let hasScheme = false;
  const scheme = s.indexOf("://");
  if (scheme >= 0) {
    if (!/^https?$/i.test(s.slice(0, scheme))) return null;
    rest = s.slice(scheme + 3);
    hasScheme = true;
  }
  rest = rest.split(/[?#]/)[0];
  const raw = rest.split("/");
  const firstIsHost = raw.length > 0 && isGithubHost(raw[0]);
  if (hasScheme && !firstIsHost) return null;
  const bare = !firstIsHost;
  if (firstIsHost) raw.shift();
  const segs = raw.filter((p) => p !== "");
  if (segs.length < 2 || (bare && segs.length !== 2)) return null;
  const owner = segs[0];
  const repo = segs[1].replace(/\.git$/, "");
  if (!validOwner(owner) || !validRepo(repo)) return null;
  const joinPath = (parts: string[]): string | null | undefined => {
    if (parts.length === 0) return null;
    const decoded = parts.map(decodeSegment);
    return decoded.every((p) => p !== null) ? decoded.join("/") : undefined;
  };
  if (segs.length === 2) return { repo: `${owner}/${repo}`, branch: null, path: null };
  const n = segs.length;
  if (segs[2] === "tree" && n >= 4) {
    const branch = decodeSegment(segs[3]);
    const path = joinPath(segs.slice(4));
    if (branch === null || path === undefined) return null;
    return { repo: `${owner}/${repo}`, branch, path };
  }
  if (segs[2] === "blob" && n >= 5 && segs[n - 1].toLowerCase() === "skill.md") {
    const branch = decodeSegment(segs[3]);
    const path = joinPath(segs.slice(4, n - 1));
    if (branch === null || path === undefined) return null;
    return { repo: `${owner}/${repo}`, branch, path };
  }
  return null;
}

/// 剪贴板里的像不像 GitHub 链接：像才填进输入框（R6）
export const looksLikeGithub = (text: string) => parseGithubLink(text) !== null;

/// 输入框下一行（R6）：认不出 / 正在读 / 读不到 / 认出了
export type LinkState =
  | { kind: "empty" }
  | { kind: "unrecognized" }
  | { kind: "reading"; link: GithubLink }
  | { kind: "failed"; message: string }
  | { kind: "found"; resolved: ResolvedLink };

export function linkState(input: string): LinkState {
  if (input.trim() === "") return { kind: "empty" };
  const link = parseGithubLink(input);
  return link ? { kind: "reading", link } : { kind: "unrecognized" };
}

/// 认出后那一行：`anthropics/skills · main · 找到 17 个 skill`
export function foundLine(resolved: ResolvedLink): string {
  const n = resolved.skills.length;
  const found = n === 0 ? t("market.link.none") : tn("market.link.found", n);
  return `${resolved.repo} · ${resolved.branch} · ${found}`;
}

/// 列表表头：`装哪几个 · 17 个里选了 3`
/// 从链接安装的列表顺序：能装的排前面、装过的沉底，各自保持仓库里的先后（2026-10-05 产品负责人）
export function pickOrder<T extends { path: string }>(
  skills: ReadonlyArray<T>,
  blockedOf: (path: string) => string | null,
): T[] {
  return [
    ...skills.filter((s) => blockedOf(s.path) === null),
    ...skills.filter((s) => blockedOf(s.path) !== null),
  ];
}

/// 全选那一行的三态：只看能装的——一个没选＝空框，选了一部分＝半选，能装的全选上＝勾
export function pickAllState(picked: number, installable: number): boolean | "mixed" {
  if (picked === 0) return false;
  return picked >= installable ? true : "mixed";
}

export const pickHeader = (n: number, m: number) => tn("market.link.pickHeader", n, { picked: m });

/// 贴底主动作：一个时 `安装`，几个时 `安装 3 个`
export const installLabel = (m: number) =>
  m > 1 ? tn("market.install.labelMany", m) : t("market.install.label");

/// `在 GitHub 打开 ↗`：`https://github.com/{repo}/tree/{分支}/{路径}`；没有路径到仓库首页；分支不知道时用 HEAD
export function githubTreeUrl(repo: string, branch: string | null, path: string | null): string {
  const p = (path ?? "").replace(/^\/+|\/+$/g, "");
  if (p === "") return `https://github.com/${repo}`;
  return `https://github.com/${repo}/tree/${branch ?? "HEAD"}/${p}`;
}

/// skill 名：仓库内路径的最后一段，仓库根时取仓库名（与 core 的落点文件夹名同一种取法）
export function skillNameOf(repo: string, path: string | null): string {
  const last = (path ?? "").split("/").filter(Boolean).pop();
  return last ?? repo.split("/").pop() ?? repo;
}

// ───────────────────────── 粘贴 MCP 配置 / MCP ─────────────────────────

/// 表头：`认出 2 个 · 已选 2`
export const jsonHeader = (n: number, m: number) => tn("market.json.header", n, { picked: m });

/// 贴底主动作：`添加 2 个`
export const addLabel = (m: number) => tn("market.json.addLabel", m);

/// 解析不了那一行：`第 3 行：…`。定得到行时后端的一句已经以 `第 N 行：` 开头（core `parse_error`，
/// `mcp.parse.atLine`），这里不再加一次（#320）
export function parseErrorLine(error: NonNullable<McpParseResult["error"]>): string {
  return error.message;
}

/// 命令一行：`npx -y @modelcontextprotocol/server-brave-search`（带空格的参数加引号）
export function commandText(def: Pick<McpDefinitionInput, "command" | "args">): string {
  const quote = (a: string) => (/[\s"']/.test(a) ? JSON.stringify(a) : a);
  return [def.command ?? "", ...(def.args ?? []).map(quote)].filter((x) => x !== "").join(" ");
}

/// 运行方式（#276）：`本地运行` + 命令 / `在线服务` + 地址。第一层只写前半，命令与地址进悬停
export function connectionParts(def: McpDefinitionInput): { kind: string; value: string } {
  if (def.transport === "stdio") {
    return { kind: t("market.mcp.connLocal"), value: commandText(def) };
  }
  return { kind: t("market.mcp.connRemote"), value: def.url ?? "" };
}

export const connectionText = (def: McpDefinitionInput) => {
  const { kind, value } = connectionParts(def);
  return `${kind} · ${value}`;
};

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASS|PAT|AUTH|CREDENTIAL)/i;

/// 粘贴的定义里空着的 `${KEY}` 占位（R8：只有这时才多出 `要填的`）。按出现先后、同名只列一次；
/// 在 env 里的算环境变量、请求头里的算请求头，其余算参数；键名像密钥的遮住
export function placeholderFields(defs: ReadonlyArray<McpDefinitionInput>): McpFieldSpec[] {
  const out: McpFieldSpec[] = [];
  const add = (text: string | null | undefined, kind: McpFieldSpec["kind"]) => {
    if (!text) return;
    for (const m of text.matchAll(PLACEHOLDER)) {
      if (out.some((f) => f.key === m[1])) continue;
      out.push({ key: m[1], kind, required: true, secret: SECRET_KEY.test(m[1]) });
    }
  };
  for (const def of defs) {
    for (const v of Object.values(def.env ?? {})) add(v, "env");
    for (const v of Object.values(def.headers ?? {})) add(v, "header");
    add(def.url, "arg");
    add(def.command, "arg");
    for (const a of def.args ?? []) add(a, "arg");
  }
  return out;
}

/// 按界面语言取一段字（精选 MCP 的说明、要填的标签与框下一句，#305）。当前语言没写（或写的是空的）时
/// 依次退回 简体 → English → 繁體，取第一个写了的——同文案目录「这种语言里没有的键退回简体」；都没写是空串。
/// 只有一种写法的（官方目录的上游原文）原样返回
export function localText(text: LocalText | null | undefined, lang: Lang = locale()): string {
  if (text === null || text === undefined) return "";
  if (typeof text === "string") return text;
  for (const l of [lang, "zh-Hans", "en", "zh-Hant"] as const) {
    const value = text[l]?.trim();
    if (value) return value;
  }
  return "";
}

/// `要填的` 一项给人看的写法（#276）：精选写好了标签与框下一句（`label` / `help`，按界面语言取，#305）。
/// 官方目录只有一句说明：写成「标签，怎么取得」的——逗号前当标签，逗号后是常显在输入框下的一句（只认全角逗号，
/// 英文说明不拆）；没有逗号时整句当标签、框下不写。都没有时退回键名（`keyed` 为真：标签本身就是键名，不再另写一遍）
export function fieldText(
  field: Pick<McpFieldSpec, "key" | "description" | "label" | "help">,
  lang: Lang = locale(),
): {
  label: string;
  help: string | null;
  keyed: boolean;
} {
  const label = localText(field.label, lang);
  if (label !== "") {
    const help = localText(field.help, lang);
    return { label, help: help === "" ? null : help, keyed: false };
  }
  const description = (field.description ?? "").trim();
  if (description === "") return { label: field.key, help: null, keyed: true };
  const cut = description.indexOf("\uff0c");
  if (cut <= 0) return { label: description, help: null, keyed: false };
  const help = description.slice(cut + 1).trim();
  return { label: description.slice(0, cut).trim(), help: help === "" ? null : help, keyed: false };
}

/// `要填的` 键名下那一行：`必填 · 密钥` / `必填` / `密钥` / `选填`
export function fieldTag(field: Pick<McpFieldSpec, "required" | "secret">): string {
  const need = field.required ? t("market.field.required") : t("market.field.optional");
  return field.secret ? `${need} · ${t("market.field.secret")}` : need;
}

/// 包名：`npx -y @scope/pkg` / `uvx pkg` / `docker run … image`；认不出为 null
export function packageOf(
  def: McpDefinitionInput,
): { registry: "npm" | "pypi" | "oci"; name: string } | null {
  if (def.transport !== "stdio" || !def.command) return null;
  const cmd = dirName(def.command);
  const args = def.args ?? [];
  const firstPlain = (from = 0) => args.slice(from).find((a) => !a.startsWith("-"));
  if (cmd === "npx" || cmd === "bunx" || cmd === "pnpx") {
    const name = firstPlain();
    return name ? { registry: "npm", name: name.replace(/@[^@/]+$/, "") } : null;
  }
  if (cmd === "uvx" || cmd === "pipx") {
    const i = cmd === "pipx" && args[0] === "run" ? 1 : 0;
    const name = firstPlain(i);
    return name ? { registry: "pypi", name } : null;
  }
  if (cmd === "docker" && args[0] === "run") {
    // docker run [选项] 镜像 [命令]：选项里带值的（-e X=1）跳过它的值
    for (let i = 1; i < args.length; i += 1) {
      const a = args[i];
      if (a.startsWith("-")) {
        if (!a.includes("=") && /^-(e|v|p|-env|-volume|-name|-network)$/.test(a)) i += 1;
        continue;
      }
      return { registry: "oci", name: a };
    }
  }
  return null;
}

/// 安装 MCP 的来历一行（R10；#276）：发布方 + 离开键 `查看说明 ↗`（npm / PyPI 上的包指向包的说明页，其余指向主页）。
/// 包名不在这一行上写，进离开键的悬停（`tip`：包名；指向主页时是主页地址）
export function mcpOrigin(entry: Pick<McpCatalogEntry, "publisher" | "definition" | "homepage">): {
  publisher: string;
  leave: { label: string; url: string; tip: string } | null;
} {
  const pkg = packageOf(entry.definition);
  let url: string | null = null;
  if (pkg?.registry === "npm") url = `https://www.npmjs.com/package/${pkg.name}`;
  else if (pkg?.registry === "pypi") url = `https://pypi.org/project/${pkg.name}/`;
  else if (entry.homepage) url = entry.homepage;
  const leave = url
    ? { label: t("market.leave.docs"), url, tip: pkg && pkg.registry !== "oci" ? pkg.name : url }
    : null;
  return { publisher: entry.publisher, leave };
}

// ───────────────────────── 装完那一窗 ─────────────────────────

/// 装上了但没链上的那几句（M14）：按原因分开、同一原因的 agent 连起来——
/// `Claude Code 和 Cursor 没链上：那里已有同名的`；几种原因之间用分号
export function notLinkedReason(
  unlinked: InstallOutcome["unlinked"],
  agents: ReadonlyArray<AgentRef>,
): string | undefined {
  const byReason = new Map<string, string[]>();
  for (const u of unlinked) {
    const name = agents.find((a) => a.id === u.harnessId)?.name ?? u.harnessId;
    const names = byReason.get(u.reason) ?? [];
    if (!names.includes(name)) names.push(name);
    byReason.set(u.reason, names);
  }
  if (byReason.size === 0) return undefined;
  // 分不出原因（core 给空串）只写主句，不带冒号与后半句
  const parts = [...byReason].map(([reason, names]) =>
    reason
      ? t("market.toast.notLinked", { agents: listText(names), reason })
      : t("market.toast.notLinkedPlain", { agents: listText(names) }),
  );
  return listText(parts, "semicolon");
}

/// 装 skill 之后右下那一窗（R9）：`✓ 已安装 pdf` + `撤销`（撤销由调用方接 `undoId`）；
/// 有没装上的是部分失败（`! 已安装 2 ✓ · 1 ⊘ · pdf：原因`），一个都没装上是 `⊘ pdf 安装失败 · 原因`；
/// 都装上了、但有勾了的 agent 没链上（那里已有同名的、建链接失败），也是部分失败那一窗、不带计数：
/// `! 已安装 pdf · Claude Code 没链上：那里已有同名的`（M14）。`agents` 用来把 harness id 对回显示名
export function skillInstalledToast(
  outcome: InstallOutcome,
  agents: ReadonlyArray<AgentRef> = [],
): ToastText {
  const failed = Object.entries(outcome.failed);
  const firstReason =
    failed.length > 0
      ? t("market.toast.failedReason", { name: failed[0][0], reason: failed[0][1] })
      : undefined;
  if (outcome.installed.length === 0 && failed.length > 0) {
    return {
      tier: "notice",
      kind: "cannot",
      sentence: "market.toast.installCannot",
      names: failed.map(([name]) => name),
      agents: [],
      reason: failed.length === 1 ? failed[0][1] : firstReason,
    };
  }
  const notLinked = notLinkedReason(outcome.unlinked ?? [], agents);
  if (failed.length > 0) {
    return {
      tier: "notice",
      kind: "partial",
      sentence: "market.toast.installPartial",
      names: outcome.installed,
      agents: [],
      reason: [firstReason, notLinked].filter(Boolean).join(" · "),
      tally: { done: outcome.installed.length, failed: failed.length },
    };
  }
  if (notLinked) {
    return {
      tier: "notice",
      kind: "partial",
      sentence: "market.toast.installPartial",
      names: outcome.installed,
      agents: [],
      reason: notLinked,
    };
  }
  return {
    tier: "routine",
    kind: "success",
    sentence: "market.toast.installDone",
    names: outcome.installed,
    agents: [],
  };
}

/// 那里已有同名的、勾选行不能勾、也就没交给后端的 agent（M14）：装完照样算「没链上：那里已有同名的」
/// （issue #111：先在 Claude Code 放了 pdf 再装 pdf，装完那一窗要说 Claude Code 没链上、给「去处理」）。
/// `skipped` 是本来要交（勾着或直接读取）、因为被占而拿掉的 agent；后端已经报过的不重复
export function withTakenSkipped(
  outcome: InstallOutcome,
  dirs: ReadonlyArray<AgentDir> | undefined,
  skipped: ReadonlyArray<string>,
): InstallOutcome {
  const unlinked = [...(outcome.unlinked ?? [])];
  for (const id of skipped) {
    const taken = dirs?.find((d) => d.harnessId === id)?.taken ?? [];
    for (const name of outcome.installed) {
      if (!taken.includes(name)) continue;
      if (unlinked.some((u) => u.harnessId === id && u.name === name)) continue;
      unlinked.push({ harnessId: id, name, reason: t("market.install.linkTaken") });
    }
  }
  return { ...outcome, unlinked };
}

/// 装完那一窗里「去处理」去哪（issue #111）：SKILLS · 我的 里装到的那个位置下、没链上的那个 skill 那一行
/// （位置 key + skill 名定位）。没有「没链上」时没有去处理，返回 null；一次装了几个都没链上时去第一个
export interface SkillHandle {
  /// 位置 key（`global` / `project:<路径>`），就是这次装到的位置
  domainKey: LocationKey;
  skill: string;
}

export function skillHandleTarget(
  outcome: InstallOutcome,
  location: LocationKey,
): SkillHandle | null {
  const first = (outcome.unlinked ?? [])[0];
  return first ? { domainKey: location, skill: first.name } : null;
}

/// 报告里的位置 id 对回 agent（`checks` 记着每一家写进的位置）
const installedAgentOf =
  <A extends AgentRef>(checks: ReadonlyArray<McpTargetCheck>, agents: ReadonlyArray<A>) =>
  (targetId: string): A | undefined => {
    const check = checks.find((c) => c.locationId === targetId || c.harnessId === targetId);
    const id = check?.harnessId ?? targetId.split("::").pop() ?? targetId;
    return agents.find((a) => a.id === id);
  };

/// 写进了要点「信任」的 agent（WorkBuddy）时，装完那一窗之外右下再提示一次去它里面点（#256）；没写进它时为 null
export function mcpInstalledTrust(
  report: McpReport,
  checks: ReadonlyArray<McpTargetCheck>,
  agents: ReadonlyArray<Pick<InstallAgent, "id" | "name" | "mcpTrust">>,
): TrustNotice | null {
  const agentOf = installedAgentOf(checks, agents);
  return trustNoticeFor(
    "write",
    report.entries
      .filter((e) => e.outcome === "created")
      .map((e) => agentOf(e.targetId))
      .map((a) => a && { id: a.id, name: a.name, trust: a.mcpTrust }),
  );
}

/// 加 MCP 之后那一窗（R10；#276）：`✓ 已加到 [图标…] brave-search` + `撤销`，第一批三家接生效时机；
/// 已有一样的跳过、不算失败；有加不上的是部分失败，全没加上是 `⊘ brave-search 添加失败`。
/// `checks` 用来把报告里的位置 id 对回 agent（图标）
export function mcpInstalledToast(
  report: McpReport,
  checks: ReadonlyArray<McpTargetCheck>,
  agents: ReadonlyArray<AgentRef>,
  location: LocationKey,
): ToastText {
  const agentOf = installedAgentOf(checks, agents);
  const project = projectPathOf(location) !== null;
  const done: ToastItem[] = report.entries
    .filter((e) => e.outcome === "created")
    .map((e) => ({ name: e.name, agent: agentOf(e.targetId), project }));
  const failed = report.entries.filter((e) => e.outcome === "failed");
  const uniq = (xs: string[]) => [...new Set(xs)];
  const agentsOf = (items: ToastItem[]) =>
    items.reduce<AgentRef[]>((out, i) => {
      if (i.agent && !out.some((a) => a.id === i.agent?.id)) out.push(i.agent);
      return out;
    }, []);
  if (done.length === 0 && failed.length > 0) {
    return {
      tier: "notice",
      kind: "cannot",
      sentence: "market.toast.addCannot",
      names: uniq(failed.map((e) => e.name)),
      agents: agentsOf(failed.map((e) => ({ name: e.name, agent: agentOf(e.targetId) }))),
      reason: failed[0].message,
    };
  }
  // 写成了的那几处里有的没加进 .gitignore（勾了「同时加进 .gitignore」）：接在别的原因后面，不互相遮住
  const withGitignore = (reason: string | undefined) =>
    [reason, report.gitignoreFailed].filter((x) => x).join(" · ") || undefined;
  if (failed.length > 0) {
    return {
      tier: "notice",
      kind: "partial",
      sentence: "market.toast.addPartial",
      names: uniq(done.map((d) => d.name)),
      agents: agentsOf(done),
      reason: withGitignore(failed[0].message),
      tally: { done: done.length, failed: failed.length },
    };
  }
  const trail = mcpEffectTrail(done);
  // Claude Desktop 第三方模式那一份没写成：成功句后接那一句（借 `reason` 的位置，同 MCP 页的提示条）
  const note = withGitignore(mirrorFailedNote(report.entries));
  return {
    tier: "routine",
    kind: "success",
    sentence: "market.toast.addDone",
    names: uniq(done.map((d) => d.name)),
    agents: agentsOf(done),
    ...(trail.length > 0 ? { trail } : {}),
    ...(note ? { reason: note } : {}),
  };
}
