#!/usr/bin/env node
// 界面规范检查：把 docs/DESIGN.md 的硬性约束变成可执行的断言。
// 画稿版在 .superpowers/design/lint-artboards.mjs，规则同源。
// 用法：node scripts/lint-ui.mjs [文件或目录...]，不传则检查 src/。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, relative } from "node:path";

/// 唯一的色值来源（V4 的 14 个色 token；ink-edge 随 2026-09-24 物性删除）；tokens.css 之外的地方不许出现字面色值，
/// tokens.css 里也不许出现这之外的值（旧的 #222222 #f2f2f2 #c8c8c8 一写就报）
const TOKENS = new Set([
  "#f4f4f2", // shell
  "#fcfcfb", // face
  "#ffffff", // paper
  "#f2f2ef", // recess
  "#efefec", // surface
  "#e3e3df", // hairline
  "#ededea", // row-line
  "#d4d4cf", // ctl-border
  "#bdbdb7", // ctl-edge
  "#dcdcd7", // track
  "#1c1c1a", // ink
  "#4e4e4a", // ink-mute
  "#6f6f6a", // ink-faint
  "#e0652a", // accent
]);
/// Barlow + Barlow Condensed + 苹方，等宽只给 id（DESIGN「Typography › 字族」，2026-09-24 回到原设计）
const FONTS = ["Barlow", "Barlow Condensed", "IBM Plex Mono"];
/// 圆角随尺寸（DESIGN「Shapes」）：刻线 1、记号与滑块 4、开关槽 5、控件 7、页签槽 10、
/// 面与浮层 12、胶囊 999、圆点 50%，平铺结构 0。2px（旧刻条）、3px、6px、8px、32px 都是旧值
const RADII = new Set(["0", "0px", "1px", "4px", "5px", "7px", "10px", "12px", "999px", "50%"]);
/// 层次 token（DESIGN「Elevation & Depth」）：投影只说离机面多高，四档——凹（recess-*）/ 平（无）/
/// 抬起（raise*，只给键、页签滑块、开关滑块）/ 浮（elev-float）。box-shadow 只能是它们、或它们用逗号连起来
const ELEVATIONS = new Set([
  "var(--recess-input)",
  "var(--recess-tabs)",
  "var(--recess-track)",
  "var(--raise)",
  "var(--raise-hover)",
  "var(--raise-pressed)",
  "var(--raise-ink)",
  "var(--raise-ink-pressed)",
  "var(--elev-float)",
]);
/// 功能性渐变只能从底色过渡到透明（滚动边缘渐隐），不做装饰：机面上从 face，
/// 纸浮层（下拉、选择器）里从 paper，侧栏里从 shell（`+ 项目` 吸底时的上沿）
const FADE_STOPS = new Set(["var(--face)", "var(--paper)", "var(--shell)", "transparent"]);

/// tokens.css 里层次 token 与指示点灯罩色的定义行：只有这几行可以出现 rgba 字面值
const ELEV_DEF =
  /^\s*--(?:elev-float|recess-(?:input|tabs|track)|raise(?:-hover|-pressed|-ink|-ink-pressed)?|accent-halo)\s*:.*$/gm;

/// 指示点的灯罩环（DESIGN「开关 › 指示点」）：一圈 2px 同色 14% 的平色环。
/// 它不是层次（不说离机面多高），只许出现在指示点的规则里
const HALO = "0 0 0 2px var(--accent-halo)";
const HALO_SELECTOR = /\.ss-indicator/;

/// 大写与正字距只经 Cap（DESIGN「字距：汉字永远 0」）：只有这些选择器里能写
/// text-transform: uppercase、非 0 letter-spacing、var(--track-*)
const CAP_SELECTOR = /\.ss-cap\b/;

/// 橙只表示「开着 / 在生效」，形态只有两种：开关刻线与指示点（裁决「橙的两种形态」）
const ACCENT_SELECTOR = /\.ss-switch|\.ss-indicator/;

/// 按顶层逗号切参数（括号里的逗号不算）
function splitTop(args) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of args) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

/// 一个 linear-gradient(...) 的参数是不是只有「方向 + 底色 / 透明 + 位置」
function isEdgeFade(args) {
  const parts = splitTop(args);
  const stops = parts.filter((p) => !/^(to\s|-?[\d.]+(deg|turn|rad)$)/.test(p));
  return (
    stops.length >= 2 &&
    stops.every((p) => {
      const color = p.replace(/\s+(-?[\d.]+(px|%)?|var\(--fade-edge\)|calc\([^)]*\))$/, "").trim();
      return FADE_STOPS.has(color);
    })
  );
}
/// 只有这个文件可以写字面色值
const TOKEN_FILE = "src/tokens.css";

/// 旧代码的豁免名单。每个任务改完自己的文件就从这里划掉；
/// T10 收口时这个数组必须是空的。不许用通配符——必须逐个文件列出，
/// 否则新写的文件会悄悄落进豁免里。
const LEGACY = [];

/// D24 旧词表（DESIGN「文案语域」的「旧」一列，外加同一轮走查改掉的说法）
const OLD_WORDS = [
  "写不进",
  "搬不过去",
  "连不上",
  "出来了",
  "探明",
  "顺手",
  "换一把",
  "拿主意",
  "没法",
  "来源管理页",
  "同名被挡",
  "密钥不对",
  "回滚也没成",
  "删了找不回来",
  "管理网关",
];

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
        else if (!isTokenFile)
          out.push(`${m[0]} 是 token 色，但只有 ${TOKEN_FILE} 能写字面值，别处用 var(--…)`);
      }
      return [...new Set(out)];
    },
  },
  {
    id: "no-color-fn",
    desc: "§1.1 色只来自 token：不出现 oklch / rgb / hsl / 具名色（tokens.css 的层次 token 除外）",
    run(src, path) {
      const out = [];
      const body = path === TOKEN_FILE ? src.replace(ELEV_DEF, "") : src;
      for (const m of body.matchAll(/\b(oklch|rgba?|hsla?|color-mix)\s*\(/g)) out.push(m[1]);
      for (const m of src.matchAll(
        /(?:color|background(?:Color)?|background-color|borderColor|border-color|stroke|fill)\s*[:=]\s*["']?([a-z]{3,20})["']?\s*[;,"'}]/gi,
      )) {
        const w = m[1].toLowerCase();
        if (["none", "transparent", "inherit", "currentcolor", "initial", "unset"].includes(w))
          continue;
        out.push(`${m[1]}（具名色，用 token 变量）`);
      }
      return [...new Set(out)];
    },
  },
  {
    id: "elevation",
    desc: "层次只用 token：凹 --recess-*、抬起 --raise*、浮 --elev-float（指示点的灯罩环除外）；渐变只做滚动边缘渐隐",
    run(src) {
      const out = [];
      // 灯罩环只在指示点的规则块里放行：先认出这些块里的那一句，其余地方照常查
      const code = src.replace(/\/\*[\s\S]*?\*\//g, " ");
      let haloOk = 0;
      for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!m[2].includes(HALO)) continue;
        const selectors = m[1].split(",").map((x) => x.trim());
        if (selectors.every((sel) => HALO_SELECTOR.test(sel))) haloOk++;
      }
      for (const m of src.matchAll(/box-?[Ss]hadow\s*[:=]\s*["']?([^;"'}\n]+)/g)) {
        const v = m[1].trim();
        if (v === "none") continue;
        if (v === HALO && haloOk > 0) {
          haloOk--;
          continue;
        }
        if (!splitTop(v).every((p) => ELEVATIONS.has(p))) out.push(`box-shadow: ${v}`);
      }
      if (/text-?[Ss]hadow\s*[:=]\s*["']?(?!none)/.test(src)) out.push("text-shadow");
      if (/\b(?:radial|conic|repeating-linear)-gradient\s*\(/.test(src)) out.push("装饰性渐变");
      for (const m of src.matchAll(/\blinear-gradient\s*\(((?:[^()]|\([^()]*\))*)\)/g)) {
        if (!isEdgeFade(m[1]))
          out.push(`linear-gradient(${m[1]})（只允许 face / paper → transparent 的边缘渐隐）`);
      }
      if (/filter\s*[:=]\s*["']?[^;"'}]*blur/.test(src)) out.push("blur");
      return out;
    },
  },
  {
    id: "radius",
    desc: "圆角只有 0 / 1 / 4 / 5 / 7 / 10 / 12 / 999px / 50% 或 var(--radius-*)",
    run(src) {
      const out = [];
      for (const m of src.matchAll(/border-?[Rr]adius\s*[:=]\s*["']?([^;"'}\n]+)/g)) {
        const v = m[1].trim().replace(/["']$/, "");
        if (/^var\(--radius-[a-z-]+\)$/.test(v)) continue;
        if (!v.split(/\s+/).every((p) => RADII.has(p))) out.push(v);
      }
      return [...new Set(out)];
    },
  },
  {
    id: "font",
    desc: "只用 Barlow / Barlow Condensed / IBM Plex Mono 三个字族，且 CJK 回退栈要写全",
    run(src, path) {
      const out = [];
      // 两处曾经让这条规则空转：①只认 font-family，而 token 写作 --font-ui
      // ②捕获组在第一个引号处截断，`Barlow, "PingFang SC"` 只捕到 `Barlow, `，
      // 于是正确写法反而被判违规、缺 CJK 回退的反而放过。
      for (const m of src.matchAll(/(?:font-?[Ff]amily|--font-[a-z-]+)\s*[:=]\s*([^;}\n]+)/g)) {
        const decl = m[1].trim().replace(/^["']|["']$/g, "");
        if (decl.startsWith("var(")) continue;
        const head = decl
          .split(",")[0]
          .trim()
          .replace(/^['"]|['"]$/g, "");
        if (!FONTS.includes(head) && !["monospace", "inherit", "ui-monospace"].includes(head)) {
          out.push(`${head}（不在 Barlow / Barlow Condensed / IBM Plex Mono 里）`);
        } else if (path === TOKEN_FILE && !/PingFang|YaHei/.test(decl)) {
          // 三个字族都没有中文字形，CJK 回退必须显式写出来
          out.push(`${head} 的回退栈缺 CJK（PingFang SC）`);
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
      const bad = [
        "操作失败",
        "执行失败",
        "出错了",
        "未知错误",
        "调用失败",
        "请重试",
        "没有需要建立的链接",
      ];
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
      return ["导入", "引入", "矩阵", "本体", "撞名", "整目录链走", "链走"].filter((w) =>
        text.includes(w),
      );
    },
  },
  {
    id: "verb-direction",
    // skill 与 agent 的关系用带方向的动词（DESIGN 冲突表「⑥⑧：skill 与 agent 的关系用什么动词」）：
    // 「开启 Claude Code」「关闭 Codex」会被读成操作应用本身，写「加到 X」「从 X 移除」
    desc: "动词：可见文案里「开启 / 关闭 / 已开启 / 未开启」不紧跟 agent 名或图标",
    run(src) {
      const text = visibleText(src);
      const agent =
        "(?:✳|⎔|Claude|Codex|Cursor|Cline|Gemini|GitHub|Copilot|Amp|Droid|WeiboAP|Windsurf|CLAUDE|CODEX|CURSOR|CLINE)";
      const hits = text.match(new RegExp(`(?:开启|关闭)\\s*${agent}`, "g")) || [];
      if (/[已未]开启/.test(text)) hits.push("已开启 / 未开启（改说 已加上 / 未加上）");
      return [...new Set(hits)];
    },
  },
  {
    id: "single-char-action",
    // 按钮与文字链不用单字（「改」读起来像半句话，写「编辑」）。图标键以提示框文字计
    desc: "动作：按钮 / 文字链的可见文字、图标键的 title 不是单个汉字",
    run(src) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
      const out = [];
      for (const m of code.matchAll(
        /<(Button|IconButton|button|a)\b[^>]*>\s*([\u4e00-\u9fff])\s*<\/\1>/g,
      ))
        out.push(`<${m[1]}>${m[2]}`);
      for (const m of code.matchAll(
        /<(?:IconButton|Button)\b[^>]*\btitle=["']([\u4e00-\u9fff])["']/g,
      ))
        out.push(`title=${m[1]}`);
      return [...new Set(out)];
    },
  },
  {
    id: "size-14",
    // 字号只有六档 28 / 20 / 16 / 15 / 13 / 12：14 与 15 眼睛分不出来，已砍掉
    desc: "字号只有 28 / 20 / 16 / 15 / 13 / 12，不出现 14px",
    run(src) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
      const n = (
        code.match(/font-size\s*:\s*14px|fontSize\s*:\s*["']?14(?:px)?["']?\s*[,}]/g) || []
      ).length;
      return n ? [`${n} 处 14px 字号`] : [];
    },
  },
  {
    id: "framed-tag",
    // 有框的都能点：不可点的标签是纯文字（强 ink 600 / 弱 ink-mute 400），
    // 旧方标签的写法是 padding 1px 6px + 1px 描边，同一条规则块里两样都有就报
    desc: "有框的都能点：不可点的标签不带框（旧方标签 padding 1px 6px + border）",
    run(src, path) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, " ");
      const out = [];
      for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = m[2];
        if (/padding\s*:\s*1px 6px/.test(body) && /border\s*:\s*1px (?!none)/.test(body))
          out.push(m[1].trim());
      }
      return out;
    },
  },
  {
    id: "accent-scope",
    // 橙的含义只有一个「开着 / 在生效」，形态只有开关刻条与指示点两种。
    // 用在按钮、文字、焦点环、选中、格点、图标上都是第二种意思（⑤）
    desc: "橙：var(--accent) 只出现在开关（.ss-switch…）与指示点（.ss-indicator，侧栏 agent 名后）的规则里；灯罩色 var(--accent-halo) 只在指示点上",
    run(src, path) {
      if (!/var\(--accent(?:-halo)?\)/.test(src)) return [];
      if (!path.endsWith(".css"))
        return [
          "组件代码里直接用了 var(--accent) / var(--accent-halo)（用 <Switch> / <Indicator>）",
        ];
      const code = src.replace(/\/\*[\s\S]*?\*\//g, " ");
      const out = [];
      for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const accent = m[2].includes("var(--accent)");
        const halo = m[2].includes("var(--accent-halo)");
        if (!accent && !halo) continue;
        const selectors = m[1].split(",").map((x) => x.trim());
        for (const sel of selectors) {
          if (accent && !ACCENT_SELECTOR.test(sel)) out.push(sel);
          else if (halo && !HALO_SELECTOR.test(sel)) out.push(`${sel}（灯罩色只给指示点）`);
        }
      }
      return out;
    },
  },
  {
    id: "no-web-link",
    // DESIGN「光标与文字选取」「按钮」：全应用一律箭头光标、没有下划线——手形与下划线是网页超链接的语言，
    // 离开 Sophia 只由浅键末尾的 ↗ 说（2026-09-25 外链并入浅键）
    desc: "光标与下划线：不出现 cursor: pointer、text-decoration: underline（含 JSX 的 style 写法）",
    run(src) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
      const out = [];
      const pointer = (code.match(/cursor\s*:\s*["']?pointer\b/g) || []).length;
      if (pointer) out.push(`${pointer} 处 cursor: pointer（一律箭头）`);
      const underline = (
        code.match(/text-?[Dd]ecoration(?:-line|Line)?\s*:\s*["']?[^;"'}\n]*\bunderline\b/g) || []
      ).length;
      if (underline) out.push(`${underline} 处下划线（离开 Sophia 由浅键的 ↗ 说）`);
      return out;
    },
  },
  {
    id: "no-retired-ui",
    // 阶段 3 收口（2026-09-25）：外链变体 `external` 并入浅键后已删；浅键只经 <Button variant="quiet"> 画
    // （组件自动带 ↗），页面里不直写 `ss-btn--quiet` 类名；`▸ / ▾` 展开记号（Disclosure）换成了抽屉拉手；
    // 界面上的 ✓ 一律是 IconTick 图形，文案里不写字体 ✓ 字符
    desc: '已删的写法：variant="external"、ss-btn--external、页面直写 ss-btn--quiet、Disclosure / mx-disclosure、文案里的 ✓ ▸',
    run(src, path) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
      const out = [];
      if (/variant\s*=\s*\{?\s*["']external["']/.test(code))
        out.push('variant="external"（写 variant="quiet"）');
      if (/ss-btn--external/.test(code)) out.push("ss-btn--external");
      if (!path.startsWith("src/ui/") && /ss-btn--quiet/.test(code))
        out.push('页面里直写 ss-btn--quiet（用 <Button variant="quiet">）');
      if (/\bDisclosure\b|mx-disclosure/.test(code))
        out.push("Disclosure / mx-disclosure（用 DrawerHandle + Drawer）");
      const text = visibleText(src);
      if (text.includes("✓")) out.push("文案里的字体 ✓（用 IconTick）");
      if (text.includes("▸")) out.push("文案里的 ▸（用 DrawerHandle）");
      return out;
    },
  },
  {
    id: "cap-only",
    // 大写是结构的语言：我们自己写的纯拉丁结构词经 <Cap> 按脚本切 run，只给拉丁 run 套
    // Condensed + 大写 + 字距；套到汉字上字字散开、窄体大写挨着常宽苹方像两套系统。
    // 所以大写变换、正字距、--track-* 只许出现在 Cap 的样式（.ss-cap…）里，组件代码里一律不写
    // （原画板 lint 的 cjk-tracking；DESIGN「字距：汉字永远 0」）
    desc: "text-transform: uppercase、非 0 letter-spacing 与 var(--track-*) 只许出现在 Cap 的样式（.ss-cap）里",
    run(src, path) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
      const isUpper = (body) =>
        /text-transform\s*:\s*uppercase|textTransform\s*:\s*["']uppercase["']/.test(body);
      const tracked = (body) =>
        [...body.matchAll(/(?:letter-spacing|letterSpacing)\s*[:=]\s*["']?([^;"'}\n,]+)/g)]
          .map((m) => m[1].trim())
          .filter((v) => !/^(0|0px|normal|inherit)$/.test(v));
      const usesTrack = (body) => /var\(--track-/.test(body);
      const out = [];
      if (!path.endsWith(".css")) {
        if (isUpper(code)) out.push("组件代码里写了大写变换（用 <Cap>）");
        for (const v of tracked(code)) out.push(`组件代码里写了字距 ${v}（用 <Cap>）`);
        if (usesTrack(code)) out.push("组件代码里引用了 --track-*（用 <Cap>）");
        return [...new Set(out)];
      }
      if (path === TOKEN_FILE) return [];
      for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = m[2];
        const bad = [];
        if (isUpper(body)) bad.push("uppercase");
        for (const v of tracked(body)) bad.push(`letter-spacing: ${v}`);
        if (usesTrack(body)) bad.push("var(--track-*)");
        if (!bad.length) continue;
        const selectors = m[1].split(",").map((x) => x.trim());
        for (const sel of selectors)
          if (!CAP_SELECTOR.test(sel)) out.push(`${sel}：${bad.join("、")}`);
      }
      return [...new Set(out)];
    },
  },
  {
    id: "no-lower",
    // 小写变换是 V4 一度用过、已撤回的做法：结构词大写经 Cap，内容原样，没有第三种
    desc: "不出现小写变换（text-transform 取 lower 开头的值）",
    run(src) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
      const n = (code.match(/text-?[Tt]ransform\s*[:=]\s*["']?lower/g) || []).length;
      return n ? [`${n} 处小写变换`] : [];
    },
  },
  {
    id: "copy-register",
    // DESIGN「文案语域：平实、完整」（D24）的旧词表：状态词与失败原因用「无法 + 动词」，句子写完整，
    // 不指向已删的页面。表左列写回界面字符串即报错（注释与标识符不算）
    desc: "D24 文案语域：界面字符串里不出现旧词",
    run(src) {
      const text = visibleText(src);
      return OLD_WORDS.filter((w) => text.includes(w)).map((w) => `「${w}」`);
    },
  },
  {
    id: "mcp-no-sync",
    // 「同步」是双向词。MCP 页只新增、从不覆盖也不删除，用它会骗人
    // （docs/specs/2026-09-21-ui-rebuild-mcp.md 的 R3 / AC7）。
    // 只管 MCP 那几个文件：skill 页的「自动同步」是名副其实的双向维护，不受此限
    desc: "MCP 页的文案不出现「同步」（R3）",
    run(src, path) {
      // 来源行与添加来源页 skill 与 MCP 共用一套文案文件，一并管
      const mcp =
        /^src\/[Mm]cp[A-Za-z]*\.(tsx|ts|css)$/.test(path) ||
        /^src\/pages\/(sourcesModel\.ts|sourcesView\.ts)$/.test(path);
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
  const strings = [...noComments.matchAll(/"([^"\\\n]{2,})"|'([^'\\\n]{2,})'|`([^`\\]{2,})`/g)].map(
    (m) => m[1] ?? m[2] ?? m[3],
  );
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
if (errs === 0)
  console.log(
    `\x1b[32m✓\x1b[0m 界面规范：${checked} 个文件零违规${skipped ? `（${skipped} 个旧文件暂时豁免）` : ""}`,
  );
else
  console.log(`\n${errs} 个违规，检查了 ${checked} 个文件${skipped ? `，豁免 ${skipped} 个` : ""}`);

if (skipped > 0 && args.length === 0) {
  console.log(
    `\x1b[33m!\x1b[0m 豁免名单还剩 ${skipped} 个文件，T10 收口时必须清空：\n   ${LEGACY.join("\n   ")}`,
  );
}
process.exit(errs ? 1 : 0);
