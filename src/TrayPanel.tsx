import { useCallback, useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import {
  gatewayConfirmText,
  gatewaySwitchText,
  parseBackendError,
  settleAfterRestart,
  switchGateway,
} from "./modelsView";
import { createSelectionWriter } from "./selectionWrites";
import { RESTART_CONSEQUENCE, RESTART_TIP, UNINSTALL_TIP, trayRow } from "./trayView";
import type { GatewayState } from "./types";
import {
  AgentIcon,
  BusySlot,
  Button,
  FloatingToast,
  NoticePanel,
  Switch,
  Toast,
  Tooltip,
} from "./ui";
import "./TrayPanel.css";

/// 菜单栏面板（DESIGN「托盘面板」，画板 Tray）。
///
/// 与模型页同一行的缩小版：`16px 图标 + Codex + 开关`，没有状态句。改动等着生效时开关后 12
/// 出紧凑键 `重启生效`（按钮即状态），确认在面板里当场展开；重启中 = 过了 0.3 秒门槛原位 14px
/// 忙碌指示 +「正在重启 Codex」，成功 = 键消失、原位下方浮起 `✓ 已生效` 约 4 秒淡出，
/// 失败 = 行下灰面板（带下一步 `再试一次`，不会自己走；关掉、再试或键消失才走）。
/// 菜单三项 `打开 Sophia` `设置` `退出`，悬停 `surface` 底。与主窗口共用 tokens 与组件。
///
/// - 开关同模型页（DESIGN「开关的状态＝Codex 正在用的状态」）：不乐观翻转；Codex 在跑时确认在面板里
///   当场展开（`重启并添加` / `重启并移除`），取消什么都不写；确认后开关原位转圈 +「正在添加 / 正在移除」，
///   成了落到新状态、原位下方浮起 `✓ 已添加到 Codex`；没成则连配置一起撤回，行下灰面板 + `再试一次`
/// - 卸下后台服务做不成：把主窗口带到「模型」页，由那里说原因——面板放不下一段解释
/// - 面板改了状态就广播 `gateway-changed`，主窗口的「模型」页跟着刷新

/// 面板里的动作做不成：主窗口到前面、切到「模型」页、把原话带过去
const failOver = (error: unknown) =>
  api.trayOpenMain("models", parseBackendError(String(error)).message);

/// 行上那一处在做什么：重启生效的确认 / 重启中 / 已生效；拨开关的确认 / 写配置到 Codex 换上 / 成了那一窗
type Restart =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "restarting" }
  | { kind: "done" }
  | { kind: "confirmSwitch"; next: boolean }
  | { kind: "switching"; next: boolean }
  | { kind: "switched"; text: string };

/// 行下灰面板：主句 + 原因 + `再试一次`。`restart` 为真的是重启没成——键消失（问题解决了）就一起走
interface TrayNotice {
  message: string;
  reason: string;
  retry: () => void;
  restart: boolean;
}

export default function TrayPanel() {
  const [state, setState] = useState<GatewayState | null>(null);
  const [busy, setBusy] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [restart, setRestart] = useState<Restart>({ kind: "idle" });
  /// 重启 / 拨开关没成（行下灰面板）：带下一步的失败不会自己走——关掉、再试一次、
  /// 或问题解决了（`重启生效` 键消失）才走，面板收起再弹出也还在
  const [notice, setNotice] = useState<TrayNotice | null>(null);
  const mounted = useRef(true);
  /// 此刻画在面板上的状态
  const shown = useRef<GatewayState | null>(null);
  /// 后端给的状态一律经它：画上去、广播给主窗口。开关不再乐观翻转、不经它的写队列
  /// （见 runSwitch），留着它是为了与模型页同一个入口；写失败那一支面板用不到
  const [writer] = useState(() =>
    createSelectionWriter<GatewayState>({
      paint: (next) => {
        shown.current = next;
        setState(next);
      },
      report: () => void emit("gateway-changed"),
      reread: () => api.gatewayState(),
      onDone: () => undefined,
      onFail: (_message, error) => void failOver(error),
      alive: () => mounted.current,
    }),
  );
  const applyState = writer.accept;

  const refresh = useCallback(async () => {
    try {
      const next = await api.gatewayState();
      if (mounted.current) applyState(next);
    } catch (error) {
      void failOver(error);
    }
  }, [applyState]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // 每次弹出都重读：主窗口、命令行、别的程序都可能改过状态；外部重启了 Codex，键要自己消失
    const pending = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      // 弹出时焦点落在面板本身，不落在任何控件上：否则 WebKit 把它交给第一个能聚焦的东西
      // （禁用开关的原因包层），一弹出就是焦点框 + 原因提示。Tab 仍从第一个控件开始
      // 窗口变成键窗口之后 WebKit 才挑初始焦点，所以下一帧再收一次
      rootRef.current?.focus({ preventScroll: true });
      requestAnimationFrame(() => rootRef.current?.focus({ preventScroll: true }));
      // 收起时没答的确认作废；正在做的（重启、拨开关）照常做完
      setRestart((r) => (r.kind === "restarting" || r.kind === "switching" ? r : { kind: "idle" }));
      void refresh();
    });
    return () => {
      mounted.current = false;
      void pending.then((un) => un());
    };
  }, [refresh]);

  // ✓ 已生效那一窗到点（停留、悬停停表、淡出都在 Toast 里）
  const dismissDone = useCallback(() => setRestart({ kind: "idle" }), []);

  /// 拨开关：Codex 在跑先在面板里确认（要重启，进行中的对话会中断）；没在跑直接写
  const toggle = (next: boolean) => {
    const current = shown.current;
    if (!current) return;
    setNotice(null);
    if (current.codex.running) setRestart({ kind: "confirmSwitch", next });
    else void runSwitch(next, false);
  };

  /// 写配置 →（在跑时）重启 Codex → 等它换上（最多 15 秒）；没成则撤回刚写的（同模型页，switchGateway）
  const runSwitch = async (next: boolean, restart: boolean) => {
    setNotice(null);
    setRestart({ kind: "switching", next });
    setBusy(true);
    let reason: string | null | undefined;
    try {
      await writer.idle();
      reason = await switchGateway(next, restart, {
        write: (on) => (on ? api.gatewayEnable() : api.gatewayRestore()),
        restartCodex: api.gatewayRestartCodex,
        read: api.gatewayState,
        onState: applyState,
        alive: () => mounted.current,
        describe: (error) => parseBackendError(String(error)).message,
      });
    } finally {
      if (mounted.current) setBusy(false);
    }
    if (reason === undefined || !mounted.current) return;
    const text = gatewaySwitchText(next, restart);
    if (reason === null) {
      setRestart({ kind: "switched", text: text.done });
      return;
    }
    setRestart({ kind: "idle" });
    setNotice({ message: text.failed, reason, retry: () => toggle(next), restart: false });
  };

  /// 停用后服务仍在：卸下它。做不成就把主窗口带到模型页说原因（面板放不下一段解释）
  const uninstall = async () => {
    setUninstalling(true);
    setBusy(true);
    try {
      // 排在还没写完的开关后面：都写 Codex 设置，先后要和点的顺序一致
      await writer.idle();
      const fresh = await api.gatewayRestore();
      if (mounted.current) applyState(fresh);
    } catch (error) {
      void failOver(error);
    } finally {
      if (mounted.current) {
        setBusy(false);
        setUninstalling(false);
      }
    }
  };

  const restartCodex = async () => {
    setNotice(null);
    setRestart({ kind: "restarting" });
    setBusy(true);
    let reason: string | null = null;
    try {
      await writer.idle();
      await api.gatewayRestartCodex();
      // 同模型页：等旧进程退了才算成，上限 15 秒（发完信号立刻读会误判成没重启）
      const settled = await settleAfterRestart(api.gatewayState, applyState, () => mounted.current);
      if (settled === undefined) return;
      reason = settled;
    } catch (error) {
      reason = parseBackendError(String(error)).message;
    } finally {
      if (mounted.current) setBusy(false);
    }
    if (!mounted.current) return;
    setNotice(
      reason === null
        ? null
        : {
            message: "没重启 Codex",
            reason,
            retry: () => void restartCodex(),
            restart: true,
          },
    );
    setRestart(reason === null ? { kind: "done" } : { kind: "idle" });
  };

  // Esc：确认开着先收回那一问，否则收起面板
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (restart.kind === "confirming" || restart.kind === "confirmSwitch")
        setRestart({ kind: "idle" });
      else void api.trayHide();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [restart]);

  // 面板高度跟着内容走：确认、灰面板展开时高一点
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const report = () => void api.traySetHeight(Math.ceil(root.getBoundingClientRect().height));
    const observer = new ResizeObserver(report);
    observer.observe(root);
    report();
    return () => observer.disconnect();
  }, []);

  const row = state ? trayRow(state) : null;
  const switching = restart.kind === "switching" ? restart.next : null;

  /// 确认在面板里当场展开：标题 + 一句后果 + 取消（文字链）+ 主动作（重启 / 重启并添加 / 重启并移除）
  const confirmPanel = (title: string, body: string, label: string, onConfirm: () => void) => (
    <div className="tray__confirm" role="dialog" aria-label={title}>
      <div className="tray__confirm-title">{title}</div>
      <div className="tray__confirm-body">{body}</div>
      <div className="tray__confirm-foot">
        <Button variant="quiet" onClick={() => setRestart({ kind: "idle" })}>
          取消
        </Button>
        <Button variant="primary" size="compact" onClick={onConfirm}>
          {label}
        </Button>
      </div>
    </div>
  );

  const restartSlot = () => {
    // 拨开关写完配置到 Codex 换上之间，状态会说「要重启」：键不能跟着闪出来
    if (restart.kind === "switching") return null;
    if (restart.kind === "restarting") {
      // 键锁住，过了 0.3 秒门槛原位换成忙碌指示 + 一句
      return (
        <BusySlot busy label="正在重启 Codex" className="tray__restart">
          <span className="tray__restart-tip">
            <Button size="compact">重启生效</Button>
          </span>
        </BusySlot>
      );
    }
    if (restart.kind === "done") {
      // 键已消失：原位留一个不占宽的锚，`✓ 已生效` 浮在它正下方 4
      return (
        <span className="tray__restart tray__restart--done">
          <FloatingToast align="start">
            <Toast kind="success" verb="已生效" onDismiss={dismissDone} />
          </FloatingToast>
        </span>
      );
    }
    if (row?.showUninstall) {
      return (
        <BusySlot busy={uninstalling} label="正在卸下后台服务" className="tray__restart">
          <span className="tray__restart-tip">
            <Tooltip content={UNINSTALL_TIP} placement="bottom">
              {busy && !uninstalling ? (
                <Button size="compact" disabled disabledReason="正在处理上一步">
                  卸下后台服务
                </Button>
              ) : (
                <Button size="compact" onClick={uninstalling ? undefined : () => void uninstall()}>
                  卸下后台服务
                </Button>
              )}
            </Tooltip>
          </span>
        </BusySlot>
      );
    }
    if (!row?.showRestart) return null;
    return (
      // 这句提示框按画板单行显示（其余提示框仍是 240 上限）
      <span className="tray__restart-tip">
        <Tooltip content={RESTART_TIP} placement="bottom">
          {busy ? (
            <Button size="compact" disabled disabledReason="正在处理上一步">
              重启生效
            </Button>
          ) : (
            <Button
              size="compact"
              onClick={() => {
                setNotice(null);
                setRestart({ kind: "confirming" });
              }}
            >
              重启生效
            </Button>
          )}
        </Tooltip>
      </span>
    );
  };

  return (
    <div className="tray" ref={rootRef} tabIndex={-1}>
      {state && row?.visible ? (
        <section className="tray__agent">
          <div className="tray__row">
            <AgentIcon id="codex" name="Codex" size={16} />
            <span className="tray__name">Codex</span>
            {/* 开关不乐观翻转：等确认、等生效，成了才落到新状态，原位下方浮起一窗 */}
            <span className="tray__switch">
              {row.toggle.disabledReason !== null && switching === null ? (
                // 禁用的开关自带原因提示框：悬停出、按下当即出（同模型页）
                <Switch
                  checked={false}
                  onChange={() => undefined}
                  label="启用 Codex 的第三方模型"
                  disabledReason={row.toggle.disabledReason}
                  tipPlacement="bottom"
                />
              ) : (
                <BusySlot
                  busy={switching !== null}
                  label={gatewaySwitchText(switching ?? true, true).busy}
                >
                  <Tooltip
                    content={
                      row.toggle.on ? "关掉：Codex 只剩官方模型" : "打开：选好的模型进 Codex"
                    }
                    placement="bottom"
                  >
                    <Switch
                      checked={row.toggle.on}
                      onChange={toggle}
                      label="启用 Codex 的第三方模型"
                      disabledReason={busy && switching === null ? "正在处理上一步" : undefined}
                    />
                  </Tooltip>
                </BusySlot>
              )}
              {restart.kind === "switched" ? (
                <FloatingToast align="start">
                  <Toast kind="success" verb={restart.text} onDismiss={dismissDone} />
                </FloatingToast>
              ) : null}
            </span>
            {restartSlot()}
          </div>
          {restart.kind === "confirming"
            ? confirmPanel("重启 Codex？", RESTART_CONSEQUENCE, "重启", () => void restartCodex())
            : null}
          {restart.kind === "confirmSwitch"
            ? (() => {
                const text = gatewayConfirmText(state, restart.next);
                const next = restart.next;
                return confirmPanel(
                  text.title,
                  text.body,
                  text.confirmLabel,
                  () => void runSwitch(next, true),
                );
              })()
            : null}
          {notice !== null && restart.kind === "idle" && (!notice.restart || row.showRestart) ? (
            // 带下一步的失败：行下灰面板，不会自己走（DESIGN「反馈的两种形态」）
            <div className="tray__notice">
              <NoticePanel
                message={notice.message}
                reason={notice.reason}
                action={{ label: "再试一次", onClick: notice.retry }}
                onClose={() => setNotice(null)}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      <ul className="tray__menu">
        <li>
          <button
            type="button"
            className="tray__item"
            onClick={() => void api.trayOpenMain(null, null)}
          >
            打开 Sophia
          </button>
        </li>
        <li>
          <button
            type="button"
            className="tray__item"
            onClick={() => void api.trayOpenMain("settings", null)}
          >
            设置
          </button>
        </li>
        <li>
          <button type="button" className="tray__item" onClick={() => void api.trayQuit()}>
            退出
          </button>
        </li>
      </ul>
    </div>
  );
}
