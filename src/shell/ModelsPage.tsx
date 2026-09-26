import { PageHead, PageTitle } from "../ui/index.ts";
import type { AgentEntry, AgentSectionProps } from "./agentRegistry.ts";

/// 模型页（spec 2026-09-26-object-first-navigation R11；DESIGN「模型页」）：侧栏「模型」一项的那一页。
/// 页面头只有页面名 `模型`；下面按注册表的先后排每个 agent 的能力节（节间 48），节头写
/// `<agent> · <能力>`（`Codex · 第三方模型`），节头与内容都归节组件自己画。哪个 agent、哪几节全由注册表给，
/// 这里不认得 Codex。以后别的 agent 能接第三方模型，这一页多一节。
/// 整页（页面头连同各节）限宽 776、左沿＝机面内左沿，与 SKILLS / MCP 的表同宽（DESIGN「第三方模型 › 一条左沿」）
export function ModelsPage({
  entries,
  ...props
}: { entries: ReadonlyArray<AgentEntry> } & AgentSectionProps) {
  return (
    <div className="agent-page">
      <PageHead lead={<PageTitle>模型</PageTitle>}>
        {entries.flatMap((entry) =>
          entry.sections.map((section) => (
            <section
              key={`${entry.id}:${section.id}`}
              className="agent-page__section"
              aria-label={`${entry.name} · ${section.title}`}
            >
              <section.Component {...props} />
            </section>
          )),
        )}
      </PageHead>
    </div>
  );
}
