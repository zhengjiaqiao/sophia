/// 安装页、从链接安装、从 JSON 添加（spec 2026-09-27-skill-mcp-market R6 R8 R9 R10 R11；DESIGN「发现与安装 ›
/// 安装页」「从链接安装 · 从 JSON 添加」）的纯逻辑：位置的默认值与落点行、勾选行的默认与记忆、每一行后面那一句、
/// 贴底的去向、主动作的禁用原因、链接的就地识别、JSON 的占位与连接方式、装完那一窗的文案。
/// 不碰 api、不产 JSX，tests/market-install-view.test.ts 直接测。

import { listText, t, tn } from "../i18n.ts";
import type { Location } from "../shell/nav.ts";
import { displayPath } from "../pathText.ts";
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

export type InstallKind = "skill" | "mcp";

/// 用户级的域 key
export const USER_LOCATION: LocationKey = "global";
export const CLAUDE_CODE = "claude-code";
export const CLAUDE_DESKTOP = "claude-desktop";

/// 能写 MCP 的 agent（DESIGN「MCP 支持哪些 agent」，2026-09-27 起六家）。其余的 agent 不出现在 `写进哪些 agent` 里
export const MCP_AGENT_IDS: ReadonlySet<string> = new Set([
  "claude-code",
  "codex",
  "cursor",
  "gemini-cli",
  "github-copilot",
  CLAUDE_DESKTOP,
]);

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

/// 位置胶囊下一行的三段：`装到` + 落点（等宽）+ `多数 agent 直接读这里`
export function landingParts(
  key: LocationKey,
  name: string | null,
): { path: string; note: string } {
  // 路径已经写在前面（`~/.agents/skills/pdf`），这一句只说它是什么：多数 agent 直接读这里
  const note = t("market.install.storeNote");
  return { path: landingPath(key, name), note };
}

/// 位置胶囊下一行（12 `ink-faint`，落点等宽）：`装到 ~/.agents/skills/pdf · 多数 agent 直接读这里`
export function landingLine(key: LocationKey, name: string | null): string {
  const { path, note } = landingParts(key, name);
  return t("market.install.landingLine", { path, note });
}

/// 悬停项目胶囊的提示框：这个位置的完整落点（完整路径，不写 `~`）
export function landingTip(projectPath: string, name: string | null): string {
  const shown = name ?? t("market.install.namePlaceholder");
  return `${projectPath.replace(/[\\/]+$/, "")}/.agents/skills/${shown}`;
}

// ───────────────────────── 给谁用 / 写进哪些 agent ─────────────────────────

/// 勾选行列哪些 agent、按什么先后（画板 06 / 09）：`列表里的 agent` 在前（按名单的先后），
/// 其余已安装的在后（按 agent 表的先后）。MCP 只列能写 MCP 的，Claude Desktop 不进名单、
/// 跟在名单那一段后面；skill 不列 Claude Desktop（它没有 skill 目录）
export function agentRows(
  kind: InstallKind,
  agents: ReadonlyArray<AgentRef>,
  shown: ReadonlyArray<string>,
): AgentRef[] {
  const usable = agents.filter((a) =>
    kind === "mcp" ? MCP_AGENT_IDS.has(a.id) : a.id !== CLAUDE_DESKTOP,
  );
  const byId = new Map(usable.map((a) => [a.id, a]));
  const head = shown.map((id) => byId.get(id)).filter((a): a is AgentRef => a !== undefined);
  const desktop = kind === "mcp" ? byId.get(CLAUDE_DESKTOP) : undefined;
  if (desktop && !head.includes(desktop)) head.push(desktop);
  return [...head, ...usable.filter((a) => !head.includes(a))];
}

/// 默认勾哪些（R9 R10）：设置里 `列表里的 agent`（2026-09-27 产品负责人：「默认应该只勾选用户在设置里勾选的
/// agent」——不再记上次的选择，每次打开都一样），MCP 另外 Claude Desktop 跟着 Claude Code
export function defaultChecked(
  kind: InstallKind,
  rows: ReadonlyArray<AgentRef>,
  shown: ReadonlyArray<string>,
): string[] {
  const listed = new Set(rows.map((a) => a.id));
  const picked = new Set(shown.filter((id) => listed.has(id)));
  if (kind === "mcp" && picked.has(CLAUDE_CODE) && listed.has(CLAUDE_DESKTOP)) {
    picked.add(CLAUDE_DESKTOP);
  }
  return rows.map((a) => a.id).filter((id) => picked.has(id));
}

/// 这个位置本来就直接读通用仓库的 agent，名字后写这一句
export const directReaderNote = () => t("market.install.directReader");

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
/// 已有一样的照样能勾、说会跳过；勾上的再说生效时机（`重启 Claude Desktop 后生效`）
export interface McpRowView {
  disabledReason?: string;
  note?: string;
}

export const sameNote = () => t("market.mcp.sameNote");

export function mcpRowView(check: McpTargetCheck | undefined, checked: boolean): McpRowView {
  if (!check) return {};
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

/// 勾上的里面真会写的（能写或部分能写）有几个：贴底 `写进 K 个配置文件`
export function writableCount(
  checks: ReadonlyArray<McpTargetCheck> | null,
  checked: ReadonlyArray<string>,
): number {
  if (!checks) return checked.length;
  return checks.filter(
    (c) => checked.includes(c.harnessId) && (c.status === "ok" || c.status === "partial"),
  ).length;
}

export const configFilesLine = (k: number) => tn("market.mcp.configFiles", k);

/// 贴底那一句拆成几段：只有地址、分支、大小这类 ASCII 读数走等宽，汉字与它们之间的空格走正文字族。
/// 整句等宽时，等宽字族里的半角空格夹在汉字中间显得像两个空格（`写进  3  个配置文件`）
export function footRuns(line: string): { text: string; mono: boolean }[] {
  const out: { text: string; mono: boolean }[] = [];
  // 一段读数：不含空格的 ASCII 词，词与词之间只隔一个空格（`2.1 MB`）
  const re = /[!-~]+(?: [!-~]+)*/g;
  let at = 0;
  for (const m of line.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > at) out.push({ text: line.slice(at, i), mono: false });
    out.push({ text: m[0], mono: true });
    at = i + m[0].length;
  }
  if (at < line.length) out.push({ text: line.slice(at), mono: false });
  return out;
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

/// 贴底左边一句（skill）：`从 codeload.github.com 下载 · main · 2.1 MB`。计划还没回来时只写已知的
export function downloadLine(source: DownloadSource | null, branch: string | null): string {
  const host = source ? hostOf(source.downloadUrl) : null;
  const parts = [t("market.install.download", { host: host ?? "codeload.github.com" })];
  const b = (source?.branch || null) ?? (source ? branchOfUrl(source.downloadUrl) : null) ?? branch;
  if (b) parts.push(b);
  if (source?.sizeBytes != null) parts.push(formatSize(source.sizeBytes));
  return parts.join(" · ");
}

// ───────────────────────── 主动作的禁用原因 ─────────────────────────

export const noAgent = () => t("market.install.noAgent");
export const noSkill = () => t("market.install.noSkill");
export const noServer = () => t("market.install.noServer");
export const checkingAgents = () => t("market.install.checking");

/// 计划还在路上（M14 复审）：不知道哪个 agent 那里已有同名的，`安装` 先不能按、也不交给后端。
/// 出计划出错的不算——计划永远不会来，照旧能按，由后端装的时候再判一次。
/// `stale`：手里的计划（或出错）是换位置之前的，还没清掉，不作数
export const skillPlanPending = (preview: unknown, planError: string | null, stale = false) =>
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
  /// 要写的定义；从 JSON 添加时是勾上的那几个
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
  if (missing) return t("market.mcp.needField", { key: missing.key });
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

// ───────────────────────── 从 JSON 添加 / MCP ─────────────────────────

/// 表头：`认出 2 个 · 已选 2`
export const jsonHeader = (n: number, m: number) => tn("market.json.header", n, { picked: m });

/// 贴底主动作：`添加 2 个`
export const addLabel = (m: number) => tn("market.json.addLabel", m);

/// 解析不了那一行：`第 3 行：…`
export function parseErrorLine(error: NonNullable<McpParseResult["error"]>): string {
  return error.line !== null
    ? t("market.json.errorLine", { line: error.line, message: error.message })
    : error.message;
}

/// 命令一行：`npx -y @modelcontextprotocol/server-brave-search`（带空格的参数加引号）
export function commandText(def: Pick<McpDefinitionInput, "command" | "args">): string {
  const quote = (a: string) => (/[\s"']/.test(a) ? JSON.stringify(a) : a);
  return [def.command ?? "", ...(def.args ?? []).map(quote)].filter((x) => x !== "").join(" ");
}

/// 连接方式：`远程 · https://…` / `本机命令 · npx -y …`
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

/// 安装 MCP 的来历一行（R10）：发布方 · 包名或地址 + 离开键（`npm 上的说明 ↗` 等）
export function mcpOrigin(entry: Pick<McpCatalogEntry, "publisher" | "definition" | "homepage">): {
  publisher: string;
  ident: string;
  leave: { label: string; url: string } | null;
} {
  const pkg = packageOf(entry.definition);
  const ident =
    pkg?.name ??
    (entry.definition.transport === "stdio"
      ? commandText(entry.definition)
      : (entry.definition.url ?? ""));
  let leave: { label: string; url: string } | null = null;
  if (pkg?.registry === "npm") {
    leave = { label: t("market.leave.npm"), url: `https://www.npmjs.com/package/${pkg.name}` };
  } else if (pkg?.registry === "pypi") {
    leave = { label: t("market.leave.pypi"), url: `https://pypi.org/project/${pkg.name}/` };
  } else if (entry.homepage) {
    const host = hostOf(entry.homepage) ?? "";
    leave = {
      label: isGithubHost(host) ? t("market.leave.github") : t("market.leave.homepage"),
      url: entry.homepage,
    };
  }
  return { publisher: entry.publisher, ident, leave };
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
  const parts = [...byReason].map(([reason, names]) =>
    t("market.toast.notLinked", { agents: listText(names), reason }),
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

/// 写 MCP 之后那一窗（R10）：`✓ 已写进 [图标…] brave-search` + `撤销`，第一批三家接生效时机；
/// 已有一样的跳过、不算失败；有写不进的是部分失败，全没写进是 `⊘ … 写进 [图标…] 失败`。
/// `checks` 用来把报告里的位置 id 对回 agent（图标）
export function mcpInstalledToast(
  report: McpReport,
  checks: ReadonlyArray<McpTargetCheck>,
  agents: ReadonlyArray<AgentRef>,
  location: LocationKey,
): ToastText {
  const agentOf = (targetId: string): AgentRef | undefined => {
    const check = checks.find((c) => c.locationId === targetId || c.harnessId === targetId);
    const id = check?.harnessId ?? targetId.split("::").pop() ?? targetId;
    return agents.find((a) => a.id === id);
  };
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
      sentence: "market.toast.writeCannot",
      names: uniq(failed.map((e) => e.name)),
      agents: agentsOf(failed.map((e) => ({ name: e.name, agent: agentOf(e.targetId) }))),
      reason: failed[0].message,
    };
  }
  if (failed.length > 0) {
    return {
      tier: "notice",
      kind: "partial",
      sentence: "market.toast.writePartial",
      names: uniq(done.map((d) => d.name)),
      agents: agentsOf(done),
      reason: failed[0].message,
      tally: { done: done.length, failed: failed.length },
    };
  }
  const trail = mcpEffectTrail(done);
  return {
    tier: "routine",
    kind: "success",
    sentence: "market.toast.writeDone",
    names: uniq(done.map((d) => d.name)),
    agents: agentsOf(done),
    ...(trail.length > 0 ? { trail } : {}),
  };
}
