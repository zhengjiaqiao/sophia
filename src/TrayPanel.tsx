import { useCallback, useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import { RESTART_DONE_MS, RESTART_STILL_STALE, parseBackendError } from "./modelsView";
import { RESTART_CONSEQUENCE, RESTART_TIP, trayRow } from "./trayView";
import type { GatewayState } from "./types";
import { AgentIcon, Button, Spinner, Switch, Toast, Tooltip } from "./ui";
import "./TrayPanel.css";

/// 菜单栏面板（DESIGN「托盘面板」，画板 Tray）。
///
/// 与模型页同一行的缩小版：`16px 图标 + Codex + 开关`，没有状态句。改动等着生效时开关后 12
/// 出紧凑键 `重启生效`（按钮即状态），确认在面板里当场展开；重启中 = 14px 细弧 +
/// 「正在重启 Codex」，成功 = `✓ 已生效` 约 4 秒淡出，失败 = 黑块 + 原因 + `再试一次`。
/// 菜单三项 `打开 Sophia` `设置` `退出`，悬停 `surface` 底。与主窗口共用 tokens 与组件。
///
/// - 开关做不成：把主窗口带到「模型」页，由那里说原因——面板放不下一段解释
/// - 面板改了状态就广播 `gateway-changed`，主窗口的「模型」页跟着刷新

/// 面板里的动作做不成：主窗口到前面、切到「模型」页、把原话带过去
const failOver = (error: unknown) =>
  api.trayOpenMain("models", parseBackendError(String(error)).message);

type Restart =
  { kind: "idle" } | { kind: "confirming" } | { kind: "restarting" } | { kind: "done" };

export default function TrayPanel() {
  const [state, setState] = useState<GatewayState | null>(null);
  const [busy, setBusy] = useState(false);
  const [restart, setRestart] = useState<Restart>({ kind: "idle" });
  /// 重启没成的原因（黑块）；面板下次弹出时清掉
  const [failure, setFailure] = useState<string | null>(null);
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
    // 每次弹出都重读：主窗口、命令行、别的程序都可能改过状态；外部重启了 Codex，键要自己消失
    const pending = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      setRestart((r) => (r.kind === "restarting" ? r : { kind: "idle" }));
      setFailure(null);
      void refresh();
    });
    return () => {
      mounted.current = false;
      void pending.then((un) => un());
    };
  }, [refresh]);

  // ✓ 已生效约 4 秒后淡出（淡出在 css 末尾 120ms）
  useEffect(() => {
    if (restart.kind !== "done") return;
    const timer = setTimeout(() => setRestart({ kind: "idle" }), RESTART_DONE_MS);
    return () => clearTimeout(timer);
  }, [restart]);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      const fresh = next ? await api.gatewayEnable() : await api.gatewayRestore();
      if (mounted.current) setState(fresh);
      void emit("gateway-changed");
    } catch (error) {
      void failOver(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const restartCodex = async () => {
    setFailure(null);
    setRestart({ kind: "restarting" });
    setBusy(true);
    let reason: string | null = null;
    try {
      await api.gatewayRestartCodex();
      const fresh = await api.gatewayState();
      if (mounted.current) setState(fresh);
      if (fresh.needsCodexRestart) reason = RESTART_STILL_STALE;
      void emit("gateway-changed");
    } catch (error) {
      reason = parseBackendError(String(error)).message;
    } finally {
      if (mounted.current) setBusy(false);
    }
    if (!mounted.current) return;
    setFailure(reason);
    setRestart(reason === null ? { kind: "done" } : { kind: "idle" });
  };

  // Esc：确认开着先收回那一问，否则收起面板
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (restart.kind === "confirming") setRestart({ kind: "idle" });
      else void api.trayHide();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [restart]);

  // 面板高度跟着内容走：确认、黑块展开时高一点
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

  const restartSlot = () => {
    if (restart.kind === "restarting") {
      return (
        <span className="tray__restart" role="status">
          <Spinner size={14} label="正在重启 Codex" />
          <span className="tray__restart-text">正在重启 Codex</span>
        </span>
      );
    }
    if (restart.kind === "done") {
      return (
        <span className="tray__restart tray__restart--done">
          <Toast tier="routine" kind="success" verb="已生效" />
        </span>
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
                setFailure(null);
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
    <div className="tray" ref={rootRef}>
      {state && row?.visible ? (
        <section className="tray__agent">
          <div className="tray__row">
            <AgentIcon id="codex" name="Codex" size={16} />
            <span className="tray__name">Codex</span>
            {row.toggle.disabledReason !== null ? (
              <Switch
                checked={false}
                onChange={() => undefined}
                label="启用 Codex 的第三方模型"
                disabledReason={row.toggle.disabledReason}
              />
            ) : (
              <Tooltip
                content={row.toggle.on ? "关掉：Codex 只剩官方模型" : "打开：选好的模型进 Codex"}
                placement="bottom"
              >
                <Switch
                  checked={row.toggle.on}
                  onChange={(next) => void toggle(next)}
                  label="启用 Codex 的第三方模型"
                  disabledReason={busy ? "正在处理上一步" : undefined}
                />
              </Tooltip>
            )}
            {restartSlot()}
          </div>
          {restart.kind === "confirming" ? (
            // 确认在面板里当场展开：标题 + 一句后果 + 取消（文字链）+ 重启（主动作）
            <div className="tray__confirm" role="dialog" aria-label="重启 Codex？">
              <div className="tray__confirm-title">重启 Codex？</div>
              <div className="tray__confirm-body">{RESTART_CONSEQUENCE}</div>
              <div className="tray__confirm-foot">
                <Button variant="link" onClick={() => setRestart({ kind: "idle" })}>
                  取消
                </Button>
                <Button variant="primary" size="compact" onClick={() => void restartCodex()}>
                  重启
                </Button>
              </div>
            </div>
          ) : null}
          {failure !== null && restart.kind === "idle" ? (
            <div className="tray__notice">
              <Toast
                kind="cannot"
                verb="没重启"
                agents={[{ id: "codex", name: "Codex" }]}
                names={["Codex"]}
                reason={failure}
                action={{ label: "再试一次", onClick: () => void restartCodex() }}
                onClose={() => setFailure(null)}
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
