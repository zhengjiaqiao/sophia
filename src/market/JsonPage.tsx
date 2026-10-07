/// 从 JSON 添加（spec R8，画板 10；DESIGN「发现与安装 › 从链接安装 · 从 JSON 添加」）：`粘贴 JSON` 推入这一页。
///
/// ```
/// ←  从 JSON 添加
/// ┌ { "mcpServers": { "github": {…}, "filesystem": {…} } }      ┐  等宽框：recess 底、限高、框内滚
/// └──────────────────────────────────────────────────────────────┘
/// 认出 2 个 · 已选 2 ───────────────────────────────
/// ☑ github       在线服务 · https://api.githubcopilot.com/mcp/
/// ☑ filesystem   本地运行 · npx -y @modelcontextprotocol/server-filesystem ~/Documents
/// 生效范围 ─── [用户级] [CardBox] [更多 ˅]
/// 给谁用 ─（一列，放得下原因句）
/// ☑ ✳ Claude Desktop  只写 filesystem · github 是远程服务器，要在 Claude Desktop 自己的「连接器」里添加
/// ═══════════════════════════════════════════════ 贴底
///                                                    [取消] [添加 2 个]
/// ```
///
/// - 进来时剪贴板里的内容认得出（解析出至少一个服务器）就直接填好
/// - 输入停 300ms 解析一次；解析不了在框下一行说哪一行错
/// - 单个服务器对象没有名字：那一行给一个输入框现起名字
/// - 贴进来的是完整定义，没有 `要填的`；值里有空着的 `${…}` 占位时才多出这一节
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n.ts";
import { Mono, PushedPage, TextField } from "../ui/index.ts";
import type { McpParseResult, McpReport } from "../types.ts";
import type { InstalledNotice } from "./InstalledToast.tsx";
import {
  AgentChecks,
  claudeScopeChoice,
  FieldsBlock,
  InstallBlock,
  InstallFooter,
  InstallScroll,
  KeyHintBlock,
  PickList,
  PickRow,
  PlaceBlock,
} from "./InstallParts.tsx";
import { useInstallFrame, type InstallPageBase } from "./InstallPage.tsx";
import {
  addLabel,
  connectionText,
  jsonHeader,
  parseErrorLine,
  placeholderFields,
} from "./installView.ts";
import { errorText, marketService } from "./service.ts";
import { useClipboardPrefill, useDebounced, useMcpInstall } from "./useInstall.ts";

export interface JsonPageProps extends InstallPageBase {
  /// 加上了（至少一处）：报告 + 右下那一窗
  onDone: (report: McpReport, notice: InstalledNotice) => void;
  /// 框里先放什么（样张、测试）；不给就看剪贴板
  initial?: string;
}

const FACE = () => document.querySelector(".face");
const FACE_SCROLL = () => document.querySelector(".face__scroll");

type Parsed = { input: string; result: McpParseResult } | { input: string; error: string };

export function JsonPage(props: JsonPageProps) {
  const service = props.service ?? marketService;
  const page = useInstallFrame(props.onClose);
  const [text, setText] = useState(props.initial ?? "");
  const textRef = useRef(text);
  textRef.current = text;
  useClipboardPrefill(
    service,
    async (clip) => {
      try {
        return (await service.parseMcpJson(clip)).servers.length > 0;
      } catch {
        return false;
      }
    },
    setText,
    () => textRef.current.trim() === "",
  );

  // 输入停 300ms 解析一次
  const settled = useDebounced(text, 300);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  useEffect(() => {
    if (settled.trim() === "") {
      setParsed(null);
      return;
    }
    let alive = true;
    service
      .parseMcpJson(settled)
      .then((result) => alive && setParsed({ input: settled, result }))
      .catch((error: unknown) => alive && setParsed({ input: settled, error: errorText(error) }));
    return () => {
      alive = false;
    };
  }, [settled, service]);

  const result = parsed && "result" in parsed ? parsed.result : null;
  const servers = useMemo(() => result?.servers ?? [], [result]);
  const serversKey = JSON.stringify(servers);

  // 换了一批：默认全选，现起的名字清掉
  const [unselected, setUnselected] = useState<number[]>([]);
  const [names, setNames] = useState<Record<number, string>>({});
  useEffect(() => {
    setUnselected([]);
    setNames({});
  }, [serversKey]);
  const nameOf = (i: number) => servers[i].name || (names[i] ?? "");
  const selected = servers.map((_, i) => i).filter((i) => !unselected.includes(i));
  const definitions = selected.map((i) => ({ ...servers[i], name: nameOf(i).trim() }));
  const fields = placeholderFields(definitions);

  const state = useMcpInstall({
    service,
    definitions,
    fields,
    mine: props.mine,
    agents: props.agents,
    shown: props.shown,
  });
  // 「同时加进 .gitignore」：有「要填的」时放在那一块最后，没有时（密钥直接写在定义里）放在「给谁用」最后
  const gitignore =
    state.keyHint !== null || state.keyTracked !== null ? (
      <KeyHintBlock
        checked={state.addToGitignore}
        onChange={state.setAddToGitignore}
        tip={state.keyHint}
        tracked={state.keyTracked}
      />
    ) : null;

  const submit = async () => {
    const done = await state.install();
    if (!done) return;
    props.onDone(done.report, { kind: "mcp", toast: done.toast, undoId: done.report.undoId });
    page.leave();
  };

  const error =
    parsed && "error" in parsed
      ? parsed.error
      : result?.error
        ? parseErrorLine(result.error)
        : null;

  return (
    <PushedPage
      {...page}
      title={t("market.json.title")}
      host={props.host ?? FACE}
      covers={props.covers ?? FACE_SCROLL}
      escape={props.escape}
      footer={
        <InstallFooter
          label={addLabel(selected.length)}
          block={servers.length === 0 ? t("market.json.pasteFirst") : state.block}
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
        <textarea
          className="install-json"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={t("market.json.textareaLabel")}
          placeholder={'{ "mcpServers": { … } }'}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
        {error ? <p className="install-status is-error">{error}</p> : null}
        {servers.length > 0 ? (
          <>
            <InstallBlock label={jsonHeader(servers.length, selected.length)}>
              <PickList label={t("market.json.pickLabel")}>
                {servers.map((s, i) => (
                  <PickRow
                    key={i}
                    label={s.name || t("market.json.unnamed")}
                    name={
                      s.name ? (
                        s.name
                      ) : (
                        <TextField
                          value={names[i] ?? ""}
                          onChange={(v) => setNames((prev) => ({ ...prev, [i]: v }))}
                          label={t("market.json.nameLabel")}
                          placeholder={t("market.json.namePlaceholder")}
                          mono
                          spellCheck={false}
                          autoComplete="off"
                        />
                      )
                    }
                    checked={!unselected.includes(i)}
                    onChange={(on) =>
                      setUnselected((prev) => (on ? prev.filter((x) => x !== i) : [...prev, i]))
                    }
                    detail={<Mono inherit>{connectionText(s)}</Mono>}
                  />
                ))}
              </PickList>
            </InstallBlock>
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
                columns={1}
              />
              {fields.length === 0 ? gitignore : null}
            </InstallBlock>
            {fields.length > 0 ? (
              <FieldsBlock
                fields={fields}
                values={state.values}
                onChange={state.setValue}
                footer={gitignore}
              />
            ) : null}
          </>
        ) : null}
      </InstallScroll>
    </PushedPage>
  );
}
