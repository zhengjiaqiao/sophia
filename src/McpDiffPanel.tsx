import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { McpDiff, McpEndpoint, McpFieldValue } from "./types.ts";
import { listText, t, tn, tRich } from "./i18n.ts";
import { mcpDiffTable } from "./mcpDiffTable.ts";
import {
  Button,
  DiffTable,
  Mono,
  Note,
  Spinner,
  Tooltip,
  TruncTip,
  useBusyShown,
} from "./ui/index.ts";
import "./McpDiffPanel.css";

/// MCP「N 份不一样」的字段级差异（DESIGN「MCP「两份不一样」只标差异」）：该服务行的抽屉里的一段
/// （2026-09-25 评审：名称格只放名字与记号，看差异挪进这一行的抽屉，不再另开一格）。
///
/// - **行优先**（issue #114，画板 #105 第七稿；差异表 `DiffTable`）：一行一份，行首位置名，第一列「原件」
///   （配置文件路径），右边只列**不同的字段**，顺着一列往下比；值用等宽，不同的那一段加粗
///   （不用反色，反色已是「刚变化」）。给了 `onKeep` 时行尾一颗「保留这份」：其余几份改成这一份
/// - headers、env 里的令牌与密钥不显示原值，只写「不同 · 末 4 位」，悬停「出于安全不显示原值」
/// - 值可以选中拷走（D23：路径、id、命令放开文字选取）
/// - 认证头运行时才生成的，如实说比不了，不假装比过
/// - 比不了（取差异出错）时末尾一颗 `在访达中显示 ↗`：离开 Sophia，浅键（↗ 由组件画）；比出来时路径已在表里
///
/// 不碰 api：比对结果由调用方懒取（`api.mcpFieldDiff`）后传进来。
export type McpDiffState = McpDiff | "loading" | Error;

export interface McpDiffPanelProps {
  diff: McpDiffState;
  /// 位置 id → 给人看的一份的名字（`用户级 · Claude Code`，`mcpCopyName`）
  labelOf: (locationId: string) => string;
  /// 位置 id → 它的配置文件路径（「原件」那一列）
  pathOf: (locationId: string) => string | undefined;
  /// 比不了时末尾 `在访达中显示 ↗` 要显示的配置文件；不给就不出这条链
  revealPath?: string;
  onReveal: (path: string) => void;
  /// 行尾「保留这份」：以这一份为准改写其余几份（确认框归调用方）；`revision` 是这张表的指纹（`McpDiff.revision`），
  /// 执行时原样交给 core。不给就没有键那一列
  onKeep?: (locationId: string, revision: string) => void;
}

/// 几个值共同的前缀与后缀长度（不重叠）：不同的那一段加粗
export function commonEnds(texts: string[]): [number, number] {
  if (texts.length < 2) return [0, 0];
  const shortest = Math.min(...texts.map((t) => t.length));
  let pre = 0;
  while (pre < shortest && texts.every((t) => t[pre] === texts[0][pre])) pre += 1;
  let suf = 0;
  while (
    suf < shortest - pre &&
    texts.every((t) => t[t.length - 1 - suf] === texts[0][texts[0].length - 1 - suf])
  )
    suf += 1;
  return [pre, suf];
}

function FieldValue({ value, ends }: { value: McpFieldValue; ends: [number, number] }) {
  if (value.kind === "absent") {
    return <span className="mcp-diff__absent">{t("mcp.diff.absent")}</span>;
  }
  if (value.kind === "secret") {
    return (
      <Tooltip content={t("mcp.diff.secretTip")} focusable>
        <span className="mcp-diff__secret">
          {value.last4 !== null
            ? tRich("mcp.diff.secretLast4", { tail: <Mono inherit>{`…${value.last4}`}</Mono> })
            : t("mcp.diff.secretDiffer")}
        </span>
      </Tooltip>
    );
  }
  const [pre, suf] = ends;
  const text = value.text;
  const mid = text.slice(pre, text.length - suf);
  // 整段一块等宽（可选中拷走）：不同的那一段加粗
  return (
    <Mono inherit>
      {pre > 0 ? text.slice(0, pre) : null}
      {mid ? <b>{mid}</b> : null}
      {suf > 0 ? text.slice(text.length - suf) : null}
    </Mono>
  );
}

export function McpDiffPanel({
  diff,
  labelOf,
  pathOf,
  revealPath,
  onReveal,
  onKeep,
}: McpDiffPanelProps) {
  const revealLink = revealPath ? (
    <div className="mcp-diff__foot">
      <Button variant="quiet" onClick={() => onReveal(revealPath)}>
        {t("mcp.diff.reveal")}
      </Button>
    </div>
  ) : null;
  if (diff === "loading") return <Comparing />;
  if (diff instanceof Error) {
    return (
      <div className="mcp-diff">
        <DiffNote>{t("mcp.diff.failed", { message: diff.message })}</DiffNote>
        {revealLink}
      </div>
    );
  }
  const table = mcpDiffTable(diff);
  // 每一列各自比：几份都是可以原样显示的值时，不同的那一段加粗
  const ends = table.fields.map((_, j) => {
    const values = table.rows.map((row) => row.values[j]);
    const plain = values.flatMap((v) => (v.kind === "plain" ? [v.text] : []));
    return plain.length === values.length ? commonEnds(plain) : ([0, 0] as [number, number]);
  });
  return (
    <div className="mcp-diff">
      {table.rows.length > 0 ? (
        <DiffTable
          label={tn("mcp.differ.tag", diff.locationIds.length)}
          fields={[
            t("mcp.detail.origin"),
            ...table.fields.map((field) => <Mono inherit>{field}</Mono>),
          ]}
          rows={table.rows.map((row) => ({
            id: row.id,
            place: labelOf(row.id),
            values: [
              <Mono path>{pathOf(row.id) ?? ""}</Mono>,
              ...row.values.map((value, j) => <FieldValue value={value} ends={ends[j]} />),
            ],
            actionDisabledReason: row.blocked
              ? t("mcp.keep.blocked", {
                  place: labelOf(row.blocked.locationId),
                  message: row.blocked.message,
                })
              : undefined,
            actionAriaLabel: t("mcp.keep.aria", { place: labelOf(row.id), name: diff.name }),
          }))}
          actionLabel={onKeep && table.keep ? t("mcp.keep.key") : undefined}
          onAction={onKeep && ((id) => onKeep(id, diff.revision))}
        />
      ) : null}
      {diff.fields.length === 0 && !diff.dynamicAuth ? (
        <DiffNote>{t("mcp.diff.agentOnly")}</DiffNote>
      ) : null}
      {diff.dynamicAuth ? <DiffNote>{t("mcp.pick.dynamicAuth")}</DiffNote> : null}
      {diff.unreadable.length > 0 ? (
        <DiffNote>
          {t("mcp.diff.unreadable", {
            locations: listText(diff.unreadable.map(labelOf)),
          })}
        </DiffNote>
      ) : null}
      {revealLink}
    </div>
  );
}

/// 行详情抽屉里「N 份不一样」的那一段：抽屉拉开时挂上，挂上时比对一次（调用方给 `api.mcpFieldDiff`；
/// 这个文件不碰 api）。段首一行小标说这一段是什么，下面是 `McpDiffPanel`
export function McpDiffSection({
  name,
  locationIds,
  load,
  labelOf,
  pathOf,
  revealPath,
  onReveal,
  onKeep,
  reloadKey,
}: {
  name: string;
  /// 定义不一样的那几处位置
  locationIds: string[];
  load: (name: string, locationIds: string[]) => Promise<McpDiff>;
  /// 变了就重新比对一次（重扫之后：位置没变、定义可能变了）
  reloadKey?: unknown;
} & Omit<McpDiffPanelProps, "diff">) {
  const [diff, setDiff] = useState<McpDiffState>("loading");
  // 数组每次渲染都是新的：按内容比
  const ids = locationIds.join("\n");
  // 比的还是同一个服务、同几处（只是重扫了）时，新结果回来之前留着旧的表，不闪回「正在比对」
  const shown = useRef("");
  useEffect(() => {
    let alive = true;
    const what = `${name}\n${ids}`;
    if (shown.current !== what) setDiff("loading");
    shown.current = what;
    load(name, ids.split("\n")).then(
      (found) => alive && setDiff(found),
      (e) => alive && setDiff(new Error(String(e))),
    );
    return () => {
      alive = false;
    };
  }, [name, ids, load, reloadKey]);
  return (
    <div className="mcp-diff-section">
      <div className="mcp-diff__title">{tn("mcp.differ.tag", locationIds.length)}</div>
      <McpDiffPanel
        diff={diff}
        labelOf={labelOf}
        pathOf={pathOf}
        revealPath={revealPath}
        onReveal={onReveal}
        onKeep={onKeep}
      />
    </div>
  );
}

/// 差异段里的一句灰字（`Note`）：与上面隔 6
function DiffNote({ children }: { children: ReactNode }) {
  return (
    <div className="mcp-diff__note">
      <Note>{children}</Note>
    </div>
  );
}

/// 点开之后在取差异：过了 0.3 秒门槛才出忙碌指示 + 一句（更快取回的什么都不闪）；之前留一行空白占位
function Comparing() {
  const shown = useBusyShown(true);
  return (
    <div className="mcp-diff">
      <div className="mcp-diff__note" role="status">
        <Note>
          {shown ? (
            <span className="mcp-diff__busy">
              <Spinner size={14} label={t("mcp.diff.comparing")} />
              {t("mcp.diff.comparing")}
            </span>
          ) : (
            "\u00a0"
          )}
        </Note>
      </div>
    </div>
  );
}

/// 行详情的 `命令` / `地址` 一行（DESIGN「点名字展开 › MCP 键值三行」）：展开时才挂上，挂上时读一次
/// 原件那一处的定义（`mcp_endpoint`，只读，凭据已在 core 脱敏）。读回来之前、读不出来时不写这一行，
/// 不写「读取中」「未知」——读本机文件是毫秒级，闪一下占位是噪音。值 mono、可选中、截断才提示
export function McpEndpointRow({
  name,
  locationId,
  load,
  reloadKey,
}: {
  name: string;
  locationId: string;
  /// 读单份定义（调用方给 `api.mcpEndpoint`；这个文件不碰 api）
  load: (name: string, locationId: string) => Promise<McpEndpoint | null>;
  /// 变了就重读一次（重扫之后：「保留这份」可能改了原件那一处）；读回来之前留着旧值
  reloadKey?: unknown;
}) {
  const [endpoint, setEndpoint] = useState<McpEndpoint | null>(null);
  const shown = useRef("");
  useEffect(() => {
    let alive = true;
    const what = `${name}\n${locationId}`;
    if (shown.current !== what) setEndpoint(null);
    shown.current = what;
    load(name, locationId).then(
      (found) => alive && setEndpoint(found),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [name, locationId, load, reloadKey]);
  if (endpoint === null) return null;
  return (
    <>
      <span className="mx-kv__key">
        {endpoint.kind === "url" ? t("mcp.diff.endpointUrl") : t("mcp.diff.endpointCommand")}
      </span>
      <span className="mx-kv__value">
        <TruncTip content={<Mono inherit>{endpoint.text}</Mono>}>
          <Mono>{endpoint.text}</Mono>
        </TruncTip>
      </span>
    </>
  );
}
