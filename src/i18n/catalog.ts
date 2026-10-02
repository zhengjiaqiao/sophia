/// 文案目录的前端入口：把 `locales/<语言>/` 下各区块的 JSON 合成一份，三种语言各一份
/// （spec 2026-09-30-language-and-theme R7、R12）。
///
/// 区块清单与目录下的文件一一对应（`tests/i18n-catalog.test.ts` 核对）；core 的 `i18n.rs` 另有一份
/// `include_str!` 清单读同一批文件。`weiboap.json` 只归后端的 weiboap feature，前端不读。
/// 键带区块前缀（`skills.cell.addTo`），各区块文件只放自己前缀的键，所以合并不会互相覆盖
import zhHansCommon from "../../locales/zh-Hans/common.json" with { type: "json" };
import zhHansHints from "../../locales/zh-Hans/hints.json" with { type: "json" };
import zhHansMarket from "../../locales/zh-Hans/market.json" with { type: "json" };
import zhHansMcp from "../../locales/zh-Hans/mcp.json" with { type: "json" };
import zhHansModels from "../../locales/zh-Hans/models.json" with { type: "json" };
import zhHansSettings from "../../locales/zh-Hans/settings.json" with { type: "json" };
import zhHansShell from "../../locales/zh-Hans/shell.json" with { type: "json" };
import zhHansSkills from "../../locales/zh-Hans/skills.json" with { type: "json" };
import zhHansSources from "../../locales/zh-Hans/sources.json" with { type: "json" };
import zhHansTime from "../../locales/zh-Hans/time.json" with { type: "json" };
import zhHansToast from "../../locales/zh-Hans/toast.json" with { type: "json" };
import zhHansTray from "../../locales/zh-Hans/tray.json" with { type: "json" };
import zhHansUsage from "../../locales/zh-Hans/usage.json" with { type: "json" };
import zhHantCommon from "../../locales/zh-Hant/common.json" with { type: "json" };
import zhHantHints from "../../locales/zh-Hant/hints.json" with { type: "json" };
import zhHantMarket from "../../locales/zh-Hant/market.json" with { type: "json" };
import zhHantMcp from "../../locales/zh-Hant/mcp.json" with { type: "json" };
import zhHantModels from "../../locales/zh-Hant/models.json" with { type: "json" };
import zhHantSettings from "../../locales/zh-Hant/settings.json" with { type: "json" };
import zhHantShell from "../../locales/zh-Hant/shell.json" with { type: "json" };
import zhHantSkills from "../../locales/zh-Hant/skills.json" with { type: "json" };
import zhHantSources from "../../locales/zh-Hant/sources.json" with { type: "json" };
import zhHantTime from "../../locales/zh-Hant/time.json" with { type: "json" };
import zhHantToast from "../../locales/zh-Hant/toast.json" with { type: "json" };
import zhHantTray from "../../locales/zh-Hant/tray.json" with { type: "json" };
import zhHantUsage from "../../locales/zh-Hant/usage.json" with { type: "json" };
import enCommon from "../../locales/en/common.json" with { type: "json" };
import enHints from "../../locales/en/hints.json" with { type: "json" };
import enMarket from "../../locales/en/market.json" with { type: "json" };
import enMcp from "../../locales/en/mcp.json" with { type: "json" };
import enModels from "../../locales/en/models.json" with { type: "json" };
import enSettings from "../../locales/en/settings.json" with { type: "json" };
import enShell from "../../locales/en/shell.json" with { type: "json" };
import enSkills from "../../locales/en/skills.json" with { type: "json" };
import enSources from "../../locales/en/sources.json" with { type: "json" };
import enTime from "../../locales/en/time.json" with { type: "json" };
import enToast from "../../locales/en/toast.json" with { type: "json" };
import enTray from "../../locales/en/tray.json" with { type: "json" };
import enUsage from "../../locales/en/usage.json" with { type: "json" };

/// 一条文案：整句，或按数量分的几种写法（英文的单复数；中文只写 `other` 或直接写字符串）
export type Message = string | { one?: string; other: string };

export const AREAS = [
  "common",
  "hints",
  "market",
  "mcp",
  "models",
  "settings",
  "shell",
  "skills",
  "sources",
  "time",
  "toast",
  "tray",
  "usage",
] as const;

/// 简体目录：键的全集以它为准（`MessageKey`），别的语言缺的键退回它
export const CATALOG = {
  ...zhHansCommon,
  ...zhHansHints,
  ...zhHansMarket,
  ...zhHansMcp,
  ...zhHansModels,
  ...zhHansSettings,
  ...zhHansShell,
  ...zhHansSkills,
  ...zhHansSources,
  ...zhHansTime,
  ...zhHansToast,
  ...zhHansTray,
  ...zhHansUsage,
};

const ZH_HANT = {
  ...zhHantCommon,
  ...zhHantHints,
  ...zhHantMarket,
  ...zhHantMcp,
  ...zhHantModels,
  ...zhHantSettings,
  ...zhHantShell,
  ...zhHantSkills,
  ...zhHantSources,
  ...zhHantTime,
  ...zhHantToast,
  ...zhHantTray,
  ...zhHantUsage,
};

const EN = {
  ...enCommon,
  ...enHints,
  ...enMarket,
  ...enMcp,
  ...enModels,
  ...enSettings,
  ...enShell,
  ...enSkills,
  ...enSources,
  ...enTime,
  ...enToast,
  ...enTray,
  ...enUsage,
};

/// 三种语言的目录，键是语言标签（与 `locales/` 下的文件夹同名）
export const CATALOGS: Record<"zh-Hans" | "zh-Hant" | "en", Record<string, Message>> = {
  "zh-Hans": CATALOG,
  "zh-Hant": ZH_HANT,
  en: EN,
};
