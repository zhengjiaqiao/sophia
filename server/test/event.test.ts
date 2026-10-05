import { describe, expect, it } from "vitest";
import { EVENT_STORE_BUDGET_BYTES, EVENTS_PER_INSTALL_PER_DAY } from "../src/limits";
import { env, freshIp, postJson, uuid } from "./helpers";

const eventBody = (over: Record<string, unknown> = {}) => ({
  installId: uuid(),
  version: "1.4.0",
  os: "macos15",
  signature: "gateway::blocking/internal",
  body: "panicked at crates/gateway/src/app/mod.rs:120:9\nstack backtrace: ...",
  ...over,
});

const quotaFor = async (id: string) =>
  (await env.DB.prepare("SELECT n FROM event_quota WHERE install_id = ?1").bind(id).first<{ n: number }>())?.n ?? 0;

const budgetUsed = async () =>
  (await env.DB.prepare("SELECT v FROM budget WHERE k = 'event_bytes'").first<{ v: number }>())!.v;

const countFor = async (id: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM event WHERE install_id = ?1").bind(id).first<{ n: number }>())!.n;

describe("POST /v1/event", () => {
  it("收下返回 202，按收到那天落库", async () => {
    const e = eventBody();
    const res = await postJson("/v1/event", e);
    expect(res.status).toBe(202);
    const row = await env.DB.prepare("SELECT * FROM event WHERE install_id = ?1").bind(e.installId).first<Record<string, string>>();
    expect(row).toMatchObject({ signature: e.signature, body: e.body, version: "1.4.0", os: "macos15" });
    expect(row!.day).toBe(new Date().toISOString().slice(0, 10));
  });

  it("同一签名当天只留一条，重复的不占名额", async () => {
    const e = eventBody();
    expect(await (await postJson("/v1/event", e)).json()).toEqual({ stored: true });
    const again = await postJson("/v1/event", { ...e, body: "second" });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ stored: false });
    expect(await countFor(e.installId)).toBe(1);
    expect(await quotaFor(e.installId)).toBe(1);
  });

  it("两条同签名的请求同时到：只存一条，名额只扣一次", async () => {
    const e = eventBody();
    const res = await Promise.all([postJson("/v1/event", e), postJson("/v1/event", e)]);
    expect(res.map((r) => r.status)).toEqual([202, 202]);
    const stored = await Promise.all(res.map((r) => r.json<{ stored: boolean }>()));
    expect(stored.filter((s) => s.stored)).toHaveLength(1);
    expect(await countFor(e.installId)).toBe(1);
    expect(await quotaFor(e.installId)).toBe(1);
  });

  it("存下一条就按字节记进总预算；预算用完后不再存（库不会被事件写满）", async () => {
    const before = await budgetUsed();
    const e = eventBody({ body: "字".repeat(100) });
    await postJson("/v1/event", e);
    const one = (await budgetUsed()) - before;
    const e2 = eventBody({ body: "字".repeat(200) });
    await postJson("/v1/event", e2);
    // 原文多 300 字节，账上也多 300：按 UTF-8 字节记，不按字数
    expect((await budgetUsed()) - before - one).toBe(one + 300);

    await env.DB.prepare("UPDATE budget SET v = ?1 WHERE k = 'event_bytes'").bind(EVENT_STORE_BUDGET_BYTES).run();
    const full = eventBody();
    const res = await postJson("/v1/event", full);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ stored: false });
    expect(await countFor(full.installId)).toBe(0);
    expect(await quotaFor(full.installId)).toBe(0);
    await env.DB.prepare("UPDATE budget SET v = ?1 WHERE k = 'event_bytes'").bind(before).run();
  });

  it("同一台电脑每天有上限，超出的丢掉（仍是 202）；重复签名不占名额", async () => {
    const id = uuid();
    const ip = freshIp();
    await postJson("/v1/event", eventBody({ installId: id, signature: "dup" }), ip);
    await postJson("/v1/event", eventBody({ installId: id, signature: "dup" }), ip);
    for (let i = 1; i < EVENTS_PER_INSTALL_PER_DAY + 3; i++) {
      // 换 IP：这里测的是按电脑计数，不是按 IP 限流
      const res = await postJson("/v1/event", eventBody({ installId: id, signature: `sig-${i}` }), freshIp());
      expect(res.status).toBe(202);
    }
    expect(await countFor(id)).toBe(EVENTS_PER_INSTALL_PER_DAY);
    expect(await quotaFor(id)).toBe(EVENTS_PER_INSTALL_PER_DAY);
  });

  it.each([
    ["签名太长", { signature: "s".repeat(129) }],
    ["签名空", { signature: "" }],
    ["签名非 ASCII", { signature: "panic@模型.rs" }],
    ["version 超 32 字节", { version: "1".repeat(33) }],
    ["body 超 32 KB", { body: "b".repeat(32 * 1024 + 1) }],
    ["没有 installId", { installId: undefined }],
    ["installId 不对", { installId: "nope" }],
    ["多余字段", { extra: 1 }],
  ])("拒收：%s", async (_n, over) => {
    const res = await postJson("/v1/event", eventBody(over));
    expect(res.status).toBe(400);
  });

  it("整条超过 64 KB：413", async () => {
    const res = await postJson("/v1/event", eventBody({ body: "é".repeat(33 * 1024) }));
    expect(res.status).toBe(413);
  });
});
