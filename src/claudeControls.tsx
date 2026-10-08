import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { t } from "./i18n.ts";
import {
  claudeHeadIssue,
  claudeKeyKind,
  claudeLaunchTip,
  claudeOf,
  claudeRestartConsequence,
  claudeRestartTip,
  claudeShouldPoll,
  claudeSwitchReason,
  claudeSwitchText,
  claudeSwitchTip,
  claudeTodos,
  claudeViaRestart,
} from "./claudeView.ts";
import type { ClaudeSwitchPlace } from "./claudeView.ts";
import { parseBackendError } from "./backendError.ts";
import { RESTART_POLL_MS } from "./modelsView.ts";
import type { RestartPhase } from "./modelsView.ts";
import type { AgentListRowProps } from "./shell/agentRegistry.ts";
import type { ClaudeGatewayView, GatewayState } from "./types.ts";
import {
  BusySlot,
  Button,
  Confirm,
  FloatingToast,
  NoticePanel,
  Switch,
  Toast,
  Tooltip,
} from "./ui/index.ts";
import "./claudeControls.css";

/// Claude 桌面应用的第三方模型控件（#259 起没有 Claude 的页了：都在模型页那一行上）：开关、开关旁那一位
/// （`重启生效` / `打开 Claude`）、行下的待办条（别家配置在生效 + `接管`、被改掉了 + `重新写入`、切回没做完 + `再试一次`）。
/// 判断与文案在 claudeView；托盘那一行另有一份画法（TrayClaudeRow），说同一句话

/// 开关的读屏名（`启用 …`）：说清切的是桌面应用
const switchLabel = () => t("models.claudePage.switchLabel");

const describeError = (error: unknown): string => parseBackendError(String(error)).message;

// ===== 开关与开关旁那一位（模型页那一行用） =====

export interface ClaudeSwitchProps {
  view: ClaudeGatewayView;
  /// 拨下去、正在写：拨向哪一侧（乐观翻转：滑块已经在那一侧）；没在写为 null
  switching: boolean | null;
  /// 别的写 Claude 设置的事在做：先不接新的一拨，按下说「正在处理上一步」
  busy: boolean;
  /// 按不动时说哪一处的下一步（模型页那一行 / 托盘）
  place: ClaudeSwitchPlace;
  onToggle: (next: boolean) => void;
}

/// 开关（标准 34 × 20，开着由刻线说）。按不动（没装、受管、太旧、别家配置在生效、没选模型……）：禁用开关自带原因提示框，
/// 悬停出、按下当即出；拨下去写配置：乐观翻转，写超过 0.3 秒原位刻度 +「正在切换 / 正在切回」；平时提示框说拨下去会怎样
export function ClaudeSwitch({ view, switching, busy, place, onToggle }: ClaudeSwitchProps) {
  const blocked = claudeSwitchReason(view, place);
  const on = switching ?? view.enabled;
  return (
    <span className="claude-switch">
      {blocked !== null && switching === null ? (
        <Switch
          checked={false}
          onChange={() => undefined}
          label={switchLabel()}
          disabledReason={blocked}
          tipPlacement="bottom"
        />
      ) : (
        <BusySlot busy={switching !== null} label={claudeSwitchText(switching ?? true).busy}>
          <Tooltip content={claudeSwitchTip(on)} placement="bottom">
            <Switch
              checked={on}
              onChange={onToggle}
              label={switchLabel()}
              disabledReason={busy && switching === null ? t("models.control.busyPrev") : undefined}
            />
          </Tooltip>
        </BusySlot>
      )}
    </span>
  );
}

export interface ClaudeKeySlotProps {
  view: ClaudeGatewayView;
  phase: RestartPhase;
  busy: boolean;
  /// 点 `重启生效`：调用方先确认（窗口正中）
  onRestart: () => void;
  onLaunch: () => void;
  /// `✓ 已重启 / 已打开` 那一窗到点
  onDoneDismiss: () => void;
  /// section：模型页那一行（提示框、✓ 左对齐键）
  place: "section";
}

/// 开关旁那一位（DESIGN「开关＝配置里开没开」）：`重启生效` / `打开 Claude` 同一位、不同时出现（claudeKeyKind），默认键紧凑 24。
/// 重启、打开期间原位忙碌（过了 0.3 秒门槛换成刻度 + `正在重启 Claude` / `正在打开 Claude`）；成了键消失，
/// 原位下方浮起 `✓ 已重启 / 已打开`（约 4 秒淡出）。拨开关写配置期间这一位空着（写完才知道要不要重启）
export function ClaudeKeySlot({
  view,
  phase,
  busy,
  onRestart,
  onLaunch,
  onDoneDismiss,
}: ClaudeKeySlotProps) {
  if (phase.kind === "restarting" || phase.kind === "launching") {
    const restarting = phase.kind === "restarting";
    return (
      <BusySlot
        busy
        label={
          restarting
            ? t("models.control.restartingLabel", { app: "Claude" })
            : t("models.control.openingLabel", { app: "Claude" })
        }
      >
        <Button size="compact">
          {restarting
            ? t("models.control.restartKey")
            : t("models.control.openKey", { app: "Claude" })}
        </Button>
      </BusySlot>
    );
  }
  if (phase.kind === "done" || phase.kind === "launched") {
    // 键已消失：原位留一个不占宽、与键同高的锚，结果浮在它正下方 4、左沿对齐
    return (
      <span className="claude-key__spot">
        <FloatingToast align="start">
          <Toast
            kind="success"
            sentence={phase.kind === "done" ? "models.control.restarted" : "models.control.opened"}
            onDismiss={onDoneDismiss}
          />
        </FloatingToast>
      </span>
    );
  }
  if (phase.kind !== "idle") return null;
  const kind = claudeKeyKind(view);
  if (kind === null) return null;
  const restart = kind === "restart";
  const label = restart
    ? t("models.control.restartKey")
    : t("models.control.openKey", { app: "Claude" });
  return (
    <Tooltip
      content={restart ? claudeRestartTip() : claudeLaunchTip()}
      placement="bottom"
      align="start"
      nowrap
    >
      {busy ? (
        <Button size="compact" disabled disabledReason={t("models.control.busyPrev")}>
          {label}
        </Button>
      ) : (
        <Button size="compact" onClick={restart ? onRestart : onLaunch}>
          {label}
        </Button>
      )}
    </Tooltip>
  );
}

/// 模型页里 Claude 那一行的右端控件列（注册表 `listRow.Controls`；DESIGN「模型 › 一个 agent 一行」）：条件键（`重启生效` /
/// `打开 Claude`）+ 12 + 开关。拨了就写、不确认、乐观翻转；`重启生效` 先确认（窗口正中）；
/// 禁用时按下即说原因——行上说「是什么」、提示框说「怎么办」。
/// 没写成：重读真实状态，这一行下出行内灰面板 + `再试一次`（经 `onNotice` 交给模型页挂）。键显示着时每 5 秒轻查一次
export function ClaudeListControls({ state, onNotice, onGatewayState, pick }: AgentListRowProps) {
  const view = claudeOf(state);
  const [phase, setPhase] = useState<RestartPhase>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const alive = () => mounted.current;

  const quietRefresh = useCallback(async () => {
    try {
      const next = await api.gatewayState();
      if (mounted.current) onGatewayState(next);
    } catch {
      // 轻查失败不打扰
    }
  }, [onGatewayState]);
  const polling = claudeShouldPoll(view, phase.kind === "idle" && !busy);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void quietRefresh(), RESTART_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, quietRefresh]);
  const dismissDone = useCallback(() => setPhase({ kind: "idle" }), []);

  if (view === null) return null;

  /// 行下灰面板：主句 + 原因 + `再试一次`
  const fail = (message: string, reason: string, retry: () => void) =>
    onNotice(
      <NoticePanel
        message={message}
        reason={reason}
        action={{ label: t("models.notice.retry"), onClick: retry }}
        onClose={() => onNotice(null)}
      />,
    );

  /// 跑一个动作：成了把后端给的状态报给壳；没成重读并返回原因。这一行没了返回 undefined
  const attempt = async (act: () => Promise<GatewayState>): Promise<string | null | undefined> => {
    onNotice(null);
    setBusy(true);
    let reason: string | null = null;
    try {
      const next = await act();
      if (alive()) onGatewayState(next);
    } catch (error) {
      reason = describeError(error);
      await quietRefresh();
    } finally {
      if (alive()) setBusy(false);
    }
    return alive() ? reason : undefined;
  };

  const toggle = async (next: boolean) => {
    setPhase({ kind: "switching", next });
    const reason = await attempt(() =>
      next ? api.gatewayEnable("claude") : api.gatewayRestore("claude"),
    );
    if (reason === undefined) return;
    setPhase({ kind: "idle" });
    if (reason !== null) fail(claudeSwitchText(next).failed, reason, () => void toggle(next));
  };

  const restart = async () => {
    setConfirmRestart(false);
    setPhase({ kind: "restarting" });
    const reason = await attempt(() => api.gatewayRestartClaude());
    if (reason === undefined) return;
    setPhase(reason === null ? { kind: "done" } : { kind: "idle" });
    if (reason !== null)
      fail(t("models.notice.notRestarted", { app: "Claude" }), reason, () => void restart());
  };

  const launch = async () => {
    setPhase({ kind: "launching" });
    const reason = await attempt(() => api.gatewayLaunchClaude());
    if (reason === undefined) return;
    setPhase(reason === null ? { kind: "launched" } : { kind: "idle" });
    if (reason !== null)
      fail(t("models.notice.notOpened", { app: "Claude" }), reason, () => void launch());
  };

  return (
    <>
      <ClaudeKeySlot
        view={view}
        phase={phase}
        busy={busy}
        onRestart={() => setConfirmRestart(true)}
        onLaunch={() => void launch()}
        onDoneDismiss={dismissDone}
        place="section"
      />
      {pick}
      <ClaudeSwitch
        view={view}
        switching={phase.kind === "switching" ? phase.next : null}
        busy={busy}
        place="list"
        onToggle={(next) => void toggle(next)}
      />
      {confirmRestart ? (
        <Confirm
          title={t("models.restart.confirmTitle", { app: "Claude" })}
          confirmLabel={t("models.restart.confirmLabel")}
          onConfirm={() => void restart()}
          onCancel={() => setConfirmRestart(false)}
        >
          {claudeRestartConsequence(view.enabled)}
        </Confirm>
      ) : null}
    </>
  );
}

/// 模型页里 Claude 那一行下的待办条（注册表 `listRow.Todos`；画板第 1′ 屏「待办条挂在行下」）：别家配置在生效 + `接管`、
/// 被改掉了 + `重新写入`、切回没做完 + `再试一次`。桌面应用在运行时 `重新写入` / `再试一次` 走 `重启生效`（先确认）。
/// 做不成：行下灰面板 + `再试一次`（经 `onNotice`）。问题解决自动收起，不给「稍后」
export function ClaudeRowTodos({ state, onNotice, onGatewayState }: AgentListRowProps) {
  const view = claudeOf(state);
  const [resolving, setResolving] = useState<"takeover" | "rewrite" | "restore" | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (view === null || state.gateway === null) return null;
  const gateway: GatewayState = state.gateway;
  const todos = claudeTodos(gateway);
  const head = claudeHeadIssue(view);
  if (todos.length === 0 && head === null && !confirmRestart) return null;

  const failText = (kind: "takeover" | "rewrite" | "restore") =>
    kind === "takeover"
      ? t("models.notice.takeoverFailed", { tool: "Claude" })
      : kind === "rewrite"
        ? t("models.notice.rewriteFailed", { tool: "Claude" })
        : claudeSwitchText(false).failed;

  const run = async (kind: "takeover" | "rewrite" | "restore") => {
    if (kind !== "takeover" && claudeViaRestart(view)) {
      setConfirmRestart(true);
      return;
    }
    onNotice(null);
    setResolving(kind);
    try {
      const next = await (kind === "takeover"
        ? api.gatewayTakeover("claude")
        : kind === "rewrite"
          ? api.gatewayEnable("claude")
          : api.gatewayRestore("claude"));
      if (mounted.current) onGatewayState(next);
    } catch (error) {
      if (mounted.current)
        onNotice(
          <NoticePanel
            message={failText(kind)}
            reason={describeError(error)}
            action={{ label: t("models.notice.retry"), onClick: () => void run(kind) }}
            onClose={() => onNotice(null)}
          />,
        );
    } finally {
      if (mounted.current) setResolving(null);
    }
  };

  const restart = async () => {
    setConfirmRestart(false);
    onNotice(null);
    setResolving("rewrite");
    try {
      const next = await api.gatewayRestartClaude();
      if (mounted.current) onGatewayState(next);
    } catch (error) {
      if (mounted.current)
        onNotice(
          <NoticePanel
            message={t("models.notice.notRestarted", { app: "Claude" })}
            reason={describeError(error)}
            action={{ label: t("models.notice.retry"), onClick: () => void restart() }}
            onClose={() => onNotice(null)}
          />,
        );
    } finally {
      if (mounted.current) setResolving(null);
    }
  };

  const busy = resolving !== null;
  return (
    <>
      {head !== null ? (
        <NoticePanel
          message={head.message}
          reason={head.reason}
          busy={resolving === "restore" ? claudeSwitchText(false).busy : undefined}
          action={{
            label: t("models.issue.retry"),
            onClick: () => void run("restore"),
            disabledReason: busy ? t("models.control.busyPrev") : undefined,
          }}
        />
      ) : null}
      {todos.map((todo) => (
        <NoticePanel
          key={todo.kind}
          message={todo.message}
          reason={todo.reason ?? undefined}
          busy={resolving === todo.kind ? todo.busy : undefined}
          action={{
            label: todo.label,
            onClick: () => void run(todo.kind),
            disabledReason: busy ? t("models.control.busyPrev") : undefined,
          }}
        />
      ))}
      {confirmRestart ? (
        <Confirm
          title={t("models.restart.confirmTitle", { app: "Claude" })}
          confirmLabel={t("models.restart.confirmLabel")}
          onConfirm={() => void restart()}
          onCancel={() => setConfirmRestart(false)}
        >
          {claudeRestartConsequence(view.enabled)}
        </Confirm>
      ) : null}
    </>
  );
}
