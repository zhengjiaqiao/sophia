/// 两套外观的颜色 token（spec 2026-09-30-language-and-theme R3，设计稿 https://claude.ai/artifact/7ZoeBtNk7RbTLKoWnPEDY8）：
/// 深色重定义浅色的每一个颜色与投影 token，一个不少；两套各自达到同一组对比度下限；原生控件跟着外观走
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8");

/// 取一段里 `--name: #rrggbb` 的调色板 token（系统色 --sys-* 与字标动效的 --cat-* 不算调色板）
function colors(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6});/gi)]
      .filter((m) => !/^(sys|cat)-/.test(m[1]))
      .map((m) => [m[1], m[2]]),
  );
}
function shadows(block: string): Set<string> {
  return new Set([...block.matchAll(/--((?:raise|recess|elev)[a-z-]*):/g)].map((m) => m[1]));
}
const darkStart = css.indexOf("@media (prefers-color-scheme: dark)");
const light = css.slice(0, darkStart);
const dark = css.slice(darkStart, css.indexOf("\n}\n", darkStart));

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("深色块存在，重定义了浅色的每一个颜色 token 与每一档投影", () => {
  assert.ok(darkStart > 0, "tokens.css 里要有 @media (prefers-color-scheme: dark)");
  const l = colors(light);
  const d = colors(dark);
  assert.equal(l.size, 14);
  assert.deepEqual([...d.keys()].sort(), [...l.keys()].sort());
  assert.deepEqual([...shadows(dark)].sort(), [...shadows(light)].sort());
});

test("两套外观达到同一组对比度下限（正文 ≥ 7、次要与计数 ≥ 4.5、提示框反色 ≥ 7、开着的橙对机面 ≥ 3）", () => {
  for (const [name, block] of [
    ["浅色", light],
    ["深色", dark],
  ] as const) {
    const c = colors(block);
    const at = (fg: string, bg: string) => contrast(c.get(fg)!, c.get(bg)!);
    for (const bg of ["face", "paper", "surface", "shell"]) {
      assert.ok(at("ink", bg) >= 7, `${name} ink / ${bg}`);
      assert.ok(at("ink-mute", bg) >= 4.5, `${name} ink-mute / ${bg}`);
    }
    for (const bg of ["face", "paper"])
      assert.ok(at("ink-faint", bg) >= 4.5, `${name} ink-faint / ${bg}`);
    assert.ok(at("face", "ink") >= 7, `${name} 提示框 face / ink`);
    assert.ok(at("accent", "face") >= 3, `${name} accent / face`);
    // 勾选框的环是 ink-faint：非文字控件边 ≥ 3
    assert.ok(at("ink-faint", "paper") >= 3, `${name} 勾选框环`);
  }
});

test("根上声明 color-scheme: light dark：原生控件、滚动条、系统颜色跟着窗口外观走", () => {
  assert.match(light, /:root \{[^}]*color-scheme: light dark;/);
});

test("空态插图在深色外观里描一圈轮廓光（--cat-rim），不反相", () => {
  const ui = readFileSync(new URL("../src/ui/ui.css", import.meta.url), "utf8");
  const at = ui.indexOf("@media (prefers-color-scheme: dark) {\n  .ss-empty__art {");
  assert.ok(at > 0, "ui.css 里要有深色外观下的空态插图规则");
  const rule = ui.slice(at, ui.indexOf("}\n}", at));
  assert.equal(rule.match(/drop-shadow\([^)]*var\(--cat-rim\)\)/g)?.length, 4);
  assert.doesNotMatch(rule, /invert/);
});

/// 深色开关（2026-09-30 真机「开关很难看清」，设计稿第 8 组 A）：滑块提亮到 ctl-edge，槽外一圈 1px 亮环；
/// 只在深色、只动开关（经变量钩子）；托盘的系统样式开关照旧由托盘自己定
test("深色开关：滑块 --switch-knob 是 ctl-edge、对机面 ≥ 2.5；开关槽的凹面投影带一圈亮环", () => {
  assert.match(dark, /--switch-knob: var\(--ctl-edge\);/);
  assert.doesNotMatch(light, /--switch-knob:/);
  const c = colors(dark);
  assert.ok(contrast(c.get("ctl-edge")!, c.get("face")!) >= 2.5);
  assert.match(
    dark,
    /--recess-track: inset 0 1px 2px rgba\(0,0,0,\.5\), 0 0 0 1px rgba\(255,255,250,\.1\);/,
  );
  const tray = readFileSync(new URL("../src/TrayPanel.css", import.meta.url), "utf8");
  assert.match(tray, /--switch-knob: var\(--sys-knob\);/);
});
