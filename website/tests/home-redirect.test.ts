/// 首页语言跳转（spec R2、AC1；#286 起在页面里做）：cookie 优先，否则看浏览器语言；只有 zh 系会跳。
/// 假的 window，不碰 DOM；最后一条确认函数源码单独拿出来也能跑（Page.astro 是把源码内联进页面的）
import assert from "node:assert/strict";
import test from "node:test";
import { homeRedirect, type RedirectWindow } from "../src/lib/homeRedirect.ts";
import { LANG_COOKIE } from "../src/lib/langs.ts";

const PATHS = { en: "/sophia/", "zh-Hans": "/sophia/zh-hans/", "zh-Hant": "/sophia/zh-hant/" };

function win(opts: {
  languages?: string[];
  language?: string;
  cookie?: string;
  search?: string;
  hash?: string;
}) {
  const went: string[] = [];
  const w: RedirectWindow = {
    document: { cookie: opts.cookie ?? "" },
    navigator: { languages: opts.languages, language: opts.language },
    location: { search: opts.search ?? "", hash: opts.hash ?? "", replace: (u) => went.push(u) },
  };
  return { w, went };
}

const go = (opts: Parameters<typeof win>[0], run = homeRedirect) => {
  const { w, went } = win(opts);
  const to = run("en", PATHS, LANG_COOKIE, w);
  assert.deepEqual(went, to === null ? [] : [to], "返回值就是跳去的地址");
  return to;
};

test("cookie 名与取值是语言菜单（#185）的契约", () => {
  assert.equal(LANG_COOKIE, "lang");
});

test("AC1：zh-CN → 简体，zh-TW / zh-HK / zh-MO / zh-Hant → 繁体，别的语言留在英文页", () => {
  assert.equal(go({ languages: ["zh-CN", "zh"] }), "/sophia/zh-hans/");
  assert.equal(go({ languages: ["zh"] }), "/sophia/zh-hans/");
  assert.equal(go({ languages: ["zh-Hans-CN"] }), "/sophia/zh-hans/");
  assert.equal(go({ languages: ["zh-TW", "zh", "en"] }), "/sophia/zh-hant/");
  assert.equal(go({ languages: ["zh-HK"] }), "/sophia/zh-hant/");
  assert.equal(go({ languages: ["zh-MO"] }), "/sophia/zh-hant/");
  assert.equal(go({ languages: ["zh-Hant"] }), "/sophia/zh-hant/");
  assert.equal(go({ languages: ["en-US", "en"] }), null);
  assert.equal(go({ languages: ["ja"] }), null);
  assert.equal(go({ languages: [] }), null);
  assert.equal(go({}), null);
});

test("按浏览器最优先的那一个语言，不是看列表里有没有 zh", () => {
  assert.equal(go({ languages: ["en", "zh-CN"] }), null);
  assert.equal(go({ languages: ["zh-TW", "en"] }), "/sophia/zh-hant/");
});

test("没有 navigator.languages 的老浏览器看 navigator.language", () => {
  assert.equal(go({ language: "zh-CN" }), "/sophia/zh-hans/");
});

test("AC1：选过的语言（lang cookie）优先；选过英文就不再跳；无效值当没有", () => {
  assert.equal(go({ cookie: "lang=en", languages: ["zh-CN"] }), null);
  assert.equal(go({ cookie: "a=1; lang=zh-Hant", languages: ["en-US"] }), "/sophia/zh-hant/");
  assert.equal(go({ cookie: "lang=zh-Hans", languages: ["en-US"] }), "/sophia/zh-hans/");
  assert.equal(go({ cookie: "lang=xx", languages: ["zh-CN"] }), "/sophia/zh-hans/");
  assert.equal(go({ cookie: "xlang=zh-Hant", languages: ["en-US"] }), null);
});

test("跳过去时带上查询与锚点（分享的 /#install 落到对应语言页的同一处）", () => {
  assert.equal(
    go({ languages: ["zh-CN"], search: "?from=x", hash: "#install" }),
    "/sophia/zh-hans/?from=x#install",
  );
});

test("函数源码单独拿出来也能跑：Page.astro 内联的就是这段源码，不能引用别的名字", () => {
  const inlined = new Function(`return (${String(homeRedirect)})`)() as typeof homeRedirect;
  assert.equal(go({ languages: ["zh-TW"] }, inlined), "/sophia/zh-hant/");
  assert.equal(go({ cookie: "lang=zh-Hans", languages: ["en"] }, inlined), "/sophia/zh-hans/");
  assert.equal(go({ languages: ["en"] }, inlined), null);
});
