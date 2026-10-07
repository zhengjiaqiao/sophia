/// 用量演示的标记：Astro 出静态默认态（关 JS 也在），客户端脚本改设置时重画，两边共用这一份。
/// 文案由调用方传（服务端用 t 取好，放进 data 属性），这里只拼标记并转义。
import { fillTemplate } from "../lib/template.ts";
import { AGENT_ICONS } from "./usageIcons.ts";
import type { Agent, ResetKey, UsageView, WindowId } from "./usage.ts";

export interface UsageLabels {
  /** 两家都没选时面板里的一句 */
  none: string;
  /** 「剩 [[pct]]」 */
  left: string;
  /** 「用 [[pct]]」 */
  usedPct: string;
  windows: Record<WindowId, string>;
  resets: Record<ResetKey, string>;
  agents: Record<Agent, string>;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/// 菜单栏里 Sophia 图标后面的分段：每家一段（标志 + 数字，叠放时两行）
export function renderTray(view: UsageView): string {
  return view.tray
    .map((seg) => {
      const num =
        seg.values.length > 1
          ? `<b class="stk">${seg.values.map((v) => `<span>${esc(v)}</span>`).join("")}</b>`
          : `<b>${esc(seg.values[0])}</b>`;
      return `<span class="tseg">${AGENT_ICONS[seg.agent]}${num}</span>`;
    })
    .join("");
}

/// 展开的面板：只列选中的几家；每行 窗口名 + 剩/用 + 条 + 重置时间
export function renderPanel(view: UsageView, labels: UsageLabels): string {
  if (view.empty) return `<p class="drop__none">${esc(labels.none)}</p>`;
  return view.panel
    .map((sec) => {
      const head = `<h6><span>${esc(labels.agents[sec.agent])}</span><span>${esc(sec.plan)}</span></h6>`;
      const rows = sec.rows
        .map((r) => {
          const tpl = r.kind === "left" ? labels.left : labels.usedPct;
          return (
            `<div class="meter"><div><span>${esc(labels.windows[r.window])}</span>` +
            `<span>${esc(fillTemplate(tpl, { pct: r.value }))}</span></div>` +
            `<span class="bar"><i style="transform:scaleX(${r.fill})"></i></span>` +
            `<small>${esc(labels.resets[r.reset])}</small></div>`
          );
        })
        .join("");
      return head + rows;
    })
    .join("<hr>");
}
