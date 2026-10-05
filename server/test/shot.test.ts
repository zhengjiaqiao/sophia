import { afterEach, describe, expect, it } from "vitest";
import { shot } from "../src/feedback";
import * as L from "../src/limits";
import { b64, b64Len, call, env, freshIp, hexId, jpeg, postShot, uploadShot } from "./helpers";

const fbBudget = async (k: string) => (await env.FB.prepare("SELECT v FROM budget WHERE k = ?1").bind(k).first<{ v: number }>())!.v;
const setBudget = (k: string, v: number) => env.FB.prepare("UPDATE budget SET v = ?2 WHERE k = ?1").bind(k, v).run();
const shotRow = (id: string) => env.FB.prepare("SELECT * FROM shot WHERE id = ?1").bind(id).first<Record<string, unknown>>();
const today = () => new Date().toISOString().slice(0, 10);
const shotsToday = async () =>
  (await env.FB.prepare("SELECT n FROM daily_count WHERE day = ?1 AND kind = 'shot'").bind(today()).first<{ n: number }>())?.n ?? 0;

/** 直接在库里把截图挂到一条反馈上，并把上传时间改成指定的时刻（测淘汰顺序用） */
async function attach(shotId: string, at: string, feedbackId = hexId()) {
  await env.FB.batch([
    env.FB.prepare(
      "INSERT OR IGNORE INTO feedback (id, at, day, text, install_id, diagnostics, version, os, arch, nonce) VALUES (?1, ?2, substr(?2, 1, 10), 'keep me', NULL, '', '1', 'm', 'a', 'test')",
    ).bind(feedbackId, at),
    env.FB.prepare("UPDATE shot SET feedback_id = ?2, at = ?3 WHERE id = ?1").bind(shotId, feedbackId, at),
  ]);
  return feedbackId;
}

describe("POST /v1/shot", () => {
  // 预算与日计数在同一个测试文件里是共用的：改过的都还原
  let restore: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const r of restore.reverse()) await r();
    restore = [];
  });
  const withBudget = async (v: number) => {
    const before = await fbBudget("shot_bytes");
    restore.push(() => setBudget("shot_bytes", before));
    await setBudget("shot_bytes", v);
  };

  it("收下一张 base64 的 JPEG：回 32 位小写 hex 的随机 id，原文存进反馈库、还没挂到反馈上", async () => {
    const img = jpeg(5000);
    const res = await postShot(img, undefined, "text/plain; charset=utf-8");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const { id } = await res.json<{ id: string }>();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const row = await shotRow(id);
    // 存的是 base64 原文，bytes 是存的字节数
    expect(row).toMatchObject({ id, feedback_id: null, bytes: b64Len(5000), jpeg_b64: b64(img) });
    expect(Date.now() - Date.parse(row!.at as string)).toBeLessThan(60_000);
    // 两张 id 不同
    expect(await uploadShot()).not.toBe(id);
  });

  it("按存的字节记账：base64 长度 + 每行固定开销；按天计数", async () => {
    const [before, count] = [await fbBudget("shot_bytes"), await shotsToday()];
    await uploadShot(7000);
    expect((await fbBudget("shot_bytes")) - before).toBe(b64Len(7000) + (await fbBudget("cost_shot_row")));
    expect(await shotsToday()).toBe(count + 1);
  });

  it("解码后正好 1 MiB 收；多 1 字节 413（base64 长度没超也一样）", async () => {
    expect(b64Len(L.SHOT_MAX_BYTES + 1)).toBeLessThanOrEqual(L.SHOT_MAX_B64_BYTES);
    expect((await postShot(jpeg(L.SHOT_MAX_BYTES))).status).toBe(200);
    const res = await postShot(jpeg(L.SHOT_MAX_BYTES + 1));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
  });

  it("不信 Content-Length：没有长度的流式请求体超过 base64 上限也是 413", async () => {
    const text = new TextEncoder().encode(b64(jpeg(L.SHOT_MAX_BYTES + 10)));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let at = 0; at < text.byteLength; at += 64 * 1024) c.enqueue(text.slice(at, at + 64 * 1024));
        c.close();
      },
    });
    const res = await postShot(stream);
    expect(res.status).toBe(413);
  });

  it.each([
    ["不是 JPEG 开头", () => postShot(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))],
    ["空请求体", () => postShot(new Uint8Array())],
    ["只有魔数", () => postShot(new Uint8Array([0xff, 0xd8, 0xff]))],
    ["不是 base64 字符", () => postShot(b64(jpeg(30)).slice(0, -4) + "ab!c")],
    ["中间夹换行", () => ((t: string) => postShot(`${t.slice(0, 20)}\n${t.slice(21)}`))(b64(jpeg(30)))],
    ["长度不是 4 的倍数", () => postShot(b64(jpeg(30)).slice(0, -1))],
    ["补齐号在中间", () => postShot(`/9j/${"A=AA".repeat(4)}`)],
    ["二进制直接发（老格式）", () => postShot(b64(jpeg()), undefined, "image/jpeg")],
    ["content-type 是 JSON", () => postShot(jpeg(), undefined, "application/json")],
  ])("拒收：%s → 400 bad_image，不入库", async (_n, send) => {
    const before = await env.FB.prepare("SELECT COUNT(*) AS n FROM shot").first<{ n: number }>();
    const res = await send();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_image" });
    expect(await env.FB.prepare("SELECT COUNT(*) AS n FROM shot").first<{ n: number }>()).toEqual(before);
  });

  it("只认 POST", async () => {
    const res = await call("/v1/shot");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("同一 IP 一分钟内超过上限：429 rate_limited", async () => {
    const ip = "198.51.100.90";
    for (let i = 0; i < L.RATE_LIMIT_PER_MINUTE; i++) expect((await postShot(jpeg(64), ip)).status).toBe(200);
    const res = await postShot(jpeg(64), ip);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("全站当天新截图数到上限：503 busy，不入库、不淘汰别的", async () => {
    const day = today();
    const n = await shotsToday();
    restore.push(() => env.FB.prepare("UPDATE daily_count SET n = ?2 WHERE day = ?1 AND kind = 'shot'").bind(day, n).run());
    // 挂上一张旧的：预算也满时，到上限要先回 busy、不能为它淘汰别的
    const a = await uploadShot();
    await attach(a, "2026-01-01T00:00:00.000Z");
    await env.FB.prepare("INSERT INTO daily_count (day, kind, n) VALUES (?1, 'shot', ?2) ON CONFLICT (day, kind) DO UPDATE SET n = ?2")
      .bind(day, L.NEW_SHOTS_PER_DAY)
      .run();
    await withBudget(L.SHOT_STORE_BUDGET_BYTES);
    const before = await env.FB.prepare("SELECT COUNT(*) AS n FROM shot").first<{ n: number }>();
    const res = await postShot(jpeg(), freshIp());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "busy" });
    expect(await env.FB.prepare("SELECT COUNT(*) AS n FROM shot").first<{ n: number }>()).toEqual(before);
    expect(await shotRow(a)).not.toBeNull();
    expect(await shotsToday()).toBe(L.NEW_SHOTS_PER_DAY);
  });

  it("预算不够时先删过期没挂上的，再删最旧的已挂上的截图腾地方；反馈文字保留，删得刚好够", async () => {
    const cost = await fbBudget("cost_shot_row");
    const [one, size] = [b64Len(1000), 2000]; // 一张旧图存的字节；新图解码后的字节
    const need = b64Len(size) + cost;
    const expired = await uploadShot(1000);
    const oldest = await uploadShot(1000);
    const older = await uploadShot(1000);
    const fresh = await uploadShot(1000); // 刚传、还没挂上的不动
    await env.FB.prepare("UPDATE shot SET at = ?2 WHERE id = ?1").bind(expired, new Date(Date.now() - L.SHOT_ATTACH_WINDOW_MS - 60_000).toISOString()).run();
    const fbOld = await attach(oldest, "2025-11-01T00:00:00.000Z");
    await attach(older, "2025-12-01T00:00:00.000Z");

    // 新的一张要的空间比预算剩下的多出「一张过期的 + 1 字节」：删掉过期的那张、再删最旧的已挂上的一张就够
    await withBudget(L.SHOT_STORE_BUDGET_BYTES - need + (one + cost) + 1);
    const res = await postShot(jpeg(size));
    expect(res.status).toBe(200);
    const { id } = await res.json<{ id: string }>();
    expect(await shotRow(expired)).toBeNull();
    expect(await shotRow(oldest)).toBeNull();
    expect(await shotRow(older)).not.toBeNull();
    expect(await shotRow(fresh)).not.toBeNull();
    expect(await shotRow(id)).not.toBeNull();
    expect(await env.FB.prepare("SELECT text FROM feedback WHERE id = ?1").bind(fbOld).first()).toEqual({ text: "keep me" });
    // 账：删掉两张、加上新的一张，记账在预算以内
    expect(await fbBudget("shot_bytes")).toBe(L.SHOT_STORE_BUDGET_BYTES - need + (one + cost) + 1 - 2 * (one + cost) + need);
    expect(await fbBudget("shot_bytes")).toBeLessThanOrEqual(L.SHOT_STORE_BUDGET_BYTES);
  });

  it("删光已挂上的也腾不出地方：503 full，什么都不删", async () => {
    const a = await uploadShot(500);
    await attach(a, "2026-01-01T00:00:00.000Z");
    const total = await env.FB.prepare("SELECT COUNT(*) AS n FROM shot").first<{ n: number }>();
    await withBudget(L.SHOT_STORE_BUDGET_BYTES + 10 * 1024 * 1024);
    const res = await postShot(jpeg(1000));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "full" });
    expect(await shotRow(a)).not.toBeNull();
    expect(await env.FB.prepare("SELECT COUNT(*) AS n FROM shot").first<{ n: number }>()).toEqual(total);
  });

  it("每天新截图上限 × 单张存下的最大字节不超过截图预算：一天刷不满", () => {
    expect(L.NEW_SHOTS_PER_DAY * (L.SHOT_MAX_B64_BYTES + 3072)).toBeLessThanOrEqual(L.SHOT_STORE_BUDGET_BYTES);
  });

  describe("正常路径不扫截图表（D1 免费档按读行数计费）", () => {
    const N = 400;
    /** 直接调处理函数，记下它发出的每个 batch 里每条语句读了几行（处理函数只用 batch 访问反馈库） */
    async function rowsRead(body: string): Promise<{ status: number; reads: number[] }> {
      const reads: number[] = [];
      const FB = new Proxy(env.FB, {
        get(t, p) {
          if (p === "batch")
            return async (stmts: D1PreparedStatement[]) => {
              const r = await t.batch(stmts);
              reads.push(...r.map((x) => x.meta.rows_read ?? 0));
              return r;
            };
          const v = Reflect.get(t, p);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      const req = new Request("https://telemetry.test/v1/shot", { method: "POST", headers: { "content-type": "text/plain" }, body });
      try {
        return { status: (await shot(req, { ...env, FB })).status, reads };
      } catch (e) {
        return { status: (e as { status: number }).status, reads };
      }
    }
    const total = (r: number[]) => r.reduce((a, b) => a + b, 0);

    it(`库里已有 ${N} 张截图（一半已挂上）：收一张只读常数行；到日上限时也一样；真要淘汰时才扫表`, async () => {
      const fid = hexId();
      await env.FB.prepare(
        "INSERT INTO feedback (id, at, day, text, install_id, diagnostics, version, os, arch, nonce) VALUES (?1, '2026-01-01T00:00:00.000Z', '2026-01-01', 't', NULL, '', '1', 'm', 'a', 'test')",
      ).bind(fid).run();
      const fresh = new Date().toISOString();
      for (let i = 0; i < N; i += 50) {
        await env.FB.batch(
          Array.from({ length: 50 }, (_, k) =>
            env.FB.prepare("INSERT INTO shot (id, feedback_id, at, bytes, jpeg_b64) VALUES (?1, ?2, ?3, 8, '/9j/2Q==')").bind(
              hexId(),
              (i + k) % 2 ? fid : null,
              (i + k) % 2 ? "2026-01-01T00:00:00.000Z" : fresh,
            ),
          ),
        );
      }
      const img = b64(jpeg(3000));

      const ok = await rowsRead(img);
      expect(ok.status).toBe(200);
      expect(total(ok.reads), JSON.stringify(ok.reads)).toBeLessThan(30);

      // 日上限满了：回 busy，也不扫
      const day = today();
      const n = await shotsToday();
      restore.push(() => env.FB.prepare("UPDATE daily_count SET n = ?2 WHERE day = ?1 AND kind = 'shot'").bind(day, n).run());
      await env.FB.prepare("UPDATE daily_count SET n = ?2 WHERE day = ?1 AND kind = 'shot'").bind(day, L.NEW_SHOTS_PER_DAY).run();
      await withBudget(L.SHOT_STORE_BUDGET_BYTES);
      const busy = await rowsRead(img);
      expect(busy.status).toBe(503);
      expect(total(busy.reads), JSON.stringify(busy.reads)).toBeLessThan(30);

      // 对照：预算真不够、要淘汰时才扫（证明上面的计数能看出扫表）
      await env.FB.prepare("UPDATE daily_count SET n = 0 WHERE day = ?1 AND kind = 'shot'").bind(day).run();
      const evict = await rowsRead(img);
      expect(evict.status).toBe(200);
      expect(total(evict.reads)).toBeGreaterThanOrEqual(N / 2);
    });
  });
});
