/// COS 副本探测（spec R19：副本地址没配置或读不到时跳 GitHub）：假请求、假缓存，不连网
import assert from "node:assert/strict";
import test from "node:test";
import { cosHas } from "../functions/_lib/cos.ts";
import { handleDownload } from "../functions/_lib/download.ts";

const GH = "https://github.com/zhengjiaqiao/sophia/releases/download";
const COS = { COS_BASE_URL: "https://cos.example/sophia" };
const COS_FILE = "https://cos.example/sophia/v0.1.1/Sophia_0.1.1_aarch64.dmg";
const req = () => new Request("https://sophiakit.com/download/mac?arch=arm64");
const ver = async () => "0.1.1";

class FakeCache {
  store = new Map<string, Response>();
  async match(r: Request) {
    return this.store.get(r.url)?.clone();
  }
  async put(r: Request, res: Response) {
    this.store.set(r.url, res.clone());
  }
}
const status = (code: number) => async () => new Response(null, { status: code });

test("CN 访客，COS 上有这个文件 → COS；探测的就是要跳的那个地址", async () => {
  const probed: string[] = [];
  const has = async (u: string) => (probed.push(u), true);
  const r = await handleDownload(req(), COS, "CN", ver, has);
  assert.equal(r.headers.get("location"), COS_FILE);
  assert.deepEqual(probed, [COS_FILE]);
});

test("CN 访客，COS 上没有（或读不到）→ GitHub", async () => {
  const r = await handleDownload(req(), COS, "CN", ver, async () => false);
  assert.equal(r.headers.get("location"), `${GH}/v0.1.1/Sophia_0.1.1_aarch64.dmg`);
});

test("非 CN、没配 COS 的访客根本不探测", async () => {
  const has = async () => assert.fail("不该探测");
  await handleDownload(req(), COS, "US", ver, has);
  await handleDownload(req(), {}, "CN", ver, has);
});

test("探测返回 200 → 有，且用 HEAD", async () => {
  let method = "";
  const f = async (_u: string, init: RequestInit) => {
    method = init.method ?? "";
    return new Response(null, { status: 200 });
  };
  assert.equal(await cosHas(COS_FILE, f, new FakeCache()), true);
  assert.equal(method, "HEAD");
});

test("探测返回 404 / 403 / 500 → 没有；请求抛错 → 没有", async () => {
  for (const code of [404, 403, 500]) assert.equal(await cosHas(COS_FILE, status(code), new FakeCache()), false);
  const boom = async () => {
    throw new Error("timeout");
  };
  assert.equal(await cosHas(COS_FILE, boom, new FakeCache()), false);
});

test("探测结果缓存 5 分钟，第二次不再请求（有、没有都缓存）；抛错不缓存", async () => {
  for (const code of [200, 404]) {
    const cache = new FakeCache();
    let calls = 0;
    const f = async () => (calls++, new Response(null, { status: code }));
    const first = await cosHas(COS_FILE, f, cache);
    assert.equal(await cosHas(COS_FILE, f, cache), first);
    assert.equal(calls, 1);
    assert.match([...cache.store.values()][0].headers.get("cache-control")!, /max-age=300/);
  }
  const cache = new FakeCache();
  await cosHas(COS_FILE, () => Promise.reject(new Error("x")), cache);
  assert.equal(cache.store.size, 0);
});

test("缓存本身出错也不挡跳转：直接探测", async () => {
  const broken = {
    async match(): Promise<Response | undefined> {
      throw new Error("cache down");
    },
    async put() {
      throw new Error("cache down");
    },
  };
  assert.equal(await cosHas(COS_FILE, status(200), broken), true);
});
