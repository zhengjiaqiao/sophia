/// 文案模板的占位约定：全站只有 `[[x]]` 一种，服务端 `slot` 造记号、浏览器 `fillTemplate` 换真值。
import assert from "node:assert/strict";
import test from "node:test";
import { stateText } from "../src/demos/skills-matrix.ts";
import { t } from "../src/i18n.ts";
import { fillTemplate, slot, slots } from "../src/lib/template.ts";

test("slot / slots 造出 [[x]] 记号", () => {
  assert.equal(slot("agent"), "[[agent]]");
  assert.deepEqual(slots("name", "agent"), { name: "[[name]]", agent: "[[agent]]" });
});

test("fillTemplate：换掉所有同名记号，数字也行，没给的换成空串，没有记号的原样", () => {
  assert.equal(fillTemplate("剩 [[pct]]，[[pct]]", { pct: "58%" }), "剩 58%，58%");
  assert.equal(fillTemplate("[[n]] 个", { n: 3 }), "3 个");
  assert.equal(fillTemplate("[[a]]-[[b]]", { a: "x" }), "x-");
  assert.equal(fillTemplate("没有记号 {x}", {}), "没有记号 {x}");
});

test("经 t 取出的带记号整句：记号原样留下（不撞目录的 {x} 检查），再 fillTemplate 得到真句子", () => {
  const raw = t("zh-Hans", "skills.added", { agent: slot("agent") });
  assert.ok(raw.includes("[[agent]]") && !/[{}]/.test(raw));
  assert.equal(fillTemplate(raw, { agent: "Codex" }), t("zh-Hans", "skills.added", { agent: "Codex" }));
});

test("stateText：四种状态在三种语言里各是图例的一句，互不相同", () => {
  for (const lang of ["en", "zh-Hans", "zh-Hant"] as const) {
    const texts = (["added", "open", "original", "broken"] as const).map((s) => stateText(lang, s));
    assert.equal(new Set(texts).size, 4);
  }
});
