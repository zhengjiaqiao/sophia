// 统一的 JSON 错误体与限量读请求体。错误体只有一个短代号，不带调用栈

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

export const errorResponse = (e: HttpError) => json({ error: e.code }, e.status, e.headers);

export const badRequest = (code = "bad_request") => new HttpError(400, code);
export const tooLarge = () => new HttpError(413, "too_large");

/**
 * 读完整个请求体，超过 max 字节就停（不信 Content-Length，边读边数）。
 * Content-Length 已经超了就不读。
 */
export async function readLimited(req: Request, max: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export async function readJson(req: Request, max: number): Promise<unknown> {
  const bytes = await readLimited(req, max);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw badRequest("bad_json");
  }
}

export const utf8Bytes = (s: string) => new TextEncoder().encode(s).byteLength;
