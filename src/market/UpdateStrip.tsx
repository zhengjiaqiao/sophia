import { t } from "../i18n.ts";
import { FloatingToast, NoticePanel, Toast } from "../ui/index.ts";
import { onlyTheseLabel, stripSentence } from "./updateView.ts";

/// 有更新的一次性提示条（DESIGN「发现与安装 › 有更新」，画板 01 / 11）：筛选行下，灰面板的一次性说明用法
/// （`NoticePanel` 没有 `!`、能关、能进出，上下各 16、宽 776），两颗紧凑默认键：`2 个 skill 有新版本` · `只看这些` · `全部更新` · ×。
///
/// - `只看这些` 让表格只列这些行，键换成 `显示全部`（过滤由页面做，这里只报按下）
/// - × ＝这一批不再提（`useSkillUpdates().dismiss`：记下此刻各个新版本的 tree SHA）；之后出了不同的版本才再出
/// - `全部更新` 在等时原位 `正在更新`；被限流 / 做不成时 `notice` 浮在条下右端（在触发处说，不弹窗、不重试）
/// - 与失效链接那一句同时在时，失效链接在上（页面排）
///
/// 接法（T11）：
/// ```tsx
/// const u = useSkillUpdates({ active: true, onFilesChanged: rescan });
/// const scoped = scopeUpdates(u.updates, scope);
/// <UpdateStrip
///   open={stripOpen(u.stripVisible, scoped)}
///   count={scoped.length}
///   onlyThese={u.onlyThese}
///   onToggleOnly={() => u.setOnlyThese(!u.onlyThese)}
///   onUpdateAll={() => u.updateAll(scoped)}
///   onDismiss={u.dismiss}
///   busy={u.busy === "strip"}
///   notice={u.noticeFor("strip")}
///   noticeAt={u.notice?.at}
///   onNoticeDone={u.clearNotice}
/// />
/// ```
export interface UpdateStripProps {
  open: boolean;
  /// 当前位置里有新版本的 skill 数
  count: number;
  /// 表格此刻只列这些行
  onlyThese: boolean;
  onToggleOnly: () => void;
  onUpdateAll: () => void;
  /// 按 ×
  onDismiss: () => void;
  /// `全部更新` 在等
  busy?: boolean;
  /// 在这里按下之后要说的一句（`GitHub 暂时限流，稍后再试`）
  notice?: string | null;
  /// 这一句是哪一刻出的：换了就从头计时
  noticeAt?: number;
  onNoticeDone?: () => void;
  /// 上方的间距归宿主（紧跟位置页的筛选行时）
  flush?: boolean;
  /// 下面还压着几张提示条（叠放，见 NoticePanel `useHintStack`）
  stacked?: number;
}

export function UpdateStrip({
  open,
  count,
  onlyThese,
  onToggleOnly,
  onUpdateAll,
  onDismiss,
  busy = false,
  notice = null,
  noticeAt,
  onNoticeDone,
  flush = false,
  stacked = 0,
}: UpdateStripProps) {
  // 不另包一层：宿主据灰面板根上的 `data-hint="open"` 写 `:has(> …)` 让间距（`flush`），多包一层就认不到了。
  // 更新不成的那一句锚在被按的 `全部更新` 这颗键下（灰面板键的公开钩子 data-hint-action；2026-09-30：原来锚在整条、
  // 右对齐到 ×）；键不在了（提示条收起）就落在提示条上
  return (
    <>
      <NoticePanel
        scope="section"
        mark={false}
        open={open}
        onClose={onDismiss}
        flush={flush}
        stacked={stacked}
        dismissTitle={t("market.update.dismiss")}
        action={{ label: onlyTheseLabel(onlyThese), onClick: onToggleOnly }}
        secondary={{
          label: t("market.update.updateAll"),
          onClick: onUpdateAll,
          busy: busy ? t("market.busy.updating") : undefined,
        }}
        message={stripSentence(count)}
      />
      {notice !== null && open ? (
        <FloatingToast
          key={noticeAt}
          align="end"
          anchor={(probe) =>
            probe.previousElementSibling?.querySelector(
              `[data-hint-action="${t("market.update.updateAll")}"]`,
            ) ?? probe.previousElementSibling
          }
        >
          <Toast kind="cannot" message={notice} onDismiss={onNoticeDone} />
        </FloatingToast>
      ) : null}
    </>
  );
}
