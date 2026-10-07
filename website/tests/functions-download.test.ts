/// 下载函数（spec R18、R19，AC2–AC4）：假清单、假请求、假缓存，不连网
import assert from "node:assert/strict";
import test from "node:test";
import { handleDownload, MANIFEST_URL, RELEASES_LATEST } from "../functions/_lib/download.ts";
import { loadVersion } from "../functions/_lib/manifest.ts";

const GH = "https://github.com/zhengjiaqiao/sophia/releases/download";
const req = (arch?: string) =>
  new Request(`https://sophiakit.com/download/mac${arch === undefined ? "" : `?arch=${arch}`}`);
const ver = (v: string | null) => async () => v;
/// COS 上什么都有 / 什么都没有（探测本身的测试在 functions-cos.test.ts）
const has = async () => true;

test("AC2：Apple 芯片 → _aarch64.dmg，Intel → _x64.dmg", async () => {
  const a = await handleDownload(req("arm64"), {}, "US", ver("0.1.1"), has);
  assert.equal(a.status, 302);
  assert.equal(a.headers.get("location"), `${GH}/v0.1.1/Sophia_0.1.1_aarch64.dmg`);
  const x = await handleDownload(req("x64"), {}, "US", ver("0.1.1"), has);
  assert.equal(x.headers.get("location"), `${GH}/v0.1.1/Sophia_0.1.1_x64.dmg`);
});

test("缺 arch 或乱写 arch 按 Apple 芯片", async () => {
  for (const q of [undefined, "", "mips"]) {
    const r = await handleDownload(req(q), {}, "US", ver("0.1.1"), has);
    assert.match(r.headers.get("location")!, /_aarch64\.dmg$/);
  }
});

test("AC3：清单给出新版本就下新版本", async () => {
  const r = await handleDownload(req("arm64"), {}, "US", ver("0.2.0"), has);
  assert.equal(r.headers.get("location"), `${GH}/v0.2.0/Sophia_0.2.0_aarch64.dmg`);
});

test("AC3：清单读不到 → Releases 页（CN 配了 COS 也一样）", async () => {
  const r = await handleDownload(req("arm64"), { COS_BASE_URL: "https://cos.example/sophia" }, "CN", ver(null), has);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), RELEASES_LATEST);
});

test("AC4：CN 访客且配了 COS 基址 → COS 上这一版目录里的同名文件，布局照 GitHub（基址末尾斜杠不影响）", async () => {
  const env = { COS_BASE_URL: "https://cos.example/sophia/" };
  const r = await handleDownload(req("x64"), env, "CN", ver("0.1.1"), has);
  assert.equal(r.headers.get("location"), "https://cos.example/sophia/v0.1.1/Sophia_0.1.1_x64.dmg");
});

test("AC4：CN 访客没配 COS（未设或空串）→ GitHub", async () => {
  for (const env of [{}, { COS_BASE_URL: "" }, { COS_BASE_URL: "  " }]) {
    const r = await handleDownload(req("arm64"), env, "CN", ver("0.1.1"), has);
    assert.equal(r.headers.get("location"), `${GH}/v0.1.1/Sophia_0.1.1_aarch64.dmg`);
  }
});

test("AC4：非 CN 访客即使配了 COS 也走 GitHub；国家未知同理", async () => {
  const env = { COS_BASE_URL: "https://cos.example/sophia" };
  for (const country of ["US", "HK", undefined]) {
    const r = await handleDownload(req("arm64"), env, country, ver("0.1.1"), has);
    assert.match(r.headers.get("location")!, /^https:\/\/github\.com\//);
  }
});

test("清单里的版本号不是版本号的样子（被篡改）→ 当读不到", async () => {
  const r = await handleDownload(req("arm64"), {}, "US", ver("1/../../evil"), has);
  assert.equal(r.headers.get("location"), RELEASES_LATEST);
});

test("重定向本身不缓存：缓存只放在清单上", async () => {
  const r = await handleDownload(req("arm64"), {}, "US", ver("0.1.1"), has);
  assert.match(r.headers.get("cache-control") ?? "", /no-store/);
});

// ——清单读取与边缘缓存——

class FakeCache {
  store = new Map<string, Response>();
  async match(r: Request) {
    return this.store.get(r.url)?.clone();
  }
  async put(r: Request, res: Response) {
    this.store.set(r.url, res.clone());
  }
}
const manifestRes = (v: string) => new Response(JSON.stringify({ version: v, pub_date: "x" }));

test("清单地址是 releases/latest/download/latest.json，不走 GitHub API", () => {
  assert.equal(MANIFEST_URL, "https://github.com/zhengjiaqiao/sophia/releases/latest/download/latest.json");
});

test("R18：读清单取 version，写进缓存，5 分钟内第二次不再请求", async () => {
  const cache = new FakeCache();
  let calls = 0;
  const fetchFn = async (u: string) => {
    calls++;
    assert.equal(u, MANIFEST_URL);
    return manifestRes("0.1.1");
  };
  assert.equal(await loadVersion(fetchFn, cache), "0.1.1");
  assert.equal(await loadVersion(fetchFn, cache), "0.1.1");
  assert.equal(calls, 1);
  const cached = [...cache.store.values()][0];
  assert.match(cached.headers.get("cache-control")!, /max-age=300/);
});

test("缓存里有旧版本就用缓存（过期由 Cache API 按 max-age 淘汰）", async () => {
  const cache = new FakeCache();
  await loadVersion(async () => manifestRes("0.1.1"), cache);
  assert.equal(await loadVersion(async () => manifestRes("0.2.0"), cache), "0.1.1");
});

test("AC3：请求失败、非 200、不是 JSON、缺 version 都返回 null，且不写缓存", async () => {
  const bad: Array<() => Promise<Response>> = [
    async () => {
      throw new Error("network");
    },
    async () => new Response("nope", { status: 404 }),
    async () => new Response("<html>"),
    async () => new Response(JSON.stringify({ pub_date: "x" })),
    async () => new Response(JSON.stringify({ version: 1 })),
  ];
  for (const f of bad) {
    const cache = new FakeCache();
    assert.equal(await loadVersion(f, cache), null);
    assert.equal(cache.store.size, 0);
  }
});

test("缓存本身出错也不挡下载：直接读源", async () => {
  const broken = {
    async match(): Promise<Response | undefined> {
      throw new Error("cache down");
    },
    async put() {
      throw new Error("cache down");
    },
  };
  assert.equal(await loadVersion(async () => manifestRes("0.1.1"), broken), "0.1.1");
});
