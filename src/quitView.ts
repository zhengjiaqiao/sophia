/// 退出 Sophia 的确认框说什么（spec 2026-10-03-gateway-in-app R5、R6、R9；画板「退出确认」）。纯函数，
/// tests/quit-view.test.ts 直接测。主窗口（窗口正中）与托盘面板（窄面板）同一套文案。
///
/// 一律写 Codex（2026-10-03 产品负责人：退出确认框里写 Codex，不写桌面应用的名字 ChatGPT）
import { listText, t } from "./i18n.ts";
import type { QuitFailure, QuitPreview, QuitStep } from "./types.ts";

/// 退出前要不要确认（R5）：Codex 正指着路由，或 Claude 处在 Sophia 写入的第三方模式，或 WorkBuddy 里写着 Sophia 的模型
///（#266）。都没有就直接退出
export function quitNeedsConfirm(preview: QuitPreview): boolean {
  return preview.codex || preview.claude || preview.workbuddy;
}

export interface QuitText {
  title: string;
  body: string;
}

/// 确认框的标题与正文（R6；走查 2026-10-07 改成两层）：一句合并主句点名接了第三方模型的几家
///（按 Codex、Claude、WorkBuddy 的先后），后面只接有额外代价的——Codex、Claude 会马上重启；WorkBuddy 没有，不另写。
/// 终端里有交互式 Codex 时再补一句
export function quitConfirmText(preview: QuitPreview): QuitText {
  const agents = [
    preview.codex && "Codex",
    preview.claude && "Claude",
    preview.workbuddy && "WorkBuddy",
  ].filter((name): name is string => typeof name === "string");
  const main = t("shell.quit.body", { agents: listText(agents) });
  const cost =
    preview.codex && preview.claude
      ? t("shell.quit.restartBoth")
      : preview.codex
        ? t("shell.quit.restartCodex")
        : preview.claude
          ? t("shell.quit.restartClaude")
          : null;
  const body = cost === null ? main : t("shell.quit.withCost", { body: main, cost });
  return {
    title: t("shell.quit.title"),
    body: preview.codex && preview.codexTerminal ? t("shell.quit.withTerminal", { body }) : body,
  };
}

/// 点了 `退出` 之后键区原位那一句（`quit-progress` 的 `step`）
export function quitBusyText(step: QuitStep): string {
  return step === "restartingCodex"
    ? t("shell.quit.restartingCodex")
    : t("shell.quit.restartingClaude");
}

/// 收尾里有没做成的（R9）：单键说明，后果与恢复办法；没有没做成的为 null。WorkBuddy 没拿掉的（#266）：只有它时
/// 自成一段；和别家一起时标题照别家的，后果接在正文后面
export function quitFailureText(failures: ReadonlyArray<QuitFailure>): QuitText | null {
  const others = restartFailureText(failures);
  if (!failures.some((f) => f.agent === "workbuddy")) return others;
  if (others === null) {
    return {
      title: t("shell.quit.workbuddyFailedTitle"),
      body: t("shell.quit.workbuddyFailedBody"),
    };
  }
  return {
    title: others.title,
    body: t("shell.quit.alsoWorkBuddyFailed", {
      body: others.body,
      workbuddy: t("shell.quit.workbuddyFailedBody"),
    }),
  };
}

/// Codex、Claude 没做成的说明
function restartFailureText(failures: ReadonlyArray<QuitFailure>): QuitText | null {
  const codex = failures.some((f) => f.agent === "codex");
  const claude = failures.some((f) => f.agent === "claude");
  if (codex && claude) {
    return {
      title: t("shell.quit.bothFailedTitle"),
      body: t("shell.quit.bothFailedBody", {
        codex: t("shell.quit.codexFailedBody"),
        claude: t("shell.quit.claudeFailedBody"),
      }),
    };
  }
  if (codex) {
    return {
      title: t("shell.quit.codexFailedTitle"),
      body: t("shell.quit.codexFailedBody"),
    };
  }
  if (claude) {
    return { title: t("shell.quit.claudeFailedTitle"), body: t("shell.quit.claudeFailedBody") };
  }
  return null;
}
