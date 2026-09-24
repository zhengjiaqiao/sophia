import { useEffect, useState } from "react";
import type { McpDiff, McpEndpoint, McpFieldValue } from "./types.ts";
import { Button, Spinner, Tooltip, TruncTip, useBusyShown } from "./ui/index.ts";
import "./McpDiffPanel.css";

/// MCP「N 份不一样」的字段级差异（DESIGN「MCP「两份不一样」只标差异」）：该服务行下拉出的一格抽屉里。
///
/// - 只列**不同的字段**：字段名 ｜ 位置 A 的值 ｜ 位置 B 的值，三列对齐；值用等宽，不同的那一段加粗
///   （不用反色，反色已是「刚变化」）
/// - headers、env 里的令牌与密钥不显示原值，只写「不同 · 末 4 位」，悬停「出于安全不显示原值」
/// - 值可以选中拷走（D23：路径、id、命令放开文字选取）
/// - 认证头运行时才生成的，如实说比不了，不假装比过
/// - `在访达中显示 ↗` 在抽屉末尾：离开 Sophia，浅键（↗ 由组件画）
///
/// 不碰 api：比对结果由调用方懒取（`api.mcpFieldDiff`）后传进来。
export type McpDiffState = McpDiff | "loading" | Error;

export interface McpDiffPanelProps {
  diff: McpDiffState;
  /// 位置 id → 给人看的位置名
  labelOf: (locationId: string) => string;
  /// 末尾 `在访达中显示 ↗` 要显示的配置文件；不给就不出这条链
  revealPath?: string;
  onReveal: (path: string) => void;
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
    return <span className="mcp-diff__absent">没有这一项</span>;
  }
  if (value.kind === "secret") {
    return (
      <Tooltip content="出于安全不显示原值" focusable>
        <span className="mcp-diff__secret">
          不同
          {value.last4 !== null ? (
            <>
              {" · 末 4 位 "}
              <span className="mcp-diff__mono">…{value.last4}</span>
            </>
          ) : null}
        </span>
      </Tooltip>
    );
  }
  const [pre, suf] = ends;
  const text = value.text;
  const mid = text.slice(pre, text.length - suf);
  return (
    <span className="mcp-diff__mono ss-selectable">
      {text.slice(0, pre)}
      {mid ? <b>{mid}</b> : null}
      {text.slice(text.length - suf)}
    </span>
  );
}

export function McpDiffPanel({ diff, labelOf, revealPath, onReveal }: McpDiffPanelProps) {
  const revealLink = revealPath ? (
    <div className="mcp-diff__foot">
      <Button variant="quiet" onClick={() => onReveal(revealPath)}>
        在访达中显示
      </Button>
    </div>
  ) : null;
  if (diff === "loading") return <Comparing />;
  if (diff instanceof Error) {
    return (
      <div className="mcp-diff">
        <div className="mcp-diff__note">无法比对：{diff.message}</div>
        {revealLink}
      </div>
    );
  }
  const columns = `max-content repeat(${diff.locationIds.length}, max-content)`;
  return (
    <div className="mcp-diff">
      {diff.fields.length > 0 ? (
        <div className="mcp-diff__grid" style={{ gridTemplateColumns: columns }}>
          <span />
          {diff.locationIds.map((id) => (
            <span key={id} className="mcp-diff__place">
              {labelOf(id)}
            </span>
          ))}
          {diff.fields.map((field) => {
            const plain = field.values.flatMap((v) => (v.kind === "plain" ? [v.text] : []));
            const ends =
              plain.length === field.values.length
                ? commonEnds(plain)
                : ([0, 0] as [number, number]);
            return (
              <div key={field.field} className="mcp-diff__row">
                <span className="mcp-diff__field">{field.field}</span>
                {field.values.map((value, i) => (
                  <span key={i} className="mcp-diff__value">
                    <FieldValue value={value} ends={ends} />
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      ) : diff.dynamicAuth ? null : (
        <div className="mcp-diff__note">
          连接字段逐项看都一样，不一样的是只有某个 agent 支持的写法
        </div>
      )}
      {diff.dynamicAuth ? (
        <div className="mcp-diff__note">认证头要到运行时才生成，无法逐字比对</div>
      ) : null}
      {diff.unreadable.length > 0 ? (
        <div className="mcp-diff__note">
          {diff.unreadable.map(labelOf).join("、")} 这次无法读取，没有比对
        </div>
      ) : null}
      {revealLink}
    </div>
  );
}

/// 点开之后在取差异：过了 0.3 秒门槛才出忙碌指示 + 一句（更快取回的什么都不闪）；之前留一行空白占位
function Comparing() {
  const shown = useBusyShown(true);
  return (
    <div className="mcp-diff">
      <div className="mcp-diff__note" role="status">
        {shown ? (
          <>
            <Spinner size={14} label="正在比对" />
            正在比对
          </>
        ) : (
          "\u00a0"
        )}
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
}: {
  name: string;
  locationId: string;
  /// 读单份定义（调用方给 `api.mcpEndpoint`；这个文件不碰 api）
  load: (name: string, locationId: string) => Promise<McpEndpoint | null>;
}) {
  const [endpoint, setEndpoint] = useState<McpEndpoint | null>(null);
  useEffect(() => {
    let alive = true;
    setEndpoint(null);
    load(name, locationId).then(
      (found) => alive && setEndpoint(found),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [name, locationId, load]);
  if (endpoint === null) return null;
  return (
    <>
      <span className="mx-kv__key">{endpoint.kind === "url" ? "地址" : "命令"}</span>
      <span className="mx-kv__value">
        <TruncTip content={<span className="mx-mono">{endpoint.text}</span>}>
          <span className="mx-mono ss-selectable">{endpoint.text}</span>
        </TruncTip>
      </span>
    </>
  );
}
