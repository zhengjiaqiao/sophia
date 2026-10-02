/// 装完之后右下那一窗（R9 R10 R11）：推入页滑回之后由调用方挂上——`✓ 已安装 pdf` + `撤销`、
/// `✓ 已写进 [图标…] brave-search` + `撤销`。撤销只给「没有顺手反操作」的事，装新东西正是（⑬）。
/// 文案由 installView 的 `skillInstalledToast` / `mcpInstalledToast` 造（推入页的 `onDone` 已经带过来）
import { useState } from "react";
import { t } from "../i18n.ts";
import { CornerToast, Toast } from "../ui/index.ts";
import type { ToastText } from "../toastText.ts";
import type { McpUndoReport, SyncReport } from "../types.ts";
import { errorText, marketService, type MarketService } from "./service.ts";

/// 推入页交给调用方的：那一窗的文案 + 撤销用的 id + 撤的是哪一种
export interface InstalledNotice {
  kind: "skill" | "mcp";
  toast: ToastText;
  undoId: string | null;
}

export function InstalledToast({
  notice,
  onDismiss,
  onUndone,
  service = marketService,
}: {
  notice: InstalledNotice;
  onDismiss: () => void;
  /// 撤销做完（结果交给调用方重扫、再说一句）；撤不了的原因也经它回去
  onUndone?: (result: { report: SyncReport | McpUndoReport | null; error: string | null }) => void;
  service?: MarketService;
}) {
  const [undoing, setUndoing] = useState(false);
  const { toast, undoId } = notice;
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
