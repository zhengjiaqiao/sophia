/// `/download/mac?arch=arm64|x64`：见 _lib/download.ts
import { cosHas } from "../_lib/cos.ts";
import { handleDownload, type DownloadEnv } from "../_lib/download.ts";
import { loadVersion, type EdgeCache } from "../_lib/manifest.ts";

export const onRequest = async (context: { request: Request; env: DownloadEnv }): Promise<Response> => {
  const country = (context.request as Request & { cf?: { country?: string } }).cf?.country;
  // Workers 运行时的默认边缘缓存；标准 DOM 类型里没有 caches.default
  const cache = (caches as unknown as { default: EdgeCache }).default;
  return handleDownload(
    context.request,
    context.env,
    country,
    () => loadVersion((u) => fetch(u), cache),
    (url) => cosHas(url, (u, init) => fetch(u, init), cache),
  );
};
