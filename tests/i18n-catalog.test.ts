/// 文案目录的一致性（spec 2026-09-30-language-and-theme R7、R8，AC9）：
/// 各语言的键与占位符对得上、区块文件只放自己前缀的键、前后端读的区块清单与目录一致、
/// 代码里引用的键都在目录里、目录里的键都有人用
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  compareCatalogs,
  countKeysViaT,
  loadLocales,
  looseNames,
  referencedKeys,
  rustKeyRefs,
} from "../scripts/i18n-catalog.mjs";
import { AREAS } from "../src/i18n/catalog.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("AC9：某种语言少了键、多了键，或同一条的占位符对不上，都报出是哪个键", () => {
  const problems = compareCatalogs({
    "zh-Hans": { "skills.a": "加到 {agent}", "skills.b": "{n} 个", "skills.c": "好" },
    en: { "skills.a": "Add to {name}", "skills.b": "{n} items", "skills.d": "extra" },
    "zh-Hant": { "skills.a": "加到 {agent}", "skills.b": "{n} 個", "skills.c": "好" },
  });
  assert.deepEqual(problems, [
    "en 缺 skills.c",
    "en 多了 skills.d（zh-Hans 没有）",
    "skills.a 的占位符不一致：zh-Hans {agent}，en {name}",
  ]);
});

test("AC9：按数量变的键，英文要写全 one 与 other；中文写字符串或只写 other 都行；各种写法的占位符合起来比", () => {
  assert.deepEqual(
    compareCatalogs({
      "zh-Hans": { "usage.m": "{count} 分钟前", "usage.n": { other: "{count} 个" } },
      en: { "usage.m": { one: "1 min ago", other: "{count} min ago" }, "usage.n": "{count} items" },
    }),
    ["usage.n：en 按数量变，要写成 {one, other}"],
  );
  assert.deepEqual(
    compareCatalogs({
      "zh-Hans": { "usage.m": "{count} 分钟前" },
      en: { "usage.m": { other: "{count} min ago" } },
    }),
    ["usage.m：en 缺 one"],
  );
  assert.deepEqual(
    compareCatalogs({
      "zh-Hans": { "usage.m": "{count} 分钟前" },
      en: { "usage.m": { one: "a minute ago", other: "{count} min ago" } },
    }),
    [],
  );
});

test("真目录：各语言互相对得上，区块文件只放自己前缀的键", () => {
  const { byLang, problems } = loadLocales(root);
  assert.deepEqual(problems, []);
  assert.deepEqual(compareCatalogs(byLang), []);
});

test("中文句子里嵌名字的占位符与汉字紧贴：名字以汉字收尾时，写了空格就多出一格（「Claude 桌面应用 的模型」）", () => {
  assert.deepEqual(
    looseNames({
      "models.a": "重启 {agent} 后生效",
      "models.b": "重启{agent}后生效",
      "models.c": { other: "{names} 等 {count} 个" },
      "models.d": "{count} 个 · 从 {service} 读到一半断了",
      "mcp.differ.message": "{locations}各有一份 {service}，连的地址不一样",
      "models.app.deleteFileFailed": "删除 {name} 失败",
      "models.e": "Restart {agent} to apply",
    }),
    ["mcp.differ.message {service}", "models.a {agent}", "models.c {names}"],
  );
});

test("真目录：中文句子里嵌名字的占位符都写成紧贴的（空格由 formatMessage / i18n::format 补）", () => {
  const { byLang } = loadLocales(root);
  for (const lang of ["zh-Hans", "zh-Hant"]) assert.deepEqual(looseNames(byLang[lang]), [], lang);
});

test("三种语言的区块文件一样；前后端读的区块清单与目录一致；weiboap 只归后端、只在 feature 下编入", () => {
  const LANGS = ["zh-Hans", "zh-Hant", "en"];
  const filesOf = (lang: string) =>
    readdirSync(new URL(`../locales/${lang}/`, import.meta.url))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
  const files = filesOf("zh-Hans");
  for (const lang of LANGS) assert.deepEqual(filesOf(lang), files, `locales/${lang}/ 的区块文件`);
  const shared = files.filter((f) => f !== "weiboap");
  assert.deepEqual([...AREAS].sort(), shared, "src/i18n/catalog.ts 的 AREAS");
  const front = read("src/i18n/catalog.ts");
  const rs = read("crates/core/src/i18n.rs");
  const rustAreas: Record<string, string> = {
    "zh-Hans": "AREAS_ZH_HANS",
    "zh-Hant": "AREAS_ZH_HANT",
    en: "AREAS_EN",
  };
  for (const lang of LANGS) {
    const esc = lang.replace("-", "\\-");
    assert.deepEqual(
      [...front.matchAll(new RegExp(`locales/${esc}/(\\w+)\\.json`, "g"))].map((m) => m[1]).sort(),
      shared,
      `src/i18n/catalog.ts 的 ${lang} import`,
    );
    const at = rs.indexOf(`const ${rustAreas[lang]}`);
    assert.ok(at >= 0, `crates/core/src/i18n.rs 没有 ${rustAreas[lang]}`);
    const block = rs.slice(at, rs.indexOf("];", at));
    assert.deepEqual(
      [...block.matchAll(new RegExp(`locales/${esc}/(\\w+)\\.json`, "g"))].map((m) => m[1]).sort(),
      shared,
      `crates/core/src/i18n.rs 的 ${rustAreas[lang]}`,
    );
  }
  // weiboap：三种语言各一份，整块只在 feature 下编入；别处不 include 它
  const weibo = rs.match(
    /#\[cfg\(feature = "weiboap"\)\]\nconst WEIBOAP: \[&str; 3\] = \[\n([^\]]*)\];/,
  );
  assert.ok(weibo, "crates/core/src/i18n.rs 的 WEIBOAP 要整块挂在 weiboap feature 下");
  assert.deepEqual(
    [...weibo[1].matchAll(/locales\/([\w-]+)\/weiboap\.json/g)].map((m) => m[1]),
    LANGS,
  );
  assert.equal([...rs.matchAll(/weiboap\.json/g)].length, LANGS.length);
});

test("Rust 里的键引用：只认 t! / tn! 宏与 i18n::t；注释、测试块不算；字符字面量 '\"' 与生命周期不打乱字符串配对", () => {
  const src = [
    `let q = '"'; let s = t!("usage.a", n = 1);`,
    "fn f<'a>(x: &'a str) {} // t!(\"usage.comment\")",
    '/* tn!("usage.block", 1) */',
    "#[cfg(test)]",
    'mod tests { fn x() { let _ = t!("usage.test"); } }',
    'let z = tn!("usage.b", 2); let w = i18n::t("usage.c", &[]);',
    'let path = "settings.json.tmp";',
  ].join("\n");
  assert.deepEqual(rustKeyRefs(src), ["usage.a", "usage.b", "usage.c"]);
});

test("代码里引用的键都在目录里，目录里的键都有人用；前端不引用 weiboap 的键", () => {
  const { byLang, areas } = loadLocales(root);
  const catalog = byLang["zh-Hans"];
  const refs = referencedKeys(root, areas["zh-Hans"]);
  const missing = [...refs.front, ...refs.back]
    .filter(([k]) => !(k in catalog))
    .map(([k, f]) => `${f}: ${k}`);
  assert.deepEqual(missing, [], "引用了目录里没有的键");
  const unused = Object.keys(catalog).filter((k) => !refs.front.has(k) && !refs.back.has(k));
  assert.deepEqual(unused, [], "目录里没人用的键");
  const weiboInFront = [...refs.front]
    .filter(([k]) => k.startsWith("weiboap."))
    .map(([k, f]) => `${f}: ${k}`);
  assert.deepEqual(weiboInFront, [], "前端引用了只归内部版后端的键");
});

test("src 里的 JSON 数据不写界面文案（写目录键）", () => {
  const walk = (dir: URL): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(new URL(`${e.name}/`, dir))
        : e.name.endsWith(".json")
          ? [new URL(e.name, dir).pathname]
          : [],
    );
  const bad = walk(new URL("../src/", import.meta.url))
    .map((p) => p.slice(root.length))
    .filter((p) => /[　-〿一-鿿＀-￯]/.test(read(p)));
  assert.deepEqual(bad, []);
});

test('前端键引用：模板字符串里的 `${t("…")}` 也算', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "i18n-refs-")));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "crates"));
  writeFileSync(
    join(dir, "src/x.ts"),
    'const a = `${t("usage.a")} · ${tn("usage.b", 2)}`;\n// t("usage.comment")\n',
  );
  const refs = referencedKeys(dir, ["usage"]);
  assert.deepEqual([...refs.front.keys()].sort(), ["usage.a", "usage.b"]);
});

test("按数量变的句子（值里带 {count}）只经 tn / tn! 取：用 t 取，英文就永远是单数", () => {
  const { byLang } = loadLocales(root);
  assert.deepEqual(countKeysViaT(root, byLang["zh-Hans"]), []);
});
