// 容量记账对不对：用最大尺寸的行灌本地 D1，库文件实际长的不能超过账上记的。
// 账记得不少于实际，再加上各预算之和留够余量，最坏情况下库就写不满（D1 免费档单库 500 MB）
import { describe, expect, it } from "vitest";
import * as L from "../src/limits";
import { env, feedbackBody, freshIp, jpeg, postJson, postShot, utcDay, uuid } from "./helpers";

const sizeNow = async () => (await env.DB.prepare("SELECT 1").run()).meta.size_after as number;
const budget = async (k: string) => (await env.DB.prepare("SELECT v FROM budget WHERE k = ?1").bind(k).first<{ v: number }>())!.v;

const pad = (prefix: string, len: number) => prefix + "x".repeat(len - prefix.length);
const full = (keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, L.COUNT_MAX]));

const maxDaily = () => ({
  installId: uuid(),
  day: utcDay(),
  version: pad("1.0.0-", L.VERSION_MAX_BYTES),
  os: pad("macOS ", L.OS_MAX_BYTES),
  arch: pad("arm", L.ARCH_MAX_BYTES),
  counts: { self: full(L.COUNT_KEYS.self), external: full(L.COUNT_KEYS.external) },
});

const maxEvent = (body: string) => ({
  installId: uuid(),
  version: pad("1.0.0-", L.VERSION_MAX_BYTES),
  os: pad("macOS ", L.OS_MAX_BYTES),
  signature: pad(`sig-${uuid()}-`, L.SIGNATURE_MAX_BYTES),
  body,
});

/** 灌 n 条，返回 [库实际长了多少, 账上记了多少] */
async function fill(n: number, key: string, post: () => Promise<Response>) {
  const [s0, b0] = [await sizeNow(), await budget(key)];
  for (let i = 0; i < n; i++) expect((await post()).status).toBeLessThan(203);
  return [(await sizeNow()) - s0, (await budget(key)) - b0];
}

describe("容量记账不少于实际占用", () => {
  it("各预算之和留够余量：≤ 350 MB", () => {
    expect(L.DAILY_STORE_BUDGET_BYTES + L.EVENT_STORE_BUDGET_BYTES + L.OTHER_TABLES_RESERVE_BYTES).toBeLessThanOrEqual(350 * 1024 * 1024);
  });

  it("每日上报：每行都是新电脑、字段全部最长", { timeout: 120_000 }, async () => {
    const [grew, booked] = await fill(4000, "daily_bytes", () => postJson("/v1/daily", maxDaily(), freshIp()));
    expect(grew, `实际 ${grew} / 账上 ${booked}（每条实际 ${Math.round(grew / 4000)}、账上 ${Math.round(booked / 4000)}）`).toBeLessThanOrEqual(booked);
  });

  // 原文长短决定它放在叶子页里还是溢出页里，几种长度都要过
  it.each([
    [0, 4000],
    [600, 2000],
    [1800, 600], // 实测最费：一页刚好只放得下一条
    [3000, 1000],
    [4100, 1000],
    [5000, 1000],
    [6000, 600], // 溢出后叶子页里剩的那截刚过半页
    [9000, 600],
    [L.EVENT_BODY_MAX_BYTES, 400],
  ])("事件：原文 %i 字节、每条都是新电脑（多一行名额计数）、其余字段最长（%i 条）", { timeout: 120_000 }, async (size, n) => {
    const body = "b".repeat(size);
    const [grew, booked] = await fill(n, "event_bytes", () => postJson("/v1/event", maxEvent(body), freshIp()));
    expect(grew, `实际 ${grew} / 账上 ${booked}（每条实际 ${Math.round(grew / n)}、账上 ${Math.round(booked / n)}）`).toBeLessThanOrEqual(booked);
  });
});

// 反馈库：同样的办法，库文件实际长的不超过账上记的。全站每天的条数上限在这里每条前清零（测的是记账，不是上限）
const fbSizeNow = async () => (await env.FB.prepare("SELECT 1").run()).meta.size_after as number;
const fbBudget = async (k: string) => (await env.FB.prepare("SELECT v FROM budget WHERE k = ?1").bind(k).first<{ v: number }>())!.v;

async function fbFill(n: number, key: string, post: () => Promise<void>) {
  // 账从 0 记起（只看增量），也免得几组加起来碰到预算上限
  await env.FB.prepare("UPDATE budget SET v = 0 WHERE k = ?1").bind(key).run();
  const s0 = await fbSizeNow();
  for (let i = 0; i < n; i++) {
    await env.FB.prepare("DELETE FROM daily_count").run();
    await post();
  }
  return [(await fbSizeNow()) - s0, await fbBudget(key)];
}

describe("反馈库的容量记账不少于实际占用", () => {
  it("两项预算之和留够余量：≤ 450 MB", () => {
    expect(L.SHOT_STORE_BUDGET_BYTES + L.FEEDBACK_STORE_BUDGET_BYTES).toBeLessThanOrEqual(450 * 1000 * 1000);
  });

  // 存的大小（base64 原文的字节）决定它在叶子页里还是溢出页里、末页剩多少；每张都挂到反馈上（多一个索引项）
  it.each([
    [200, 1000],
    [1500, 1000],
    [2100, 600], // 实测最费：叶子页里一页只放得下一张
    [2400, 600],
    [3000, 600],
    [4200, 600],
    [6192, 400], // 溢出后叶子页里剩的那截刚过半页
    [9000, 400],
    [10284, 300],
    [136536, 200], // 约 100 KiB 的图
    [L.SHOT_MAX_B64_BYTES, 40], // 1 MiB 的图
  ])("截图：存下 %i 字节、挂到反馈上（%i 张）", { timeout: 300_000 }, async (stored, n) => {
    const fid = uuid().replaceAll("-", "");
    await env.FB.prepare(
      "INSERT INTO feedback (id, at, day, text, install_id, diagnostics, version, os, arch, nonce) VALUES (?1, '2026-10-04T00:00:00.000Z', '2026-10-04', 't', NULL, '', '1', 'm', 'a', 'test')",
    ).bind(fid).run();
    // 存的字节都是 4 的倍数；最大那张解码后正好 1 MiB（base64 末尾带两个补齐号，存的仍是这么多）
    const size = Math.min((stored / 4) * 3, L.SHOT_MAX_BYTES);
    const img = jpeg(size);
    const [grew, booked] = await fbFill(n, "shot_bytes", async () => {
      const res = await postShot(img, freshIp());
      expect(res.status).toBe(200);
      const { id } = await res.json<{ id: string }>();
      await env.FB.prepare("UPDATE shot SET feedback_id = ?2 WHERE id = ?1").bind(id, fid).run();
    });
    expect(grew, `实际 ${grew} / 账上 ${booked}（每张实际 ${Math.round(grew / n)}、账上 ${Math.round(booked / n)}）`).toBeLessThanOrEqual(booked);
  });

  // 文字 + 诊断的总长决定它在叶子页还是溢出页；字段全部最长、带安装 ID
  it.each([
    [1, 0, 2000],
    [300, 300, 1000],
    [450, 1350, 600],
    [1000, 2000, 600], // 实测最费：溢出后叶子页里剩的那截刚过半页
    [500, 4100, 600],
    [1100, 3000, 600],
    [1500, 4500, 400],
    [2000, 7000, 400],
    [L.FEEDBACK_TEXT_MAX_CHARS, L.FEEDBACK_DIAGNOSTICS_MAX_BYTES, 300],
  ])("反馈：文字 %i 个 4 字节字符、诊断 %i 字节（%i 条）", { timeout: 300_000 }, async (chars, diag, n) => {
    const text = "😀".repeat(chars);
    const diagnostics = "d".repeat(diag);
    const pad = (prefix: string, len: number) => prefix + "x".repeat(len - prefix.length);
    const [grew, booked] = await fbFill(n, "feedback_bytes", async () => {
      const body = feedbackBody({ text, diagnostics, version: pad("1.0.0-", L.VERSION_MAX_BYTES), os: pad("macOS ", L.OS_MAX_BYTES), arch: pad("arm", L.ARCH_MAX_BYTES) });
      expect((await postJson("/v1/feedback", body, freshIp())).status).toBe(200);
    });
    expect(grew, `实际 ${grew} / 账上 ${booked}（每条实际 ${Math.round(grew / n)}、账上 ${Math.round(booked / n)}）`).toBeLessThanOrEqual(booked);
  });
});
