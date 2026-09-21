import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { MICRO_CAP, MONO, TAG_SQUARE } from "./ui/text";
import { api } from "./api";
import { viewOf } from "./cellState";
import { compareBy, STATE_RANK, toggleSort, type SortState } from "./sort";
import {
  AgentMark,
  Button,
  Chip,
  Empty,
  StateDot,
  type ButtonSize,
  type ButtonVariant,
} from "./ui";
import type { AutoLink, CellRef, DomainPage, DomainRow, Overview } from "./types";

/// 交给容器去清除的一批链接：行（用于结果说明）+ 要清的格，省略 cells = 整行
export interface UnlinkTarget {
  page: DomainPage;
  row: DomainRow;
  cells?: CellRef[];
}

export interface DomainViewProps {
  overview: Overview;
  page: DomainPage;
  /// 全部自动同步规则；本组件只列目标落在本域的那些
  autoLinks: AutoLink[];
  /// 经过筛选、要显示的行；排序在本组件里做
  rows: DomainRow[];
  busy: boolean;
  /// 高亮的本体位置筛选片（空 = 不筛）
  activeSources: Set<string>;
  onToggleSource: (sourceId: string) => void;
  /// 「全部」片：清掉本域的本体位置筛选
  onClearSources: () => void;
  /// 当前是否有筛选条件（文字或本体位置）——决定空表格该说哪一句
  filtered: boolean;
  /// 空态里的「清除筛选」：文字与本体位置一起清掉
  onClearFilter: () => void;
  /// 空态里的「导入 skill」
  onImport: () => void;
  isSelected: (row: DomainRow) => boolean;
  /// 行首复选框：交回当前显示顺序的行，供 Shift 区间选择算区间
  onToggle: (row: DomainRow, shiftKey: boolean, ordered: DomainRow[]) => void;
  onSelectAll: (selected: boolean) => void;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
  /// 把格交给容器：开启、关闭、只说明原因
  onLink: (cells: CellRef[]) => Promise<void>;
  onUnlink: (targets: UnlinkTarget[]) => Promise<void>;
  onNotice: (text: string) => void;
}

/// 没有格子的行排在所有状态之后
const ABSENT_RANK = STATE_RANK.readOnly + 1;

/// 拼路径：Windows 路径用反斜杠，其余用斜杠
export const join = (dir: string, name: string) =>
  `${dir}${dir.includes("\\") ? "\\" : "/"}${name}`;

/// 区域标签与列头（组件规范 §1.2 的「区域标签」档）
/// 等宽只给**路径与计数**（§1.2）。skill 名是当词读的，用正文档；
/// 「本体位置」显示的是位置名时同样用正文档，显示的是路径时才随路径走等宽

/// 这个位置名看着是不是一条路径
const looksLikePath = (label: string) => /[\\/]/.test(label);
/// 不可点的方标签：零圆角，因为圆角只给可点的东西（§3.1）

/// busy 期间受影响控件的样子（§6）：置灰且点不动。
/// **豁免的五处不要套它**：设置、筛选输入框、取消选择、提示条关闭、表头排序
export const dim = (busy: boolean): CSSProperties | undefined =>
  busy ? { opacity: "var(--busy-dim)", pointerEvents: "none" } : undefined;

/// `Button` / `Chip` 的「禁用必须同时给出原因」在类型上是个联合，条件禁用得分两支写。
/// 这一层只做那件事，省得每个调用点都展开成三元
export function ActionButton({
  disabled,
  disabledReason,
  ...rest
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return disabled ? (
    <Button {...rest} disabled disabledReason={disabledReason ?? "正在执行上一步操作"} />
  ) : (
    <Button {...rest} />
  );
}

/// 一个域的整页：筛选片、自动同步行、行×目标的矩阵
export default function DomainView({
  overview,
  page,
  autoLinks,
  rows: visible,
  busy,
  activeSources,
  onToggleSource,
  onClearSources,
  filtered,
  onClearFilter,
  onImport,
  isSelected,
  onToggle,
  onSelectAll,
  onChange,
  onError,
  onLink,
  onUnlink,
  onNotice,
}: DomainViewProps) {
  // 表头排序；null = 后端原序（skill 名再本体位置）
  const [sort, setSort] = useState<SortState | null>(null);
  // 表头是「看起来是读的」：默认无箭头，鼠标停在哪一列才浮出淡箭头（§7）
  const [hovered, setHovered] = useState<string | null>(null);

  const labelOf = (sourceId: string) =>
    overview.sources.find((s) => s.id === sourceId)?.label ?? sourceId;

  // skill 自带本体真实路径；查不到时回退到「本体位置目录 + 名字」
  const skillPathOf = (sourceId: string, skill: string) => {
    const source = overview.sources.find((s) => s.id === sourceId);
    return (
      source?.skills.find((sk) => sk.name === skill)?.path ?? join(source?.path ?? sourceId, skill)
    );
  };

  const isExternal = (sourceId: string) =>
    overview.sources.find((s) => s.id === sourceId)?.kind.type === "external";

  const targetLabelOf = (targetId: string) =>
    page.targets.find((t) => t.id === targetId)?.label ?? targetId;

  /// 这条规则下一轮会**新建**的链接条数，不含已存在的（§11 的口径）
  const pendingOf = (rule: AutoLink, local: string[]) =>
    page.rows
      .filter((row) => row.sourceId === rule.source && !rule.excluded.includes(row.skill))
      .reduce(
        (n, row) =>
          n + row.cells.filter((c) => local.includes(c.targetId) && c.state === "missing").length,
        0,
      );

  // 只列目标落在本域的规则，且每条只保留本域的那部分目标
  const rules = autoLinks
    .map((rule) => ({
      rule,
      local: rule.targets.filter((id) => page.targets.some((t) => t.id === id)),
    }))
    .filter((r) => r.local.length > 0);

  /// 在系统文件管理器里定位并选中该 skill 的本体目录
  const reveal = async (path: string) => {
    try {
      await api.revealInDir(path);
    } catch (e) {
      onError(String(e));
    }
  };

  // 写操作后统一重扫；失败只报错，不改本地状态
  const run = async (act: () => Promise<unknown>) => {
    try {
      await act();
      await onChange();
    } catch (e) {
      onError(String(e));
    }
  };

  const cellOf = (row: DomainRow, targetId: string) =>
    row.cells.find((c) => c.targetId === targetId) ?? null;

  // 筛选片按本域全部行统计本体位置，筛选不改变片上的计数（§11）
  const counts = new Map<string, number>();
  for (const row of page.rows) counts.set(row.sourceId, (counts.get(row.sourceId) ?? 0) + 1);

  // 表头全选框只看可见行：全选则勾，部分选中则半选
  const allSelected = visible.length > 0 && visible.every((r) => isSelected(r));
  const someSelected = !allSelected && visible.some((r) => isSelected(r));
  const allRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const rows = sort
    ? [...visible].sort(
        compareBy((row: DomainRow) => {
          if (sort.key === "skill") return row.skill;
          if (sort.key === "source") return labelOf(row.sourceId);
          const cell = cellOf(row, sort.key);
          return cell ? STATE_RANK[cell.state] : ABSENT_RANK;
        }, sort.dir),
      )
    : visible;

  /// 排序箭头：默认不占眼、hover 才淡淡浮出、激活转黑（§7）。
  /// 位置留着不抽走，否则 hover 时整行会跳一下
  const arrow = (column: string) => {
    const active = sort?.key === column;
    const down = active && sort?.dir === "desc";
    return (
      <svg
        width="8"
        height="8"
        viewBox="0 0 8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        aria-hidden="true"
        style={{
          flexShrink: 0,
          visibility: active || hovered === column ? "visible" : "hidden",
          color: active ? "var(--ink)" : "var(--ink-faint)",
        }}
      >
        <path d={down ? "M1.4 2.8L4 5.4l2.6-2.6" : "M1.4 5.2L4 2.6l2.6 2.6"} />
      </svg>
    );
  };

  /// 表头一列。**busy 期间照常可点**——排序不写磁盘（§6 第三条细节）
  const sortHeader = (column: string, content: ReactNode, stacked = false) => (
    <button
      type="button"
      className="sort"
      style={{
        display: "inline-flex",
        alignItems: stacked ? "flex-start" : "center",
        gap: 5,
        opacity: 1,
      }}
      onMouseEnter={() => setHovered(column)}
      onMouseLeave={() => setHovered((prev) => (prev === column ? null : prev))}
      onClick={() => setSort((prev) => toggleSort(prev, column))}
    >
      {content}
      {arrow(column)}
    </button>
  );

  /// 一个 agent 目录都还不存在：列照常在（§6 / AC17），用户才有入口把目录建出来
  const noAgentDirs = page.targets.length === 0 || page.targets.every((t) => !t.exists);

  const tableBody = (
    <table className="matrix">
      <thead>
        <tr>
          <th style={{ borderBottom: "1px solid var(--ink)" }}>
            {/* 表头整行不置灰，只灰这个全选框（§6 第二条细节） */}
            <input
              ref={allRef}
              type="checkbox"
              checked={allSelected}
              style={dim(busy)}
              disabled={busy || visible.length === 0}
              onChange={() => onSelectAll(!allSelected)}
            />
            {sortHeader("skill", <span style={MICRO_CAP}>skill</span>)}
          </th>
          <th style={{ borderBottom: "1px solid var(--ink)" }}>
            {sortHeader("source", <span style={MICRO_CAP}>本体位置</span>)}
          </th>
          {page.targets.map((target) => (
            <th
              key={target.id}
              style={{ borderBottom: "1px solid var(--ink)", textAlign: "center" }}
            >
              {sortHeader(
                target.id,
                // 列头＝图标 + 名字，**没有灯**（DESIGN「矩阵列头」）：目录不存在这件事
                // 由点格那一刻的提示条说，写不进去的进待处理栏，列头不再说第二遍
                <AgentMark
                  id={target.scope.harnessId}
                  name={target.label}
                  title={target.path}
                  layout="stacked"
                />,
                true,
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody style={dim(busy)}>
        {rows.map((row) => {
          const selected = isSelected(row);
          return (
            <tr
              key={`${row.sourceId}|${row.skill}`}
              style={selected ? { background: "var(--surface)" } : undefined}
            >
              <td>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  {/* 用 onClick 是为了拿到 shiftKey；选中态仍由上层状态决定 */}
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={busy}
                    readOnly
                    onClick={(e) => onToggle(row, e.shiftKey, rows)}
                  />
                  <span style={{ fontSize: "var(--size-body)" }}>{row.skill}</span>
                </label>
              </td>
              <td className="path">
                {isExternal(row.sourceId) && <span style={TAG_SQUARE}>外部</span>}
                <Button
                  variant="link"
                  title={skillPathOf(row.sourceId, row.skill)}
                  onClick={() => void reveal(skillPathOf(row.sourceId, row.skill))}
                >
                  <span style={looksLikePath(labelOf(row.sourceId)) ? MONO : undefined}>
                    {labelOf(row.sourceId)}
                  </span>
                </Button>
              </td>
              {page.targets.map((target) => {
                const cell = cellOf(row, target.id);
                // 无格态：该 target 在这一行没有格，例如本体属于另一个域（§8）
                if (!cell) {
                  return (
                    <td className="cell" key={target.id}>
                      <StateDot dot="none" title="这个 agent 不在当前域" />
                    </td>
                  );
                }
                const view = viewOf(cell, target, target.label, row.skill);
                const ref: CellRef = {
                  sourceId: row.sourceId,
                  skill: row.skill,
                  targetId: target.id,
                };
                // 先判状态再决定做什么：不能点的四种画得和「未开启」一样，
                // 凭动作数组为空统一说一句话对它们全是错的（§8）
                const click = () => {
                  if (!view.clickable) {
                    if (view.reason) onNotice(view.reason);
                    return;
                  }
                  if (view.dot === "linked") void onUnlink([{ page, row, cells: [ref] }]);
                  else void onLink([ref]);
                };
                const title = view.clickable
                  ? view.dot === "linked"
                    ? `关掉 ${row.skill} 在 ${target.label} 下的链接`
                    : `在 ${target.label} 下开启 ${row.skill}`
                  : view.reason;
                return (
                  <td className="cell" key={target.id}>
                    <StateDot
                      dot={view.dot}
                      title={title}
                      onClick={busy ? undefined : click}
                      label={`${row.skill} · ${target.label}`}
                    />
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div className="domain-group">
      <h2>{page.label}</h2>

      {counts.size > 0 && (
        <div className="tags" style={dim(busy)}>
          {/* 「全部 N」与侧栏、与各片同源：本域的 skill 行数（§11） */}
          <Chip selected={activeSources.size === 0} onClick={onClearSources}>
            全部 <span style={MONO}>{page.rows.length}</span>
          </Chip>
          {[...counts].map(([sourceId, n]) => (
            <Chip
              key={sourceId}
              selected={activeSources.has(sourceId)}
              title={sourceId}
              onClick={() => onToggleSource(sourceId)}
            >
              <span style={looksLikePath(labelOf(sourceId)) ? MONO : undefined}>
                {labelOf(sourceId)}
              </span>{" "}
              <span style={MONO}>{n}</span>
            </Chip>
          ))}
        </div>
      )}

      {/* 自动同步行：只读一行，顶多关掉。不展开、没有展开箭头（§12） */}
      {rules.map(({ rule, local }) => (
        <div
          key={rule.source}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            border: "1px solid var(--hairline)",
            padding: "7px 12px",
            marginBottom: 10,
          }}
        >
          <span style={MICRO_CAP}>自动同步</span>
          <span style={{ fontSize: "var(--size-body)" }}>
            {labelOf(rule.source)} <span style={{ color: "var(--ink-faint)" }}>→</span>{" "}
            {local.map((id) => targetLabelOf(id)).join(" · ")}
          </span>
          {/* 计数带单位：裸的「+2」紧跟在 agent 列表后面会被读成「还有 2 个 agent」（§11） */}
          <span style={{ ...MONO, color: "var(--ink-mute)" }}>
            {pendingOf(rule, local)} 条待建
            {rule.excluded.length > 0 && `（排除 ${rule.excluded.length}）`}
          </span>
          <span style={{ marginLeft: "auto", ...dim(busy) }}>
            <Button
              size="compact"
              title="不再自动同步到本域的这些 agent"
              onClick={() => void run(() => api.removeAutoLinkTargets(rule.source, local))}
            >
              关掉
            </Button>
          </span>
        </div>
      ))}

      {/* 表头照常渲染，即使一行都没有——agent 列在，用户才有入口把目录建出来（§8） */}
      {page.targets.length > 0 && tableBody}
      {rows.length === 0 &&
        (filtered ? (
          <Empty kind="noMatch" secondary={{ label: "清除筛选", onClick: onClearFilter }} />
        ) : noAgentDirs ? (
          <Empty
            kind="noAgentDirs"
            description="这个位置下还没有任何 agent 的 skill 目录。开启任一 skill 时会顺手建出来。"
            primary={{ label: "导入 skill", onClick: onImport }}
          />
        ) : (
          <Empty
            kind="noSkills"
            description={`${page.label} 里还没有 skill。`}
            hint="导入之后它会出现在这张表里，再逐个 agent 开启。"
            primary={{ label: "导入 skill", onClick: onImport }}
          />
        ))}
    </div>
  );
}
