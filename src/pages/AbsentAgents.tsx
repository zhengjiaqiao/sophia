import { t } from "../i18n.ts";
import { AgentIcon, SectionLabel } from "../ui/index.ts";

/// 设置页「› 未安装的 N 个」展开后的那一节（DESIGN「设置页」）：**它是信息，不是设置**——
/// 不放复选框，只列名字（`ink-mute`，带图标 / 首字母方块，三列按行读，同已安装那一节）。
/// 打勾却不在列表里是说谎；看着能点、点了没效果也不行。
/// 勾选与否只对已安装的有意义：未安装的不在不显示名单里（`discovery::reconcile_shown`），没有例外
export function AbsentAgents({
  agents,
}: {
  /// 未安装的全部品牌：图标用哪个产品的（`id`）+ 品牌名
  agents: ReadonlyArray<{ id: string; name: string }>;
}) {
  return (
    <div className="settings-page__absent">
      <SectionLabel>{t("sources.absent.title")}</SectionLabel>
      <div className="settings-page__grid">
        {agents.map((agent) => (
          <div key={agent.id} className="settings-page__cell">
            <div className="settings-page__info">
              <AgentIcon id={agent.id} name={agent.name} />
              <span className="settings-page__name">{agent.name}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
