/// 站点部署在哪儿：同一份代码要能发到不同地址（#286）。构建时用环境变量 SITE_URL 指定，
/// 备案下来之前的 GitHub Pages 是 `https://zhengjiaqiao.github.io/sophia/`（带子路径）；
/// 没给就是正式域名、不带子路径（以后的 Cloudflare Pages 与阿里云服务器）。
/// astro.config.mjs（site、base）、站点配置（canonical、站内链接）与构建检查都从这里取，别处不再拼子路径。

const DEFAULT_URL = "https://sophiakit.com/";

export interface SiteUrl {
  /** 源，不带末尾斜杠：`https://zhengjiaqiao.github.io` */
  origin: string;
  /** 子路径，两头都带斜杠：`/sophia/`；不带子路径时是 `/` */
  base: string;
  /** 站内路径（以 `/` 开头，如 LANGS 里的 `/zh-hans/`）加上子路径 */
  href(path: string): string;
}

export function siteUrl(raw: string | undefined): SiteUrl {
  const url = new URL(raw || DEFAULT_URL);
  if (url.protocol !== "https:") throw new Error(`SITE_URL must be an https URL, got "${raw}"`);
  if (url.search || url.hash) throw new Error(`SITE_URL must not have a query or hash, got "${raw}"`);
  const base = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return { origin: url.origin, base, href: (path) => base + path.replace(/^\//, "") };
}
