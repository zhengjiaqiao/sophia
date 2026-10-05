/// 设置「界面」一节（spec 2026-09-30-language-and-theme R1 R2，设计稿 https://claude.ai/artifact/7ZoeBtNk7RbTLKoWnPEDY8 第 3 组，
/// 第三批画板 1A）：最前面一节，两行——「界面语言」在上（跟随系统 ｜ 简体中文 ｜ 繁體中文 ｜ English，说明句说系统控件跟随
/// macOS 的语言），「外观」在下（跟随系统 ｜ 浅色 ｜ 深色，不加图标；下面一句灰字说跟随系统的意思）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { render } from "./ui-render.ts";
import { withCopy } from "./copy.ts";
import { setLocale } from "../src/i18n.ts";

const { AppearanceRow, APPEARANCE_ITEMS } = await import("../src/pages/AppearanceRow.tsx");
const { LanguageRow, LANGUAGE_ITEMS } = await import("../src/pages/LanguageRow.tsx");

test("1A 界面语言四项：跟随系统 ｜ 简体中文 ｜ 繁體中文 ｜ English，值是 system / zh-Hans / zh-Hant / en", () => {
  assert.deepEqual(
    LANGUAGE_ITEMS.map((i) => [i.id, i.label]),
    [
      ["system", "跟随系统"],
      ["zh-Hans", "简体中文"],
      ["zh-Hant", "繁體中文"],
      ["en", "English"],
    ],
  );
});

test("1A 语言名写成各自的自称，换了界面语言也不变；只有「跟随系统」随当前语言", () => {
  for (const [lang, system] of [
    ["en", "System"],
    ["zh-Hant", "跟隨系統"],
  ] as const) {
    setLocale(lang);
    try {
      assert.deepEqual(
        LANGUAGE_ITEMS.map((i) => i.label),
        [system, "简体中文", "繁體中文", "English"],
      );
    } finally {
      setLocale("zh-Hans");
    }
  }
});

test("1A 界面语言一行：设置行，标签与说明句在左、紧凑页签在右（原样显示，不转大写）；选中的那项亮着；读屏名写明", () => {
  const html = render(LanguageRow, { value: "zh-Hant", onChange: () => undefined });
  assert.match(html, /settings-page__label">界面语言</);
  // 名字与说明句在左栏，页签在右端一列（2026-10-04 画板 B）
  assert.ok(html.indexOf("settings-page__text") < html.indexOf("settings-page__controls"));
  assert.ok(html.indexOf("settings-page__controls") < html.indexOf("ss-tabs--compact"));
  assert.match(html, /aria-label="界面语言"/);
  assert.match(html, /ss-tabs--compact/);
  assert.doesNotMatch(html, /ss-cap/);
  assert.match(html, /aria-current="page"[^>]*>繁體中文</);
  assert.match(
    html,
    /settings-page__note">部分系统控件（如选文件夹对话框的按钮）跟随 macOS 的语言</,
  );
  setLocale("en");
  try {
    const en = render(LanguageRow, { value: "en", onChange: () => undefined });
    assert.match(en, /settings-page__label">Language</);
    assert.match(
      en,
      /Some system controls, like the buttons in file dialogs, follow the macOS language/,
    );
  } finally {
    setLocale("zh-Hans");
  }
});

test("外观三项：跟随系统 ｜ 浅色 ｜ 深色，值是 system / light / dark", () => {
  assert.deepEqual(
    APPEARANCE_ITEMS.map((i) => [i.id, i.label]),
    [
      ["system", "跟随系统"],
      ["light", "浅色"],
      ["dark", "深色"],
    ],
  );
});

test("外观一行：标签「外观」+ 紧凑页签（原样显示，不转大写）+ 灰字；选中的那项亮着；读屏名写明", () => {
  const html = render(AppearanceRow, { value: "dark", onChange: () => undefined });
  assert.match(html, /settings-page__label">外观</);
  assert.match(html, /aria-label="外观"/);
  assert.match(html, /ss-tabs--compact/);
  assert.match(html, /aria-current="page"[^>]*>(?:<[^>]+>)*深色/);
  assert.match(html, /跟随系统时，系统切换深浅色，Sophia 当场跟着变/);
  // 不加太阳 / 月亮图标
  assert.doesNotMatch(html, /<svg/);
});

test("设置页：「通用」是第一节（在「列表里的 agent」之前），语言在上、外观在下；外观读自 core、改了当场写，写不成读回原样", () => {
  const src = withCopy(
    readFileSync(new URL("../src/pages/SettingsPage.tsx", import.meta.url), "utf8"),
  );
  // 节小标下不画线（2026-10-04 画板 B）
  assert.match(src, /<SectionLabel>通用<\/SectionLabel>/);
  assert.doesNotMatch(src, /<SectionLabel rule/);
  // 节序（画板 1A、B）：通用 → 界面语言 → 外观 → 列表里的 agent
  const at = (re: RegExp) => src.search(re);
  assert.ok(at(/通用<\/SectionLabel>/) < at(/<LanguageRow /));
  assert.ok(at(/<LanguageRow /) < at(/<AppearanceRow /));
  assert.ok(at(/<AppearanceRow /) < at(/<SectionLabel>\s*列表里的 agent/));
  assert.match(src, /<AppearanceRow value=\{appearance\} onChange=\{/);
  assert.match(src, /api\.appearance\(\)/);
  assert.match(src, /api\.setAppearance\(next\)/);
  // 写不成：重读 core 的真值（不是回到闭包里的旧值——快速连点时会盖掉后一次的选择）
  assert.match(
    src,
    /catch \(e\) \{\s*onError\(String\(e\)\);\s*void api\.appearance\(\)\.then\(setAppearanceState/,
  );
});

test("1A 设置页：界面语言读自 core（设置里存的那一项）、选了先画出来再写，写不成说原因、重读 core 的真值", () => {
  const src = readFileSync(new URL("../src/pages/SettingsPage.tsx", import.meta.url), "utf8");
  assert.match(src, /<LanguageRow value=\{language\} onChange=\{/);
  assert.match(src, /api\.uiLanguage\(\)\.then\(\s*\(v\) => setLanguageState\(v\.setting\)/);
  assert.match(src, /setLanguageState\(next\);\s*try \{\s*await api\.setUiLanguage\(next\)/);
  assert.match(
    src,
    /catch \(e\) \{\s*onError\(String\(e\)\);\s*void api\.uiLanguage\(\)\.then\(\s*\(v\) => setLanguageState\(v\.setting\)/,
  );
});

test("1A 正式入口做好了，开发用的切换入口（SYMSYNC_UI_LANG、sophiaSetLanguage）删掉", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const rs = readFileSync(new URL("../src-tauri/src/language.rs", import.meta.url), "utf8");
  assert.doesNotMatch(main, /sophiaSetLanguage/);
  assert.doesNotMatch(rs, /SYMSYNC_UI_LANG|DEV_OVERRIDE|parse_override/);
});
