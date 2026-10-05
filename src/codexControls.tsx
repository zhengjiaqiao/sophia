import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { api } from "./api.ts";
import type { ModelsTool, RestartPhase } from "./modelsView.ts";
import type { AgentListRowProps } from "./shell/agentRegistry.ts";
import {
  CODEX,
  LAUNCH_POLL_MS,
  LAUNCH_TIMEOUT_MS,
  RESTART_POLL_MS,
  codexAppName,
  codexKeyKind,
  codexListSwitchReason,
  gatewaySwitchText,
  gatewaySwitchTip,
  launchTimeout,
  launchTip,
  parseBackendError,
  restartConsequence,
  restartTip,
  settleAfterRestart,
  shouldPollRestart,
  switchDisabledReason,
  switchGateway,
} from "./modelsView.ts";
import { t } from "./i18n.ts";
import { codexGateway } from "./types.ts";
import type { GatewayState } from "./types.ts";
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
import "./codexControls.css";

/// Codex 能力控件（DESIGN「组件使用指南 › 不进组件库、在页面层合并的」）：「第三方模型」的开关三态、
/// 开关旁那一位的 `重启生效` / `启动 Codex`。Codex 页节头（ModelsTab）与托盘能力行
/// （TrayModelsRow）用的是这同一份——DESIGN「改动待生效」：Codex 页与托盘同一段逻辑。
/// 它带业务判断（哪颗键此刻该出、开关为什么按不动），所以不进 `src/ui`；写配置、重启、等结果由调用方做，
/// 这里只按调用方给的阶段画。两处只差放在哪（`place`）：节头里提示框与 `✓ 已生效` 左对齐键；
/// 托盘里提示框居中、`✓` 右沿对齐开关（锚是能力行右端那一组）

/// 开关旁那一位在做什么：modelsView 的阶段，外加托盘里「重启确认在面板里展开着」
export type CodexPhase = RestartPhase | { kind: "confirming" };

/// 确认开着时键照常在（它是确认的触发键），判断按空闲算
const settled = (phase: CodexPhase): RestartPhase =>
  phase.kind === "confirming" ? { kind: "idle" } : phase;

export interface CodexSwitchProps {
  tool: ModelsTool;
  state: GatewayState;
  /// 拨下去、正在写配置：拨向哪一侧（乐观翻转：滑块已经在那一侧）；没在写为 null
  switching: boolean | null;
  /// 别的写 Codex 设置的事在做：开关先不接新的一拨，按下说「正在处理上一步」
  busy: boolean;
  /// 读屏名
  label: string;
  /// 提示框在结果之后再说改的是哪个文件（Codex 页）；托盘面板窄，只说结果
  withFile?: boolean;
  /// 按不动的原因换一句（模型列表页的行上说「进去…」：`codexListSwitchReason`）；不给按 Codex 的页那句
  disabledReason?: string | null;
  onToggle: (next: boolean) => void;
}

/// 「第三方模型」的开关（标准 34 × 20，旁边不点指示点，开着由刻线说）。三态：
/// - 按不动（没有网关、没选模型、待接管……）：禁用开关自带原因提示框，悬停出、按下当即出
/// - 拨下去写配置：乐观翻转，滑块当即过去、橙刻线亮；写超过 0.3 秒原位换成刻度 +「正在添加 / 正在移除」
/// - 平时：提示框说拨下去会怎样（`gatewaySwitchTip`）
export function CodexSwitch({
  tool,
  state,
  switching,
  busy,
  label,
  withFile = false,
  disabledReason,
  onToggle,
}: CodexSwitchProps) {
  const blocked = disabledReason === undefined ? switchDisabledReason(state) : disabledReason;
  const on = switching ?? codexGateway(state).enabled;
  return (
    <span className="codex-switch">
      {blocked !== null && switching === null ? (
        <Switch
          checked={false}
          onChange={() => undefined}
          label={label}
          disabledReason={blocked}
          tipPlacement="bottom"
        />
      ) : (
        <BusySlot busy={switching !== null} label={gatewaySwitchText(switching ?? true, tool).busy}>
          <Tooltip content={gatewaySwitchTip(on, tool, withFile)} placement="bottom">
            <Switch
              checked={on}
              onChange={onToggle}
              label={label}
              disabledReason={busy && switching === null ? t("models.control.busyPrev") : undefined}
            />
          </Tooltip>
        </BusySlot>
      )}
    </span>
  );
}

export interface CodexKeySlotProps {
  state: GatewayState;
  phase: CodexPhase;
  /// 别的写 Codex 设置的事在做：键禁用并说「正在处理上一步」
  busy: boolean;
  /// 点 `重启生效`：调用方先确认（节头：窗口正中的确认框；托盘：面板里的窄面板）
  onRestart: () => void;
  onLaunch: () => void;
  /// `✓ 已生效 / 已启动` 那一窗到点
  onDoneDismiss: () => void;
  /// section：Codex 页节头（提示框、✓ 左对齐键）；tray：托盘能力行（提示框居中、✓ 右沿对齐 `doneAnchor`）
  place: "section" | "tray";
  /// 托盘：`✓` 的锚（能力行右端那一组：键位 + 开关）
  doneAnchor?: (probe: HTMLElement) => Element | null;
  /// 重启确认是面板里当场展开的窄面板（托盘）：它的 id，`重启生效` 的 aria-controls 指向它
  confirmId?: string;
}

/// 开关旁那一位（DESIGN「改动待生效：重启生效与启动 Codex」）：`重启生效` / `启动 Codex`
/// 同一位、不会同时出现（modelsView.codexKeyKind）；都是默认键紧凑 24。
/// 重启、启动期间原位忙碌（`BusySlot`：过了 0.3 秒门槛才换成刻度 + 一句，之前键照旧、点不动）；
/// 重启、启动成了键消失，原位下方浮起 `✓ 已生效 / 已启动`（约 4 秒淡出）。做不成的灰面板不在这里——由调用方挂
export function CodexKeySlot({
  state,
  phase,
  busy,
  onRestart,
  onLaunch,
  onDoneDismiss,
  place,
  doneAnchor,
  confirmId,
}: CodexKeySlotProps) {
  const tipAlign = place === "section" ? "start" : undefined;
  const tipped = (content: string, key: ReactElement) => (
    <Tooltip content={content} placement="bottom" align={tipAlign} nowrap={place === "section"}>
      {key}
    </Tooltip>
  );

  // 重启、启动退出 / 打开的是桌面应用本身：写它的名字（2026-09-30 起叫 ChatGPT），不写 agent 名
  const app = codexAppName(state);
  if (phase.kind === "restarting" || phase.kind === "launching") {
    const restarting = phase.kind === "restarting";
    return (
      <BusySlot
        busy
        label={
          restarting
            ? t("models.control.restartingLabel", { app })
            : t("models.control.launchingLabel", { app })
        }
      >
        <Button size="compact">
          {restarting ? t("models.control.restartKey") : t("models.control.launchKey", { app })}
        </Button>
      </BusySlot>
    );
  }
  if (phase.kind === "done" || phase.kind === "launched") {
    const toast = (
      <FloatingToast align={place === "section" ? "start" : "end"} anchor={doneAnchor}>
        <Toast
          kind="success"
          sentence={phase.kind === "done" ? "models.control.done" : "models.control.launched"}
          onDismiss={onDoneDismiss}
        />
      </FloatingToast>
    );
    // 节头：键已消失，原位留一个不占宽、与键同高的锚，结果浮在它正下方 4、左沿对齐
    return place === "section" ? <span className="codex-key__spot">{toast}</span> : toast;
  }

  const kind = codexKeyKind(state, settled(phase));
  if (kind === null) return null;
  const restart = kind === "restart";
  const label = restart ? t("models.control.restartKey") : t("models.control.launchKey", { app });
  const expanded = restart && confirmId !== undefined ? phase.kind === "confirming" : undefined;
  return tipped(
    restart ? restartTip(app) : launchTip(app),
    busy ? (
      <Button size="compact" disabled disabledReason={t("models.control.busyPrev")}>
        {label}
      </Button>
    ) : (
      <Button
        size="compact"
        onClick={restart ? onRestart : onLaunch}
        ariaExpanded={expanded}
        ariaControls={expanded ? confirmId : undefined}
      >
        {label}
      </Button>
    ),
  );
}

/// 模型列表页里 Codex 那一行的右端控件列（注册表 `listRow.Controls`；DESIGN「列表页」）：条件键（`重启生效` / `启动 Codex`，
/// 同 Codex 的页那一位）+ 12 + 开关。规则同 Codex 的页：拨了就写、不确认、乐观翻转；`重启生效` 先确认
/// （窗口正中）；禁用时按下即说原因——行上说「是什么」、提示框说「怎么办」（`codexListSwitchReason`）。
/// 没写成：滑块滑回，这一行下出行内灰面板 + `再试一次`（经 `onNotice` 交给列表页挂）；新状态经 `onGatewayState` 报给壳，
/// 列表页、侧栏橙点、Codex 的页下次推入都读同一份。键显示着时每 5 秒轻查一次（外部重启了 Codex，键要自己消失）
export function CodexListControls({ state, onNotice, onGatewayState }: AgentListRowProps) {
  const gateway = state.gateway;
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
  const describe = (error: unknown) => parseBackendError(String(error)).message;
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

  const quietRefresh = useCallback(async () => {
    try {
      const next = await api.gatewayState();
      if (mounted.current) onGatewayState(next);
    } catch {
      // 轻查失败不打扰
    }
  }, [onGatewayState]);
  const polling = shouldPollRestart(gateway, phase);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void quietRefresh(), RESTART_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, quietRefresh]);
  const dismissDone = useCallback(() => setPhase({ kind: "idle" }), []);

  if (gateway === null) return null;

  const toggle = async (next: boolean) => {
    onNotice(null);
    setPhase({ kind: "switching", next });
    setBusy(true);
    let reason: string | null | undefined;
    try {
      reason = await switchGateway(next, {
        write: (on) => (on ? api.gatewayEnable("codex") : api.gatewayRestore("codex")),
        read: api.gatewayState,
        onState: onGatewayState,
        alive,
        describe,
      });
    } finally {
      if (alive()) setBusy(false);
    }
    if (reason === undefined || !alive()) return;
    setPhase({ kind: "idle" });
    if (reason !== null) fail(gatewaySwitchText(next).failed, reason, () => void toggle(next));
  };

  const restart = async () => {
    setConfirmRestart(false);
    onNotice(null);
    setPhase({ kind: "restarting" });
    setBusy(true);
    let reason: string | null = null;
    try {
      await api.gatewayRestartCodex();
      // 等旧进程退了才算成，上限 15 秒（同 Codex 的页）
      const settled = await settleAfterRestart(api.gatewayState, onGatewayState, alive);
      if (settled === undefined) return;
      reason = settled;
    } catch (error) {
      reason = describe(error);
    } finally {
      if (alive()) setBusy(false);
    }
    if (!alive()) return;
    if (reason !== null)
      fail(
        t("models.notice.notRestarted", { app: codexAppName(gateway) }),
        reason,
        () => void restart(),
      );
    setPhase(reason === null ? { kind: "done" } : { kind: "idle" });
  };

  const launch = async () => {
    onNotice(null);
    setPhase({ kind: "launching" });
    setBusy(true);
    let reason: string | null = null;
    try {
      await api.gatewayLaunchCodex();
      const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
      for (;;) {
        const fresh = await api.gatewayState();
        if (!alive()) return;
        onGatewayState(fresh);
        if (codexGateway(fresh).codex.app.running) break;
        if (Date.now() >= deadline) {
          reason = launchTimeout(codexAppName(fresh));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, LAUNCH_POLL_MS));
        if (!alive()) return;
      }
    } catch (error) {
      reason = describe(error);
    } finally {
      if (alive()) setBusy(false);
    }
    if (!alive()) return;
    if (reason !== null)
      fail(
        t("models.notice.notLaunched", { app: codexAppName(gateway) }),
        reason,
        () => void launch(),
      );
    setPhase(reason === null ? { kind: "launched" } : { kind: "idle" });
  };

  return (
    <>
      <CodexKeySlot
        state={gateway}
        phase={phase}
        busy={busy}
        onRestart={() => setConfirmRestart(true)}
        onLaunch={() => void launch()}
        onDoneDismiss={dismissDone}
        place="section"
      />
      <CodexSwitch
        tool={CODEX}
        state={gateway}
        switching={phase.kind === "switching" ? phase.next : null}
        busy={busy}
        label={t("models.section.switchLabel", { tool: CODEX.name })}
        withFile
        disabledReason={codexListSwitchReason(gateway)}
        onToggle={(next) => void toggle(next)}
      />
      {confirmRestart ? (
        <Confirm
          title={t("models.restart.confirmTitle", { app: codexAppName(gateway) })}
          confirmLabel={t("models.restart.confirmLabel")}
          onConfirm={() => void restart()}
          onCancel={() => setConfirmRestart(false)}
        >
          {restartConsequence(codexAppName(gateway))}
        </Confirm>
      ) : null}
    </>
  );
}
