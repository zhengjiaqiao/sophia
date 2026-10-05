import type { ReactNode } from "react";
import { t } from "../i18n.ts";
import { Button, Switch } from "../ui/index.ts";
import { SettingRow } from "./SettingRow.tsx";
import type { ReportSettings } from "../types";

/// 隐私说明：官网上线前放在公开仓库（spec 2026-10-04-reporting-feedback R15）
export const PRIVACY_URL = "https://github.com/zhengjiaqiao/sophia/blob/main/PRIVACY.md";
/// 常驻的 GitHub 入口（2026-10-05 产品负责人）：灰字行里 `隐私说明 ↗` 之后的 `在 GitHub 提 ↗`，反馈小窗发送失败那一句后面也有
export const ISSUES_URL = "https://github.com/zhengjiaqiao/sophia/issues/new/choose";

/// 设置「关于」里 `版本` 之后的 `使用统计和错误报告`（spec 2026-10-04-reporting-feedback R5、R6，画板「关于 · 使用统计」B）：
/// 设置行，左栏名字与一句灰字，灰字后接浅键 `隐私说明 ↗`、`在 GitHub 提 ↗`；右端一列 `反馈问题`（默认键紧凑，R13）+ 开关，
/// 开关默认开、随时可关（关掉删安装 ID）。不弹首次告知、不加说明段落。
/// 开关只在这份构建、这次运行能上报时画（内部版、没有接收服务地址、DO_NOT_TRACK 都不画）；`反馈问题` 只要有接收服务
/// 就有（DO_NOT_TRACK 不管它）。两样都没有、或还没读回来时整行不画。
/// 发出去之后的提示条（`feedbackNote`，调用方的 `FloatingToast`）放在键那一格里，锚在键下面
export function ReportRow({
  settings,
  onChange,
  onPrivacy,
  onGithub,
  onFeedback,
  feedbackNote,
}: {
  settings: ReportSettings | null;
  onChange: (next: boolean) => void;
  onPrivacy: () => void;
  /// 点 `在 GitHub 提`：打开仓库的新 issue 页
  onGithub: () => void;
  /// 点 `反馈问题`：打开反馈小窗
  onFeedback: () => void;
  feedbackNote?: ReactNode;
}) {
  if (!settings || !(settings.available || settings.feedback)) return null;
  return (
    <SettingRow
      label={t("settings.about.report")}
      note={
        <>
          {t("settings.about.reportNote")}&nbsp;&nbsp;
          <Button variant="quiet" onClick={onPrivacy}>
            {t("settings.about.privacy")}
          </Button>
          &nbsp;&nbsp;
          <Button variant="quiet" onClick={onGithub}>
            {t("settings.about.github")}
          </Button>
        </>
      }
    >
      {settings.feedback ? (
        <span className="settings-page__check">
          <Button size="compact" onClick={onFeedback}>
            {t("settings.about.feedback")}
          </Button>
          {feedbackNote}
        </span>
      ) : null}
      {settings.available ? (
        <Switch
          checked={settings.autoReport}
          onChange={onChange}
          label={t("settings.about.report")}
        />
      ) : null}
    </SettingRow>
  );
}
