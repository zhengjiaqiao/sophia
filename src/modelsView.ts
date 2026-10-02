import { listText, t, tn } from "./i18n.ts";
import type { MessageKey } from "./i18n.ts";
import { agentGateway, codexGateway, withAgentGateway } from "./types.ts";
import type { AgentState } from "./shell/agentRegistry.ts";
import type { GatewayAgent, GatewayProvider, GatewayProviderModel, GatewayState } from "./types.ts";

/**
 * 页面上的一个**工具**（Codex、以后可能还有别的）。
 *
 * 后端今天只支持 Codex，这一层不是为了现在就多支持一个，而是**别让版面和文案
 * 写死一个工具**：标题、空态、提示条、限制说明都从这里取名字，加第二个工具时
 * 只改这张表，不用回去翻每一句话。
 */
export interface ModelsTool {
  /// `AgentIcon` 的 id
  id: string;
  /// 显示名，**不大写**——它是被谈论的对象（DESIGN §1.2）
  name: string;
  /// 用这个工具的第三方模型要知道的事（全文，不截断）。只在挑模型时有用：网关行展开区的第一行
  /// （DESIGN「agent 页 › 点整行展开＝从这家挑模型」）
  limitations: string;
  /// 开关改的那个配置文件（短路径 `~/…`）：开关的提示框里说（新手提示只说结果，机制留给悬停，
  /// DESIGN 2026-09-25 评审第二轮）
  configPath: string;
}

/// 各家的页里能力行的名字（DESIGN「每家的页」：两家都写 `第三方模型`，页面头已经说了是哪一家）
export const modelsCapability = () => t("models.page.capability");

export const CODEX: ModelsTool = {
  id: "codex",
  name: "Codex",
  configPath: "~/.codex/config.toml",
  // getter：用的时候才取文案，模块加载时不定死语言
  get limitations() {
    return t("models.tool.codexLimitations");
  },
};

/// 文案按这张表取名字。今天只有 Codex；别的 agent 用上网关时，它自己的 agent 页有同样一节
export const MODELS_TOOLS: ModelsTool[] = [CODEX];

export interface ParsedBackendError {
  code: string;
  message: string;
}

const ERROR_PREFIX = /^\[([a-z_]+)]\s*/;

/**
 * 后端错误形如 `[code] message`；剥离前缀，只展示后半段。
 * `[changed]` 的正文本身已经在说明“配置已变化，请重试”，同样剥离前缀原样展示即可。
 * 读不出前缀（例如非字符串异常）时把整段原文当作 internal 展示。
 */
export function parseBackendError(text: string): ParsedBackendError {
  const match = ERROR_PREFIX.exec(text);
  if (!match) return { code: "internal", message: text };
  return { code: match[1], message: text.slice(match[0].length) };
}

/// 任一家在用路由（路由两家共用：任一家在用它就得在跑，两家都不用了才卸，spec 2026-09-29 R8 R46）。
/// 与 core `claude_on` 同一条：Claude 拨关了、等重启生效时桌面应用里还写着 Sophia（`applied`），仍在用
export function anyGatewayOn(state: GatewayState): boolean {
  return state.agents.some((view) => view.enabled || view.claude?.desktop.applied === true);
}

/// 有一家开着但路由没在跑：那一家的第三方模型用不了（Codex 的官方模型也可能受影响），在列表页与各家的页头下提醒
export function routerUnavailable(state: GatewayState): boolean {
  return anyGatewayOn(state) && !state.router.running;
}

/// 一家网关的显示名。后端新建时会用地址里的主机名起名，这里只兜取不到名字的底
export function providerLabel(provider: GatewayProvider): string {
  if (provider.name) return provider.name;
  try {
    return new URL(provider.baseUrl).host || provider.id;
  } catch {
    return provider.id;
  }
}

/// 列表与片上显示的模型名：用户改过的显示名 > 网关给的 slug > 原始 id
export function modelLabel(model: GatewayProviderModel): string {
  return model.displayName || model.slug || model.id;
}

/// 这一家已选的模型，顺序保持网关给的顺序
export function selectedModels(provider: GatewayProvider): GatewayProviderModel[] {
  return provider.models.filter((model) => model.selected);
}

/// 全部网关加起来已选了几个模型。开关的可用性与确认框里的数量都按这个数算
export function totalSelected(state: GatewayState): number {
  return codexGateway(state).providers.reduce(
    (sum, provider) => sum + selectedModels(provider).length,
    0,
  );
}

/**
 * 网关管理页上每一家右端那句（等宽）：这一家一共拉到多少个可以选的模型。
 * 一个都没拉到时返回空串，那时候旁边的方标签已经把话说了。
 */
export function providerCatalogHint(provider: GatewayProvider): string {
  return provider.models.length === 0
    ? ""
    : tn("models.provider.catalogHint", provider.models.length);
}

/// 「在用」一行里的一条：这个模型、它属于哪一家网关、以及它在工具里显示成什么
export interface EffectiveModel {
  provider: GatewayProvider;
  model: GatewayProviderModel;
  /**
   * 工具的模型选择器里**实际**显示的名字。
   * 两家网关的已选模型显示名相同时，后端会自动加上「 · 网关短名」
   * （docs/gateway-commands.md）；后缀取 core 给的同一个 `shortName`，与 Codex 里看到的对得上。
   * ＝ `name` 或 `name · suffix`
   */
  label: string;
  /// 片上的名字（不含网关后缀）
  name: string;
  /// 只在两家网关撞名时有：网关短名（DESIGN「在用」：` · 网关短名`，短名 `ink-mute`）；不撞名为 null
  suffix: string | null;
}

/**
 * 全部网关里已选的模型，按网关顺序摊平：Codex 页「在用」一行的模型片、托盘的在用行都读它。
 * 撞名时的后缀是网关短名（core 算的 `shortName`：网关行的名字、Codex 目录里的后缀都是它）
 */
export function effectiveModels(state: GatewayState): EffectiveModel[] {
  const rows = codexGateway(state).providers.flatMap((provider) =>
    selectedModels(provider).map((model) => ({ provider, model })),
  );
  // 已选的都来自同一服务商时省前缀；跨服务商并存时保留前缀以区分（DESIGN「模型列表的写法」）
  const vendors = new Set(rows.map((row) => splitModelId(row.model.id).vendor ?? ""));
  const keepVendor = vendors.size > 1;
  const nameOf = (row: { model: GatewayProviderModel }) => chipLabel(row.model, keepVendor);
  const times = new Map<string, number>();
  for (const row of rows) {
    const name = nameOf(row);
    times.set(name, (times.get(name) ?? 0) + 1);
  }
  return rows.map((row) => {
    const name = nameOf(row);
    const suffix = (times.get(name) ?? 0) > 1 ? gatewayShortName(row.provider) : null;
    return { ...row, name, suffix, label: suffix === null ? name : `${name} · ${suffix}` };
  });
}

// ===== 模型列表的写法（DESIGN「模型列表的写法」：网关行展开区里的勾选列表） =====

/// 列表超过这么多行才出筛选框
export const MODEL_FILTER_THRESHOLD = 8;

/// 网关内部路由命名的前缀：`default-azure-gpt-4.1` 里的 `default-`
const ROUTE_PREFIX = /^default-/i;

/**
 * 把模型 id 拆成服务商与其余部分：`azure/gpt-4.1` → azure · gpt-4.1；
 * `default-azure-gpt-4.1` → azure · gpt-4.1（网关路由命名，第一段是服务商）；
 * 拆不出服务商（`deepseek-chat`）→ vendor 为 null，其余原样。
 */
export function splitModelId(id: string): { vendor: string | null; rest: string } {
  const routed = ROUTE_PREFIX.test(id);
  const s = id.replace(ROUTE_PREFIX, "");
  const slash = s.indexOf("/");
  if (slash > 0) return { vendor: s.slice(0, slash), rest: s.slice(slash + 1) };
  const dash = s.indexOf("-");
  if (routed && dash > 0) return { vendor: s.slice(0, dash), rest: s.slice(dash + 1) };
  return { vendor: null, rest: s };
}

/// 网关有没有给友好名：后端在没有显示名时把 id 填进 displayName，等于 id / slug 的不算
export function hasFriendlyName(model: GatewayProviderModel): boolean {
  const name = model.displayName.trim();
  return name !== "" && name !== model.id && name !== model.slug;
}

/// 列表一行的名字：有友好名写友好名；没有就写去掉服务商前缀的 id（组头已给出服务商）
export function modelRowLabel(model: GatewayProviderModel): string {
  return hasFriendlyName(model) ? model.displayName.trim() : splitModelId(model.id).rest;
}

/// 已选模型片的名字：友好名优先；否则跨服务商时保留前缀（`azure/gpt-4.1`），同一服务商省前缀
export function chipLabel(model: GatewayProviderModel, keepVendor: boolean): string {
  if (hasFriendlyName(model)) return model.displayName.trim();
  const { vendor, rest } = splitModelId(model.id);
  return keepVendor && vendor ? `${vendor}/${rest}` : rest;
}

/// 比较用：去掉 `default-` 与服务商前缀、去掉分隔符 / - _ . 与空白、转小写
function squash(text: string, vendor: string | null): string {
  let s = text.replace(ROUTE_PREFIX, "").toLowerCase();
  const v = vendor?.toLowerCase().replace(/[\s/_.-]+/g, "") ?? "";
  s = s.replace(/[\s/_.-]+/g, "");
  if (v !== "" && s.startsWith(v)) s = s.slice(v.length);
  return s;
}

/**
 * 行尾要不要显示 id：只有友好名与 id **明显不同**（从名字推不出 id）时才显示。
 * 名称与 id 都去掉常见前缀（`default-`、服务商名）和分隔符（/ - _ .）、转小写后，
 * 名称是 id 的子串 → 视为「不同不明显」，不显示。
 * `DeepSeek V3.2` 对 `deepseek-chat` 显示；`Opus 4.6` 对 `anthropic/claude-opus-4-6`、
 * `Kimi K2` 对 `moonshotai/kimi-k2-0905` 不显示。
 */
export function shouldShowModelId(name: string, id: string): boolean {
  const { vendor, rest } = splitModelId(id);
  const n = squash(name, vendor);
  const i = squash(rest, vendor);
  if (n === "") return false;
  return !i.includes(n);
}

/// 行尾显示的 id（去掉服务商前缀，组头已给出）；不该显示时为 null
export function modelRowId(model: GatewayProviderModel): string | null {
  if (!hasFriendlyName(model)) return null;
  return shouldShowModelId(model.displayName, model.id) ? splitModelId(model.id).rest : null;
}

export interface ModelEntry {
  provider: GatewayProvider;
  model: GatewayProviderModel;
}

export interface ModelGroup {
  /// 组头：服务商；拆不出服务商时退到网关名
  vendor: string;
  entries: ModelEntry[];
}

/**
 * 按服务商分组（一家只有一个模型也有组头），组的先后按第一次出现的顺序；
 * 组内按筛选词过滤、已选置顶（sortAndFilterModels 的规则），空组不出现。
 */
export function modelGroups(entries: ModelEntry[], query = ""): ModelGroup[] {
  const groups = new Map<string, ModelEntry[]>();
  for (const entry of entries) {
    const vendor = splitModelId(entry.model.id).vendor ?? gatewayShortName(entry.provider);
    const list = groups.get(vendor);
    if (list) list.push(entry);
    else groups.set(vendor, [entry]);
  }
  const out: ModelGroup[] = [];
  for (const [vendor, list] of groups) {
    const kept = sortAndFilterModels(
      list.map((e) => e.model),
      query,
    );
    const byModel = new Map(list.map((e) => [e.model, e]));
    const sorted = kept.map((m) => byModel.get(m) as ModelEntry);
    if (sorted.length > 0) out.push({ vendor, entries: sorted });
  }
  return out;
}

// ===== 勾选不挪位置（DESIGN「模型列表的写法」） =====

/// 列表里一行的稳定键：同名模型可能来自不同网关
export const modelEntryKey = (entry: ModelEntry) => `${entry.provider.id}|${entry.model.id}`;

/**
 * 打开那一刻排一次序并冻结：各组里的先后（已选在前）。
 * 之后勾选 / 取消只改勾选状态、不挪位置；下次打开（组件重挂）再重排
 */
export interface ModelOrder {
  order: string[];
}

export function snapshotOrder(entries: ModelEntry[]): ModelOrder {
  return { order: modelGroups(entries).flatMap((g) => g.entries.map(modelEntryKey)) };
}

/// 筛选词命中：id / slug / 显示名，大小写不敏感（与 sortAndFilterModels 同规则）
function matches(entry: ModelEntry, query: string): boolean {
  const term = query.trim().toLowerCase();
  if (term === "") return true;
  const { id, slug, displayName } = entry.model;
  return [id, slug, displayName].some((text) => text.toLowerCase().includes(term));
}

/// 按冻结的先后排：冻结之后才出现的（新拉到的）排在各自组的末尾
function byFrozen(order: string[]) {
  const rank = new Map(order.map((k, i) => [k, i]));
  return (a: ModelEntry, b: ModelEntry) =>
    (rank.get(modelEntryKey(a)) ?? Number.MAX_SAFE_INTEGER) -
    (rank.get(modelEntryKey(b)) ?? Number.MAX_SAFE_INTEGER);
}

// ===== 网关短名（DESIGN「模型列表的写法」：网关行的名字、同名模型片的后缀） =====

/**
 * 网关短名：网关行的名字，也是两家撞名时模型片后缀、Codex 模型目录里「 · 网关名」的那个名字。
 * **由 core 一处算**（`ProviderSettings::short_name`，经状态的 `shortName` 给过来），界面不再自己取——
 * 否则 Sophia 与 Codex 里会看到两个名字（DESIGN「在用」⑤⑨）。取法：显示名优先；显示名像主机名或为空时
 * 取主机名主体（`openrouter.ai` → `openrouter`）。`shortName` 缺省只会出现在测试样例里
 */
export function gatewayShortName(provider: GatewayProvider): string {
  return provider.shortName?.trim() || provider.name.trim() || provider.id;
}

/// 各服务商分组：组与组内的先后都按冻结的顺序，勾选变化不挪位置；按筛选词过滤，空组不出现
export function frozenGroups(entries: ModelEntry[], snap: ModelOrder, query = ""): ModelGroup[] {
  const sorted = entries.filter((e) => matches(e, query)).sort(byFrozen(snap.order));
  const groups = new Map<string, ModelEntry[]>();
  const nonChat: ModelEntry[] = [];
  for (const entry of sorted) {
    if (likelyNonChat(entry.model.id)) {
      nonChat.push(entry);
      continue;
    }
    const vendor = splitModelId(entry.model.id).vendor ?? gatewayShortName(entry.provider);
    const list = groups.get(vendor);
    if (list) list.push(entry);
    else groups.set(vendor, [entry]);
  }
  const out = [...groups].map(([vendor, list]) => ({ vendor, entries: list }));
  if (nonChat.length > 0) out.push({ vendor: nonChatGroup(), entries: nonChat });
  return out;
}

// ===== 可能不是对话模型、上下文长度（2026-09-30 产品负责人） =====

/// 放到列表最后的那一组的组头：只挪到后面、不藏——按名字猜，猜错了用户还找得到
export const nonChatGroup = () => t("models.list.nonChatGroup");

/// 名字里带这些片段的多半不能对话（向量、重排、语音、审核、画图）
const NON_CHAT_MARKS = [
  "embed",
  "rerank",
  "tts",
  "whisper",
  "transcribe",
  "moderation",
  "dall-e",
  "stable-diffusion",
  "sdxl",
];

/// 按名字猜这个模型多半不能对话（Codex、Claude 只会拿它对话，选了也用不了）
export function likelyNonChat(id: string): boolean {
  const name = id.toLowerCase();
  return NON_CHAT_MARKS.some((mark) => name.includes(mark));
}

/// 上下文长度的读数：`1M` `200K` `128K`；网关没给为 null。
/// 整千的按十进制（128000 → `128K`）；不是整千、却整除 1024 的按二进制（131072 → `128K`、1048576 → `1M`）
export function contextLabel(tokens: number | null | undefined): string | null {
  if (tokens === null || tokens === undefined || !(tokens > 0)) return null;
  const trim = (n: number) => String(Math.round(n * 10) / 10);
  const unit = tokens % 1000 !== 0 && tokens % 1024 === 0 ? 1024 : 1000;
  const kilo = tokens / unit;
  if (kilo < 1) return String(tokens);
  // 四舍五入到了 1000K 就写成 M（999999 → `1M`）
  if (Math.round(kilo * 10) / 10 >= 1000) return `${trim(kilo / unit)}M`;
  return `${trim(kilo)}K`;
}

/// 手动重新拉取之后，键下浮起的那一句（2026-09-30 产品负责人：不自动拉，给一颗手动的键）：
/// 有变化 `已更新 · 新增 3 个 · 少了 1 个`，没变化 `已拉取 · 没有变化`。主句是提示条的整句键（`sentence`），读数接在 `trail`
export function refetchSummary(
  before: readonly string[],
  after: readonly GatewayProviderModel[],
): { sentence: MessageKey; trail: string[] } {
  const was = new Set(before);
  const now = new Set(after.map((m) => m.id));
  const added = [...now].filter((id) => !was.has(id)).length;
  const removed = [...was].filter((id) => !now.has(id)).length;
  if (added === 0 && removed === 0) {
    return { sentence: "models.refetch.fetched", trail: [t("models.refetch.unchanged")] };
  }
  const trail: string[] = [];
  if (added > 0) trail.push(tn("models.refetch.added", added));
  if (removed > 0) trail.push(tn("models.refetch.removed", removed));
  return { sentence: "models.refetch.updated", trail };
}

/// 勾上之前先试调用那一会儿，行上紧跟名字的一句
export const probingNote = () => t("models.probeUi.probing");

/**
 * 这一家现在删不得的原因；能删则返回 null。
 *
 * 已启用时删掉**最后一家还在发布模型**的网关，后端会拒（`invalid`，见
 * docs/gateway-commands.md 的 `gateway_remove_provider`）。与其让用户按完确认才撞上
 * 一句错误，不如在垃圾桶上就把下一步说清楚——禁用的动作必须同时给出原因（按下即出）。
 */
export function removeProviderBlockedReason(
  state: GatewayState,
  provider: GatewayProvider,
  tool: ModelsTool = CODEX,
  agent: GatewayAgent = "codex",
): string | null {
  // 每家各管自己的网关（spec 2026-09-29 R43）：按这一家的开关与已选算
  const view = agentGateway(state, agent);
  if (view === null || !view.enabled) return null;
  if (selectedModels(provider).length === 0) return null;
  const others = view.providers.some(
    (other) => other.id !== provider.id && selectedModels(other).length > 0,
  );
  return others
    ? null
    : tn("models.provider.removeBlocked", selectedModels(provider).length, { tool: tool.name });
}

/// 没有网关、或一个模型都没选时开关按下即出的那一句（DESIGN「agent 页 › 第三方模型」）
export const enableNeedsModels = () => t("models.enable.needsModels");

/**
 * 「第三方模型」开关不可用时的原因；可用则返回 null。
 * 优先级：待接管 > 冲突 > 一家网关都没有 > 一个密钥都没存 > 未选模型 > 选了模型的那几家缺密钥。
 *
 * 最后那条排在选模型之后是没办法的事：多家网关时，缺密钥只挡着**有模型要发布**的那几家
 * （见 docs/gateway-commands.md 的 `gateway_enable`），所以得先知道选了哪些。
 * 一个密钥都没存那一条留在前面——那时还没有模型可选，先说密钥才是下一步。
 *
 * 菜单栏面板（`trayView.ts`）也用这个函数，两边说同一句话。
 */
export function enableDisabledReason(state: GatewayState, selectedCount: number): string | null {
  const codex = codexGateway(state);
  if (codex.codex.takeover !== null)
    return t("models.enable.takeover", { manager: "agents-manager" });
  if (codex.conflict) return codex.conflict;
  if (codex.providers.length === 0) return enableNeedsModels();
  if (!codex.providers.some((provider) => provider.hasKey)) return t("models.enable.needsKey");
  if (selectedCount === 0) return enableNeedsModels();
  const noKey = codex.providers.filter(
    (provider) => selectedModels(provider).length > 0 && !provider.hasKey,
  );
  if (noKey.length > 0)
    return t("models.enable.missingKey", {
      names: listText(noKey.map(providerLabel), "enum"),
    });
  return null;
}

/// 「恢复」按钮可用：已启用，或后台服务还装着（哪怕当前未启用）
export function canRestore(state: GatewayState): boolean {
  return codexGateway(state).enabled || state.router.installed;
}

/**
 * 后台服务残留：已经停用、服务却还装着（自动卸下失败，或旧版本遗留）。
 * 关开关时的 gatewayRestore 本身就会卸下服务，所以手动入口只在这种状态下出现——
 * Codex 页「第三方模型」节头右端（与托盘那一块）按状态出现紧凑键 `卸下后台服务`
 * （DESIGN「停用即卸下后台服务」）。
 */
export function serviceLeftover(state: GatewayState): boolean {
  // 路由两家共用：两家都关了才算残留（spec 2026-09-29 R46）
  return !anyGatewayOn(state) && state.router.installed;
}

/// 「卸下后台服务」键的提示框：只写点下去的结果
export const uninstallTip = () => t("models.tip.uninstall");

// ===== 网关行里的表单（DESIGN「agent 页 › 编辑 / 新增：表单在行里就地展开」） =====

/// 表单开在哪一行；"new" 是最上面那一行正在加的新网关
export type GatewayChoice = string | "new";

/**
 * 换一行编辑（点别的 `编辑` / `+ 网关`）前要不要先问：表单有没保存的改动（新网关填了东西，
 * 或改了地址 / 密钥）就不能静默丢掉，在那一行里就地问「保存 / 丢弃」；点的是当前这一行不算换
 */
export function switchNeedsConfirm(
  current: GatewayChoice,
  next: GatewayChoice,
  dirty: boolean,
): boolean {
  return dirty && next !== current;
}

/// 网关行第二行（DESIGN「网关」：`地址 · 已连接 · 已选 2 / 103`；无法连接时 `地址 · 无法连接 · 原因`，原因写全）
export interface GatewayFacts {
  /// 地址；还没填时一句话
  url: string;
  /// 状态码：组件按它判断（无法连接时那一段画成红字），不比对显示文字
  statusKind: "unreachable" | "connected" | "noKey";
  status: string;
  /// 无法连接的原因（写全，不藏进悬停）
  reason: string | null;
  /// `已选 2 / 103`；还没拉到模型、或无法连接时为 null
  picked: string | null;
}

export function gatewayFacts(provider: GatewayProvider): GatewayFacts {
  const url = provider.baseUrl || t("models.gateway.noUrl");
  if (provider.unreachable) {
    return {
      url,
      statusKind: "unreachable",
      status: t("models.gateway.unreachable"),
      reason: provider.unreachable,
      picked: null,
    };
  }
  return {
    url,
    statusKind: provider.hasKey ? "connected" : "noKey",
    status: provider.hasKey ? t("models.gateway.connected") : t("models.gateway.noKey"),
    reason: null,
    picked:
      provider.models.length > 0
        ? tn("models.gateway.picked", provider.models.length, {
            selected: selectedModels(provider).length,
          })
        : null,
  };
}

/// 「在用」一行的标签：开关关着时写「已选」——选了、还没在用，写「在用」就是说谎（DESIGN「在用」）
export function inUseLabel(state: GatewayState): string {
  return codexGateway(state).enabled ? t("models.inUse.inUse") : t("models.inUse.picked");
}

/// 勾选列表框顶上的筛选框：`筛选 40 个模型`
export const modelFilterPlaceholder = (count: number) => tn("models.filter.placeholder", count);

/// 编辑表单里只读的协议：本机路由收 Responses，转给网关时说它的协议；还没拉过模型时写「拉取模型时识别」
export function protocolText(protocol: string | undefined): string {
  if (protocol === "chat") return "Responses → Chat Completions";
  if (protocol === "responses") return "Responses";
  return t("models.gateway.protocolUnknown");
}

/// 草稿存在期间 `+ 网关` 禁用的原因（从源头防止两个草稿）
export const addGatewayBlocked = () => t("models.gateway.addBlocked");

/// 就地拦截那一句：草稿没保存与改动没保存说法不同
export function unsavedText(current: GatewayChoice): string {
  return current === "new" ? t("models.gateway.unsavedNew") : t("models.gateway.unsavedEdit");
}

/// 「重启 Codex」不设禁用态：结束进程不依赖我们的路由装没装上，
/// 一个进程都没找到也不算失败（R6 修订 v2、AC7′），所以这里没有对应的 reason 函数。

/**
 * 按筛选词过滤（大小写不敏感，匹配 id / slug / displayName），已选模型排在前面，
 * 其余保持原有相对顺序不变。
 */
export function sortAndFilterModels(
  models: GatewayProviderModel[],
  query: string,
): GatewayProviderModel[] {
  const term = query.trim().toLowerCase();
  const filtered =
    term === ""
      ? models
      : models.filter(
          (model) =>
            model.id.toLowerCase().includes(term) ||
            model.slug.toLowerCase().includes(term) ||
            model.displayName.toLowerCase().includes(term),
        );
  // Array.prototype.sort 是稳定排序，同为已选/未选的模型保持原有顺序。
  return [...filtered].sort((a, b) => Number(b.selected) - Number(a.selected));
}

// ===== 重启生效（DESIGN「改动待生效：重启生效与启动 Codex」：按钮即状态） =====

/// 「重启生效」「启动」真正退出 / 打开的那个桌面应用叫什么：2026-09-30 起 Codex 桌面应用改名 ChatGPT
/// （包 id 仍是 `com.openai.codex`），重启会连 ChatGPT 窗口一起关，所以这几处写实际的名字（⑭）；读不到写 Codex。
/// 页面标题、能力行仍写 Codex——那是 agent 的名字，不是这个应用的
export function codexAppName(state: GatewayState | null): string {
  if (state === null) return "Codex";
  return codexGateway(state).codex.app.appName?.trim() || "Codex";
}

/// 「重启生效」键的提示框：只写点击的后果与代价。
/// 检测只认 Codex 桌面应用（与编辑器插件）拉起的后台进程，终端里的 `codex` 不认也不重启，
/// 所以写明「桌面应用」——否则用户会以为终端里那个也跟着换了配置（⑫）
export function restartTip(app: string): string {
  return t("models.tip.restart", { app });
}

/// 确认框正文：不重复提示框原话。进行中的对话数查不到（Codex 没有对外暴露），写通用的后果。
/// 2026-09-30 起重启＝整个桌面应用退出再打开（只重启后台进程时，ChatGPT 窗口里的模型列表不刷新）
export function restartConsequence(app: string): string {
  return t("models.restart.consequence", { app });
}

/// 重启完重读状态，键还在：Codex 还在用旧配置。原样说出来，不假装成功（⑫）
export function restartStillStale(app: string): string {
  return t("models.restart.stillStale", { app });
}
/// 发出结束信号后等旧进程退出、Codex 换上新配置的上限（DESIGN「点了重启生效之后」）。
/// 信号是异步的：发完立刻读，旧进程多半还在，会把「正在退出」误判成「重启失败」
export const RESTART_SETTLE_TIMEOUT_MS = 15000;
/// 等的时候多久读一次（本机读一次约 0.1 秒）
export const RESTART_SETTLE_POLL_MS = 300;

/// 等待用的时钟：默认是真实时间；测试注入假时钟，等多久、读几次与机器快慢无关
export interface SettleClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const REAL_CLOCK: SettleClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface SettleTiming {
  timeoutMs: number;
  pollMs: number;
  /// 不给就用真实时间
  clock?: SettleClock;
}

/// 发完结束信号之后等 Codex 换上新配置：每读到一份状态交给 `onState`；不再用旧配置就返回 null，
/// 等满还在用旧的返回 `restartStillStale`；`alive()` 为假（页面没了）时返回 undefined，调用方什么都别做。
/// Codex 页节头与菜单栏面板的「重启生效」共用这一段
export async function settleAfterRestart(
  read: () => Promise<GatewayState>,
  onState: (state: GatewayState) => void,
  alive: () => boolean,
  timing: SettleTiming = {
    timeoutMs: RESTART_SETTLE_TIMEOUT_MS,
    pollMs: RESTART_SETTLE_POLL_MS,
  },
): Promise<string | null | undefined> {
  const clock = timing.clock ?? REAL_CLOCK;
  const deadline = clock.now() + timing.timeoutMs;
  for (;;) {
    const fresh = await read();
    if (!alive()) return undefined;
    onState(fresh);
    if (!codexGateway(fresh).codex.needsRestart) return null;
    if (clock.now() >= deadline) return restartStillStale(codexAppName(fresh));
    await clock.sleep(timing.pollMs);
    if (!alive()) return undefined;
  }
}

// ===== 开关＝配置里开没开（DESIGN「第三方模型（一节）」） =====

/// 没成之后撤回刚写的配置也没成：接在原因后面
export const switchRollbackFailed = () => t("models.switch.rollbackFailed");

/// 开关那一格的两句话：忙碌（写配置超过 0.3 秒时原位转圈旁那一句）、没成（节头下灰面板的主句）。
/// 成了不说话：滑块与橙就是结果，要重启才生效时旁边出 `重启生效`（与改选模型同一个模式）
export function gatewaySwitchText(
  next: boolean,
  tool: ModelsTool = CODEX,
): { busy: string; failed: string } {
  return next
    ? {
        busy: t("models.switch.busyAdd"),
        failed: t("models.switch.failedAdd", { tool: tool.name }),
      }
    : {
        busy: t("models.switch.busyRemove"),
        failed: t("models.switch.failedRemove", { tool: tool.name }),
      };
}

/// 开关的提示框：先说拨下去的结果；`withFile` 时再说改的是哪个文件（Codex 页；托盘面板窄，只说结果）。
/// 新手提示只说结果，机制留给悬停（DESIGN 2026-09-25 评审第二轮）
export function gatewaySwitchTip(on: boolean, tool: ModelsTool = CODEX, withFile = true): string {
  if (on) {
    return withFile
      ? t("models.switch.onTipFile", { tool: tool.name, path: tool.configPath })
      : t("models.switch.onTip", { tool: tool.name });
  }
  return withFile
    ? t("models.switch.offTipFile", { tool: tool.name, path: tool.configPath })
    : t("models.switch.offTip", { tool: tool.name });
}

export interface GatewaySwitchIo {
  /// 写配置：true → `gatewayEnable`，false → `gatewayRestore`。打开没成时的撤回也走它（恢复）
  write: (enabled: boolean) => Promise<GatewayState>;
  read: () => Promise<GatewayState>;
  /// 每拿到一份后端状态都交给它（页面据此画开关）
  onState: (state: GatewayState) => void;
  alive: () => boolean;
  describe: (error: unknown) => string;
}

/**
 * 拨开关（DESIGN「第三方模型（一节）」：开关＝配置里开没开，拨了就写）：只写配置，不重启 Codex、不确认——
 * 打断对话的是重启，那一道确认在 `重启生效` 上。成了返回 null。
 *
 * 没写成：打开没成时**撤回刚写的**（恢复；写可能做了一半），尽力而为，撤回也没成就在原因后面说一声。
 * 关掉没成时**不反向再启用**——恢复先改设置、改成了才拆路由，停在半路也是一致的；反向启用会重启路由、
 * 重写设置，用户看到的是「关不掉」（2026-09-30 真机）。最后重读一次，开关画成真实状态。返回原因。
 *
 * 页面没了（`alive()` 为假）返回 undefined，调用方什么都别做
 */
export async function switchGateway(
  next: boolean,
  io: GatewaySwitchIo,
): Promise<string | null | undefined> {
  let reason: string;
  try {
    const written = await io.write(next);
    if (!io.alive()) return undefined;
    io.onState(written);
    return null;
  } catch (error) {
    reason = io.describe(error);
  }
  if (next) {
    try {
      const back = await io.write(false);
      if (io.alive()) io.onState(back);
    } catch {
      reason += switchRollbackFailed();
    }
  }
  try {
    const actual = await io.read();
    if (io.alive()) io.onState(actual);
  } catch {
    // 读不到就停在上次拿到的状态；下一次焦点或操作还会再读
  }
  return io.alive() ? reason : undefined;
}

/**
 * 「重启生效」那一格（DESIGN「点了重启生效之后」）：
 * - idle：Codex 的 `needsRestart` 为真时显示键，否则什么都没有
 * - restarting：键位原地换成 14px 忙碌指示（Spinner）+ 「正在重启 Codex」——用户正在等，就地带文字
 * - done：一行例行成功 `✓ 已生效`，约 4 秒后淡出
 *
 * - launching：`启动 Codex` 点下去之后，键位换成忙碌指示 + 「正在启动 Codex」，等到检测到它在跑
 * - launched：一行例行成功 `✓ 已启动`，约 4 秒后淡出
 *
 * - switching：拨了开关、正在写配置（`switchGateway`）。滑块已经过去（乐观翻转），写超过 0.3 秒开关原位转圈；
 *   这一格空着——写完了才知道要不要重启，键等写完再出来
 *
 * 失败不是这一格的状态：灰面板「Codex 重启失败」/「Codex 启动失败」+ 原因 + `再试一次` 挂在「第三方模型」节头下，
 * 格子回到 idle（键还在就还能点）
 */
export type RestartPhase =
  | { kind: "idle" }
  | { kind: "restarting" }
  | { kind: "done" }
  | { kind: "launching" }
  | { kind: "launched" }
  | { kind: "switching"; next: boolean };

/// 已生效那行停多久（含末尾 120ms 淡出）
export const RESTART_DONE_MS = 4000;
/// 键显示着时轻查一次状态的间隔：外部重启了 Codex，键要自己消失
export const RESTART_POLL_MS = 5000;

/// 键要不要显示：状态说要重启、且此刻没在重启 / 刚报完结果
export function showRestartKey(state: GatewayState, phase: RestartPhase): boolean {
  return codexGateway(state).codex.needsRestart && phase.kind === "idle";
}

/// Codex 没在跑时那一格的键（DESIGN「Codex 没在跑：同一格换成 启动 Codex」）：网关开着、Codex 桌面应用
/// 没在跑、且此刻空闲。网关关着时不出现——那时 Codex 用自己的模型，启动它与这一页无关
export function showLaunchKey(state: GatewayState, phase: RestartPhase): boolean {
  const codex = codexGateway(state);
  return (
    codex.enabled && !codex.codex.app.running && !codex.codex.needsRestart && phase.kind === "idle"
  );
}

/// 开关旁那一位此刻放哪颗键（DESIGN「第三方模型（一节）」「托盘面板」：`重启生效` / `启动 Codex` /
/// `卸下后台服务` 同一位，不会同时出现）。Codex 页节头与托盘能力行同一个判断：
/// 等重启 > Codex 没在跑（开着）> 关着而后台服务还装着；拨开关写配置、重启、启动期间都不出键
export type CodexKeyKind = "restart" | "launch" | "uninstall";

export function codexKeyKind(state: GatewayState, phase: RestartPhase): CodexKeyKind | null {
  if (showRestartKey(state, phase)) return "restart";
  if (showLaunchKey(state, phase)) return "launch";
  if (phase.kind === "idle" && serviceLeftover(state)) return "uninstall";
  return null;
}

/// 开关按不动的原因（能按为 null）：开着时永远能关——停用不依赖密钥和模型还在不在。Codex 页与托盘同一句
export function switchDisabledReason(state: GatewayState): string | null {
  return codexGateway(state).enabled ? null : enableDisabledReason(state, totalSelected(state));
}

/// `启动 Codex` 的提示框：点击的结果，不打断任何东西，所以不确认。名字同 `codexAppName`
export function launchTip(app: string): string {
  return t("models.tip.launch", { app });
}
/// 点了之后最多等多久看它跑起来
export const LAUNCH_TIMEOUT_MS = 15000;
/// 等它跑起来时多久查一次
export const LAUNCH_POLL_MS = 1000;
/// 等满了还没检测到：如实说
export function launchTimeout(app: string): string {
  return t("models.launch.timeout", { app });
}

/// 只在键（重启生效 / 启动 Codex）显示着时轮询；键消失即停，不做常驻进程监控。
/// 用户自己重启或打开了 Codex，键要自己消失（按钮即状态）
export function shouldPollRestart(state: GatewayState | null, phase: RestartPhase): boolean {
  return state !== null && (showRestartKey(state, phase) || showLaunchKey(state, phase));
}

// ===== 在用的模型与勾选 =====

/// 关掉之后先画的「做成之后」的样子（删掉最后一个生效模型那一支用它，见 selectModel）：只翻 enabled 会让依赖它的提示在等结果的那一下闪出来——开时「路由没在跑」
/// 待办条（启用成功时后端已等到路由就绪），关时 `卸下后台服务` 键（恢复会一并卸掉路由服务）。
/// 做不成时整份回滚到后端给的状态，所以这里只预测成功
export function predictEnabled(state: GatewayState, enabled: boolean): GatewayState {
  const next = withAgentGateway(state, { ...codexGateway(state), enabled });
  // 关掉时：另一家还开着，路由服务留着（spec 2026-09-29 R8 R46：两家都关才卸）
  const router = enabled
    ? { ...state.router, installed: true, running: true }
    : anyGatewayOn(next)
      ? state.router
      : { ...state.router, installed: false, running: false };
  return { ...next, router };
}

/**
 * 勾选 / 取消一个模型之后该画成什么样（DESIGN「勾选不闪」）：片与勾选框先按用户的操作变，
 * 写盘在后台完成。只改这一家这一个模型的 `selected`。
 *
 * 网关开着时去掉的是最后一个生效模型（全部网关加起来一个不剩）：`turnsOff` 为真、开关随之画成关——
 * 等同把开关关掉（DESIGN「第三方模型（一节）› 移除最后一个 = 关掉」）：照这份直接写、不确认，
 * Codex 在跑时写完出 `重启生效`（同拨开关）
 */
export function selectModel(
  state: GatewayState,
  providerId: string,
  modelId: string,
  selected: boolean,
): { next: GatewayState; turnsOff: boolean } {
  const codex = codexGateway(state);
  const providers = codex.providers.map((provider) =>
    provider.id !== providerId
      ? provider
      : {
          ...provider,
          models: provider.models.map((model) =>
            model.id === modelId ? { ...model, selected } : model,
          ),
        },
  );
  const moved = withAgentGateway(state, { ...codex, providers });
  const turnsOff = codex.enabled && totalSelected(moved) === 0;
  return { next: turnsOff ? predictEnabled(moved, false) : moved, turnsOff };
}

/// 列表行第二行一句都放得下的名字个数：多于这些时只写前两个 + `等 N 个`
const LIST_NAMES_MAX = 3;

/// 模型列表页每一行的第二行（DESIGN「列表页」，2026-09-30：只写已选的模型名，名字比个数有用）：
/// `glm-5、kimi-k2.5`；超过 3 个 `glm-5、kimi-k2.5 等 5 个`；一个没选 `还没选模型`。名字是模型片上的名字
/// （撞名时带 ` · 网关短名`），两家同一条规则
export function listModelNames(names: ReadonlyArray<string>): string {
  if (names.length === 0) return t("models.listRow.none");
  if (names.length <= LIST_NAMES_MAX) return listText(names, "enum");
  // 前两个之间只用并列号连（English 写 `a, b, and more`，不用 Intl 的 `a and b`）
  return tn("models.listRow.namesMore", names.length, {
    names: names.slice(0, 2).join(t("common.list.enum")),
  });
}

/// 模型列表页里 Codex 那一行的第二行：已选的模型名（`listModelNames`）；被 agents-manager 管着时
/// `正由 agents-manager 管理`。注册表 `listRow.status` 读它；状态还没读回来是空串
export function codexListStatus(s: AgentState): string {
  if (s.gateway === null) return "";
  if (codexGateway(s.gateway).codex.takeover !== null) return t("models.listRow.managed");
  return listModelNames(effectiveModels(s.gateway).map((row) => row.label));
}

/// 列表行上 Codex 开关按不动的原因（DESIGN「列表页」：行上说「是什么」、提示框说「怎么办」）：列表页上挑不了模型、
/// 也接管不了，所以说「进去…」——没选模型 `先进去选好模型再打开`，被 agents-manager 管着 `进去接管后才能打开`；
/// 别的原因（冲突、缺密钥）照 Codex 的页那句原话。开着永远能关
export const listNeedsModels = () => t("models.listRow.needsModels");
export const listNeedsTakeover = () => t("models.listRow.needsTakeover");

export function codexListSwitchReason(state: GatewayState): string | null {
  const reason = switchDisabledReason(state);
  if (reason === null) return null;
  if (codexGateway(state).codex.takeover !== null) return listNeedsTakeover();
  return reason === enableNeedsModels() ? listNeedsModels() : reason;
}

/// 路由没在跑、且启动时自愈过一次仍没起来，才在「第三方模型」节里出待办条（DESIGN「路由没在跑」）
export function showRouterTodo(state: GatewayState, healAttempted: boolean): boolean {
  return healAttempted && routerUnavailable(state);
}

// ===== 模型的问题（就地在 Codex 页「第三方模型」节里显示） =====

/**
 * 第三方模型里要用户处理的事（DESIGN「没有收件箱、待处理页和「忽略」」那张表）：
 * - `takeover`：Codex 正由 agents-manager 管着 → 节里的行内待办条 `接管`
 * - `configChanged`：Codex 升级后 Sophia 写进去的设置对不上了 → 节里的行内待办条 `重新写入`
 * - `unreachable`：某家网关无法连接 → 那一家网关行的第二行与行尾 `再试一次`
 *
 * 「改动要重启 Codex 才生效」不进来——它不用处理，页面头的 `重启生效` 就地表达。
 * 「路由没在跑」也不进来——它由节里的行内待办条就地说，不打扰别处。
 *
 * 形状：
 * - `key`：这一条状况的标识（节里渲染待办条时当 React key），`model\u001f<类别>\u001f<细节…>`
 * - `action`：一个动作；`kind` 决定调哪个命令（节里的行内待办条照它执行）
 */
export type ModelIssueKind = "takeover" | "configChanged" | "unreachable";

export interface ModelIssue {
  kind: ModelIssueKind;
  key: string;
  action: { kind: "takeover" | "rewrite" | "retry"; label: string };
}

/// key 的段分隔符：Unit Separator，地址、版本号与失败原因里都不会出现
const SEP = "\u001f";
const modelKey = (...parts: string[]) => ["model", ...parts].join(SEP);

export function modelIssues(state: GatewayState | null): ModelIssue[] {
  if (state === null || !state.supported) return [];
  const out: ModelIssue[] = [];
  const codex = codexGateway(state);
  const { takeover, app } = codex.codex;
  if (takeover !== null) {
    out.push({
      kind: "takeover",
      key: modelKey("takeover", takeover.baseUrl),
      action: { kind: "takeover", label: t("models.issue.takeover") },
    });
  }
  if (app.drift) {
    out.push({
      kind: "configChanged",
      key: modelKey("configChanged", app.version),
      action: { kind: "rewrite", label: t("models.issue.rewrite") },
    });
  }
  for (const provider of codex.providers) {
    if (!provider.unreachable) continue;
    out.push({
      kind: "unreachable",
      key: modelKey("unreachable", provider.id, provider.unreachable),
      action: { kind: "retry", label: t("models.issue.retry") },
    });
  }
  return out;
}

// ===== 两家各管自己的网关，配置时可以顺手同步（spec 2026-09-29 R40 R43；DESIGN「同步由用户选」） =====

/// 另一家
export const otherAgent = (agent: GatewayAgent): GatewayAgent =>
  agent === "codex" ? "claude" : "codex";

/// 另一家在网关区块里要用的：显示名（注册表给，`Codex` / `Claude Desktop`）与它的网关
export interface OtherHome {
  name: string;
  providers: GatewayProvider[];
}

/// 地址拆成比较用的几段；读不出（不是完整的 http(s) 地址）为 null
function addressParts(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname === "") return null;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return [url.protocol, url.hostname.toLowerCase(), port, url.pathname.replace(/\/+$/, "")].join(
    " ",
  );
}

/// 「同一地址」（R40，与 core `providers::same_address` 同一条）：scheme、host（小写）、port、path 相同；
/// 末尾斜杠与默认端口不算不同，读不出的地址不算同一处
export function sameAddress(a: string, b: string): boolean {
  const pa = addressParts(a);
  return pa !== null && pa === addressParts(b);
}

/// 同一家里同一地址只能有一个网关（2026-09-30 产品负责人；core `ensure_address_free` 同一条）：
/// 这一家里除了正在改的那个（`selfId`）之外，已经用了这个地址的网关；没有为 null
export function addressTakenBy(
  providers: GatewayProvider[],
  baseUrl: string,
  selfId: string | undefined,
): GatewayProvider | null {
  // 地址没改（改名、换密钥）不查：规则出台前已经重复的也要能照常编辑（core 同一条）
  const own = providers.find((p) => p.id === selfId);
  if (own && sameAddress(own.baseUrl, baseUrl)) return null;
  return providers.find((p) => p.id !== selfId && sameAddress(p.baseUrl, baseUrl)) ?? null;
}

/// 地址撞上这一家的另一个网关时，地址下那一句与保存键的禁用原因（与 core 的报错同一句）
export function addressTakenText(taken: GatewayProvider): string {
  return t("models.provider.duplicateUrl", { name: gatewayShortName(taken) });
}

/// 另一家里与这个地址同一处的网关；没有为 null
export function sameAddressIn(
  providers: GatewayProvider[],
  baseUrl: string,
): GatewayProvider | null {
  return providers.find((p) => sameAddress(p.baseUrl, baseUrl)) ?? null;
}

/**
 * 表单里同步那一行的字（DESIGN「同步由用户选」，默认勾上）；不出为 null。
 * - 新建（`provider` 为 null）：`也加到 Claude Desktop`；另一家已有同一地址（按正在填的地址）时不出
 * - 编辑：按**改之前**的地址找另一家的同一地址网关（R40），有才出 `Claude Desktop 里的 ap-gateway 一起改`
 * - 没有另一家（注册表里没列它）：不出
 */
export function syncCheckLabel(
  provider: GatewayProvider | null,
  baseUrl: string,
  other: OtherHome | null,
): string | null {
  if (other === null) return null;
  if (provider === null) {
    return sameAddressIn(other.providers, baseUrl) === null
      ? t("models.sync.alsoAdd", { other: other.name })
      : null;
  }
  const match = sameAddressIn(other.providers, provider.baseUrl);
  return match === null
    ? null
    : t("models.sync.alsoEdit", { other: other.name, short: gatewayShortName(match) });
}

/// 删网关确认框的正文与那一行勾选（DESIGN「同步由用户选 › 删网关」）：另一家有同一地址的网关时多一行
/// `同时删掉 Claude Desktop 里的 ap-gateway`（默认不勾），正文随勾选变；没有时 `also` 为 null、正文照原来一句
export function removeConfirmText(
  provider: GatewayProvider,
  other: OtherHome | null,
  alsoOther: boolean,
): { body: string; also: string | null } {
  const match = other === null ? null : sameAddressIn(other.providers, provider.baseUrl);
  if (other === null || match === null) {
    return { body: t("models.gateway.confirmBody"), also: null };
  }
  const short = gatewayShortName(match);
  const also = t("models.sync.alsoRemove", { other: other.name, short });
  if (!alsoOther) {
    return { body: t("models.sync.removeKeepOther", { other: other.name, short }), also };
  }
  const picked = selectedModels(match).length;
  const body =
    picked > 0
      ? tn("models.sync.removeBothPicked", picked, { other: other.name })
      : t("models.sync.removeBoth");
  return { body, also };
}

/// 这一家还没有网关、另一家有时网关小标下的空态（DESIGN「另一家已有网关、这一家还没有时」）+ `带过来`；
/// 另一家也没有时为 null（照旧「还没有网关，先加一家」）
export function copyEmptyText(other: OtherHome | null): string | null {
  if (other === null || other.providers.length === 0) return null;
  // 同一地址的几家带过来只算一家（core `copy_providers` 跳过同一地址），名字相同的只写一次
  const names = [...new Set(other.providers.map(gatewayShortName))];
  return t("models.sync.copyEmpty", { other: other.name, names: listText(names, "enum") });
}
