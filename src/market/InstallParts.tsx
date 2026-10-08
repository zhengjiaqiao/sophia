/// 安装类推入页（安装页 06 / 09、从链接安装 07、粘贴 MCP 配置 10）共用的几块（DESIGN「发现与安装 › 安装页」）：
/// `生效范围`（复用位置页筛选行的胶囊，去掉 `全部`）+ 结果一句与落点路径、勾选行网格、`要填的` 表单、勾选列表的一行、贴底一行。
/// 只吃 props；带业务状态的钩子在 `useInstall.ts`。
import { useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { t, tRich } from "../i18n.ts";
import {
  AgentIcon,
  BusySlot,
  Button,
  CheckRow,
  Checkbox,
  Chip,
  ChipRow,
  FadeViewport,
  FloatingToast,
  Mono,
  Note,
  NoticePanel,
  SectionLabel,
  Tag,
  TextField,
  Toast,
  Tooltip,
  TruncTip,
  useEdgeFades,
} from "../ui/index.ts";
import { FilterRow } from "../FilterRow.tsx";
import type { ScopeProject } from "../scopeView.ts";
import type { ProjectSort } from "../sidebarProjects.ts";
import type { ToastText } from "../toastText.ts";
import type { ClaudeCodeScope, LocationKey, McpFieldSpec } from "../types.ts";
import {
  downloadTip,
  fieldTag,
  fieldText,
  landingParts,
  landingTip,
  locationOfNav,
  navOfLocation,
  type AgentRef,
  type DownloadSource,
} from "./installView.ts";
import { copyDetails } from "../diagnostics.ts";
import type { SkillDownloadFailure } from "../netFailure.ts";
import "./install.css";

/// 下载 skill 失败（spec #248、issue #253）：网络那三类（连不上、超时、限流）是灰面板——左端 `!` 看原文、
/// 按类说的主句、「开着代理再试一次」；别的（仓库或分支不在、仓库太大、压缩包解压失败）带原文时同一块灰面板、
/// 不给键（再试一次结果一样，#335），没有原文时照旧一行字，`className` 是那一行的样子
export function DownloadFailure({
  failure,
  className,
  onRetry,
}: {
  failure: SkillDownloadFailure;
  className: string;
  onRetry: () => void;
}) {
  if (!failure.retryWithProxy && !failure.detail)
    return <p className={className}>{failure.message}</p>;
  return (
    <div className="install-failure">
      <NoticePanel
        scope="section"
        message={failure.message}
        technical={failure.detail ?? undefined}
        onCopy={(text) => copyDetails(text)}
        action={
          failure.retryWithProxy
            ? { label: t("common.net.retryWithProxy"), onClick: onRetry }
            : undefined
        }
      />
    </div>
  );
}

/// 位置胶囊要的项目（与位置页筛选行同一份数据，调用方从壳里拿）
export interface InstallPlaces {
  /// 按最近活跃排好的项目（胶囊取前几个）
  recent: ReadonlyArray<ScopeProject>;
  /// 按用户选的排序排好的项目（「更多」列表）
  sorted: ReadonlyArray<ScopeProject>;
  sort: ProjectSort;
  onSort: (sort: ProjectSort) => void;
}

/// 区块：区块小标（下 7 一条 hairline）+ 内容
export function InstallBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="install-block">
      <SectionLabel rule>{label}</SectionLabel>
      <div className="install-block__body">{children}</div>
    </section>
  );
}

/// `生效范围`：与 `我的` 筛选行同一种单选胶囊，去掉 `全部`（R9）；悬停项目胶囊，提示框出这个位置的完整落点。
/// `name`：给了（装一个时是名字，几个时是 null）就在胶囊下写两行——结果一句（13 `ink`：`所有项目都能用` /
/// `只在 CardBox 中能用`）+ 落点路径（等宽 12 `ink-faint`，常显，#275）；不给（MCP）就不写。
/// `blocked`：落点已有同名的（`用户级的通用仓库里已经有 pdf` + `在访达中显示 ↗`）
export function PlaceBlock({
  places,
  value,
  onChange,
  name,
  blocked,
  onReveal,
}: {
  places: InstallPlaces;
  value: LocationKey;
  onChange: (key: LocationKey) => void;
  name?: string | null;
  blocked?: { reason: string; path: string } | null;
  onReveal?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const landing =
    name === undefined
      ? null
      : landingParts(value, name, (key) => places.sorted.find((p) => p.key === key)?.label);
  return (
    <InstallBlock label={t("market.install.blockPlace")}>
      <FilterRow
        recent={places.recent}
        sorted={places.sorted}
        location={navOfLocation(value)}
        onLocation={(l) => onChange(locationOfNav(l))}
        sort={places.sort}
        onSort={places.onSort}
        listOpen={open}
        listFocus={0}
        onListOpen={setOpen}
        all={false}
        rowLabel={null}
        tipOf={(p) => landingTip(p.path, name ?? null)}
      />
      {landing ? (
        <div className="install-landing">
          <p className="install-landing__result">{landing.result}</p>
          <p className="install-landing__path">
            <Mono>{landing.path}</Mono>
          </p>
        </div>
      ) : null}
      {blocked ? (
        <p className="install-blocked">
          {/* 句后浅键：不垫底，与句子之间一个「 · 」（2026-10-06）；`·` 跟着键走、不留在行尾 */}
          <span>
            {blocked.reason}
            {" ·\u00a0"}
            <Button variant="quiet" inline onClick={() => onReveal?.(blocked.path)}>
              {t("market.install.reveal")}
            </Button>
          </span>
        </p>
      ) : null}
    </InstallBlock>
  );
}

/// 项目位置里 Claude Code 写到哪一格的选择（R8）：位置是用户级时不给（用户级本来就只给自己）
export function claudeScopeChoice(
  places: InstallPlaces,
  location: LocationKey,
  value: ClaudeCodeScope,
  onChange: (next: ClaudeCodeScope) => void,
):
  { value: ClaudeCodeScope; onChange: (next: ClaudeCodeScope) => void; place: string } | undefined {
  if (location === "global") return undefined;
  const place =
    places.sorted.find((p) => p.key === location)?.label ?? t("market.install.thisProject");
  return { value, onChange, place };
}

/// 一行勾选行此刻的样子：名字后那一句，与不能勾的原因；`path`（MCP）：这个 agent 的配置文件，悬停这一行出
/// `写入 ~/.codex/config.toml`（第二层，#276；不能勾的行悬停出原因，不出它）
export interface AgentRowView {
  note?: string;
  disabledReason?: string;
  path?: string;
  /// 原因背后的精确值（第二层，等宽）：悬停这一行时在原因或 `写入 <路径>` 下另起一行
  detail?: string;
}

/// `给谁用`：勾选行（勾选框 + agent 图标 + 名字 + 名字后一句），两列或一列（粘贴 MCP 配置：
/// 放得下原因句）。不能勾的行画成没勾
export function AgentChecks({
  rows,
  checked,
  onToggle,
  viewOf,
  columns = 2,
  claudeScope,
}: {
  rows: ReadonlyArray<AgentRef>;
  checked: ReadonlyArray<string>;
  onToggle: (id: string, on: boolean) => void;
  viewOf: (id: string) => AgentRowView;
  columns?: 1 | 2;
  /// 位置是项目时：Claude Code 写到哪一格（spec 2026-09-30-mcp-claude-self-team R8）。不给＝不出选择（用户级）
  claudeScope?: {
    value: ClaudeCodeScope;
    onChange: (next: ClaudeCodeScope) => void;
    place: string;
  };
}) {
  const scoped =
    claudeScope !== undefined &&
    checked.includes("claude-code") &&
    viewOf("claude-code").disabledReason === undefined;
  return (
    <>
      <div className={columns === 1 ? "install-agents install-agents--one" : "install-agents"}>
        {rows.map((a) => {
          const view = viewOf(a.id);
          const disabled = view.disabledReason !== undefined;
          const check = (
            <CheckRow
              key={a.id}
              size="grid"
              checked={!disabled && checked.includes(a.id)}
              onChange={(on) => onToggle(a.id, on)}
              icon={<AgentIcon id={a.id} name={a.name} />}
              note={view.note}
              disabledReason={view.disabledReason}
              reasonDetail={view.detail ? <Mono inherit>{view.detail}</Mono> : undefined}
              label={a.name}
            >
              {a.name}
            </CheckRow>
          );
          const writesTo = view.path
            ? tRich("market.mcp.writesTo", { path: <Mono inherit>{view.path}</Mono> })
            : null;
          const detail = view.detail ? <Mono inherit>{view.detail}</Mono> : null;
          const row =
            (writesTo || detail) && !disabled ? (
              <Tooltip
                key={a.id}
                content={
                  writesTo && detail ? (
                    <>
                      <div>{writesTo}</div>
                      <div>{detail}</div>
                    </>
                  ) : (
                    (writesTo ?? detail)
                  )
                }
              >
                {check}
              </Tooltip>
            ) : (
              check
            );
          // 勾选行是一颗键，单选片不能放在它里面：并排放在同一格，紧跟名字
          return scoped && a.id === "claude-code" ? (
            <div key={a.id} className="install-scope">
              {row}
              <ChipRow
                listLabel={t("market.install.claudeScopeLabel", { agent: "Claude Code" })}
                wrap={false}
              >
                <Chip
                  selected={claudeScope.value === "self"}
                  onClick={() => claudeScope.onChange("self")}
                >
                  {t("mcp.claude.selfScope")}
                </Chip>
                <Chip
                  selected={claudeScope.value === "team"}
                  onClick={() => claudeScope.onChange("team")}
                >
                  {t("mcp.claude.teamScope")}
                </Chip>
              </ChipRow>
            </div>
          ) : (
            row
          );
        })}
      </div>
      {scoped ? (
        <p className="install-scope__hint">
          {t("market.install.scopeHint", { place: claudeScope.place, file: ".mcp.json" })}
        </p>
      ) : null}
    </>
  );
}

/// skill 的 `给谁用`（2026-09-27 产品负责人：直接读通用仓库的 agent 不用勾，告诉用户它们会读，其余再勾——
/// 同 `npx skills` 的 Universal 一组）：上面一句 `这些 agent 直接读取这个文件夹，无需选择` + 一排图标与名字（不能点）；
/// 下面其余 agent 的勾选行，有上面一组时加小标 `同时加到`（#275：不说「链接给」，这一页还有「从链接安装」）。直接读取的照样放进安装请求（计划里它们不建链接）。
/// 用户级只有 Cline 这类读 `~/.agents/skills`；项目里 Codex、Cursor、Gemini CLI 等都读 `.agents/skills`
export function SkillAgents({
  rows,
  direct,
  checked,
  onToggle,
  viewOf = () => ({}),
}: {
  rows: ReadonlyArray<AgentRef>;
  direct: ReadonlyArray<string>;
  checked: ReadonlyArray<string>;
  onToggle: (id: string, on: boolean) => void;
  /// 那里已有同名的那一行不能勾、名字后说原因（M14）
  viewOf?: (id: string) => AgentRowView;
}) {
  const readers = rows.filter((a) => direct.includes(a.id));
  const others = rows.filter((a) => !direct.includes(a.id));
  return (
    <>
      {readers.length > 0 ? (
        <div className="install-direct">
          <p className="install-direct__say">{t("market.install.directSay")}</p>
          <ul className="install-direct__list">
            {readers.map((a) => (
              <li key={a.id} className="install-direct__item">
                <AgentIcon id={a.id} name={a.name} />
                <span>{a.name}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {others.length > 0 ? (
        <>
          {readers.length > 0 ? (
            <p className="install-direct__more">{t("market.install.alsoAdd")}</p>
          ) : null}
          <AgentChecks rows={others} checked={checked} onToggle={onToggle} viewOf={viewOf} />
        </>
      ) : null}
    </>
  );
}

/// `要填的`（R10；#276）：两列——左：标签（目录里的说明，`ink`）+ 下一行 `必填 · 密钥` 与键名（等宽 12 `ink-faint`）；
/// 没有说明时标签就是键名（等宽），不再另写一遍。右：输入框（密钥遮住，眼睛看一眼），说明的后半句常显在框下
/// （不放占位里：一打字就没了）。块下一句 `密钥只保存在所选 agent 中，Sophia 不保留`
export function FieldsBlock({
  fields,
  values,
  onChange,
  footer,
}: {
  fields: ReadonlyArray<McpFieldSpec>;
  values: Readonly<Record<string, string>>;
  onChange: (key: string, value: string) => void;
  /// 说明句下面、这一块的最后（「同时加进 .gitignore」）
  footer?: ReactNode;
}) {
  return (
    <InstallBlock label={t("market.install.blockFields")}>
      <div className="install-fields">
        {fields.map((f) => {
          const id = `install-field-${f.key}`;
          const text = fieldText(f);
          return (
            <div key={f.key} className="install-field">
              <label className="install-field__label" id={`${id}-label`} htmlFor={id}>
                {text.keyed ? <Mono inherit>{text.label}</Mono> : <span>{text.label}</span>}
                <span className="install-field__meta">
                  <Tag tone="weak">{fieldTag(f)}</Tag>
                  {text.keyed ? null : <Mono>{f.key}</Mono>}
                </span>
              </label>
              <div className="install-field__input">
                <TextField
                  id={id}
                  labelledBy={`${id}-label`}
                  value={values[f.key] ?? ""}
                  onChange={(v) => onChange(f.key, v)}
                  type={f.secret ? "password" : "text"}
                  revealable={f.secret}
                  mono
                  spellCheck={false}
                  autoComplete="off"
                />
                {text.help ? <p className="install-field__help">{text.help}</p> : null}
              </div>
            </div>
          );
        })}
      </div>
      <p className="install-fields__note">{t("market.install.fieldsNote")}</p>
      {footer}
    </InstallBlock>
  );
}

/// 密钥提醒（S19，spec 2026-10-05-skill-mcp-batch2）：往 git 仓库里的项目文件写像密钥的值时，一个默认不勾的
/// 勾选行「同时加进 .gitignore」。解释不常显，进提示框（悬停这一行、键盘焦点到它时出）：哪几个文件在仓库里、
/// 不加会怎样、勾上加哪几行（`keyHintTip`）。放在 `要填的` 最后——先填密钥，再决定要不要加；没有那一块时放在
/// `给谁用` 最后。想自用的人勾一下，想共享给队友的不受影响。
/// 目标文件已被 git 跟踪的（`tracked`，加进 .gitignore 也挡不住）不出勾选，在同一个位置说一句（现成的 `Note`，
/// 13 `ink-mute`；产品负责人 2026-10-06）；两种都有时勾选在上、那一句在下
export function KeyHintBlock({
  checked,
  onChange,
  tip,
  tracked,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /// 勾选的提示框文字（`keyHintTip`）；没有要提醒的为 null，不出勾选
  tip: string | null;
  /// 已被跟踪的那一句（`keyTrackedNote`）；没有为 null
  tracked: string | null;
}) {
  return (
    <>
      {tip !== null ? (
        <div className="install-keyhint">
          <Tooltip content={tip}>
            <CheckRow size="small" checked={checked} onChange={onChange}>
              {t("market.install.addGitignore")}
            </CheckRow>
          </Tooltip>
        </div>
      ) : null}
      {tracked !== null ? (
        <div className="install-keyhint-note">
          <Note>{tracked}</Note>
        </div>
      ) : null}
    </>
  );
}

/// 勾选列表的一行（从链接安装的 skill、粘贴 MCP 配置的 MCP）：勾选框 + 名字 + 一句（等宽）+ 可选行尾动作。
/// 整行可点（行里的键与输入框除外）；不能勾的行平贴、不回应悬停，原因写在那一句的位置
export function PickRow({
  checked,
  onChange,
  name,
  label,
  detail,
  blocked,
  action,
  tip,
  pinned = false,
}: {
  /// `"mixed"`＝半选（只有全选那一行用：选了一部分）
  checked: boolean | "mixed";
  onChange: (next: boolean) => void;
  /// 名字；要现起名字时是一个输入框
  name: ReactNode;
  /// 读屏名
  label: string;
  /// 名字后那一句：路径、连接方式（等宽）
  detail?: ReactNode;
  /// 不能勾的原因（`用户级的通用仓库里已经有 pdf`），写在那一句的位置
  blocked?: string | null;
  /// 行尾动作（`在访达中显示 ↗`）
  action?: ReactNode;
  /// 悬停名字时的提示框（第二层：从链接安装每行的仓库内路径，等宽）；不能勾的行也出
  tip?: ReactNode;
  /// 钉在列表顶上、不随列表滚走（全选那一行）
  pinned?: boolean;
}) {
  const disabled = Boolean(blocked);
  const onRow = (e: MouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    const target = e.target as Element;
    if (target.closest("button, input, textarea, a, label")) return;
    // 半选时点行同点框：全选
    onChange(checked !== true);
  };
  const classes = ["install-pick"];
  if (disabled) classes.push("is-blocked");
  if (pinned) classes.push("is-pinned");
  return (
    <div className={classes.join(" ")} data-checkrow={disabled ? undefined : ""} onClick={onRow}>
      <span className="install-pick__box">
        <Checkbox
          checked={!disabled && checked}
          onChange={onChange}
          label={label}
          disabledReason={blocked ?? undefined}
        />
      </span>
      {/* 没有提示框时包层不占盒（display: contents），名字一列照旧定宽 */}
      <Tooltip content={tip}>
        <span className="install-pick__name">{name}</span>
      </Tooltip>
      <span className="install-pick__detail">{blocked ?? detail}</span>
      {action ? <span className="install-pick__action">{action}</span> : null}
    </div>
  );
}

/// 自己滚的勾选列表：露 6 行半，被切掉的半行就是「下面还有」——**不加渐隐**（渐隐会把最后一行画成禁用的样子）
export function PickList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="install-picklist" role="group" aria-label={label}>
      {children}
    </div>
  );
}

/// 推入页的滚动区（贴底行上面那一块）：上下被裁掉时边缘渐隐
export function InstallScroll({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const fade = useEdgeFades(ref);
  return (
    <FadeViewport fade={fade} tone="face" className="install-scroll-fade">
      <div ref={ref} className="install-scroll">
        <div className="install-scroll__inner">{children}</div>
      </div>
    </FadeViewport>
  );
}

/// 悬停贴底那一句（skill，#275）出的提示框：`codeload.github.com · 分支 main`，主机名与分支等宽；分支不知道时只写主机名
export function DownloadTip({
  source,
  branch,
}: {
  source: DownloadSource | null;
  branch: string | null;
}) {
  const tip = downloadTip(source, branch);
  const host = <Mono inherit>{tip.host}</Mono>;
  if (tip.branch === null) return host;
  return (
    <>{tRich("market.install.downloadTip", { host, branch: <Mono inherit>{tip.branch}</Mono> })}</>
  );
}

/// 做不成时浮在主动作上方那一窗（8 秒，悬停停表）
export interface InstallFailure {
  key: number;
  toast: ToastText;
}

/// 贴底一行：左边灰字一句去向（skill：`从 GitHub 下载 · 2.1 MB`，悬停出 `tip`——主机名与分支，#275；
/// MCP 不写：勾选行已经说清给谁了，#276）；右边 `取消`（默认键）+ 8 + 墨键主动作。主动作不能按时带原因；
/// 在装时原位换成刻度 + 一句
export function InstallFooter({
  line = "",
  tip,
  label,
  block,
  busy,
  busyLabel,
  failure,
  onDismissFailure,
  onCancel,
  onSubmit,
}: {
  line?: string;
  /// 悬停那一句出的提示框（第二层）；不给时只在一行放不下被截断时出全句
  tip?: ReactNode;
  label: string;
  block: string | null;
  busy: boolean;
  busyLabel: string;
  failure: InstallFailure | null;
  onDismissFailure: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  // 第一层没有要等宽的读数（「GitHub」是名字、大小是正文里的数）；主机名与分支在提示框里等宽
  const lineText = <span className="install-foot__line">{line}</span>;
  return (
    <div className="install-foot">
      {tip ? (
        <span className="install-foot__lead">
          <Tooltip content={tip} placement="top" fit="shrink" focusable>
            {lineText}
          </Tooltip>
        </span>
      ) : (
        // 一行放不下截断时悬停出全句（不写原生 title：悬停弹系统灰框）
        <TruncTip content={line} fit="grow">
          {lineText}
        </TruncTip>
      )}
      <span className="install-foot__keys">
        <Button size="row" onClick={onCancel}>
          {t("market.action.cancel")}
        </Button>
        <span className="install-foot__primary">
          {failure ? (
            <FloatingToast key={failure.key} align="end">
              <Toast {...failure.toast} onDismiss={onDismissFailure} onClose={onDismissFailure} />
            </FloatingToast>
          ) : null}
          {busy ? (
            <BusySlot busy label={busyLabel} className="install-foot__busy">
              <Button variant="primary" size="row">
                {label}
              </Button>
            </BusySlot>
          ) : block ? (
            <Button variant="primary" size="row" disabled disabledReason={block}>
              {label}
            </Button>
          ) : (
            <Button variant="primary" size="row" onClick={onSubmit}>
              {label}
            </Button>
          )}
        </span>
      </span>
    </div>
  );
}

/// 来历一行：`来自 <作者>`（skill，#307）/ 发布方（MCP）· 句后浅键（`在 GitHub 打开 ↗` / `查看说明 ↗`，不垫底）。
/// 一段带 `tip` 时悬停出它（skill 的 `owner/repo · 仓库内路径`）；浅键带 `tip` 时同样（MCP 的包名，#276）
export function OriginLine({
  parts,
  leave,
}: {
  parts: ReadonlyArray<{ text: string; tip?: ReactNode }>;
  leave?: { label: string; onClick: () => void; tip?: ReactNode } | null;
}) {
  return (
    <p className="install-origin">
      {parts.map((p, i) => (
        <span key={i} className="install-origin__part">
          {i > 0 ? <span className="install-origin__dot">·</span> : null}
          {p.tip ? (
            <Tooltip content={p.tip} focusable>
              <span>{p.text}</span>
            </Tooltip>
          ) : (
            <span>{p.text}</span>
          )}
        </span>
      ))}
      {/* 末尾的外链是这一行的最后一项：句后浅键，不垫底，同样一个 · 隔开（2026-10-06） */}
      {leave ? (
        <span className="install-origin__part">
          <span className="install-origin__dot">·</span>
          <Tooltip content={leave.tip ?? null}>
            <Button variant="quiet" inline onClick={leave.onClick}>
              {leave.label}
            </Button>
          </Tooltip>
        </span>
      ) : null}
    </p>
  );
}
