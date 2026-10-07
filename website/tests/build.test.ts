/// 构建产物测试（AC9、AC14、R22）：真的把站点构建到临时目录，再用 CLI 跑一遍构建检查；
/// 然后在产物与文案目录里造错，确认检查会失败并指出是哪个。需要先 `npm ci`（make test-site 会保证）。
/// 构建两份：不带子路径（以后的 Cloudflare Pages 与阿里云服务器），和 GitHub Pages 的子路径 /sophia/（#286）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { SITE } from "../src/site.config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const GH_PAGES = "https://zhengjiaqiao.github.io/sophia/";
// 不带子路径的那份不能受外面设的 SITE_URL 影响
const { SITE_URL: _, ...outer } = process.env;
const env = { ...outer, ASTRO_TELEMETRY_DISABLED: "1" };
const ghEnv = { ...env, SITE_URL: GH_PAGES };
let dist = "";
let ghDist = "";

const check = (args: string[], e: NodeJS.ProcessEnv = env) =>
  spawnSync(process.execPath, [join(root, "scripts/check-site.ts"), ...args], { encoding: "utf8", env: e });

function build(e: NodeJS.ProcessEnv): string {
  const out = mkdtempSync(join(tmpdir(), "sophia-site-"));
  const r = spawnSync(process.execPath, [join(root, "node_modules/astro/bin/astro.mjs"), "build", "--outDir", out], {
    cwd: root,
    encoding: "utf8",
    env: e,
  });
  assert.equal(r.status, 0, `astro build 失败：\n${r.stdout}\n${r.stderr}`);
  return out;
}

before(() => {
  dist = build(env);
  ghDist = build(ghEnv);
});

test("真构建的产物通过检查：三个语言页都在", () => {
  const r = check(["--dist", dist]);
  assert.equal(r.status, 0, r.stderr);
  for (const f of ["index.html", "zh-hans/index.html", "zh-hant/index.html"])
    assert.ok(readFileSync(join(dist, f), "utf8").includes("<html"), f);
});

test("AC14：产物里没有境外 CDN，字体是自带的 woff2", () => {
  const html = readFileSync(join(dist, "zh-hans/index.html"), "utf8");
  assert.doesNotMatch(html, /fonts\.googleapis|cdnjs|unpkg|jsdelivr/);
  assert.match(html, /\/_astro\/[^"']*\.css/);
});

test("AC9：产物里出现残留 {占位符} 时失败并指出页面与占位符", () => {
  const copy = mkdtempSync(join(tmpdir(), "sophia-site-bad-"));
  cpSync(dist, copy, { recursive: true });
  const p = join(copy, "zh-hant/index.html");
  writeFileSync(p, readFileSync(p, "utf8").replace("<main>", "<main><p>{agent}</p>"));
  const r = check(["--dist", copy]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /zh-hant\/index\.html：残留占位符 \{agent\}/);
});

test("AC9：产物里出现白名单外的域名时失败并指出是哪个", () => {
  const copy = mkdtempSync(join(tmpdir(), "sophia-site-bad-"));
  cpSync(dist, copy, { recursive: true });
  const p = join(copy, "index.html");
  writeFileSync(p, readFileSync(p, "utf8").replace("</head>", '<script src="https://cdn.example.com/a.js"></script></head>'));
  const r = check(["--dist", copy]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /index\.html：白名单外的域名 cdn\.example\.com/);
});

test("AC9：某语言的文案缺一个键时失败并指出是哪个键", () => {
  const loc = mkdtempSync(join(tmpdir(), "sophia-site-loc-"));
  cpSync(join(root, "locales"), loc, { recursive: true });
  const p = join(loc, "en.json");
  const en = JSON.parse(readFileSync(p, "utf8"));
  delete en.install.copy;
  writeFileSync(p, JSON.stringify(en));
  const r = check(["--dist", dist, "--locales", loc]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /en 缺 install\.copy/);
});

test("AC12：模型区的服务商数与预设对不上时失败（真产物里把「70+」改成「100+」）", () => {
  const copy = mkdtempSync(join(tmpdir(), "sophia-site-bad-"));
  cpSync(dist, copy, { recursive: true });
  const p = join(copy, "index.html");
  const html = readFileSync(p, "utf8");
  const floor = SITE.providerFloor;
  assert.match(html, new RegExp(`${floor}\\+ providers`));
  writeFileSync(p, html.replace(`${floor}+ providers`, "100+ providers"));
  const r = check(["--dist", copy]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /index\.html：静态 HTML 里没有服务商数的说法/);
});

test("模型区三步卡在静态 HTML 里就是终态：agent 开关来自名单，结果句已是「做好了」", () => {
  const html = readFileSync(join(dist, "zh-hans/index.html"), "utf8");
  for (const a of SITE.agents) assert.match(html, new RegExp(`role="switch" aria-checked="true" data-agent="${a.id}"`));
  assert.match(html, /<b[^>]*>好了。<\/b>Codex、Claude 已重启，官方模型和新模型都在。/);
});

test("R17.1：首屏短片第 3 镜头的开关名单就是 SITE.agents（全站一处配置），静态样子是开着的", () => {
  for (const file of ["index.html", "zh-hans/index.html", "zh-hant/index.html"]) {
    const html = readFileSync(join(dist, file), "utf8");
    const shot = html.slice(html.indexOf('data-shot="2"'), html.indexOf('data-shot="3"'));
    const rows = [...shot.matchAll(/<div class="swrow"[^>]*><span[^>]*>([^<]*)<\/span><span class="switch" data-on="(\w+)"/g)];
    assert.deepEqual(
      rows.map((m) => m[1]),
      SITE.agents.map((a) => a.name),
      `${file} 的开关名单`,
    );
    assert.ok(rows.every((m) => m[2] === "true"), `${file} 的开关静态样子应是开着`);
  }
});

test("短片第 2–6 镜头（含片尾）在静态 HTML 里：只有第 1 镜头显示，其余收起（关 JS 看到静止帧）", () => {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const shots = [...html.matchAll(/class="shot( on)?"[^>]*data-shot="(\d)"/g)].map((m) => `${m[2]}${m[1] ? "+" : ""}`);
  assert.deepEqual(shots, ["0+", "1", "2", "3", "4", "5"]);
});

test("#286：带子路径 /sophia/ 构建的产物通过检查；站内链接、资源、canonical 都带上子路径", () => {
  const r = check(["--dist", ghDist], ghEnv);
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(join(ghDist, "zh-hans/index.html"), "utf8");
  assert.match(html, /href="\/sophia\/_astro\/[^"]*\.css"/);
  assert.match(html, /<a href="\/sophia\/zh-hant\/" hreflang="zh-Hant"/);
  assert.match(html, /<link rel="canonical" href="https:\/\/zhengjiaqiao\.github\.io\/sophia\/zh-hans\/"/);
  const css = readFileSync(join(ghDist, html.match(/href="\/sophia\/(_astro\/[^"]*\.css)"/)![1]), "utf8");
  assert.match(css, /url\(\/sophia\/_astro\/[^)]*\.woff2\)/);
});

test("#286：带子路径构建的产物里有站内地址漏了子路径时失败并指出是哪个", () => {
  const copy = mkdtempSync(join(tmpdir(), "sophia-site-bad-"));
  cpSync(ghDist, copy, { recursive: true });
  const p = join(copy, "zh-hant/index.html");
  writeFileSync(p, readFileSync(p, "utf8").replace('href="/sophia/zh-hans/"', 'href="/zh-hans/"'));
  const r = check(["--dist", copy], ghEnv);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /zh-hant\/index\.html：站内地址 \/zh-hans\/ 没带子路径 \/sophia\//);
});

test("#286：下载键直链 COS 上固定文件名的最新版，两种构建都一样", () => {
  for (const d of [dist, ghDist]) {
    const html = readFileSync(join(d, "index.html"), "utf8");
    assert.ok(html.includes(`href="${SITE.downloadHref.arm64}"`));
    assert.ok(html.includes(`href="${SITE.downloadHref.x64}"`));
  }
});

/// 取英文页 head 里内联的跳转脚本，在假的 window 里跑一遍，返回它跳去的地址
function runRedirect(file: string, w: { languages: string[]; cookie?: string; hash?: string }): string[] {
  const html = readFileSync(file, "utf8");
  const script = html.match(/<head><meta charset="utf-8"><script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, `${file} 的 head 最前面应有语言跳转脚本`);
  const went: string[] = [];
  const window = {
    document: { cookie: w.cookie ?? "" },
    navigator: { languages: w.languages },
    location: { search: "", hash: w.hash ?? "", replace: (u: string) => went.push(u) },
  };
  runInNewContext(script, { window });
  return went;
}

test("#286：首页按浏览器语言跳转，选过的语言优先；只有英文页带这段脚本", () => {
  const home = join(ghDist, "index.html");
  assert.deepEqual(runRedirect(home, { languages: ["zh-CN"], hash: "#install" }), ["/sophia/zh-hans/#install"]);
  assert.deepEqual(runRedirect(home, { languages: ["zh-TW"] }), ["/sophia/zh-hant/"]);
  assert.deepEqual(runRedirect(home, { languages: ["en-US"] }), []);
  assert.deepEqual(runRedirect(home, { languages: ["zh-CN"], cookie: "lang=en" }), []);
  assert.deepEqual(runRedirect(join(dist, "index.html"), { languages: ["zh-CN"] }), ["/zh-hans/"]);
  for (const f of ["zh-hans/index.html", "zh-hant/index.html"])
    assert.doesNotMatch(readFileSync(join(ghDist, f), "utf8"), /homeRedirect/);
});
