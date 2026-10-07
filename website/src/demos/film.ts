/// 首屏短片播放器的核心（spec R7）：只管「镜头序列怎么播」，不碰 DOM、不 import astro，
/// 假时钟下可测（tests/film.test.ts）。镜头的 DOM 实现在 src/client/film-shots/，接线在 src/client/film.ts。
///
/// 镜头契约（#242 / #243 加镜头只实现 Shot，不改本文件）：
///   enter()   摆好镜头的起点并显示它（字幕升起也在这里或 demo 开头）。同步。
///   demo(ctx) 演示本身。全程只用 ctx.sleep 等待，每次醒来先看 ctx.alive()：为假就立刻收手返回
///             （暂停、点进度条、换镜头都会让它变假，ctx.sleep 也会被立刻放行）。
///   exit(ctx) 可选。转场：「东西从哪来到哪去」放这里，做完下一镜头才 enter。同样要守 alive。
///   rest()    把镜头摆成「完整画面」：字幕全部可见、动画收在最后一帧、不留半截。同步、可重复调用。
///             三处用到：静止帧（第 1 镜头）、暂停时停在当前镜头、跳转时摆好上一镜头的结尾。
///   duration  进度条用的名义时长（毫秒），不影响播放节奏（节奏由 demo 里的 sleep 决定）。
/// 播放器保证：同一时刻只有一路在播；新的一路开始前，旧的一路已经收手（demo / exit 已返回）；
/// 暂停后的 rest() 也在旧的一路收手之后才调，不会被晚到的收尾步骤盖掉。

export interface ShotCtx {
  /// 这一路还在播吗（暂停、跳转、换镜头后为假）
  alive(): boolean;
  /// 等 ms 毫秒；这一路被打断时立刻放行（调用方醒来后要检查 alive）
  sleep(ms: number): Promise<void>;
  /// 本镜头是从静止帧接着往下播的：画面已经是它的结尾，demo 停一拍直接转场即可
  fromRest: boolean;
}

export interface Shot {
  duration: number;
  enter(): void;
  demo(ctx: ShotCtx): Promise<void>;
  exit?(ctx: ShotCtx): Promise<void>;
  rest(): void;
}

export interface Clock {
  sleep(ms: number): Promise<void>;
}

export interface FilmState {
  playing: boolean;
  index: number;
}

export interface FilmOptions {
  clock?: Clock;
  /// 访客开了「减少动态」：不播放，只显示静止帧
  reducedMotion?: boolean;
  /// 开播、换镜头（含循环回同一个镜头）、暂停时通知
  onChange?: (state: FilmState) => void;
}

const realClock: Clock = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export class FilmPlayer {
  private readonly shots: readonly Shot[];
  private readonly clock: Clock;
  private readonly reduced: boolean;
  private readonly onChange?: (state: FilmState) => void;
  private token = 0;
  private playing = false;
  private index = 0;
  private stillShown = false;
  private run: Promise<void> = Promise.resolve();
  private readonly pending = new Set<() => void>();

  constructor(shots: readonly Shot[], opts: FilmOptions = {}) {
    if (shots.length === 0) throw new Error("FilmPlayer needs at least one shot");
    this.shots = shots;
    this.clock = opts.clock ?? realClock;
    this.reduced = opts.reducedMotion ?? false;
    this.onChange = opts.onChange;
  }

  get state(): FilmState {
    return { playing: this.playing, index: this.index };
  }

  /// 静止帧：第 1 镜头的完整画面。截图、分享卡、关 JS 与减少动态时看到的就是它
  showStill(): void {
    this.shots[0]!.rest();
    this.index = 0;
    this.stillShown = true;
  }

  /// 从第 from 个镜头播起；跳转（from > 0）先摆好上一镜头的结尾，转场才有起点
  play(from = 0): void {
    if (this.reduced) return;
    const first = Math.max(0, Math.min(from, this.shots.length - 1));
    const fromRest = this.stillShown && first === 0;
    this.stillShown = false;
    const my = ++this.token;
    this.playing = true;
    this.index = first;
    this.release();
    const previous = this.run;
    this.run = (async () => {
      await previous;
      if (my !== this.token) return;
      if (first > 0) this.shots[first - 1]!.rest();
      await this.loop(my, first, fromRest);
    })();
  }

  /// 点进度条第 n 段
  seek(n: number): void {
    this.play(n);
  }

  /// 暂停：演示立刻收手，停在当前镜头的完整画面
  pause(): void {
    if (!this.playing) return;
    const my = ++this.token;
    this.playing = false;
    this.release();
    this.notify();
    const previous = this.run;
    this.run = (async () => {
      await previous;
      if (my === this.token) this.shots[this.index]!.rest();
    })();
  }

  /// 播放 / 暂停键：暂停中按下，从暂停的那个镜头重播
  toggle(): void {
    if (this.playing) this.pause();
    else this.play(this.index);
  }

  private async loop(my: number, first: number, fromRest: boolean): Promise<void> {
    const ctx = (rest: boolean): ShotCtx => ({
      alive: () => my === this.token,
      sleep: (ms) => this.sleep(ms),
      fromRest: rest,
    });
    let i = first;
    let resting = fromRest;
    while (my === this.token) {
      const shot = this.shots[i]!;
      this.index = i;
      this.notify();
      if (!resting) shot.enter();
      await shot.demo(ctx(resting));
      resting = false;
      if (my !== this.token) return;
      await shot.exit?.(ctx(false));
      if (my !== this.token) return;
      i = (i + 1) % this.shots.length;
    }
  }

  /// 可被打断的等待：跳转与暂停时 release() 把所有还在等的放行
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pending.add(resolve);
      void this.clock.sleep(ms).then(() => {
        this.pending.delete(resolve);
        resolve();
      });
    });
  }

  private release(): void {
    const waiting = [...this.pending];
    this.pending.clear();
    for (const r of waiting) r();
  }

  private notify(): void {
    this.onChange?.(this.state);
  }
}
