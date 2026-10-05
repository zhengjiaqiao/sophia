/// 退出 Sophia 的确认框说什么（spec 2026-10-03-gateway-in-app R5、R6、R9；画板「退出确认」）。纯函数，
/// tests/quit-view.test.ts 直接测。主窗口（窗口正中）与托盘面板（窄面板）同一套文案。
///
/// 一律写 Codex（2026-10-03 产品负责人：退出确认框里写 Codex，不写桌面应用的名字 ChatGPT）
import { t } from "./i18n.ts";
import type { QuitFailure, QuitPreview, QuitStep } from "./types.ts";

/// 退出前要不要确认（R5）：Codex 正指着路由，或 Claude 处在 Sophia 写入的第三方模式。都没有就直接退出
export function quitNeedsConfirm(preview: QuitPreview): boolean {
  return preview.codex || preview.claude;
}

export interface QuitText {
  title: string;
  body: string;
}

/// 确认框的标题与正文（R6）：两家 / 只 Codex / 只 Claude，终端里有交互式 Codex 时补一句
export function quitConfirmText(preview: QuitPreview): QuitText {
  const body =
    preview.codex && preview.claude
      ? t("shell.quit.bodyBoth")
      : preview.codex
        ? t("shell.quit.bodyCodex")
        : t("shell.quit.bodyClaude");
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

/// 收尾里有没做成的（R9）：单键说明，后果与恢复办法；没有没做成的为 null
export function quitFailureText(failures: ReadonlyArray<QuitFailure>): QuitText | null {
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
