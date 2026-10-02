/// 状态 `✓ 已安装`（DESIGN「发现与安装 › `发现` 的页面头与列表」）：对勾 + 13 `ink-mute`，平贴、没有键面、按不下，
/// 右沿与 `安装` 键对齐。2026-09-27 产品负责人：「已安装看起来还像是按钮」——它说的是状态，不是能按
import { t } from "../i18n";
import { IconTick } from "../ui";

export function InstalledMark() {
  return (
    <span className="dsc-installed">
      <IconTick />
      <span>{t("market.installed.mark")}</span>
    </span>
  );
}
