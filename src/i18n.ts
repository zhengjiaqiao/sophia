/// 界面文案的唯一取处（spec 2026-09-30-language-and-theme R6、R7）。
///
/// 目录在仓库根 `locales/<语言>/<区块>.json`，前后端共用：core 的 `i18n.rs` 读同一批文件。
/// 值是整句，参数写成 `{name}` 占位符；按数量变的写成 `{"one": …, "other": …}`。
///
/// 两条规矩（第三批要不重启就换语言）：
/// - **不在模块顶层调 `t` / `tn` / `tRich`**：常量写成函数或键表，用的时候才取
///   （`tests/i18n-module-load.test.ts` 把关）
/// - **键写字面量**：枚举式的用键表 `{add: "toast.verb.add"} as const`，再 `t(VERB_KEY[kind])`
///
/// 一句话一个键，不在代码里拼碎片（英文语序不同）；句中要嵌带样式的专名用 `tRich`
import {
  Fragment,
  createElement,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { CATALOG, CATALOGS, type Message } from "./i18n/catalog.ts";

export type MessageKey = keyof typeof CATALOG;
type Params = Record<string, string | number>;

/// 界面实际用的语言（设置里的「跟随系统」由后端解析好），与 `locales/` 下的文件夹、`html lang` 同名
export type Lang = "zh-Hans" | "zh-Hant" | "en";

export function isLang(value: unknown): value is Lang {
  return value === "zh-Hans" || value === "zh-Hant" || value === "en";
}

// ---- 当前语言：一份模块级的 store。启动时与收到 `locale-changed` 时由 main.tsx 写入 ----
let current: Lang = "zh-Hans";
const localeListeners = new Set<() => void>();

/// 当前界面语言
export function locale(): Lang {
  return current;
}

/// 换语言：之后取的每一句都按它；订阅者（React 根部）据此整棵树重渲染
export function setLocale(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  localeListeners.forEach((listener) => listener());
}

export function subscribeLocale(listener: () => void): () => void {
  localeListeners.add(listener);
  return () => localeListeners.delete(listener);
}

/// 组件里读当前语言：语言一换就重渲染（根部用它让整棵树跟着换；`useMemo` 的依赖也写它）
export function useLocale(): Lang {
  return useSyncExternalStore(subscribeLocale, locale, locale);
}

/// 语言换了之后做一件事（挂上时不做）：重拉后端算好的句子、清掉存着的成句
export function useOnLocaleChange(effect: () => void): void {
  const lang = useLocale();
  const seen = useRef(lang);
  const latest = useRef(effect);
  latest.current = effect;
  useEffect(() => {
    if (seen.current === lang) return;
    seen.current = lang;
    latest.current();
  }, [lang]);
}

/// `Intl.PluralRules` 按语言建一次
const pluralRules = new Map<string, Intl.PluralRules>();

/// 按数量选写法：英文的 one / other 由 `Intl.PluralRules` 定，缺了哪种退回 other
export function selectForm(message: Message, count: number, lang: string): string {
  if (typeof message === "string") return message;
  let rules = pluralRules.get(lang);
  if (!rules) pluralRules.set(lang, (rules = new Intl.PluralRules(lang)));
  const form = rules.select(count);
  return (form === "one" && message.one) || message.other;
}

/// 某种语言里的一条；这种语言里没有的键退回简体，简体也没有给键名（界面上看得见）
export function messageFor(
  lang: Lang,
  key: string,
  catalogs: Partial<Record<Lang, Record<string, Message>>> = CATALOGS,
): Message {
  return catalogs[lang]?.[key] ?? catalogs["zh-Hans"]?.[key] ?? key;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/// 占位符换成参数。缺参数的占位符原样留着：界面上看得见，测试也抓得到
export function formatMessage(template: string, params: Params = {}): string {
  return template.replace(PLACEHOLDER, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

const HAN = /[\u3400-\u9fff]/;
const LATIN = /[A-Za-z0-9]/;

/// 句中嵌名字（位置名、来源名）时的中西文空格：名字与相邻的**汉字**之间，名字那一侧是西文（字母、数字）
/// 就隔一个空格，汉字名紧贴（`从 CardBox 移除 pdf`、`从用户级移除技能`、`从项目A 移除`）。首尾字符各看各的；
/// 与标点、句首句尾相接不加。目录里这类句子写成紧贴的（`从{place}移除{name}`），一句一个键；
/// 英文句子里名字两侧本来就是空格或标点，这条规则不起作用
export function formatSpaced(template: string, params: Params = {}): string {
  return template.replace(PLACEHOLDER, (whole, name: string, at: number) => {
    if (!(name in params)) return whole;
    const value = String(params[name]);
    const before = template[at - 1] ?? "";
    const after = template[at + whole.length] ?? "";
    const lead = HAN.test(before) && LATIN.test(value.charAt(0)) ? " " : "";
    const trail = HAN.test(after) && LATIN.test(value.charAt(value.length - 1)) ? " " : "";
    return lead + value + trail;
  });
}

/// 占位符换成 React 节点（句中嵌 `<Plain>Codex</Plain>` 这类带样式的专名）
export function formatRich(template: string, parts: Record<string, ReactNode>): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    const at = m.index ?? 0;
    if (at > last) out.push(template.slice(last, at));
    out.push(m[1] in parts ? parts[m[1]] : m[0]);
    last = at + m[0].length;
  }
  if (last < template.length) out.push(template.slice(last));
  return createElement(Fragment, null, ...out);
}

/// 列表的连接方式：`enum` 并列（中文「、」）、`and` 两样并举（中文「 和 」）、`semicolon` 几条原因（中文「；」）
export type ListStyle = "enum" | "and" | "semicolon";

/// 连接一组名字或原因（纯函数，测试用）。中文用目录里的连接符，与原来逐字相同——`Intl.ListFormat`
/// 的中文会写成「A、B和C」；其他语言的并列走 `Intl.ListFormat`（`A, B, and C`），分号各语言自写
export function joinList(
  items: readonly string[],
  style: ListStyle,
  lang: string,
  seps: Record<ListStyle, string>,
): string {
  if (style === "semicolon" || lang.startsWith("zh")) return items.join(seps[style]);
  return new Intl.ListFormat(lang, { type: "conjunction" }).format(items);
}

/// 按当前语言连接列表
export function listText(items: readonly string[], style: ListStyle = "enum"): string {
  return joinList(items, style, locale(), {
    enum: t("common.list.enum"),
    and: t("common.list.and"),
    semicolon: t("common.list.semicolon"),
  });
}

function lookup(key: MessageKey): Message {
  return messageFor(current, key as string);
}

/// 取一句文案
export function t(key: MessageKey, params?: Params): string {
  return formatMessage(selectForm(lookup(key), 1, locale()), params);
}

/// 取一句嵌名字的文案，名字与汉字相接处按中西文空格规则处理（见 `formatSpaced`）
export function tSpaced(key: MessageKey, params: Params): string {
  return formatSpaced(selectForm(lookup(key), 1, locale()), params);
}

/// 取一句按数量变的文案；`{count}` 自动带入
export function tn(key: MessageKey, count: number, params?: Params): string {
  return formatMessage(selectForm(lookup(key), count, locale()), { count, ...params });
}

/// 取一句文案，占位符换成 React 节点
export function tRich(key: MessageKey, parts: Record<string, ReactNode>): ReactNode {
  return formatRich(selectForm(lookup(key), 1, locale()), parts);
}
