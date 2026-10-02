/// 第三批画板 7A：键值两列的左列「至少原宽，放不下就按字撑开」——`minmax(原宽, max-content)`。
/// 简体的键（两到四个汉字）都窄于原宽，列宽仍是原宽、逐像素不变；English 的 Transport、Command 按最长的键撑开。
/// 三处：MCP 详情（36）、网关表单（44）、介绍页（72）。几行共用一张格子，才撑得齐（每行各自一张会参差）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
const rule = (src: string, selector: string) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = src.match(new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`));
  assert.ok(m, `${selector} 的规则`);
  return m[1];
};

test("7A MCP 详情：键列 minmax(36px, max-content)，三行同一张格子", () => {
  assert.match(
    rule(css("Matrix.css"), ".mx-kv"),
    /grid-template-columns: minmax\(36px, max-content\) minmax\(0, 1fr\);/,
  );
});

test("7A 网关表单：两行的标签与输入框同一张格子，标签列 minmax(44px, max-content)；键区与报错对齐输入框那一列，不再写死 44 的缩进", () => {
  const src = css("ModelsTab.css");
  const form = rule(src, ".gw-form");
  assert.match(form, /display: grid;/);
  assert.match(
    form,
    /grid-template-columns: minmax\(44px, max-content\) var\(--space-sm\) min\(360px, 100%\) minmax\(0, 1fr\);/,
  );
  assert.match(form, /row-gap: var\(--space-xs\);/);
  assert.match(rule(src, ".gw-form__field"), /display: contents;/);
  assert.match(rule(src, ".gw-form__label"), /grid-column: 1;/);
  assert.match(rule(src, ".gw-form__field > :last-child"), /grid-column: 3;/);
  for (const sel of [".gw-form__actions", ".gw-form__error"]) {
    assert.match(rule(src, sel), /grid-column: 3 \/ -1;/, sel);
    assert.doesNotMatch(rule(src, sel), /44px/, sel);
  }
  assert.match(rule(src, ".gw-form__facts"), /grid-column: 1 \/ -1;/);
  assert.doesNotMatch(src, /calc\(44px/);
});

test("7A 介绍页：两行事实同一张格子，键列 minmax(72px, max-content)，按基线对齐", () => {
  const src = css("market/IntroPage.css");
  const facts = rule(src, ".intro__facts");
  assert.match(facts, /display: grid;/);
  assert.match(facts, /grid-template-columns: minmax\(72px, max-content\) minmax\(0, 1fr\);/);
  assert.match(facts, /gap: var\(--space-xs\) var\(--space-sm\);/);
  assert.match(facts, /align-items: baseline;/);
  assert.match(rule(src, ".intro__fact"), /display: contents;/);
  assert.doesNotMatch(rule(src, ".intro__fact dt"), /width: 72px/);
});
