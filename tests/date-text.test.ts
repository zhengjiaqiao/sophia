import assert from "node:assert/strict";
import test from "node:test";
import { shortDate } from "../src/dateText.ts";

test("shortDate：今年只写月日，跨年写全年份", () => {
  const now = new Date(2026, 8, 22);
  assert.equal(shortDate(new Date(2026, 8, 20, 15).getTime(), now), "9月20日");
  assert.equal(shortDate(new Date(2025, 8, 20).getTime(), now), "2025年9月20日");
  assert.equal(shortDate(new Date(2026, 0, 1).getTime(), now), "1月1日");
});
