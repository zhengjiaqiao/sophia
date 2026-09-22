/// 日期读数：「改于 9月20日」这类只到日的短写法。今年不写年份，跨年写全「2025年9月20日」。
/// 纯函数，`now` 由调用方传（测试用），按本地时区取年月日
export function shortDate(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`;
}
