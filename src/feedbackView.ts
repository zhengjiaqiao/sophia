/// 应用内反馈的纯逻辑（spec 2026-10-04-reporting-feedback R11–R14）：出错处给不给 `报告这个问题`、截图压到多大、
/// 截图的上传状态、发送键的状态、失败原因的那一句、等截图传完再发。界面在 `src/ui/FeedbackDialog.tsx`，
/// 接线（api、读上报设置）在 `src/feedback.tsx`。测试：tests/feedback.test.ts
import type { MessageKey } from "./i18n.ts";
import type { FeedbackFailure, ReportSettings } from "./types.ts";

/// 截图缩到长边这么多像素
export const LONG_SIDE = 1600;
/// 一张截图压到这么多字节以内（接收服务收 1 MiB，留足余量）
export const SHOT_MAX_BYTES = 400_000;
/// 一条反馈至多几张截图（接收服务同一上限）
export const MAX_SHOTS = 3;
/// 文字上限（接收服务收 1–8000 字）
export const TEXT_MAX = 8000;
/// JPEG 质量从高往低试
const QUALITIES = [0.86, 0.78, 0.7, 0.62, 0.54, 0.46, 0.38];
/// 最低质量还压不下时，尺寸再缩到这几档
const SCALES = [1, 0.75, 0.5];

/// 出错页、意外退出提示给不给 `报告这个问题`（R11）：有接收服务、且自动上报此刻没在生效（开关关着，
/// 或 `DO_NOT_TRACK`）。开着时维护者已经自动拿到了，不打扰；还没读回来、内部版（读不到）不给
export function offerReport(settings: ReportSettings | null): boolean {
  if (!settings?.feedback) return false;
  return !(settings.available && settings.autoReport);
}

/// 发出去之后提示条出在哪：打开小窗的那颗入口键还挂着（发送中没切走页面）就锚在键下，不在了出在右下。
/// `mountedEntries`：此刻挂着的、要锚的同种入口有几处（意外退出提示不登记：键随提示收起，一律右下）
export function sentPlacement(mountedEntries: number): "anchored" | "corner" {
  return mountedEntries > 0 ? "anchored" : "corner";
}

/// 收到退出请求（应用菜单「退出 Sophia」⌘Q）：退出必须总能生效（产品负责人 2026-10-05）。反馈小窗开着时先收起它
/// ——发送中也直接放弃、不等；收起时应用壳的 inert 随之摘掉——再照常走退出流程（退出确认框在应用壳里）
export function quitRequested(
  feedbackOpen: boolean,
  closeFeedback: () => void,
  startQuit: () => void,
) {
  if (feedbackOpen) closeFeedback();
  startQuit();
}

/// 启动后出不出「上次意外退出」的提示
export function crashNotice(unexpected: boolean, settings: ReportSettings | null): boolean {
  return unexpected && offerReport(settings);
}

/// 长边缩到 `longSide`（不放大），比例不变，各边至少 1
export function scaledSize(
  width: number,
  height: number,
  longSide: number,
): { width: number; height: number } {
  const ratio = Math.min(1, longSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/// 按质量从高往低编码，第一份不超过 `max` 的就用；最低质量还大就把尺寸再缩一档重来。
/// `encode(scale, quality)` 由调用方给（网页里画到 canvas 再转 JPEG）。实在压不下去时报错
export async function encodeUnder(
  encode: (scale: number, quality: number) => Promise<Uint8Array>,
  max: number = SHOT_MAX_BYTES,
): Promise<Uint8Array> {
  for (const scale of SCALES) {
    for (const quality of QUALITIES) {
      const bytes = await encode(scale, quality);
      if (bytes.length <= max) return bytes;
    }
  }
  throw new Error("screenshot too large");
}

/// 一张截图：粘贴 / 拖进来当下就占一格（`preparing`：还在缩、压，没有缩略图），压好了开始传（`uploading`），
/// 拿到 id 是 `done`，没传上去是 `failed`（发送时重传）。显示的百分比是模拟进度（[`shotPercent`]）：
/// 只按时间缓动逼近 90（交给 socket 的字节一开始就接近 100%，不能拿来做下限，真机 2026-10-05）；
/// 拿到 id 才用短动画走到 100
export interface ShotState {
  /// 本窗里的序号（React key）
  key: number;
  /// 缩略图（压好的 JPEG 的 object URL）；准备中为 null
  url: string | null;
  phase: "preparing" | "uploading" | "done" | "failed";
  /// 压好的 JPEG 字节数（估模拟进度的快慢）
  size: number;
  /// 这一次开始传的时刻（`performance.now()` 的毫秒）
  startedAt: number | null;
  /// 拿到 id 的时刻
  doneAt: number | null;
  /// 没传上去时停在的显示值
  frozen: number | null;
  id: string | null;
}

export type ShotAction =
  | { type: "add"; key: number }
  | { type: "ready"; key: number; url: string; size: number; at: number }
  | { type: "done"; key: number; id: string; at: number }
  | { type: "failed"; key: number; at: number }
  | { type: "retry"; key: number; at: number }
  | { type: "remove"; key: number }
  /// 接收服务说截图过期了（`bad_shot`）：全部记成没传上去，下次发送时重传
  | { type: "expire"; at: number };

/// 拿到 id 之后从当时的值走到 100 的时长；减少动效时调用方给 0
export const FINISH_MS = 240;
/// 模拟进度逼近的上限：没拿到 id 之前不过它
const SIMULATED_CAP = 90;
/// 估模拟进度用的速度（字节 / 毫秒，约 100 KB/s），τ 夹在 0.4–8 秒
const ASSUMED_BYTES_PER_MS = 100;
const TAU_MIN_MS = 400;
const TAU_MAX_MS = 8000;

/// 模拟进度的时间常数（毫秒）：按压缩后的大小估
export function simulatedTau(size: number): number {
  return Math.min(TAU_MAX_MS, Math.max(TAU_MIN_MS, size / ASSUMED_BYTES_PER_MS));
}

/// 模拟进度：p(t) = 90 × (1 − e^(−t/τ))，不过 90、随时间单调不减。不看真实已发的字节：交给 socket 的字节
/// 一开始就接近 100%，拿它做下限会 1 秒内冲到 90 再停住（真机 2026-10-05）
export function simulatedPercent(elapsedMs: number, tauMs: number): number {
  const eased = SIMULATED_CAP * (1 - Math.exp(-Math.max(0, elapsedMs) / tauMs));
  return Math.min(SIMULATED_CAP, eased);
}

/// 上传中（含拿到 id 前）此刻的模拟值
function runningPercent(shot: ShotState, now: number): number {
  if (shot.startedAt === null) return 0;
  return simulatedPercent(now - shot.startedAt, simulatedTau(shot.size));
}

/// 此刻显示的百分比（整数）：准备中 0；上传中模拟值；拿到 id 后 `finishMs` 内从当时的值缓出到 100；
/// 没传上去停在当时的值
export function shotPercent(shot: ShotState, now: number, finishMs: number): number {
  return Math.min(100, Math.max(0, Math.round(rawPercent(shot, now, finishMs))));
}

/// 没夹的显示值。完成那一段的时间夹在 [0, finishMs]：小窗闲置时时钟不走，读到的 `now` 可能早于拿到 id 的时刻
function rawPercent(shot: ShotState, now: number, finishMs: number): number {
  if (shot.phase === "failed") return shot.frozen ?? 0;
  if (shot.phase === "done" && shot.doneAt !== null) {
    const from = runningPercent(shot, shot.doneAt);
    const t = finishMs <= 0 ? 1 : Math.min(1, Math.max(0, (now - shot.doneAt) / finishMs));
    if (t >= 1) return 100;
    const eased = 1 - (1 - t) ** 3;
    return from + (100 - from) * eased;
  }
  return runningPercent(shot, now);
}

/// 缩略图此刻的样子：拿到 id 后细线走完到 100 才算 `done`（百分比淡出、去掉键淡入），之前仍是 `uploading`
export function shotPhase(
  shot: ShotState,
  now: number,
  finishMs: number,
): "preparing" | "uploading" | "done" | "failed" {
  if (shot.phase === "done" && shot.doneAt !== null && now - shot.doneAt < finishMs) {
    return "uploading";
  }
  return shot.phase;
}

export function shotsReducer(shots: ShotState[], action: ShotAction): ShotState[] {
  if (action.type === "add") {
    if (shots.length >= MAX_SHOTS) return shots;
    const shot: ShotState = {
      key: action.key,
      url: null,
      phase: "preparing",
      size: 0,
      startedAt: null,
      doneAt: null,
      frozen: null,
      id: null,
    };
    return [...shots, shot];
  }
  if (action.type === "remove") return shots.filter((s) => s.key !== action.key);
  if (action.type === "expire") {
    return shots.map((s) => ({
      ...s,
      phase: "failed",
      frozen: shotPercent(s, action.at, 0),
      id: null,
    }));
  }
  const at = shots.findIndex((s) => s.key === action.key);
  if (at < 0) return shots;
  const shot = shots[at];
  let next: ShotState = shot;
  if (action.type === "ready" && shot.phase === "preparing") {
    next = {
      ...shot,
      phase: "uploading",
      url: action.url,
      size: action.size,
      startedAt: action.at,
    };
  } else if (action.type === "done") {
    next = { ...shot, phase: "done", doneAt: action.at, id: action.id };
  } else if (action.type === "failed") {
    next = { ...shot, phase: "failed", frozen: shotPercent(shot, action.at, 0), id: null };
  } else if (action.type === "retry") {
    next = {
      ...shot,
      phase: "uploading",
      startedAt: action.at,
      doneAt: null,
      frozen: null,
      id: null,
    };
  }
  if (next === shot) return shots;
  return shots.map((s, i) => (i === at ? next : s));
}

/// 一次发送尝试：用的草稿 id、当时的文字与附件（按顺序的格子序号）
export interface Attempt {
  id: string;
  text: string;
  shots: number[];
}

/// 这一次发送用哪个草稿 id（复审第二轮 1）：和上一次尝试原样相同（文字、附件集合与顺序都没变）才复用——
/// 上一次可能其实已收下、只是回答丢了，接收服务据同一个 id 认出是重复；内容变了就换新 id，免得新内容被当成重复丢掉
export function attemptFor(
  last: Attempt | null,
  text: string,
  shots: readonly number[],
  fresh: () => string,
): Attempt {
  const same =
    last !== null &&
    last.text === text &&
    last.shots.length === shots.length &&
    last.shots.every((key, i) => key === shots[i]);
  return same ? last : { id: fresh(), text, shots: [...shots] };
}

/// 接住拒绝（不再算未处理拒绝，免得后台上传失败被全局日志记成 Sophia 自己的错），原样交回：之后 await 照样拿到失败原因
export function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

/// 每份草稿一个 id（32 位小写 hex）：重试复用，接收服务据它去重；发出去了才换新的（新开一窗就是新草稿）
export function draftId(
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b),
): string {
  return Array.from(random(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/// 两颗键：没写字时主键是灰的（理由「先写几句」）；发送失败过主键换成 `再试一次`；发送中两颗都禁用（「正在发送」）——
/// 请求在路上时不能把小窗关掉（键盘也按不动），发完或失败才放开
export function sendKey(input: {
  text: string;
  failed: FeedbackFailure | null;
  sending: boolean;
}): {
  label: MessageKey;
  disabledReason: MessageKey | null;
  cancelDisabledReason: MessageKey | null;
} {
  const sending = input.sending ? "common.feedback.sending" : null;
  return {
    label: input.failed ? "common.feedback.retry" : "common.feedback.send",
    disabledReason: sending ?? (input.text.trim() === "" ? "common.feedback.writeFirst" : null),
    cancelDisabledReason: sending,
  };
}

/// 失败原因的那一句（按钮行左边 `发送失败 · 网络不通`）
export const FAILURE_KEY = {
  network: "common.feedback.failure.network",
  rateLimited: "common.feedback.failure.rateLimited",
  server: "common.feedback.failure.server",
  tooLarge: "common.feedback.failure.tooLarge",
  shotExpired: "common.feedback.failure.shotExpired",
  other: "common.feedback.failure.other",
} as const satisfies Record<FeedbackFailure, MessageKey>;

/// 命令拒绝的值 → 原因：后端回的是原因名（`"network"`）；别的（不在应用里、命令不存在、读不懂）算 `other`
export function failureOf(error: unknown): FeedbackFailure {
  return typeof error === "string" && Object.prototype.hasOwnProperty.call(FAILURE_KEY, error)
    ? (error as FeedbackFailure)
    : "other";
}

/// 发送：等每张截图准备好、传完（按放进来的顺序取 id；认不出的图片是 null，不带），再发。成功为 null；
/// 截图没传上去时不发，回它的原因。`send` 同时拿到实际带上的格子序号：发送尝试按它记（`attemptFor`），
/// 坏图在准备中被去掉后原样重试，草稿 id 不变
export async function deliver(
  uploads: ReadonlyArray<{ key: number; upload: Promise<string | null> }>,
  send: (ids: string[], keys: number[]) => Promise<void>,
): Promise<FeedbackFailure | null> {
  const ids: string[] = [];
  const keys: number[] = [];
  try {
    const results = await Promise.all(uploads.map((u) => u.upload));
    results.forEach((id, i) => {
      if (id === null) return;
      ids.push(id);
      keys.push(uploads[i].key);
    });
  } catch (error) {
    return failureOf(error);
  }
  try {
    await send(ids, keys);
    return null;
  } catch (error) {
    return failureOf(error);
  }
}
