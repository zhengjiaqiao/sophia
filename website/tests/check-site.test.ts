/// 构建检查（spec 2026-10-06-website AC9、AC12、AC14 的静态部分）：
/// 三份文案缺键、HTML 里残留 {占位符}、白名单外的域名、hreflang 不全、关 JS 看不到文案与下载链接，
/// 都要失败并指出是哪个。检查函数不碰文件系统，输入是目录读出来的内容，这里直接喂内存里的夹具。
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkBase,
  checkCatalogs,
  checkDomains,
  checkPage,
  flattenCatalog,
  PAGES,
  STATIC_KEYS,
} from "../scripts/check-site.ts";

const ctx = {
  base: "/",
  minMacos: "14",
  staticTexts: ["装上 Sophia，"],
  downloadHrefs: ["https://github.com/zhengjiaqiao/sophia/releases/latest"],
  providerSub: "选一家就好。70 多家的地址都已填好，填错了当场告诉你。",
};

const goodHead = `<html lang="zh-Hans"><head>
<link rel="alternate" hreflang="en" href="https://sophiakit.com/">
<link rel="alternate" hreflang="zh-Hans" href="https://sophiakit.com/zh-hans/">
<link rel="alternate" hreflang="zh-Hant" href="https://sophiakit.com/zh-hant/">
<link rel="alternate" hreflang="x-default" href="https://sophiakit.com/">
</head>`;
const goodBody = `<body><h2>装上 Sophia，</h2><p>免费开源 · macOS 14 及以上</p><p>选一家就好。70 多家的地址都已填好，填错了当场告诉你。</p>
<a href="https://github.com/zhengjiaqiao/sophia/releases/latest">下载</a></body></html>`;

test("flattenCatalog：嵌套的区块展平成 区块.名字，占位符之外的值原样", () => {
  assert.deepEqual(flattenCatalog({ hero: { title1: "甲", sub: { a: "乙 {n}" } } }), {
    "hero.title1": "甲",
    "hero.sub.a": "乙 {n}",
  });
});

test("AC9：某种语言缺了键、多了键、同一条占位符对不上，都指出是哪个键", () => {
  const problems = checkCatalogs({
    "zh-Hans": { a: { x: "好 {n}", y: "好" } },
    en: { a: { x: "ok {m}", z: "extra" } },
    "zh-Hant": { a: { x: "好 {n}", y: "好" } },
  });
  assert.deepEqual(problems, [
    "en 缺 a.y",
    "en 多了 a.z（zh-Hans 没有）",
    "a.x 的占位符不一致：zh-Hans {n}，en {m}",
  ]);
});

test("三份目录齐全一致时没有问题", () => {
  const c = { a: { x: "好 {n}" } };
  assert.deepEqual(checkCatalogs({ "zh-Hans": c, en: c, "zh-Hant": c }), []);
});

test("干净的页面没有问题", () => {
  assert.deepEqual(checkPage("zh-hans/index.html", goodHead + goodBody, ctx), []);
});

test("AC9：HTML 里残留 {占位符}，指出页面与占位符；脚本与样式里的花括号不算", () => {
  const bad = goodHead + goodBody.replace("下载", "下载 {agent}");
  assert.deepEqual(checkPage("zh-hans/index.html", bad, ctx), [
    "zh-hans/index.html：残留占位符 {agent}",
  ]);
  const withCode = goodHead + `<style>a{color:red}</style><script>if(1){}</script>` + goodBody;
  assert.deepEqual(checkPage("zh-hans/index.html", withCode, ctx), []);
});

test("AC9：白名单外的域名指出是哪个；GitHub、自己的域名与 SVG 命名空间放行", () => {
  const bad = goodHead + goodBody + `<script src="https://cdn.example.com/x.js"></script>`;
  assert.deepEqual(checkPage("index.html", bad, ctx), [
    "index.html：白名单外的域名 cdn.example.com",
  ]);
  const ok = goodHead + goodBody + `<svg xmlns="http://www.w3.org/2000/svg"></svg>`;
  assert.deepEqual(checkPage("index.html", ok, ctx), []);
});

test("R22：HTML 里的 gsap.com 要报（只有许可声明与 GSAP 打包脚本里的字符串可以带它）", () => {
  const bad = goodHead + goodBody + `<script src="https://gsap.com/x.js"></script>`;
  assert.deepEqual(checkPage("index.html", bad, ctx), ["index.html：白名单外的域名 gsap.com"]);
  assert.deepEqual(checkDomains("THIRD-PARTY-NOTICES.txt", "GSAP, https://gsap.com/standard-license"), []);
  const chunk = "warn(`GSAP target ${t} not found. https://gsap.com`)";
  assert.deepEqual(checkDomains("_astro/ending.abc.js", chunk), []);
  // 别的脚本、样式里仍然不行
  assert.deepEqual(checkDomains("_astro/other.js", "fetch('https://gsap.com/x')"), ["_astro/other.js：白名单外的域名 gsap.com"]);
  assert.deepEqual(checkDomains("_astro/a.css", "@import 'https://gsap.com/x.css'"), ["_astro/a.css：白名单外的域名 gsap.com"]);
});

test("R22：域名精确匹配，白名单域名的子域也要报（cdn.github.com、www.sophiakit.com）", () => {
  assert.deepEqual(checkDomains("index.html", `<script src="https://cdn.github.com/x.js"></script>`), [
    "index.html：白名单外的域名 cdn.github.com",
  ]);
  assert.deepEqual(checkDomains("a.js", "https://www.sophiakit.com/ https://sophiakit.com/"), [
    "a.js：白名单外的域名 www.sophiakit.com",
  ]);
});

test("R22：协议相对的 //host/… 也要报；注释里的 // 与白名单内的不误伤", () => {
  assert.deepEqual(checkDomains("index.html", `<script src="//evil.example/x.js"></script>`), [
    "index.html：白名单外的域名 evil.example",
  ]);
  assert.deepEqual(checkDomains("a.js", "// 注释 and //github.com/x and a.b"), []);
});

test("R2：缺了某个语言的 hreflang 或 x-default 都要报", () => {
  const head = goodHead.replace(/<link rel="alternate" hreflang="zh-Hant"[^>]*>\n/, "");
  assert.deepEqual(checkPage("index.html", head + goodBody, ctx), ["index.html：缺 hreflang zh-Hant"]);
});

test("AC12：最低系统版本要与应用配置一致", () => {
  const stale = goodHead + goodBody.replace("macOS 14", "macOS 13");
  assert.deepEqual(checkPage("index.html", stale, ctx), ["index.html：缺「macOS 14」（应用最低系统版本）"]);
});

test("AC14：关掉 JS 也要看到文案与下载链接，缺了指出缺哪个", () => {
  const noText = goodHead + goodBody.replace("装上 Sophia，", "");
  assert.deepEqual(checkPage("index.html", noText, ctx), ["index.html：静态 HTML 里没有文案「装上 Sophia，」"]);
  const noLink = goodHead + goodBody.replace(/<a href[^>]*>/, "<a>");
  assert.deepEqual(checkPage("index.html", noLink, ctx), [
    "index.html：静态 HTML 里没有下载链接 https://github.com/zhengjiaqiao/sophia/releases/latest",
  ]);
});

test("R18：页面文字里出现版本号（0.1.1、v0.2.0）要报；macOS 14、14.4 不算", () => {
  const withText = (s: string) => goodHead + goodBody.replace("下载", s);
  assert.ok(checkPage("a.html", withText("下载 v0.1.1"), ctx).some((p) => p.includes("版本号") && p.includes("0.1.1")));
  assert.ok(checkPage("a.html", withText("Sophia 0.2.0"), ctx).some((p) => p.includes("版本号")));
  assert.deepEqual(checkPage("a.html", withText("需要 macOS 14.4"), ctx), []);
});

test("三个页面的路径与语言对得上", () => {
  assert.deepEqual(
    PAGES.map((p) => [p.lang, p.file]),
    [
      ["en", "index.html"],
      ["zh-Hans", "zh-hans/index.html"],
      ["zh-Hant", "zh-hant/index.html"],
    ],
  );
  assert.ok(STATIC_KEYS.includes("install.title1"));
});

test("AC12：模型区写的服务商数要和预设一致：数不对（或写成别的数）就报错", () => {
  const stale = goodHead + goodBody.replace("70 多家", "100 多家");
  assert.deepEqual(checkPage("zh-hans/index.html", stale, ctx), [
    "zh-hans/index.html：静态 HTML 里没有服务商数的说法「选一家就好。70 多家的地址都已填好，填错了当场告诉你。」（应用预设向下取整到十）",
  ]);
});

test("#286：带子路径构建时，页面里的站内地址都要带上它（缺了在 GitHub Pages 上就是 404）", () => {
  const sub = { ...ctx, base: "/sophia/" };
  const page =
    goodHead +
    goodBody +
    `<link rel="stylesheet" href="/sophia/_astro/a.css"><script type="module" src="/_astro/a.js"></script><img src="/_astro/cat.png" srcset="/sophia/_astro/a.png 1x, /_astro/b.png 2x"><a href="/zh-hans/">`;
  assert.deepEqual(checkPage("index.html", page, sub), [
    "index.html：站内地址 /_astro/a.js 没带子路径 /sophia/",
    "index.html：站内地址 /_astro/b.png 没带子路径 /sophia/",
    "index.html：站内地址 /_astro/cat.png 没带子路径 /sophia/",
    "index.html：站内地址 /zh-hans/ 没带子路径 /sophia/",
  ]);
});

test("#286：样式里的 url(/…) 也要带子路径；不带子路径构建、外部地址、协议相对地址、锚点都不算", () => {
  const css = "a{background:url(/_astro/x.woff2)} b{background:url('/sophia/_astro/y.woff2')} c{background:url(\"/_astro/z.png\")}";
  assert.deepEqual(checkBase("_astro/a.css", css, "/sophia/"), [
    "_astro/a.css：站内地址 /_astro/x.woff2 没带子路径 /sophia/",
    "_astro/a.css：站内地址 /_astro/z.png 没带子路径 /sophia/",
  ]);
  assert.deepEqual(checkBase("index.html", `<a href="/x/"></a>`, "/"), []);
  assert.deepEqual(
    checkBase("index.html", `<a href="//github.com/a"></a><a href="#top"></a><a href="https://github.com/x"></a>`, "/sophia/"),
    [],
  );
});
