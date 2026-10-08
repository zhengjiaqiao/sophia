/// English 与繁體目录（连同精选 MCP 清单里按语言写的字，#305）的译文检查（spec 2026-09-30-language-and-theme R10、R11，AC11–AC13 的代理验证）。
/// 各语言键与占位符一致由 i18n-catalog.test.ts 查；这里查译文本身：English 里没有中文，繁體里没有简体字，
/// 术语按 locales/GLOSSARY.md 的规定写法（列出每个术语不许用的写法）
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import * as OpenCC from "opencc-js";

type Message = string | Record<string, string>;
type Texts = Record<string, string>;
/// 精选 MCP 清单里按界面语言写的字（#305）：说明、要填的标签与框下一句，与目录同一套译文检查
const curated = (lang: string): Record<string, Message> => {
  const file: {
    servers: {
      name: string;
      description: Texts;
      fields: { key: string; label: Texts; help?: Texts }[];
    }[];
  } = JSON.parse(
    readFileSync(new URL("../crates/core/data/market/mcp-curated.json", import.meta.url), "utf8"),
  );
  const out: Record<string, Message> = {};
  for (const s of file.servers) {
    out[`mcp-curated ${s.name}.description`] = s.description[lang];
    for (const f of s.fields) {
      out[`mcp-curated ${s.name}.${f.key}.label`] = f.label[lang];
      if (f.help) out[`mcp-curated ${s.name}.${f.key}.help`] = f.help[lang];
    }
  }
  return out;
};
const load = (lang: string): Record<string, Message> =>
  Object.assign(
    {},
    ...readdirSync(new URL(`../locales/${lang}/`, import.meta.url)).map((f) =>
      JSON.parse(readFileSync(new URL(`../locales/${lang}/${f}`, import.meta.url), "utf8")),
    ),
    curated(lang),
  );
const forms = (v: Message) => (typeof v === "string" ? [v] : Object.values(v));
const CJK = /[　-〿㐀-鿿＀-￯]/;
/// 设置里「界面语言」的三个选项写成各语言的自称（选语言的人未必读得懂当前界面的语言），三份目录里值相同：
/// English 里的「简体中文」「繁體中文」、繁體里的「简体中文」是有意的，不算漏译
const ENDONYMS = new Set(["settings.language.zhHans", "settings.language.zhHant"]);

test("English 目录里没有中文字符（专名本来就是拉丁字母）", () => {
  const bad = Object.entries(load("en"))
    .filter(([k, v]) => !ENDONYMS.has(k) && forms(v).some((x) => CJK.test(x)))
    .map(([k, v]) => `${k}: ${forms(v).join(" | ")}`);
  assert.deepEqual(bad, []);
  // 豁免只给语言自称：值就是那种语言自己的写法
  const en = load("en");
  assert.deepEqual(
    [...ENDONYMS].map((k) => en[k]),
    ["简体中文", "繁體中文"],
  );
});

test("繁體目录里没有简体字：按 OpenCC 简→繁转一遍不该有变化（OpenCC 自己的两处误转除外）", () => {
  const s2t = OpenCC.Converter({ from: "cn", to: "tw" });
  // OpenCC 的已知误转：「只有 / 只差」的「只」转成「隻」；「台」（台湾正体通行写法）转成「臺」
  const tolerated = new Set(["只隻", "台臺"]);
  const bad: string[] = [];
  for (const [k, v] of Object.entries(load("zh-Hant")))
    for (const x of ENDONYMS.has(k) ? [] : forms(v)) {
      const y = s2t(x);
      if (y === x) continue;
      const diffs = [...x].map((c, i) => c + [...y][i]).filter((p) => p[0] !== p[1]);
      if (diffs.some((p) => !tolerated.has(p))) bad.push(`${k}: ${x} → ${y}`);
    }
  assert.deepEqual(bad, []);
});

test("术语按 GLOSSARY.md：繁體与 English 不出现被替换掉的写法", () => {
  // 繁體：术语表左列在台湾的规定写法之外、OpenCC 直转或大陆用语会带出来的写法
  const hantBanned = [
    "撤銷", // 撤销 → 復原
    "倉庫", // 仓库 → 儲存庫
    "網關", // 网关 → 閘道
    "閘道器",
    "密鑰", // 密钥 → 金鑰
    "後臺", // 后台服务 → 背景服務
    "後台",
    "界面", // 界面语言 → 介面語言
    "菜單", // 菜单栏 → 選單列
    "文件夾", // 文件夹 → 資料夾
    "設置", // 设置 → 設定
    "配置",
    "使用者級", // 用户级 → 使用者層級
    "寫進", // 写进 → 寫入
    "訪達", // 访达 → Finder
    "鏈接", // 链接 → 連結
    "軟件",
    "默認",
    "會話",
  ];
  // English：界面上不说的词（harness、矩阵、导入、同步……）与术语表换掉的说法
  const enBanned = [
    /\bharness/i,
    /\bmatrix\b/i,
    /universal store/i,
    /\bglobal\b/i,
    /\bimport/i,
    /(?<!auto-)\bsync\b/i, // 术语表规定 MCP 页入口写 Auto-sync
  ];
  const bad: string[] = [];
  for (const [k, v] of Object.entries(load("zh-Hant")))
    for (const w of hantBanned)
      if (forms(v).some((x) => x.includes(w))) bad.push(`zh-Hant ${k}: ${w}`);
  for (const [k, v] of Object.entries(load("en")))
    for (const re of enBanned) if (forms(v).some((x) => re.test(x))) bad.push(`en ${k}: ${re}`);
  assert.deepEqual(bad, []);
});
