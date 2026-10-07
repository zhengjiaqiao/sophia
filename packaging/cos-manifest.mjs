#!/usr/bin/env node
// 把某次 Release 的 latest.json 改写成腾讯云 COS 上的那份（issue #263，spec #248）：
// 只换各平台的包地址，指向 COS 上同一版本目录里的同名文件；签名与其余字段原样搬运——
// 签名里写着版本号，应用开了 requireSignedVersion，改动或重签都会让已装的客户端拒绝更新。
//
// COS 上的布局照 GitHub 的下载地址：<基址>/v<版本>/<产物名>，清单在 <基址>/latest.json。
// 另外两个 .dmg 各传一份固定文件名的最新版（LATEST_DMG），每次发版覆盖：官网的下载键直链它们，页面不写版本号（#286）。
//
// 用法（.github/workflows/cos-sync.yml 调用；gh 要已登录）：
//   node packaging/cos-manifest.mjs <tag> <COS 基址> <目录>
// <目录> 里要有从 Release 下回来的 latest.json 与全部产物。改写后的清单写到 <目录>/cos/latest.json，
// 要传的文件逐行打印到标准输出，每行「<目录里的文件名> <对象键>」：先是版本目录里的产物（清单引用的更新包与两个 .dmg），
// 最后是两个固定文件名的 .dmg 副本。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "zhengjiaqiao/sophia";

/// 固定文件名的最新版 .dmg 在桶里的对象键（按 Sophia_<版本>_<架构>.dmg 的架构名）。
/// 官网下载键（website/src/site.config.ts 的 downloadHref）直接取这里的键，拼成 <基址>/<键>
export const LATEST_DMG = { aarch64: "latest/Sophia_aarch64.dmg", x64: "latest/Sophia_x64.dmg" };

/// manifest：Release 上的 latest.json；assets：Release 的资产（name、url 是 API 地址、browser_download_url）。
/// 返回改写后的清单、要传进版本目录的产物名，与固定文件名副本（latest：哪个文件传到哪个键）。对不上的一律抛错，不出一份指向不存在文件的清单
export function rewriteManifest({ manifest, assets, tag, base }) {
  if (!/^https:\/\//.test(base)) throw new Error(`COS 基址要是 https 地址，收到的是「${base}」`);
  // 版本号对不上 tag，等于把别的版本当成这一版发出去
  if (`v${manifest.version}` !== tag) {
    throw new Error(`latest.json 写的版本是 ${manifest.version}，而同步的是 ${tag}`);
  }
  const entries = Object.entries(manifest.platforms ?? {});
  if (entries.length === 0) throw new Error("latest.json 里没有 platforms");

  // tauri-action 写进清单的是 API 地址（…/releases/assets/<id>），也认浏览器下载地址
  const byUrl = new Map();
  for (const a of assets) {
    byUrl.set(a.url, a.name);
    byUrl.set(a.browser_download_url, a.name);
  }
  const root = base.replace(/\/+$/, "");
  const platforms = {};
  const files = new Set();
  for (const [key, entry] of entries) {
    const name = byUrl.get(entry.url);
    if (!name) throw new Error(`${key} 的包地址 ${entry.url} 不是 Release ${tag} 的资产`);
    files.add(name);
    platforms[key] = { ...entry, url: `${root}/${tag}/${name}` };
  }

  // 按 Sophia_<版本>_<aarch64|x64>.dmg 认两个架构的安装包，认不出就不知道哪个该覆盖官网下载的那一份
  const dmgs = assets.filter((a) => a.name.endsWith(".dmg")).map((a) => a.name);
  const latest = [];
  for (const [arch, key] of Object.entries(LATEST_DMG)) {
    const expected = `Sophia_${manifest.version}_${arch}.dmg`;
    if (!dmgs.includes(expected)) {
      throw new Error(
        `Release ${tag} 里没有 ${expected}（官网下载的固定文件名副本按这个名字认架构）；实际的 dmg：${dmgs.join("、") || "无"}`,
      );
    }
    files.add(expected);
    latest.push({ file: expected, key });
  }
  return { manifest: { ...manifest, platforms }, files: [...files], latest };
}

function main([tag, base, dir]) {
  if (!tag || !base || !dir) {
    console.error("用法：node packaging/cos-manifest.mjs <tag> <COS 基址> <目录>");
    process.exit(2);
  }
  const release = JSON.parse(
    execFileSync("gh", ["api", `repos/${REPO}/releases/tags/${tag}`], {
      encoding: "utf8",
      maxBuffer: 16 << 20,
    }),
  );
  const manifest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  const {
    manifest: out,
    files,
    latest,
  } = rewriteManifest({ manifest, assets: release.assets, tag, base });
  for (const name of files) {
    if (!existsSync(join(dir, name)))
      throw new Error(`${dir} 里没有 ${name}：先从 Release ${tag} 下回来`);
  }
  mkdirSync(join(dir, "cos"), { recursive: true });
  writeFileSync(join(dir, "cos", "latest.json"), `${JSON.stringify(out, null, 2)}\n`);
  const lines = [
    ...files.map((name) => `${name} ${tag}/${name}`),
    ...latest.map((l) => `${l.file} ${l.key}`),
  ];
  console.log(lines.join("\n"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
