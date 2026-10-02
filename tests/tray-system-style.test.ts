/// 托盘改成 macOS 菜单风格（spec 2026-09-30-language-and-theme R14，设计稿 https://claude.ai/artifact/7ZoeBtNk7RbTLKoWnPEDY8 第 6 组）：
/// 系统菜单材质垫在网页底下、网页不画底；字体、字色、分隔线、强调色都取系统的；内容、顺序、行为不变。
/// 托盘文件不碰组件内部类（ss-*）：外观只经 token 与组件暴露的变量钩子换
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { render } from "./ui-render.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/// 取行首是这个选择器的所有规则块，连起来（同一个选择器也出现在合并选择器里时一并算上）
const block = (css: string, sel: string) => {
  const parts: string[] = [];
  let at = css.indexOf(`\n${sel} {`);
  while (at >= 0) {
    parts.push(css.slice(at, css.indexOf("}", at)));
    at = css.indexOf(`\n${sel} {`, at + 1);
  }
  assert.ok(parts.length > 0, `缺 ${sel}`);
  return parts.join("\n");
};

test("系统色与系统字体 token：只在 tokens.css 里取系统关键字，别处读变量", () => {
  const tokens = read("../src/tokens.css");
  for (const [name, value] of [
    ["sys-label", "-apple-system-label"],
    ["sys-secondary", "-apple-system-secondary-label"],
    ["sys-separator", "-apple-system-separator"],
    ["sys-fill", "-apple-system-quaternary-label"],
    ["sys-accent", "-apple-system-control-accent"],
  ]) {
    assert.match(tokens, new RegExp(`--${name}: ${value};`), name);
  }
  // 中文字族经 --font-cjk（繁体换 PingFang TC，见下一条）
  assert.match(tokens, /--font-system: -apple-system, BlinkMacSystemFont, var\(--font-cjk\)/);
  assert.match(tokens, /--font-cjk: "PingFang SC"/);
  assert.doesNotMatch(read("../src/TrayPanel.css"), /-apple-system/);
});

test("繁体只换中文字族：四个字体变量都经 --font-cjk，:root:lang(zh-Hant) 只覆盖它一个——托盘在 html 上的 --font-ui 不被盖掉", () => {
  const tokens = read("../src/tokens.css");
  for (const name of ["font-ui", "font-cond", "font-mono", "font-system"])
    assert.match(tokens, new RegExp(`--${name}: [^;]*var\\(--font-cjk\\)`), name);
  const hant = block(tokens, ":root:lang(zh-Hant)");
  assert.deepEqual(
    [...hant.matchAll(/(--[\w-]+):/g)].map((m) => m[1]),
    ["--font-cjk"],
  );
  assert.match(hant, /--font-cjk: "PingFang TC", "Microsoft JhengHei";/);
});

test("共享组件暴露变量钩子，默认值就是现在的样子（主窗口不变）", () => {
  const ui = read("../src/ui/ui.css");
  assert.match(
    block(ui, ".ss-switch.is-on .ss-switch__track"),
    /background: var\(--switch-on-track, var\(--recess\)\)/,
  );
  assert.match(
    block(ui, ".ss-switch__scribe"),
    /background: var\(--switch-scribe, var\(--accent\)\)/,
  );
  assert.match(
    block(ui, ".ss-switch__knob"),
    /border-radius: var\(--switch-knob-radius, var\(--radius-knob\)\)/,
  );
  assert.match(block(ui, ".ss-switch__knob"), /background: var\(--switch-knob, var\(--paper\)\)/);
  assert.match(
    block(ui, ".ss-switch__track"),
    /border-radius: var\(--switch-track-radius, var\(--radius-track\)\)/,
  );
  assert.match(
    block(ui, ".ss-menuitem:hover:not(:disabled)"),
    /background: var\(--menu-hover-bg, var\(--surface\)\)/,
  );
  assert.match(
    block(ui, ".ss-menuitem:hover:not(:disabled)"),
    /color: var\(--menu-hover-ink, var\(--ink\)\)/,
  );
  // 键盘移到的那一项同悬停（独立审查：原来焦点写死 surface，托盘里在磨砂底上几乎看不见）
  assert.match(
    ui,
    /html\[data-input="keyboard"\] \.ss-menuitem:focus \{\s*background: var\(--menu-hover-bg, var\(--surface\)\);\s*color: var\(--menu-hover-ink, var\(--ink\)\);/,
  );
  // 行高真能到 22：上下内边距也是钩子（原来 4 + 19.5 + 4 把 min-height 22 撑到 27.5）
  assert.match(
    block(ui, ".ss-menuitem"),
    /padding: var\(--menu-item-pad, var\(--space-xxs\)\) 10px/,
  );
  const gauge = read("../src/usage/UsageWindows.css");
  assert.match(
    block(gauge, ".usage-win__bar > i"),
    /background: var\(--gauge-fill, var\(--ink\)\)/,
  );
});

test("托盘窗口：网页不画底，文字与分隔线换系统色、字体换系统字体，开关 / 菜单 / 进度条走钩子；不写字面色", () => {
  const css = read("../src/TrayPanel.css");
  const root = block(css, 'html[data-window="tray"]');
  assert.match(root, /background: transparent/);
  for (const [name, value] of [
    ["ink", "var(--sys-label)"],
    ["ink-mute", "var(--sys-secondary)"],
    ["hairline", "var(--sys-separator)"],
    ["row-line", "var(--sys-separator)"],
    ["track", "var(--sys-fill)"],
    ["font-ui", "var(--font-system)"],
    ["gauge-fill", "var(--sys-accent)"],
    ["switch-on-track", "var(--sys-accent)"],
    ["switch-scribe", "transparent"],
    ["menu-hover-bg", "var(--sys-accent)"],
    ["menu-item-pad", "0"],
  ]) {
    assert.match(root, new RegExp(`--${name}: ${value.replace(/[()]/g, "\\$&")};`), name);
  }
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i);
  assert.doesNotMatch(css, /\.ss-/);
  // 标记只给托盘窗口打
  assert.match(read("../src/main.tsx"), /document\.documentElement\.dataset\.window = "tray"/);
});

test("用量两行版式（stacked）：上一行窗口名 + 读数，下一行满宽进度条；用量页照旧一行三列", async () => {
  const { UsageWindows } = await import("../src/usage/UsageWindows.tsx");
  const usage = {
    agent: "claude-code",
    updatedText: "3 分钟前更新",
    windows: [
      {
        label: "5 小时",
        percentText: "剩 87%",
        gaugePercent: 13,
        emphasize: false,
        resetText: "3:04 后重置",
      },
    ],
    note: null,
  };
  const stacked = render(UsageWindows, { usage, stacked: true });
  assert.match(
    stacked,
    /class="usage-wins usage-wins--stacked"[^]*?class="usage-win__line">[^]*?<span class="usage-win__label">5 小时<\/span>[^]*?<span class="usage-win__text">[^]*?剩 87%[^]*?<\/span><\/span><span class="usage-win__bar"/,
  );
  assert.doesNotMatch(render(UsageWindows, { usage }), /usage-wins--stacked|usage-win__line/);
  assert.match(read("../src/usage/UsageTrayRow.tsx"), /<UsageWindows usage=\{[^}]*\} stacked \/>/);
});

test("原生层：托盘面板底下垫系统菜单材质，网页不画底；圆角 10、带系统窗口投影", () => {
  const rs = read("../src-tauri/src/tray.rs");
  assert.match(rs, /NSVisualEffectMaterial::Menu/);
  assert.match(rs, /NSVisualEffectBlendingMode::BehindWindow/);
  assert.match(rs, /"drawsBackground"/);
  assert.match(rs, /setCornerRadius\(10\.0\)/);
  assert.match(rs, /setHasShadow\(true\)/);
});

/// 托盘里的键（2026-09-30 真机「按钮的颜色是不是可以改改」，设计稿第 9 组 C）：macOS 小按键——半透明底、
/// 0.5px 细边、圆角 5、12 号常规字重；只经默认键的变量钩子换，主窗口的键不变
test("默认键暴露变量钩子（默认照旧）；托盘设成系统小按键，取值在 tokens.css 两套外观里", () => {
  const ui = read("../src/ui/ui.css");
  const btn = block(ui, ".ss-btn");
  assert.match(btn, /border-radius: var\(--key-radius, var\(--radius-control\)\)/);
  assert.match(btn, /background: var\(--key-bg, var\(--paper\)\)/);
  assert.match(btn, /box-shadow: var\(--key-shadow, var\(--raise\)\)/);
  assert.match(btn, /font-size: var\(--key-size, var\(--size-caption\)\)/);
  assert.match(btn, /font-weight: var\(--key-weight, 600\)/);
  assert.match(
    block(ui, ".ss-btn:hover:not(:disabled)"),
    /box-shadow: var\(--key-shadow-hover, var\(--raise-hover\)\)/,
  );
  const active = block(ui, ".ss-btn:active:not(:disabled)");
  assert.match(active, /background: var\(--key-bg-pressed, var\(--surface\)\)/);
  assert.match(active, /box-shadow: var\(--key-shadow-pressed, var\(--raise-pressed\)\)/);

  const tray = block(read("../src/TrayPanel.css"), 'html[data-window="tray"]');
  for (const [name, value] of [
    ["key-bg", "var(--sys-key-bg)"],
    ["key-bg-pressed", "var(--sys-fill)"],
    ["key-shadow", "var(--sys-key-shadow)"],
    ["key-shadow-hover", "var(--sys-key-shadow)"],
    ["key-shadow-pressed", "var(--sys-key-shadow)"],
    ["key-radius", "5px"],
    ["key-size", "var(--size-caption)"],
    ["key-weight", "500"],
  ]) {
    assert.match(tray, new RegExp(`--${name}: ${value.replace(/[()]/g, "\\$&")};`), name);
  }
  const tokens = read("../src/tokens.css");
  const darkAt = tokens.indexOf("@media (prefers-color-scheme: dark)");
  for (const part of [tokens.slice(0, darkAt), tokens.slice(darkAt)]) {
    assert.match(part, /--sys-key-bg: rgba\(255, ?255, ?255, ?0?\.\d+\);/);
    assert.match(
      part,
      /--sys-key-shadow: 0 0 0 0?\.5px rgba\([^)]*\), 0 0?\.5px 1px rgba\([^)]*\);/,
    );
  }
});

/// 最长情况（2026-09-30 产品负责人「考虑下最长的情况，以及是否符合设计规范，不行的话，就加宽」）：
/// 读数最长「剩 100% · 23 小时 59 分后重置」约 168（12 号），常见最长窗口名「本周 · Sonnet」约 80（13 号），
/// 加间距 12 共约 260——280 宽（内容 248）放不下，托盘加宽到 300（内容 268）。
/// 服务端给的模型窗口名（Codex「5 小时 · GPT-5.3-Codex-Spark」）长度没有上限：按规范「放不下截断、完整值进提示框」，
/// 截的是窗口名，读数永远完整
test("托盘宽 300；窗口名放不下截断并悬停出全名，读数不收窄（托盘与用量页同一个组件）", async () => {
  assert.match(read("../src-tauri/src/tray.rs"), /pub const PANEL_WIDTH: f64 = 300\.0;/);
  const { UsageWindows } = await import("../src/usage/UsageWindows.tsx");
  const usage = {
    agent: "codex",
    updatedText: "1 分钟前更新",
    windows: [
      {
        label: "5 小时 · GPT-5.3-Codex-Spark",
        percentText: "剩 100%",
        gaugePercent: 100,
        emphasize: false,
        resetText: "23 小时 59 分后重置",
      },
    ],
    note: null,
  };
  for (const stacked of [true, false]) {
    const html = render(UsageWindows, { usage, stacked });
    // 窗口名包在截断才提示的提示框里
    assert.match(
      html,
      /ss-tipwrap[^>]*>[^]*?class="usage-win__label">5 小时 · GPT-5\.3-Codex-Spark</,
    );
  }
  const css = read("../src/usage/UsageWindows.css");
  const label = block(css, ".usage-win__label");
  assert.match(label, /overflow: hidden/);
  assert.match(label, /text-overflow: ellipsis/);
  assert.match(block(css, ".usage-win__text"), /flex-shrink: 0/);
  // 一行三列（用量页）：窗口名那一列能收窄
  assert.match(
    block(css, ".usage-wins"),
    /grid-template-columns: minmax\(0, max-content\) minmax\(48px, 1fr\) max-content/,
  );
});
