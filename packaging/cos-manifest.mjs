#!/usr/bin/env node
// 把某次 Release 的 latest.json 改写成腾讯云 COS 上的那份（issue #263，spec #248）：
// 只换各平台的包地址，指向 COS 上同一版本目录里的同名文件；签名与其余字段原样搬运——
// 签名里写着版本号，应用开了 requireSignedVersion，改动或重签都会让已装的客户端拒绝更新。
//
// COS 上的布局照 GitHub 的下载地址：<基址>/v<版本>/<产物名>，清单在 <基址>/latest.json。
// 官网下载函数（website/functions/_lib/download.ts）按同一个布局拼 .dmg 地址。
//
// 用法（.github/workflows/cos-sync.yml 调用；gh 要已登录）：
//   node packaging/cos-manifest.mjs <tag> <COS 基址> <目录>
// <目录> 里要有从 Release 下回来的 latest.json 与全部产物。改写后的清单写到 <目录>/cos/latest.json，
// 要传的产物名（清单引用的更新包与两个 .dmg）逐行打印到标准输出。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "zhengjiaqiao/sophia";

/// manifest：Release 上的 latest.json；assets：Release 的资产（name、url 是 API 地址、browser_download_url）。
/// 返回改写后的清单与要传上 COS 的产物名。对不上的一律抛错，不出一份指向不存在文件的清单
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

  // 官网下载函数按 Sophia_<版本>_<aarch64|x64>.dmg 拼地址，名字对不上国内访客会被送去一个 404
  const dmgs = assets.filter((a) => a.name.endsWith(".dmg")).map((a) => a.name);
  for (const arch of ["aarch64", "x64"]) {
    const expected = `Sophia_${manifest.version}_${arch}.dmg`;
    if (!dmgs.includes(expected)) {
      throw new Error(
        `Release ${tag} 里没有 ${expected}（官网按这个名字拼下载地址）；实际的 dmg：${dmgs.join("、") || "无"}`,
      );
    }
    files.add(expected);
  }
  return { manifest: { ...manifest, platforms }, files: [...files] };
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
  const { manifest: out, files } = rewriteManifest({ manifest, assets: release.assets, tag, base });
  for (const name of files) {
    if (!existsSync(join(dir, name)))
      throw new Error(`${dir} 里没有 ${name}：先从 Release ${tag} 下回来`);
  }
  mkdirSync(join(dir, "cos"), { recursive: true });
  writeFileSync(join(dir, "cos", "latest.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(files.join("\n"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
