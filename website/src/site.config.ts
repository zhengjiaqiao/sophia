/// 站点配置：页面与检查脚本共用的一处事实。
/// 数字类说法一律从仓库数据算，不手写（spec R4）：最低系统版本取自应用配置，服务商数取自内置预设。
/// 这个文件要同时被 Astro（vite）与 node 脚本加载，所以 JSON 一律用 `with { type: "json" }` 引入。
import tauriConf from "../../src-tauri/tauri.conf.json" with { type: "json" };
import presets from "../../crates/core/data/provider-presets.json" with { type: "json" };
import { LATEST_DMG } from "../../packaging/cos-manifest.mjs";
import { LANGS, type Lang } from "./lib/langs.ts";
import { siteUrl } from "./lib/siteUrl.ts";

/// "14.0" → "14"：整数版本不写小数
export const macosLabel = (v: string) => v.replace(/\.0+$/, "");
/// 向下取整到十：74 → 70（页面写「70 多家」）
export const floorToTen = (n: number) => Math.floor(n / 10) * 10;

/// 语言的自称（菜单里各语言按自己的写法显示）
const LANG_LABELS: Record<Lang, string> = {
  en: "English",
  "zh-Hans": "简体中文", // i18n-exempt: 语言的自称
  "zh-Hant": "繁體中文", // i18n-exempt: 语言的自称
};

const REPO = "https://github.com/zhengjiaqiao/sophia";

/// 腾讯云 COS 桶：取自应用更新的 COS 线路（tauri.conf.json 里那条 myqcloud.com 的清单地址），桶只写这一处
const COS_BASE = new URL(".", tauriConf.plugins.updater.endpoints.find((u) => u.includes(".myqcloud.com/"))!).href;

/// 部署地址（SITE_URL，见 lib/siteUrl.ts）：GitHub Pages 带子路径 /sophia/，正式域名不带
const DEPLOY = siteUrl(process.env.SITE_URL);

export const SITE = {
  origin: DEPLOY.origin,
  /// 子路径（`/` 或 `/sophia/`）；站内链接一律经 href 加上它
  base: DEPLOY.base,
  href: DEPLOY.href,
  repo: REPO,
  links: {
    github: REPO,
    releases: `${REPO}/releases`,
    issues: `${REPO}/issues`,
    privacy: `${REPO}/blob/main/PRIVACY.md`,
    notice: `${REPO}/blob/main/NOTICE`,
  },
  brewCommand: "brew install --cask zhengjiaqiao/tap/sophia",
  minMacos: macosLabel(tauriConf.bundle.macOS.minimumSystemVersion),
  providerFloor: floorToTen(presets.providers.length),

  /// 下载链接：直链 COS 上固定文件名的最新版 .dmg（对象键取自发版同步脚本的 LATEST_DMG，每次发版由
  /// .github/workflows/cos-sync.yml 覆盖），所以页面不写版本号、发版后网站不用改，关 JS 也能下
  downloadHref: {
    arm64: COS_BASE + LATEST_DMG.aarch64,
    x64: COS_BASE + LATEST_DMG.x64,
  },
  get downloadHrefs() {
    return [...new Set([this.downloadHref.arm64, this.downloadHref.x64])];
  },

  /// 构建检查允许出现的外部域名（R22：不依赖境外 CDN），**精确匹配、子域不算**。每一项为什么在：
  ///   github.com      仓库、Releases、PRIVACY 等链接（用户点出去的，不是页面加载的资源）
  ///   sophiakit.com   自己的域名：canonical 与 hreflang
  ///   zhengjiaqiao.github.io  备案下来之前发到 GitHub Pages 时的地址：canonical 与 hreflang（#286）
  ///   COS 桶的默认域名  下载键直链的 .dmg（用户点出去的，不是页面加载的资源）
  ///   www.w3.org      SVG 的 xmlns 命名空间，不是请求
  /// GSAP 的 gsap.com 只作为字符串出现在许可声明与告警文字里，不在这里放行，见 scripts/check-site.ts 的 INERT_HOSTS
  allowedHosts: ["github.com", "sophiakit.com", "zhengjiaqiao.github.io", new URL(COS_BASE).host, "www.w3.org"],

  /// R17.1：模型区与首屏短片里开关上写的 agent，上线时都得是真能接第三方模型的（真机核实）。
  /// 名单只在这里写一处；画板里的 Cursor 是占位，上线时换成那时已支持的，或只留两家
  agents: [
    { id: "codex", name: "Codex" },
    { id: "claude", name: "Claude" },
  ],

  /// 语言菜单与 hreflang 用：码、路径、hreflang 来自 lib/langs.ts（唯一定义），这里只加自称
  langs: LANGS.map((l) => ({ ...l, label: LANG_LABELS[l.code] })),
} as const;
