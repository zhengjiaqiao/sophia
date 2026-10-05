import { describe, expect, it } from "vitest";
import { RATE_LIMIT_PER_MINUTE } from "../src/limits";
import { call, dailyBody, env, feedbackBody, jpeg, postJson, postShot, uuid } from "./helpers";

describe("限流与 IP", () => {
  it("同一 IP 一分钟内超过上限：429 带 Retry-After；换个 IP 不受影响", async () => {
    const ip = "198.51.100.77";
    const codes: number[] = [];
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE + 2; i++) codes.push((await postJson("/v1/daily", dailyBody(), ip)).status);
    expect(codes.slice(0, RATE_LIMIT_PER_MINUTE).every((c) => c === 200)).toBe(true);
    const last = await postJson("/v1/daily", dailyBody(), ip);
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await last.json()).toEqual({ error: "rate_limited" });
    expect((await postJson("/v1/daily", dailyBody(), "198.51.100.78")).status).toBe(200);
  });

  it("统计页不受上报接口的限流影响", async () => {
    // 统计页只靠口令；限流只管 /v1/*
    const res = await call("/admin", { ip: "198.51.100.77" });
    expect(res.status).toBe(401);
  });

  it("没有任何一列存 IP：表结构里没有，写过之后的数据里也没有（两个库都查）", async () => {
    const ip = "203.0.113.199";
    await postJson("/v1/daily", dailyBody(), ip);
    await postJson("/v1/event", { installId: uuid(), version: "1", os: "m", signature: "s-ip", body: "b" }, ip);
    const shot = await (await postShot(jpeg(), ip)).json<{ id: string }>();
    expect((await postJson("/v1/feedback", feedbackBody({ shots: [shot.id] }), ip)).status).toBe(200);

    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
    ).all<{ name: string }>();
    const names = tables.results.map((t) => t.name).sort();
    expect(names).toEqual(["budget", "daily", "daily_new", "daily_summary", "event", "event_quota", "feedback", "feedback_shot", "installs"]);

    const fbTables = await env.FB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
    ).all<{ name: string }>();
    expect(fbTables.results.map((t) => t.name).sort()).toEqual(["budget", "daily_count", "feedback", "shot"]);

    for (const [db, list] of [[env.DB, tables.results], [env.FB, fbTables.results]] as const) {
      for (const { name } of list) {
        const cols = await db.prepare(`SELECT name, type FROM pragma_table_info('${name}')`).all<{ name: string; type: string }>();
        for (const c of cols.results) expect(c.name).not.toMatch(/(^|_)(ip|addr|address|hash|ua|agent)($|_)/i);
        const textCols = cols.results.filter((c) => c.type === "TEXT").map((c) => c.name);
        for (const c of textCols) {
          const hit = await db.prepare(`SELECT COUNT(*) AS n FROM ${name} WHERE instr(${c}, ?1) > 0`).bind(ip).first<{ n: number }>();
          expect(hit!.n, `${name}.${c}`).toBe(0);
        }
      }
    }
  });
});
