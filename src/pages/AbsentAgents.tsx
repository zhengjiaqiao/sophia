import type { HarnessStatus } from "../types.ts";
import { AgentIcon, Button } from "../ui/index.ts";

/// 设置页「显示未安装的 N 个」展开后的那一节（DESIGN「设置页」）：**它是信息，不是设置**——
/// 不放复选框，只列名字（`ink-faint`，带图标 / 首字母方块，三列按列读）。打勾却不在列表里是说谎；
/// 看着能点、点了没效果也不行。
///
/// 例外：曾在已安装时被取消勾选、后来卸载了的 agent（在不显示名单里、且未安装）排在最前，
/// 名字后写 `装上后也不显示 · 恢复`；`恢复` 是文字链＝从不显示名单里移除。
export function AbsentAgents({
  agents,
  onRestore,
}: {
  /// 未安装的全部 agent
  agents: HarnessStatus[];
  onRestore: (id: string) => void;
}) {
  const hidden = agents.filter((a) => !a.enabled);
  const plain = agents.filter((a) => a.enabled);
  const ordered = [...hidden, ...plain];
  const rows = Math.max(1, Math.ceil(ordered.length / 3));
  return (
    <div className="settings-page__absent">
      <div className="settings-page__absent-head">
        未安装的 {agents.length} 个 · 装上后可以在这里勾选显示
      </div>
      <div className="settings-page__grid" style={{ gridTemplateRows: `repeat(${rows}, auto)` }}>
        {ordered.map((agent) => (
          <div key={agent.id} className="settings-page__cell">
            <div className="settings-page__info">
              <AgentIcon id={agent.id} name={agent.displayName} />
              <span className="settings-page__name">{agent.displayName}</span>
              {agent.enabled ? null : (
                <span className="settings-page__hidden-note">
                  {/* flex 容器会吃掉文字间的空白：间距用 gap，不靠空格 */}
                  <span>装上后也不显示 ·</span>
                  <Button variant="quiet" onClick={() => onRestore(agent.id)}>
                    恢复
                  </Button>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
