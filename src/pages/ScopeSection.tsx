import type { ProjectScope } from "../types.ts";
import { t, tn } from "../i18n.ts";
import {
  Button,
  CheckRow,
  DrawerHandle,
  FloatingToast,
  IconPlus,
  Mono,
  Toast,
  Tooltip,
} from "../ui/index.ts";
import { scopeGroups } from "./scopeSettings.ts";
import { SettingRow } from "./SettingRow.tsx";

export interface ScopeSectionProps {
  /// 全部项目格（core 给的先后）；null＝还没读回来
  projects: ReadonlyArray<ProjectScope> | null;
  /// 这一程在上面取消勾的项目路径：格子留在原处（见 `scopeGroups`）
  kept: ReadonlySet<string>;
  /// 「不显示的 N 个」拉开没有
  open: boolean;
  onOpen: (open: boolean) => void;
  onToggle: (path: string, shown: boolean) => void;
  /// `+ 项目`：弹系统文件夹选择器
  onAdd: () => void;
  /// 刚取消勾的那一格：它正下方浮起一句说明，约 4 秒淡出
  unchecked: { path: string; at: number } | null;
  onDismissUnchecked: () => void;
  /// `+ 项目` 选的文件夹当不了项目（主目录、不是文件夹）：键下浮起原因
  addNotice: { message: string; at: number } | null;
  onDismissAddNotice: () => void;
}

/// 设置 `Skills 和 MCP` 一节的 `生效范围` 一块（spec 2026-10-05-skill-mcp-batch2「项目来源」；DESIGN「设置 › 生效范围」）：
/// SKILLS、MCP 页筛选行上那一排在这里管，**勾上的才出现在筛选行与「切换项目…」浮层里**。
/// 一块＝一条设置行（名字 `生效范围` + 灰字说用户级与项目从哪来，右端 `+ 项目`）连同下面的名单（2026-10-06 并节）。
/// 名单画法照 `显示的 agent`（三列 `CheckRow` grid），差两处：第一格用户级勾着且禁用；
/// 项目格没有图标，停上去提示框给路径。只有勾不勾一个动作——没有「移除」、不分手动还是自动；
/// 没勾的折进下面「不显示的 N 个 ›」（照「未安装的 N 个 ›」，拉手在字后），拉开能勾回来
export function ScopeSection({
  projects,
  kept,
  open,
  onOpen,
  onToggle,
  onAdd,
  unchecked,
  onDismissUnchecked,
  addNotice,
  onDismissAddNotice,
}: ScopeSectionProps) {
  const { grid, folded } = scopeGroups(projects ?? [], kept);
  const cell = (p: ProjectScope) => (
    <div key={p.path} className="settings-page__cell">
      <Tooltip
        fit="grow"
        placement="bottom"
        content={
          <Mono path inherit>
            {p.path}
          </Mono>
        }
      >
        <CheckRow
          size="grid"
          checked={p.shown}
          onChange={(next) => onToggle(p.path, next)}
          highlighted={unchecked?.path === p.path}
        >
          {p.name}
        </CheckRow>
      </Tooltip>
      {unchecked?.path === p.path ? (
        <FloatingToast key={unchecked.at} align="start">
          <Toast
            kind="success"
            sentence="settings.scope.unchecked"
            trail={[t("settings.agents.uncheckedTrail")]}
            onDismiss={onDismissUnchecked}
          />
        </FloatingToast>
      ) : null}
    </div>
  );
  const toggleOpen = () => onOpen(!open);
  return (
    <div className="settings-page__block">
      <SettingRow label={t("settings.scope.label")} note={t("settings.scope.note")}>
        {/* 键与它下方浮起的原因（选的文件夹当不了项目）的锚 */}
        <span className="settings-page__check">
          <Button
            size="compact"
            icon={<IconPlus size={12} />}
            ariaLabel={t("settings.scope.addLabel")}
            onClick={onAdd}
          >
            {t("settings.scope.addNoun")}
          </Button>
          {addNotice ? (
            <FloatingToast key={addNotice.at} align="end">
              <Toast kind="cannot" message={addNotice.message} onDismiss={onDismissAddNotice} />
            </FloatingToast>
          ) : null}
        </span>
      </SettingRow>
      <div className="settings-page__grid">
        {/* 用户级一直在：勾着、禁用，按下即说原因 */}
        <div className="settings-page__cell">
          <CheckRow
            size="grid"
            checked
            onChange={() => undefined}
            disabledReason={t("settings.scope.userLocked")}
          >
            {t("skills.scope.user")}
          </CheckRow>
        </div>
        {grid.map(cell)}
      </div>
      {folded.length > 0 ? (
        <>
          {/* 句末补充式的「还有 N 个」：字在前、拉手在后（2026-10-06），整句可点 */}
          <div className="settings-page__more">
            <span className="settings-page__more-label" onClick={toggleOpen}>
              {tn("settings.scope.hiddenCount", folded.length)}
            </span>
            <DrawerHandle
              always
              open={open}
              onToggle={toggleOpen}
              label={tn("settings.scope.hiddenCount", folded.length)}
              controls="settings-scope-hidden"
            />
          </div>
          {open ? (
            <div id="settings-scope-hidden" className="settings-page__grid">
              {folded.map(cell)}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
