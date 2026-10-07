/// 页面语言的唯一定义：语言码、页面路径、hreflang、语言 cookie 名。
/// 页面、构建检查、语言菜单、首页的语言跳转都从这里取，别处不再写一份。
/// 无任何依赖（不带预设 JSON、不碰 DOM），所以浏览器脚本也能直接 import。
/// 路径是相对站点根的；带子路径部署（#286）时经 SITE.href 加上子路径。

export const LANGS = [
  { code: "en", path: "/", hreflang: "en" },
  { code: "zh-Hans", path: "/zh-hans/", hreflang: "zh-Hans" },
  { code: "zh-Hant", path: "/zh-hant/", hreflang: "zh-Hant" },
] as const;

export type Lang = (typeof LANGS)[number]["code"];

export const LANG_CODES: readonly Lang[] = LANGS.map((l) => l.code);

/// 语言菜单写、`/` 的跳转读的 cookie 名（spec「语言跳转」）
export const LANG_COOKIE = "lang";

export const isLang = (v: string | undefined): v is Lang => LANG_CODES.some((c) => c === v);

export const pathOf = (code: Lang): string => LANGS.find((l) => l.code === code)!.path;

/// 页面在 dist 里的文件：`/zh-hans/` → `zh-hans/index.html`
export const fileOf = (code: Lang): string => `${pathOf(code).replace(/^\//, "")}index.html`;
