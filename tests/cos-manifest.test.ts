/// 发版同步到 COS（issue #263）：packaging/cos-manifest.mjs 把 GitHub 的 latest.json 改写成指向 COS 的清单
import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error 打包脚本是不带类型的 .mjs
import { LATEST_DMG, rewriteManifest } from "../packaging/cos-manifest.mjs";

const BASE = "https://sophia-releases-1258113621.cos.ap-shanghai.myqcloud.com";
const API = "https://api.github.com/repos/zhengjiaqiao/sophia/releases/assets";
const DL = "https://github.com/zhengjiaqiao/sophia/releases/download/v0.2.0";

const asset = (id: number, name: string) => ({
  name,
  url: `${API}/${id}`,
  browser_download_url: `${DL}/${name}`,
});
const ASSETS = [
  asset(1, "latest.json"),
  asset(2, "Sophia_0.2.0_aarch64.app.tar.gz"),
  asset(3, "Sophia_0.2.0_aarch64.app.tar.gz.sig"),
  asset(4, "Sophia_0.2.0_aarch64.dmg"),
  asset(5, "Sophia_0.2.0_x64.app.tar.gz"),
  asset(6, "Sophia_0.2.0_x64.app.tar.gz.sig"),
  asset(7, "Sophia_0.2.0_x64.dmg"),
];
// 照 v0.1.1 的真实清单：tauri-action 写的是 API 地址，-app 键与不带后缀的键指向同一个包
const manifest = () => ({
  version: "0.2.0",
  notes: "",
  pub_date: "2026-10-08T00:00:00.000Z",
  platforms: {
    "darwin-aarch64": { signature: "SIG-ARM", url: `${API}/2` },
    "darwin-aarch64-app": { signature: "SIG-ARM", url: `${API}/2` },
    "darwin-x86_64": { signature: "SIG-X64", url: `${API}/5` },
    "darwin-x86_64-app": { signature: "SIG-X64", url: `${API}/5` },
  },
});
const run = (m: unknown = manifest(), assets = ASSETS, tag = "v0.2.0") =>
  rewriteManifest({ manifest: m, assets, tag, base: BASE });

test("包地址换成 COS 上同一版本目录里的同名文件，签名与其余字段原样", () => {
  const { manifest: out } = run();
  assert.deepEqual(out, {
    version: "0.2.0",
    notes: "",
    pub_date: "2026-10-08T00:00:00.000Z",
    platforms: {
      "darwin-aarch64": {
        signature: "SIG-ARM",
        url: `${BASE}/v0.2.0/Sophia_0.2.0_aarch64.app.tar.gz`,
      },
      "darwin-aarch64-app": {
        signature: "SIG-ARM",
        url: `${BASE}/v0.2.0/Sophia_0.2.0_aarch64.app.tar.gz`,
      },
      "darwin-x86_64": { signature: "SIG-X64", url: `${BASE}/v0.2.0/Sophia_0.2.0_x64.app.tar.gz` },
      "darwin-x86_64-app": {
        signature: "SIG-X64",
        url: `${BASE}/v0.2.0/Sophia_0.2.0_x64.app.tar.gz`,
      },
    },
  });
});

test("要传的产物：清单引用的更新包（去重）与两个 .dmg；签名文件与清单本身不在其中", () => {
  assert.deepEqual(run().files, [
    "Sophia_0.2.0_aarch64.app.tar.gz",
    "Sophia_0.2.0_x64.app.tar.gz",
    "Sophia_0.2.0_aarch64.dmg",
    "Sophia_0.2.0_x64.dmg",
  ]);
});

test("官网的下载键直链固定文件名的最新版：两个 .dmg 各一份，每次发版覆盖（#286）", () => {
  assert.deepEqual(LATEST_DMG, {
    aarch64: "latest/Sophia_aarch64.dmg",
    x64: "latest/Sophia_x64.dmg",
  });
  assert.deepEqual(run().latest, [
    { file: "Sophia_0.2.0_aarch64.dmg", key: "latest/Sophia_aarch64.dmg" },
    { file: "Sophia_0.2.0_x64.dmg", key: "latest/Sophia_x64.dmg" },
  ]);
});

test("对不上就停：版本号与 tag 不符、包地址不在这次 Release 里、没有平台", () => {
  assert.throws(() => run(manifest(), ASSETS, "v0.2.1"), /0\.2\.0.*v0\.2\.1/);
  const stray = manifest();
  stray.platforms["darwin-x86_64"].url = `${API}/999`;
  assert.throws(() => run(stray), new RegExp(`${API}/999`));
  assert.throws(() => run({ ...manifest(), platforms: {} }), /platforms/);
});

test("对不上就停：两个 .dmg 不是官网拼得出的名字（Sophia_<版本>_aarch64 / _x64）", () => {
  const renamed = ASSETS.map((a) =>
    a.name === "Sophia_0.2.0_x64.dmg" ? { ...a, name: "Sophia_0.2.0_x86_64.dmg" } : a,
  );
  assert.throws(() => run(manifest(), renamed), /Sophia_0\.2\.0_x64\.dmg/);
  assert.throws(
    () =>
      run(
        manifest(),
        ASSETS.filter((a) => !a.name.endsWith("_aarch64.dmg")),
      ),
    /aarch64/,
  );
});

test("基址只认 https，末尾的斜杠不重复", () => {
  assert.throws(
    () =>
      rewriteManifest({
        manifest: manifest(),
        assets: ASSETS,
        tag: "v0.2.0",
        base: "http://x.example",
      }),
    /https/,
  );
  const { manifest: out } = rewriteManifest({
    manifest: manifest(),
    assets: ASSETS,
    tag: "v0.2.0",
    base: `${BASE}/`,
  });
  assert.equal(
    out.platforms["darwin-aarch64"].url,
    `${BASE}/v0.2.0/Sophia_0.2.0_aarch64.app.tar.gz`,
  );
});
