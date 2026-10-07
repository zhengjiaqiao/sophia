/// 站点配置里「从仓库数据算」的几个数（spec R4、R9、R12）：最低系统版本取自应用配置，服务商数向下取整到十
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LATEST_DMG } from "../../packaging/cos-manifest.mjs";
import { siteUrl } from "../src/lib/siteUrl.ts";
import { floorToTen, macosLabel, SITE } from "../src/site.config.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

test("最低系统版本：去掉尾部的 .0，其余原样", () => {
  assert.equal(macosLabel("14.0"), "14");
  assert.equal(macosLabel("14.4"), "14.4");
  assert.equal(macosLabel("15"), "15");
});

test("SITE.minMacos 与 tauri.conf.json 一致（独立读一遍核对）", () => {
  const conf = JSON.parse(readFileSync(repo("src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(SITE.minMacos, macosLabel(conf.bundle.macOS.minimumSystemVersion));
});

test("服务商数向下取整到十：74 → 70，70 → 70，9 → 0", () => {
  assert.equal(floorToTen(74), 70);
  assert.equal(floorToTen(70), 70);
  assert.equal(floorToTen(9), 0);
});

test("SITE.providerFloor 取自内置预设的条数", () => {
  const n = JSON.parse(readFileSync(repo("crates/core/data/provider-presets.json"), "utf8")).providers.length;
  assert.equal(SITE.providerFloor, Math.floor(n / 10) * 10);
});

test("下载链接：两种芯片各一个，直链 COS 上固定文件名的最新版（页面不写版本号，关 JS 也能下）", () => {
  const cos = "https://sophia-releases-1258113621.cos.ap-shanghai.myqcloud.com";
  assert.equal(SITE.downloadHref.arm64, `${cos}/latest/Sophia_aarch64.dmg`);
  assert.equal(SITE.downloadHref.x64, `${cos}/latest/Sophia_x64.dmg`);
  assert.deepEqual(SITE.downloadHrefs, [SITE.downloadHref.arm64, SITE.downloadHref.x64]);
});

test("下载链接的桶就是应用更新的 COS 线路（tauri.conf.json 里 myqcloud.com 的那条）", () => {
  const conf = JSON.parse(readFileSync(repo("src-tauri/tauri.conf.json"), "utf8"));
  const manifest: string = conf.plugins.updater.endpoints.find((u: string) => u.includes(".myqcloud.com/"));
  const base = manifest.replace(/latest\.json$/, "");
  assert.ok(SITE.downloadHref.arm64.startsWith(base));
  assert.ok(SITE.downloadHref.x64.startsWith(base));
});

test("部署地址：SITE_URL 拆成源与子路径；没给就是正式域名、不带子路径", () => {
  const gh = siteUrl("https://zhengjiaqiao.github.io/sophia/");
  assert.equal(gh.origin, "https://zhengjiaqiao.github.io");
  assert.equal(gh.base, "/sophia/");
  assert.equal(gh.href("/"), "/sophia/");
  assert.equal(gh.href("/zh-hans/"), "/sophia/zh-hans/");
  assert.equal(siteUrl("https://zhengjiaqiao.github.io/sophia").base, "/sophia/");
  const root = siteUrl(undefined);
  assert.equal(root.origin, "https://sophiakit.com");
  assert.equal(root.base, "/");
  assert.equal(root.href("/zh-hant/"), "/zh-hant/");
  assert.equal(siteUrl("").base, "/");
});

test("部署地址只认 https，带查询或锚点的拒绝", () => {
  assert.throws(() => siteUrl("http://example.com/"), /https/);
  assert.throws(() => siteUrl("https://example.com/a/?x=1"), /SITE_URL/);
});

test("brew 命令与 cask 模板的 tap 路径一致", () => {
  assert.equal(SITE.brewCommand, "brew install --cask zhengjiaqiao/tap/sophia");
});

test("R17.1 的 agent 名单只写一处：每项有 id 与名字，id 不重复", () => {
  const ids = SITE.agents.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(SITE.agents.length >= 2);
  for (const a of SITE.agents) assert.ok(a.id && a.name);
});
