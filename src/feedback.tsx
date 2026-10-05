import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./api.ts";
import { crashNotice, sentPlacement } from "./feedbackView.ts";
import { t } from "./i18n.ts";
import { ISSUES_URL } from "./pages/ReportRow.tsx";
import type { ReportSettings } from "./types.ts";
import { CornerToast, FeedbackDialog, FloatingToast, NoticePanel, Toast } from "./ui/index.ts";

/// 应用内反馈的接线（spec 2026-10-04-reporting-feedback R11–R13）：上报设置读一次、几处共用（设置页那一行、
/// 出错页、意外退出提示）；反馈小窗接上 api。给不给 `报告这个问题` 的规则在 `feedbackView.ts`（纯函数）。

let current: ReportSettings | null = null;
let read: Promise<void> | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/// 换一份（设置页拨了开关）：几处一起跟着变
export function setReportSettings(
  next: ReportSettings | null | ((prev: ReportSettings | null) => ReportSettings | null),
): void {
  current = typeof next === "function" ? next(current) : next;
  listeners.forEach((l) => l());
}

/// 自动上报与反馈的设置：第一次用时问一次后端；内部版没有这个命令、问不到时一直是 null（不画、不给）
export function useReportSettings(): ReportSettings | null {
  const settings = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  useEffect(() => {
    read ??= api.reportSettings().then(
      (s) => setReportSettings(s),
      () => undefined,
    );
  }, []);
  return settings;
}

// ===== 反馈小窗：应用级一份（不随页面卸载）=====
//
// 小窗、草稿与发送都挂在应用壳上的 `FeedbackHost` 里：发送中切页（应用菜单 ⌘1 这类绕得过遮罩）时，打开它的那一页
// 卸掉了，小窗照样在、草稿与在路上的请求都不丢。入口（设置那一行、出错页、意外退出提示）经 `useFeedbackEntry`
// 打开它；发出去时入口键还在就把提示条锚在键下（入口自己画 `FloatingToast`），不在了就出在右下（`FeedbackHost` 画）。

/// 入口：设置「关于」那一行、出错页、意外退出提示
export type FeedbackSource = "settings" | "pageFault" | "crash";

interface Request {
  source: FeedbackSource;
  /// 出错页带来的、已去隐私的错误详情
  attached?: string;
}

interface HubState {
  open: Request | null;
  /// 各入口发出去的时刻（入口键还在时由入口画提示条）
  sent: Partial<Record<FeedbackSource, number>>;
  /// 入口键不在了：右下出提示条的时刻
  corner: number | null;
}

let hub: HubState = { open: null, sent: {}, corner: null };
const hubListeners = new Set<() => void>();
/// 此刻挂着的入口（锚得住提示条的）：同一种入口可能挂着几处，计数
const mounted = new Map<FeedbackSource, number>();
/// 发出去时要通知的入口回调（意外退出提示收起自己）
const sentHandlers = new Map<FeedbackSource, Set<() => void>>();

function setHub(next: Partial<HubState>) {
  hub = { ...hub, ...next };
  hubListeners.forEach((l) => l());
}

const subscribeHub = (listener: () => void) => {
  hubListeners.add(listener);
  return () => void hubListeners.delete(listener);
};

const useHub = () =>
  useSyncExternalStore(
    subscribeHub,
    () => hub,
    () => hub,
  );

/// 反馈小窗此刻开着没有（应用菜单据此只留作用于输入框的命令，见 `routeUnderModal`）
export function feedbackOpen(): boolean {
  return hub.open !== null;
}

/// 收起反馈小窗（退出时：发送中也直接放弃，在路上的请求结果不再理会）
export function closeFeedback(): void {
  if (hub.open) setHub({ open: null });
}

/// 打开反馈小窗（已经开着时不动：一次只有一份草稿）
export function openFeedback(source: FeedbackSource, attached?: string): void {
  if (hub.open) return;
  setHub({ open: { source, attached } });
}

/// 入口用：`open` 打开小窗；`sent` 是这个入口发出去的时刻（键还在时由入口把提示条锚在键下），`clearSent` 撤掉。
/// `anchored: false`（意外退出提示：键随提示一起收起）一律出在右下；`onSent` 发出去时叫一次
export function useFeedbackEntry(
  source: FeedbackSource,
  options: { anchored?: boolean; onSent?: () => void } = {},
): { open: (attached?: string) => void; sent: number | null; clearSent: () => void } {
  const { anchored = true, onSent } = options;
  const state = useHub();
  useEffect(() => {
    if (!anchored) return;
    mounted.set(source, (mounted.get(source) ?? 0) + 1);
    return () => {
      const n = (mounted.get(source) ?? 1) - 1;
      if (n > 0) mounted.set(source, n);
      else mounted.delete(source);
    };
  }, [source, anchored]);
  useEffect(() => {
    if (!onSent) return;
    const set = sentHandlers.get(source) ?? new Set();
    sentHandlers.set(source, set);
    set.add(onSent);
    return () => void set.delete(onSent);
  }, [source, onSent]);
  return {
    open: (attached?: string) => openFeedback(source, attached),
    sent: state.sent[source] ?? null,
    clearSent: () => setHub({ sent: { ...hub.sent, [source]: undefined } }),
  };
}

/// 入口键旁边放它（在键那一格里、键画出来时才画）：登记「这颗入口键还在」，这个入口发出去时把提示条锚在键下。
/// 键不在了（发送中切走了页面）就不登记，提示条由 `FeedbackHost` 出在右下
export function FeedbackSentNote({
  source,
  align,
}: {
  source: FeedbackSource;
  align: "start" | "end";
}) {
  const { sent, clearSent } = useFeedbackEntry(source);
  return sent !== null ? (
    <FloatingToast key={sent} align={align}>
      <Toast kind="success" sentence="common.feedback.sent" onDismiss={clearSent} />
    </FloatingToast>
  ) : null;
}

/// 应用壳上挂一处（主窗口）：开着的反馈小窗与「入口键已经不在」时右下的提示条
export function FeedbackHost() {
  const state = useHub();
  const request = state.open;
  return (
    <>
      {request ? (
        <ApiFeedbackDialog
          // 每次打开是一份新草稿（新的草稿 id）
          key={`${request.source}:${request.attached ?? ""}`}
          attached={request.attached}
          onClose={() => setHub({ open: null })}
          onSent={() => {
            const at = Date.now();
            const where = sentPlacement(mounted.get(request.source) ?? 0);
            setHub(
              where === "anchored"
                ? { open: null, sent: { ...hub.sent, [request.source]: at } }
                : { open: null, corner: at },
            );
            sentHandlers.get(request.source)?.forEach((f) => f());
          }}
        />
      ) : null}
      {state.corner !== null ? (
        <CornerToast key={state.corner}>
          <Toast
            kind="success"
            sentence="common.feedback.sent"
            onDismiss={() => setHub({ corner: null })}
          />
        </CornerToast>
      ) : null}
    </>
  );
}

/// 反馈小窗，接上上传与发送命令。`attached`：出错页带来的、已去隐私的错误详情
export function ApiFeedbackDialog({
  attached,
  onClose,
  onSent,
}: {
  attached?: string;
  onClose: () => void;
  onSent: () => void;
}) {
  return (
    <FeedbackDialog
      upload={api.feedbackUploadShot}
      send={(text, shots, id) => api.feedbackSend(id, text, shots, attached)}
      onClose={onClose}
      onSent={onSent}
      onGithub={() => void openUrl(ISSUES_URL).catch(() => undefined)}
    />
  );
}

/// 上次意外退出的提示（R11，画板 AfterCrashOff）：上报关着（或 `DO_NOT_TRACK`）且有接收服务时，启动后在机面顶上出一次
/// 一次性说明（灰面板，不带 `!`）+ `报告这个问题`。关掉或发出去后这次运行不再出；标记本来就是一次启动一次。
/// 发出去之后提示条出在右下（那颗键已经随提示一起收起了，没有可锚的地方）
export function CrashNotice() {
  const settings = useReportSettings();
  const [unexpected, setUnexpected] = useState(false);
  const [closed, setClosed] = useState(false);
  const close = useCallback(() => setClosed(true), []);
  const entry = useFeedbackEntry("crash", { anchored: false, onSent: close });
  useEffect(() => {
    let cancelled = false;
    void api.lastExitUnexpected().then(
      (u) => !cancelled && setUnexpected(u),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);
  if (closed || !crashNotice(unexpected, settings)) return null;
  return (
    <div className="face__banner">
      <NoticePanel
        scope="app"
        mark={false}
        message={t("common.feedback.crash")}
        action={{ label: t("common.feedback.report"), onClick: () => entry.open() }}
        onClose={close}
      />
    </div>
  );
}
