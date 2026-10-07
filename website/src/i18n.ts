/// 官网文案：`website/locales/<zh-Hans|zh-Hant|en>.json`，三份同一套键（嵌套的区块 → 名字）。
/// 规则同应用（DESIGN「文案目录」）：键写字面量、一句话一个键、不拼键名、不在模块顶层取文案。
/// 缺键、占位符没填、多给参数都在构建时抛错，指明是哪个键，页面构建不出来。
import en from "../locales/en.json" with { type: "json" };
import zhHans from "../locales/zh-Hans.json" with { type: "json" };
import zhHant from "../locales/zh-Hant.json" with { type: "json" };

import type { Lang } from "./lib/langs.ts";

export type { Lang };
type Tree = { [k: string]: string | Tree };
export type Params = Record<string, string | number>;

const CATALOG: Record<Lang, Tree> = { en, "zh-Hans": zhHans, "zh-Hant": zhHant };

export function makeT(catalog: Record<string, Tree>) {
  return (lang: string, key: string, params?: Params): string => {
    let node: string | Tree | undefined = catalog[lang];
    for (const part of key.split(".")) node = typeof node === "object" ? node[part] : undefined;
    if (node === undefined) throw new Error(`${lang} 缺文案键 ${key}`); // i18n-exempt: 构建期错误信息，不进页面
    if (typeof node !== "string") throw new Error(`${lang} 的 ${key} 不是一句文案（是区块）`); // i18n-exempt: 构建期错误信息，不进页面
    const used = new Set<string>();
    const text = node.replace(/\{([A-Za-z_]\w*)\}/g, (_, name: string) => {
      if (!params || !(name in params)) throw new Error(`${lang} 的 ${key} 缺参数 {${name}}`); // i18n-exempt: 构建期错误信息，不进页面
      used.add(name);
      return String(params[name]);
    });
    const unused = Object.keys(params ?? {}).filter((n) => !used.has(n));
    if (unused.length) throw new Error(`${lang} 的 ${key} 用不上参数 ${unused.join("、")}`); // i18n-exempt: 构建期错误信息，不进页面
    return text;
  };
}

/// 页面里用的 t：`t(lang, "hero.title1")`、`t(lang, "skills.added", { agent: "Codex" })`
export const t = makeT(CATALOG);
