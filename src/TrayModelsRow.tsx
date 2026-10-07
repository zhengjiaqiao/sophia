import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "./api.ts";
import { t } from "./i18n.ts";
import {
  CODEX,
  LAUNCH_POLL_MS,
  LAUNCH_TIMEOUT_MS,
  gatewaySwitchText,
  settleAfterRestart,
  switchGateway,
} from "./modelsView.ts";
import { parseBackendError } from "./backendError.ts";
import type { TrayRowProps } from "./shell/agentRegistry.ts";
import { codexAppName } from "./modelsView.ts";
import { launchTimeout, restartConsequence, trayRow } from "./trayView.ts";
import { codexGateway } from "./types.ts";
import type { GatewayState } from "./types.ts";
import { Confirm, NoticePanel, TruncTip } from "./ui/index.ts";
import { CodexKeySlot, CodexSwitch } from "./codexControls.tsx";
import type { CodexPhase } from "./codexControls.tsx";

/// 托盘面板里「第三方模型」一行（DESIGN「托盘面板」）：agent 注册表里这一节的 `trayRow` 画法，
/// 面板（TrayPanel）按注册表把它排进 Codex 那一块，面板自己不认得这一节。样式在 TrayPanel.css。
///
/// 一行高 32：名字（13 `ink`）+ 右端开关（标准 34 × 20，不点指示点）；键位在同一行里、开关左边 12
/// （与 Codex 页节头同一个位置关系），不另起一行。不列在用的模型（2026-09-25：在 Codex 页的模型片上看）。
/// 重启确认、做不成的灰面板都在这一行下当场展开。
///
/// 与 Codex 页同一段逻辑（modelsView 的判断 + codexControls 的开关与键位）：
/// - 开关＝配置里开没开：拨了就写、不确认，乐观翻转（滑块当即过去，写超过 0.3 秒原位转圈 +「正在添加 / 正在移除」）；
///   写成了要重启才生效时键位出 `重启生效`（Codex 没在跑出 `启动 Codex`）；没写成连配置一起撤回、滑块滑回，
///   键位原位灰面板 + `再试一次`。打断对话的是重启，确认只在 `重启生效` 上
/// - 键位 `重启生效` / `启动 Codex` 占同一位（默认键紧凑），规则同 Codex 页
/// - Esc：重启确认开着先收回那一问（在捕获阶段接住，面板自己的 Esc 收起就不再收到）；面板每次弹出，上次没答的确认作废

/// `✓ 已生效 / 已启动` 的锚：能力行右端那一组（键位 + 开关）
const endOf = (probe: HTMLElement) => probe.closest(".tray__end");

/// 键位那一处在做什么：重启生效的确认 / 重启中 / 已生效；启动中 / 已启动；拨了开关、正在写配置
type Phase = CodexPhase;

/// 键位原位的灰面板：主句 + 原因 + `再试一次`。`for` 说它跟着哪颗键：那颗键消失（问题解决了）就一起走
interface TrayNotice {
  message: string;
  reason: string;
  retry: () => void;
  for: "restart" | "launch" | "switch";
}

export function TrayThirdPartyModels({ title, state, tray }: TrayRowProps) {
  const gateway = state.gateway;
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  /// 重启 / 启动 / 拨开关没成（键位原位灰面板）：带下一步的失败不会自己走——关掉、再试一次、
  /// 或问题解决了（那颗键消失）才走，面板收起再弹出也还在
  const [notice, setNotice] = useState<TrayNotice | null>(null);
  /// 此刻画在面板上的状态（点下去那一刻读它）
  const shown = useRef<GatewayState | null>(gateway);
  shown.current = gateway;
  /// 重启确认那一块（`重启生效` 的 aria-controls 指向它）
  const confirmId = useId();

  // 面板每次弹出：收起时没答的确认作废；正在做的（重启、启动、拨开关）照常做完
  useEffect(() => {
    setPhase((p) =>
      p.kind === "restarting" || p.kind === "switching" || p.kind === "launching"
        ? p
        : { kind: "idle" },
    );
  }, [tray.openedAt]);

  // Esc：确认开着先收回那一问。捕获阶段接住并停下，面板自己「Esc 收起」的监听就收不到这一下
  useEffect(() => {
    if (phase.kind !== "confirming") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setPhase({ kind: "idle" });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [phase.kind]);

  // ✓ 已生效 / 已启动那一窗到点（停留、悬停停表、淡出都在 Toast 里）
  const dismissDone = useCallback(() => setPhase({ kind: "idle" }), []);

  /// 拨开关（同 Codex 页）：不确认，直接写配置；滑块当即过去（乐观翻转）。写成了键位按状态出
  /// `重启生效` / `启动 Codex`；没写成 switchGateway 撤回刚写的、滑块滑回，键位原位灰面板 + `再试一次`
  const toggle = async (next: boolean) => {
    setNotice(null);
    setPhase({ kind: "switching", next });
    setBusy(true);
    let reason: string | null | undefined;
    try {
      await tray.idle();
      reason = await switchGateway(next, {
        write: (on) => (on ? api.gatewayEnable("codex") : api.gatewayRestore("codex")),
        read: api.gatewayState,
        onState: tray.applyGateway,
        alive: tray.alive,
        describe: (error) => parseBackendError(String(error)).message,
      });
    } finally {
      if (tray.alive()) setBusy(false);
    }
    if (reason === undefined || !tray.alive()) return;
    setPhase({ kind: "idle" });
    if (reason === null) return;
    setNotice({
      message: gatewaySwitchText(next).failed,
      reason,
      retry: () => void toggle(next),
      for: "switch",
    });
  };

  const restartCodex = async () => {
    setNotice(null);
    setPhase({ kind: "restarting" });
    setBusy(true);
    let reason: string | null = null;
    try {
      await tray.idle();
      await api.gatewayRestartCodex();
      // 同 Codex 页：等旧进程退了才算成，上限 15 秒（发完信号立刻读会误判成重启失败）
      const settled = await settleAfterRestart(api.gatewayState, tray.applyGateway, tray.alive);
      if (settled === undefined) return;
      reason = settled;
    } catch (error) {
      reason = parseBackendError(String(error)).message;
    } finally {
      if (tray.alive()) setBusy(false);
    }
    if (!tray.alive()) return;
    setNotice(
      reason === null
        ? null
        : {
            message: t("models.notice.notRestarted", { app: codexAppName(shown.current) }),
            reason,
            retry: () => void restartCodex(),
            for: "restart",
          },
    );
    setPhase(reason === null ? { kind: "done" } : { kind: "idle" });
  };

  /// 启动 Codex（同 Codex 页）：不打断任何东西，不确认。键位原地忙碌 +「正在启动 Codex」，
  /// 轮询到它在跑（上限 15 秒）才算成；超时或打不开，键位原位灰面板说原因 + `再试一次`
  const launchCodex = async () => {
    setNotice(null);
    setPhase({ kind: "launching" });
    setBusy(true);
    let reason: string | null = null;
    try {
      await tray.idle();
      await api.gatewayLaunchCodex();
      const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
      for (;;) {
        const fresh = await api.gatewayState();
        if (!tray.alive()) return;
        tray.applyGateway(fresh);
        if (codexGateway(fresh).codex.app.running) break;
        if (Date.now() >= deadline) {
          reason = launchTimeout(codexAppName(fresh));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, LAUNCH_POLL_MS));
        if (!tray.alive()) return;
      }
    } catch (error) {
      reason = parseBackendError(String(error)).message;
    } finally {
      if (tray.alive()) setBusy(false);
    }
    if (!tray.alive()) return;
    setNotice(
      reason === null
        ? null
        : {
            message: t("models.notice.notLaunched", { app: codexAppName(shown.current) }),
            reason,
            retry: () => void launchCodex(),
            for: "launch",
          },
    );
    setPhase(reason === null ? { kind: "launched" } : { kind: "idle" });
  };

  /// `第三方模型` 一行：名字 + 右端 [键位 12 开关] → 行下当场展开的确认 / 灰面板
  const draw = (current: GatewayState) => {
    const row = trayRow(current);
    // 灰面板跟着它那颗键：键消失（问题解决了）就一起走
    const noticeLive =
      notice !== null &&
      phase.kind === "idle" &&
      (notice.for === "switch" ||
        (notice.for === "restart" && row.showRestart) ||
        (notice.for === "launch" && row.showLaunch));
    return (
      <>
        <div className="tray__cap">
          {/* 名字一行：English 的节名加上键和开关放不下时省略，悬停出全名（截断才提示，第三批画板 4A） */}
          <TruncTip content={title} fit="grow">
            <span className="tray__cap-title">{title}</span>
          </TruncTip>
          <span className="tray__end">
            {/* 键位：`重启生效` / `启动 Codex` 占同一位；失败的灰面板出来时让给它 */}
            {noticeLive ? null : (
              <CodexKeySlot
                state={current}
                phase={phase}
                busy={busy}
                onRestart={() => {
                  setNotice(null);
                  setPhase({ kind: "confirming" });
                }}
                onLaunch={() => void launchCodex()}
                onDoneDismiss={dismissDone}
                place="tray"
                doneAnchor={endOf}
                confirmId={confirmId}
              />
            )}
            {/* 开关＝配置里开没开：拨了就写，滑块当即过去；没写成滑回 */}
            <CodexSwitch
              tool={CODEX}
              state={current}
              switching={phase.kind === "switching" ? phase.next : null}
              busy={busy}
              label={t("models.tray.switchLabel", { tool: CODEX.name, title })}
              onToggle={(next) => void toggle(next)}
            />
          </span>
        </div>
        {phase.kind === "confirming" ? (
          // 确认在面板里当场展开（窄面板形态）：标题 + 一句后果 + `取消` 与主动作墨键，都紧凑
          <div className="tray__confirm">
            <Confirm
              inline
              id={confirmId}
              title={t("models.restart.confirmTitle", { app: codexAppName(current) })}
              confirmLabel={t("models.restart.confirmLabel")}
              onConfirm={() => void restartCodex()}
              onCancel={() => setPhase({ kind: "idle" })}
            >
              {restartConsequence(codexAppName(current))}
            </Confirm>
          </div>
        ) : null}
        {noticeLive && notice ? (
          // 带下一步的失败：能力行下灰面板（键位原位让给它），不会自己走（DESIGN「反馈的两种形态」）
          <div className="tray__notice">
            <NoticePanel
              scope="section"
              message={notice.message}
              reason={notice.reason}
              action={{ label: t("models.notice.retry"), onClick: notice.retry }}
              onClose={() => setNotice(null)}
            />
          </div>
        ) : null}
      </>
    );
  };

  return gateway ? draw(gateway) : null;
}

/// 托盘面板里 Claude 那一块的「第三方模型」一行（注册表 Claude 那一项的 `trayRow`；spec R44）：同一骨架，
/// 画法在 TrayClaudeRow.tsx
export { TrayClaudeModels } from "./TrayClaudeRow.tsx";
