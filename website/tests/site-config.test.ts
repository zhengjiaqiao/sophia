/// 站点配置里「从仓库数据算」的几个数（spec R4、R9、R12）：最低系统版本取自应用配置，服务商数向下取整到十
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

test("下载链接：两种芯片各一个，都走下载函数（页面不写版本号）", () => {
  assert.equal(SITE.downloadHref.arm64, "/download/mac?arch=arm64");
  assert.equal(SITE.downloadHref.x64, "/download/mac?arch=x64");
  assert.deepEqual(SITE.downloadHrefs, [...new Set([SITE.downloadHref.arm64, SITE.downloadHref.x64])]);
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
