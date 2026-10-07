/// 首页语言跳转（spec R2、AC1）：cookie 优先，否则 Accept-Language；只有 zh 系会跳
import assert from "node:assert/strict";
import test from "node:test";
import { handleIndex, pickLang } from "../functions/_lib/lang.ts";
import { LANG_COOKIE } from "../src/lib/langs.ts";

test("cookie 名与取值是语言菜单（#185）的契约", () => {
  assert.equal(LANG_COOKIE, "lang");
});

test("AC1：zh-CN → 简体，zh-TW / zh-HK / zh-Hant → 繁体，en-US 留在 /", () => {
  assert.equal(pickLang({ acceptLanguage: "zh-CN,zh;q=0.9" }), "zh-Hans");
  assert.equal(pickLang({ acceptLanguage: "zh" }), "zh-Hans");
  assert.equal(pickLang({ acceptLanguage: "zh-TW,zh;q=0.9,en;q=0.8" }), "zh-Hant");
  assert.equal(pickLang({ acceptLanguage: "zh-HK" }), "zh-Hant");
  assert.equal(pickLang({ acceptLanguage: "zh-MO" }), "zh-Hant");
  assert.equal(pickLang({ acceptLanguage: "zh-Hant" }), "zh-Hant");
  assert.equal(pickLang({ acceptLanguage: "zh-Hans-CN" }), "zh-Hans");
  assert.equal(pickLang({ acceptLanguage: "en-US,en;q=0.9" }), "en");
  assert.equal(pickLang({ acceptLanguage: "ja" }), "en");
  assert.equal(pickLang({}), "en");
});

test("Accept-Language 按权重取最优先的一个，不是看有没有 zh", () => {
  assert.equal(pickLang({ acceptLanguage: "en;q=0.9,zh-CN;q=0.5" }), "en");
  assert.equal(pickLang({ acceptLanguage: "en;q=0.5,zh-TW;q=0.9" }), "zh-Hant");
});

test("有 lang cookie 就按 cookie，不看 Accept-Language；无效值当没有", () => {
  assert.equal(pickLang({ cookie: "lang=en", acceptLanguage: "zh-CN" }), "en");
  assert.equal(pickLang({ cookie: "a=1; lang=zh-Hant", acceptLanguage: "en-US" }), "zh-Hant");
  assert.equal(pickLang({ cookie: "lang=zh-Hans", acceptLanguage: "en-US" }), "zh-Hans");
  assert.equal(pickLang({ cookie: "lang=xx", acceptLanguage: "zh-CN" }), "zh-Hans");
});

const next = async () => new Response("<html>en</html>", { headers: { "content-type": "text/html" } });
const req = (h: Record<string, string>) => new Request("https://sophiakit.com/", { headers: h });

test("AC1：zh-CN 无 cookie → 302 /zh-hans/，带 Vary", async () => {
  const res = await handleIndex(req({ "accept-language": "zh-CN" }), next);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/zh-hans/");
  assert.equal(res.headers.get("vary"), "Accept-Language, Cookie");
});

test("AC1：zh-TW → /zh-hant/", async () => {
  const res = await handleIndex(req({ "accept-language": "zh-TW" }), next);
  assert.equal(res.headers.get("location"), "/zh-hant/");
});

test("AC1：en-US 不跳，放行静态页，也带 Vary", async () => {
  const res = await handleIndex(req({ "accept-language": "en-US" }), next);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<html>en</html>");
  assert.equal(res.headers.get("vary"), "Accept-Language, Cookie");
  assert.equal(res.headers.get("content-type"), "text/html");
});

test("AC1：选过英文（cookie lang=en）后，浏览器是 zh-CN 也不再跳", async () => {
  const res = await handleIndex(req({ "accept-language": "zh-CN", cookie: "lang=en" }), next);
  assert.equal(res.status, 200);
});

test("AC1：cookie 选了繁体，浏览器是 en-US 也跳到繁体", async () => {
  const res = await handleIndex(req({ "accept-language": "en-US", cookie: "lang=zh-Hant" }), next);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/zh-hant/");
});

test("放行的响应已有 Vary 时合并，不覆盖", async () => {
  const withVary = async () => new Response("x", { headers: { vary: "Accept-Encoding" } });
  const res = await handleIndex(req({}), withVary);
  assert.equal(res.headers.get("vary"), "Accept-Encoding, Accept-Language, Cookie");
});
