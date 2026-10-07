/// 装完之后右下那一窗（R9 R10 R11）：推入页滑回之后由调用方挂上——`✓ 已安装 pdf` + `撤销`、
/// `✓ 已加到 [图标…] brave-search` + `撤销`。撤销只给「没有顺手反操作」的事，装新东西正是（⑬）。
/// 文案由 installView 的 `skillInstalledToast` / `mcpInstalledToast` 造（推入页的 `onDone` 已经带过来）。
/// 有 agent 没链上（那里已有同名的、建链接失败）时，「撤销」前多一颗「去处理」（issue #111）：
/// 带到 SKILLS · 我的 里那一行、拉开抽屉（去哪由 `skillHandleTarget` 算，怎么去归调用方）
import { useState } from "react";
import { t } from "../i18n.ts";
import { CornerToast, Toast } from "../ui/index.ts";
import type { ToastText } from "../toastText.ts";
import type { McpUndoReport, SyncReport } from "../types.ts";
import type { SkillHandle } from "./installView.ts";
import { errorText, marketService, type MarketService } from "./service.ts";

/// 推入页交给调用方的：那一窗的文案 + 撤销用的 id + 撤的是哪一种
export interface InstalledNotice {
  kind: "skill" | "mcp";
  toast: ToastText;
  undoId: string | null;
  /// 「去处理」去哪一行；没有「没链上」时为 null（MCP 一直没有）
  handle?: SkillHandle | null;
}

export function InstalledToast({
  notice,
  onDismiss,
  onUndone,
  onHandle,
  service = marketService,
}: {
  notice: InstalledNotice;
  onDismiss: () => void;
  /// 点了「去处理」：调用方切到那一行（这一窗随即收起）；不给就没有这颗键
  onHandle?: (target: SkillHandle) => void;
  /// 撤销做完（结果交给调用方重扫、再说一句）；撤不了的原因也经它回去
  onUndone?: (result: { report: SyncReport | McpUndoReport | null; error: string | null }) => void;
  service?: MarketService;
}) {
  const [undoing, setUndoing] = useState(false);
  const { toast, undoId, handle } = notice;
  const undo = async () => {
    if (!undoId || undoing) return;
    setUndoing(true);
    try {
      const report =
        notice.kind === "skill" ? await service.undoSkill(undoId) : await service.undoMcp(undoId);
      onUndone?.({ report, error: null });
    } catch (error) {
      onUndone?.({ report: null, error: errorText(error) });
    } finally {
      setUndoing(false);
      onDismiss();
    }
  };
  return (
    <CornerToast>
      <Toast
        {...toast}
        // 正在撤销时不给去处理：撤完那一行就没了
        go={
          handle && onHandle && !undoing
            ? {
                label: t("market.action.handle"),
                onClick: () => {
                  onHandle(handle);
                  onDismiss();
                },
              }
            : undefined
        }
        action={
          undoId
            ? {
                label: t("market.action.undo"),
                onClick: () => void undo(),
                busy: undoing ? t("market.busy.undoing") : undefined,
              }
            : undefined
        }
        onDismiss={onDismiss}
        onClose={toast.kind === "success" ? undefined : onDismiss}
      />
    </CornerToast>
  );
}
