/// Skills 的一个域（全局或某项目）→ 共享表格 `Matrix` 的视图（DESIGN「主视图」「表格 = 面板」）。
///
/// 只做折算：把 DomainPage 的行 × 目标折成「分组 + 行 + 格 + 选择键」，点了什么原样交回
/// SkillsTab（写操作、乐观更新、提示条都在那里）。格的语义取自 `cellState.viewOf`，
/// 不在这里另写一份。
///
/// 这一版删掉的（DESIGN「主视图」）：「原件位置」列（改为按来源分组）、说明横幅（机制说明
/// 进名称列头的提示框）、独占一行的自动同步框（并进组头规则）、「清除失效的」总按钮
/// （失效就画在那一格上，点那一格就是重新链接）。
import { useEffect } from "react";
import type { ReactNode } from "react";
import Matrix, {
  cellKey,
  type MatrixCellView,
  type MatrixRowView,
  type SelectionKey,
} from "./Matrix";
import { viewOf } from "./cellState";
import { AddButton, Button, Chip, DupMark, Tooltip } from "./ui";
import type { AutoLink, CellRef, CellState, DomainPage, DomainRow, Overview } from "./types";

/// 行键：本体位置 + skill（一页只显示一个域）
export const skillRowKey = (row: { sourceId: string; skill: string }) =>
  `${row.sourceId}|${row.skill}`;

/// 一格的键（乐观更新、闪烁、就地提示都按它认格）
export const skillCellKey = (ref: CellRef) => cellKey(skillRowKey(ref), ref.targetId);

/// 批量操作：已选的 × 一个 agent（或全部）
export interface BatchPress {
  keyId: string;
  op: "link" | "unlink";
  cells: CellRef[];
}

export interface DomainViewProps {
  overview: Overview;
  page: DomainPage;
  autoLinks: AutoLink[];
  /// 本次会话里关掉的规则：来源 → 当时的目标。组头保留一段灰的规则和开关，好重开
  offRules: Map<string, string[]>;
  /// 经过筛选、要显示的行
  rows: DomainRow[];
  /// 格此刻该画成什么（乐观更新之后的状态）
  stateOf: (ref: CellRef, actual: CellState) => CellState;
  /// 批量操作进行中的格：画成灰色的将来状态
  pendingCells: Set<string>;
  /// 正在操作的行 → 忙什么（行内转盘 + 读屏句子）
  busyRows: Map<string, string>;
  /// 只留这份之后、提交之前先藏起来的那一份
  hiddenRows: Set<string>;
  /// 同名行悬停读数（`3 个文件`）；没取到时为 undefined
  dupReadout: Map<string, string>;
  onDupHover: (row: DomainRow) => void;
  onKeepThis: (row: DomainRow, other: DomainRow) => void;

  busy: boolean;
  filterText: string;
  onFilterText: (text: string) => void;
  activeSources: Set<string>;
  onToggleSource: (sourceId: string) => void;
  onClearSources: () => void;
  onClearFilter: () => void;
  onImport: () => void;

  selected: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  onCell: (ref: CellRef) => void;
  onBatch: (press: BatchPress) => void;
  onRule: (sourceId: string, targets: string[], on: boolean) => void;
  onUndo: () => void;
  shortcuts: boolean;

  flash?: { keys: string[]; nonce: number; stagger?: number };
  cellNotice?: { rowKey: string; columnId: string; text: string } | null;
  rowToast?: { rowKey: string; node: ReactNode } | null;
  keyToast?: { keyId: string; node: ReactNode } | null;
  globalToast?: ReactNode;
  focus?: { rowKeys: string[]; columnId?: string; nonce: number } | null;
}

/// 提示框里的动词：格子只写「动词 · 快捷键」，agent 由列头与列带说明（DESIGN「提示框」）
const VERB: Partial<Record<CellState, string>> = {
  linked: "点一下关闭",
  missing: "点一下开启",
  broken: "点一下重新链接",
  readOnly: "点一下再试一次",
};

export default function DomainView(props: DomainViewProps) {
  const { overview, page, autoLinks, offRules, rows: visible, stateOf } = props;

  const sourceOf = (id: string) => overview.sources.find((s) => s.id === id);
  const labelOf = (id: string) => sourceOf(id)?.label ?? id;

  // 来源顺序 = 行里第一次出现的先后；筛选片与分组共用，计数按本域全部行（筛选不改计数）
  const counts = new Map<string, number>();
  for (const row of page.rows) counts.set(row.sourceId, (counts.get(row.sourceId) ?? 0) + 1);

  // 同名：本域里同一个 skill 名出现在不止一个来源下＝有几份原件
  const copies = new Map<string, DomainRow[]>();
  for (const row of page.rows) {
    if (props.hiddenRows.has(skillRowKey(row))) continue;
    const list = copies.get(row.skill);
    if (list) list.push(row);
    else copies.set(row.skill, [row]);
  }

  const stateAt = (row: DomainRow, targetId: string): CellState | null => {
    const cell = row.cells.find((c) => c.targetId === targetId);
    if (!cell) return null;
    return stateOf({ sourceId: row.sourceId, skill: row.skill, targetId }, cell.state);
  };

  // ---- 列：通道条表头，第三层是这个 agent 下能用的格数 ----
  const columns = page.targets.map((target) => {
    const n = page.rows.filter((row) => {
      const s = stateAt(row, target.id);
      return s === "linked" || s === "own";
    }).length;
    return {
      id: target.id,
      agentId: target.scope.harnessId,
      name: target.label,
      count: n,
      tip: `${target.label} · ${n} 个已开启`,
      missing: !target.exists,
    };
  });

  // ---- 分组：来源名 + 计数 + 规则图式 ----
  const groups = [...counts].map(([sourceId, count]) => {
    const rule = autoLinks.find((r) => r.source === sourceId);
    const local = rule?.targets.filter((id) => page.targets.some((t) => t.id === id)) ?? [];
    const off = offRules.get(sourceId);
    const targets = local.length > 0 ? local : (off ?? []);
    return {
      key: sourceId,
      label: labelOf(sourceId),
      title: sourceOf(sourceId)?.path,
      count,
      rule:
        targets.length === 0
          ? undefined
          : {
              on: local.length > 0,
              agents: targets.flatMap((id) => {
                const t = page.targets.find((x) => x.id === id);
                return t ? [{ id: t.scope.harnessId, name: t.label, columnId: t.id }] : [];
              }),
              onToggle: (next: boolean) => props.onRule(sourceId, targets, next),
              disabledReason: props.busy ? "正在执行上一步操作" : undefined,
            },
    };
  });

  // ---- 行 ----
  const matrixRows: MatrixRowView[] = visible
    .filter((row) => !props.hiddenRows.has(skillRowKey(row)))
    .map((row) => {
      const key = skillRowKey(row);
      const cells: Record<string, MatrixCellView | null> = {};
      for (const target of page.targets) {
        const cell = row.cells.find((c) => c.targetId === target.id);
        if (!cell) {
          cells[target.id] = null;
          continue;
        }
        const ref = { sourceId: row.sourceId, skill: row.skill, targetId: target.id };
        const state = stateOf(ref, cell.state);
        const view = viewOf({ ...cell, state }, target, target.label, row.skill);
        const verb = VERB[state];
        cells[target.id] = {
          dot: view.dot,
          clickable: verb !== undefined,
          tip: verb ?? view.reason ?? "",
          pending: props.pendingCells.has(skillCellKey(ref)),
        };
      }
      const dup = copies.get(row.skill) ?? [];
      const other = dup.length === 2 ? dup.find((r) => r.sourceId !== row.sourceId) : undefined;
      const readout = props.dupReadout.get(key);
      return {
        key,
        group: row.sourceId,
        name: row.skill,
        cells,
        mark: dup.length > 1 ? <DupMark count={dup.length} /> : undefined,
        dupGroup: dup.length > 1 ? row.skill : undefined,
        extra:
          other === undefined ? undefined : (
            <DupExtra
              readout={readout}
              onShow={() => props.onDupHover(row)}
              onKeep={() => props.onKeepThis(row, other)}
              label={`只留 ${labelOf(row.sourceId)} 的 ${row.skill}`}
            />
          ),
        busy: props.busyRows.get(key),
      };
    });

  // ---- 选择操作条：已选的 × 每个 agent，写出按下会产生的增量 ----
  const chosen = visible.filter(
    (row) => props.selected.has(skillRowKey(row)) && !props.hiddenRows.has(skillRowKey(row)),
  );
  const keys: SelectionKey[] = page.targets.map((target) => {
    const linked: CellRef[] = [];
    const missing: CellRef[] = [];
    let own = 0;
    for (const row of chosen) {
      const s = stateAt(row, target.id);
      const ref = { sourceId: row.sourceId, skill: row.skill, targetId: target.id };
      if (s === "linked") linked.push(ref);
      else if (s === "missing") missing.push(ref);
      else if (s === "own") own += 1;
    }
    const base = { id: target.id, agentId: target.scope.harnessId, name: target.label };
    if (target.linkedWholeTo !== null) {
      return {
        ...base,
        delta: 0,
        disabledReason: `${target.label} 的 skills 文件夹整个是链接，拆开后才能逐个开关`,
        dot: "own" as const,
        onPress: () => undefined,
      };
    }
    if (missing.length > 0) {
      return {
        ...base,
        dot: "missing" as const,
        delta: missing.length,
        tip: `在 ${target.label} 下开启没开的 ${missing.length} 个`,
        onPress: () => props.onBatch({ keyId: target.id, op: "link", cells: missing }),
      };
    }
    if (linked.length > 0) {
      return {
        ...base,
        dot: "linked" as const,
        delta: -linked.length,
        tip: `已选的在 ${target.label} 下都开着：点一下全部关掉`,
        onPress: () => props.onBatch({ keyId: target.id, op: "unlink", cells: linked }),
      };
    }
    return {
      ...base,
      dot: own > 0 ? ("own" as const) : undefined,
      delta: 0,
      disabledReason:
        own > 0
          ? `${target.label} · 已选的原件都在这里`
          : `已选的在 ${target.label} 下没有能开关的格`,
      onPress: () => undefined,
    };
  });
  const usable = keys.filter((k) => k.disabledReason === undefined);
  const allMissing = usable.filter((k) => k.delta > 0);
  const allCells = (op: "link" | "unlink") =>
    page.targets.flatMap((target) =>
      chosen.flatMap((row) => {
        const s = stateAt(row, target.id);
        return (op === "link" ? s === "missing" : s === "linked") && target.linkedWholeTo === null
          ? [{ sourceId: row.sourceId, skill: row.skill, targetId: target.id }]
          : [];
      }),
    );
  const allOp: "link" | "unlink" = allMissing.length > 0 ? "link" : "unlink";
  const allTargets = allCells(allOp);
  const selectionAll: SelectionKey = {
    id: "all",
    name: "全部",
    delta: allOp === "link" ? allTargets.length : -allTargets.length,
    tip: allOp === "link" ? "在所有 agent 下开启没开的" : "在所有 agent 下关掉已选的",
    disabledReason: allTargets.length === 0 ? "已选的在这些 agent 下都没有能开关的格" : undefined,
    onPress: () => props.onBatch({ keyId: "all", op: allOp, cells: allTargets }),
  };

  const chips = (
    <>
      {/* 「全部 N」与侧栏、与各片同源：本域的 skill 行数 */}
      <Chip
        selected={props.activeSources.size === 0}
        count={page.rows.length}
        onClick={props.onClearSources}
      >
        全部
      </Chip>
      {[...counts].map(([sourceId, n]) => (
        <Chip
          key={sourceId}
          selected={props.activeSources.has(sourceId)}
          count={n}
          onClick={() => props.onToggleSource(sourceId)}
        >
          {labelOf(sourceId)}
        </Chip>
      ))}
    </>
  );

  // ---- 空态：一句现状 + 一个动作（DESIGN「空态与忙碌态」） ----
  const noAgentDirs = page.targets.length === 0 || page.targets.every((t) => !t.exists);
  const query = props.filterText.trim();
  const addAction = { label: "skill", onClick: props.onImport, icon: <PlusGlyph /> };
  const empty =
    props.activeSources.size > 0 || query !== "" ? (
      <Empty
        text={query !== "" ? `没有名字里带「${query}」的 skill` : "这个来源下没有匹配的 skill"}
        action={{ label: "清除筛选", onClick: props.onClearFilter }}
      />
    ) : noAgentDirs ? (
      <Empty text={`${page.label} 下还没有 agent 的 skill 目录`} action={addAction} />
    ) : (
      <Empty text={`${page.label} 里还没有 skill`} action={addAction} />
    );

  return (
    <Matrix
      columns={columns}
      groups={groups}
      rows={matrixRows}
      nameLabel="名称"
      nameTip="列表里只出现两种 skill：原件就在这个位置下的，和在某个 agent 下有链接的"
      filterText={props.filterText}
      onFilterText={props.onFilterText}
      chips={counts.size > 0 ? chips : undefined}
      addButton={<AddButton noun="skill" onClick={props.onImport} />}
      selected={props.selected}
      onSelectionChange={props.onSelectionChange}
      selectionKeys={keys}
      selectionAll={page.targets.length > 1 ? selectionAll : undefined}
      busy={props.busy}
      onCell={(rowKey, columnId) => {
        const row = page.rows.find((r) => skillRowKey(r) === rowKey);
        if (row) props.onCell({ sourceId: row.sourceId, skill: row.skill, targetId: columnId });
      }}
      onUndo={props.onUndo}
      shortcuts={props.shortcuts}
      empty={empty}
      flash={props.flash}
      cellNotice={props.cellNotice}
      rowToast={props.rowToast}
      keyToast={props.keyToast}
      globalToast={props.globalToast}
      focus={props.focus}
    />
  );
}

/// 空态的 `+`：与 AddButton 同一个 12px 1.4 描边线性图形
export function PlusGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 1.5v9M1.5 6h9" />
    </svg>
  );
}

/// 表格里的空态：一句现状 + 一个按钮（表头照常在上面——列在，用户才有入口把目录建出来）
export function Empty({
  text,
  action,
}: {
  text: string;
  action: { label: string; onClick: () => void; icon?: ReactNode };
}) {
  return (
    <div className="ss-empty">
      <div className="ss-empty__description">{text}</div>
      <div className="ss-empty__actions">
        <Button icon={action.icon} onClick={action.onClick}>
          {action.label}
        </Button>
      </div>
    </div>
  );
}

/// 同名行悬停时出现的读数 + 「只留这份」。出现那一刻去取读数（取过的不再取）
function DupExtra({
  readout,
  onShow,
  onKeep,
  label,
}: {
  readout: string | undefined;
  onShow: () => void;
  onKeep: () => void;
  label: string;
}) {
  useEffect(() => {
    onShow();
    // 只在出现时取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      {readout !== undefined ? (
        <span className="mx-extra__readout" title={readout}>
          {readout}
        </span>
      ) : null}
      <Tooltip content="另一份进废纸篓，可撤销">
        <Button variant="link" onClick={onKeep} ariaLabel={label}>
          只留这份
        </Button>
      </Tooltip>
    </>
  );
}
