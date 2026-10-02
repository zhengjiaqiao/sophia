// 文案目录的检查（spec 2026-09-30-language-and-theme R7、R8）：tests/i18n-catalog.test.ts 调这里的纯函数。
// 目录在 locales/<语言>/<区块>.json，键带区块前缀；值是整句（{name} 占位符），或按数量分的 {one, other}。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { scanSource } from "./lint-ui.mjs";

/// 一条文案里的占位符名（按数量分的几种写法合起来算）
export function placeholders(message) {
  const forms = typeof message === "string" ? [message] : Object.values(message);
  const names = new Set();
  for (const f of forms) for (const m of f.matchAll(/\{(\w+)\}/g)) names.add(m[1]);
  return [...names].sort();
}

/// 各语言目录互相对照：键一样多、每条的占位符一样、按数量变的英文有 one 与 other。
/// 以 base（简体）为准，返回问题清单，每条都点出键
export function compareCatalogs(byLang, base = "zh-Hans") {
  const out = [];
  const ref = byLang[base] ?? {};
  for (const [lang, cat] of Object.entries(byLang)) {
    if (lang === base) continue;
    for (const k of Object.keys(ref)) if (!(k in cat)) out.push(`${lang} 缺 ${k}`);
    for (const k of Object.keys(cat))
      if (!(k in ref)) out.push(`${lang} 多了 ${k}（${base} 没有）`);
    for (const [k, v] of Object.entries(cat)) {
      if (!(k in ref)) continue;
      const a = placeholders(ref[k]).join(", ");
      const b = placeholders(v).join(", ");
      if (a !== b) out.push(`${k} 的占位符不一致：${base} {${a}}，${lang} {${b}}`);
    }
  }
  // 按数量变的键（任何一种语言写成了对象）：英文要写全 one 与 other，其余语言至少有 other
  const plural = new Set(
    Object.values(byLang).flatMap((cat) =>
      Object.entries(cat)
        .filter(([, v]) => typeof v !== "string")
        .map(([k]) => k),
    ),
  );
  for (const k of [...plural].sort())
    for (const [lang, cat] of Object.entries(byLang)) {
      const v = cat[k];
      if (v === undefined) continue;
      if (typeof v === "string") {
        if (lang.startsWith("en")) out.push(`${k}：${lang} 按数量变，要写成 {one, other}`);
      } else if (!v.other) out.push(`${k}：${lang} 缺 other`);
      else if (lang.startsWith("en") && !v.one) out.push(`${k}：${lang} 缺 one`);
    }
  return out;
}

/// 读 locales/：{语言: {键: 文案}}，另报出区块前缀不对的键
export function loadLocales(root) {
  const dir = join(root, "locales");
  const byLang = {};
  const problems = [];
  const areas = {};
  for (const lang of readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory())) {
    byLang[lang] = {};
    areas[lang] = [];
    for (const f of readdirSync(join(dir, lang))
      .filter((f) => f.endsWith(".json"))
      .sort()) {
      const area = f.slice(0, -".json".length);
      areas[lang].push(area);
      const part = JSON.parse(readFileSync(join(dir, lang, f), "utf8"));
      for (const [k, v] of Object.entries(part)) {
        if (!k.startsWith(`${area}.`))
          problems.push(`locales/${lang}/${f} 里的 ${k} 不是 ${area}. 开头`);
        byLang[lang][k] = v;
      }
    }
  }
  return { byLang, areas, problems };
}

const FILE_EXT =
  /\.(json|md|toml|tsx?|rs|txt|lock|ya?ml|m?js|html|css|png|svg|jpe?g|sqlite|db|plist)$/;

/// 代码里引用到的键：字符串字面量恰好是「区块.名字」形式的就算（t("…")、键表里的值、JSON 里的 labelKey）
export function referencedKeys(root, areas) {
  const re = new RegExp(`^(?:${areas.join("|")})\\.[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*$`);
  const refs = { front: new Map(), back: new Map() };
  const note = (side, key, file) => {
    if (!re.test(key) || FILE_EXT.test(key)) return;
    if (!refs[side].has(key)) refs[side].set(key, file);
  };
  const walk = (p, acc = []) => {
    if (!existsSync(p)) return acc;
    if (statSync(p).isDirectory()) {
      for (const e of readdirSync(p))
        if (e !== "node_modules" && e !== "target") walk(join(p, e), acc);
    } else acc.push(p);
    return acc;
  };
  // 前端：字符串字面量都算（键表 `{add: "toast.verb.add"}` 的值也是引用），注释不算
  for (const f of walk(join(root, "src")).filter((f) =>
    [".ts", ".tsx", ".json"].includes(extname(f)),
  )) {
    const src = readFileSync(f, "utf8");
    let strings;
    if (f.endsWith(".json")) strings = [...src.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((m) => m[1]);
    else {
      const { code, strings: lits } = scanSource(src, relative(root, f));
      // 模板字符串 `${t("…")}` 里的调用不在字面量清单里（scanSource 只收 `${}` 之外的文字），另按调用找
      const calls = [...code.matchAll(/\b(?:t|tn|tRich|tSpaced)\(\s*["']([^"'\n]+)["']/g)].map(
        (m) => m[1],
      );
      strings = [...lits, ...calls];
    }
    for (const s of strings) note("front", s, relative(root, f));
  }
  // 后端：键只能经 t! / tn! 宏（或 i18n::t / i18n::tn）传，只认这几处；注释与测试块不算
  const rust = [
    ...readdirSync(join(root, "crates")).flatMap((c) => walk(join(root, "crates", c, "src"))),
    ...walk(join(root, "src-tauri/src")),
  ].filter((f) => f.endsWith(".rs") && !f.endsWith("tests.rs"));
  for (const f of rust)
    for (const k of rustKeyRefs(readFileSync(f, "utf8"))) note("back", k, relative(root, f));
  return refs;
}

/// 一个 Rust 文件经 t! / tn! 宏（或 i18n::t / i18n::tn）引用的键；注释与测试块里的不算
export function rustKeyRefs(src) {
  return [...rustCode(src).matchAll(/\b(?:t|tn)!\(\s*"([^"]+)"|\bi18n::tn?\(\s*"([^"]+)"/g)].map(
    (m) => m[1] ?? m[2],
  );
}

/// Rust 源码去掉注释与 `#[cfg(test)] mod x { … }` 块（字符串原样）
function rustCode(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src.startsWith("//", i)) {
      const e = src.indexOf("\n", i);
      i = e < 0 ? n : e;
    } else if (src.startsWith("/*", i)) {
      let depth = 1;
      let k = i + 2;
      while (k < n && depth) {
        if (src.startsWith("/*", k)) (depth++, (k += 2));
        else if (src.startsWith("*/", k)) (depth--, (k += 2));
        else k++;
      }
      i = k;
    } else if (src[i] === "'" && /^'(?:\\.[^']{0,8}|[^\\'])'/.test(src.slice(i, i + 12))) {
      // 字符字面量（'"' 不开字符串）；否则是生命周期
      const m = /^'(?:\\.[^']{0,8}|[^\\'])'/.exec(src.slice(i, i + 12));
      out += m[0];
      i += m[0].length;
    } else if (src[i] === '"') {
      let k = i + 1;
      while (k < n && src[k] !== '"') k += src[k] === "\\" ? 2 : 1;
      out += src.slice(i, k + 1);
      i = k + 1;
    } else out += src[i++];
  }
  for (;;) {
    const m = /#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/.exec(out);
    if (!m) return out;
    let depth = 1;
    let k = m.index + m[0].length;
    while (k < out.length && depth) {
      if (out[k] === "{") depth++;
      else if (out[k] === "}") depth--;
      k++;
    }
    out = out.slice(0, m.index) + out.slice(k);
  }
}

/// 按数量变的句子只许经 tn / tn! 取：值里带 `{count}` 的键用 `t` 取，英文就永远是单数那一种写法。
/// 返回 `文件: 键`（前端认 t( / tRich(，后端认 t!( / i18n::t(；注释与测试块不算）
export function countKeysViaT(root, catalog) {
  const withCount = new Set(
    Object.entries(catalog)
      .filter(([, v]) =>
        (typeof v === "string" ? [v] : Object.values(v)).some((x) => x.includes("{count}")),
      )
      .map(([k]) => k),
  );
  const out = [];
  const walk = (p, acc = []) => {
    if (!existsSync(p)) return acc;
    if (statSync(p).isDirectory()) {
      for (const e of readdirSync(p))
        if (e !== "node_modules" && e !== "target") walk(join(p, e), acc);
    } else acc.push(p);
    return acc;
  };
  for (const f of walk(join(root, "src")).filter((f) => /\.tsx?$/.test(f))) {
    const { code } = scanSource(readFileSync(f, "utf8"), relative(root, f));
    for (const m of code.matchAll(/\b(?:t|tRich|tSpaced)\(\s*["']([^"'\n]+)["']/g))
      if (withCount.has(m[1])) out.push(`${relative(root, f)}: ${m[1]}`);
  }
  const rust = [
    ...readdirSync(join(root, "crates")).flatMap((c) => walk(join(root, "crates", c, "src"))),
    ...walk(join(root, "src-tauri/src")),
  ].filter((f) => f.endsWith(".rs") && !f.endsWith("tests.rs"));
  for (const f of rust)
    for (const m of rustCode(readFileSync(f, "utf8")).matchAll(
      /\bt!\(\s*"([^"]+)"|\bi18n::t\(\s*"([^"]+)"/g,
    )) {
      const k = m[1] ?? m[2];
      if (withCount.has(k)) out.push(`${relative(root, f)}: ${k}`);
    }
  return out;
}
