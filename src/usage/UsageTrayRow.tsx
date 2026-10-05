import type { TrayRowProps } from "../shell/agentRegistry.ts";
import { UsageWindows, useUsageRetry } from "./UsageWindows.tsx";
import { trayUsageOf } from "./usageView.ts";

/// 托盘面板里「用量」（spec 2026-09-26-menubar-usage R10；DESIGN「托盘面板」）：agent 注册表里用量一节的
/// `trayRow`，面板按注册表把它排进每个 agent 块、第三方模型那一行之前。外框样式在 TrayPanel.css，
/// 各窗口的画法与用量页「当前用量」共用（UsageWindows）。这个 agent 没登录（用量视图里没有它）就不画——
/// 同一块里的第三方模型照旧。「N 分钟前更新」在块头名字后（注册表的 `headNote`）。
/// 原因行右端的「再试一次」跑完先经面板重读用量视图，再收回「正在读取」
export function UsageTrayRow({ agent, state, tray }: TrayRowProps) {
  const usage = trayUsageOf(state, agent);
  const { retry, retrying } = useUsageRetry(tray.rereadUsage);
  if (!usage) return null;
  return (
    <div className="tray__usage">
      <UsageWindows
        usage={usage}
        stacked
        retrying={retrying(usage.agent)}
        onRetry={() => void retry(usage.agent)}
      />
    </div>
  );
}
