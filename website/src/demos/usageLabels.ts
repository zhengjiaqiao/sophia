/// 用量面板的文案（服务端取好）：用量区与首屏短片第 5 镜头共用，渲染同一份面板标记（usageHtml.ts）。
/// `[[pct]]` 留给标记函数替换，页面上不会残留 {…}。
import { t, type Lang } from "../i18n.ts";
import { slot } from "../lib/template.ts";
import type { UsageLabels } from "./usageHtml.ts";

export function usageLabels(lang: Lang): UsageLabels {
  return {
    none: t(lang, "usage.none"),
    left: t(lang, "usage.left", { pct: slot("pct") }),
    usedPct: t(lang, "usage.usedPct", { pct: slot("pct") }),
    windows: {
      w5h: t(lang, "usage.w5h"),
      week: t(lang, "usage.week"),
      weekFable: t(lang, "usage.weekFable"),
    },
    resets: {
      reset5h: t(lang, "usage.reset5h"),
      resetWeek: t(lang, "usage.resetWeek"),
      resetCodexWeek: t(lang, "usage.resetCodexWeek"),
    },
    agents: { claude: "Claude", codex: "Codex" },
  };
}
