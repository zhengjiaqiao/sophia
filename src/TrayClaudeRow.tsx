import { useCallback, useEffect, useId, useState } from "react";
import type { ReactElement } from "react";
import { api } from "./api.ts";
import { t } from "./i18n.ts";
import {
  claudeAccountCost,
  claudeLaunchTip,
  claudeRestartTip,
  claudeOf,
  claudeRestartConsequence,
  claudeSwitchText,
  claudeSwitchTip,
} from "./claudeView.ts";
import { parseBackendError } from "./backendError.ts";
import type { RestartPhase } from "./modelsView.ts";
import type { TrayRowProps } from "./shell/agentRegistry.ts";
import type { GatewayState } from "./types.ts";
import { trayClaudeRow } from "./trayView.ts";
import {
  BusySlot,
  Button,
  Confirm,
  FloatingToast,
  NoticePanel,
  Switch,
  Toast,
  Tooltip,
  TruncTip,
} from "./ui/index.ts";

/// 托盘面板里 Claude 那一块的「第三方模型」一行（注册表 Claude 那一项的 `trayRow`，经 TrayModelsRow 导出；
/// spec 2026-09-29 R44，DESIGN「托盘面板」「Claude 的页：桌面应用」）。样式在 TrayPanel.css。
///
/// 与 Codex 那一行同一骨架（TrayModelsRow 的 `TrayThirdPartyModels`）：名字 + 右端 [键位 12 开关]，
/// 确认与做不成的灰面板在行下当场展开。只差 Claude 自己的几样：
/// - 开关＝配置里开没开：拨了就写、不确认、乐观翻转。桌面应用在运行时后端只记为待生效（键位出 `重启生效`），
///   没在运行时当场写好（开着时键位出 `打开 Claude`）。撤回由后端在同一动作里做（spec R32），这里不反向再写；
///   没成就重读真实状态、画上去，行下灰面板 + `再试一次`
/// - 键位 `重启生效` / `打开 Claude` 占同一位（claudeView.claudeKeyKind）。`重启生效` 打断正在用的桌面应用，
///   先在面板里展开 `重启 Claude？`（正文按方向）；`打开 Claude` 不打断什么，不确认。后端等到它重新在跑才返回
/// - 开着时能力行下一行灰字 `账号里的对话暂时看不到`（代价写在明处）；已选不进托盘（托盘是拨开关的地方）
/// - Esc：确认开着先收回那一问（捕获阶段接住）；面板每次弹出，上次没答的确认作废

/// `✓ 已重启 / 已打开` 的锚：能力行右端那一组（键位 + 开关）
const endOf = (probe: HTMLElement) => probe.closest(".tray__end");

/// 键位那一处在做什么：modelsView 的阶段（switching / restarting / done / launching / launched），外加确认展开着
type Phase = RestartPhase | { kind: "confirming" };

/// 行下的灰面板：主句 + 原因 + `再试一次`。`for` 说它跟着哪颗键：那颗键消失（问题解决了）就一起走
interface TrayNotice {
  message: string;
  reason: string;
  retry: () => void;
  for: "restart" | "launch" | "switch";
}

export function TrayClaudeModels({ title, state, tray }: TrayRowProps) {
  const view = claudeOf(state);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [notice, setNotice] = useState<TrayNotice | null>(null);
  const confirmId = useId();

  // 面板每次弹出：收起时没答的确认作废；正在做的（重启、打开、拨开关）照常做完
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

  const dismissDone = useCallback(() => setPhase({ kind: "idle" }), []);

  /// 做不成之后重读一次，开关与键位画成真实状态（读不到就停在上次拿到的）
  const reread = async () => {
    try {
      const actual = await api.gatewayState();
      if (tray.alive()) tray.applyGateway(actual);
    } catch {
      // 下一次弹出或操作还会再读
    }
  };

  /// 跑一个动作：写之前排在还没写完的后面；成了把后端给的状态画上去，没成重读并返回原因。
  /// 面板没了返回 undefined，调用方什么都别做
  const run = async (act: () => Promise<GatewayState>) => {
    setNotice(null);
    setBusy(true);
    let reason: string | null = null;
    try {
      await tray.idle();
      const fresh = await act();
      if (tray.alive()) tray.applyGateway(fresh);
    } catch (error) {
      reason = parseBackendError(String(error)).message;
      await reread();
    } finally {
      if (tray.alive()) setBusy(false);
    }
    return tray.alive() ? reason : undefined;
  };

  /// 拨开关：不确认，直接写（在运行时后端只记为待生效）；滑块当即过去
  const toggle = async (next: boolean) => {
    setPhase({ kind: "switching", next });
    const reason = await run(() =>
      next ? api.gatewayEnable("claude") : api.gatewayRestore("claude"),
    );
    if (reason === undefined) return;
    setPhase({ kind: "idle" });
    if (reason !== null) {
      setNotice({
        message: claudeSwitchText(next).failed,
        reason,
        retry: () => void toggle(next),
        for: "switch",
      });
    }
  };

  /// 重启生效（确认之后）：退出 → 写 → 打开，后端等到它重新在跑才返回
  const restartClaude = async () => {
    setPhase({ kind: "restarting" });
    const reason = await run(() => api.gatewayRestartClaude());
    if (reason === undefined) return;
    setPhase(reason === null ? { kind: "done" } : { kind: "idle" });
    if (reason !== null) {
      setNotice({
        message: t("models.notice.notRestarted", { app: "Claude" }),
        reason,
        retry: () => void restartClaude(),
        for: "restart",
      });
    }
  };

  /// 打开 Claude：有待生效的先写再打开，后端等到它在跑才返回；不确认
  const launchClaude = async () => {
    setPhase({ kind: "launching" });
    const reason = await run(() => api.gatewayLaunchClaude());
    if (reason === undefined) return;
    setPhase(reason === null ? { kind: "launched" } : { kind: "idle" });
    if (reason !== null) {
      setNotice({
        message: t("models.notice.notOpened", { app: "Claude" }),
        reason,
        retry: () => void launchClaude(),
        for: "launch",
      });
    }
  };

  if (view === null) return null;
  const row = trayClaudeRow(view);
  // 拨下去、正在写：滑块已经在拨过去的那一侧（乐观翻转）
  const on = phase.kind === "switching" ? phase.next : view.enabled;
  // 空闲与确认展开时按状态出键；写配置期间这一格空着（写完才知道要不要重启）
  const key = phase.kind === "idle" || phase.kind === "confirming" ? row.key : null;
  // 灰面板跟着它那颗键：键消失（问题解决了）就一起走
  const noticeLive =
    notice !== null &&
    phase.kind === "idle" &&
    (notice.for === "switch" ||
      (notice.for === "restart" && key === "restart") ||
      (notice.for === "launch" && key === "launch"));
  const label = t("models.tray.switchLabel", { tool: "Claude", title });

  /// 开关旁那一位：忙碌刻度 / `✓ 已重启 · 已打开` / `重启生效` / `打开 Claude`
  const keySlot = (): ReactElement | null => {
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
      return (
        <FloatingToast align="end" anchor={endOf}>
          <Toast
            kind="success"
            sentence={phase.kind === "done" ? "models.control.restarted" : "models.control.opened"}
            onDismiss={dismissDone}
          />
        </FloatingToast>
      );
    }
    if (key === null) return null;
    const restart = key === "restart";
    const text = restart
      ? t("models.control.restartKey")
      : t("models.control.openKey", { app: "Claude" });
    const expanded = restart ? phase.kind === "confirming" : undefined;
    return (
      <Tooltip content={restart ? claudeRestartTip() : claudeLaunchTip()} placement="bottom">
        {busy ? (
          <Button size="compact" disabled disabledReason={t("models.control.busyPrev")}>
            {text}
          </Button>
        ) : (
          <Button
            size="compact"
            onClick={
              restart
                ? () => {
                    setNotice(null);
                    setPhase({ kind: "confirming" });
                  }
                : () => void launchClaude()
            }
            ariaExpanded={expanded}
            ariaControls={expanded ? confirmId : undefined}
          >
            {text}
          </Button>
        )}
      </Tooltip>
    );
  };

  return (
    <>
      <div className="tray__cap">
        {/* 名字撑满键位左边的宽（同 Codex 那一行）：不撑开的话开关贴着名字，不在右端 */}
        <TruncTip content={title} fit="grow">
          <span className="tray__cap-title">{title}</span>
        </TruncTip>
        <span className="tray__end">
          {/* 键位：失败的灰面板出来时让给它 */}
          {noticeLive ? null : keySlot()}
          {/* 开关＝配置里开没开：按不动时按下即说原因；拨了就写，滑块当即过去 */}
          {row.toggle.disabledReason !== null && phase.kind !== "switching" ? (
            <Switch
              checked={false}
              onChange={() => undefined}
              label={label}
              disabledReason={row.toggle.disabledReason}
              tipPlacement="bottom"
            />
          ) : (
            <BusySlot
              busy={phase.kind === "switching"}
              label={claudeSwitchText(phase.kind === "switching" ? phase.next : true).busy}
            >
              <Tooltip content={claudeSwitchTip(on)} placement="bottom">
                <Switch
                  checked={on}
                  onChange={(next) => void toggle(next)}
                  label={label}
                  disabledReason={
                    busy && phase.kind !== "switching" ? t("models.control.busyPrev") : undefined
                  }
                />
              </Tooltip>
            </BusySlot>
          )}
        </span>
      </div>
      {/* 开着时的代价写在明处（12 ink-mute，同一条左沿） */}
      {on ? <p className="tray__cost">{claudeAccountCost()}</p> : null}
      {phase.kind === "confirming" && key === "restart" ? (
        // 确认在面板里当场展开（窄面板形态）：标题 + 按方向的后果 + `取消` 与主动作
        <div className="tray__confirm">
          <Confirm
            inline
            id={confirmId}
            title={t("models.restart.confirmTitle", { app: "Claude" })}
            confirmLabel={t("models.restart.confirmLabel")}
            onConfirm={() => void restartClaude()}
            onCancel={() => setPhase({ kind: "idle" })}
          >
            {claudeRestartConsequence(view.enabled)}
          </Confirm>
        </div>
      ) : null}
      {noticeLive && notice ? (
        // 带下一步的失败：能力行下灰面板（键位原位让给它），不会自己走
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
}
