/// 前端取文案（src/i18n.ts，spec 2026-09-30-language-and-theme R7）：占位符、按数量选写法、句中嵌元素。
/// 目录本身的一致性在 i18n-catalog.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as CATALOG_MODULE from "../src/i18n/catalog.ts";
import {
  formatMessage,
  formatRich,
  isLang,
  listText,
  locale,
  messageFor,
  selectForm,
  setLocale,
  subscribeLocale,
  t,
} from "../src/i18n.ts";

test("占位符：{name} 换成参数，数字照写；缺参数的占位符原样留着（看得见，不静默吞掉）", () => {
  assert.equal(formatMessage("加到 {agent}", { agent: "Codex" }), "加到 Codex");
  assert.equal(formatMessage("{n} 个 skill", { n: 3 }), "3 个 skill");
  assert.equal(formatMessage("{a} 和 {a}", { a: "x" }), "x 和 x");
  assert.equal(formatMessage("加到 {agent}", {}), "加到 {agent}");
  assert.equal(formatMessage("没有占位符"), "没有占位符");
});

test("按数量选写法：英文 1 取 one、其余取 other；中文只有一种写法，字符串或只写 other 都行", () => {
  const en = { one: "{count} skill", other: "{count} skills" };
  assert.equal(selectForm(en, 1, "en"), "{count} skill");
  assert.equal(selectForm(en, 0, "en"), "{count} skills");
  assert.equal(selectForm(en, 2, "en"), "{count} skills");
  assert.equal(selectForm("{count} 个 skill", 1, "zh-Hans"), "{count} 个 skill");
  assert.equal(selectForm({ other: "{count} 个" }, 1, "zh-Hans"), "{count} 个");
  // 缺 one 时退回 other
  assert.equal(selectForm({ other: "{count} items" }, 1, "en"), "{count} items");
});

test("句中嵌元素：占位符换成传入的 React 节点，前后文字原样、顺序不变", () => {
  const node = formatRich("重启 {agent} 生效", {
    agent: createElement("span", { className: "plain" }, "Codex"),
  });
  assert.equal(
    renderToStaticMarkup(createElement("b", null, node)),
    '<b>重启 <span class="plain">Codex</span> 生效</b>',
  );
  // 字符串与数字也能当部件；没给的占位符原样留着
  assert.equal(
    renderToStaticMarkup(createElement("b", null, formatRich("{n} 个 {x}", { n: 2 }))),
    "<b>2 个 {x}</b>",
  );
});

test("当前语言：起始是简体；setLocale 换掉、通知订阅者，同一种语言不重复通知；退订之后不再通知", () => {
  assert.equal(locale(), "zh-Hans");
  const seen: string[] = [];
  const off = subscribeLocale(() => seen.push(locale()));
  try {
    setLocale("en");
    assert.equal(locale(), "en");
    setLocale("en");
    setLocale("zh-Hant");
    assert.deepEqual(seen, ["en", "zh-Hant"]);
  } finally {
    setLocale("zh-Hans");
    off();
  }
  setLocale("en");
  setLocale("zh-Hans");
  assert.deepEqual(seen, ["en", "zh-Hant", "zh-Hans"]);
});

test("语言标签：只认三种，别的都不算", () => {
  for (const lang of ["zh-Hans", "zh-Hant", "en"]) assert.equal(isLang(lang), true, lang);
  for (const other of ["zh", "en-GB", "ja", "", null, 3]) assert.equal(isLang(other), false);
});

const SAMPLE = {
  "zh-Hans": { "x.hi": "你好 {name}", "x.only": "只有简体", "x.n": "{count} 个 skill" },
  "zh-Hant": { "x.hi": "妳好 {name}", "x.n": "{count} 個 skill" },
  en: { "x.hi": "Hi {name}", "x.n": { one: "{count} skill", other: "{count} skills" } },
};

test("按语言查：这种语言里没有的键退回简体，简体也没有就给键名", () => {
  assert.equal(formatMessage(messageFor("en", "x.hi", SAMPLE), { name: "Ann" }), "Hi Ann");
  assert.equal(formatMessage(messageFor("zh-Hant", "x.hi", SAMPLE), { name: "Ann" }), "妳好 Ann");
  assert.equal(messageFor("en", "x.only", SAMPLE), "只有简体");
  assert.equal(messageFor("zh-Hant", "x.only", SAMPLE), "只有简体");
  assert.equal(messageFor("en", "x.none", SAMPLE), "x.none");
});

test("tn 按当前语言选单复数：英文 1 取 one、其余 other；繁体只有一种写法", () => {
  const n = (count: number) =>
    formatMessage(selectForm(messageFor(locale(), "x.n", SAMPLE), count, locale()), { count });
  try {
    setLocale("en");
    assert.equal(n(1), "1 skill");
    assert.equal(n(2), "2 skills");
    setLocale("zh-Hant");
    assert.equal(n(1), "1 個 skill");
  } finally {
    setLocale("zh-Hans");
  }
  assert.equal(n(2), "2 个 skill");
});

test("t / tn 读当前语言的目录（三份目录都载入了）", () => {
  const { CATALOGS } = CATALOG_MODULE;
  assert.deepEqual(Object.keys(CATALOGS).sort(), ["en", "zh-Hans", "zh-Hant"]);
  for (const cat of Object.values(CATALOGS))
    assert.deepEqual(Object.keys(cat).sort(), Object.keys(CATALOGS["zh-Hans"]).sort());
  try {
    setLocale("en");
    assert.equal(
      t("common.list.semicolon"),
      formatMessage(messageFor("en", "common.list.semicolon")),
    );
  } finally {
    setLocale("zh-Hans");
  }
});

test("测试助手 withCopy：源码里的键换回简体文案，读源码的测试照旧比中文", async () => {
  const { withCopy, copy } = await import("./copy.ts");
  const cat = {
    "models.restart": "重启生效",
    "models.tip": "改完要重启 {agent}",
    "usage.n": { other: "{count} 个" },
  };
  assert.equal(
    withCopy('<Button title={t("models.restart")}>{t("models.restart")}</Button>', cat),
    '<Button title="重启生效">重启生效</Button>',
  );
  assert.equal(withCopy('t("models.tip", { agent })', cat), 't("改完要重启 {agent}", { agent })');
  assert.equal(
    withCopy('const K = { n: "usage.n", f: "a.json" };', cat),
    'const K = { n: "{count} 个", f: "a.json" };',
  );
  assert.equal(copy("models.restart", cat), "重启生效");
  assert.throws(() => copy("models.none", cat), /目录里没有 models\.none/);
});

test("列表：中文照旧用「、」「 和 」「；」连接；其他语言的枚举与「和」走 Intl.ListFormat，分号各语言自写", async () => {
  const { joinList } = await import("../src/i18n.ts");
  const zh = { enum: "、", and: " 和 ", semicolon: "；" };
  assert.equal(joinList(["A", "B", "C"], "enum", "zh-Hans", zh), "A、B、C");
  assert.equal(joinList(["A", "B"], "and", "zh-Hans", zh), "A 和 B");
  assert.equal(joinList(["原因一", "原因二"], "semicolon", "zh-Hans", zh), "原因一；原因二");
  const en = { enum: "", and: "", semicolon: "; " };
  assert.equal(joinList(["A", "B", "C"], "enum", "en", en), "A, B, and C");
  assert.equal(joinList(["A", "B"], "and", "en", en), "A and B");
  assert.equal(joinList(["A"], "enum", "en", en), "A");
  assert.equal(joinList([], "enum", "en", en), "");
  assert.equal(joinList(["x", "y"], "semicolon", "en", en), "x; y");
});

test("列表（#320）：中文「和」两边挨着西文才空格，挨着汉字、全角标点不空（同 formatMessage 的中西文规则）", async () => {
  const { joinList } = await import("../src/i18n.ts");
  const zh = { enum: "、", and: " 和 ", semicolon: "；" };
  assert.equal(
    joinList(["Codex 的配置文件", ".gitignore"], "and", "zh-Hans", zh),
    "Codex 的配置文件和 .gitignore",
  );
  assert.equal(joinList(["用户级", "项目"], "and", "zh-Hans", zh), "用户级和项目");
  assert.equal(joinList(["Codex", "Cursor"], "and", "zh-Hans", zh), "Codex 和 Cursor");
  // 与 formatMessage 同一套：可打印 ASCII 都算西文（半角点开头的 `.gitignore` 也隔开）
  assert.equal(
    formatMessage("已还原{restored}，{failed}未还原", { restored: ".gitignore", failed: "Codex" }),
    "已还原 .gitignore，Codex 未还原",
  );
  assert.equal(joinList(["CardBox", "用户级"], "and", "zh-Hant", zh), "CardBox 和用户级");
  assert.equal(
    joinList(["Claude Code（仅自己）", "Codex"], "and", "zh-Hans", zh),
    "Claude Code（仅自己）和 Codex",
  );
  assert.equal(joinList(["A", "B", "配置"], "and", "zh-Hans", zh), "A、B 和配置");
});

test("列表（#304）：中文并举两项「A 和 B」，三项及以上「A、B 和 C」，不连写成「A 和 B 和 C」；一项、零项原样", async () => {
  const { joinList } = await import("../src/i18n.ts");
  const zh = { enum: "、", and: " 和 ", semicolon: "；" };
  for (const lang of ["zh-Hans", "zh-Hant"]) {
    assert.equal(joinList(["A", "B", "C"], "and", lang, zh), "A、B 和 C");
    assert.equal(joinList(["A", "B", "C", "D"], "and", lang, zh), "A、B、C 和 D");
    assert.equal(joinList(["A", "B"], "and", lang, zh), "A 和 B");
    assert.equal(joinList(["A"], "and", lang, zh), "A");
    assert.equal(joinList([], "and", lang, zh), "");
  }
  // 按当前语言取连接符：简体、繁體同一种写法，English 走 Intl.ListFormat
  try {
    for (const lang of ["zh-Hans", "zh-Hant"] as const) {
      setLocale(lang);
      assert.equal(
        listText(["Claude Code", "Codex", "Cursor"], "and"),
        "Claude Code、Codex 和 Cursor",
      );
    }
    setLocale("en");
    assert.equal(
      listText(["Claude Code", "Codex", "Cursor"], "and"),
      "Claude Code, Codex, and Cursor",
    );
  } finally {
    setLocale("zh-Hans");
  }
});

test("句中嵌名字的空格：名字与相邻汉字之间，西文那一侧隔一个空格；汉字名紧贴；标点、句首句尾不加；英文句子不受影响", () => {
  const tpl = "从{place}移除{name}（不动原件）";
  assert.equal(
    formatMessage(tpl, { place: "CardBox", name: "pdf" }),
    "从 CardBox 移除 pdf（不动原件）",
  );
  assert.equal(
    formatMessage(tpl, { place: "用户级", name: "技能" }),
    "从用户级移除技能（不动原件）",
  );
  // 首尾字符各看各的：「项目A」左边紧贴、右边隔开；「2024项目」反过来；「.dotfiles」开头的半角点也算西文（#320，与 joinList 同一套）
  assert.equal(formatMessage(tpl, { place: "项目A", name: "pdf" }), "从项目A 移除 pdf（不动原件）");
  assert.equal(
    formatMessage("它的原件就在{place}里", { place: "2024项目" }),
    "它的原件就在 2024项目里",
  );
  assert.equal(
    formatMessage(tpl, { place: ".dotfiles", name: "x" }),
    "从 .dotfiles 移除 x（不动原件）",
  );
  // 句首、句尾没有相邻字，不加
  assert.equal(formatMessage("{place}的来源", { place: "CardBox" }), "CardBox 的来源");
  assert.equal(formatMessage("添加来源到{place}", { place: "CardBox" }), "添加来源到 CardBox");
  // 英文模板里名字两侧本来就是空格或标点
  assert.equal(
    formatMessage("Remove {name} from {place}?", { place: "CardBox", name: "pdf" }),
    "Remove pdf from CardBox?",
  );
  // 缺参数的占位符原样留着
  assert.equal(formatMessage("从{place}移除", {}), "从{place}移除");
  // 目录里写了空格的句子不受影响；名字以汉字收尾时那个空格就多出来了（所以嵌名字的句子要写紧贴的）
  assert.equal(formatMessage("{n} 个 skill", { n: 3 }), "3 个 skill");
  assert.equal(
    formatMessage("重启 {app} 后生效", { app: "Claude 桌面应用" }),
    "重启 Claude 桌面应用 后生效",
  );
  assert.equal(
    formatMessage("重启{app}后生效", { app: "Claude 桌面应用" }),
    "重启 Claude 桌面应用后生效",
  );
});

test("tRich 的字符串参数按同样的规则空格，React 节点原样放", async () => {
  const { formatRich } = await import("../src/i18n.ts");
  const { createElement } = await import("react");
  const node = createElement("b", null, "pdf");
  const parts = (out: unknown) => (out as { props: { children: unknown[] } }).props.children;
  assert.deepEqual(parts(formatRich("加到{place}{names}", { place: "CardBox", names: node })), [
    "加到",
    " CardBox",
    node,
  ]);
  assert.deepEqual(parts(formatRich("加到{place}{names}", { place: "用户级", names: node })), [
    "加到",
    "用户级",
    node,
  ]);
});
