/// 写进或改写进要点「信任」的 agent（WorkBuddy）之后右下那一窗（#256，画板「国产 agent 与国内网络」第 6 屏）：
/// 主句 `已加到 WorkBuddy，还要在 WorkBuddy 里点一下「信任」才会连上`，第二行在它里面去哪点，浅键 `打开 WorkBuddy ↗`。
/// 要用户离开 Sophia 去做一步，停留比例行成功长（同部分失败），带 ×。文案由 `mcpTrust.ts` 造
import { api } from "./api.ts";
import { t } from "./i18n.ts";
import type { TrustNotice } from "./mcpTrust.ts";
import { CornerToast, Toast, TOAST_DWELL_MS } from "./ui/index.ts";

export function McpTrustToast({
  notice,
  onDismiss,
  onError,
}: {
  notice: TrustNotice;
  onDismiss: () => void;
  /// 打不开（没装、被挪走）：原话交给页面的出错处
  onError: (message: string) => void;
}) {
  return (
    <CornerToast>
      <Toast
        kind="success"
        message={notice.sentence}
        trail={[notice.where]}
        secondary={{
          label: t("mcp.trust.open", { app: notice.app }),
          onClick: () => void api.mcpOpenTrustApp(notice.agentId).catch((e) => onError(String(e))),
        }}
        dwellMs={TOAST_DWELL_MS.partial}
        onDismiss={onDismiss}
        onClose={onDismiss}
      />
    </CornerToast>
  );
}
