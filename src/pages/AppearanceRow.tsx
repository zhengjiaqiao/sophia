import { t } from "../i18n.ts";
import { Tabs } from "../ui/index.ts";
import { SettingRow } from "./SettingRow.tsx";
import type { Appearance } from "../types";

/// 设置「通用」一节的「外观」一行（spec 2026-09-30-language-and-theme R1 R2，设计稿 7ZoeBtNk7RbTLKoWnPEDY8 第 3 组）：
/// 设置行（`SettingRow`）：标签与一句灰字在左，紧凑页签在右（与用量页的分段选择同一种；不加太阳 / 月亮图标，这套界面里没有这类图标的先例）。
/// 选了当场生效，不设保存键
/// label 用取值函数（getter）：文案用到时才取，不在模块加载时定死
export const APPEARANCE_ITEMS: ReadonlyArray<{ id: Appearance; label: string }> = [
  {
    id: "system",
    get label() {
      return t("settings.appearance.system");
    },
  },
  {
    id: "light",
    get label() {
      return t("settings.appearance.light");
    },
  },
  {
    id: "dark",
    get label() {
      return t("settings.appearance.dark");
    },
  },
];

export function AppearanceRow({
  value,
  onChange,
}: {
  value: Appearance;
  onChange: (next: Appearance) => void;
}) {
  return (
    <SettingRow label={t("settings.appearance.label")} note={t("settings.appearance.hint")}>
      <Tabs
        compact
        plain
        label={t("settings.appearance.label")}
        items={APPEARANCE_ITEMS}
        value={value}
        onChange={onChange}
      />
    </SettingRow>
  );
}
