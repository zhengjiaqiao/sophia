import { listText, t, tn } from "./i18n.ts";
import type {
  ProviderAdded,
  ProviderDefaultRule,
  ProviderModelRow,
  ProviderPreset,
  ProviderRow,
} from "./types.ts";

/// 全局模型提供商页的纯逻辑（#252，ADR 0003，画板第 3 屏）：行上的一行字、加完的提示条、「启用模型」浮层顶上那一句、
/// 名称规则、删除与取消启用的确认。组件只画，不自己拼句子

/// 地址去掉协议头与末尾斜杠（`api.moonshot.cn/v1`）
export function displayAddress(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/$/, "");
}

const HAN = /\p{Script=Han}/u;

/// 句中的提供商名：带汉字的加「」（`已加上「我的中转」`），拉丁名与汉字之间留空格（`已加上 Kimi`）
function named(
  key: Parameters<typeof t>[0],
  name: string,
  params: Record<string, string | number> = {},
) {
  // 加了「」的不再按中西文补空格（引号本身就隔开了）
  if (HAN.test(name)) return t(key, { ...params, name: t("models.providers.cjkName", { name }) });
  return t(key, { ...params, name });
}

/// 提供商行的第二行：`地址 · 已启用 N / 总数（推荐）· 3 个 agent`；超过 20 个一个没开时接 `模型太多，挑几个常用的`
export function providerSubline(row: ProviderRow): string {
  let count = t("models.providers.enabledCount", { enabled: row.enabled, total: row.total });
  if (row.defaultRule === "recommended") count += t("models.providers.recommendedMark");
  const parts = [displayAddress(row.baseUrl), count];
  if (row.agents.length > 0) parts.push(tn("models.providers.agents", row.agents.length));
  if (row.defaultRule === "tooMany" && row.enabled === 0) parts.push(t("models.providers.tooMany"));
  // 全角括号后面不再空一格（`（推荐）· 3 个 agent`）
  return parts.join(" · ").replace(/([\uff09\u300d]) ·/g, "$1·");
}

/// 停在「N 个 agent」上的那句：是哪几个；没有 agent 选它为 null
export function providerAgentsTip(
  row: ProviderRow,
  nameOf: (agent: string) => string,
): string | null {
  if (row.agents.length === 0) return null;
  return t("models.providers.agentsTip", { agents: listText(row.agents.map(nameOf)) });
}

/// 加完一家的提示条（画板第 9 屏 ⑥）：`已启用 2 个模型`（只说这一句，2026-10-08 起不再接加到了哪几家）；一个没启用时
/// `已加上 OpenRouter`。启用哪些在弹窗里当场看过了，不再复述用了哪条规则、也不再另开「启用模型」
export function addedLead(added: ProviderAdded): string {
  if (added.enabled > 0) return tn("models.providers.addedEnabled", added.enabled);
  return named("models.providers.added", added.name);
}

// ===== 添加 / 编辑弹窗（画板第 9 屏） =====

/// 保存失败的原因是不是上面「拉不到模型列表」那块已经说过的那一句（同一份地址与密钥再拉一次，失败原因一样）：
/// 是就不再另出一块，同一原因只说一处（走查 2026-10-08）
export function saveErrorRepeats(
  preview: { status: string; message?: string } | null,
  error: { message: string },
): boolean {
  return preview?.status === "failed" && preview.message === error.message;
}

/// 弹窗里填的三项
export interface ProviderDraft {
  name: string;
  baseUrl: string;
  key: string;
}

/// 有没有没保存的改动（Esc / 取消先问一次丢弃）：添加时选了预设、一字没动不算，填了密钥或改了预设填好的名称、地址算；
/// 自定义的填了名称或地址算。编辑时对照那一家现在的名称与地址，填了新密钥也算
export function draftDirty(
  row: ProviderRow | null,
  preset: ProviderPreset | "custom" | null,
  draft: ProviderDraft,
): boolean {
  if (draft.key.trim() !== "") return true;
  if (row !== null) return draft.name.trim() !== row.name || draft.baseUrl.trim() !== row.baseUrl;
  if (preset === null) return false;
  if (preset === "custom") return draft.name.trim() !== "" || draft.baseUrl.trim() !== "";
  return draft.name !== preset.name || draft.baseUrl !== (preset.openai?.apiBase ?? "");
}

/// 密钥框下那一句（走查 2026-10-08）：填的东西不像密钥（去首尾空白后含空白字符、或不到 8 位，同后端
/// `keystore::validate_shape`，原话也是同一句）时说明，空着或像密钥为 null。常见的误操作是剪贴板里其实是一条命令
export function keyShapeText(key: string): string | null {
  const secret = key.trim();
  if (secret === "") return null;
  if (/\s/.test(secret) || [...secret].length < 8) return t("models.secrets.invalidShape");
  return null;
}

/// 密钥框里这一下改动要不要当场判断形状（产品负责人 2026-10-08：不边打边报）：一次进来多个字符（粘贴、选中后
/// 粘贴替换）当场判断；逐个打、删字等离开密钥框或停手 0.4 秒。比较前后去掉相同的头尾，剩下的就是这一下进来的
export function keyChecksNow(prev: string, next: string): boolean {
  const a = [...prev];
  const b = [...next];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail += 1;
  return b.length - head - tail > 1;
}

/// 密钥框下那一句：只说判断过的那一份（`checked`，粘贴、离开密钥框、停手 0.4 秒时记下）；还在打就不说。
/// 保存键的禁用不等这个，照旧实时（`saveBlocked`）
export function keyHintText(key: string, checked: string): string | null {
  return checked === key ? keyShapeText(key) : null;
}

/// 保存按不了的原因（禁用键按下即说）：先填地址；添加时先粘贴密钥；密钥不像密钥（编辑时留空＝不改，不查）；
/// 同名那一句。能保存为 null
export function saveBlocked(input: {
  adding: boolean;
  baseUrl: string;
  key: string;
  taken: string | null;
}): string | null {
  if (input.baseUrl.trim() === "") return t("models.form.needUrl");
  if (input.adding && input.key.trim() === "") return t("models.enable.needsKey");
  return keyShapeText(input.key) ?? input.taken;
}

/// 拉不拉列表、拉哪一份：地址与密钥都填了、密钥像密钥才拉；两者（去首尾空白）一变就是另一份，旧的那份回来也不用
export function previewKey(baseUrl: string, key: string): string | null {
  const url = baseUrl.trim();
  const secret = key.trim();
  if (url === "" || secret === "" || keyShapeText(secret) !== null) return null;
  return `${url}\n${secret}`;
}

/// 勾上追加到末尾、取消拿掉；已经是那个状态就原样
export function toggleChosen(chosen: readonly string[], id: string, on: boolean): string[] {
  if (on) return chosen.includes(id) ? [...chosen] : [...chosen, id];
  return chosen.filter((c) => c !== id);
}

/// 「启用的模型」下那一句：还是默认那几个时照三种情况说（`按推荐启用了 2 个` / `12 个都启用了` /
/// `模型太多，默认一个都没启用，挑几个常用的`）；改过只说现在启用了几个
export function dialogRuleText(
  preview: { rule: ProviderDefaultRule; enabled: readonly string[] },
  chosen: readonly string[],
): string {
  const unchanged =
    chosen.length === preview.enabled.length && chosen.every((id) => preview.enabled.includes(id));
  if (!unchanged) return tn("models.providers.dialogChosen", chosen.length);
  switch (preview.rule) {
    case "recommended":
      return tn("models.providers.dialogRecommended", chosen.length);
    case "all":
      return tn("models.providers.dialogAll", chosen.length);
    case "tooMany":
      return t("models.providers.dialogTooMany");
  }
}

/// 「启用模型」浮层顶上那一句：写明默认用了哪条规则；用户改过之后只说关掉的后果
export function enableHeadNote(row: ProviderRow): string {
  switch (row.defaultRule) {
    case "recommended":
      return named("models.providers.headRecommended", row.name, { enabled: row.enabled });
    case "all":
      return t("models.providers.headAll", { enabled: row.enabled });
    case "tooMany":
      return t("models.providers.headTooMany");
    default:
      return t("models.providers.headPlain");
  }
}

/// 浮层与添加弹窗搜索框的占位：`搜索 Kimi 的 98 个对话模型`
export function searchPlaceholder(row: Pick<ProviderRow, "name" | "total">): string {
  return named("models.providers.search", row.name, { total: row.total });
}

/// 浮层与添加弹窗的搜索：按 id 与显示名，不分大小写；空串＝全部
export function filterProviderModels<T extends { id: string; displayName?: string | null }>(
  models: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return models;
  return models.filter((m) => [m.id, m.displayName ?? ""].some((s) => s.toLowerCase().includes(q)));
}

/// 名称为空时的默认名称：地址的主体（主机名去掉 `api.` / `www.` 后的第一段，IP 原样）。
/// 只给占位与提前查同名用；真正的名字由后端定（core `model_providers::default_name`，同一规则）
export function defaultNameFor(url: string): string | null {
  let host: string;
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "") return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return host;
  const labels = host.split(".").filter((l) => l !== "");
  while (labels.length > 1 && (labels[0] === "api" || labels[0] === "www")) labels.shift();
  return labels[0] ?? null;
}

/// 自定义表单名称框的占位：`比如：我的中转（不填就叫 relay）`；地址还认不出时只写前半句
export function customNamePlaceholder(url: string): string {
  const name = defaultNameFor(url);
  return name === null
    ? t("models.providers.namePlaceholder")
    : t("models.providers.namePlaceholderDefault", { name });
}

/// 同名不让保存：已经有一家叫这个名字（去首尾空白、不分大小写；`exceptId` 是正在改的那一家）时的那句，没有为 null。
/// 名称空着时按地址的默认名查（给了 `url`）
export function nameTakenText(
  rows: ProviderRow[],
  name: string,
  exceptId: string | null,
  url?: string,
): string | null {
  const wanted = (name.trim() === "" && url !== undefined ? (defaultNameFor(url) ?? "") : name)
    .trim()
    .toLowerCase();
  if (wanted === "") return null;
  const taken = rows.find((r) => r.id !== exceptId && r.name.trim().toLowerCase() === wanted);
  return taken ? t("models.providers.nameTaken", { name: taken.name }) : null;
}

/// 删除一家的确认：点名选了它的模型的 agent，说清密钥一并删除且无法恢复
export function removeConfirm(
  row: ProviderRow,
  nameOf: (agent: string) => string,
): { title: string; body: string } {
  return {
    title: t("models.providers.removeTitle", { name: row.name }),
    body:
      row.agents.length > 0
        ? t("models.providers.removeBodyUsed", { agents: listText(row.agents.map(nameOf)) })
        : t("models.providers.removeBody"),
  };
}

/// 取消启用一个模型：有 agent 选了它才确认（点名是哪几个）；没有为 null，直接取消
export function disableConfirm(
  model: ProviderModelRow,
  nameOf: (agent: string) => string,
): { title: string; body: string } | null {
  if (model.agents.length === 0) return null;
  return {
    title: t("models.providers.disableTitle", { model: model.id }),
    body: t("models.providers.disableBody", { agents: listText(model.agents.map(nameOf)) }),
  };
}
