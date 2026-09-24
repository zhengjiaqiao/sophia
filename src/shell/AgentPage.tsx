import { AgentIcon } from "../ui/index.ts";
import type { AgentEntry, AgentSectionProps } from "./agentRegistry.ts";
import { PageHead, PageTitle } from "./PageHead.tsx";

/// agent 页（DESIGN「agent 页」）：一个 agent 一页，页内按能力分节。外框只有两样：
/// 页面头（24px 图标 + 10 + 名字 `title` 20 / 600；右端留给 agent 级动作，节经 PageHeadActions 放进来）
/// 和按注册表先后排的一串节（节间 48）。哪个 agent、哪几节全由注册表给，这里不认得 Codex
export function AgentPage({ entry, ...props }: { entry: AgentEntry } & AgentSectionProps) {
  return (
    <PageHead
      lead={
        <PageTitle icon={<AgentIcon id={entry.id} name={entry.name} size={24} />}>
          {entry.name}
        </PageTitle>
      }
    >
      <div className="agent-page">
        {entry.sections.map((section) => (
          <section key={section.id} className="agent-page__section" aria-label={section.title}>
            <section.Component {...props} />
          </section>
        ))}
      </div>
    </PageHead>
  );
}
