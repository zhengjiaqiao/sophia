import { AgentIcon, PageHead, PageTitle } from "../ui/index.ts";
import type { AgentEntry, AgentSectionProps } from "./agentRegistry.ts";

/// agent 页（DESIGN「agent 页」）：一个 agent 一页，页内按能力分节。外框只有两样：
/// 页面头（24px 图标 + 10 + 名字 `title` Condensed 20 / 700；右端留给 agent 级动作，节经 PageHeadActions 放进来）
/// 和按注册表先后排的一串节（节间 48）。哪个 agent、哪几节全由注册表给，这里不认得 Codex。
/// 整页（页面头连同各节）限宽 776、左沿＝机面内左沿，与位置页的表同宽（DESIGN「第三方模型 › 一条左沿」）
export function AgentPage({ entry, ...props }: { entry: AgentEntry } & AgentSectionProps) {
  return (
    <div className="agent-page">
      <PageHead
        lead={
          <PageTitle icon={<AgentIcon id={entry.id} name={entry.name} size={24} />}>
            {entry.name}
          </PageTitle>
        }
      >
        {entry.sections.map((section) => (
          <section key={section.id} className="agent-page__section" aria-label={section.title}>
            <section.Component {...props} />
          </section>
        ))}
      </PageHead>
    </div>
  );
}
