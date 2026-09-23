/// 日期读数：「改于 9月20日」这类只到日的短写法。今年不写年份，跨年写全「2025年9月20日」。
/// 纯函数，`now` 由调用方传（测试用），按本地时区取年月日
export function shortDate(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

/// 相对时间：「刚刚」「5 分钟前」「3 小时前」「3 天前」；30 天以上改写日期（`shortDate`）。
/// 纯函数，`now` 由调用方传（测试用）；将来的时间（时钟偏差）按「刚刚」
export function relativeTime(ms: number, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - ms) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return shortDate(ms, now);
}
