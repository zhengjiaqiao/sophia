import { useState } from "react";
import type { ReactNode } from "react";
import { Confirm } from "./ui/index.ts";
import { t } from "./i18n.ts";
import { ScopeKeyHint, type ScopeGitignore } from "./McpScopeDialog.tsx";
import { askedTargets, scopeKeyHintTip, scopeTrackedNote } from "./mcpKeyHint.ts";
import type { McpKeyHint } from "./types.ts";

export type KeepGitignore = ScopeGitignore;

/// 「保留这份」的确认框（DESIGN-components「差异表 › 按下先确认」）：标题一问写明对象，正文一句后果，安全信息，
/// 主动作墨键 `保留`。密钥提醒（S19，issue #147，同修改生效范围的确认框一套判断）：要改写的项目文件里有「第一次暴露」
/// 的，正文末尾出默认不勾的 `同时加进 .gitignore`（`ScopeKeyHint`，勾选行默认档——紧挨的是 15 号的确认框正文，
/// DESIGN-components「勾选行 › 字号随场景」；提示框）；目标文件已被跟踪的在同一个
/// 位置说一句；来源被忽略（写成后自动加，结果提示条里说）、来源已提交过、不处理的什么都不出。
/// `hints` 为 null＝检查还没回来：墨键灰着，不然没看到勾选就改了
export function McpKeepConfirm({
  title,
  body,
  hints,
  onConfirm,
  onCancel,
}: {
  title: ReactNode;
  body: ReactNode;
  hints: McpKeyHint[] | null;
  onConfirm: (gitignore: KeepGitignore) => void;
  onCancel: () => void;
}) {
  const [addGitignore, setAddGitignore] = useState(false);
  const tip = scopeKeyHintTip(hints);
  const tracked = scopeTrackedNote(hints);
  const checking = hints === null;
  return (
    <Confirm
      title={title}
      safetyNote={t("mcp.keep.safety")}
      confirmLabel={t("mcp.keep.confirm")}
      confirmDisabledReason={checking ? t("mcp.write.checking") : undefined}
      onConfirm={() => {
        if (!checking)
          onConfirm({
            ...askedTargets(hints),
            add: tip !== null && addGitignore,
          });
      }}
      onCancel={onCancel}
    >
      {body}
      {tip !== null || tracked !== null ? (
        <ScopeKeyHint
          checked={addGitignore}
          onChange={setAddGitignore}
          tip={tip}
          tracked={tracked}
          size="list"
        />
      ) : null}
    </Confirm>
  );
}
