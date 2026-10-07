/// 取文案（website/src/i18n.ts）：键写字面量，缺键、缺参数、多余参数都在构建时抛错并指出是哪个键，
/// 这样三份目录缺键、占位符没填的页面根本构建不出来（AC9 的第一道关，check-site 再兜一道）
import assert from "node:assert/strict";
import test from "node:test";
import { makeT } from "../src/i18n.ts";

const cat = {
  "zh-Hans": { a: { plain: "你好", param: "加到 {agent}", two: "{x}-{x}" } },
  en: { a: { plain: "Hello", param: "Add to {agent}" } },
} as const;
const t = makeT(cat as never);

test("按语言取整句，嵌套键用点连接", () => {
  assert.equal(t("zh-Hans", "a.plain"), "你好");
  assert.equal(t("en", "a.plain"), "Hello");
});

test("参数替换：同一个占位符出现多次都换", () => {
  assert.equal(t("zh-Hans", "a.param", { agent: "Codex" }), "加到 Codex");
  assert.equal(t("zh-Hans", "a.two", { x: "1" }), "1-1");
});

test("缺键：抛错并写明语言与键", () => {
  assert.throws(() => t("en", "a.two"), /en 缺文案键 a\.two/);
  assert.throws(() => t("zh-Hans", "a.nope"), /zh-Hans 缺文案键 a\.nope/);
});

test("占位符没给参数：抛错并写明是哪个键、哪个占位符", () => {
  assert.throws(() => t("zh-Hans", "a.param"), /a\.param.*\{agent\}/);
});

test("给了用不上的参数：抛错（多半是键写错了）", () => {
  assert.throws(() => t("zh-Hans", "a.plain", { agent: "x" }), /a\.plain.*agent/);
});

test("取到的不是整句（键指到了一个区块）：抛错", () => {
  assert.throws(() => t("zh-Hans", "a"), /a.*不是一句文案/);
});
