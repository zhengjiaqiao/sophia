import { useCallback, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api.ts";
import { copyDetails } from "../diagnostics.ts";
import { t } from "../i18n.ts";
import type { ConnectAction, TrayUsage, UsageAgentId } from "../types.ts";
import { BusySlot, Button, Confirm, Details, Spinner, TruncTip } from "../ui/index.ts";
import { usageNoteAction } from "./usageView.ts";
import "./UsageWindows.css";

/// 原因行上「连接 Claude 用量」的几个动作（`useClaudeConnect` 给）：不给就只写句子、不出键
export interface ConnectHandlers {
  /// 点「连接 Claude 用量」或失败后的「再试一次」
  start: () => void;
  /// 点了、后端还没回话：键锁住（过了忙碌门槛换刻度）
  starting: boolean;
  /// 等授权时的「取消」
  cancel: () => void;
  /// 「没看到授权页 · 再打开 ↗」
  reopen: () => void;
}

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
  connect,
}: {
  usage: TrayUsage;
  stacked?: boolean;
  /// 这个 agent 的「再试一次」正在跑
  retrying?: boolean;
  /// 不给就只写原因、不出键
  onRetry?: () => void;
  /// 「连接 Claude 用量」的动作（只 Claude 有 `usage.connect`）；不给就只写句子
  connect?: ConnectHandlers;
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
      {usage.note && usage.connect && connect ? (
        <ConnectRow note={usage.note} action={usage.connect} handlers={connect} />
      ) : usage.note && action !== null ? (
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

/// 原因行上的「连接 Claude 用量」（票 #208，画板 #206 第 2 版 3–12）：句子是后端算好的 `note`，这里按进行到哪
/// 换右端那一处——给键 / 原位忙碌「正在安装 Claude Code」/ 句首刻度 + 右端「取消」（下一句「没看到授权页 · 再打开 ↗」）/
/// 授权后取首轮用量时原位忙碌「正在读取」（不可取消）/
/// 失败的原因（技术原文挂在句首「!」上，网络失败另带一句 PAC 的说明）+ 句后「手动安装 ↗」+ 右端「再试一次」
function ConnectRow({
  note,
  action,
  handlers,
}: {
  note: string;
  action: ConnectAction;
  handlers: ConnectHandlers;
}) {
  const key = (label: string) => (
    // 点了、后端还没回话（一般一瞬间）：键锁住、变淡，不换字（这时还不知道要不要装）
    <BusySlot busy={handlers.starting} label={label} mode="dim">
      <Button size="compact" onClick={handlers.start}>
        {label}
      </Button>
    </BusySlot>
  );
  switch (action.kind) {
    case "offer":
      return (
        <p className="usage-note usage-note--retry">
          <span className="usage-note__text">{note}</span>
          {key(t("usage.connect.action"))}
        </p>
      );
    case "installing":
      return (
        <p className="usage-note usage-note--retry">
          <span className="usage-note__text">{note}</span>
          <BusySlot busy label={t("usage.connect.installing")}>
            <Button size="compact">{t("usage.connect.action")}</Button>
          </BusySlot>
        </p>
      );
    case "waiting":
      return (
        <>
          <p className="usage-note usage-note--retry">
            {/* 要等的是人：句首刻度 + 去哪做什么，`取消` 不受忙碌锁 */}
            <span className="usage-note__text usage-note__wait" role="status">
              {/* 读屏读紧挨着的那句可见文字一遍就够：刻度藏起来，不再带同一句 */}
              <span aria-hidden="true">
                <Spinner size={14} label={note} />
              </span>
              <span>{note}</span>
            </span>
            <Button size="compact" onClick={handlers.cancel}>
              {t("common.cancel")}
            </Button>
          </p>
          {action.reopen ? (
            <p className="usage-note">
              {t("usage.connect.noPage")} ·{"\u00a0"}
              <Button variant="quiet" inline onClick={handlers.reopen}>
                {t("usage.connect.reopen")}
              </Button>
            </p>
          ) : null}
        </>
      );
    case "finishing":
      // 授权完成、在取首轮用量（后端最多等 60 秒）：同「正在安装」键原位锁住，不给「取消」
      return (
        <p className="usage-note usage-note--retry">
          <span className="usage-note__text">{note}</span>
          <BusySlot busy label={t("usage.retrying")}>
            <Button size="compact">{t("usage.connect.action")}</Button>
          </BusySlot>
        </p>
      );
    case "failed": {
      const manual = action.manualInstall;
      return (
        <p className="usage-note usage-note--retry">
          <span className="usage-note__text">
            {action.detail ? (
              <span className="usage-note__mark">
                <Details size="row" text={action.detail} onCopy={(raw) => copyDetails(raw)} />
              </span>
            ) : null}
            {note}
            {manual ? (
              <>
                {" ·\u00a0"}
                <Button
                  variant="quiet"
                  inline
                  onClick={() => void openUrl(manual).catch(() => undefined)}
                >
                  {t("usage.connect.manual")}
                </Button>
              </>
            ) : null}
          </span>
          {key(t("usage.retry"))}
        </p>
      );
    }
  }
}

/// 「安装 Claude Code？」（只在找不到 Claude Code、要装时问）：托盘里是窄面板（在原因行下当场展开），
/// 用量页是居中确认框。焦点默认在 `取消`
export function ConnectConfirm({
  inline = false,
  onConfirm,
  onCancel,
}: {
  inline?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Confirm
      inline={inline}
      id={inline ? "claude-connect-confirm" : undefined}
      title={t("usage.connect.confirmTitle")}
      confirmLabel={t("usage.connect.confirmAction")}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {t("usage.connect.confirmBody")}
    </Confirm>
  );
}

/// 「连接 Claude 用量」的界面一侧（托盘的用量行、用量页共用）：点了先问后端；找不到 Claude Code 就先问一句
/// （`confirming`），确认后带「可以安装」再问。过程的每一步经 `usage-changed` 送达，这里只在后端回话后重读一次，
/// 免得等事件；点了还没回话时键锁着（`starting`），连点不起第二个
export function useClaudeConnect(reread: () => Promise<void>, onError?: (message: string) => void) {
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const inFlight = useRef(false);
  const run = useCallback(
    async (allowInstall: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setStarting(true);
      try {
        const result = await api.usageConnect(allowInstall);
        if (result === "needsInstall") setConfirming(true);
        await reread();
      } catch (error) {
        onError?.(String(error));
      } finally {
        inFlight.current = false;
        setStarting(false);
      }
    },
    [reread, onError],
  );
  const handlers: ConnectHandlers = {
    start: () => void run(false),
    starting,
    cancel: () => void api.usageConnectCancel().catch(() => undefined),
    reopen: () => void api.usageConnectReopen().catch(() => undefined),
  };
  return {
    handlers,
    confirming,
    confirm: () => {
      setConfirming(false);
      void run(true);
    },
    dismiss: useCallback(() => setConfirming(false), []),
  };
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
