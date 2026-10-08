import { ClaudeListControls, ClaudeRowTodos } from "../claudeControls.tsx";
import { claudeListStatus, claudeModelsName, claudeOf, claudeTradeoff } from "../claudeView.ts";
import { CodexListControls, CodexRowTodos } from "../codexControls.tsx";
import { t } from "../i18n.ts";
import { codexListStatus, modeNote, portMovedNote, quotaNote } from "../modelsView.ts";
import { agentInstalled } from "../pickView.ts";
import { TrayClaudeModels, TrayThirdPartyModels } from "../TrayModelsRow.tsx";
import { gatewayOn } from "../types.ts";
import { UsageTrayRow } from "../usage/UsageTrayRow.tsx";
import { WorkBuddyListControls, WorkBuddyRowTodos } from "../workbuddyControls.tsx";
import { workbuddyListStatus } from "../workbuddyView.ts";
import { usageHeadNote, usageShown } from "../usage/usageView.ts";
import type { AgentEntry, AgentSection } from "./agentRegistry.ts";

/// agent 注册表（扩展点，见 agentRegistry.ts）：模型页的行、托盘面板的块与行都从这里生成。
/// - Codex：`用量`（只进托盘）+ `第三方模型`（模型页一行、托盘一行；只在 macOS 上、装了 Codex 才有）
/// - Claude（id `claude-code`，网关的家 `claude`）：`用量`（只进托盘，已登录才有）+ `第三方模型`（桌面应用；
///   模型页一行、托盘一行；只在 macOS 上、装了桌面应用才有——没装的不再列出灰开关，#259）
/// 用量有自己的一页（侧栏「用量」⌘4），不在模型页里占节（spec 2026-09-26-menubar-usage 第 7 节）
/// - WorkBuddy：`第三方模型`（模型页一行；只在 macOS 上、装了 WorkBuddy 才有；改了它自动重读，没有重启键）
/// 能接第三方模型的 agent 在后端也有一张表（core `model_providers::picks::MODEL_AGENTS`）：加一个 agent
/// ＝两边各加一行

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
        available: (s) => agentInstalled(s.gateway, s.modelsSupported, "codex"),
        listRow: {
          status: codexListStatus,
          note: (s) =>
            s.gateway === null
              ? null
              : (portMovedNote(s.gateway, "codex") ??
                quotaNote(s.gateway, s.usage) ??
                modeNote(s.gateway)),
          Controls: CodexListControls,
          Todos: CodexRowTodos,
        },
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
    // 模型页里的名字（这一行只改桌面应用）；托盘与用量仍用上面的 `Claude`
    modelsName: claudeModelsName,
    gateway: "claude",
    // 用量出行（已登录、桌面应用有记录，或装了桌面应用、给「连接 Claude 用量」），或本机支持第三方模型
    available: (s) => usageShown(s, "claude-code") || s.modelsSupported,
    indicator: (s) => gatewayOn(s.gateway, "claude"),
    headNote: (s) => usageHeadNote(s, "claude-code"),
    sections: [
      { ...USAGE, available: (s) => usageShown(s, "claude-code") },
      {
        id: "third-party-models",
        get title() {
          return t("shell.agents.thirdPartyModels");
        },
        available: (s) => agentInstalled(s.gateway, s.modelsSupported, "claude"),
        listRow: {
          status: claudeListStatus,
          note: (s) => {
            const view = claudeOf(s);
            if (view === null || s.gateway === null) return null;
            return portMovedNote(s.gateway, "claude") ?? (view.enabled ? claudeTradeoff() : null);
          },
          Controls: ClaudeListControls,
          Todos: ClaudeRowTodos,
        },
        trayRow: TrayClaudeModels,
      },
    ],
  },
  {
    // WorkBuddy（#266）：只有 `第三方模型`，模型页一行；装了才有。没有托盘行（托盘不出这一块）
    id: "workbuddy",
    name: "WorkBuddy",
    gateway: "workbuddy",
    available: (s) => agentInstalled(s.gateway, s.modelsSupported, "workbuddy"),
    indicator: (s) => gatewayOn(s.gateway, "workbuddy"),
    sections: [
      {
        id: "third-party-models",
        get title() {
          return t("shell.agents.thirdPartyModels");
        },
        listRow: {
          status: workbuddyListStatus,
          Controls: WorkBuddyListControls,
          Todos: WorkBuddyRowTodos,
        },
      },
    ],
  },
];
