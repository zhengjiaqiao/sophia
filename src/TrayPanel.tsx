import { useCallback, useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import { factsLine, parseBackendError } from "./modelsView";
import { RESTART_CONSEQUENCE, trayRow } from "./trayView";
import type { GatewayState } from "./types";
import { AgentIcon, Busy, Button } from "./ui";
import "./TrayPanel.css";

/// 菜单栏面板（docs/specs/2026-09-21-tray.md）。
///
/// - 一行 Codex：现状一句话 + 开关。开关是 ghost pill 两态，反色＝已启用；不用滑动开关（DESIGN「Don't」）
/// - 面板放不下一段解释：动作做不成时把主窗口带到「模型」页，由那里说原因（R5）——一件事只在一个地方说
/// - 「重启 Codex」只在有改动等着生效时出现；它会中断进行中的对话，确认一道，就在那一行上完成（R4）
/// - 面板改了状态就广播 `gateway-changed`，主窗口的「模型」页跟着刷新（R8）

/// 面板里的动作做不成：主窗口到前面、切到「模型」页、把原话带过去
const failOver = (error: unknown) =>
  api.trayOpenMain("models", parseBackendError(String(error)).message);

export default function TrayPanel() {
  const [state, setState] = useState<GatewayState | null>(null);
  /// 正在做的事，顶替现状句：只把按钮变淡不说话，那几百毫秒到几秒里看起来就是卡住了
  const [busy, setBusy] = useState<null | string>(null);
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  /// 重启 Codex 的结果就一句，顶替现状句；面板下次弹出时清掉
  const [restartNote, setRestartNote] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await api.gatewayState();
      if (mounted.current) setState(next);
    } catch (error) {
      void failOver(error);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // 每次弹出都重读：主窗口、命令行、别的程序都可能改过状态（R8）
    const pending = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      setConfirmingRestart(false);
      setRestartNote(null);
      void refresh();
    });
    return () => {
      mounted.current = false;
      void pending.then((un) => un());
    };
  }, [refresh]);

  const toggle = async (on: boolean) => {
    setBusy(on ? "正在停用…" : "正在启用…");
    try {
      const next = on ? await api.gatewayRestore() : await api.gatewayEnable();
      if (mounted.current) setState(next);
      void emit("gateway-changed");
    } catch (error) {
      void failOver(error);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const restartCodex = async () => {
    setConfirmingRestart(false);
    setBusy("正在结束 Codex 的后台进程…");
    try {
      const result = await api.gatewayRestartCodex();
      if (!mounted.current) return;
      setRestartNote(
        result.terminated > 0
          ? `结束了 ${result.terminated} 个 Codex 进程，下次启动就是新配置`
          : "Codex 现在没在跑，下次启动就是新配置",
      );
      await refresh();
      void emit("gateway-changed");
    } catch (error) {
      void failOver(error);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  // 浮层点外面或 Esc 关（DESIGN「什么时候才有按钮」）。确认行开着时 Esc 先收回那一问
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirmingRestart) setConfirmingRestart(false);
      else void api.trayHide();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirmingRestart]);

  // 面板高度跟着内容走：不同状态下行数不一样（要不要「去配置」、确认行高一点）
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

  return (
    <div className="tray" ref={rootRef}>
      {state && row?.visible ? (
        <section className="tray__agent">
          <div className="tray__identity">
            <div className="tray__name">
              <AgentIcon id="codex" name="Codex" />
              <span>Codex</span>
            </div>
            <Busy busy={busy !== null} className="tray__switch">
              {row.toggle.disabledReason !== null ? (
                <Button size="compact" disabled disabledReason={row.toggle.disabledReason}>
                  {row.toggle.label}
                </Button>
              ) : (
                <Button
                  size="compact"
                  // 反色＝现在开着（DESIGN「Do」）
                  variant={row.toggle.on ? "inverse" : "default"}
                  title={
                    row.toggle.on
                      ? "点一下停用：Codex 的模型列表只保留官方模型"
                      : "点一下启用：选好的模型进 Codex 的模型列表"
                  }
                  onClick={() => void toggle(row.toggle.on)}
                >
                  {row.toggle.label}
                </Button>
              )}
            </Busy>
          </div>
          {/* 重启完那一行就没了，结果说在这里；面板下次弹出时清掉 */}
          <p className="tray__status">{busy ?? restartNote ?? row.status}</p>
          <p className="tray__facts">{factsLine(state)}</p>
          {row.needsSetup ? (
            <Button variant="link" onClick={() => void api.trayOpenMain("models", null)}>
              去「模型」页配置
            </Button>
          ) : null}
        </section>
      ) : null}

      <ul className="tray__menu">
        {row?.visible && row.showRestart ? (
          <li>
            {confirmingRestart ? (
              // 确认一道，就在这一行上：一句后果 + 紧凑 pill（R4）
              <div className="tray__confirm">
                <span>{RESTART_CONSEQUENCE}</span>
                <span className="tray__confirm-actions">
                  <Button size="compact" onClick={() => void restartCodex()}>
                    重启
                  </Button>
                  <Button variant="link" onClick={() => setConfirmingRestart(false)}>
                    取消
                  </Button>
                </span>
              </div>
            ) : (
              <button
                type="button"
                className="tray__item"
                disabled={busy !== null}
                onClick={() => {
                  setRestartNote(null);
                  setConfirmingRestart(true);
                }}
              >
                重启 Codex
              </button>
            )}
          </li>
        ) : null}
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
      </ul>

      <ul className="tray__menu tray__menu--last">
        <li>
          <button
            type="button"
            className="tray__item"
            title="退出应用。模型注入由系统后台服务维持，不受影响"
            onClick={() => void api.trayQuit()}
          >
            退出
          </button>
        </li>
      </ul>
    </div>
  );
}
