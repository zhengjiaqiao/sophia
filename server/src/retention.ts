// 定时任务：按 spec R3 的保留期清理。聚合都在 SQL 里做（免费档 Worker 每次只有 10 ms CPU，D1 那边不算）
import type { Env } from "./env";
import { SHOT_ATTACH_WINDOW_MS } from "./limits";

const layerTotals = (layer: "self" | "external") => `json((
    SELECT json_group_object(key, total) FROM (
      SELECT j.key AS key, SUM(j.value) AS total
      FROM daily x, json_each(x.counts_json, '$.${layer}') j
      WHERE x.day = d.day GROUP BY j.key
    )))`;

const distribution = (col: "version" | "os") => `(
    SELECT json_group_object(${col}, n) FROM (
      SELECT ${col}, COUNT(*) AS n FROM daily WHERE day = d.day GROUP BY ${col}
    ))`;

// 13 个月前的每日记录先并成按天汇总，再删原始行。
// 每日上报只收 31 天内的日期，汇总过的日子不会再有新行，所以撞上已有汇总只可能是重跑，跳过即可
const SUMMARIZE = `
  INSERT INTO daily_summary (day, installs, by_version_json, by_os_json, counts_json)
  SELECT d.day, COUNT(*), ${distribution("version")}, ${distribution("os")},
         json_object('self', ${layerTotals("self")}, 'external', ${layerTotals("external")})
  FROM daily d WHERE d.day < ?1 GROUP BY d.day
  ON CONFLICT (day) DO NOTHING`;

const cost = (k: string) => `(SELECT v FROM budget WHERE k = '${k}')`;

const RECOUNT_DAILY = `
  UPDATE budget SET v =
      (SELECT COALESCE(SUM(length(CAST(install_id AS BLOB)) + length(CAST(day AS BLOB)) + length(CAST(version AS BLOB)) + length(CAST(os AS BLOB)) + length(CAST(arch AS BLOB)) + length(CAST(counts_json AS BLOB)) + length(CAST(updated_at AS BLOB)) + ${cost("cost_daily_row")}), 0) FROM daily)
    + (SELECT COUNT(*) FROM installs) * ${cost("cost_install")}
  WHERE k = 'daily_bytes'`;

const RECOUNT_EVENT = `
  UPDATE budget SET v =
      (SELECT COALESCE(SUM(length(CAST(day AS BLOB)) + length(CAST(install_id AS BLOB)) + length(CAST(version AS BLOB)) + length(CAST(os AS BLOB)) + length(CAST(signature AS BLOB)) + length(CAST(body AS BLOB)) + length(CAST(at AS BLOB)) + 2 * length(CAST(signature AS BLOB)) + ${cost("cost_event_row")}), 0) FROM event)
  WHERE k = 'event_bytes'`;

export async function retention(env: Env, now: number): Promise<void> {
  const today = new Date(now).toISOString().slice(0, 10);
  const cut = (await env.DB.prepare(
    "SELECT date(?1, '-13 months') AS m13, date(?1, '-12 months') AS m12, date(?1, '-7 days') AS d7",
  )
    .bind(today)
    .first<{ m13: string; m12: string; d7: string }>())!;

  // 一个 batch 是一个事务：汇总与删除要么都成、要么都不成
  const res = await env.DB.batch([
    env.DB.prepare(SUMMARIZE).bind(cut.m13),
    env.DB.prepare("DELETE FROM daily WHERE day < ?1").bind(cut.m13),
    env.DB.prepare("DELETE FROM event WHERE day < ?1").bind(cut.m13),
    env.DB.prepare("DELETE FROM event_quota WHERE day < ?1").bind(cut.d7),
    env.DB.prepare("DELETE FROM daily_new WHERE day < ?1").bind(cut.d7),
    // feedback.at 是完整 ISO 时间，和日期按字符串比：早于那天 0 点的才删
    env.DB.prepare("DELETE FROM feedback_shot WHERE feedback_id IN (SELECT id FROM feedback WHERE at < ?1)").bind(cut.m12),
    env.DB.prepare("DELETE FROM feedback WHERE at < ?1").bind(cut.m12),
    env.DB.prepare("DELETE FROM installs WHERE NOT EXISTS (SELECT 1 FROM daily d WHERE d.install_id = installs.install_id)"),
    // 容量记账按清理后实际剩下的重算，算法与迁移里的触发器相同
    env.DB.prepare(RECOUNT_DAILY),
    env.DB.prepare(RECOUNT_EVENT),
  ]);
  console.log("retention", JSON.stringify(res.map((r) => r.meta.changes)));
}

const FB_COST = (k: string) => `(SELECT v FROM budget WHERE k = '${k}')`;

const RECOUNT_SHOT = `
  UPDATE budget SET v = (SELECT COALESCE(SUM(bytes + ${FB_COST("cost_shot_row")}), 0) FROM shot)
  WHERE k = 'shot_bytes'`;

const RECOUNT_FEEDBACK = `
  UPDATE budget SET v =
      (SELECT COALESCE(SUM(length(CAST(id AS BLOB)) + length(CAST(at AS BLOB)) + length(CAST(day AS BLOB)) + length(CAST(text AS BLOB)) + COALESCE(length(CAST(install_id AS BLOB)), 0) + length(CAST(diagnostics AS BLOB)) + length(CAST(version AS BLOB)) + length(CAST(os AS BLOB)) + length(CAST(arch AS BLOB)) + length(CAST(nonce AS BLOB)) + ${FB_COST("cost_feedback_row")}), 0) FROM feedback)
  WHERE k = 'feedback_bytes'`;

/**
 * 反馈库（env.FB）：没挂到反馈上的截图 24 小时后删；反馈与它的截图 12 个月后删（R3）；每天的计数 7 天。
 * 删除时触发器已经减了账，最后仍按剩下的重算一遍（算法与迁移里的触发器相同）
 */
export async function feedbackRetention(env: Env, now: number): Promise<void> {
  const today = new Date(now).toISOString().slice(0, 10);
  const loose = new Date(now - SHOT_ATTACH_WINDOW_MS).toISOString();
  const cut = (await env.FB.prepare("SELECT date(?1, '-12 months') AS m12, date(?1, '-7 days') AS d7")
    .bind(today)
    .first<{ m12: string; d7: string }>())!;
  const res = await env.FB.batch([
    env.FB.prepare("DELETE FROM shot WHERE feedback_id IS NULL AND at < ?1").bind(loose),
    // at 是完整 ISO 时间，和日期按字符串比：早于那天 0 点的才删。先删截图再删反馈，账由各自的触发器减
    env.FB.prepare("DELETE FROM shot WHERE feedback_id IN (SELECT id FROM feedback WHERE at < ?1)").bind(cut.m12),
    env.FB.prepare("DELETE FROM feedback WHERE at < ?1").bind(cut.m12),
    env.FB.prepare("DELETE FROM daily_count WHERE day < ?1").bind(cut.d7),
    env.FB.prepare(RECOUNT_SHOT),
    env.FB.prepare(RECOUNT_FEEDBACK),
  ]);
  console.log("feedback retention", JSON.stringify(res.map((r) => r.meta.changes)));
}
