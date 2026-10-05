/// 安装类推入页（安装页 06 / 09、从链接安装 07、从 JSON 添加 10）共用的几块（DESIGN「发现与安装 › 安装页」）：
/// `位置`（复用位置页筛选行的胶囊，去掉 `全部`）+ 落点行、勾选行网格、`要填的` 表单、勾选列表的一行、贴底一行。
/// 只吃 props；带业务状态的钩子在 `useInstall.ts`。
import { useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { t, tRich, tSpaced } from "../i18n.ts";
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
  SectionLabel,
  Tag,
  TextField,
  Toast,
  useEdgeFades,
} from "../ui/index.ts";
import { FilterRow } from "../FilterRow.tsx";
import type { ScopeProject } from "../scopeView.ts";
import type { ProjectSort } from "../sidebarProjects.ts";
import type { ToastText } from "../toastText.ts";
import type { ClaudeCodeScope, LocationKey, McpFieldSpec } from "../types.ts";
import {
  fieldTag,
  footRuns,
  landingParts,
  landingTip,
  locationOfNav,
  navOfLocation,
  type AgentRef,
} from "./installView.ts";
import "./install.css";

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

/// `位置`：与 `我的` 筛选行同一种单选胶囊，去掉 `全部`（R9）；悬停项目胶囊，提示框出这个位置的完整落点。
/// `name`：给了（装一个时是名字，几个时是 null）就在胶囊下写落点行；不给（MCP）就不写。
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
  const landing = name === undefined ? null : landingParts(value, name);
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
        <p className="install-landing">
          {/* 目录里这一句用不换行空格（原来的 &nbsp;）：「装到」、路径、「·」之间不折行 */}
          {tRich("market.install.landingLineKept", {
            path: <Mono inherit>{landing.path}</Mono>,
            note: landing.note,
          })}
        </p>
      ) : null}
      {blocked ? (
        <p className="install-blocked">
          <span>{blocked.reason}</span>
          <Button variant="quiet" onClick={() => onReveal?.(blocked.path)}>
            {t("market.install.reveal")}
          </Button>
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

/// 一行勾选行此刻的样子：名字后那一句，与不能勾的原因
export interface AgentRowView {
  note?: string;
  disabledReason?: string;
}

/// `给谁用` / `写进哪些 agent`：勾选行（勾选框 + agent 图标 + 名字 + 名字后一句），两列或一列（从 JSON 添加：
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
          const row = (
            <CheckRow
              key={a.id}
              size="grid"
              checked={!disabled && checked.includes(a.id)}
              onChange={(on) => onToggle(a.id, on)}
              icon={<AgentIcon id={a.id} name={a.name} />}
              note={view.note}
              disabledReason={view.disabledReason}
              label={a.name}
            >
              {a.name}
            </CheckRow>
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
          {tSpaced("market.install.scopeHint", { place: claudeScope.place, file: ".mcp.json" })}
        </p>
      ) : null}
    </>
  );
}

/// skill 的 `给谁用`（2026-09-27 产品负责人：直接读通用仓库的 agent 不用勾，告诉用户它们会读，其余再勾——
/// 同 `npx skills` 的 Universal 一组）：上面一句 `这些 agent 直接读取这个文件夹，不用选` + 一排图标与名字（不能点）；
/// 下面其余 agent 的勾选行，有上面一组时加小标 `另外链接给`。直接读取的照样放进安装请求（计划里它们不建链接）。
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
            <p className="install-direct__more">{t("market.install.alsoLink")}</p>
          ) : null}
          <AgentChecks rows={others} checked={checked} onToggle={onToggle} viewOf={viewOf} />
        </>
      ) : null}
    </>
  );
}

/// `要填的`（R10）：两列——左：键名（等宽 `ink`）+ 下一行 `必填 · 密钥`；右：输入框（密钥遮住，眼睛看一眼）。
/// 下面一句 `只写进勾选的 agent 的配置文件，Sophia 自己不存`
export function FieldsBlock({
  fields,
  values,
  onChange,
}: {
  fields: ReadonlyArray<McpFieldSpec>;
  values: Readonly<Record<string, string>>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <InstallBlock label={t("market.install.blockFields")}>
      <div className="install-fields">
        {fields.map((f) => {
          const id = `install-field-${f.key}`;
          return (
            <div key={f.key} className="install-field">
              <label className="install-field__label" id={`${id}-label`} htmlFor={id}>
                <Mono inherit>{f.key}</Mono>
                <Tag tone="weak">{fieldTag(f)}</Tag>
              </label>
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
                placeholder={f.description ?? undefined}
              />
            </div>
          );
        })}
      </div>
      <p className="install-fields__note">{t("market.install.fieldsNote")}</p>
    </InstallBlock>
  );
}

/// 勾选列表的一行（从链接安装的 skill、从 JSON 添加的 MCP）：勾选框 + 名字 + 一句（等宽）+ 可选行尾动作。
/// 整行可点（行里的键与输入框除外）；不能勾的行平贴、不回应悬停，原因写在那一句的位置
export function PickRow({
  checked,
  onChange,
  name,
  label,
  detail,
  blocked,
  action,
}: {
  checked: boolean;
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
}) {
  const disabled = Boolean(blocked);
  const onRow = (e: MouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    const target = e.target as Element;
    if (target.closest("button, input, textarea, a, label")) return;
    onChange(!checked);
  };
  return (
    <div
      className={disabled ? "install-pick is-blocked" : "install-pick"}
      data-checkrow={disabled ? undefined : ""}
      onClick={onRow}
    >
      <span className="install-pick__box">
        <Checkbox
          checked={!disabled && checked}
          onChange={onChange}
          label={label}
          disabledReason={blocked ?? undefined}
        />
      </span>
      <span className="install-pick__name">{name}</span>
      <span className="install-pick__detail">{blocked ?? detail}</span>
      {action ? <span className="install-pick__action">{action}</span> : null}
    </div>
  );
}

/// 自己滚的勾选列表：露 4 行半，被切掉的半行就是「下面还有」——**不加渐隐**（渐隐会把最后一行画成禁用的样子）
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

/// 做不成时浮在主动作上方那一窗（8 秒，悬停停表）
export interface InstallFailure {
  key: number;
  toast: ToastText;
}

/// 贴底一行：左边等宽灰字一句去向（`从 codeload.github.com 下载 · main · 2.1 MB` / `写进 3 个配置文件`）；
/// 右边 `取消`（默认键）+ 8 + 墨键主动作。主动作不能按时带原因；在装时原位换成刻度 + 一句
export function InstallFooter({
  line,
  label,
  block,
  busy,
  busyLabel,
  failure,
  onDismissFailure,
  onCancel,
  onSubmit,
}: {
  line: string;
  label: string;
  block: string | null;
  busy: boolean;
  busyLabel: string;
  failure: InstallFailure | null;
  onDismissFailure: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="install-foot">
      <span className="install-foot__line" title={line}>
        {footRuns(line).map((run, i) =>
          run.mono ? (
            <Mono key={i} inherit>
              {run.text}
            </Mono>
          ) : (
            <span key={i}>{run.text}</span>
          ),
        )}
      </span>
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

/// 来历一行：等宽的仓库 / 包名 · 仓库内路径 + 离开键（`在 GitHub 打开 ↗`）
export function OriginLine({
  parts,
  leave,
}: {
  /// 各段：`mono` 为真的等宽（仓库、路径、包名），否则是正文（发布方）
  parts: ReadonlyArray<{ text: string; mono?: boolean; strong?: boolean }>;
  leave?: { label: string; onClick: () => void } | null;
}) {
  return (
    <p className="install-origin">
      {parts.map((p, i) => (
        <span key={i} className="install-origin__part">
          {i > 0 ? <span className="install-origin__dot">·</span> : null}
          {p.mono ? (
            <span className={p.strong ? "install-origin__mono is-strong" : "install-origin__mono"}>
              <Mono inherit>{p.text}</Mono>
            </span>
          ) : (
            <span>{p.text}</span>
          )}
        </span>
      ))}
      {leave ? (
        <Button variant="quiet" onClick={leave.onClick}>
          {leave.label}
        </Button>
      ) : null}
    </p>
  );
}
