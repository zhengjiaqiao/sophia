import ClaudeModelsPage, { ClaudeListControls } from "../ClaudeModelsPage.tsx";
import { CLAUDE_MODELS_NAME, claudeListStatus } from "../claudeView.ts";
import { CodexListControls } from "../codexControls.tsx";
import { t } from "../i18n.ts";
import ModelsTab from "../ModelsTab.tsx";
import { codexListStatus } from "../modelsView.ts";
import { TrayClaudeModels, TrayThirdPartyModels } from "../TrayModelsRow.tsx";
import { gatewayOn } from "../types.ts";
import { UsageTrayRow } from "../usage/UsageTrayRow.tsx";
import { usageHeadNote, usageSignedIn } from "../usage/usageView.ts";
import type { AgentEntry, AgentSection, AgentSectionProps } from "./agentRegistry.ts";

/// agent 注册表（扩展点，见 agentRegistry.ts）：模型页的列表行与推入页、托盘面板的块与行都从这里生成。
/// - Codex：`用量`（只进托盘）+ `第三方模型`（列表一行、推入 Codex 的页、托盘一行，只在 macOS 上有）
/// - Claude（id `claude-code`，网关的家 `claude`）：`用量`（只进托盘，已登录才有）+ `第三方模型`（桌面应用；
///   列表一行、推入 Claude 的页、托盘一行，只在 macOS 上有，没装桌面应用也列出、开关禁用）
/// 用量有自己的一页（侧栏「用量」⌘4），不在模型页里占节（spec 2026-09-26-menubar-usage 第 7 节）

/// Codex 的页：今天由 ModelsTab 整页承担
function CodexModels(props: AgentSectionProps) {
  return <ModelsTab {...props} />;
}

/// 用量：托盘里一行，排在第三方模型之前（R10）
const USAGE: AgentSection = {
  id: "usage",
  get title() {
    return t("shell.agents.usage");
  },
  trayRow: UsageTrayRow,
};

export const AGENTS: ReadonlyArray<AgentEntry> = [
  {
    id: "codex",
    name: "Codex",
    gateway: "codex",
    available: (s) => s.modelsSupported,
    indicator: (s) => gatewayOn(s.gateway, "codex"),
    headNote: (s) => usageHeadNote(s, "codex"),
    sections: [
      USAGE,
      {
        id: "third-party-models",
        get title() {
          return t("shell.agents.thirdPartyModels");
        },
        Component: CodexModels,
        listRow: { status: codexListStatus, Controls: CodexListControls },
        trayRow: TrayThirdPartyModels,
      },
    ],
  },
  {
    // 块名 `Claude`（产品负责人 2026-09-29）：这块里的 5 小时 / 本周额度属于 Claude 账号，命令行、
    // 桌面应用、claude.ai 共用；桌面应用的第三方模型也接在这一块、用量之后。id 仍是 `claude-code`（用量按它取数），
    // 第三方模型读网关状态里的家 `claude`（spec R45）
    id: "claude-code",
    name: "Claude",
    // 模型页里叫 `Claude Desktop`（这一行只改桌面应用）；托盘与用量仍用上面的 `Claude`
    modelsName: CLAUDE_MODELS_NAME,
    gateway: "claude",
    // 用量已登录，或本机支持第三方模型（没装桌面应用照样列出，开关禁用）
    available: (s) => usageSignedIn(s, "claude-code") || s.modelsSupported,
    indicator: (s) => gatewayOn(s.gateway, "claude"),
    headNote: (s) => usageHeadNote(s, "claude-code"),
    sections: [
      { ...USAGE, available: (s) => usageSignedIn(s, "claude-code") },
      {
        id: "third-party-models",
        get title() {
          return t("shell.agents.thirdPartyModels");
        },
        available: (s) => s.modelsSupported,
        Component: ClaudeModelsPage,
        listRow: { status: claudeListStatus, Controls: ClaudeListControls },
        trayRow: TrayClaudeModels,
      },
    ],
  },
];
