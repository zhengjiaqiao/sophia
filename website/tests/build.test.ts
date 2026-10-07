/// 构建产物测试（AC9、AC14、R22）：真的把站点构建到临时目录，再用 CLI 跑一遍构建检查；
/// 然后在产物与文案目录里造错，确认检查会失败并指出是哪个。需要先 `npm ci`（make test-site 会保证）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import { fileURLToPath } from "node:url";
import { SITE } from "../src/site.config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" };
let dist = "";

const check = (args: string[]) =>
  spawnSync(process.execPath, [join(root, "scripts/check-site.ts"), ...args], { encoding: "utf8", env });

before(() => {
  const out = mkdtempSync(join(tmpdir(), "sophia-site-"));
  const r = spawnSync(process.execPath, [join(root, "node_modules/astro/bin/astro.mjs"), "build", "--outDir", out], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  assert.equal(r.status, 0, `astro build 失败：\n${r.stdout}\n${r.stderr}`);
  dist = out;
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
