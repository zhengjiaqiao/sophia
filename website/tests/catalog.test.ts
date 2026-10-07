/// 文案目录与代码的对应（DESIGN「文案目录」的官网版）：代码里引用的键都在目录里；
/// 页面代码里不写中文（句子都在 website/locales/）。确实只能写中文的地方同一行写 `i18n-exempt: 理由`。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { flattenCatalog } from "../scripts/check-site.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const sources = walk(join(root, "src")).filter((p) => /\.(astro|ts)$/.test(p));
const zhHans = flattenCatalog(JSON.parse(readFileSync(join(root, "locales/zh-Hans.json"), "utf8")));

test("代码里 t(lang, \"键\") 引用的键都在目录里", () => {
  const missing: string[] = [];
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\bt\(\s*[A-Za-z_.]+\s*,\s*"([^"]+)"/g))
      if (!(m[1] in zhHans)) missing.push(`${relative(root, file)} 引用了不存在的键 ${m[1]}`);
  }
  assert.deepEqual(missing, []);
});

test("页面代码里不写中文：句子都在 locales/，例外要写 i18n-exempt", () => {
  const found: string[] = [];
  for (const file of sources) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/[一-鿿]/.test(line) && !line.includes("i18n-exempt") && !/^\s*(\/\/|\/\*|\*|<!--)/.test(line))
          found.push(`${relative(root, file)}:${i + 1}`);
      });
  }
  assert.deepEqual(found, []);
});

test("目录里每个键都有人用：源码里出现过这个键的字面量（防止改文案后留下死键）", () => {
  const text = sources.map((f) => readFileSync(f, "utf8")).join("\n");
  const unused = Object.keys(zhHans).filter((k) => !text.includes(`"${k}"`));
  assert.deepEqual(unused, []);
});

test("R6：「AI agent」「agent 配置」在三份目录里都用不换行空格连着，标题折行不拆开", () => {
  const bad: string[] = [];
  for (const lang of ["en", "zh-Hans", "zh-Hant"]) {
    const flat = flattenCatalog(JSON.parse(readFileSync(join(root, `locales/${lang}.json`), "utf8")));
    for (const [k, v] of Object.entries(flat)) if (/AI agent|agent [配設]/.test(v)) bad.push(`${lang} ${k}`);
  }
  assert.deepEqual(bad, []);
});
