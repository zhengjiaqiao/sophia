/// 第三批画板 7A：键值两列的左列「至少原宽，放不下就按字撑开」——`minmax(原宽, max-content)`。
/// 简体的键（两到四个汉字）都窄于原宽，列宽仍是原宽、逐像素不变；English 的 Transport、Command 按最长的键撑开。
/// 两处：MCP 详情（36）、介绍页（72）。几行共用一张格子，才撑得齐（每行各自一张会参差）。模型提供商表单 2026-10-07 起在弹窗里、标签在上，不再有标签列
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

test("模型提供商弹窗（画板第 9 屏）：标签在上、输入框占满，English 长标签不挤输入框；不再有写死宽度的标签列", () => {
  const form = css("gatewayForm.css");
  assert.doesNotMatch(form, /grid-template-columns|grid-column|44px/);
  const page = css("ProvidersPage.css");
  assert.match(rule(page, ".provider-dialog__field"), /flex-direction: column;/);
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
