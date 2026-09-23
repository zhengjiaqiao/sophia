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
  /// 用这个工具的第三方模型要知道的事（全文）。只在挑模型时有用：进模型下拉第三方分组头的提示框
  limitations: string;
  /// 第三方分组头上那一句短的（DESIGN「模型页」：限制说明放进下拉的第三方组头）
  pickerNote: string;
}

export const CODEX: ModelsTool = {
  id: "codex",
  name: "Codex",
  limitations:
    "Codex 仍会用官方模型生成会话标题，第一条消息会发给官方；自动审阅在第三方会话里用不了；网页搜索这类工具在第三方模型上也用不了。",
  pickerNote: "只支持文本与工具调用，不支持图片",
};

/// 页面按这张表一个工具一块。今天只有一个，但版面不假设只有一个
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

/// 全部网关加起来已选了几个模型。启动页那句人话与「启用」的可用性都按这个数算
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

/// 主页面「生效的模型」里的一条：这个模型、它属于哪一家网关、以及它在工具里显示成什么
export interface EffectiveModel {
  provider: GatewayProvider;
  model: GatewayProviderModel;
  /**
   * 工具的模型选择器里**实际**显示的名字。
   * 两家网关的已选模型显示名相同时，后端会自动加上「 · 网关名」
   * （docs/gateway-commands.md）；这一页叫「生效的模型」，那就得照抄那条规则，
   * 否则页面上写的和 Codex 里看到的对不上。
   */
  label: string;
}

/**
 * 全部网关里已选的模型，按网关顺序摊平。主页面只展示它——
 * 网关本身（地址、密钥、增删）搬去配置页了（第三轮反馈）。
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
    const collides = (times.get(name) ?? 0) > 1;
    return { ...row, label: collides ? `${name} · ${providerLabel(row.provider)}` : name };
  });
}

/**
 * 网关页列表上方那一行已选模型片：只这一家已选的，按网关给的顺序；前缀规则与模型页的片相同
 * （这一家已选的都来自同一服务商时省前缀，跨服务商并存时保留）。一个都没选时是空数组（整行不渲染）
 */
export function gatewaySelectedChips(
  provider: GatewayProvider,
): { model: GatewayProviderModel; label: string }[] {
  const models = selectedModels(provider);
  const keepVendor = new Set(models.map((m) => splitModelId(m.id).vendor ?? "")).size > 1;
  return models.map((model) => ({ model, label: chipLabel(model, keepVendor) }));
}

// ===== 模型列表的写法（DESIGN「模型列表的写法」：下拉与网关页同一组件） =====

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

// ===== 跨网关时行尾写网关短名（DESIGN「模型列表的写法」） =====

/// 列表跨几个网关：≥2 个时每行行尾写来源网关短名；只有一个（含网关页）不写
export function showGatewayNames(entries: ModelEntry[]): boolean {
  return new Set(entries.map((e) => e.provider.id)).size >= 2;
}

const IP_HOST = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

/// 显示名本身像主机名（迁移来的网关被 core 命名为完整主机名，`openrouter.ai`）：不含空格、含点、能按主机名解析
const HOST_LIKE = /^[a-z0-9.-]+(:\d+)?$/i;

/**
 * 行尾的网关短名：显示名优先；显示名本身像主机名、或没有显示名时，按主机名取短名——
 * 去掉开头的 `api.` / `www.` 后取第一段（`ap-gateway.internal.example.com` → `ap-gateway`，
 * `https://openrouter.ai/api/v1` → `openrouter`，`localhost:4000` → `localhost`），IP 原样
 */
export function gatewayShortName(provider: GatewayProvider): string {
  const name = provider.name.trim();
  if (name && !(name.includes(".") && HOST_LIKE.test(name) && hostOf(name))) return name;
  const host = hostOf(name || provider.baseUrl);
  if (!host) return provider.id;
  if (IP_HOST.test(host)) return host;
  const labels = host.split(".").filter(Boolean);
  while (labels.length > 1 && (labels[0] === "api" || labels[0] === "www")) labels.shift();
  return labels[0] || provider.id;
}

/// 地址里的主机名（小写）；没写协议的（`localhost:4000`）补上再解析
function hostOf(baseUrl: string): string {
  const raw = baseUrl.trim();
  if (!raw) return "";
  for (const candidate of [raw, `http://${raw}`]) {
    try {
      const host = new URL(candidate).hostname;
      if (host) return host.toLowerCase();
    } catch {
      // 换下一种写法
    }
  }
  return "";
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
 * 「生效的模型」那块空着时说清**为什么空、下一步做什么**，而不是一律「还没选模型」。
 * 三种空是三件不同的事，混成一句用户就不知道该去哪儿（DESIGN「说结果，不说机制」）。
 * 一家网关都没有那一种不走这里——那时整块换成空态，直接把人送去配置页。
 */
export function emptyEffectiveText(state: GatewayState): string {
  const pulled = state.providers.some((provider) => provider.models.length > 0);
  if (pulled) return "还没选模型";
  return state.providers.some((provider) => provider.hasKey)
    ? "还没拉到模型列表——到「配置网关」里再存一次就会拉"
    : "网关还没有密钥——到「配置网关」里填上就能拉到模型列表";
}

/**
 * 这一家现在删不得的原因；能删则返回 null。
 *
 * 已启用时删掉**最后一家还在发布模型**的网关，后端会拒（`invalid`，见
 * docs/gateway-commands.md 的 `gateway_remove_provider`）。与其让用户按完确认才撞上
 * 一句错误，不如在确认弹窗里就把下一步说清楚——禁用的动作必须同时给出原因（§3）。
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
    : `它是最后一家还在给 ${tool.name} 发模型的网关；先点「已启用」停用，再回来删`;
}

/**
 * 「启用」按钮不可用时的原因；可用则返回 null。
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
  if (state.providers.length === 0) return "先添加一个网关";
  if (!state.providers.some((provider) => provider.hasKey)) return "请先保存网关密钥";
  if (selectedCount === 0) return "请先勾选至少一个模型";
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
 * Codex 行（与托盘那一行）按状态出现紧凑键 `卸下后台服务`，设置页「关于」下方也用它判断
 * （DESIGN「停用即卸下后台服务」）。
 */
export function serviceLeftover(state: GatewayState): boolean {
  return !state.enabled && state.router.installed;
}

/// 「卸下后台服务」键的提示框：只写点下去的结果
export const UNINSTALL_TIP = "停用后后台服务还在运行，卸下后不再占用资源";

// ===== 网关页的分段片（DESIGN「网关配置是二级页 › 网关切换」） =====

/// 选中的是哪一家；"new" 是正在加的那一家草稿（下方直接出表单）
export type GatewayChoice = string | "new";

export type GatewayChip = { kind: "provider"; id: string } | { kind: "draft" } | { kind: "add" };

/**
 * 分段片：已有网关各一片；末尾是 `+ 网关`。点了 `+ 网关` 它**原位变成**选中反色的 `新网关` 草稿片，
 * 草稿存在期间不再渲染 `+ 网关`——看着能点、其实点不了的键不许出现（真机反馈）。
 * 保存成功后草稿片换成真实那一家，`+ 网关` 重新出现
 */
export function gatewayChips(providerIds: string[], selected: GatewayChoice): GatewayChip[] {
  const chips: GatewayChip[] = providerIds.map((id) => ({ kind: "provider", id }));
  chips.push(selected === "new" ? { kind: "draft" } : { kind: "add" });
  return chips;
}

/// 取消草稿：回到点 `+ 网关` 之前选中的那一家；它已经不在了就退到第一家；一家都没有就仍是草稿
export function choiceAfterCancel(
  previous: GatewayChoice | null,
  providerIds: string[],
): GatewayChoice {
  if (previous !== null && previous !== "new" && providerIds.includes(previous)) return previous;
  return providerIds[0] ?? "new";
}

/**
 * 换一家（点别的分段片）前要不要先问：连接区有没保存的改动（新网关草稿填了东西，或改了地址 / 密钥）
 * 就不能静默丢掉，就地问「保存 / 丢弃」；点的是当前这一家不算换
 */
export function switchNeedsConfirm(
  current: GatewayChoice,
  next: GatewayChoice,
  dirty: boolean,
): boolean {
  return dirty && next !== current;
}

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

// ===== 重启生效（DESIGN「模型页」：按钮即状态） =====

/// 「重启生效」键的提示框：只写点击的后果与代价。
/// 检测只认 Codex 桌面应用（与编辑器插件）拉起的后台进程，终端里的 `codex` 不认也不重启，
/// 所以写明「桌面应用」——否则用户会以为终端里那个也跟着换了配置（⑫）
export const RESTART_TIP = "重启 Codex 桌面应用让改动生效，进行中的对话会中断";

/// 确认框正文：不重复提示框原话。进行中的对话数查不到（Codex 没有对外暴露），写通用的后果
export const RESTART_CONSEQUENCE = "会结束 Codex 正在运行的进程，进行中的对话会中断";

/// 重启完重读状态，键还在：Codex 还在用旧配置。原样说出来，不假装成功（⑫）
export const RESTART_STILL_STALE = "Codex 还在用旧配置，稍后再试一次";

/**
 * 「重启生效」那一格（DESIGN「点了重启生效之后」）：
 * - idle：`needsCodexRestart` 为真时显示键，否则什么都没有
 * - restarting：键位原地换成 14px 忙碌指示（Spinner）+ 「正在重启 Codex」——用户正在等，就地带文字
 * - done：一行例行成功 `✓ 已生效`，约 4 秒后淡出
 *
 * - launching：`启动 Codex` 点下去之后，键位换成忙碌指示 + 「正在启动 Codex」，等到检测到它在跑
 * - launched：一行例行成功 `✓ 已启动`，约 4 秒后淡出
 *
 * 失败不是这一格的状态：灰面板「没重启 Codex」/「没启动 Codex」+ 原因 + `再试一次` 挂在整行下面，
 * 格子回到 idle（键还在就还能点）
 */
export type RestartPhase =
  | { kind: "idle" }
  | { kind: "restarting" }
  | { kind: "done" }
  | { kind: "launching" }
  | { kind: "launched" };

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

// ===== 模型框与选择器 =====

/**
 * 勾选 / 取消一个模型之后该画成什么样（DESIGN「勾选不闪」）：片与勾选框先按用户的操作变，
 * 写盘在后台完成。只改这一家这一个模型的 `selected`；兼容字段 `provider` 跟着换。
 *
 * 网关开着时去掉的是最后一个生效模型（全部网关加起来一个不剩）：`turnsOff` 为真、开关随之画成关——
 * 等同把开关关掉，不提示、不确认（DESIGN「移除最后一个生效模型 = 关掉网关」）
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
  return { next: turnsOff ? { ...moved, enabled: false } : moved, turnsOff };
}

/// 模型框尾端的等宽读数：全部网关一共拉到几个可选模型
export function availableCount(state: GatewayState): number {
  return state.providers.reduce((sum, provider) => sum + provider.models.length, 0);
}

/// 路由没在跑、且启动时自愈过一次仍没起来，才在 Codex 行下出待办条（DESIGN「路由服务没在跑」）
export function showRouterTodo(state: GatewayState, healAttempted: boolean): boolean {
  return healAttempted && routerUnavailable(state);
}

// ===== 模型的问题（就地在 Codex 行 / 网关页显示；新出现时由壳提示一次） =====

/**
 * 模型页里要用户拿主意的事（DESIGN「没有收件箱、待处理页和「忽略」」那张表）：
 * - `takeover`：Codex 正由 agents-manager 管着 → Codex 行内待办条 `接管`
 * - `configChanged`：Codex 升级后 Sophia 写进去的设置对不上了 → Codex 行内待办条 `重新写入`
 * - `unreachable`：某家网关连不上 → 网关页那一家的连接摘要 `再试一次`
 *
 * 「改动要重启 Codex 才生效」不进来——它不用拿主意，已在 agent 行上就地出现。
 * 「路由没在跑」也不进来——它影响整页，走模型页页级横幅。
 *
 * 形状：
 * - `key`：看过表的 key，**状况一变 key 就变**（Codex 升了版本、网关换了失败原因），看过的会再提示一次。
 *   格式由 core `store::SeenIssue` 钉死：`model\u001f<类别>\u001f<细节…>`，段间都用 `\u001f`
 * - `subject`：句子的主语（`Codex`、网关名），一次性提示里加粗
 * - `sentence`：一次性提示只有这一条时说的整句，以 `subject` 开头
 * - `action`：一个动作；`kind` 决定调哪个命令（Codex 行内待办条照它执行）
 * - `providerId`：只有 `unreachable` 有，「查看」进网关页选中那一家
 */
export type ModelIssueKind = "takeover" | "configChanged" | "unreachable";

export interface ModelIssue {
  kind: ModelIssueKind;
  key: string;
  subject: string;
  sentence: string;
  action: { kind: "takeover" | "rewrite" | "retry"; label: string };
  providerId?: string;
}

/// 模型类 key 的段分隔符，与 core `store::MODEL_KEY_PREFIX` 同一个 Unit Separator
const SEP = "\u001f";
const modelKey = (...parts: string[]) => ["model", ...parts].join(SEP);

const issue = (
  kind: ModelIssueKind,
  key: string,
  subject: string,
  rest: string,
  action: ModelIssue["action"],
  providerId?: string,
): ModelIssue => ({
  kind,
  key,
  subject,
  sentence: `${subject} ${rest}`,
  action,
  ...(providerId === undefined ? {} : { providerId }),
});

export function modelIssues(state: GatewayState | null, tool: ModelsTool = CODEX): ModelIssue[] {
  if (state === null || !state.supported) return [];
  const out: ModelIssue[] = [];
  if (state.takeover !== null) {
    out.push(
      issue(
        "takeover",
        modelKey("takeover", state.takeover.baseUrl),
        tool.name,
        "正由 agents-manager 管理",
        { kind: "takeover", label: "接管" },
      ),
    );
  }
  if (state.codex.drift) {
    out.push(
      issue(
        "configChanged",
        modelKey("configChanged", state.codex.version),
        tool.name,
        "里 Sophia 写进去的设置被改掉了",
        { kind: "rewrite", label: "重新写入" },
      ),
    );
  }
  for (const provider of state.providers) {
    if (!provider.unreachable) continue;
    out.push(
      issue(
        "unreachable",
        modelKey("unreachable", provider.id, provider.unreachable),
        providerLabel(provider),
        "连不上",
        { kind: "retry", label: "再试一次" },
        provider.id,
      ),
    );
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
