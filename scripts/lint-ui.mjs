#!/usr/bin/env node
// 界面规范检查：把 docs/DESIGN.md 的硬性约束变成可执行的断言。
// 画稿版在 .superpowers/design/lint-artboards.mjs，规则同源。
// 用法：node scripts/lint-ui.mjs [文件或目录...]，不传则检查 src/。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, relative } from "node:path";

/// 唯一的色值来源；tokens.css 之外的地方不许出现字面色值
const TOKENS = new Set([
  "#ffffff", "#000000", "#f2f2f2", "#e2e2e2", "#c8c8c8", "#9a9a9a", "#5a5a5a",
]);
const FONTS = ["Barlow Condensed", "Barlow", "IBM Plex Mono"];
/// 动作与输入 2px、片与开关 32px、圆点 50%，其余 0（DESIGN「Shapes」）
const RADII = new Set(["0", "0px", "2px", "32px", "50%"]);
/// 只有这个文件可以写字面色值
const TOKEN_FILE = "src/tokens.css";

/// 旧代码的豁免名单。每个任务改完自己的文件就从这里划掉；
/// T10 收口时这个数组必须是空的。不许用通配符——必须逐个文件列出，
/// 否则新写的文件会悄悄落进豁免里。
const LEGACY = [];


const rules = [
  {
    id: "color",
    desc: "§1.1 色值只来自 tokens.css 的变量",
    run(src, path) {
      const out = [];
      const isTokenFile = path === TOKEN_FILE;
      for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        const v = m[0].toLowerCase();
        const expanded = v.length === 4 ? "#" + [...v.slice(1)].map((c) => c + c).join("") : v;
        if (!TOKENS.has(expanded)) out.push(`${m[0]} 不是 token 色`);
        else if (!isTokenFile) out.push(`${m[0]} 是 token 色，但只有 ${TOKEN_FILE} 能写字面值，别处用 var(--…)`);
      }
      return [...new Set(out)];
    },
  },
  {
    id: "no-color-fn",
    desc: "§1.1 零色彩：不出现 oklch / rgb / hsl / 具名色",
    run(src) {
      const out = [];
      for (const m of src.matchAll(/\b(oklch|rgba?|hsla?|color-mix)\s*\(/g)) out.push(m[1]);
      for (const m of src.matchAll(/(?:color|background(?:Color)?|background-color|borderColor|border-color|stroke|fill)\s*[:=]\s*["']?([a-z]{3,20})["']?\s*[;,"'}]/gi)) {
        const w = m[1].toLowerCase();
        if (["none", "transparent", "inherit", "currentcolor", "initial", "unset"].includes(w)) continue;
        out.push(`${m[1]}（具名色，用 token 变量）`);
      }
      return [...new Set(out)];
    },
  },
  {
    id: "elevation",
    desc: "§1.3 零阴影零渐变",
    run(src) {
      const out = [];
      if (/box-?[Ss]hadow\s*[:=]\s*["']?(?!none)/.test(src)) out.push("box-shadow");
      if (/text-?[Ss]hadow\s*[:=]\s*["']?(?!none)/.test(src)) out.push("text-shadow");
      if (/\b(?:linear|radial|conic)-gradient\s*\(/.test(src)) out.push("gradient");
      if (/filter\s*[:=]\s*["']?[^;"'}]*blur/.test(src)) out.push("blur");
      return out;
    },
  },
  {
    id: "radius",
    desc: "§1.3 圆角只有 4px（输入框）/ 32px（pill）/ 50%（圆点）",
    run(src) {
      const out = [];
      for (const m of src.matchAll(/border-?[Rr]adius\s*[:=]\s*["']?([^;"'}\n]+)/g)) {
        const v = m[1].trim().replace(/["']$/, "");
        if (v.startsWith("var(")) continue;
        if (!v.split(/\s+/).every((p) => RADII.has(p))) out.push(v);
      }
      return [...new Set(out)];
    },
  },
  {
    id: "font",
    desc: "§1.2 只用三个字族，且 CJK 回退栈要写全",
    run(src, path) {
      const out = [];
      // 两处曾经让这条规则空转：①只认 font-family，而 token 写作 --font-ui
      // ②捕获组在第一个引号处截断，`Barlow, "PingFang SC"` 只捕到 `Barlow, `，
      // 于是正确写法反而被判违规、缺 CJK 回退的反而放过。
      for (const m of src.matchAll(/(?:font-?[Ff]amily|--font-[a-z-]+)\s*[:=]\s*([^;}\n]+)/g)) {
        const decl = m[1].trim().replace(/^["']|["']$/g, "");
        if (decl.startsWith("var(")) continue;
        const head = decl.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
        if (!FONTS.includes(head) && !["monospace", "inherit", "ui-monospace"].includes(head)) {
          out.push(`${head}（不在三个字族里）`);
        } else if (path === TOKEN_FILE && !/PingFang|YaHei/.test(decl)) {
          // §1.2.1：三个字族都没有中文字形，CJK 回退必须显式写出来
          out.push(`${head} 的回退栈缺 CJK（见 §1.2.1）`);
        }
      }
      return [...new Set(out)];
    },
  },
  {
    id: "term",
    desc: "§13 文案层不出现 harness",
    run(src) {
      return visibleText(src).match(/harness/i) ? ["可见文案里出现了 harness"] : [];
    },
  },
  {
    id: "mechanism-words",
    desc: "§4.5 说结果不说机制",
    run(src) {
      const text = visibleText(src);
      const bad = ["操作失败", "执行失败", "出错了", "未知错误", "调用失败", "请重试", "没有需要建立的链接"];
      return bad.filter((w) => text.includes(w));
    },
  },
  {
    id: "old-terms",
    // 用用户的语言（原则 ⑤）：「导入 / 引入」统一成「添加」，「矩阵」说「列表」，
    // 「本体」说「原件」，「撞名」说「同名」，「整目录链走 / 链走」说「整个文件夹是链接」。
    // 画板那边是 lint-artboards.mjs 的同名规则，这里拦代码里的回潮
    desc: "术语：可见文案不说 导入 / 引入 / 矩阵 / 本体 / 撞名 / 整目录链走 / 链走",
    run(src, path) {
      const text = visibleText(src);
      return ["导入", "引入", "矩阵", "本体", "撞名", "整目录链走", "链走"].filter((w) => text.includes(w));
    },
  },
  {
    id: "size-14",
    // 字号只有 28 / 20 / 15 / 13 / 12：14 与 15、13 与 12 眼睛分不出来，已砍掉
    desc: "字号只有 28 / 20 / 15 / 13 / 12，不出现 14px",
    run(src) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
      const n = (code.match(/font-size\s*:\s*14px|fontSize\s*:\s*["']?14(?:px)?["']?\s*[,}]/g) || []).length;
      return n ? [`${n} 处 14px 字号`] : [];
    },
  },
  {
    id: "framed-tag",
    // 有框的都能点：不可点的标签是纯文字（强 ink 600 / 弱 ink-faint 400），
    // 旧方标签的写法是 padding 1px 6px + 1px 描边，同一条规则块里两样都有就报
    desc: "有框的都能点：不可点的标签不带框（旧方标签 padding 1px 6px + border）",
    run(src, path) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, " ");
      const out = [];
      for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = m[2];
        if (/padding\s*:\s*1px 6px/.test(body) && /border\s*:\s*1px (?!none)/.test(body)) out.push(m[1].trim());
      }
      return out;
    },
  },
  {
    id: "mcp-no-sync",
    // 「同步」是双向词。MCP 页只新增、从不覆盖也不删除，用它会骗人
    // （docs/specs/2026-09-21-ui-rebuild-mcp.md 的 R3 / AC7）。
    // 只管 MCP 那几个文件：skill 页的「自动同步」是名副其实的双向维护，不受此限
    desc: "MCP 页的文案不出现「同步」（R3）",
    run(src, path) {
      const mcp = /^src\/[Mm]cp[A-Za-z]*\.(tsx|ts|css)$/.test(path) || /^src\/pages\/McpImportPage\./.test(path);
      if (!mcp) return [];
      return visibleText(src).includes("同步") ? ["MCP 页的可见文案里出现了「同步」"] : [];
    },
  },
];

/// 取可见文案：JSX 文本节点与字符串字面量，**只留含中文的**。
///
/// 两条理由：①CLAUDE.md 约定「注释与 UI 文案中文，标识符英文」，所以含中文
/// 就是文案、不含就是标识符；②不这么滤的话，`invoke<Harness[]>("list_harnesses")`
/// 这种命令名和泛型会被当成文案报出来——而 §13 明确说代码标识符保持 harness。
/// 注释里的词也不算违规，那是给读代码的人看的。
function visibleText(src) {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const strings = [...noComments.matchAll(/"([^"\\\n]{2,})"|'([^'\\\n]{2,})'|`([^`\\]{2,})`/g)]
    .map((m) => m[1] ?? m[2] ?? m[3]);
  // JSX 文本节点：`[^<>{}]` 不排除换行，所以跨行的整块也能取到。
  // 曾经这里带着 \n，于是 `>\n  操作失败\n<` 这种被整段漏掉——
  // 三条文案规则（term / mechanism-words / mcp-no-sync）一起失效，
  // 而漏检是静默的：lint 报零违规，人就以为过了。
  const jsxText = [...noComments.matchAll(/>([^<>{}]{2,}?)</gs)].map((m) => m[1]);
  return [...strings, ...jsxText].filter((t) => /[一-鿿]/.test(t)).join("\n");
}

function walk(p, acc = []) {
  if (statSync(p).isDirectory()) {
    for (const e of readdirSync(p)) walk(join(p, e), acc);
  } else if ([".tsx", ".ts", ".css"].includes(extname(p)) && !p.endsWith(".d.ts")) {
    acc.push(p);
  }
  return acc;
}

const args = process.argv.slice(2);
const roots = args.length ? args : ["src"];
const files = roots.flatMap((r) => (existsSync(r) ? walk(r) : []));

let errs = 0;
let skipped = 0;
for (const f of files.sort()) {
  const path = relative(process.cwd(), f);
  if (LEGACY.includes(path)) {
    skipped++;
    continue;
  }
  const src = readFileSync(f, "utf8");
  const hits = rules.map((r) => [r, r.run(src, path)]).filter(([, v]) => v.length);
  if (hits.length === 0) continue;
  console.log(`\x1b[33m•\x1b[0m ${path}`);
  for (const [r, v] of hits) {
    errs += v.length;
    console.log(`   \x1b[31m✗\x1b[0m ${r.id}  ${r.desc}`);
    for (const x of v) console.log(`       ${x}`);
  }
}

const checked = files.length - skipped;
if (errs === 0) console.log(`\x1b[32m✓\x1b[0m 界面规范：${checked} 个文件零违规${skipped ? `（${skipped} 个旧文件暂时豁免）` : ""}`);
else console.log(`\n${errs} 个违规，检查了 ${checked} 个文件${skipped ? `，豁免 ${skipped} 个` : ""}`);

if (skipped > 0 && args.length === 0) {
  console.log(`\x1b[33m!\x1b[0m 豁免名单还剩 ${skipped} 个文件，T10 收口时必须清空：\n   ${LEGACY.join("\n   ")}`);
}
process.exit(errs ? 1 : 0);
