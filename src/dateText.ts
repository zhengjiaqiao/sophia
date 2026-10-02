import { locale, t, tn } from "./i18n.ts";

/// 日期读数：「改于 9月20日」这类只到日的短写法。今年不写年份，跨年写全「2025年9月20日」。
/// 纯函数，`now` 由调用方传（测试用），按本地时区取年月日
export function shortDate(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(locale(), {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
  }).format(d);
}

/// 相对时间：「刚刚」「5 分钟前」「3 小时前」「3 天前」；30 天以上改写日期（`shortDate`）。
/// 纯函数，`now` 由调用方传（测试用）；将来的时间（时钟偏差）按「刚刚」。
/// `inline`：嵌在句子中间时（`热门排行 · 刚刚更新`），英文写小写的 `just now`
export function relativeTime(ms: number, now: Date = new Date(), inline = false): string {
  const minutes = Math.floor((now.getTime() - ms) / 60_000);
  if (minutes < 1) return inline ? t("time.relative.justNowInline") : t("time.relative.justNow");
  if (minutes < 60) return tn("time.relative.minutes", minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tn("time.relative.hours", hours);
  const days = Math.floor(hours / 24);
  if (days < 30) return tn("time.relative.days", days);
  return shortDate(ms, now);
}

/// 自动规则最近一次执行的读数：skill「2 分钟前 · 加到 3 个」，MCP「2 分钟前 · 写进 3 个」。
/// `noun`：来源的种类（`skill` / `MCP`），各一句整句。纯函数，`now` 由调用方传（测试用）
export function lastAutoText(
  run: { at: number; added: number },
  noun: "skill" | "MCP",
  now: Date = new Date(),
): string {
  const params = { when: relativeTime(run.at, now) };
  return noun === "MCP"
    ? tn("time.lastAutoMcp", run.added, params)
    : tn("time.lastAutoSkill", run.added, params);
}
