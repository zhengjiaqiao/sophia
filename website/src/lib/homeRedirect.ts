/// 首页语言跳转（spec R2；#286 起在页面里做，GitHub Pages 跑不了服务端代码）：
/// 选过的语言（`lang` cookie，顶栏语言菜单写）优先，否则看浏览器最优先的那个语言；只有 zh 系会跳。
/// 英文页的 <head> 里同步执行，页面还没画出来就跳走；关掉 JS 时停在英文页，可以从语言菜单手动切换。
///
/// Page.astro 把这个函数的**源码**内联进页面（`(${homeRedirect})(…)`），省一个脚本请求、不让英文页先闪一下。
/// 所以函数体必须自包含：不引用本文件或别处的任何名字，用到的都从参数传进来（tests/home-redirect.test.ts 把关）。

export interface RedirectWindow {
  document: { cookie: string };
  navigator: { languages?: readonly string[]; language?: string };
  location: { search: string; hash: string; replace(url: string): void };
}

/// here：这一页的语言码；paths：语言码 → 已带子路径的页面地址；返回跳去的地址，不跳就是 null
export function homeRedirect(
  here: string,
  paths: Record<string, string>,
  cookieName: string,
  w: RedirectWindow,
): string | null {
  let lang: string | undefined;
  for (const part of w.document.cookie.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === cookieName) {
      const saved = part.slice(i + 1).trim();
      if (Object.prototype.hasOwnProperty.call(paths, saved)) lang = saved;
    }
  }
  if (!lang) {
    // 一个语言标签落到哪种页面：zh-TW / HK / MO / Hant 是繁体，其余 zh 是简体，别的都留英文
    const tag = (w.navigator.languages?.[0] ?? w.navigator.language ?? "").toLowerCase().split("-");
    if (tag[0] !== "zh") lang = "en";
    else if (tag.includes("hant")) lang = "zh-Hant";
    else if (tag.includes("hans")) lang = "zh-Hans";
    else lang = tag.some((p) => p === "tw" || p === "hk" || p === "mo") ? "zh-Hant" : "zh-Hans";
  }
  if (lang === here || !paths[lang]) return null;
  const to = paths[lang] + w.location.search + w.location.hash;
  w.location.replace(to);
  return to;
}
