import type { TrayUsage } from "../types.ts";
import { TruncTip } from "../ui/index.ts";
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
export function UsageWindows({ usage, stacked = false }: { usage: TrayUsage; stacked?: boolean }) {
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
      {usage.note ? <p className="usage-note">{usage.note}</p> : null}
    </>
  );
}
