// 上报接口：每日上报、Sophia 自身错误事件。只收不读。用户反馈在 feedback.ts（单独的库）
import type { Env } from "./env";
import { badRequest, json, readJson, utf8Bytes } from "./http";
import * as L from "./limits";
import { asciiField, asObject, counts, installId, onlyKeys, parseDay } from "./validate";

const DAY_MS = 86_400_000;
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * POST /v1/daily：每台电脑每天一行，后来的覆盖前面的（客户端当天会用累计数再报）。
 * 新建一行要过全局上限：没见过的电脑受「当天新电脑数」限，所有新行受字节预算限；已有的行照样更新。
 * 不收的回 202 + stored:false。判断与写入是同一条语句，计数与记账由触发器在真写入时做（见迁移）
 */
export async function daily(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const o = asObject(await readJson(req, L.DAILY_MAX_BYTES));
  onlyKeys(o, ["installId", "day", "version", "os", "arch", "counts"]);
  const id = installId(o.installId);
  const dayMs = parseDay(o.day);
  const today = Date.parse(`${utcDay(now)}T00:00:00Z`);
  if (dayMs < today - L.DAILY_MAX_AGE_DAYS * DAY_MS || dayMs > today + L.DAILY_FUTURE_TOLERANCE_DAYS * DAY_MS) {
    throw badRequest("day_out_of_range");
  }
  const version = asciiField(o.version, "version", L.VERSION_MAX_BYTES);
  const os = asciiField(o.os, "os", L.OS_MAX_BYTES);
  const arch = asciiField(o.arch, "arch", L.ARCH_MAX_BYTES);
  const c = counts(o.counts);

  // date('now') 与触发器里的同源，按收到时的 UTC 日数新电脑
  const res = await env.DB.prepare(
    `INSERT INTO daily (install_id, day, version, os, arch, counts_json, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE EXISTS (SELECT 1 FROM daily WHERE install_id = ?1 AND day = ?2)
        OR ((EXISTS (SELECT 1 FROM installs WHERE install_id = ?1)
             OR COALESCE((SELECT n FROM daily_new WHERE day = date('now')), 0) < ?8)
            AND (SELECT v FROM budget WHERE k = 'daily_bytes') < ?9)
     ON CONFLICT (install_id, day) DO UPDATE SET
       version = excluded.version, os = excluded.os, arch = excluded.arch,
       counts_json = excluded.counts_json, updated_at = excluded.updated_at
     RETURNING 1 AS ok`,
  )
    .bind(id, o.day, version, os, arch, JSON.stringify(c), new Date(now).toISOString(),
      L.NEW_INSTALLS_PER_DAY, L.DAILY_STORE_BUDGET_BYTES)
    .all();
  return res.results.length === 1 ? json({ ok: true }) : json({ stored: false }, 202);
}

/**
 * POST /v1/event：同一台电脑同一签名每天一条，每天至多 EVENTS_PER_INSTALL_PER_DAY 条，
 * 全库事件不超过 EVENT_STORE_BUDGET_BYTES；不收的回 202 + stored:false。
 * 查重（唯一索引）、名额与预算的判断、插入是同一条语句；扣名额、记字节由触发器在真插入时做（见迁移）。
 * 所以并发的重复请求只扣一次，没存下的不扣
 */
export async function event(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const o = asObject(await readJson(req, L.EVENT_MAX_BYTES));
  onlyKeys(o, ["installId", "version", "os", "signature", "body"]);
  const id = installId(o.installId);
  const version = asciiField(o.version, "version", L.VERSION_MAX_BYTES);
  const os = asciiField(o.os, "os", L.OS_MAX_BYTES);
  const signature = asciiField(o.signature, "signature", L.SIGNATURE_MAX_BYTES);
  if (typeof o.body !== "string" || utf8Bytes(o.body) > L.EVENT_BODY_MAX_BYTES) throw badRequest("bad_body");

  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO event (day, install_id, version, os, signature, body, at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE COALESCE((SELECT n FROM event_quota WHERE install_id = ?2 AND day = ?1), 0) < ?8
       AND (SELECT v FROM budget WHERE k = 'event_bytes') < ?9
     RETURNING id`,
  )
    .bind(utcDay(now), id, version, os, signature, o.body, new Date(now).toISOString(),
      L.EVENTS_PER_INSTALL_PER_DAY, L.EVENT_STORE_BUDGET_BYTES)
    .all();
  // 认 RETURNING 的行数而不是 meta.changes：后者把触发器里的改动也算进去
  return json({ stored: res.results.length === 1 }, 202);
}
