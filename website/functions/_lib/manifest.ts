/// 读 Tauri 更新清单里的版本号，边缘缓存 5 分钟（spec R18）。
/// 缓存只放清单：发新版后最迟 5 分钟下载就跟上，网站不用重新部署。
import { MANIFEST_URL } from "./download.ts";

export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

const TTL_SECONDS = 300;

async function versionOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version ? body.version : null;
  } catch {
    return null;
  }
}

/// 读不到（网络、非 200、不是 JSON、没有 version）一律返回 null，由调用方退到 Releases 页。
/// 缓存读写出错不挡下载：当没有缓存直接读源。
export async function loadVersion(
  fetchFn: (url: string) => Promise<Response>,
  cache: EdgeCache,
): Promise<string | null> {
  const key = new Request(MANIFEST_URL);
  try {
    const hit = await cache.match(key);
    if (hit) {
      const v = await versionOf(hit);
      if (v) return v;
    }
  } catch {
    // 缓存不可用，继续读源
  }
  let fresh: Response;
  try {
    fresh = await fetchFn(MANIFEST_URL);
  } catch {
    return null;
  }
  if (!fresh.ok) return null;
  const text = await fresh.text();
  const version = await versionOf(new Response(text));
  if (!version) return null;
  try {
    await cache.put(key, new Response(text, { headers: { "cache-control": `public, max-age=${TTL_SECONDS}` } }));
  } catch {
    // 写不进缓存也照常下载
  }
  return version;
}
