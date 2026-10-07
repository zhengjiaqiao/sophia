/// 首页语言跳转（spec R2）：cookie 优先，否则看 Accept-Language。
/// `lang` cookie 由顶栏语言菜单（#185）写，值是 src/lib/langs.ts 里的语言码；这里只读。
import { isLang, LANG_COOKIE, pathOf, type Lang } from "../../src/lib/langs.ts";

const VARY = "Accept-Language, Cookie";

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/// 一个语言标签落到哪种页面：zh-TW / HK / MO / Hant 是繁体，其余 zh 是简体，别的都留英文
function fromTag(tag: string): Lang {
  const parts = tag.toLowerCase().split("-");
  if (parts[0] !== "zh") return "en";
  if (parts.includes("hant")) return "zh-Hant";
  if (parts.includes("hans")) return "zh-Hans";
  return parts.some((p) => p === "tw" || p === "hk" || p === "mo") ? "zh-Hant" : "zh-Hans";
}

/// 取权重最高的那个标签（同权重取靠前的）；`*` 与空头当没说
function fromAcceptLanguage(header: string | undefined): Lang {
  let best: { tag: string; q: number } | undefined;
  for (const item of (header ?? "").split(",")) {
    const [tag, ...params] = item.trim().split(";");
    if (!tag || tag === "*") continue;
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    if (Number.isNaN(q) || q <= 0) continue;
    if (!best || q > best.q) best = { tag, q };
  }
  return best ? fromTag(best.tag) : "en";
}

export function pickLang(input: { cookie?: string; acceptLanguage?: string }): Lang {
  const saved = readCookie(input.cookie, LANG_COOKIE);
  return isLang(saved) ? saved : fromAcceptLanguage(input.acceptLanguage);
}

/// `/` 的处理：要跳就 302，不跳就放行静态首页；两种响应都带 Vary，免得缓存把一种语言发给另一种人
export async function handleIndex(request: Request, next: () => Promise<Response>): Promise<Response> {
  const lang = pickLang({
    cookie: request.headers.get("cookie") ?? undefined,
    acceptLanguage: request.headers.get("accept-language") ?? undefined,
  });
  if (lang !== "en") {
    return new Response(null, { status: 302, headers: { location: pathOf(lang), vary: VARY } });
  }
  const res = await next();
  const out = new Response(res.body, res);
  const old = out.headers.get("vary");
  out.headers.set("vary", old ? `${old}, ${VARY}` : VARY);
  return out;
}
