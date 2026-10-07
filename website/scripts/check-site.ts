#!/usr/bin/env node
/// 构建检查（spec 2026-10-06-website AC9、AC12、AC14、R2、R22）：`make build-site` 在 astro build 之后跑它。
/// 查这些，任何一条不满足就非零退出，并指出是哪个页面、哪个键、哪个域名：
///   - 三份文案（website/locales/*.json）键集合一致、同一条的占位符一致
///   - 产出的 HTML 没有残留 `{占位符}`（脚本与样式里的花括号不算）
///   - 所有产物里的外部域名都在白名单内（R22：不依赖境外 CDN）
///   - 每页带齐 hreflang（含 x-default）
///   - 带子路径构建（GitHub Pages 的 /sophia/，#286）时，页面与样式里的站内地址都带上它
///   - 最低系统版本与 tauri.conf.json 一致、模型区的服务商数（「N 多家」）与预设一致（AC12）
///   - 关 JS 也能看到文案与下载链接（AC14）：STATIC_KEYS 里的句子与下载链接都在静态 HTML 里
/// 后续票要加断言：往 `checkPage` 里加一条（有需要的数据放进 PageContext），或把键放进 STATIC_KEYS；
/// 同时在 tests/check-site.test.ts 里加一条造错的用例。
/// 用法：node scripts/check-site.ts [--dist dist] [--locales locales]；子路径取自构建时同一个 SITE_URL（src/lib/siteUrl.ts）
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import presets from "../../crates/core/data/provider-presets.json" with { type: "json" };
import { fileOf, LANGS, type Lang } from "../src/lib/langs.ts";
import { floorToTen, SITE } from "../src/site.config.ts";

export type { Lang };

/// 三个页面：路径相对 dist，语言码、路径、hreflang 都取自 src/lib/langs.ts
export const PAGES: { lang: Lang; file: string }[] = LANGS.map((l) => ({ lang: l.code, file: fileOf(l.code) }));

/// 关 JS 也必须在静态 HTML 里的句子（AC14）。每个后续票把自己区块的标题、一句话键加进来
export const STATIC_KEYS = [
  "hero.title1",
  "hero.title2",
  "hero.lead1",
  "hero.lead2",
  "hero.download",
  "models.title1",
  "models.title2",
  "models.step1",
  "models.step2",
  "models.step3",
  "skills.title1",
  "skills.title2",
  "usage.title1",
  "usage.title2",
  "install.title1",
  "install.title2",
  "install.arm",
  "install.intel",
  "install.copy",
  "footer.disclaimer",
  // #185：顶栏与首屏短片的静止帧（第 1 镜头字幕）
  "nav.models",
  "nav.skills",
  "nav.usage",
  "nav.download",
  "hero.intel",
  "film.s1a",
  "film.s1b",
  // #242：第 2–5 镜头的字幕（关 JS 时镜头收起，但文案必须在静态 HTML 里：读屏、搜索、分享卡都靠它）
  "film.s2a",
  "film.s2b",
  "film.s3a",
  "film.s3b1",
  "film.s3b2",
  "film.s4a",
  "film.s4b",
  "film.s5a",
  "film.s5b",
  "film.end1",
  "film.end2",
];

export interface PageContext {
  /** 构建的子路径（`/` 或 `/sophia/`） */
  base: string;
  minMacos: string;
  /** 这一页的语言里，STATIC_KEYS 对应的句子 */
  staticTexts: string[];
  /** 静态 HTML 里必须出现的下载链接 */
  downloadHrefs: string[];
  /** 模型区一句话（含服务商数）按这一页语言展开后的整句；数字必须是预设数向下取整到十（AC12） */
  providerSub: string;
}

type Tree = { [k: string]: string | Tree };

/// 嵌套目录展平成 `区块.名字`
export function flattenCatalog(tree: Tree, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out[key] = v;
    else Object.assign(out, flattenCatalog(v, key));
  }
  return out;
}

const placeholders = (s: string) => [...new Set(s.match(/\{[A-Za-z_]\w*\}/g) ?? [])].sort();

/// 以 zh-Hans 为准比较：缺键、多键、占位符不一致
export function checkCatalogs(byLang: Record<string, Tree>): string[] {
  const flat: Record<string, Record<string, string>> = {};
  for (const [lang, tree] of Object.entries(byLang)) flat[lang] = flattenCatalog(tree);
  const base = flat["zh-Hans"] ?? {};
  const problems: string[] = [];
  for (const lang of Object.keys(flat).filter((l) => l !== "zh-Hans")) {
    for (const key of Object.keys(base)) if (!(key in flat[lang])) problems.push(`${lang} 缺 ${key}`);
    for (const key of Object.keys(flat[lang]))
      if (!(key in base)) problems.push(`${lang} 多了 ${key}（zh-Hans 没有）`);
  }
  for (const key of Object.keys(base)) {
    const ref = placeholders(base[key]).join(" ");
    for (const lang of Object.keys(flat).filter((l) => l !== "zh-Hans")) {
      if (!(key in flat[lang])) continue;
      const mine = placeholders(flat[lang][key]).join(" ");
      if (mine !== ref) problems.push(`${key} 的占位符不一致：zh-Hans ${ref || "（无）"}，${lang} ${mine || "（无）"}`);
    }
  }
  return problems;
}

/// 只当「字符串」出现、不会发请求的域名，按文件限定（R22：页面不依赖境外域名，但随站打包的 GSAP 自带许可声明与告警文字）。
/// 只放行精确的主机名，且只在这两处：THIRD-PARTY-NOTICES.txt，以及含 GSAP 自己告警文字的打包脚本。
/// HTML 里一律不放行：`<script src="https://gsap.com/…">` 必须报。
const INERT_HOSTS: { host: string; applies: (file: string, text: string) => boolean }[] = [
  {
    host: "gsap.com",
    applies: (file, text) =>
      file === "THIRD-PARTY-NOTICES.txt" || (/\.m?js$/.test(file) && text.includes("GSAP target")),
  },
];

/// 文本里出现的外部域名（`http(s)://host`、`ws(s)://host` 与协议相对的 `//host.tld`），
/// 不在 SITE.allowedHosts 的逐个报。**精确匹配主机名，子域不算**：`cdn.github.com` 与 `github.com` 是两回事。
export function checkDomains(file: string, text: string): string[] {
  const hosts = new Set<string>();
  const add = (h: string) => hosts.add(h.toLowerCase().replace(/[.-]+$/, ""));
  for (const m of text.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9][a-z0-9.-]*)/gi)) add(m[1]);
  for (const m of text.matchAll(/\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) add(m[1]);
  const allowed = new Set<string>(SITE.allowedHosts);
  for (const inert of INERT_HOSTS) if (inert.applies(file, text)) allowed.add(inert.host);
  return [...hosts]
    .filter((h) => !allowed.has(h))
    .sort()
    .map((h) => `${file}：白名单外的域名 ${h}`);
}

/// 站内地址（以单个 `/` 开头的 href、src、srcset 与样式里的 url()）没带子路径的逐个报：
/// 部署在子路径下时它们会落到子路径之外，全是 404。不带子路径构建（base 为 `/`）时不用查
export function checkBase(file: string, text: string, base: string): string[] {
  if (base === "/") return [];
  const urls = new Set<string>();
  for (const m of text.matchAll(/\b(?:href|src|poster|action)=["'](\/[^"']*)/gi)) urls.add(m[1]);
  for (const m of text.matchAll(/\bsrcset=["']([^"']*)/gi))
    for (const part of m[1].split(",")) urls.add(part.trim().split(/\s+/)[0]);
  for (const m of text.matchAll(/url\(\s*["']?(\/[^"')\s]*)/gi)) urls.add(m[1]);
  return [...urls]
    .filter((u) => u.startsWith("/") && !u.startsWith("//") && !u.startsWith(base))
    .sort()
    .map((u) => `${file}：站内地址 ${u} 没带子路径 ${base}`);
}

const decode = (s: string) =>
  s
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[\s ]+/g, " ");

export function checkPage(file: string, html: string, ctx: PageContext): string[] {
  const problems: string[] = [];
  const noCode = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");

  for (const m of new Set(noCode.match(/\{[A-Za-z_][\w.-]*\}/g) ?? [])) problems.push(`${file}：残留占位符 ${m}`);
  problems.push(...checkDomains(file, html));
  problems.push(...checkBase(file, html, ctx.base));

  for (const lang of [...LANGS.map((l) => l.hreflang), "x-default"])
    if (!new RegExp(`<link[^>]*hreflang="${lang}"`).test(html)) problems.push(`${file}：缺 hreflang ${lang}`);

  const text = decode(noCode);
  if (!text.includes(`macOS ${ctx.minMacos}`)) problems.push(`${file}：缺「macOS ${ctx.minMacos}」（应用最低系统版本）`);
  for (const s of ctx.staticTexts)
    if (!text.includes(decode(s))) problems.push(`${file}：静态 HTML 里没有文案「${s}」`);
  // R18：下载函数永远给最新版，页面上写了版本号发版后就会过时
  const version = text.replace(/<[^>]*>/g, " ").match(/(?<![\w.])v?\d+\.\d+\.\d+(?![\w.]*\d)/);
  if (version) problems.push(`${file}：页面不应出现版本号（${version[0]}），下载键直链固定文件名的最新版`);
  for (const href of ctx.downloadHrefs)
    if (!noCode.includes(`href="${href}"`)) problems.push(`${file}：静态 HTML 里没有下载链接 ${href}`);
  if (!text.includes(decode(ctx.providerSub)))
    problems.push(`${file}：静态 HTML 里没有服务商数的说法「${ctx.providerSub}」（应用预设向下取整到十）`);
  return problems;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/// 整站检查：目录读进来、逐项过。返回问题列表，空就是通过
export function checkSite(opts: { dist: string; locales: string; base: string }): string[] {
  const byLang: Record<string, Tree> = {};
  for (const { code } of LANGS) byLang[code] = readJson(join(opts.locales, `${code}.json`));
  const problems = checkCatalogs(byLang);

  if (!existsSync(opts.dist)) return [...problems, `没有构建产物：${opts.dist}（先 astro build）`];
  for (const { lang, file } of PAGES) {
    const path = join(opts.dist, file);
    if (!existsSync(path)) {
      problems.push(`${file}：页面没生成`);
      continue;
    }
    const flat = flattenCatalog(byLang[lang]);
    problems.push(
      ...checkPage(file, readFileSync(path, "utf8"), {
        base: opts.base,
        minMacos: SITE.minMacos,
        staticTexts: STATIC_KEYS.map((k) => flat[k]).filter((v) => v !== undefined),
        downloadHrefs: SITE.downloadHrefs,
        // 数字直接从预设算，不经 SITE.providerFloor：页面或配置里手写的数都会对不上
        providerSub: flat["models.sub"].replace("{count}", String(floorToTen(presets.providers.length))),
      }),
    );
  }
  // 其余产物（样式、脚本、SVG）只查域名，样式另查子路径
  for (const p of walk(opts.dist)) {
    if (p.endsWith(".html") || !/\.(css|js|mjs|svg|json|xml|txt|webmanifest)$/.test(p)) continue;
    const text = readFileSync(p, "utf8");
    problems.push(...checkDomains(relative(opts.dist, p), text));
    if (p.endsWith(".css")) problems.push(...checkBase(relative(opts.dist, p), text, opts.base));
  }
  return problems;
}

function arg(name: string, fallback: string) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkSite({
    dist: resolve(arg("--dist", join(root, "dist"))),
    locales: resolve(arg("--locales", join(root, "locales"))),
    base: SITE.base,
  });
  if (problems.length) {
    console.error(`官网构建检查失败（${problems.length} 项）：\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("官网构建检查通过");
}
