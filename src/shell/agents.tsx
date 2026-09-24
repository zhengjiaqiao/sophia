import ModelsTab from "../ModelsTab.tsx";
import type { AgentEntry, AgentSectionProps } from "./agentRegistry.ts";

/// agent 注册表（扩展点，见 agentRegistry.ts）：侧栏 `agent` 段、agent 页的节都从这里生成。
/// 今天只有 Codex，只有「第三方模型」一节（只在 macOS 上有）。
/// 以后 Claude Code 有了用量：加一项 `{ id: "claude-code", name: "Claude Code", sections: [用量] }`；
/// Codex 有了用量：在它的 sections 最前面加一节。

/// 第三方模型：今天由 ModelsTab 整页承担（第二波把它改成节头 + 开关 + 网关的一节）
function ThirdPartyModels(props: AgentSectionProps) {
  return <ModelsTab {...props} />;
}

export const AGENTS: ReadonlyArray<AgentEntry> = [
  {
    id: "codex",
    name: "Codex",
    available: (s) => s.modelsSupported,
    indicator: (s) => s.gateway?.enabled === true,
    sections: [{ id: "third-party-models", title: "第三方模型", Component: ThirdPartyModels }],
  },
];
