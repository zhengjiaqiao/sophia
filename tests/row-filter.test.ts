import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesFilter } from "../src/rowFilter.ts";

test("AC19 matchesFilter：命中名字", () => {
  assert.equal(matchesFilter("docx", "docx", "通用仓库"), true);
  assert.equal(matchesFilter("do", "docx", "通用仓库"), true);
});

test("AC19 matchesFilter：命中来源（名字里没有）", () => {
  assert.equal(matchesFilter("通用仓库", "docx", "通用仓库"), true);
  assert.equal(matchesFilter("仓库", "docx", "通用仓库"), true);
});

test("AC19 matchesFilter：名字与来源都不命中", () => {
  assert.equal(matchesFilter("pdf", "docx", "通用仓库"), false);
});

test("AC19 matchesFilter：空查询（含只有空白）总是命中", () => {
  assert.equal(matchesFilter("", "docx", "通用仓库"), true);
  assert.equal(matchesFilter("   ", "docx", null), true);
});

test("AC19 matchesFilter：大小写不敏感", () => {
  assert.equal(matchesFilter("WEIBOAP", "docx", "WeiboAP"), true);
  assert.equal(matchesFilter("DOCX", "docx", "通用仓库"), true);
});

test("AC19 matchesFilter：查询两端的空白不算数（只筛掉整段都是空白的）", () => {
  assert.equal(matchesFilter("  docx  ", "docx", "通用仓库"), true);
});

test("AC19 matchesFilter：来源为 null（没有可比对的来源，如孤链行）时只按名字命中", () => {
  assert.equal(matchesFilter("不在了", "docx", null), false);
  assert.equal(matchesFilter("doc", "docx", null), true);
});
