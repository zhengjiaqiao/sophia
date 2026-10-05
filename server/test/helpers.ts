import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/index";

export { env };

let ipSeq = 0;
/** 每个测试用不同的 IP，避免限流计数互相干扰 */
export const freshIp = () => `10.0.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

export const ADMIN_TOKEN = "test-admin-token";

export async function call(path: string, init: RequestInit & { ip?: string } = {}): Promise<Response> {
  const { ip, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("CF-Connecting-IP", ip ?? freshIp());
  const ctx = createExecutionContext();
  // 测试里构造的请求没有 cf 属性（线上由 Cloudflare 填）；处理函数不读它
  const req = new Request("https://telemetry.test" + path, { ...rest, headers }) as unknown as Request<unknown, IncomingRequestCfProperties>;
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export const postJson = (path: string, body: unknown, ip?: string) =>
  call(path, {
    method: "POST",
    ip,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

export const uuid = () => crypto.randomUUID();

/** UTC 日期，offset 天 */
export const utcDay = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

export const dailyBody = (over: Record<string, unknown> = {}) => ({
  installId: uuid(),
  day: utcDay(),
  version: "1.4.0",
  os: "macos15",
  arch: "arm64",
  counts: {
    self: { panic: 0, pageFault: 1, uncaught: 0, internal: 2 },
    external: { network: 3, upstream: 0, writeFailure: 0, auth: 1 },
  },
  ...over,
});

export const adminAuth = (token = ADMIN_TOKEN) => ({ authorization: `Bearer ${token}` });
export const basicAuth = (password: string, user = "me") => ({ authorization: `Basic ${btoa(`${user}:${password}`)}` });

/** 一张「JPEG」：FF D8 FF 开头、FF D9 结尾，中间填随机字节（服务端只认开头的魔数），共 size 字节 */
export function jpeg(size = 2048): Uint8Array {
  const b = new Uint8Array(size);
  for (let at = 0; at < size; at += 65536) crypto.getRandomValues(b.subarray(at, Math.min(size, at + 65536)));
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  b.set([0xff, 0xd9], size - 2);
  return b;
}

/** 标准 base64（带补齐），客户端传截图就用这个 */
export const b64 = (bytes: Uint8Array) => (bytes as Uint8Array & { toBase64(): string }).toBase64();

/** 这么多字节的图存成 base64 后的长度（预算按存的字节记） */
export const b64Len = (size: number) => 4 * Math.ceil(size / 3);

/** 传截图：给字节就先转成 base64 文本；给字符串 / 流就原样发 */
export const postShot = (body: Uint8Array | string | ReadableStream, ip?: string, contentType = "text/plain") =>
  call("/v1/shot", {
    method: "POST",
    ip,
    headers: { "content-type": contentType },
    body: body instanceof Uint8Array ? b64(body) : body,
  });

/** 传一张截图，返回它的 id */
export async function uploadShot(size = 2048): Promise<string> {
  const res = await postShot(jpeg(size));
  if (res.status !== 200) throw new Error(`upload shot: ${res.status} ${await res.text()}`);
  return (await res.json<{ id: string }>()).id;
}

/** 32 位小写 hex：截图与反馈的 id */
export const hexId = () => crypto.randomUUID().replaceAll("-", "");

export const feedbackBody = (over: Record<string, unknown> = {}) => ({
  id: hexId(),
  text: "模型页切换后网关没生效",
  shots: [] as string[],
  installId: uuid(),
  diagnostics: "Sophia 1.4.0 · macOS 15.1 · arm64\n[error] gateway: connect refused",
  version: "1.4.0",
  os: "macos15",
  arch: "arm64",
  ...over,
});
