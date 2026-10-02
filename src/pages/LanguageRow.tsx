import { t } from "../i18n.ts";
import { Tabs } from "../ui/index.ts";
import type { LanguageSetting } from "../types";

/// 设置「界面」一节的「界面语言」一行（spec 2026-09-30-language-and-theme R1 R2，第三批画板 1A）：在外观行之上，
/// 同外观行一样是标签 + 紧凑页签 + 一句灰字。四项：跟随系统 ｜ 简体中文 ｜ 繁體中文 ｜ English——后三项写成各语言的
/// 自称（选语言的人未必读得懂当前界面的语言），三份目录里值相同；「跟随系统」按当前语言。
/// 说明句说系统自带的控件（选文件夹对话框的按钮）跟随 macOS 的语言，运行中改不了。选了当场换，不设保存键
/// label 用取值函数（getter）：文案用到时才取，不在模块加载时定死
export const LANGUAGE_ITEMS: ReadonlyArray<{ id: LanguageSetting; label: string }> = [
  {
    id: "system",
    get label() {
      return t("settings.language.system");
    },
  },
  {
    id: "zh-Hans",
    get label() {
      return t("settings.language.zhHans");
    },
  },
  {
    id: "zh-Hant",
    get label() {
      return t("settings.language.zhHant");
    },
  },
  {
    id: "en",
    get label() {
      return t("settings.language.en");
    },
  },
];

export function LanguageRow({
  value,
  onChange,
}: {
  value: LanguageSetting;
  onChange: (next: LanguageSetting) => void;
}) {
  return (
    <div className="settings-page__line">
      <span className="settings-page__label">{t("settings.language.label")}</span>
      <div className="settings-page__control">
        <Tabs
          compact
          plain
          label={t("settings.language.label")}
          items={LANGUAGE_ITEMS}
          value={value}
          onChange={onChange}
        />
        <p className="settings-page__hint">{t("settings.language.hint")}</p>
      </div>
    </div>
  );
}
