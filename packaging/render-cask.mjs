#!/usr/bin/env node
// 把 packaging/Casks/sophia.rb 的 version 与两个 sha256 换成某次 Release 的真实值。
//
// sha256 只能从产物本身算，不能从别处抄——抄错了用户 brew install 会在校验那步失败，
// 而那时包已经下完了。所以这里老老实实把两个 dmg 下回来算一遍。
//
// 用法：
//   node packaging/render-cask.mjs v0.2.0
//   node packaging/render-cask.mjs            # 用 tauri.conf.json 里的版本
//
// 需要 gh 已登录（CI 里给 GH_TOKEN）。发版后由 .github/workflows/homebrew-cask.yml 调用它，检查通过后推到 tap 仓库；
// 手工跑只用来本机看渲染结果，补推用那个工作流的手动入口。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, readFileSync as read } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = "zhengjiaqiao/sophia";
const CASK = join(root, "packaging", "Casks", "sophia.rb");

const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const configVersion = JSON.parse(read(join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
const tag = process.argv[2] ?? `v${configVersion}`;
const version = tag.replace(/^v/, "");

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20 });

let assets;
try {
  assets = JSON.parse(sh("gh", ["release", "view", tag, "--repo", REPO, "--json", "assets"])).assets;
} catch {
  die(`读不到 ${REPO} 的 Release ${tag}。先确认 tag 发布过，且 gh auth status 是登录状态。`);
}

const dmgs = assets.filter((a) => a.name.endsWith(".dmg"));
const pick = (re) => dmgs.filter((a) => re.test(a.name));
const arm = pick(/aarch64|arm64/i);
const intel = pick(/x64|x86_64|intel/i);
if (arm.length !== 1 || intel.length !== 1) {
  die(
    `Release ${tag} 里没有恰好一个 arm dmg 和一个 intel dmg。实际的 dmg：\n` +
      dmgs.map((a) => `    ${a.name}`).join("\n"),
  );
}

// cask 的 url 是按 Sophia_<版本>_<arch>.dmg 拼出来的。产物改名而这里没跟上，
// brew 会去下一个 404——所以拼出来的名字必须和真实资产名逐字相同，对不上就停。
for (const [archToken, asset] of [
  ["aarch64", arm[0]],
  ["x64", intel[0]],
]) {
  const expected = `Sophia_${version}_${archToken}.dmg`;
  if (asset.name !== expected) {
    die(
      `产物名和 cask 的 url 模板对不上：\n` +
        `    cask 会去下 ${expected}\n` +
        `    Release 上实际叫 ${asset.name}\n` +
        `  改 packaging/Casks/sophia.rb 里的 url 那一行，让它拼得出真实的名字。`,
    );
  }
}

const dir = mkdtempSync(join(tmpdir(), "sophia-cask-"));
const digest = (asset) => {
  console.log(`  取 ${asset.name}…`);
  sh("gh", ["release", "download", tag, "--repo", REPO, "--pattern", asset.name, "--dir", dir]);
  return createHash("sha256").update(readFileSync(join(dir, asset.name))).digest("hex");
};

const armSha = digest(arm[0]);
const intelSha = digest(intel[0]);

const before = readFileSync(CASK, "utf8");
const rules = [
  [/^(\s*version\s+")[^"]*(")/m, `$1${version}$2`],
  [/^(\s*sha256 arm:\s+")[0-9a-f]{64}(")/m, `$1${armSha}$2`],
  [/^(\s*)(intel:\s+")[0-9a-f]{64}(")/m, `$1$2${intelSha}$3`],
];
// 三行都要找得到；找到了而值没变（模板已经是这一版，比如补推同一个 tag）不算错
if (!rules.every(([re]) => re.test(before))) {
  die("version 与两个 sha256 有一行没找到——packaging/Casks/sophia.rb 的格式变了，改这个脚本的正则。");
}
const after = rules.reduce((text, [re, to]) => text.replace(re, to), before);
writeFileSync(CASK, after);

console.log(`✓ ${CASK}`);
console.log(`    version ${version}`);
console.log(`    arm     ${armSha}`);
console.log(`    intel   ${intelSha}`);
console.log(`  推到 tap 仓库由 homebrew-cask 工作流做（发版后自动；补推用它的手动入口）。`);
