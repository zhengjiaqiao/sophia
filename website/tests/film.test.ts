/// 首屏短片播放器的逻辑（spec R7、AC5）：假时钟驱动，不起浏览器。
/// 播放器只认「镜头」契约（enter / demo / exit / rest），不碰 DOM；镜头的 DOM 实现另在 src/client/film-shots/。
import assert from "node:assert/strict";
import test from "node:test";
import { FilmPlayer, type Shot, type ShotCtx } from "../src/demos/film.ts";

/// 假时钟：sleep 只在 advance 时到期，按到期先后依次放行，每放行一个就让出事件循环，让后续代码跑完
function fakeClock() {
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  const flush = () => new Promise<void>((r) => setImmediate(r));
  return {
    sleep: (ms: number) => new Promise<void>((res) => timers.push({ at: now + ms, run: res })),
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        await flush();
        const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        now = next.at;
        next.run();
      }
      now = end;
      await flush();
    },
  };
}

/// 记日志的假镜头：demo 睡 ms 毫秒，醒来若已被打断就记 "interrupted"
function fakeShots(log: string[], ms = 1000, count = 3): Shot[] {
  return Array.from({ length: count }, (_, i) => ({
    duration: ms,
    enter: () => void log.push(`enter${i}`),
    async demo(ctx: ShotCtx) {
      log.push(`demo${i}${ctx.fromRest ? ":fromRest" : ""}`);
      await ctx.sleep(ms);
      if (!ctx.alive()) log.push(`interrupted${i}`);
    },
    exit: async () => void log.push(`exit${i}`),
    rest: () => void log.push(`rest${i}`),
  }));
}

test("按序播放并循环：每个镜头 enter → demo → exit，播完最后一个回到第 1 个", async () => {
  const clock = fakeClock();
  const log: string[] = [];
  const p = new FilmPlayer(fakeShots(log), { clock });
  p.play();
  await clock.advance(3000);
  assert.deepEqual(log, ["enter0", "demo0", "exit0", "enter1", "demo1", "exit1", "enter2", "demo2", "exit2", "enter0", "demo0"]);
  assert.deepEqual(p.state, { playing: true, index: 0 });
});

test("点第 n 段：先摆好上一镜头的结尾，再从第 n 个镜头播起（不经过前面的镜头）", async () => {
  const clock = fakeClock();
  const log: string[] = [];
  const p = new FilmPlayer(fakeShots(log), { clock });
  p.seek(2);
  await clock.advance(100);
  assert.deepEqual(log, ["rest1", "enter2", "demo2"]);
  assert.deepEqual(p.state, { playing: true, index: 2 });
});

test("点第 1 段：没有上一镜头，不摆结尾", async () => {
  const clock = fakeClock();
  const log: string[] = [];
  const p = new FilmPlayer(fakeShots(log), { clock });
  p.seek(0);
  await clock.advance(100);
  assert.deepEqual(log, ["enter0", "demo0"]);
});

test("播放中点另一段：旧的演示被打断，只剩新的一路在播", async () => {
  const clock = fakeClock();
  const log: string[] = [];
  const p = new FilmPlayer(fakeShots(log), { clock });
  p.play();
  await clock.advance(1500); // 镜头 1 播到一半
  log.length = 0;
  p.seek(0);
  await clock.advance(100);
  assert.deepEqual(log, ["interrupted1", "enter0", "demo0"]);
  await clock.advance(2000);
  // 旧的一路（本该在 2000ms 时接着播镜头 2 的前一个）已死：只有新的一路按自己的节奏前进
  assert.deepEqual(log, ["interrupted1", "enter0", "demo0", "exit0", "enter1", "demo1", "exit1", "enter2", "demo2"]);
});

test("暂停：演示立刻被打断（不用等睡醒）、停在当前镜头的完整画面、之后不再前进", async () => {
  const clock = fakeClock();
  const log: string[] = [];
  const p = new FilmPlayer(fakeShots(log, 5000), { clock });
  p.play();
  await clock.advance(1000);
  log.length = 0;
  p.pause();
  await clock.advance(0);
  assert.deepEqual(log, ["interrupted0", "rest0"]);
  assert.deepEqual(p.state, { playing: false, index: 0 });
  log.length = 0;
  await clock.advance(60000);
  assert.deepEqual(log, [], "暂停后什么都不再发生");
});

test("暂停后再播：从暂停的那个镜头重播，先摆好上一镜头的结尾", async () => {
  const clock = fakeClock();
  const log: string[] = [];
  const p = new FilmPlayer(fakeShots(log), { clock });
  p.seek(2);
  await clock.advance(100);
  p.pause();
  await clock.advance(0);
  log.length = 0;
  p.toggle();
  await clock.advance(100);
  assert.deepEqual(log, ["rest1", "enter2", "demo2"]);
  p.toggle();
  assert.equal(p.state.playing, false);
});

test("减少动态：不播放；静止帧只摆第 1 镜头的完整画面；点进度条也不播", async () => {
  const clock = fakeClock();
  const log: string[] = [];
  const p = new FilmPlayer(fakeShots(log), { clock, reducedMotion: true });
  p.showStill();
  p.play();
  p.seek(2);
  p.toggle();
  await clock.advance(60000);
  assert.deepEqual(log, ["rest0"]);
  assert.equal(p.state.playing, false);
});

test("静止帧开播：第 1 镜头的静态画面就是它的结尾，不再 enter，demo 带 fromRest；循环回来时才是完整演出", async () => {
  const clock = fakeClock();
  const log: string[] = [];
  const p = new FilmPlayer(fakeShots(log), { clock });
  p.showStill();
  p.play();
  await clock.advance(3000);
  assert.deepEqual(log, ["rest0", "demo0:fromRest", "exit0", "enter1", "demo1", "exit1", "enter2", "demo2", "exit2", "enter0", "demo0"]);
});

test("状态变化通知：开播、换镜头、暂停各通知一次", async () => {
  const clock = fakeClock();
  const seen: string[] = [];
  const p = new FilmPlayer(fakeShots([]), { clock, onChange: (s) => seen.push(`${s.playing ? "播" : "停"}${s.index}`) });
  p.play();
  await clock.advance(1100);
  p.pause();
  assert.deepEqual(seen, ["播0", "播1", "停1"]);
});

test("镜头列表可以只有一个（后续票的镜头还没接上时）：循环播它自己", async () => {
  const clock = fakeClock();
  const log: string[] = [];
  const p = new FilmPlayer(fakeShots(log, 1000, 1), { clock });
  p.play();
  await clock.advance(2100);
  assert.deepEqual(log, ["enter0", "demo0", "exit0", "enter0", "demo0", "exit0", "enter0", "demo0"]);
});
