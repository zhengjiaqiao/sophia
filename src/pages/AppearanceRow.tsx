import { t } from "../i18n.ts";
import { Tabs } from "../ui/index.ts";
import type { Appearance } from "../types";

/// 设置「界面」一节的「外观」一行（spec 2026-09-30-language-and-theme R1 R2，设计稿 7ZoeBtNk7RbTLKoWnPEDY8 第 3 组）：
/// 标签 + 紧凑页签（与用量页的分段选择同一种；不加太阳 / 月亮图标，这套界面里没有这类图标的先例）+ 一句灰字。
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
    <div className="settings-page__line">
      <span className="settings-page__label">{t("settings.appearance.label")}</span>
      <div className="settings-page__control">
        <Tabs
          compact
          plain
          label={t("settings.appearance.label")}
          items={APPEARANCE_ITEMS}
          value={value}
          onChange={onChange}
        />
        <p className="settings-page__hint">{t("settings.appearance.hint")}</p>
      </div>
    </div>
  );
}
