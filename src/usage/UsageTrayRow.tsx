import { useEffect } from "react";
import type { TrayRowProps } from "../shell/agentRegistry.ts";
import { ConnectConfirm, UsageWindows, useClaudeConnect, useUsageRetry } from "./UsageWindows.tsx";
import { trayUsageOf } from "./usageView.ts";

/// 托盘面板里「用量」（spec 2026-09-26-menubar-usage R10；DESIGN「托盘面板」）：agent 注册表里用量一节的
/// `trayRow`，面板按注册表把它排进每个 agent 块、第三方模型那一行之前。外框样式在 TrayPanel.css，
/// 各窗口的画法与用量页「当前用量」共用（UsageWindows）。这个 agent 没登录（用量视图里没有它）就不画——
/// 同一块里的第三方模型照旧。「N 分钟前更新」在块头名字后（注册表的 `headNote`）。
/// 原因行右端的「再试一次」跑完先经面板重读用量视图，再收回「正在读取」。
/// Claude 命令行不可用时原因行右端是「连接 Claude 用量」（票 #208）；要安装时「安装 Claude Code？」在这一行下
/// 当场展开（窄面板形态），面板重新弹出时收回没答的那一问
export function UsageTrayRow({ agent, state, tray }: TrayRowProps) {
  const usage = trayUsageOf(state, agent);
  const { retry, retrying } = useUsageRetry(tray.rereadUsage);
  // 托盘里点不成（命令本身失败）不另外报：原因行照旧，再点一次即可
  const connect = useClaudeConnect(tray.rereadUsage);
  const dismissConnect = connect.dismiss;
  useEffect(() => dismissConnect(), [tray.openedAt, dismissConnect]);
  if (!usage) return null;
  return (
    <>
      <div className="tray__usage">
        <UsageWindows
          usage={usage}
          stacked
          retrying={retrying(usage.agent)}
          onRetry={() => void retry(usage.agent)}
          connect={connect.handlers}
        />
      </div>
      {/* 同能力行下的确认（`重启 Claude？`）：贴着这一行展开、占满块宽 */}
      {usage.connect && connect.confirming ? (
        <div className="tray__confirm">
          <ConnectConfirm inline onConfirm={connect.confirm} onCancel={connect.dismiss} />
        </div>
      ) : null}
    </>
  );
}
