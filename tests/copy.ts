/// 测试助手：文案搬进目录后（spec 2026-09-30-language-and-theme 第二批），读源码断言文案的测试经这里
/// 把源码里的键换回简体文案再比。断言的中文一字不改，只改取文案的路径
import { CATALOG, type Message } from "../src/i18n/catalog.ts";

const MESSAGES: Record<string, Message> = CATALOG;
const textOf = (m: Message) => (typeof m === "string" ? m : m.other);

/// 目录里一条文案的简体（按数量变的取 other）
export function copy(key: string, catalog: Record<string, Message> = MESSAGES): string {
  const m = catalog[key];
  if (m === undefined) throw new Error(`目录里没有 ${key}`);
  return textOf(m);
}

/// 源码里的键换成简体文案：`title={t("k")}` → `title="文案"`，JSX 子节点 `{t("k")}` → `文案`，
/// 其余出现的 `"k"`（t("k", …)、键表里的值）→ `"文案"`。不在目录里的字符串原样
export function withCopy(src: string, catalog: Record<string, Message> = MESSAGES): string {
  const text = (k: string) => (k in catalog ? textOf(catalog[k]) : null);
  return src
    .replace(/=\{\s*t\(\s*"([^"]+)"\s*\)\s*\}/g, (m, k) => (text(k) === null ? m : `="${text(k)}"`))
    .replace(/\{\s*t\(\s*"([^"]+)"\s*\)\s*\}/g, (m, k) => text(k) ?? m)
    .replace(/"([a-z]+(?:\.[A-Za-z0-9_]+)+)"/g, (m, k) => (text(k) === null ? m : `"${text(k)}"`));
}
