import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api.ts";
import { t } from "./i18n.ts";
import { quitBusyText, quitConfirmText, quitFailureText, quitNeedsConfirm } from "./quitView.ts";
import type { QuitFailure, QuitPreview, QuitStep } from "./types.ts";
import { Confirm } from "./ui/index.ts";

/// 退出 Sophia（spec 2026-10-03-gateway-in-app R5–R9）：主窗口（菜单「退出 Sophia」⌘Q → `quit-requested`）
/// 与托盘面板（`退出`）同一段流程，只差确认框放在哪（主窗口：窗口正中；托盘：面板里的窄面板）。
///
/// 先问后端（`quit_preview`）：Codex、Claude 都没在用第三方模型 → 不确认、直接退出。否则确认框（默认焦点 `取消`）→
/// 点 `退出`：键区原位忙碌，跟着 `quit-progress` 换「正在重启 Codex / Claude」→ 都做成了应用就退出了；
/// 有没做成的 → 换成单键说明（后果与恢复办法），点 `退出` 直接退出（收尾已经做过）
type Stage =
  | { kind: "idle" }
  | { kind: "confirm"; preview: QuitPreview }
  | { kind: "busy"; preview: QuitPreview; step: QuitStep | null }
  /// 什么都没开着、不确认直接退出：不画任何东西
  | { kind: "quiet" }
  | { kind: "failed"; failures: QuitFailure[] };

/// 什么都没开着时直接退出用的预览
const NOTHING: QuitPreview = {
  codex: false,
  codexAppRunning: false,
  codexTerminal: false,
  claude: false,
  claudeRunning: false,
  workbuddy: false,
};

export interface QuitFlow {
  /// 用户要退出：已经在流程里时什么都不做
  start: () => void;
  /// 此刻要画的确认框（没有为 null）
  dialog: ReactNode;
  /// 确认框开着（调用方据此让出 Esc 等）
  open: boolean;
  /// 收起还在问的确认框（托盘面板重新打开时：上次没回答的不留着）；正在收尾时不动
  dismiss: () => void;
}

/// `inline`：托盘的窄面板形态
export function useQuitFlow(inline = false): QuitFlow {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const current = useRef(stage);
  current.current = stage;

  // 收尾进行到哪一步：只在忙的时候换那一句
  useEffect(() => {
    const pending = listen<{ step: QuitStep }>("quit-progress", ({ payload }) =>
      setStage((s) => (s.kind === "busy" ? { ...s, step: payload.step } : s)),
    );
    return () => void pending.then((un) => un());
  }, []);

  // 有没做成的一律由主窗口说明（托盘里点的退出也一样：面板那时多半已经收起）
  useEffect(() => {
    if (inline) return;
    const pending = listen<QuitFailure[]>("quit-failed", ({ payload }) =>
      setStage(payload.length > 0 ? { kind: "failed", failures: payload } : { kind: "idle" }),
    );
    return () => void pending.then((un) => un());
  }, [inline]);

  /// `asked`：从确认框点进来的（确认框原位忙碌）；否则不画任何东西
  const quit = useCallback(
    async (preview: QuitPreview, asked: boolean) => {
      setStage(asked ? { kind: "busy", preview, step: null } : { kind: "quiet" });
      try {
        // 都做成了应用就退出了，这次调用不会回来；回来了就是有没做成的
        const failures = await api.appQuit();
        // 托盘：说明交给主窗口（`quit-failed`），面板这里收起
        setStage(failures.length > 0 && !inline ? { kind: "failed", failures } : { kind: "idle" });
      } catch {
        // 命令本身没跑起来（不是某一家没做成）：收起，用户可以再点一次退出
        setStage({ kind: "idle" });
      }
    },
    [inline],
  );

  const start = useCallback(() => {
    if (current.current.kind !== "idle") return;
    void (async () => {
      let preview: QuitPreview;
      try {
        preview = await api.quitPreview();
      } catch {
        // 问不到：照「都要收尾」的那一步走，收尾本身会跳过没开着的
        preview = NOTHING;
      }
      if (current.current.kind !== "idle") return;
      if (quitNeedsConfirm(preview)) setStage({ kind: "confirm", preview });
      else void quit(preview, false);
    })();
  }, [quit]);

  const cancel = useCallback(() => setStage({ kind: "idle" }), []);
  const dismiss = useCallback(
    () => setStage((s) => (s.kind === "confirm" ? { kind: "idle" } : s)),
    [],
  );

  let dialog: ReactNode = null;
  if (stage.kind === "confirm" || stage.kind === "busy") {
    const text = quitConfirmText(stage.preview);
    const step: QuitStep | null =
      stage.kind === "busy"
        ? (stage.step ?? (stage.preview.codex ? "restartingCodex" : "restartingClaude"))
        : null;
    dialog = (
      <Confirm
        key="ask"
        inline={inline}
        title={text.title}
        confirmLabel={t("shell.quit.confirm")}
        onConfirm={() => void quit(stage.preview, true)}
        onCancel={cancel}
        busy={step === null ? undefined : quitBusyText(step)}
      >
        {text.body}
      </Confirm>
    );
  } else if (stage.kind === "failed") {
    const text = quitFailureText(stage.failures);
    if (text !== null) {
      // 单键：读完只能退出（收尾已经做过）；换一个 key 重新挂上，焦点落在 `退出` 上
      dialog = (
        <Confirm
          key="failed"
          inline={inline}
          title={text.title}
          confirmLabel={t("shell.quit.confirm")}
          onConfirm={() => void api.appExitNow()}
        >
          {text.body}
        </Confirm>
      );
    }
  }
  return { start, dialog, open: stage.kind !== "idle", dismiss };
}
