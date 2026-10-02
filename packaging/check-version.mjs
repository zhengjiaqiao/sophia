#!/usr/bin/env node
// 版本号只有一个来源：src-tauri/tauri.conf.json 的 version。
//
// 为什么是它：Tauri 把这个值写进 Info.plist 和安装包文件名，更新器比较的也是它。
// Cargo.toml 与 package.json 里的 version 对构建没有影响，但留着旧值会骗人，
// 所以这里不让它们各说各的——对不上就红，由人去改，脚本不代劳。
//
// 用法：
//   node packaging/check-version.mjs              # 三处一致即通过
//   node packaging/check-version.mjs --tag v0.2.0 # 再要求 tag 与之对齐
//   node packaging/check-version.mjs --print      # 只打印版本号（供 workflow 取值）
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), "utf8");

const SOURCE = "src-tauri/tauri.conf.json";
const version = JSON.parse(read(SOURCE)).version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`✗ ${SOURCE} 的 version 不是 x.y.z：${JSON.stringify(version)}`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes("--print")) {
  process.stdout.write(version);
  process.exit(0);
}

const problems = [];

// Cargo.toml：只认 [package] 段里的第一个 version，别的段（[dependencies] 里的）不算
const cargo = read("src-tauri/Cargo.toml");
const pkgSection = cargo.split(/^\[/m).find((s) => s.startsWith("package]"));
const cargoVersion = pkgSection?.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
if (cargoVersion !== version) {
  problems.push(`src-tauri/Cargo.toml 是 ${cargoVersion ?? "（没读到）"}，应为 ${version}`);
}

const npmVersion = JSON.parse(read("package.json")).version;
if (npmVersion !== version) {
  problems.push(`package.json 是 ${npmVersion ?? "（没读到）"}，应为 ${version}`);
}

const tagIndex = args.indexOf("--tag");
if (tagIndex !== -1) {
  const tag = args[tagIndex + 1] ?? "";
  if (tag !== `v${version}`) {
    problems.push(`tag 是 ${tag || "（空）"}，应为 v${version}`);
  }
}

if (problems.length > 0) {
  console.error(`✗ 版本号对不上。唯一来源是 ${SOURCE}（${version}）：`);
  for (const p of problems) console.error(`    ${p}`);
  console.error(`  改完三处再打 tag；只改一处会让安装包、更新清单和 cask 各说各的。`);
  process.exit(1);
}

console.log(`✓ 版本号 ${version}（来源 ${SOURCE}），Cargo.toml、package.json${tagIndex !== -1 ? "、tag" : ""} 一致`);
