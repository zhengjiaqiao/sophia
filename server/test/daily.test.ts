import { describe, expect, it } from "vitest";
import { COUNT_MAX, DAILY_STORE_BUDGET_BYTES, NEW_INSTALLS_PER_DAY } from "../src/limits";
import { dailyBody, env, postJson, utcDay } from "./helpers";

const rowsFor = (id: string) =>
  env.DB.prepare("SELECT * FROM daily WHERE install_id = ?1").bind(id).all<Record<string, string>>();

describe("POST /v1/daily", () => {
  it("同一台电脑同一天再报一次：覆盖计数，只有一行", async () => {
    const first = dailyBody();
    expect((await postJson("/v1/daily", first)).status).toBe(200);
    const second = { ...first, version: "1.4.1", counts: { self: { panic: 1 }, external: { network: 7 } } };
    expect((await postJson("/v1/daily", second)).status).toBe(200);

    const { results } = await rowsFor(first.installId);
    expect(results).toHaveLength(1);
    expect(results[0].version).toBe("1.4.1");
    expect(JSON.parse(results[0].counts_json)).toEqual({ self: { panic: 1 }, external: { network: 7 } });
    expect(results[0].updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("次数大得离谱（客户端计数失控）：按上限记，这一天的活跃不丢", async () => {
    const body = dailyBody({ counts: { self: { panic: COUNT_MAX + 1 }, external: { network: 4_000_000_000 } } });
    expect((await postJson("/v1/daily", body)).status).toBe(200);
    const { results } = await rowsFor(body.installId as string);
    expect(JSON.parse(results[0].counts_json)).toEqual({ self: { panic: COUNT_MAX }, external: { network: COUNT_MAX } });
  });

  it("新电脑按收到那天（UTC）计数，同一台电脑再报、补报别的日子不重复计；存下的字节记进预算", async () => {
    const newToday = async () =>
      (await env.DB.prepare("SELECT n FROM daily_new WHERE day = ?1").bind(utcDay()).first<{ n: number }>())?.n ?? 0;
    const bytes = async () => (await env.DB.prepare("SELECT v FROM budget WHERE k = 'daily_bytes'").first<{ v: number }>())!.v;
    const [n0, b0] = [await newToday(), await bytes()];
    const a = dailyBody();
    await postJson("/v1/daily", a);
    const b1 = await bytes();
    expect(b1).toBeGreaterThan(b0);
    await postJson("/v1/daily", a);
    expect(await bytes()).toBe(b1); // 同样长的内容覆盖，字节不变
    await postJson("/v1/daily", { ...a, day: utcDay(-1) });
    expect(await newToday()).toBe(n0 + 1);
    expect(await bytes()).toBeGreaterThan(b1);
  });

  describe("全局上限：造出来的安装 ID 写不满库", () => {
    const capNew = (v: number) =>
      env.DB.prepare("INSERT INTO daily_new (day, n) VALUES (?2, ?1) ON CONFLICT (day) DO UPDATE SET n = ?1").bind(v, utcDay()).run();
    const budget = async () => (await env.DB.prepare("SELECT v FROM budget WHERE k = 'daily_bytes'").first<{ v: number }>())!.v;
    const setBudget = (v: number) => env.DB.prepare("UPDATE budget SET v = ?1 WHERE k = 'daily_bytes'").bind(v).run();

    it("当天新电脑到上限：没见过的电脑不存（202 stored:false）；见过的电脑新的一天、补报照样存", async () => {
      const known = dailyBody({ day: utcDay(-3) });
      expect((await postJson("/v1/daily", known)).status).toBe(200);
      await capNew(NEW_INSTALLS_PER_DAY);
      try {
        const fresh = dailyBody();
        const res = await postJson("/v1/daily", fresh);
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ stored: false });
        expect((await rowsFor(fresh.installId)).results).toHaveLength(0);

        expect((await postJson("/v1/daily", { ...known, day: utcDay() })).status).toBe(200);
        expect((await postJson("/v1/daily", { ...known, day: utcDay(-2) })).status).toBe(200);
        expect((await rowsFor(known.installId)).results).toHaveLength(3);
      } finally {
        await capNew(0);
      }
    });

    it("总字节到预算：谁的新行都不存，已有的行照样更新", async () => {
      const existing = dailyBody();
      expect((await postJson("/v1/daily", existing)).status).toBe(200);
      const saved = await budget();
      await setBudget(DAILY_STORE_BUDGET_BYTES);
      try {
        const fresh = dailyBody();
        expect((await postJson("/v1/daily", fresh)).status).toBe(202);
        expect((await rowsFor(fresh.installId)).results).toHaveLength(0);
        expect((await postJson("/v1/daily", { ...existing, day: utcDay(-1) })).status).toBe(202);

        const upd = await postJson("/v1/daily", { ...existing, version: "2.0.0" });
        expect(upd.status).toBe(200);
        expect((await rowsFor(existing.installId)).results[0].version).toBe("2.0.0");
      } finally {
        await setBudget(saved);
      }
    });
  });

  it("不同天各一行", async () => {
    const a = dailyBody();
    await postJson("/v1/daily", a);
    await postJson("/v1/daily", { ...a, day: utcDay(-1) });
    expect((await rowsFor(a.installId)).results).toHaveLength(2);
  });

  it("客户端本地日期可能比 UTC 早一天：明天收", async () => {
    expect((await postJson("/v1/daily", dailyBody({ day: utcDay(1) }))).status).toBe(200);
  });

  it("31 天前收，32 天前不收", async () => {
    expect((await postJson("/v1/daily", dailyBody({ day: utcDay(-31) }))).status).toBe(200);
    expect((await postJson("/v1/daily", dailyBody({ day: utcDay(-32) }))).status).toBe(400);
  });

  it("后天（未来）不收", async () => {
    expect((await postJson("/v1/daily", dailyBody({ day: utcDay(2) }))).status).toBe(400);
  });

  it.each([
    ["installId 不是 uuid v4", { installId: "abc" }],
    ["installId 是 v1", { installId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" }],
    ["day 格式不对", { day: "2026/10/04" }],
    ["day 不是真日期", { day: "2026-02-30" }],
    ["version 缺", { version: undefined }],
    ["version 超 32 字节", { version: "1".repeat(33) }],
    ["version 非 ASCII", { version: "１.0.0" }],
    ["os 超 32 字节", { os: "m".repeat(33) }],
    ["os 非 ASCII", { os: "macOS 十五" }],
    ["arch 超 16 字节", { arch: "a".repeat(17) }],
    ["installId 大写", { installId: "6BA7B810-9DAD-41D1-80B4-00C04FD430C8" }],
    ["os 不是字符串", { os: 15 }],
    ["arch 空", { arch: "" }],
    ["counts 缺", { counts: undefined }],
    ["counts 多一层", { counts: { self: {}, external: {}, other: {} } }],
    ["未知类别", { counts: { self: { whatever: 1 }, external: {} } }],
    ["负数", { counts: { self: { panic: -1 }, external: {} } }],
    ["小数", { counts: { self: { panic: 1.5 }, external: {} } }],
    ["超出 u32", { counts: { self: { panic: 2 ** 32 }, external: {} } }],
    ["字符串数字", { counts: { self: { panic: "1" }, external: {} } }],
    ["多余字段", { ip: "1.2.3.4" }],
  ])("拒收：%s", async (_name, over) => {
    const body = dailyBody(over as Record<string, unknown>);
    const res = await postJson("/v1/daily", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
    expect((await rowsFor(body.installId as string)).results).toHaveLength(0);
  });

  it("不是 JSON：400，JSON 错误体", async () => {
    const res = await postJson("/v1/daily", "{not json");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "bad_json" });
  });

  it("超过 4 KB：413", async () => {
    const res = await postJson("/v1/daily", dailyBody({ pad: "x".repeat(4 * 1024) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
  });
});
