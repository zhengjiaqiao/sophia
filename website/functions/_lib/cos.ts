/// COS 副本探测（spec R19：「副本地址没配置或读不到时跳 GitHub」）：HEAD 一下目标文件，2xx 才跳 COS。
/// 结果在边缘缓存 5 分钟，同清单一样：新版 .dmg 传上 COS 后最迟 5 分钟生效，不用每次下载都探一次。
import type { EdgeCache } from "./manifest.ts";

const TTL_SECONDS = 300;
/// 探测超时：COS 慢时别拖住下载，超时当读不到、改走 GitHub
const PROBE_TIMEOUT_MS = 3000;

export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

/// 有、没有都缓存（传上 COS 前的 404 也缓存 5 分钟，换来的是 COS 不被打）；
/// 请求出错（超时、断网）不缓存，下一位访客再试，这一位走 GitHub。缓存读写出错当没有缓存。
export async function cosHas(url: string, fetchFn: ProbeFetch, cache: EdgeCache): Promise<boolean> {
  const key = new Request(url);
  try {
    const hit = await cache.match(key);
    if (hit) return (await hit.text()) === "1";
  } catch {
    // 缓存不可用，继续探测
  }
  let ok: boolean;
  try {
    const res = await fetchFn(url, { method: "HEAD", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    ok = res.ok;
  } catch {
    return false;
  }
  try {
    await cache.put(key, new Response(ok ? "1" : "0", { headers: { "cache-control": `public, max-age=${TTL_SECONDS}` } }));
  } catch {
    // 写不进缓存也照常跳转
  }
  return ok;
}
