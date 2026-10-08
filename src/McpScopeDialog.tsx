import { useEffect, useRef, useState } from "react";
import {
  AgentIcon,
  Button,
  CheckRow,
  Confirm,
  FloatingLayer,
  IconChevronDown,
  Menu,
  MenuItem,
  Note,
  RadioRow,
  Tooltip,
} from "./ui/index.ts";
import { ProjectList } from "./FilterRow.tsx";
import { scopeWord } from "./terms.ts";
import { InstallBlock, type InstallPlaces } from "./market/InstallParts.tsx";
import { t } from "./i18n.ts";
import {
  noChange,
  claudeSibling,
  scopeIntent,
  type ScopeAgentOption,
  type ScopeMode,
} from "./mcpView.ts";
import { askedTargets, scopeKeyHintTip, scopeTrackedNote } from "./mcpKeyHint.ts";
import type { LocationKey, McpKeyHint } from "./types.ts";

/// 确认时确认框里对哪几个目标（位置 id）说过什么：`remind` 出了勾选的，`tracked` 出了已被跟踪那一句的（按目标记：
/// 说过的提示条不再说，没说过的——检查之后又变了，比如勾选护着的那个文件确认前被 git add 了——照样说）；
/// `add` 出了勾选并且勾了。修改生效范围与「保留这份」共用
export interface ScopeGitignore {
  remind: string[];
  tracked: string[];
  add: boolean;
}

/// 确认框里这一刻的样子：能不能做、后果几句、几个去处在句子里的写法（`CardBox、weibo_assistant` / `3 个项目`）、
/// 按哪种动作说（移动但一份都不从这边挪＝加一份）
export interface ScopeChoiceView {
  blocked: string | null;
  lines: string[];
  toLabel: string;
  mode: ScopeMode;
}

/// 一个 agent 都没勾时墨键上的原因
export const noAgent = () => t("mcp.scope.noAgent");

/// 项目勾选行至多露几个（当前所在的项目、勾上的另算），其余在 `更多…`
const DIALOG_PROJECTS = 5;

/// MCP「修改生效范围」的确认框（spec 2026-09-30-mcp-config-scope R3 R4，画板 04–06b）：移动与加一份都改写配置文件、
/// 可能影响队友，是弹层唯一的用途「确认一个决定」。窗口正中（`Confirm`），标题 `修改 filesystem 的生效范围`，只有一块
/// `生效范围`：
/// - 互斥本身是一个单选（单选行）：`所有项目（用户级）` ｜ `只在这些项目`——用户级对所有项目都生效，两者不能同时要
///   （2026-09-30 产品负责人：「那互斥的操作呢？」——勾选框自己跳会意外，改成先单选）
/// - 选后者时下面的项目用勾选行多选（同安装页「给谁用」）；选前者时项目那一块变淡、不可勾；点任一个项目自动切到「只在这些项目」
/// - 默认跟着这一行现在在哪：用户级的行选「所有项目」，项目的行选「只在这些项目」并勾着这个项目
/// - 勾着这一行现在的项目、再勾别的＝在别处加一份；没勾它＝移过去（`scopeIntent`）。不再有「移动 ｜ 复制」与
///   「Claude Code 写到」（挪过去保持原来那一格，要换在表格里点那一格）
/// - 去不了的项目那一行灰着、悬停说原因；墨键写动作本身 `移到 CardBox` / `加到 weibo_assistant`，没改时 `没有改动` 灰着
/// - 下面一行 `写进哪些 agent` + 一颗目标框（同自动同步页「以后新出现的自动加到」那一颗：图标 + ˅；行首用词同 MCP
///   安装页）：默认＝这一行现在在用、去得了的全部，不用管它就是整行挪（2026-09-30 产品负责人：「默认用户移动后，不更改
///   agent，然后展示出来，但是用户可以调整」）；点开的多选菜单同自动同步页：去处能写的每个位置一项（Claude Code 仅自己、
///   团队共享各一项，两格互斥同表格），勾着的是和现在一致的；去掉的留在原处，多勾的从现有的一份转写过去，
///   去不了的灰着说原因（「不能选的应该灰色」）
/// - 密钥提醒（S19）：选中的去处里有「第一次暴露」的（来源不在仓库里、没被忽略，目标是 git 仓库里的项目文件）时，
///   正文末尾出默认不勾的 `同时加进 .gitignore`（`ScopeKeyHint`）；来源被忽略的写成后自动加，结果提示条里说
export function McpScopeDialog({
  name,
  places,
  fromKey,
  fromName,
  agents: agentsFor,
  view,
  targetBlocked,
  keyHints,
  onConfirm,
  onCancel,
}: {
  name: string;
  places: InstallPlaces;
  /// 这一行现在所在的生效范围
  fromKey: LocationKey;
  fromName: string;
  /// 「写进哪些 agent」的几项与默认勾着的（按选中的去处）
  agents: (targets: LocationKey[]) => { options: ScopeAgentOption[]; defaults: string[] };
  /// `columns`：「写进哪些 agent」里勾着的列
  view: (mode: ScopeMode, targets: LocationKey[], columns: ReadonlySet<string>) => ScopeChoiceView;
  /// 这个项目为什么勾不了（已有同名、一份都放不过去）；能勾时为 null
  targetBlocked: (key: LocationKey) => string | null;
  /// 密钥提醒（S19）：写进这几个去处、这几列时各项目文件的提醒（问后端，只读）
  keyHints: (targets: LocationKey[], columns: ReadonlySet<string>) => Promise<McpKeyHint[]>;
  /// `gitignore.remind` / `gitignore.tracked`：确认框里对哪几个目标出了「同时加进 .gitignore」、出了已被跟踪那一句；
  /// `gitignore.add`：出了勾选并且勾了
  onConfirm: (
    mode: ScopeMode,
    targets: LocationKey[],
    columns: ReadonlySet<string>,
    gitignore: ScopeGitignore,
  ) => void;
  onCancel: () => void;
}) {
  const [all, setAll] = useState(fromKey === "global");
  const [projects, setProjects] = useState<LocationKey[]>(fromKey === "global" ? [] : [fromKey]);
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLSpanElement>(null);
  // 用户在默认之外改过的：去掉的、多勾的（默认随去处变，改过的记着）
  const [removed, setRemoved] = useState<string[]>([]);
  const [added, setAdded] = useState<string[]>([]);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const agentsRef = useRef<HTMLButtonElement>(null);
  const intent = scopeIntent(fromKey, all, projects);
  const { options: agents, defaults } = agentsFor("blocked" in intent ? [] : intent.targets);
  const isOn = (id: string) =>
    (defaults.includes(id) && !removed.includes(id)) || added.includes(id);
  const going = agents.filter((a) => a.blocked === null && isOn(a.id));
  const columns = new Set(going.map((a) => a.id));
  const setOn = (id: string, on: boolean) => {
    setRemoved((prev) =>
      on ? prev.filter((k) => k !== id) : [...prev.filter((k) => k !== id), id],
    );
    setAdded((prev) => (on ? [...prev.filter((k) => k !== id), id] : prev.filter((k) => k !== id)));
  };
  const toggleAgent = (id: string) => {
    const on = !isOn(id);
    setOn(id, on);
    // Claude Code 仅自己、团队共享两格互斥（同表格）：勾一格，另一格让出来
    const sibling = claudeSibling(id);
    if (on && sibling !== null && isOn(sibling)) setOn(sibling, false);
  };
  const now = "blocked" in intent ? null : view(intent.mode, intent.targets, columns);
  // 密钥提醒：去处或列变了再问一次；新的回来之前先留着上一次的（不闪），但墨键等这一次回来再亮——
  // 不然没看到勾选就写进去了。问不出来（不该发生）按没有要提醒的算，写的时候后端照样再判一次
  const [keyCheck, setKeyCheck] = useState<{ key: string; hints: McpKeyHint[] } | null>(null);
  const [addGitignore, setAddGitignore] = useState(false);
  const checkKey = "blocked" in intent ? "" : JSON.stringify([intent.targets, [...columns].sort()]);
  useEffect(() => {
    if ("blocked" in intent) return;
    let live = true;
    keyHints(intent.targets, columns).then(
      (hints) => live && setKeyCheck({ key: checkKey, hints }),
      () => live && setKeyCheck({ key: checkKey, hints: [] }),
    );
    return () => {
      live = false;
    };
    // 只随去处与列变：`keyHints` 每次渲染都是新的函数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey]);
  const keyTip = "blocked" in intent ? null : scopeKeyHintTip(keyCheck?.hints ?? null);
  // 目标文件已被跟踪的：不出勾选，在同一个位置说一句（产品负责人 2026-10-06）
  const keyTracked = "blocked" in intent ? null : scopeTrackedNote(keyCheck?.hints ?? null);
  const checking = !("blocked" in intent) && keyCheck?.key !== checkKey;
  const blocked =
    "blocked" in intent
      ? intent.blocked
      : going.length === 0 && agents.some((a) => a.blocked === null)
        ? noAgent()
        : (now?.blocked ?? null);
  const label =
    "blocked" in intent
      ? intent.blocked === noChange()
        ? noChange()
        : t("mcp.scope.moveKey")
      : t((now?.mode ?? intent.mode) === "move" ? "mcp.scope.moveTo" : "mcp.scope.addTo", {
          place: now?.toLabel ?? "",
        });
  const lines =
    "blocked" in intent
      ? [intent.blocked === noChange() ? t("mcp.scope.unchanged") : intent.blocked]
      : blocked !== null
        ? [blocked]
        : (now?.lines ?? []);

  // 项目：这一行现在所在的项目在前（项目的行），再是最近活跃的，至多 5 个；从「更多」里勾上的补在后面
  const here = places.sorted.find((p) => p.key === fromKey);
  const recent = places.recent.filter((p) => p.key !== fromKey);
  const shown = [...(here ? [here] : []), ...recent.slice(0, DIALOG_PROJECTS)];
  const extra = places.sorted.filter(
    (p) => projects.includes(p.key) && !shown.some((s) => s.key === p.key),
  );
  const rows = [...shown, ...extra];
  const rest = places.sorted.filter((p) => !rows.some((r) => r.key === p.key));
  const toggle = (key: LocationKey, on: boolean) => {
    setAll(false);
    setProjects((prev) =>
      on ? [...prev.filter((k) => k !== key), key] : prev.filter((k) => k !== key),
    );
  };
  const anchor = moreRef.current?.querySelector<HTMLElement>("button") ?? moreRef.current;
  return (
    <Confirm
      title={t("mcp.scope.title", { name })}
      confirmLabel={label}
      confirmDisabledReason={blocked ?? (checking ? t("mcp.write.checking") : undefined)}
      onConfirm={() => {
        if (!("blocked" in intent) && !checking)
          onConfirm(intent.mode, intent.targets, columns, {
            ...askedTargets(keyCheck?.hints ?? null),
            add: keyTip !== null && addGitignore,
          });
      }}
      onCancel={onCancel}
    >
      <div className="mcp-scope">
        <InstallBlock label={`${scopeWord()} · ${t("mcp.scope.nowIn", { place: fromName })}`}>
          <div role="radiogroup" aria-label={scopeWord()}>
            <RadioRow checked={all} onSelect={() => setAll(true)}>
              {t("mcp.scope.allProjects")}
            </RadioRow>
            <RadioRow checked={!all} onSelect={() => setAll(false)}>
              {t("mcp.scope.onlyThese")}
            </RadioRow>
          </div>
          <div className={all ? "mcp-scope__projects is-off" : "mcp-scope__projects"}>
            {rows.map((p) => {
              const why = p.key === fromKey ? null : targetBlocked(p.key);
              return (
                <CheckRow
                  key={p.key}
                  size="grid"
                  checked={!all && projects.includes(p.key)}
                  onChange={(on) => toggle(p.key, on)}
                  disabledReason={why ?? undefined}
                  note={why ?? undefined}
                >
                  {p.label}
                </CheckRow>
              );
            })}
            {rest.length > 0 ? (
              <span ref={moreRef} className="mcp-scope__more">
                <Button size="compact" onClick={() => setOpen(!open)} ariaExpanded={open}>
                  {t("mcp.scope.more")}
                </Button>
              </span>
            ) : null}
          </div>
          {open && anchor ? (
            <ProjectList
              anchor={anchor}
              focusRequest={0}
              projects={rest}
              selected={null}
              sort={places.sort}
              onSort={places.onSort}
              onPick={(key) => {
                if (targetBlocked(key) === null) toggle(key, true);
                setOpen(false);
              }}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </InstallBlock>
        <div className="mcp-scope__agents">
          <span>{t("mcp.scope.agentsLabel")}</span>
          {/* 同自动同步页的目标框（SourceRow.css 的 srcrow__targets），同一种东西两处一个样子 */}
          <button
            type="button"
            ref={agentsRef}
            className={`srcrow__targets${agentsOpen ? " is-open" : ""}`}
            aria-haspopup="menu"
            aria-expanded={agentsOpen}
            aria-label={t("mcp.scope.agentsAria", { name })}
            onClick={() => setAgentsOpen((v) => !v)}
          >
            <span className="srcrow__shown">
              {going.length > 0 ? (
                going.map((a) => (
                  <AgentIcon key={a.id} id={a.iconId} name={a.label} size={13} labelled />
                ))
              ) : (
                <span className="srcrow__pick">{t("mcp.scope.agentsNone")}</span>
              )}
            </span>
            <IconChevronDown className="srcrow__chevron" />
          </button>
          {agentsOpen && agentsRef.current ? (
            <FloatingLayer
              trigger={agentsRef.current}
              onClose={() => setAgentsOpen(false)}
              label={t("mcp.scope.agentsLabel")}
            >
              <Menu maxWidth={280}>
                {agents.map((a) => (
                  <MenuItem
                    key={a.id}
                    kind="check"
                    checked={a.blocked === null && isOn(a.id)}
                    icon={<AgentIcon id={a.iconId} name={a.label} size={14} />}
                    disabledReason={a.blocked ?? undefined}
                    onSelect={() => toggleAgent(a.id)}
                  >
                    {a.label}
                  </MenuItem>
                ))}
              </Menu>
            </FloatingLayer>
          ) : null}
        </div>
        <div className="mcp-scope__cons">
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        {keyTip !== null || keyTracked !== null ? (
          <ScopeKeyHint
            checked={addGitignore}
            onChange={setAddGitignore}
            tip={keyTip}
            tracked={keyTracked}
          />
        ) : null}
      </div>
    </Confirm>
  );
}

/// 确认框正文末尾的 `同时加进 .gitignore`（密钥提醒 S19）：DESIGN-components「勾选行」字号随场景，与紧挨着的正文
/// 同一档——修改生效范围确认框紧挨 13 号的后果那几句（`mcp-scope__cons`），小档；「保留这份」确认框紧挨 15 号的
/// 确认框正文，默认档（`size="list"`）。默认不勾。
/// 解释同安装页，进提示框（悬停这一行、键盘焦点到它时出）。目标文件已被跟踪的不出勾选，在同一个位置说一句
/// （现成的 `Note`，13 `ink-mute`）；两种都有时勾选在上、那一句在下（同安装页 `KeyHintBlock`）
export function ScopeKeyHint({
  checked,
  onChange,
  tip,
  tracked,
  size = "small",
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /// 勾选的提示框文字（`scopeKeyHintTip`）；没有要提醒的为 null，不出勾选
  tip: string | null;
  /// 已被跟踪的那一句（`scopeTrackedNote`）；没有为 null
  tracked?: string | null;
  /// 勾选行的档：与紧挨着的正文同一档（13 号旁小档，15 号确认框正文旁默认档）
  size?: "small" | "list";
}) {
  return (
    <>
      {tip !== null ? (
        <div className="mcp-scope__keyhint">
          <Tooltip content={tip}>
            <CheckRow size={size} checked={checked} onChange={onChange}>
              {t("market.install.addGitignore")}
            </CheckRow>
          </Tooltip>
        </div>
      ) : null}
      {tracked ? (
        <div className="mcp-scope__keynote">
          <Note>{tracked}</Note>
        </div>
      ) : null}
    </>
  );
}
