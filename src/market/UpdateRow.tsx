import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "../i18n.ts";
import { BusySlot, Button, FloatingToast, Toast } from "../ui/index.ts";
import type { UpdateInfo } from "../types.ts";
import { drawerLine, updateMark as updateMarkText } from "./updateView.ts";
import "./Update.css";

/// 行上名字后的灰字 `有更新`（DESIGN「发现与安装 › 有更新」「位置页 › 表格」）：12 `ink-mute`，不是键；
/// 提示条关掉后仍在。作表格行的 `mark`（与 `×2` 并排时由页面拼：`<>{dup}<UpdateMark /></>`）。
/// 点它与点名字一样拉开抽屉（`Matrix` 的 `mx-mark` 已经这么接），单个更新在抽屉末行
export function UpdateMark() {
  return <span className="update-mark">{updateMarkText()}</span>;
}

/// 有新版本时 `mark` 挂什么：没有就是 undefined（不占位）
export function updateMark(info: UpdateInfo | undefined) {
  return info ? <UpdateMark /> : undefined;
}

export interface UpdateDrawerLineProps {
  info: UpdateInfo;
  onUpdate: () => void;
  /// `更新` 在等：原位 `正在更新`
  busy?: boolean;
  /// 在这里按下之后要说的一句（`GitHub 暂时限流，稍后再试`），浮在这一行下
  notice?: string | null;
  noticeAt?: number;
  onNoticeDone?: () => void;
}

/// 行抽屉的末行（DESIGN「位置页 › 表格」skill 抽屉）：`来自 anthropics/skills · 有新版本` + `更新`（默认键紧凑）
/// + `看改动 ↗`（浅键，打开这个文件夹在 GitHub 上的提交记录）。放在 `SkillDetail` 的最后。
/// 接法（T11）：`<UpdateDrawerLine info={u} onUpdate={() => s.updateOne(u)} busy={s.busy === rowTrigger(u)}
/// notice={s.noticeFor(rowTrigger(u))} noticeAt={s.notice?.at} onNoticeDone={s.clearNotice} />`
export function UpdateDrawerLine({
  info,
  onUpdate,
  busy = false,
  notice = null,
  noticeAt,
  onNoticeDone,
}: UpdateDrawerLineProps) {
  const line = drawerLine(info);
  return (
    <div className="update-line">
      <span className="update-line__text">
        {line.from}
        <span className="update-line__sep">·</span>
        {t("market.update.hasNew")}
      </span>
      {/* 更新不成的一句锚在被按的 `更新` 这颗键下（2026-09-30：原来锚在整行、左对齐，离键远） */}
      <span className="update-line__key">
        <BusySlot busy={busy} label={t("market.busy.updating")}>
          <Button
            size="compact"
            onClick={onUpdate}
            ariaLabel={t("market.update.ariaUpdate", { name: info.name })}
          >
            {t("market.update.action")}
          </Button>
        </BusySlot>
        {notice !== null ? (
          <FloatingToast key={noticeAt} align="start">
            <Toast kind="cannot" message={notice} onDismiss={onNoticeDone} />
          </FloatingToast>
        ) : null}
      </span>
      <Button variant="quiet" onClick={() => void openUrl(line.url)} title={line.url}>
        {t("market.update.viewChanges")}
      </Button>
    </div>
  );
}
