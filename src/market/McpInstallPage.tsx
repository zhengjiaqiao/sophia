/// 安装 MCP（spec R10，画板 09；#276 画板第 7 屏；DESIGN「发现与安装 › 安装页」）：骨架同安装 skill。
///
/// ```
/// ←  安装 brave-search
/// Brave · 查看说明 ↗                                  （悬停：@modelcontextprotocol/server-brave-search）
/// 本地运行                                            （悬停：npx -y @modelcontextprotocol/server-brave-search）
/// 生效范围 ─────────────────────────────────────────
/// [用户级] [CardBox] [更多 ˅]
/// 给谁用 ───────────────────────────────────────────
/// ☑ ✳ Claude Code             ☐ ⎔ Codex  Codex 里已经有一个不一样的 brave-search
/// ☑ ✳ Claude Desktop  重启 Claude Desktop 后生效      （悬停能勾的一行：写入 <配置文件>）
/// 要填的 ───────────────────────────────────────────
/// Brave Search API key  [••••••••••••••••••        👁]
/// 必填 · 密钥 BRAVE_API_KEY   在 brave.com/search/api 申请
/// 密钥只保存在所选 agent 中，Sophia 不保留
/// ═══════════════════════════════════════════════ 贴底
///                                                     [取消] [安装]
/// ```
///
/// 给谁用：默认勾名单里能写 MCP 的，Claude Desktop 跟着 Claude Code；一个都加不上的不能勾、
/// 就地说原因；已有一样的跳过、不算失败。要填的值只进这一次写入，不进 Sophia 的设置与日志
import { t } from "../i18n.ts";
import type { McpReport, McpCatalogEntry } from "../types.ts";
import { Mono, PushedPage, Tooltip } from "../ui/index.ts";
import type { InstalledNotice } from "./InstalledToast.tsx";
import {
  AgentChecks,
  claudeScopeChoice,
  FieldsBlock,
  InstallBlock,
  InstallFooter,
  InstallScroll,
  KeyHintBlock,
  OriginLine,
  PlaceBlock,
} from "./InstallParts.tsx";
import { useInstallFrame, type InstallPageBase } from "./InstallPage.tsx";
import { connectionParts, installLabel, mcpOrigin } from "./installView.ts";
import { marketService } from "./service.ts";
import { useMcpInstall } from "./useInstall.ts";

export interface McpInstallPageProps extends InstallPageBase {
  /// 精选或官方目录的一项
  entry: McpCatalogEntry;
  /// 加上了（至少一处）：报告 + 右下那一窗（`✓ 已加到 [图标…] brave-search` + `撤销`）
  onDone: (report: McpReport, notice: InstalledNotice) => void;
}

/// 远程 OAuth 的：加上之后还要在浏览器里登录一次（发现列表上写的是 `需要登录`）
export const signInNote = () => t("market.mcp.signInNote");

const FACE = () => document.querySelector(".face");
const FACE_SCROLL = () => document.querySelector(".face__scroll");

export function McpInstallPage(props: McpInstallPageProps) {
  const { entry, onDone } = props;
  const service = props.service ?? marketService;
  const page = useInstallFrame(props.onClose);
  const definition = { ...entry.definition, name: entry.name };
  const state = useMcpInstall({
    service,
    definitions: [definition],
    fields: entry.fields,
    mine: props.mine,
    agents: props.agents,
    shown: props.shown,
  });
  // 「同时加进 .gitignore」：有「要填的」时放在那一块最后，没有时放在「给谁用」最后
  const gitignore =
    state.keyHint !== null || state.keyTracked !== null ? (
      <KeyHintBlock
        checked={state.addToGitignore}
        onChange={state.setAddToGitignore}
        tip={state.keyHint}
        tracked={state.keyTracked}
      />
    ) : null;
  const origin = mcpOrigin(entry);
  const connection = connectionParts(entry.definition);
  const submit = async () => {
    const done = await state.install();
    if (!done) return;
    onDone(done.report, { kind: "mcp", toast: done.toast, undoId: done.report.undoId });
    page.leave();
  };
  return (
    <PushedPage
      {...page}
      title={t("market.install.title", { name: entry.name })}
      host={props.host ?? FACE}
      covers={props.covers ?? FACE_SCROLL}
      escape={props.escape}
      footer={
        <InstallFooter
          label={installLabel(1)}
          block={state.block}
          busy={state.busy}
          busyLabel={t("market.busy.adding")}
          failure={state.failure}
          onDismissFailure={state.dismissFailure}
          onCancel={page.leave}
          onSubmit={() => void submit()}
        />
      }
    >
      <InstallScroll>
        <OriginLine
          parts={[{ text: origin.publisher }]}
          leave={
            origin.leave
              ? {
                  label: origin.leave.label,
                  tip: <Mono inherit>{origin.leave.tip}</Mono>,
                  onClick: () => service.openUrl(origin.leave!.url),
                }
              : null
          }
        />
        <p className="install-lede">
          {/* 运行方式只写 `本地运行` / `在线服务`，命令与地址进悬停（第二层，#276） */}
          <Tooltip
            content={connection.value ? <Mono inherit>{connection.value}</Mono> : null}
            focusable
          >
            <span>{connection.kind}</span>
          </Tooltip>
          {entry.signIn ? <>&nbsp;·&nbsp;{signInNote()}</> : null}
        </p>
        <PlaceBlock places={props.places} value={state.location} onChange={state.setLocation} />
        <InstallBlock label={t("market.install.blockWho")}>
          <AgentChecks
            rows={state.rows}
            checked={state.checked}
            onToggle={state.toggle}
            viewOf={state.viewOf}
            claudeScope={claudeScopeChoice(
              props.places,
              state.location,
              state.claudeScope,
              state.setClaudeScope,
            )}
          />
          {entry.fields.length === 0 ? gitignore : null}
        </InstallBlock>
        {entry.fields.length > 0 ? (
          <FieldsBlock
            fields={entry.fields}
            values={state.values}
            onChange={state.setValue}
            footer={gitignore}
          />
        ) : null}
      </InstallScroll>
    </PushedPage>
  );
}
