/// 换成 English / 繁體后的读数（spec AC10 的代理验证）：日期按语言排、相对时间嵌在句中时小写、
/// 列表与复数按英文写。每条测完切回简体，别的测试照简体断言
import assert from "node:assert/strict";
import test from "node:test";
import { listText, setLocale, t, tn } from "../src/i18n.ts";
import { relativeTime, shortDate } from "../src/dateText.ts";
import { clockText } from "../src/market/updateView.ts";
import {
  addButtonLabel,
  addLabel,
  addedParts,
  loadFailedText,
  nothingChecked,
  readingText,
  suggestedLabel,
} from "../src/pages/addSourceView.ts";
import { manageSources } from "../src/pages/sourcesView.ts";

const inLang = (lang: "en" | "zh-Hant", fn: () => void) => {
  setLocale(lang);
  try {
    fn();
  } finally {
    setLocale("zh-Hans");
  }
};

const now = new Date(2026, 8, 30, 15, 0);

test("AC10：English 下抽屉「改于」写作 Modified Sep 20，跨年带年份；简体照旧 9月20日", () => {
  const sep20 = new Date(2026, 8, 20).getTime();
  assert.equal(t("skills.readout.modified", { date: shortDate(sep20, now) }), "改于 9月20日");
  inLang("en", () => {
    assert.equal(t("skills.readout.modified", { date: shortDate(sep20, now) }), "Modified Sep 20");
    assert.equal(shortDate(new Date(2025, 8, 20).getTime(), now), "Sep 20, 2025");
  });
});

test("相对时间：English 独立成句写 Just now、嵌在句中写 just now；分钟按单复数", () => {
  const at = (minutesAgo: number) => now.getTime() - minutesAgo * 60_000;
  inLang("en", () => {
    assert.equal(relativeTime(at(0), now), "Just now");
    assert.equal(relativeTime(at(0), now, true), "just now");
    assert.equal(relativeTime(at(1), now), "1 min ago");
    assert.equal(relativeTime(at(3), now), "3 min ago");
  });
  assert.equal(relativeTime(at(0), now, true), "刚刚");
  assert.equal(relativeTime(at(3), now), "3 分钟前");
});

test("更新检查的时刻：日期按语言排（Sep 20 14:32），今天 / 昨天照旧", () => {
  const at = (d: Date) => d.getTime() / 1000;
  assert.equal(clockText(at(new Date(2026, 8, 20, 14, 32)), now), "9月20日 14:32");
  inLang("en", () => {
    assert.equal(clockText(at(new Date(2026, 8, 20, 14, 32)), now), "Sep 20 14:32");
    assert.equal(clockText(at(new Date(2026, 8, 30, 9, 5)), now), "Today 09:05");
  });
});

test("English 的列表与计数：A, B, and C；1 个与多个写法不同", () => {
  inLang("en", () => {
    assert.equal(listText(["Claude Code", "Codex", "Cursor"]), "Claude Code, Codex, and Cursor");
    assert.notEqual(tn("sources.count.skill", 1), tn("sources.count.skill", 2).replace("2", "1"));
  });
});

test("定宽处 English 用短写（第三批画板 2A 4A 6A）：窗口 5h / Week / 12h / 2d，键 Restart，要填的 API key / Sign-in；全句留在提示框", () => {
  inLang("en", () => {
    assert.equal(t("usage.window.session"), "5h");
    assert.equal(t("usage.window.weekly"), "Week");
    assert.equal(t("usage.window.weeklyModel", { name: "Fable" }), "Week · Fable");
    assert.equal(tn("usage.window.hours", 1), "1h");
    assert.equal(tn("usage.window.hours", 12), "12h");
    assert.equal(tn("usage.window.days", 1), "1d");
    assert.equal(tn("usage.window.days", 2), "2d");
    assert.equal(t("models.control.restartKey"), "Restart");
    // 键面短写，提示框（另一个键）仍是全句
    assert.match(
      t("models.tip.restart", { app: "Codex" }),
      /^Restart the Codex desktop app to apply the change/,
    );
    assert.equal(t("market.mcp.needsKey"), "API key");
    assert.equal(t("market.mcp.needsSignIn"), "Sign-in");
  });
  // 简体、繁體不变
  assert.equal(t("usage.window.session"), "5 小时");
  assert.equal(t("usage.window.weeklyModel", { name: "Fable" }), "本周 · Fable");
  assert.equal(tn("usage.window.hours", 12), "12 小时");
  assert.equal(t("models.control.restartKey"), "重启生效");
  assert.equal(t("market.mcp.needsKey"), "要填密钥");
  inLang("zh-Hant", () => {
    assert.equal(t("usage.window.weekly"), "本週");
    assert.equal(t("models.control.restartKey"), "重新啟動以套用");
  });
});

test("系统写法：关窗提示框的按钮简体、繁體都是「好」（English OK）；繁體应用菜单的撤销写「還原」，提示条的撤销键仍是「復原」", () => {
  assert.equal(t("tray.closeHint.ok"), "好");
  inLang("zh-Hant", () => {
    assert.equal(t("tray.closeHint.ok"), "好");
    assert.equal(t("shell.menu.undo"), "還原");
    assert.equal(t("skills.undo.label"), "復原");
    assert.equal(t("mcp.action.undo"), "復原");
  });
  inLang("en", () => assert.equal(t("tray.closeHint.ok"), "OK"));
  assert.equal(t("shell.menu.undo"), "撤销");
});

test("名词不当参数拼进句子：English 的原件位置 / 配置文件各是整句，单复数按英文写；简体逐字不变", () => {
  inLang("en", () => {
    assert.equal(manageSources(), "Manage locations");
    assert.equal(addLabel(0, "skill"), "Add location");
    assert.equal(addLabel(1, "skill"), "Add 1 location");
    assert.equal(addLabel(3, "skill"), "Add 3 locations");
    assert.equal(addLabel(0, "MCP"), "Add config file");
    assert.equal(addLabel(1, "MCP"), "Add 1 config file");
    assert.equal(addLabel(3, "MCP"), "Add 3 config files");
    assert.equal(addButtonLabel("skill"), "Add location");
    assert.equal(addButtonLabel("MCP"), "Add config file");
    assert.equal(suggestedLabel("skill"), "Suggested locations");
    assert.equal(suggestedLabel("MCP"), "Suggested config files");
    assert.equal(nothingChecked("skill"), "Select the locations to add first");
    assert.equal(nothingChecked("MCP"), "Select the config files to add first");
    assert.equal(readingText("skill"), "Reading locations");
    assert.equal(loadFailedText("MCP"), "Couldn't read config files");
    assert.equal(t("skills.filter.bySource"), "Filter by location");
    assert.equal(t("skills.filter.sourceKey"), "Location:");
    assert.deepEqual(addedParts(["A", "B"], 5, "skill", false), ["2 locations", "5 skills"]);
    assert.deepEqual(addedParts(["A", "B", "C"], 3, "MCP", false), [
      "3 config files",
      "3 MCP servers",
    ]);
  });
  inLang("zh-Hant", () => {
    assert.equal(manageSources(), "管理原件位置");
    assert.equal(addLabel(3, "MCP"), "加入 3 個設定檔");
    assert.equal(addButtonLabel("skill"), "加入 原件位置");
  });
  assert.equal(manageSources(), "管理原件位置");
  assert.equal(addLabel(3, "skill"), "添加 3 个原件位置");
  assert.equal(addButtonLabel("MCP"), "添加 配置文件");
});
