import { afterEach, describe, expect, it } from "vitest";
import { feedback } from "../src/feedback";
import * as L from "../src/limits";
import { call, env, feedbackBody, freshIp, postJson, uploadShot } from "./helpers";

type Row = Record<string, unknown>;
const fbBudget = async (k: string) => (await env.FB.prepare("SELECT v FROM budget WHERE k = ?1").bind(k).first<{ v: number }>())!.v;
const setBudget = (k: string, v: number) => env.FB.prepare("UPDATE budget SET v = ?2 WHERE k = ?1").bind(k, v).run();
const byText = (text: string) => env.FB.prepare("SELECT * FROM feedback WHERE text = ?1").bind(text).all<Row>();
const owner = async (shotId: string) =>
  (await env.FB.prepare("SELECT feedback_id FROM shot WHERE id = ?1").bind(shotId).first<{ feedback_id: string | null }>())?.feedback_id;
const today = () => new Date().toISOString().slice(0, 10);
const uniq = () => `反馈 ${crypto.randomUUID()}`;

describe("POST /v1/feedback", () => {
  let restore: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const r of restore.reverse()) await r();
    restore = [];
  });

  it("收下文字与截图：200 {ok:true}；截图挂到这条反馈上；按收到那天落库", async () => {
    const shots = [await uploadShot(), await uploadShot()];
    const body = feedbackBody({ text: uniq(), shots });
    const res = await postJson("/v1/feedback", body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const { results } = await byText(body.text);
    expect(results).toHaveLength(1);
    const f = results[0];
    expect(f).toMatchObject({
      install_id: body.installId,
      diagnostics: body.diagnostics,
      version: "1.4.0",
      os: "macos15",
      arch: "arm64",
      day: today(),
    });
    expect(f.id).toBe(body.id); // id 由客户端给（每份草稿一个，重试复用）
    expect(Date.now() - Date.parse(f.at as string)).toBeLessThan(60_000);
    for (const s of shots) expect(await owner(s)).toBe(f.id);
  });

  it("不带截图、不带安装 ID（上报关着时）也收；installId 为 null 同样当没带", async () => {
    for (const over of [{ installId: undefined }, { installId: null }]) {
      const body = feedbackBody({ text: uniq(), ...over });
      const res = await postJson("/v1/feedback", body);
      expect(res.status).toBe(200);
      const { results } = await byText(body.text);
      expect(results[0].install_id).toBeNull();
    }
  });

  it("文字首尾空白去掉再存；正好 8000 个字符（含 4 字节的）、诊断正好 32 KiB 也收（整条仍在 64 KiB 以内）", async () => {
    const t = uniq();
    expect((await postJson("/v1/feedback", feedbackBody({ text: `  \n${t}\n ` }))).status).toBe(200);
    expect((await byText(t)).results).toHaveLength(1);
    const long = "😀".repeat(L.FEEDBACK_TEXT_MAX_CHARS);
    const res = await postJson("/v1/feedback", feedbackBody({ text: long, diagnostics: "d".repeat(L.FEEDBACK_DIAGNOSTICS_MAX_BYTES) }));
    expect(res.status).toBe(200);
  });

  it("按字节记账：各列字节 + 每行固定开销；按天计数", async () => {
    const before = await fbBudget("feedback_bytes");
    const n0 =
      (await env.FB.prepare("SELECT n FROM daily_count WHERE day = ?1 AND kind = 'feedback'").bind(today()).first<{ n: number }>())?.n ?? 0;
    const body = feedbackBody({ text: uniq() });
    await postJson("/v1/feedback", body);
    const f = (await byText(body.text)).results[0];
    const enc = (s: unknown) => (s == null ? 0 : new TextEncoder().encode(String(s)).byteLength);
    const cols = ["id", "at", "day", "text", "install_id", "diagnostics", "version", "os", "arch", "nonce"].reduce((s, c) => s + enc(f[c]), 0);
    expect((await fbBudget("feedback_bytes")) - before).toBe(cols + (await fbBudget("cost_feedback_row")));
    const n1 = (await env.FB.prepare("SELECT n FROM daily_count WHERE day = ?1 AND kind = 'feedback'").bind(today()).first<{ n: number }>())!.n;
    expect(n1).toBe(n0 + 1);
  });

  it.each([
    ["没有 id", "bad_id", { id: undefined }],
    ["id 大写", "bad_id", { id: "ABCDEF0123456789ABCDEF0123456789" }],
    ["id 太短", "bad_id", { id: "abc123" }],
    ["id 是 UUID 写法", "bad_id", { id: "0123abcd-0123-4abc-8abc-0123456789ab" }],
    ["没有文字", "bad_text", { text: "" }],
    ["只有空白", "bad_text", { text: " \n\t " }],
    ["文字超过 8000 字", "bad_text", { text: "字".repeat(L.FEEDBACK_TEXT_MAX_CHARS + 1) }],
    ["文字不是字符串", "bad_text", { text: 1 }],
    ["没有 shots", "bad_shot", { shots: undefined }],
    ["shots 不是数组", "bad_shot", { shots: "abc" }],
    ["截图 id 格式不对", "bad_shot", { shots: ["ABCDEF0123456789ABCDEF0123456789"] }],
    ["截图不存在", "bad_shot", { shots: ["0123456789abcdef0123456789abcdef"] }],
    ["installId 不对", "bad_installId", { installId: "nope" }],
    ["诊断内容超过 32 KiB", "bad_diagnostics", { diagnostics: "d".repeat(L.FEEDBACK_DIAGNOSTICS_MAX_BYTES + 1) }],
    ["没有诊断内容", "bad_diagnostics", { diagnostics: undefined }],
    ["version 超长", "bad_version", { version: "1".repeat(L.VERSION_MAX_BYTES + 1) }],
    ["os 非 ASCII", "bad_os", { os: "macOS 十五" }],
    ["没有 arch", "bad_arch", { arch: undefined }],
    ["多余字段", "unknown_field", { email: "a@b.c" }],
  ])("拒收：%s → 400 %s", async (_n, code, over) => {
    const body = feedbackBody({ text: uniq(), ...over });
    const res = await postJson("/v1/feedback", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: code });
    if (typeof body.text === "string") expect((await byText(body.text.trim())).results).toHaveLength(0);
  });

  it("不是 JSON：400 bad_json；整条超过 64 KiB：413", async () => {
    expect(await (await postJson("/v1/feedback", "{nope")).json()).toEqual({ error: "bad_json" });
    const res = await postJson("/v1/feedback", feedbackBody({ text: "字", diagnostics: "d".repeat(L.FEEDBACK_MAX_BYTES) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
  });

  it("截图规则：至多 3 张、不能重复、不能已挂到别的反馈上、不能超过 24 小时；不合规整条不收，别的截图也不挂", async () => {
    const [a, b, c, d] = [await uploadShot(), await uploadShot(), await uploadShot(), await uploadShot()];
    const reject = async (shots: string[]) => {
      const body = feedbackBody({ text: uniq(), shots });
      const res = await postJson("/v1/feedback", body);
      expect(res.status, JSON.stringify(shots)).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_shot" });
      expect((await byText(body.text)).results).toHaveLength(0);
    };
    await reject([a, b, c, d]);
    await reject([a, a]);
    await reject([a, "0123456789abcdef0123456789abcdef"]);
    for (const s of [a, b, c, d]) expect(await owner(s)).toBeNull();

    // 过期的
    await env.FB.prepare("UPDATE shot SET at = ?2 WHERE id = ?1").bind(d, new Date(Date.now() - L.SHOT_ATTACH_WINDOW_MS - 1000).toISOString()).run();
    await reject([a, d]);
    expect(await owner(a)).toBeNull();

    // 已挂到别的反馈上的
    expect((await postJson("/v1/feedback", feedbackBody({ text: uniq(), shots: [a, b, c] }))).status).toBe(200);
    await reject([a]);
  });

  it("幂等：同一 id 重发（响应丢了、客户端重试）回 200，不重复入库、不改任何东西；截图仍挂在它上面", async () => {
    const shots = [await uploadShot(), await uploadShot()];
    const body = feedbackBody({ text: uniq(), shots });
    expect((await postJson("/v1/feedback", body)).status).toBe(200);
    const snapshot = async () => ({
      rows: (await env.FB.prepare("SELECT * FROM feedback WHERE id = ?1").bind(body.id).all()).results,
      owners: await Promise.all(shots.map(owner)),
      budget: await fbBudget("feedback_bytes"),
      today: (await env.FB.prepare("SELECT n FROM daily_count WHERE day = ?1 AND kind = 'feedback'").bind(today()).first<{ n: number }>())!.n,
    });
    const first = await snapshot();
    expect(first.rows).toHaveLength(1);
    expect(first.owners).toEqual([body.id, body.id]);

    // 原样重发
    const again = await postJson("/v1/feedback", body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });
    expect(await snapshot()).toEqual(first);

    // 同一 id 换了内容、带上一张新截图：照样 200，什么都不改，新截图也不挂
    const extra = await uploadShot();
    expect((await postJson("/v1/feedback", { ...body, text: "改过的", shots: [...shots, extra] })).status).toBe(200);
    expect(await snapshot()).toEqual(first);
    expect(await owner(extra)).toBeNull();

    // 当天已到上限、文字预算也满了：重发照样 200（已经存下了）
    const n = first.today;
    const before = first.budget;
    restore.push(() => setBudget("feedback_bytes", before));
    restore.push(() => env.FB.prepare("UPDATE daily_count SET n = ?2 WHERE day = ?1 AND kind = 'feedback'").bind(today(), n).run());
    await env.FB.prepare("UPDATE daily_count SET n = ?2 WHERE day = ?1 AND kind = 'feedback'").bind(today(), L.FEEDBACK_PER_DAY).run();
    await setBudget("feedback_bytes", L.FEEDBACK_STORE_BUDGET_BYTES);
    expect((await postJson("/v1/feedback", body)).status).toBe(200);
    expect((await env.FB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE id = ?1").bind(body.id).first<{ n: number }>())!.n).toBe(1);
  });

  it("幂等：同一 id 的两次请求同时到：都回 200，只存一条", async () => {
    const s = await uploadShot();
    const body = feedbackBody({ text: uniq(), shots: [s] });
    const res = await Promise.all([1, 2].map(() => postJson("/v1/feedback", body, freshIp())));
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    expect((await byText(body.text)).results).toHaveLength(1);
    expect(await owner(s)).toBe(body.id);
  });

  it("幂等：同一 id、同一毫秒的两次请求各带三张不同截图同时到：都回 200，只挂上真插入那次的一组（≤ 3 张）", async () => {
    const groups = [
      [await uploadShot(), await uploadShot(), await uploadShot()],
      [await uploadShot(), await uploadShot(), await uploadShot()],
    ];
    const body = feedbackBody({ text: uniq() });
    const now = Date.now(); // 两次请求的收到时间完全相同
    const send = (shots: string[]) =>
      feedback(
        new Request("https://telemetry.test/v1/feedback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, shots }),
        }),
        env,
        now,
      );
    const res = await Promise.all(groups.map(send));
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    expect((await byText(body.text)).results).toHaveLength(1);
    const attached = (await env.FB.prepare("SELECT id FROM shot WHERE feedback_id = ?1").bind(body.id).all<{ id: string }>()).results.map((r) => r.id);
    expect(attached.length).toBeLessThanOrEqual(L.FEEDBACK_MAX_SHOTS);
    // 恰好是其中一组，另一组一张都没挂
    expect(groups.some((g) => [...g].sort().join() === [...attached].sort().join())).toBe(true);
  });

  it("两条反馈同时挂同一张截图：只有一条成功，另一条 400 bad_shot", async () => {
    const s = await uploadShot();
    const res = await Promise.all([1, 2].map(() => postJson("/v1/feedback", feedbackBody({ text: uniq(), shots: [s] }), freshIp())));
    expect(res.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it("全站当天反馈数到上限：503 busy，不入库、截图不挂", async () => {
    const day = today();
    const n = (await env.FB.prepare("SELECT n FROM daily_count WHERE day = ?1 AND kind = 'feedback'").bind(day).first<{ n: number }>())?.n ?? 0;
    restore.push(() => env.FB.prepare("UPDATE daily_count SET n = ?2 WHERE day = ?1 AND kind = 'feedback'").bind(day, n).run());
    await env.FB.prepare("INSERT INTO daily_count (day, kind, n) VALUES (?1, 'feedback', ?2) ON CONFLICT (day, kind) DO UPDATE SET n = ?2")
      .bind(day, L.FEEDBACK_PER_DAY)
      .run();
    const s = await uploadShot();
    const body = feedbackBody({ text: uniq(), shots: [s] });
    const res = await postJson("/v1/feedback", body);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "busy" });
    expect((await byText(body.text)).results).toHaveLength(0);
    expect(await owner(s)).toBeNull();
  });

  it("文字的预算满了：503 full，不入库", async () => {
    const before = await fbBudget("feedback_bytes");
    restore.push(() => setBudget("feedback_bytes", before));
    await setBudget("feedback_bytes", L.FEEDBACK_STORE_BUDGET_BYTES);
    const s = await uploadShot();
    const body = feedbackBody({ text: uniq(), shots: [s] });
    const res = await postJson("/v1/feedback", body);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "full" });
    expect((await byText(body.text)).results).toHaveLength(0);
    expect(await owner(s)).toBeNull();
  });

  it("截图不合规优先于 busy / full：先回 400，客户端知道要重传", async () => {
    const before = await fbBudget("feedback_bytes");
    restore.push(() => setBudget("feedback_bytes", before));
    await setBudget("feedback_bytes", L.FEEDBACK_STORE_BUDGET_BYTES);
    const res = await postJson("/v1/feedback", feedbackBody({ text: uniq(), shots: ["0123456789abcdef0123456789abcdef"] }));
    expect(res.status).toBe(400);
  });

  it("只认 POST", async () => {
    const res = await call("/v1/feedback");
    expect(res.status).toBe(405);
  });
});
