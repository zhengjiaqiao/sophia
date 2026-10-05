// 用户反馈：先逐张传截图（POST /v1/shot，拿到 id），再提交文字并挂上截图（POST /v1/feedback）。
// 都写单独的反馈库（env.FB）。判断与写入在同一个 batch（一个事务）里，计数与记账由迁移里的触发器在真写入时做
import type { Env } from "./env";
import { HttpError, badRequest, json, readJson, readLimited, tooLarge, utf8Bytes } from "./http";
import * as L from "./limits";
import { asciiField, asObject, installId, onlyKeys } from "./validate";

/** 32 位小写 hex，16 字节随机数 */
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** 截图 id、反馈 id 都是 32 位小写 hex */
const HEX_ID = /^[0-9a-f]{32}$/;
/** 标准 base64 字符集，补齐号只在末尾、至多两个（长度是 4 的倍数另判） */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const busy = () => new HttpError(503, "busy");
const full = () => new HttpError(503, "full");

const SHOT_COST = "(SELECT v FROM budget WHERE k = 'cost_shot_row')";
const SHOT_USED = "(SELECT v FROM budget WHERE k = 'shot_bytes')";

/**
 * 校验截图请求体：JPEG 的标准 base64（带补齐、不换行），解码后 ≤ SHOT_MAX_BYTES、开头是 FF D8 FF。
 * 不整段解码：字符集用一条正则、大小按长度算、魔数只解前 4 个字符
 */
function shotBase64(raw: Uint8Array): string {
  const text = new TextDecoder().decode(raw);
  if (text.length === 0 || text.length % 4 !== 0 || !BASE64.test(text)) throw badRequest("bad_image");
  const size = (text.length / 4) * 3 - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0);
  if (size > L.SHOT_MAX_BYTES) throw tooLarge();
  const head = atob(text.slice(0, 4));
  if (size <= 3 || head.charCodeAt(0) !== 0xff || head.charCodeAt(1) !== 0xd8 || head.charCodeAt(2) !== 0xff) {
    throw badRequest("bad_image");
  }
  return text;
}

/**
 * POST /v1/shot：请求体是一张 JPEG 的标准 base64 文本（content-type: text/plain），解码后 ≤ 1 MiB、
 * 开头 FF D8 FF；原文存库。回 200 {"id":"<32 位 hex>"}。全站当天新截图数到上限回 503 busy；
 * 预算不够时先删过期没挂上的、再删最旧的已挂上反馈的截图腾地方（反馈文字保留），删光也腾不出就什么都不删、回 503 full。
 * 只用 batch 访问反馈库。正常路径（没到上限、预算够）只读预算、计数这几行常数行；真要淘汰时才另发一个会扫表的 batch
 */
export async function shot(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "text/plain") throw badRequest("bad_image");
  const text = shotBase64(await readLimited(req, L.SHOT_MAX_B64_BYTES));

  const id = randomId();
  const at = new Date(now).toISOString();
  // ?1 当天 ?2 每天上限 ?3 存的字节 ?4 预算 ?5 id ?6 上传时间 ?7 base64 原文 ?8 过期界线
  const args = [at.slice(0, 10), L.NEW_SHOTS_PER_DAY, text.length, L.SHOT_STORE_BUDGET_BYTES, id, at, text,
    new Date(now - L.SHOT_ATTACH_WINDOW_MS).toISOString()];
  const underCap = "COALESCE((SELECT n FROM daily_count WHERE day = ?1 AND kind = 'shot'), 0) < ?2";
  const fits = `${SHOT_USED} + ?3 + ${SHOT_COST} <= ?4`;
  const insert = () =>
    env.FB.prepare(
      `INSERT INTO shot (id, at, bytes, jpeg_b64) SELECT ?5, ?6, ?3, ?7 WHERE ${underCap} AND ${fits} RETURNING 1 AS ok`,
    ).bind(...args.slice(0, 7));

  // 先只试插入：判断与插入在同一个事务里，只读常数行
  const [state, inserted] = await env.FB.batch<Record<string, unknown>>([
    env.FB.prepare(`SELECT ${underCap} AS under_cap`).bind(...args.slice(0, 2)),
    insert(),
  ]);
  if (inserted.results.length === 1) return json({ id });
  if (!state.results[0]?.under_cap) throw busy();

  // 预算不够才淘汰：按「过期没挂上的在前、再按上传时间」排，删掉刚好够的那一截；全删了也不够就一张都不删。
  // 两个 batch 之间别的请求可能改了账，所以这里把上限和预算重新判一遍
  const need = `${SHOT_USED} + ?3 + ${SHOT_COST} - ?4`; // 还差多少字节
  const evictable = "(feedback_id IS NOT NULL OR at < ?8)";
  const [again, , retried] = await env.FB.batch<Record<string, unknown>>([
    env.FB.prepare(`SELECT ${underCap} AS under_cap`).bind(...args.slice(0, 2)),
    env.FB.prepare(
      `DELETE FROM shot WHERE ${underCap} AND ${need} > 0
         AND (SELECT COALESCE(SUM(bytes + ${SHOT_COST}), 0) FROM shot WHERE ${evictable}) >= ${need}
         AND id IN (
           SELECT id FROM (
             SELECT id, SUM(bytes + ${SHOT_COST}) OVER (ORDER BY feedback_id IS NOT NULL, at, id ROWS UNBOUNDED PRECEDING)
                    - (bytes + ${SHOT_COST}) AS before
             FROM shot WHERE ${evictable}
           ) WHERE before < ${need})`,
    ).bind(...args),
    insert(),
  ]);
  if (retried.results.length === 1) return json({ id });
  throw again.results[0]?.under_cap ? full() : busy();
}

/** 去掉首尾空白后非空、不超过 FEEDBACK_TEXT_MAX_CHARS 个字符（按码点数） */
function feedbackText(v: unknown): string {
  if (typeof v !== "string") throw badRequest("bad_text");
  const t = v.trim();
  let n = 0;
  for (const _ of t) if (++n > L.FEEDBACK_TEXT_MAX_CHARS) throw badRequest("bad_text");
  if (n === 0) throw badRequest("bad_text");
  return t;
}

/** 至多 FEEDBACK_MAX_SHOTS 个不重复的截图 id；在不在、过没过期、挂没挂过在库里判断 */
function shotIds(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > L.FEEDBACK_MAX_SHOTS) throw badRequest("bad_shot");
  if (!v.every((s) => typeof s === "string" && HEX_ID.test(s)) || new Set(v).size !== v.length) throw badRequest("bad_shot");
  return v as string[];
}

const FEEDBACK_ROW_BYTES =
  "length(CAST(?1 AS BLOB)) + length(CAST(?2 AS BLOB)) + length(CAST(?3 AS BLOB)) + length(CAST(?4 AS BLOB)) + COALESCE(length(CAST(?5 AS BLOB)), 0) + length(CAST(?6 AS BLOB)) + length(CAST(?7 AS BLOB)) + length(CAST(?8 AS BLOB)) + length(CAST(?9 AS BLOB)) + length(CAST(?15 AS BLOB))";

/**
 * POST /v1/feedback：JSON {id, text, shots, installId?, diagnostics, version, os, arch}，整条 ≤ 64 KiB。
 * id 由客户端给（32 位小写 hex，每份草稿生成一次、重试复用）：同 id 已存在就回 200、什么都不改，
 * 响应丢了重试不会重复入库。截图必须是 24 小时内传上来、还没挂到别的反馈上的（挂在同一 id 上的也算数）；
 * 插入反馈与挂上截图在同一个事务里。截图不合规 400 bad_shot（优先）；全站当天反馈数到上限 503 busy；文字的预算满了 503 full
 */
export async function feedback(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const o = asObject(await readJson(req, L.FEEDBACK_MAX_BYTES));
  onlyKeys(o, ["id", "text", "shots", "installId", "diagnostics", "version", "os", "arch"]);
  if (typeof o.id !== "string" || !HEX_ID.test(o.id)) throw badRequest("bad_id");
  const id = o.id;
  const text = feedbackText(o.text);
  const shots = shotIds(o.shots);
  const install = o.installId === undefined || o.installId === null ? null : installId(o.installId);
  if (typeof o.diagnostics !== "string" || utf8Bytes(o.diagnostics) > L.FEEDBACK_DIAGNOSTICS_MAX_BYTES) throw badRequest("bad_diagnostics");
  const version = asciiField(o.version, "version", L.VERSION_MAX_BYTES);
  const os = asciiField(o.os, "os", L.OS_MAX_BYTES);
  const arch = asciiField(o.arch, "arch", L.ARCH_MAX_BYTES);

  const at = new Date(now).toISOString();
  const cutoff = new Date(now - L.SHOT_ATTACH_WINDOW_MS).toISOString();
  // 这次请求的随机数，存进这次插入的行：挂截图只认它，同 id、同一毫秒的并发重发也分得清是哪次真插进去的
  const nonce = randomId();
  // ?1–?9 各列 ?10 截图 id（JSON 数组） ?11 截图过期界线 ?12 截图张数 ?13 每天上限 ?14 预算 ?15 nonce
  const args = [id, at, at.slice(0, 10), text, install, o.diagnostics, version, os, arch,
    JSON.stringify(shots), cutoff, shots.length, L.FEEDBACK_PER_DAY, L.FEEDBACK_STORE_BUDGET_BYTES, nonce];
  const exists = "EXISTS (SELECT 1 FROM feedback WHERE id = ?1)";
  const shotsOk = `(SELECT COUNT(*) FROM shot WHERE id IN (SELECT value FROM json_each(?10))
                      AND ((feedback_id IS NULL AND at >= ?11) OR feedback_id = ?1)) = ?12`;
  const underCap = "COALESCE((SELECT n FROM daily_count WHERE day = ?3 AND kind = 'feedback'), 0) < ?13";
  const fits = `(SELECT v FROM budget WHERE k = 'feedback_bytes') + ${FEEDBACK_ROW_BYTES} + (SELECT v FROM budget WHERE k = 'cost_feedback_row') <= ?14`;

  const [reason, inserted] = await env.FB.batch<Record<string, unknown>>([
    env.FB.prepare(`SELECT ${exists} AS seen, ${shotsOk} AS shots_ok, ${underCap} AS under_cap, ${fits} AS fits`).bind(...args),
    env.FB.prepare(
      `INSERT INTO feedback (id, at, day, text, install_id, diagnostics, version, os, arch, nonce)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?15 WHERE NOT ${exists} AND ${shotsOk} AND ${underCap} AND ${fits}
       RETURNING 1 AS ok`,
    ).bind(...args),
    // 这一次真插进去了才挂（认这次的 nonce，重发的不挂）；上面已确认这几张都还能挂
    env.FB.prepare(
      `UPDATE shot SET feedback_id = ?1
       WHERE id IN (SELECT value FROM json_each(?2)) AND feedback_id IS NULL AND at >= ?3
         AND EXISTS (SELECT 1 FROM feedback WHERE id = ?1 AND nonce = ?4)`,
    ).bind(id, JSON.stringify(shots), cutoff, nonce),
  ]);
  const r = reason.results[0] ?? {};
  if (inserted.results.length === 1 || r.seen) return json({ ok: true });
  if (!r.shots_ok) throw badRequest("bad_shot");
  throw r.under_cap ? full() : busy();
}
