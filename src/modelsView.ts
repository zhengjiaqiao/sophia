import type { GatewayProvider, GatewayProviderModel, GatewayState } from "./types.ts";

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

export const CODEX: ModelsTool = {
  id: "codex",
  name: "Codex",
  configPath: "~/.codex/config.toml",
  limitations:
    "只支持文本与工具调用，不支持图片 · 会话标题仍由官方模型生成，第一条消息会发给官方 · 网页搜索用不了",
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

/// 已启用但路由没在跑：官方模型也可能受影响，需要在页面顶部提醒
export function routerUnavailable(state: GatewayState): boolean {
  return state.enabled && !state.router.running;
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
  return state.providers.reduce((sum, provider) => sum + selectedModels(provider).length, 0);
}

/**
 * 网关管理页上每一家右端那句（等宽）：这一家一共拉到多少个可以选的模型。
 * 一个都没拉到时返回空串，那时候旁边的方标签已经把话说了。
 */
export function providerCatalogHint(provider: GatewayProvider): string {
  return provider.models.length === 0 ? "" : `${provider.models.length} 个可选`;
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
  const rows = state.providers.flatMap((provider) =>
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
  return [id, slug, displayName].some((t) => t.toLowerCase().includes(term));
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
  for (const entry of sorted) {
    const vendor = splitModelId(entry.model.id).vendor ?? gatewayShortName(entry.provider);
    const list = groups.get(vendor);
    if (list) list.push(entry);
    else groups.set(vendor, [entry]);
  }
  return [...groups].map(([vendor, list]) => ({ vendor, entries: list }));
}

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
): string | null {
  if (!state.enabled) return null;
  if (selectedModels(provider).length === 0) return null;
  const others = state.providers.some(
    (other) => other.id !== provider.id && selectedModels(other).length > 0,
  );
  return others
    ? null
    : `${tool.name} 还在用它的 ${selectedModels(provider).length} 个模型，先关掉第三方模型再删`;
}

/// 没有网关、或一个模型都没选时开关按下即出的那一句（DESIGN「agent 页 › 第三方模型」）
export const ENABLE_NEEDS_MODELS = "先加一家网关、选好模型再打开";

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
  if (state.takeover !== null) return "本机当前由 agents-manager 启用，请先接管";
  if (state.conflict) return state.conflict;
  if (state.providers.length === 0) return ENABLE_NEEDS_MODELS;
  if (!state.providers.some((provider) => provider.hasKey)) return "请先保存网关密钥";
  if (selectedCount === 0) return ENABLE_NEEDS_MODELS;
  const noKey = state.providers.filter(
    (provider) => selectedModels(provider).length > 0 && !provider.hasKey,
  );
  if (noKey.length > 0) return `${noKey.map(providerLabel).join("、")} 还没有密钥`;
  return null;
}

/// 「恢复」按钮可用：已启用，或后台服务还装着（哪怕当前未启用）
export function canRestore(state: GatewayState): boolean {
  return state.enabled || state.router.installed;
}

/**
 * 后台服务残留：已经停用、服务却还装着（自动卸下失败，或旧版本遗留）。
 * 关开关时的 gatewayRestore 本身就会卸下服务，所以手动入口只在这种状态下出现——
 * Codex 页「第三方模型」节头右端（与托盘那一块）按状态出现紧凑键 `卸下后台服务`
 * （DESIGN「停用即卸下后台服务」）。
 */
export function serviceLeftover(state: GatewayState): boolean {
  return !state.enabled && state.router.installed;
}

/// 「卸下后台服务」键的提示框：只写点下去的结果
export const UNINSTALL_TIP = "停用后后台服务还在运行，卸下后不再占用资源";

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
  status: "已连接" | "无法连接" | "还没有密钥";
  /// 无法连接的原因（写全，不藏进悬停）
  reason: string | null;
  /// `已选 2 / 103`；还没拉到模型、或无法连接时为 null
  picked: string | null;
}

export function gatewayFacts(provider: GatewayProvider): GatewayFacts {
  const url = provider.baseUrl || "还没填地址";
  if (provider.unreachable) {
    return { url, status: "无法连接", reason: provider.unreachable, picked: null };
  }
  return {
    url,
    status: provider.hasKey ? "已连接" : "还没有密钥",
    reason: null,
    picked:
      provider.models.length > 0
        ? `已选 ${selectedModels(provider).length} / ${provider.models.length}`
        : null,
  };
}

/// 「在用」一行的标签：开关关着时写「已选」——选了、还没在用，写「在用」就是说谎（DESIGN「在用」）
export function inUseLabel(state: GatewayState): "在用" | "已选" {
  return state.enabled ? "在用" : "已选";
}

/// 勾选列表框顶上的筛选框：`筛选 40 个模型`
export const modelFilterPlaceholder = (count: number) => `筛选 ${count} 个模型`;

/// 编辑表单里只读的协议：本机路由收 Responses，转给网关时说它的协议；还没拉过模型时写「拉取模型时识别」
export function protocolText(protocol: string | undefined): string {
  if (protocol === "chat") return "Responses → Chat Completions";
  if (protocol === "responses") return "Responses";
  return "拉取模型时识别";
}

/// 草稿存在期间 `+ 网关` 禁用的原因（从源头防止两个草稿）
export const ADD_GATEWAY_BLOCKED = "先保存或取消正在添加的网关";

/// 就地拦截那一句：草稿没保存与改动没保存说法不同
export function unsavedText(current: GatewayChoice): string {
  return current === "new" ? "新网关没保存" : "地址改动没保存";
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

/// 「重启生效」键的提示框：只写点击的后果与代价。
/// 检测只认 Codex 桌面应用（与编辑器插件）拉起的后台进程，终端里的 `codex` 不认也不重启，
/// 所以写明「桌面应用」——否则用户会以为终端里那个也跟着换了配置（⑫）
export const RESTART_TIP = "重启 Codex 桌面应用让改动生效，进行中的对话会中断";

/// 确认框正文：不重复提示框原话。进行中的对话数查不到（Codex 没有对外暴露），写通用的后果
export const RESTART_CONSEQUENCE = "会结束 Codex 正在运行的进程，进行中的对话会中断";

/// 重启完重读状态，键还在：Codex 还在用旧配置。原样说出来，不假装成功（⑫）
export const RESTART_STILL_STALE = "Codex 15 秒内没换上新配置，稍后再试一次";
/// 发出结束信号后等旧进程退出、Codex 换上新配置的上限（DESIGN「点了重启生效之后」）。
/// 信号是异步的：发完立刻读，旧进程多半还在，会把「正在退出」误判成「没重启」
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
/// 等满还在用旧的返回 `RESTART_STILL_STALE`；`alive()` 为假（页面没了）时返回 undefined，调用方什么都别做。
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
    if (!fresh.needsCodexRestart) return null;
    if (clock.now() >= deadline) return RESTART_STILL_STALE;
    await clock.sleep(timing.pollMs);
    if (!alive()) return undefined;
  }
}

// ===== 开关＝配置里开没开（DESIGN「第三方模型（一节）」） =====

/// 没成之后撤回刚写的配置也没成：接在原因后面
export const SWITCH_ROLLBACK_FAILED = "；回滚也失败了";

/// 开关那一格的两句话：忙碌（写配置超过 0.3 秒时原位转圈旁那一句）、没成（节头下灰面板的主句）。
/// 成了不说话：滑块与橙就是结果，要重启才生效时旁边出 `重启生效`（与改选模型同一个模式）
export function gatewaySwitchText(
  next: boolean,
  tool: ModelsTool = CODEX,
): { busy: string; failed: string } {
  return next
    ? { busy: "正在添加", failed: `没添加到 ${tool.name}` }
    : { busy: "正在移除", failed: `没从 ${tool.name} 移除` };
}

export interface GatewaySwitchIo {
  /// 写配置：true → `gatewayEnable`，false → `gatewayRestore`。回滚也走它（反向）
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
 * 没写成：**撤回刚写的**——打开的反向是恢复、关掉的反向是再启用（写可能做了一半），尽力而为；
 * 撤回也没成就在原因后面说一声。最后重读一次，开关画成真实状态。返回原因。
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
  try {
    const back = await io.write(!next);
    if (io.alive()) io.onState(back);
  } catch {
    reason += SWITCH_ROLLBACK_FAILED;
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
 * - idle：`needsCodexRestart` 为真时显示键，否则什么都没有
 * - restarting：键位原地换成 14px 忙碌指示（Spinner）+ 「正在重启 Codex」——用户正在等，就地带文字
 * - done：一行例行成功 `✓ 已生效`，约 4 秒后淡出
 *
 * - launching：`启动 Codex` 点下去之后，键位换成忙碌指示 + 「正在启动 Codex」，等到检测到它在跑
 * - launched：一行例行成功 `✓ 已启动`，约 4 秒后淡出
 *
 * - switching：拨了开关、正在写配置（`switchGateway`）。滑块已经过去（乐观翻转），写超过 0.3 秒开关原位转圈；
 *   这一格空着——写完了才知道要不要重启，键等写完再出来
 *
 * 失败不是这一格的状态：灰面板「没重启 Codex」/「没启动 Codex」+ 原因 + `再试一次` 挂在「第三方模型」节头下，
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
  return state.needsCodexRestart && phase.kind === "idle";
}

/// Codex 没在跑时那一格的键（DESIGN「Codex 没在跑：同一格换成 启动 Codex」）：网关开着、Codex 桌面应用
/// 没在跑、且此刻空闲。网关关着时不出现——那时 Codex 用自己的模型，启动它与这一页无关
export function showLaunchKey(state: GatewayState, phase: RestartPhase): boolean {
  return state.enabled && !state.codex.running && !state.needsCodexRestart && phase.kind === "idle";
}

/// `启动 Codex` 的提示框：点击的结果，不打断任何东西，所以不确认
export const LAUNCH_TIP = "打开 Codex 桌面应用，它会用上现在的模型设置";
/// 点了之后最多等多久看它跑起来
export const LAUNCH_TIMEOUT_MS = 15000;
/// 等它跑起来时多久查一次
export const LAUNCH_POLL_MS = 1000;
/// 等满了还没检测到：如实说
export const LAUNCH_TIMEOUT = "Codex 没能在 15 秒内打开";

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
  return enabled
    ? { ...state, enabled, router: { ...state.router, installed: true, running: true } }
    : { ...state, enabled, router: { ...state.router, installed: false, running: false } };
}

/**
 * 勾选 / 取消一个模型之后该画成什么样（DESIGN「勾选不闪」）：片与勾选框先按用户的操作变，
 * 写盘在后台完成。只改这一家这一个模型的 `selected`；兼容字段 `provider` 跟着换。
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
  const providers = state.providers.map((provider) =>
    provider.id !== providerId
      ? provider
      : {
          ...provider,
          models: provider.models.map((model) =>
            model.id === modelId ? { ...model, selected } : model,
          ),
        },
  );
  const moved = {
    ...state,
    providers,
    provider: providers.find((p) => p.id === state.provider.id) ?? state.provider,
  };
  const turnsOff = state.enabled && totalSelected(moved) === 0;
  return { next: turnsOff ? predictEnabled(moved, false) : moved, turnsOff };
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
  if (state.takeover !== null) {
    out.push({
      kind: "takeover",
      key: modelKey("takeover", state.takeover.baseUrl),
      action: { kind: "takeover", label: "接管" },
    });
  }
  if (state.codex.drift) {
    out.push({
      kind: "configChanged",
      key: modelKey("configChanged", state.codex.version),
      action: { kind: "rewrite", label: "重新写入" },
    });
  }
  for (const provider of state.providers) {
    if (!provider.unreachable) continue;
    out.push({
      kind: "unreachable",
      key: modelKey("unreachable", provider.id, provider.unreachable),
      action: { kind: "retry", label: "再试一次" },
    });
  }
  return out;
}

// ===== 功能性渐变：滚动边缘渐隐（DESIGN「渐变只用于功能」） =====

/// 可滚动区域哪一边有被裁掉的内容：那一边出 16px 渐隐。留 1px 容差，免得小数像素误判
export function edgeFades(
  offset: number,
  viewport: number,
  content: number,
): { start: boolean; end: boolean } {
  if (content - viewport <= 1) return { start: false, end: false };
  return { start: offset > 1, end: offset + viewport < content - 1 };
}
