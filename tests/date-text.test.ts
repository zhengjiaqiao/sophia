import assert from "node:assert/strict";
import test from "node:test";
import { relativeTime, shortDate } from "../src/dateText.ts";

test("shortDate：今年只写月日，跨年写全年份", () => {
  const now = new Date(2026, 8, 22);
  assert.equal(shortDate(new Date(2026, 8, 20, 15).getTime(), now), "9月20日");
  assert.equal(shortDate(new Date(2025, 8, 20).getTime(), now), "2025年9月20日");
  assert.equal(shortDate(new Date(2026, 0, 1).getTime(), now), "1月1日");
});

test("relativeTime：分钟 / 小时 / 天，30 天以上写日期", () => {
  const now = new Date(2026, 8, 23, 12);
  const ago = (ms: number) => relativeTime(now.getTime() - ms, now);
  assert.equal(ago(20_000), "刚刚");
  assert.equal(ago(-60_000), "刚刚");
  assert.equal(ago(5 * 60_000), "5 分钟前");
  assert.equal(ago(3 * 3_600_000), "3 小时前");
  assert.equal(ago(3 * 86_400_000), "3 天前");
  assert.equal(relativeTime(new Date(2026, 7, 1).getTime(), now), "8月1日");
});
