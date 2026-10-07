/// 站点配置：页面与检查脚本共用的一处事实。
/// 数字类说法一律从仓库数据算，不手写（spec R4）：最低系统版本取自应用配置，服务商数取自内置预设。
/// 这个文件要同时被 Astro（vite）与 node 脚本加载，所以 JSON 一律用 `with { type: "json" }` 引入。
import tauriConf from "../../src-tauri/tauri.conf.json" with { type: "json" };
import presets from "../../crates/core/data/provider-presets.json" with { type: "json" };
import { LANGS, type Lang } from "./lib/langs.ts";

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

export const SITE = {
  origin: "https://sophiakit.com",
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

  /// 下载链接：走 Pages Function（functions/download/mac.ts），它读最新版清单再跳到对应 .dmg，
  /// 所以页面不写版本号、发版后网站不用改
  downloadHref: {
    arm64: "/download/mac?arch=arm64",
    x64: "/download/mac?arch=x64",
  },
  get downloadHrefs() {
    return [...new Set([this.downloadHref.arm64, this.downloadHref.x64])];
  },

  /// 构建检查允许出现的外部域名（R22：不依赖境外 CDN），**精确匹配、子域不算**。每一项为什么在：
  ///   github.com      仓库、Releases、PRIVACY 等链接（用户点出去的，不是页面加载的资源）
  ///   sophiakit.com   自己的域名：canonical 与 hreflang
  ///   www.w3.org      SVG 的 xmlns 命名空间，不是请求
  /// GSAP 的 gsap.com 只作为字符串出现在许可声明与告警文字里，不在这里放行，见 scripts/check-site.ts 的 INERT_HOSTS
  allowedHosts: ["github.com", "sophiakit.com", "www.w3.org"],

  /// R17.1：模型区与首屏短片里开关上写的 agent，上线时都得是真能接第三方模型的（真机核实）。
  /// 名单只在这里写一处；画板里的 Cursor 是占位，上线时换成那时已支持的，或只留两家
  agents: [
    { id: "codex", name: "Codex" },
    { id: "claude", name: "Claude" },
  ],

  /// 语言菜单与 hreflang 用：码、路径、hreflang 来自 lib/langs.ts（唯一定义），这里只加自称
  langs: LANGS.map((l) => ({ ...l, label: LANG_LABELS[l.code] })),
} as const;
