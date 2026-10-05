import { createScheduledController } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { env } from "./helpers";

// 固定「现在」，按这个时间判断保留期
const NOW = Date.parse("2026-10-04T03:17:00Z");
const run = () => worker.scheduled!(createScheduledController({ scheduledTime: NOW, cron: "17 3 * * *" }), env, {} as ExecutionContext);

const insertDaily = (id: string, day: string, version: string, os: string, counts: object) =>
  env.DB.prepare("INSERT INTO daily VALUES (?1, ?2, ?3, ?4, 'arm64', ?5, ?6)")
    .bind(id, day, version, os, JSON.stringify(counts), `${day}T12:00:00Z`)
    .run();

const count = async (sql: string, ...args: unknown[]) =>
  (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;

describe("定时任务：保留期", () => {
  beforeEach(async () => {
    await env.DB.batch(
      ["daily", "daily_new", "installs", "daily_summary", "event", "event_quota", "feedback_shot", "feedback"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    );
  });

  it("13 个月前的每日记录并进按天汇总，原始行删除；13 个月内的不动", async () => {
    // 2026-10-04 往前 13 个月是 2025-09-04
    await insertDaily("a", "2025-09-03", "1.0.0", "macos14", { self: { panic: 1 }, external: { network: 2 } });
    await insertDaily("b", "2025-09-03", "1.0.0", "macos15", { self: { panic: 2, internal: 1 }, external: {} });
    await insertDaily("c", "2025-09-03", "1.1.0", "macos15", { self: {}, external: { network: 1, auth: 4 } });
    await insertDaily("a", "2025-09-04", "1.1.0", "macos14", { self: {}, external: {} });

    await run();

    expect(await count("SELECT COUNT(*) AS n FROM daily WHERE day = '2025-09-03'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM daily WHERE day = '2025-09-04'")).toBe(1);
    const s = await env.DB.prepare("SELECT * FROM daily_summary WHERE day = '2025-09-03'").first<Record<string, string | number>>();
    expect(s!.installs).toBe(3);
    expect(JSON.parse(s!.by_version_json as string)).toEqual({ "1.0.0": 2, "1.1.0": 1 });
    expect(JSON.parse(s!.by_os_json as string)).toEqual({ macos14: 1, macos15: 2 });
    expect(JSON.parse(s!.counts_json as string)).toEqual({ self: { panic: 3, internal: 1 }, external: { network: 3, auth: 4 } });
    expect(await count("SELECT COUNT(*) AS n FROM daily_summary WHERE day = '2025-09-04'")).toBe(0);
    // 字节预算按清理后剩下的重算：和只写入剩下那一行时触发器记的一样；只在被删的日子出现过的电脑也清掉
    expect(await count("SELECT COUNT(*) AS n FROM installs WHERE install_id IN ('b', 'c')")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM installs WHERE install_id = 'a'")).toBe(1);
    const recomputed = await count("SELECT v AS n FROM budget WHERE k = 'daily_bytes'");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM daily"),
      env.DB.prepare("DELETE FROM installs"),
      env.DB.prepare("UPDATE budget SET v = 0 WHERE k = 'daily_bytes'"),
    ]);
    await insertDaily("a", "2025-09-04", "1.1.0", "macos14", { self: {}, external: {} });
    expect(await count("SELECT v AS n FROM budget WHERE k = 'daily_bytes'")).toBe(recomputed);

    // 再跑一次不重复汇总
    await run();
    const again = await env.DB.prepare("SELECT installs FROM daily_summary WHERE day = '2025-09-03'").first<{ installs: number }>();
    expect(again!.installs).toBe(3);
  });

  it("事件 13 个月、事件计数 7 天、反馈与截图 12 个月", async () => {
    const ev = (day: string) =>
      env.DB.prepare("INSERT INTO event (day, install_id, version, os, signature, body, at) VALUES (?1, 'i', 'v', 'o', ?2, 'b', ?3)").bind(
        day,
        `sig-${day}`,
        `${day}T00:00:00Z`,
      );
    const quota = (day: string) => env.DB.prepare("INSERT INTO event_quota VALUES ('i', ?1, 3)").bind(day);
    const dailyNew = (day: string) => env.DB.prepare("INSERT INTO daily_new VALUES (?1, 5)").bind(day);
    const fb = (id: number, at: string) =>
      env.DB.prepare("INSERT INTO feedback (id, at, text) VALUES (?1, ?2, 't')").bind(id, at);
    const shot = (id: number) => env.DB.prepare("INSERT INTO feedback_shot VALUES (?1, 1, x'ffd8ffd9')").bind(id);
    await env.DB.batch([
      ev("2025-09-03"),
      ev("2025-09-04"),
      quota("2026-09-26"),
      quota("2026-09-27"),
      dailyNew("2026-09-26"),
      dailyNew("2026-09-27"),
      fb(1, "2025-10-03T23:59:59Z"),
      fb(2, "2025-10-04T00:00:01Z"),
      shot(1),
      shot(2),
    ]);

    await run();

    expect(await count("SELECT COUNT(*) AS n FROM event WHERE day = '2025-09-03'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM event WHERE day = '2025-09-04'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM event_quota WHERE day = '2026-09-26'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM event_quota WHERE day = '2026-09-27'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM daily_new WHERE day = '2026-09-26'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM daily_new WHERE day = '2026-09-27'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM feedback WHERE id = 1")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM feedback_shot WHERE feedback_id = 1")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM feedback WHERE id = 2")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM feedback_shot WHERE feedback_id = 2")).toBe(1);
    // 事件的字节预算按清理后剩下的重算：和只写入剩下那一条时触发器记的一样
    const recomputed = await count("SELECT v AS n FROM budget WHERE k = 'event_bytes'");
    await env.DB.batch([env.DB.prepare("DELETE FROM event"), env.DB.prepare("UPDATE budget SET v = 0 WHERE k = 'event_bytes'")]);
    await ev("2025-09-04").run();
    expect(await count("SELECT v AS n FROM budget WHERE k = 'event_bytes'")).toBe(recomputed);
  });

  it("反馈库：没挂上的截图 24 小时后删；反馈与它的截图 12 个月后删；日计数 7 天；字节预算按剩下的重算", async () => {
    await env.FB.batch(["shot", "feedback", "daily_count"].map((t) => env.FB.prepare(`DELETE FROM ${t}`)));
    const fb = (id: string, at: string) =>
      env.FB.prepare("INSERT INTO feedback (id, at, day, text, install_id, diagnostics, version, os, arch, nonce) VALUES (?1, ?2, substr(?2, 1, 10), '文字', NULL, 'diag', '1.0.0', 'macos15', 'arm64', 'test')").bind(id, at);
    const shot = (id: string, at: string, feedbackId: string | null) =>
      env.FB.prepare("INSERT INTO shot (id, feedback_id, at, bytes, jpeg_b64) VALUES (?1, ?3, ?2, 8, '/9j/2Q==')").bind(id, at, feedbackId);
    const counter = (day: string) => env.FB.prepare("INSERT INTO daily_count (day, kind, n) VALUES (?1, 'shot', 3)").bind(day);
    await env.FB.batch([
      fb("f-old", "2025-10-03T23:59:59.000Z"),
      fb("f-new", "2025-10-04T00:00:01.000Z"),
      shot("s-old-attached", "2025-10-03T23:00:00.000Z", "f-old"),
      shot("s-new-attached", "2025-10-03T23:00:00.000Z", "f-new"), // 截图早于 12 个月，但反馈没过期：跟着反馈留
      shot("s-loose-expired", "2026-10-03T03:16:59.000Z", null), // NOW 前 24 小时零 1 秒
      shot("s-loose-fresh", "2026-10-03T03:17:01.000Z", null),
      counter("2026-09-26"),
      counter("2026-09-27"),
    ]);

    await run();

    const ids = async (t: string) => (await env.FB.prepare(`SELECT id FROM ${t} ORDER BY id`).all<{ id: string }>()).results.map((r) => r.id);
    expect(await ids("feedback")).toEqual(["f-new"]);
    expect(await ids("shot")).toEqual(["s-loose-fresh", "s-new-attached"]);
    // 触发器按上传 / 收到那天也记了数：2025 年那几天的删掉，7 天内的留着
    expect((await env.FB.prepare("SELECT DISTINCT day FROM daily_count ORDER BY day").all()).results).toEqual([{ day: "2026-09-27" }, { day: "2026-10-03" }]);

    // 账和只写入剩下的行时触发器记的一样
    const booked = async () => (await env.FB.prepare("SELECT k, v FROM budget WHERE k IN ('shot_bytes', 'feedback_bytes') ORDER BY k").all()).results;
    const after = await booked();
    await env.FB.batch([
      env.FB.prepare("DELETE FROM shot"),
      env.FB.prepare("DELETE FROM feedback"),
      env.FB.prepare("UPDATE budget SET v = 0 WHERE k IN ('shot_bytes', 'feedback_bytes')"),
    ]);
    await env.FB.batch([fb("f-new", "2025-10-04T00:00:01.000Z"), shot("s-new-attached", "2025-10-03T23:00:00.000Z", "f-new"), shot("s-loose-fresh", "2026-10-03T03:17:01.000Z", null)]);
    expect(await booked()).toEqual(after);
    expect(after.every((r) => Number(r.v) > 0)).toBe(true);
  });
});
