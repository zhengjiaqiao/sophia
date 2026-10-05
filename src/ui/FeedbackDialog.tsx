import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, KeyboardEvent, Ref } from "react";
import { createPortal } from "react-dom";
import {
  FAILURE_KEY,
  FINISH_MS,
  LONG_SIDE,
  MAX_SHOTS,
  TEXT_MAX,
  deliver,
  attemptFor,
  draftId,
  quiet,
  type Attempt,
  encodeUnder,
  scaledSize,
  sendKey,
  shotPercent,
  shotPhase,
  shotsReducer,
} from "../feedbackView.ts";
import { t } from "../i18n.ts";
import type { FeedbackFailure } from "../types.ts";
import { BusySlot } from "./BusySlot.tsx";
import { Button } from "./Button.tsx";
import { FOCUSABLE, cycleFocus } from "./FloatingLayer.tsx";
import { IconClose, IconImage } from "./icons.tsx";
import { holdInert, type InertTarget } from "./PushedPage.tsx";

/// 反馈小窗（spec 2026-10-04-reporting-feedback R12、R14；DESIGN-components「反馈小窗」，画板 FeedbackEmpty /
/// Feedback / FeedbackFailed）。DESIGN「弹层只用于确认」的唯一例外：像聊天输入框，写几句、贴截图就发。
///
/// - 长相照确认框：窗口正中、遮罩整面压暗，纸浮层宽 480（`ss-confirm--wide`）。点遮罩**不**收起（写了一半的话不该
///   因为点偏了就没了），Esc 收起（发送中不收），焦点从 `取消` 开始，Tab 在小窗里转圈
/// - 输入框（`recess` 底、发丝线、最小高 140、获焦线色 `ink-mute`）；截图 56 方缩略图在文字上方，至多 3 张。
///   粘贴或拖进来先在这里缩到长边 1600、转 JPEG、按质量逐级压到 400 KB 以内，随即上传：细线沿边缘顺时针画一圈、
///   右上角百分比跟着数；到 100 百分比淡出、去掉键在同一处淡入
/// - 回车发送、Shift+回车换行（R12「回车或点发送」；输入法选字时的回车不算）
/// - `发送` 没写字时禁用（「先写几句」）；截图还没传完按下去就等它传完；没传上去的截图发送时重传。
///   失败时按钮行左边一句原因（`发送失败 · 网络不通`），主键变 `再试一次`，写的内容不丢；成功由调用方收起、出提示条
///
/// 组件库不碰 api：上传与发送由调用方给（`src/feedback.tsx` 接上命令）。

export interface FeedbackDialogProps {
  /// 传一张已压好的 JPEG；成功回截图 id，失败拒绝原因名（`FeedbackFailure`）。进度只按时间模拟，不看已发的字节
  upload: (bytes: Uint8Array) => Promise<string>;
  /// 发送：写的话、按顺序的截图 id、草稿 id（重试复用）；失败拒绝原因名
  send: (text: string, shots: string[], id: string) => Promise<void>;
  onClose: () => void;
  /// 发出去了：调用方收起小窗、出提示条
  onSent: () => void;
  /// 发送失败那一句后面的 `在 GitHub 提 ↗`（2026-10-05 产品负责人：常驻一个 GitHub 入口）：打开仓库的新 issue 页，由调用方给
  onGithub: () => void;
}

/// 一张截图：解码、缩到长边 1600、画到白底上（截图里透明的阴影转 JPEG 不变黑）、压成 ≤ 400 KB 的 JPEG
async function encodeShot(file: Blob): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  try {
    return await encodeUnder(async (scale, quality) => {
      const size = scaledSize(bitmap.width, bitmap.height, LONG_SIDE * scale);
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no canvas");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, size.width, size.height);
      ctx.drawImage(bitmap, 0, 0, size.width, size.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality),
      );
      if (!blob) throw new Error("no jpeg");
      return new Uint8Array(await blob.arrayBuffer());
    });
  } finally {
    bitmap.close();
  }
}

/// 粘贴、拖进来的东西里的图片文件
function imageFiles(list: DataTransfer | null): File[] {
  if (!list) return [];
  const fromItems = Array.from(list.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  const files = fromItems.length > 0 ? fromItems : Array.from(list.files ?? []);
  return files.filter((file) => file.type.startsWith("image/"));
}

/// 小窗开着时应用壳的其余部分（`#root`）inert：菜单、快捷键把焦点往遮罩后面放（⌘F 聚焦筛选框）放不进去，
/// 读屏也只读小窗。小窗 portal 在 `#root` 外，不受影响。与推入页共用 `holdInert` 的计数，返回放手函数
export function inertBehind(lookup: (id: string) => InertTarget | null): () => void {
  const root = lookup("root");
  return root ? holdInert(root) : () => undefined;
}

export function FeedbackDialog({ upload, send, onClose, onSent, onGithub }: FeedbackDialogProps) {
  const titleId = useId();
  /// 上一次发送尝试（草稿 id 与当时的内容）：原样重试复用 id，接收服务据它去重；内容变了换新 id（`attemptFor`）
  const lastAttempt = useRef<Attempt | null>(null);
  const [text, setText] = useState("");
  const [shots, dispatch] = useReducer(shotsReducer, []);
  const [failed, setFailed] = useState<FeedbackFailure | null>(null);
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  /// 减少动效：拿到 id 直接是完成状态，不走那一小段
  const [finishMs] = useState(() =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0
      : FINISH_MS,
  );
  const [now, setNow] = useState(() => performance.now());
  const dialog = useRef<HTMLDivElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  const shotsNow = useRef(shots);
  shotsNow.current = shots;
  /// 每张截图：压好的字节（重传用）与「准备 + 上传」这一整段（发送时等它；认不出的图片回 null）
  const uploads = useRef(
    new Map<number, { bytes: Uint8Array | null; promise: Promise<string | null> }>(),
  );
  /// 缩略图的 object URL：去掉、收起时释放
  const urls = useRef(new Map<number, string>());
  /// 已占的格子：粘贴 / 拖进来当下就算，免得一次贴进好几张超过 3 张
  const taken = useRef(0);
  const nextKey = useRef(1);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const held = urls.current;
    const entries = uploads.current;
    return () => {
      alive.current = false;
      held.forEach((url) => URL.revokeObjectURL(url));
      held.clear();
      entries.clear();
    };
  }, []);

  // 模拟进度的时钟：有截图在传、或细线还在走最后一段时才走（50ms 一格）
  const ticking = shots.some((s) => shotPhase(s, now, finishMs) === "uploading");
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(performance.now()), 50);
    return () => window.clearInterval(timer);
  }, [ticking]);

  // 焦点从 `取消` 开始（同确认框）；收起时还给打开前的地方（还在的话）。程序放的焦点不画框（inputModality）
  useEffect(() => {
    const before = document.activeElement;
    foot.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  // Esc 收起（发送中不收）：捕获阶段接走，页面不再把它当返回
  const sendingNow = useRef(sending);
  sendingNow.current = sending;
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.stopPropagation();
      event.preventDefault();
      if (!sendingNow.current) onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  // 应用壳其余部分 inert（布局阶段挂上 / 摘掉：关窗时锚在入口键下的提示条量位置之前就摘掉）
  useLayoutEffect(() => inertBehind((id) => document.getElementById(id)), []);

  /// 开始传、传完、没传上去时当场把时钟拨到现在（闲置时时钟不走，不然完成那一段会从旧时刻算起）
  const tick = () => {
    const at = performance.now();
    setNow(at);
    return at;
  };

  /// 返回的上传已接住拒绝（`quiet`）：还没按发送时失败不算未处理拒绝，发送时照样读到原因
  const startUpload = (key: number, bytes: Uint8Array): Promise<string> => {
    const promise = upload(bytes);
    promise.then(
      (shotId) => alive.current && dispatch({ type: "done", key, id: shotId, at: tick() }),
      () => alive.current && dispatch({ type: "failed", key, at: tick() }),
    );
    return quiet(promise);
  };

  // 粘贴 / 拖进来当下就占一格（准备中），压好了再传。发送中不收：这一次要发的截图在按下发送时就定了
  const addFiles = (files: File[]) => {
    if (sendingNow.current) return;
    for (const file of files) {
      if (taken.current >= MAX_SHOTS) break;
      taken.current += 1;
      const key = nextKey.current++;
      dispatch({ type: "add", key });
      const entry: { bytes: Uint8Array | null; promise: Promise<string | null> } = {
        bytes: null,
        promise: Promise.resolve(null),
      };
      entry.promise = quiet(
        encodeShot(file).then(
          (bytes) => {
            if (!alive.current || !uploads.current.has(key)) return null;
            entry.bytes = bytes;
            const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
            urls.current.set(key, url);
            dispatch({ type: "ready", key, url, size: bytes.length, at: tick() });
            return startUpload(key, bytes);
          },
          () => {
            // 认不出的图片：那一格去掉，不占名额
            if (uploads.current.delete(key)) {
              taken.current -= 1;
              dispatch({ type: "remove", key });
            }
            return null;
          },
        ),
      );
      uploads.current.set(key, entry);
    }
  };

  const removeShot = (key: number) => {
    const url = urls.current.get(key);
    if (url) URL.revokeObjectURL(url);
    urls.current.delete(key);
    if (uploads.current.delete(key)) taken.current -= 1;
    dispatch({ type: "remove", key });
  };

  const submit = async () => {
    if (sendingNow.current || text.trim() === "") return;
    sendingNow.current = true;
    setSending(true);
    setFailed(null);
    // 附件在这一刻定下：准备中、还在传的等它；没传上去的重传
    const uploadsNow = shotsNow.current.map((shot) => {
      const entry = uploads.current.get(shot.key);
      if (!entry) return { key: shot.key, upload: Promise.resolve(null) };
      if (shot.phase === "failed" && entry.bytes) {
        dispatch({ type: "retry", key: shot.key, at: tick() });
        entry.promise = startUpload(shot.key, entry.bytes);
      }
      return { key: shot.key, upload: entry.promise };
    });
    // 发送尝试按准备完、实际带上的附件记（坏图已去掉）：原样重试复用同一个草稿 id
    const result = await deliver(uploadsNow, (ids, keys) => {
      const attempt = attemptFor(lastAttempt.current, text, keys, draftId);
      lastAttempt.current = attempt;
      return send(text, ids, attempt.id);
    });
    if (!alive.current) return;
    sendingNow.current = false;
    setSending(false);
    if (result === null) return onSent();
    // 截图过期（传上去超过 24 小时）或已用过：全部记成没传上去，`再试一次` 时重传
    if (result === "shotExpired") dispatch({ type: "expire", at: performance.now() });
    setFailed(result);
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = imageFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files");
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = sending ? "none" : "copy";
    setDragOver(!sending);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDragOver(false);
    if (!hasFiles(event)) return;
    event.preventDefault();
    addFiles(imageFiles(event.dataTransfer));
  };

  // Tab 在小窗里转圈（同详情浮层），不走到后面的页面
  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !dialog.current) return;
    const items = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const next = cycleFocus(
      items.length,
      items.indexOf(document.activeElement as HTMLElement),
      event.shiftKey,
    );
    if (next < 0) return;
    event.preventDefault();
    items[next].focus();
  };

  // 回车发送，Shift+回车换行；输入法正在选字时的回车留给输入法
  const onTextKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void submit();
  };

  const layer = (
    <div className="ss-confirm-layer" role="presentation">
      <div className="ss-confirm-veil ss-confirm-veil--full" />
      <div
        ref={dialog}
        className="ss-confirm ss-confirm--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onDialogKeyDown}
        onPaste={onPaste}
      >
        <div className="ss-confirm__title" id={titleId}>
          {t("common.feedback.title")}
        </div>
        <div
          className="ss-feedback__box"
          data-drop={dragOver ? "over" : undefined}
          onDragOver={onDragOver}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          {shots.length > 0 ? (
            <div className="ss-feedback__shots">
              {shots.map((shot, i) => (
                <ShotTile
                  key={shot.key}
                  url={shot.url}
                  n={i + 1}
                  phase={shotPhase(shot, now, finishMs)}
                  percent={shotPercent(shot, now, finishMs)}
                  onRemove={sending ? undefined : () => removeShot(shot.key)}
                />
              ))}
            </div>
          ) : null}
          <textarea
            className="ss-feedback__text"
            aria-label={t("common.feedback.label")}
            placeholder={t("common.feedback.placeholder")}
            maxLength={TEXT_MAX}
            value={text}
            readOnly={sending}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onTextKeyDown}
          />
        </div>
        <div className="ss-feedback__hint">
          <IconImage size={14} />
          {t("common.feedback.hint")}
        </div>
        <FeedbackFoot
          footRef={foot}
          text={text}
          failed={failed}
          sending={sending}
          onCancel={onClose}
          onSend={() => void submit()}
          onGithub={onGithub}
        />
      </div>
    </div>
  );
  return typeof document === "undefined" ? layer : createPortal(layer, document.body);
}

/// 一张截图的缩略图（56 方）。准备中：还没有缩略图，百分比 0；上传中：细线沿边缘顺时针画到（模拟的）百分比，
/// 右上角百分比；传完：百分比淡出、同一处淡入去掉键；没传上去：细线停在当时的值、给去掉键。
/// `onRemove` 不给（发送中）时去掉键不能点
export function ShotTile({
  url,
  n,
  phase,
  percent,
  onRemove,
}: {
  url: string | null;
  n: number;
  phase: "preparing" | "uploading" | "done" | "failed";
  percent: number;
  onRemove?: () => void;
}) {
  const busy = phase === "preparing" || phase === "uploading";
  const label =
    phase === "preparing"
      ? t("common.feedback.shotPreparing", { n })
      : phase === "uploading"
        ? t("common.feedback.shotUploading", { n, percent })
        : phase === "failed"
          ? t("common.feedback.shotFailed", { n })
          : t("common.feedback.shot", { n });
  return (
    <div
      className="ss-feedback__shot"
      data-phase={phase}
      role="img"
      aria-label={label}
      title={phase === "uploading" ? t("common.feedback.uploading", { percent }) : undefined}
    >
      <div className="ss-feedback__thumb">
        {url ? <img src={url} alt="" draggable={false} /> : null}
      </div>
      {phase === "uploading" || phase === "failed" ? (
        <svg
          className="ss-feedback__ring"
          width="60"
          height="60"
          viewBox="0 0 60 60"
          aria-hidden="true"
        >
          <rect
            x="1"
            y="1"
            width="58"
            height="58"
            rx="9"
            pathLength="100"
            strokeDasharray={`${percent} 100`}
          />
        </svg>
      ) : null}
      <span className="ss-feedback__percent" aria-hidden={busy ? undefined : true}>
        {percent}%
      </span>
      {busy ? null : (
        <button
          type="button"
          className="ss-feedback__remove"
          aria-label={t("common.feedback.removeShot", { n })}
          title={t("common.feedback.removeShot", { n })}
          disabled={!onRemove}
          onClick={onRemove}
        >
          <IconClose size={10} />
        </button>
      )}
    </div>
  );
}

/// 按钮行：失败时左边一句原因，原因后接浅键 `在 GitHub 提 ↗`（只在失败时出现）；`取消`（默认键）与 `发送` / `再试一次`
/// （墨键）。发送中两颗都禁用（「正在发送」，键盘也按不动），过了门槛键区原位换成忙碌刻度 + 正在发送
export function FeedbackFoot({
  text,
  failed,
  sending,
  onCancel,
  onSend,
  onGithub,
  footRef,
}: {
  text: string;
  failed: FeedbackFailure | null;
  sending: boolean;
  onCancel: () => void;
  onSend: () => void;
  onGithub: () => void;
  footRef?: Ref<HTMLDivElement>;
}) {
  const key = sendKey({ text, failed, sending });
  return (
    <div className="ss-confirm__foot" ref={footRef}>
      {failed ? (
        <span className="ss-feedback__failure" role="status">
          {t("common.feedback.failed", { reason: t(FAILURE_KEY[failed]) })}
          &nbsp;&nbsp;
          <Button variant="quiet" onClick={onGithub}>
            {t("common.feedback.github")}
          </Button>
        </span>
      ) : null}
      <BusySlot busy={sending} label={t("common.feedback.sending")}>
        {key.cancelDisabledReason ? (
          <Button size="row" disabled disabledReason={t(key.cancelDisabledReason)}>
            {t("common.cancel")}
          </Button>
        ) : (
          <Button size="row" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        )}
        {key.disabledReason ? (
          <Button variant="primary" size="row" disabled disabledReason={t(key.disabledReason)}>
            {t(key.label)}
          </Button>
        ) : (
          <Button variant="primary" size="row" onClick={onSend}>
            {t(key.label)}
          </Button>
        )}
      </BusySlot>
    </div>
  );
}
