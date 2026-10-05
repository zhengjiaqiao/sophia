import { useCallback, useRef, useState } from "react";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import type { TrayUsage, UsageAgentId } from "../types.ts";
import { BusySlot, Button, TruncTip } from "../ui/index.ts";
import { usageNoteAction } from "./usageView.ts";
import "./UsageWindows.css";

/// 一个 agent 的各窗口与一句状态（spec 2026-09-26-menubar-usage R7 R10）：托盘面板的用量行与用量页的「当前用量」
/// 共用同一种画法，文字都是后端算好的（`TrayUsage`）。一个窗口一行、三列对齐：窗口名 ｜ 条（与文字同一刻度）｜
/// 「剩 72%」+「 · 5 天后重置」；服务端判为紧张的窗口名与百分比加粗（不用红、不用橙）。取不到新数、被限流、
/// 没有订阅额度、还没有读数时，下面一行灰字说原因。没有窗口就不画空的一排。
///
/// `stacked`（托盘，2026-09-30 系统菜单风格）：每个窗口两行——上一行窗口名 ……… 读数，下一行满宽进度条，
/// 照系统菜单里用量条的排法。
///
/// 窗口名放不下时截断、悬停出全名（服务端给的模型窗口名没有长度上限，如 Codex「5 小时 · GPT-5.3-Codex-Spark」）；
/// 读数永远完整，不收窄
///
/// 原因行右端（2026-10-03）：原因是再试可能有用的（后端给 `usage.retry`）且给了 `onRetry` 时，一颗紧凑默认键
/// 「再试一次」（托盘里经变量钩子画成系统小按键，同 `重启生效`）；点了之后原位忙碌（BusySlot：键当即锁住，
/// 过了忙碌门槛换成刻度 +「正在读取」），跑完新数照常画上，还是取不到就原因行带着键回来
export function UsageWindows({
  usage,
  stacked = false,
  retrying = false,
  onRetry,
}: {
  usage: TrayUsage;
  stacked?: boolean;
  /// 这个 agent 的「再试一次」正在跑
  retrying?: boolean;
  /// 不给就只写原因、不出键
  onRetry?: () => void;
}) {
  const action = onRetry ? usageNoteAction(usage, retrying) : null;
  const text = (w: TrayUsage["windows"][number]) => (
    <span className="usage-win__text">
      <span className="usage-win__pct">{w.percentText}</span>
      {w.resetText ? (
        <>
          <span className="usage-win__sep"> · </span>
          <span className="usage-win__reset">{w.resetText}</span>
        </>
      ) : null}
    </span>
  );
  const bar = (w: TrayUsage["windows"][number]) => (
    <span className="usage-win__bar" aria-hidden="true">
      <i style={{ width: `${w.gaugePercent}%` }} />
    </span>
  );
  return (
    <>
      {usage.windows.length > 0 && stacked ? (
        <div className="usage-wins usage-wins--stacked">
          {usage.windows.map((w, i) => (
            <div key={`${w.label}:${i}`} className={`usage-win${w.emphasize ? " is-tight" : ""}`}>
              <span className="usage-win__line">
                <TruncTip content={w.label} fit="shrink">
                  <span className="usage-win__label">{w.label}</span>
                </TruncTip>
                {text(w)}
              </span>
              {bar(w)}
            </div>
          ))}
        </div>
      ) : usage.windows.length > 0 ? (
        <div className="usage-wins">
          {usage.windows.map((w, i) => (
            <div key={`${w.label}:${i}`} className={`usage-win${w.emphasize ? " is-tight" : ""}`}>
              <TruncTip content={w.label} fit="shrink">
                <span className="usage-win__label">{w.label}</span>
              </TruncTip>
              <span className="usage-win__bar" aria-hidden="true">
                <i style={{ width: `${w.gaugePercent}%` }} />
              </span>
              <span className="usage-win__text">
                <span className="usage-win__pct">{w.percentText}</span>
                {w.resetText ? (
                  <>
                    <span className="usage-win__sep"> · </span>
                    <span className="usage-win__reset">{w.resetText}</span>
                  </>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {usage.note && action !== null ? (
        <p className="usage-note usage-note--retry">
          <span className="usage-note__text">{usage.note}</span>
          <BusySlot busy={action === "retrying"} label={t("usage.retrying")}>
            <Button size="compact" onClick={onRetry}>
              {t("usage.retry")}
            </Button>
          </BusySlot>
        </p>
      ) : usage.note ? (
        <p className="usage-note">{usage.note}</p>
      ) : null}
    </>
  );
}

/// 「再试一次」的进行状态（托盘的用量行、用量页的「当前用量」共用）：点了先记下这个 agent 在读，
/// 后端这一轮跑完（`usage_refresh` 回话）、`reread` 把新视图画上之后再收回——先画新数再收「正在读取」，
/// 不闪回旧原因。正在读时再按不起作用（键锁着只挡指针，键盘回车也挡在这里）
export function useUsageRetry(reread: () => Promise<void>) {
  const [running, setRunning] = useState<ReadonlySet<UsageAgentId>>(() => new Set());
  const inFlight = useRef(new Set<UsageAgentId>());
  const retry = useCallback(
    async (agent: UsageAgentId) => {
      if (inFlight.current.has(agent)) return;
      inFlight.current.add(agent);
      setRunning(new Set(inFlight.current));
      try {
        await api.usageRefresh(agent);
        await reread();
      } catch {
        // 回话不了（调度没在跑）也收回：原因行带着键回来，下一次弹出或打开还会读
      } finally {
        inFlight.current.delete(agent);
        setRunning(new Set(inFlight.current));
      }
    },
    [reread],
  );
  const retrying = useCallback((agent: UsageAgentId) => running.has(agent), [running]);
  return { retry, retrying };
}
