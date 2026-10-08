/// 应用内反馈（spec 2026-10-04-reporting-feedback R11–R14，AC10–AC12 的代理验证）：反馈小窗的纯逻辑——
/// 出错页与意外退出提示用哪种说法、截图压到多大、截图的上传状态、发送键的状态、失败原因、等截图传完再发。
/// 组件本身在 feedback-dialog.test.ts 里用服务端渲染断言长相
import assert from "node:assert/strict";
import test from "node:test";
import {
  FAILURE_KEY,
  LONG_SIDE,
  MAX_SHOTS,
  SHOT_MAX_BYTES,
  crashNotice,
  deliver,
  encodeUnder,
  failureOf,
  offerReport,
  scaledSize,
  sentPlacement,
  FINISH_MS,
  attemptFor,
  type Attempt,
  type ShotAction,
  draftId,
  quiet,
  sendKey,
  shotPercent,
  shotPhase,
  shotsReducer,
  simulatedPercent,
  simulatedTau,
  type ShotState,
} from "../src/feedbackView.ts";
import type { ReportSettings } from "../src/types.ts";

const settings = (s: Partial<ReportSettings>): ReportSettings => ({
  autoReport: true,
  available: true,
  feedback: true,
  ...s,
});

// ===== 出错处的两种说法（R11、AC10）=====

test("offerReport：有接收服务、且自动上报没在生效（关着，或 DO_NOT_TRACK）时才给 `报告这个问题`", () => {
  assert.equal(offerReport(settings({ autoReport: false })), true, "开关关着");
  assert.equal(offerReport(settings({ available: false })), true, "DO_NOT_TRACK：开关开着也没在发");
  assert.equal(offerReport(settings({})), false, "开着：维护者已经自动拿到了，不打扰");
  assert.equal(
    offerReport(settings({ autoReport: false, feedback: false })),
    false,
    "没有接收服务",
  );
  assert.equal(offerReport(null), false, "还没读回来、内部版");
});

test("crashNotice：上次意外退出、且同上一条规则时才提示", () => {
  assert.equal(crashNotice(true, settings({ autoReport: false })), true);
  assert.equal(crashNotice(false, settings({ autoReport: false })), false);
  assert.equal(crashNotice(true, settings({})), false);
  assert.equal(crashNotice(true, null), false);
});

test("sentPlacement：入口键还挂着就锚在键下；发送中切走了页面（键不在了）出在右下", () => {
  assert.equal(sentPlacement(1), "anchored");
  assert.equal(sentPlacement(2), "anchored");
  assert.equal(sentPlacement(0), "corner");
});

// ===== 截图：长边 1600、JPEG、压到 400 KB 以内 =====

test("scaledSize：长边缩到 1600，不放大，比例不变、至少 1", () => {
  assert.equal(LONG_SIDE, 1600);
  assert.deepEqual(scaledSize(3200, 2000, 1600), { width: 1600, height: 1000 });
  assert.deepEqual(scaledSize(1000, 4000, 1600), { width: 400, height: 1600 });
  assert.deepEqual(scaledSize(800, 600, 1600), { width: 800, height: 600 });
  assert.deepEqual(scaledSize(10000, 1, 1600), { width: 1600, height: 1 });
});

test("encodeUnder：质量逐级往下，第一份 ≤ 400 KB 的就用；最低质量还大就缩小再来；实在压不下去报错", async () => {
  assert.equal(SHOT_MAX_BYTES, 400_000);
  const tried: string[] = [];
  const bytes = await encodeUnder(async (scale, quality) => {
    tried.push(`${scale}@${quality}`);
    return new Uint8Array(quality > 0.6 ? 500_000 : 300_000);
  });
  assert.equal(bytes.length, 300_000);
  assert.ok(tried.length >= 2, tried.join());
  assert.ok(
    tried.every((s) => s.startsWith("1@")),
    "原尺寸下就压得下，不缩",
  );
  const qualities = tried.map((s) => Number(s.split("@")[1]));
  assert.deepEqual(
    qualities,
    [...qualities].sort((a, b) => b - a),
    "质量从高往低试",
  );

  const scales = new Set<number>();
  const small = await encodeUnder(async (scale) => {
    scales.add(scale);
    return new Uint8Array(scale < 1 ? 100 : 900_000);
  });
  assert.equal(small.length, 100);
  assert.ok(
    [...scales].some((s) => s < 1),
    "缩小了再来",
  );

  await assert.rejects(encodeUnder(async () => new Uint8Array(900_000)));
});

// ===== 截图的上传状态 =====

const add = (shots: ShotState[], key: number) => shotsReducer(shots, { type: "add", key });
const ready = (shots: ShotState[], key: number, at = 0, size = 200_000) =>
  shotsReducer(shots, { type: "ready", key, url: `blob:${key}`, size, at });

test("shotsReducer：粘贴 / 拖进来当下就占一格（准备中，还没有缩略图），至多 3 张；压好了才开始传", () => {
  assert.equal(MAX_SHOTS, 3);
  let shots: ShotState[] = [];
  for (const key of [1, 2, 3, 4]) shots = add(shots, key);
  assert.deepEqual(
    shots.map((s) => [s.key, s.phase, s.url]),
    [
      [1, "preparing", null],
      [2, "preparing", null],
      [3, "preparing", null],
    ],
    "第 4 张不收",
  );
  shots = ready(shots, 1, 1000, 300_000);
  assert.equal(shots[0].phase, "uploading");
  assert.equal(shots[0].url, "blob:1");
  assert.equal(shots[0].startedAt, 1000);
  assert.equal(shots[0].size, 300_000);
  // 认不出的图片：那一格去掉
  shots = shotsReducer(shots, { type: "remove", key: 2 });
  assert.deepEqual(
    shots.map((s) => s.key),
    [1, 3],
  );
});

test("shotsReducer：拿到 id 记下完成时刻；没传上去停在当时的显示值；重传从头来", () => {
  const shots = ready(add([], 1), 1, 0);
  assert.equal("real" in shots[0], false, "不再记交给 socket 的字节");
  const failed = shotsReducer(shots, { type: "failed", key: 1, at: 500 });
  assert.equal(failed[0].phase, "failed");
  assert.equal(failed[0].frozen, shotPercent(shots[0], 500, FINISH_MS), "停在当前值");
  const retried = shotsReducer(failed, { type: "retry", key: 1, at: 900 });
  assert.equal(retried[0].phase, "uploading");
  assert.equal(retried[0].startedAt, 900);
  const done = shotsReducer(shots, { type: "done", key: 1, id: "a".repeat(32), at: 700 });
  assert.equal(done[0].phase, "done");
  assert.equal(done[0].id, "a".repeat(32));
  assert.equal(done[0].doneAt, 700);
  // 已经不在的：原样
  assert.equal(shotsReducer(done, { type: "done", key: 9, id: "x", at: 1 }), done);
});

test("shotsReducer expire：接收服务说截图过期了（bad_shot），所有截图记成没传上去，再试一次时全部重传", () => {
  let shots = ready(ready(add(add([], 1), 2), 1), 2);
  shots = shotsReducer(shots, { type: "done", key: 1, id: "a".repeat(32), at: 10 });
  shots = shotsReducer(shots, { type: "expire", at: 5000 });
  assert.deepEqual(
    shots.map((s) => [s.phase, s.id]),
    [
      ["failed", null],
      ["failed", null],
    ],
  );
});

// ===== 模拟进度（产品负责人 2026-10-05：不直接显示交给 socket 的百分比）=====

test("simulatedTau：按压缩后大小估（约 100 KB/s），夹在 0.4–8 秒", () => {
  assert.equal(simulatedTau(200_000), 2000);
  assert.equal(simulatedTau(1_000), 400);
  assert.equal(simulatedTau(5_000_000), 8000);
});

test("simulatedPercent：只按时间缓动逼近 90、单调不减、到不了 90 之上", () => {
  const tau = simulatedTau(200_000);
  let last = -1;
  for (let t = 0; t <= 120_000; t += 37) {
    const p = simulatedPercent(t, tau);
    assert.ok(p >= last, `t=${t} 回退了`);
    assert.ok(p <= 90, `t=${t} 超过 90`);
    last = p;
  }
  assert.equal(simulatedPercent(0, tau), 0);
  assert.ok(simulatedPercent(tau, tau) > 50, "一个 τ 约到 57");
});

// 真机（2026-10-05）：交给 socket 的字节一开始就接近 100%，拿它做下限会 1 秒内冲到 90 再停住。
// 真实字节不再参与显示：后端一上来报 99% 也不影响，1 秒时仍按时间走、明显小于 90
test("真实字节瞬间 99%：显示值仍只按时间走，1 秒时明显小于 90（不再有 progress 这一步）", () => {
  let shots = ready(add([], 1), 1, 0, 200_000);
  // 后端报的字节百分比不再进状态：没有这种动作，状态原样
  shots = shotsReducer(shots, { type: "progress", key: 1, percent: 99 } as unknown as ShotAction);
  const at1s = shotPercent(shots[0], 1000, FINISH_MS);
  assert.ok(at1s < 60, `1 秒时 ${at1s}`);
  assert.equal(at1s, Math.round(90 * (1 - Math.exp(-1000 / simulatedTau(200_000)))));
});

test("shotPercent：上传中按模拟进度；拿到 id 后用短动画从当时的值走到 100，走完才算传完（百分比淡出、去掉键淡入）", () => {
  let shots = ready(add([], 1), 1, 0, 200_000);
  const up = shots[0];
  assert.equal(shotPhase(up, 1000, FINISH_MS), "uploading");
  const before = shotPercent(up, 1000, FINISH_MS);
  assert.ok(before > 0 && before < 90);
  shots = shotsReducer(shots, { type: "done", key: 1, id: "a".repeat(32), at: 1000 });
  const done = shots[0];
  assert.equal(shotPercent(done, 1000, FINISH_MS), before, "从当时的值起");
  const mid = shotPercent(done, 1000 + FINISH_MS / 2, FINISH_MS);
  assert.ok(mid > before && mid < 100);
  assert.equal(shotPhase(done, 1000 + FINISH_MS / 2, FINISH_MS), "uploading", "细线还在走");
  assert.equal(shotPercent(done, 1000 + FINISH_MS, FINISH_MS), 100);
  assert.equal(shotPhase(done, 1000 + FINISH_MS, FINISH_MS), "done");
  // 本机这种一下就传完的：也从 0 走一段动画再到 100，不一闪而过
  const instant = shotsReducer(ready(add([], 2), 2, 0), { type: "done", key: 2, id: "b", at: 5 });
  assert.ok(FINISH_MS >= 200);
  assert.equal(shotPhase(instant[0], 5 + FINISH_MS / 2, FINISH_MS), "uploading");
  // 减少动效（finish 0）：直接是完成状态
  assert.equal(shotPhase(instant[0], 5, 0), "done");
  assert.equal(shotPercent(instant[0], 5, 0), 100);
  // 没传上去：停在当时的值；准备中：0
  const failed = shotsReducer(ready(add([], 3), 3, 0), { type: "failed", key: 3, at: 800 })[0];
  assert.equal(shotPercent(failed, 99_999, FINISH_MS), failed.frozen);
  assert.equal(shotPhase(failed, 99_999, FINISH_MS), "failed");
  assert.equal(shotPercent(add([], 4)[0], 99_999, FINISH_MS), 0);
});

// 复审第二轮 1：响应丢了（其实已收下）→ 用户改了文字或截图 → 再试：同一个 id 会被当成重复，新内容就丢了
test("attemptFor：原样重试复用上一次的 id；文字或附件集合变了就换新 id；第一次发送取新 id", () => {
  let n = 0;
  const fresh = () => `id${++n}`;
  const first = attemptFor(null, "打不开", [1, 2], fresh);
  assert.deepEqual(first, { id: "id1", text: "打不开", shots: [1, 2] });
  assert.equal(attemptFor(first, "打不开", [1, 2], fresh).id, "id1", "原样重试");
  assert.equal(attemptFor(first, "打不开了", [1, 2], fresh).id, "id2", "文字变了");
  assert.equal(attemptFor(first, "打不开", [1], fresh).id, "id3", "去掉一张");
  assert.equal(attemptFor(first, "打不开", [1, 3], fresh).id, "id4", "换了一张（新放进来的格子）");
  assert.equal(attemptFor(first, "打不开", [2, 1], fresh).id, "id5", "顺序也算内容");
});

// 复审第二轮 3：后台上传失败而还没按发送时，那条拒绝没人接，会被全局日志记成 Sophia 自己的未处理拒绝
test("quiet：接住拒绝（不再算未处理），之后 await 它照样拿到失败原因", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const p = quiet(Promise.reject("network"));
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(unhandled, []);
    await assert.rejects(p, (e) => e === "network");
    assert.equal(await quiet(Promise.resolve("a")), "a");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// 复审第二轮 4：小窗闲置时时钟不走，拿到 id 的时刻可能比最后一次读的时钟还晚
test("shotPercent / shotPhase：时钟落后于完成时刻也不出负数，显示值夹在 0–100", () => {
  const up = shotsReducer(shotsReducer([], { type: "add", key: 1 }), {
    type: "ready",
    key: 1,
    url: "blob:1",
    size: 200_000,
    at: 1000,
  });
  const done = shotsReducer(up, { type: "done", key: 1, id: "a".repeat(32), at: 50_000 });
  for (const now of [0, 999, 1000, 20_000, 49_999]) {
    const p = shotPercent(done[0], now, FINISH_MS);
    assert.ok(p >= 0 && p <= 100, `now=${now} → ${p}`);
    assert.equal(shotPhase(done[0], now, FINISH_MS), "uploading", "细线那一段还没走完");
  }
  assert.equal(shotPercent(done[0], 50_000 + FINISH_MS, FINISH_MS), 100);
  // 上传中时钟落后于开始时刻：0
  assert.equal(shotPercent(up[0], 0, FINISH_MS), 0);
});

test("draftId：每份草稿一个 32 位小写 hex", () => {
  const id = draftId();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.notEqual(draftId(), id);
  assert.equal(
    draftId(() => new Uint8Array(16).fill(0xab)),
    "ab".repeat(16),
  );
});

// ===== 发送键与失败原因（R14、AC12）=====

test("sendKey：没写字时发送是灰的，理由「先写几句」；失败过主键变 `再试一次`", () => {
  assert.deepEqual(sendKey({ text: "  \n", failed: null, sending: false }), {
    label: "common.feedback.send",
    disabledReason: "common.feedback.writeFirst",
    cancelDisabledReason: null,
  });
  assert.deepEqual(sendKey({ text: "打不开", failed: null, sending: false }), {
    label: "common.feedback.send",
    disabledReason: null,
    cancelDisabledReason: null,
  });
  assert.deepEqual(sendKey({ text: "打不开", failed: "network", sending: false }), {
    label: "common.feedback.retry",
    disabledReason: null,
    cancelDisabledReason: null,
  });
});

test("failureOf：后端回的原因名照用，别的（不在应用里、读不懂）一律算 other；每种原因都有一句", () => {
  for (const f of [
    "network",
    "rateLimited",
    "server",
    "tooLarge",
    "shotExpired",
    "other",
  ] as const) {
    assert.equal(failureOf(f), f);
    assert.match(FAILURE_KEY[f], /^common\.feedback\.failure\./);
  }
  assert.equal(failureOf(new Error("boom")), "other");
  assert.equal(failureOf("unknown command feedback_send"), "other");
  assert.equal(failureOf(undefined), "other");
});

// ===== 发送：等截图传完再发 =====

test("deliver：等所有截图准备好、传完，按放进来的顺序带上 id 与实际带上的格子再发；认不出的图片（null）不带；成功为 null", async () => {
  let release!: (id: string) => void;
  const slow = new Promise<string>((r) => (release = r));
  const sent: Array<[string[], number[]]> = [];
  const done = deliver(
    [
      { key: 1, upload: slow },
      { key: 2, upload: Promise.resolve(null) },
      { key: 3, upload: Promise.resolve("b") },
    ],
    async (ids, keys) => void sent.push([ids, keys]),
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, [], "截图没传完不发");
  release("a");
  assert.equal(await done, null);
  assert.deepEqual(sent, [
    [
      ["a", "b"],
      [1, 3],
    ],
  ]);
});

test("deliver：截图没传上去、或发送没成，回原因；截图失败时不发", async () => {
  let sends = 0;
  const send = async () => void sends++;
  assert.equal(
    await deliver([{ key: 1, upload: Promise.reject("rateLimited") }], send),
    "rateLimited",
  );
  assert.equal(sends, 0);
  assert.equal(await deliver([], () => Promise.reject("network")), "network");
  assert.equal(await deliver([], () => Promise.reject(new Error("x"))), "other");
});

// 复审第三轮：发送尝试按「实际带上的附件」记。坏图在准备中被自动去掉后原样重试，内容没变，草稿 id 也不能变——
// 不然回答丢了的那一次其实已收下，再试会入库两条
test("坏图 + 原样重试：两次发送用同一个草稿 id（按实际带上的格子记尝试，不按按下发送时的全部格子）", async () => {
  let n = 0;
  const fresh = () => `id${++n}`;
  let last: Attempt | null = null;
  const ids: string[] = [];
  const submit = (uploads: Array<{ key: number; upload: Promise<string | null> }>) =>
    deliver(uploads, async (_shots, keys) => {
      last = attemptFor(last, "打不开", keys, fresh);
      ids.push(last.id);
      throw "network";
    });
  // 第一次：格子 1 是好图，格子 2 还在准备、结果认不出（null，随后被移除）
  assert.equal(
    await submit([
      { key: 1, upload: Promise.resolve("a") },
      { key: 2, upload: Promise.resolve(null) },
    ]),
    "network",
  );
  // 原样重试：只剩格子 1
  assert.equal(await submit([{ key: 1, upload: Promise.resolve("a") }]), "network");
  assert.deepEqual(ids, ["id1", "id1"]);
});

test("sendKey：发送中两颗键都禁用，理由「正在发送」（键盘也按不动取消，请求在路上不能把小窗关掉）", () => {
  assert.deepEqual(sendKey({ text: "x", failed: null, sending: true }), {
    label: "common.feedback.send",
    disabledReason: "common.feedback.sending",
    cancelDisabledReason: "common.feedback.sending",
  });
});
