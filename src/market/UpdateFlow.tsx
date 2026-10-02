import { t } from "../i18n.ts";
import { Confirm, CornerToast, Mono, Toast, ToastCount } from "../ui/index.ts";
import type { UpdateInfo } from "../types.ts";
import type { UpdateToastModel } from "./updateView.ts";
import { confirmModel } from "./updateView.ts";
import type { SkillUpdates } from "./useSkillUpdates.ts";
import "./Update.css";

/// 更新 skill 且有本地改动时的确认（DESIGN「发现与安装 › 有更新」「哪些要确认」）：窗口正中 `Confirm`。
/// 标题 `更新 2 个 skill？`（单个 `更新 pdf？`）；正文说清哪个改过、哪个没改；下面列出改过的文件
/// （`recess` 底 `mono`，多了框内滚）；`取消` 是默认键，墨键 `全部更新`（单个 `更新`）。
export interface UpdateConfirmProps {
  targets: UpdateInfo[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function UpdateConfirm({ targets, onConfirm, onCancel }: UpdateConfirmProps) {
  const m = confirmModel(targets);
  return (
    <Confirm
      title={m.title}
      confirmLabel={m.confirmLabel}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p className="update-confirm__body">{m.body}</p>
      {m.files.length > 0 ? (
        <ul className="update-confirm__files" aria-label={t("market.update.changedFiles")}>
          {m.files.map((f) => (
            // 路径可拖选（D23）；字号颜色随清单
            <li key={f}>
              <Mono inherit>{f}</Mono>
            </li>
          ))}
        </ul>
      ) : null}
    </Confirm>
  );
}

/// 更新之后右下那一窗：`✓ 已更新 2 个 skill` + `撤销`；做不成 / 部分成带原因
export function UpdateResultToast({
  toast,
  onUndo,
  undoing = false,
  onDismiss,
}: {
  toast: UpdateToastModel;
  onUndo?: () => void;
  undoing?: boolean;
  onDismiss: () => void;
}) {
  return (
    <Toast
      kind={toast.kind}
      sentence={toast.sentence}
      names={toast.names}
      reading={
        toast.count !== undefined ? (
          <ToastCount n={toast.count} line="market.update.count" />
        ) : undefined
      }
      tally={toast.tally}
      reason={toast.reason}
      action={
        onUndo
          ? {
              label: t("market.action.undo"),
              onClick: onUndo,
              busy: undoing ? t("market.busy.undoing") : undefined,
            }
          : undefined
      }
      onDismiss={undoing ? undefined : onDismiss}
    />
  );
}

/// 页面挂一处：确认框（有本地改动时）与更新之后右下的纸窗。状态全在 `useSkillUpdates` 里
export function UpdateFlow({ updates }: { updates: SkillUpdates }) {
  const { confirm, result } = updates;
  return (
    <>
      {confirm ? (
        <UpdateConfirm
          targets={confirm.targets}
          onConfirm={updates.confirmUpdate}
          onCancel={updates.cancelUpdate}
        />
      ) : null}
      {result ? (
        <CornerToast>
          <UpdateResultToast
            key={result.at}
            toast={result.toast}
            onUndo={updates.undo ?? undefined}
            undoing={updates.undoing}
            onDismiss={updates.clearResult}
          />
        </CornerToast>
      ) : null}
    </>
  );
}
