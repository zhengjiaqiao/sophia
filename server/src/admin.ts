// 维护者统计页 /admin：管理口令（wrangler secret ADMIN_TOKEN），Basic 或 Bearer。
// 服务端渲染、不加载任何外部资源、所有数据先转义
import type { Env } from "./env";
import { HttpError } from "./http";

const enc = new TextEncoder();
const sha256 = async (s: string) => crypto.subtle.digest("SHA-256", enc.encode(s));

function presentedSecret(header: string | null): string | null {
  const m = /^(Bearer|Basic)\s+(\S+)$/i.exec((header ?? "").trim());
  if (!m) return null;
  if (m[1].toLowerCase() === "bearer") return m[2];
  try {
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)));
    const colon = decoded.indexOf(":");
    return colon < 0 ? null : decoded.slice(colon + 1); // 用户名随便填，只认口令
  } catch {
    return null;
  }
}

async function authorize(req: Request, env: Env) {
  const token = env.ADMIN_TOKEN;
  const given = presentedSecret(req.headers.get("authorization"));
  // 都先哈希成等长再做常数时间比较，长度也不泄露
  const ok =
    !!token && given !== null && crypto.subtle.timingSafeEqual(await sha256(given), await sha256(token));
  if (!ok) throw new HttpError(401, "unauthorized", { "www-authenticate": 'Basic realm="Sophia"' });
}

const PRIVATE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const table = (head: string[], rows: unknown[][], empty = "暂无数据") =>
  rows.length === 0
    ? `<p class="muted">${esc(empty)}</p>`
    : `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${typeof c === "object" && c && "html" in c ? (c as { html: string }).html : esc(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`;

/** 已转义好的 HTML 片段，放进 table() 时不再转义 */
const raw = (html: string) => ({ html });

const pct = (n: number, total: number) => (total ? `${((n / total) * 100).toFixed(1)}%` : "—");

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

type Row = Record<string, unknown>;

export async function admin(req: Request, env: Env, now = Date.now()): Promise<Response> {
  await authorize(req, env);
  const since = utcDay(now - 29 * 86_400_000);
  const tomorrow = utcDay(now + 86_400_000);
  const q = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args);

  const [dau, layers, mau, latest, kinds, events] = await env.DB.batch<Row>([
    q("SELECT day, COUNT(*) AS n FROM daily WHERE day >= ?1 GROUP BY day ORDER BY day DESC", since),
    q(
      `SELECT d.day AS day, j.path AS layer, SUM(j.value) AS n
       FROM daily d, json_tree(d.counts_json) j
       WHERE d.day >= ?1 AND j.type = 'integer' GROUP BY d.day, j.path`,
      since,
    ),
    q("SELECT COUNT(DISTINCT install_id) AS n FROM daily WHERE day >= ?1", since),
    q("SELECT MAX(day) AS day FROM daily WHERE day <= ?1", tomorrow),
    q(
      `SELECT substr(j.path, 3) AS layer, j.key AS kind, SUM(j.value) AS n
       FROM daily d, json_tree(d.counts_json) j
       WHERE d.day >= ?1 AND j.type = 'integer' GROUP BY j.path, j.key ORDER BY j.path DESC, n DESC`,
      since,
    ),
    q(
      `SELECT signature, COUNT(*) AS n, COUNT(DISTINCT install_id) AS installs, MAX(at) AS last_at,
              (SELECT version FROM event x WHERE x.signature = e.signature ORDER BY x.at DESC LIMIT 1) AS version,
              (SELECT body FROM event x WHERE x.signature = e.signature ORDER BY x.at DESC LIMIT 1) AS sample
       FROM event e GROUP BY signature ORDER BY last_at DESC LIMIT 100`,
    ),
  ]);
  // 反馈在单独的库里；截图只取 id，图走 /admin/shot/<id>
  const feedback = await env.FB.prepare(
    `SELECT f.id, f.at, f.text, f.install_id, f.diagnostics, f.version, f.os, f.arch,
            (SELECT json_group_array(id) FROM (SELECT id FROM shot s WHERE s.feedback_id = f.id ORDER BY s.at, s.id)) AS shots
     FROM feedback f ORDER BY f.at DESC, f.id LIMIT 100`,
  ).all<Row>();

  const latestDay = (latest.results[0]?.day as string | null) ?? null;
  const [byVersion, byOs] = latestDay
    ? await env.DB.batch<Row>([
        q("SELECT version AS k, COUNT(*) AS n FROM daily WHERE day = ?1 GROUP BY version ORDER BY n DESC", latestDay),
        q("SELECT os AS k, COUNT(*) AS n FROM daily WHERE day = ?1 GROUP BY os ORDER BY n DESC", latestDay),
      ])
    : [{ results: [] as Row[] }, { results: [] as Row[] }];
  const latestTotal = byVersion.results.reduce((s, r) => s + Number(r.n), 0);

  // 两层异常按天合计：json_tree 的 path 是 '$.self' / '$.external'
  const layerByDay = new Map<string, { self: number; external: number }>();
  for (const r of layers.results) {
    const e = layerByDay.get(r.day as string) ?? { self: 0, external: 0 };
    if (r.layer === "$.self") e.self += Number(r.n);
    if (r.layer === "$.external") e.external += Number(r.n);
    layerByDay.set(r.day as string, e);
  }
  const layerName = (l: unknown) => (l === "self" ? "Sophia 自身" : l === "external" ? "外部原因" : String(l));

  const html = `<!doctype html>
<html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Sophia 统计</title>
<style>
:root{color-scheme:light dark;--fg:#1d1d1f;--bg:#fff;--muted:#6e6e73;--line:#d2d2d7;--soft:#f5f5f7}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--bg:#1c1c1e;--muted:#a1a1a6;--line:#3a3a3c;--soft:#2c2c2e}}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;padding:16px;max-width:1100px}
h1{font-size:20px}h2{font-size:16px;margin-top:32px;border-bottom:1px solid var(--line);padding-bottom:4px}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--soft);padding:8px;border-radius:6px;max-height:320px;overflow:auto;font-size:12px}
.fb{border-bottom:1px solid var(--line);padding:12px 0}.fb p{white-space:pre-wrap;margin:4px 0}
.shots{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0}.shots img{max-width:160px;max-height:160px;border:1px solid var(--line);border-radius:4px;display:block}
.kpi{font-size:24px;font-variant-numeric:tabular-nums}
</style></head><body>
<h1>Sophia 统计</h1>
<p class="muted">时间均为 UTC。日活按客户端上报的日期计。</p>

<div class="grid">
  <div><div class="muted">月活（近 30 天）</div><div class="kpi">${esc(mau.results[0]?.n ?? 0)}</div></div>
  <div><div class="muted">日活（${esc(latestDay ?? "—")}）</div><div class="kpi">${esc(latestTotal)}</div></div>
</div>

<h2>近 30 天日活与异常次数</h2>
${table(
  ["日期", "日活", "Sophia 自身", "外部原因"],
  dau.results.map((r) => {
    const l = layerByDay.get(r.day as string) ?? { self: 0, external: 0 };
    return [r.day, r.n, l.self, l.external];
  }),
)}

<div class="grid">
<div><h2>版本分布（${esc(latestDay ?? "—")}）</h2>
${table(["版本", "台数", "占比"], byVersion.results.map((r) => [r.k, r.n, pct(Number(r.n), latestTotal)]))}</div>
<div><h2>系统分布（${esc(latestDay ?? "—")}）</h2>
${table(["系统", "台数", "占比"], byOs.results.map((r) => [r.k, r.n, pct(Number(r.n), latestTotal)]))}</div>
<div><h2>近 30 天各类异常</h2>
${table(["层", "类别", "次数"], kinds.results.map((r) => [layerName(r.layer), r.kind, r.n]))}</div>
</div>

<h2>错误事件（按签名合并，最近 100 种）</h2>
${table(
  ["签名", "条数", "电脑数", "最近一次", "最近版本", "样本"],
  events.results.map((r) => [
    r.signature,
    r.n,
    r.installs,
    r.last_at,
    r.version,
    raw(`<details><summary>展开</summary><pre>${esc(r.sample)}</pre></details>`),
  ]),
)}

<h2>用户反馈（最新 100 条）</h2>
${
  feedback.results.length === 0
    ? `<p class="muted">暂无数据</p>`
    : feedback.results
        .map((f) => {
          // 截图 id 是库里存的 32 位 hex（接口只收这个形状），照样转义
          const shots = JSON.parse(String(f.shots ?? "[]")) as string[];
          return `<div class="fb">
  <div class="muted">${esc(f.at)} · ${esc(f.version)} · ${esc(f.os)} · ${esc(f.arch)}${f.install_id ? ` · 安装 ${esc(String(f.install_id).slice(0, 8))}` : ""}</div>
  <p>${esc(f.text)}</p>
  ${shots.length ? `<div class="shots">${shots.map((s) => `<a href="/admin/shot/${esc(s)}"><img src="/admin/shot/${esc(s)}" alt="截图" loading="lazy"></a>`).join("")}</div>` : ""}
  ${f.diagnostics ? `<details><summary>诊断内容</summary><pre>${esc(f.diagnostics)}</pre></details>` : ""}
</div>`;
        })
        .join("\n")
}
</body></html>`;

  return new Response(html, {
    headers: {
      ...PRIVATE_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    },
  });
}

const SHOT_ID = /^[0-9a-f]{32}$/;

/**
 * 截图存的是 base64 原文，这里解回二进制。运行时有原生的 Uint8Array.fromBase64 就用它（一次原生解码，
 * 不经 JS 循环，1 MiB 也远低于 10 ms）；没有时退回 atob（原生）加一遍 charCodeAt 循环
 */
function fromBase64(text: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (native) return native.call(Uint8Array, text);
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** GET /admin/shot/<32 位 hex>：反馈截图原图，同一口令；先验口令再查，没口令的人分不出 id 在不在 */
export async function adminShot(req: Request, env: Env, id: string): Promise<Response> {
  await authorize(req, env);
  if (!SHOT_ID.test(id)) throw new HttpError(404, "not_found");
  const row = await env.FB.prepare("SELECT jpeg_b64 FROM shot WHERE id = ?1").bind(id).first<{ jpeg_b64: string }>();
  if (!row) throw new HttpError(404, "not_found");
  return new Response(fromBase64(row.jpeg_b64), {
    headers: {
      ...PRIVATE_HEADERS,
      "cache-control": "private, no-store",
      "content-type": "image/jpeg",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
