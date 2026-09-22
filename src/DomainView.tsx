/// Skills 的一个域（全局或某项目）→ 共享表格 `Matrix` 的视图（DESIGN「主视图」「表格 = 面板」）。
///
/// 只做折算：把 DomainPage 的行 × 目标折成「行 + 原件位置 + 格 + 选择键」，点了什么
/// 原样交回 SkillsTab（写操作、乐观更新、提示条都在那里）。格的语义取自 `cellState.viewOf`，
/// 不在这里另写一份。
///
/// 「原件位置」列恢复、按来源分组撤销（DESIGN「产品裁决」冲突表）：位置信息常驻视线；
/// 点这一列列头文字按位置排序。自动添加规则只在添加页管理，主视图不放规则入口。
/// 说明横幅、「清除失效的」总按钮仍不回来（失效画在那一格上，点那一格就是重新链接）。
import { useEffect } from "react";
import type { ReactNode } from "react";
import Matrix, {
  duplicatesAKey,
  cellKey,
  RevealLink,
  type MatrixCellView,
  type MatrixRowView,
  type SelectionKey,
} from "./Matrix";
import { distinguishingSegments } from "./pages/importDefaults";
import { viewOf } from "./cellState";
import { displayPath } from "./pathText";
import { AddButton, Button, DupMark, Tooltip } from "./ui";
import type { CellRef, CellState, DomainPage, DomainRow, Overview } from "./types";

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
  onClearFilter: () => void;
  /// 按来源筛选中的来源（工具行第二行的片）；null＝全部
  originFilter: string | null;
  onOriginFilter: (sourceId: string | null) => void;
  /// 行悬停「打开 ↗」：在访达中显示原件
  onReveal: (path: string) => void;
  onImport: () => void;

  selected: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  onCell: (ref: CellRef) => void;
  onBatch: (press: BatchPress) => void;
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
  const { overview, page, rows: visible, stateOf } = props;

  const sourceOf = (id: string) => overview.sources.find((s) => s.id === id);
  const labelOf = (id: string) => sourceOf(id)?.label ?? id;
  /// 原件完整路径：skill 自带；查不到时回退到「来源目录 + 名字」
  const pathOf = (row: DomainRow) => {
    const source = sourceOf(row.sourceId);
    return (
      source?.skills.find((k) => k.name === row.skill)?.path ??
      `${source?.path ?? row.sourceId}/${row.skill}`
    );
  };

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

  // ---- 原件位置：来源名；同名来源用路径里能区分它们的那一级 ----
  const originLabels = new Map<string, string>();
  const byLabel = new Map<string, string[]>();
  for (const id of counts.keys()) {
    const label = labelOf(id);
    byLabel.set(label, [...(byLabel.get(label) ?? []), id]);
  }
  for (const [label, ids] of byLabel) {
    const segs = distinguishingSegments(ids.map((id) => sourceOf(id)?.path ?? id));
    // 区分片段就是名字本身（WeiboAP/skills 对 WeiboAP/agent_…/skills）时不重复写
    ids.forEach((id, i) =>
      originLabels.set(id, segs[i] && segs[i] !== label ? `${label} · ${segs[i]}` : label),
    );
  }
  const originOf = (id: string) => originLabels.get(id) ?? labelOf(id);

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
      const readout = props.dupReadout.get(key) || undefined;
      const otherReadout = other
        ? props.dupReadout.get(skillRowKey(other)) || undefined
        : undefined;
      const path = pathOf(row);
      const description = sourceOf(row.sourceId)?.skills.find(
        (k) => k.name === row.skill,
      )?.description;
      return {
        key,
        name: row.skill,
        origin: {
          id: row.sourceId,
          label: originOf(row.sourceId),
          path,
          onReveal: () => props.onReveal(path),
        },
        cells,
        // 判断用的读数不越过面板右沿：进 ×2 的提示框，两份同时列出（DESIGN「表格 = 面板」）
        mark:
          dup.length > 1 ? (
            <span onMouseEnter={() => props.onDupHover(row)} onFocus={() => props.onDupHover(row)}>
              <DupMark
                count={dup.length}
                tip={
                  other === undefined ? undefined : (
                    <>
                      <div>这份 {readout ?? "…"}</div>
                      <div>
                        {labelOf(other.sourceId)} 那份 {otherReadout ?? "…"}
                      </div>
                    </>
                  )
                }
              />
            </span>
          ) : undefined,
        dupGroup: dup.length > 1 ? row.skill : undefined,
        // 点名字就地展开：描述、路径 + 打开 ↗、改于 … · N 个文件（读不到描述不写那一行）
        detail: (
          <SkillDetail
            description={description}
            path={path}
            readout={readout}
            onShow={() => props.onDupHover(row)}
            onReveal={() => props.onReveal(path)}
          />
        ),
        extra:
          other === undefined ? undefined : (
            <DupExtra
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
  // 动词键：`开启 ⎔ CODEX` / `关闭 ✳ CLAUDE CODE`；受影响数 ≠ 已选数时才写「· N 个」
  const countIf = (n: number, total: number) => (n !== total ? n : undefined);
  const pressOf = new Map<string, BatchPress>();
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
        verb: "开启",
        disabledReason: `${target.label} 的 skills 整个文件夹是链接`,
        onPress: () => undefined,
      };
    }
    if (missing.length > 0) {
      const press: BatchPress = { keyId: target.id, op: "link", cells: missing };
      pressOf.set(target.id, press);
      return {
        ...base,
        verb: "开启",
        count: countIf(missing.length, chosen.length),
        tip: `在 ${target.label} 下开启没开的 ${missing.length} 个`,
        onPress: () => props.onBatch(press),
      };
    }
    if (linked.length > 0) {
      const press: BatchPress = { keyId: target.id, op: "unlink", cells: linked };
      pressOf.set(target.id, press);
      return {
        ...base,
        verb: "关闭",
        count: countIf(linked.length, chosen.length),
        tip: `关掉已选的在 ${target.label} 下的 ${linked.length} 个`,
        onPress: () => props.onBatch(press),
      };
    }
    return {
      ...base,
      verb: "开启",
      disabledReason: own > 0 ? "已选的都是原件" : `已选的在 ${target.label} 下没有能开关的格`,
      onPress: () => undefined,
    };
  });
  // 全部：已选的在所有 agent 下都开着 → 全部关闭；否则全部开启（补齐缺的）
  const allOp: "link" | "unlink" = [...pressOf.values()].some((p) => p.op === "link")
    ? "link"
    : "unlink";
  const allTargets = page.targets.flatMap((target) =>
    target.linkedWholeTo !== null
      ? []
      : chosen.flatMap((row) => {
          const s = stateAt(row, target.id);
          return (allOp === "link" ? s === "missing" : s === "linked")
            ? [{ sourceId: row.sourceId, skill: row.skill, targetId: target.id }]
            : [];
        }),
  );
  const allPress: BatchPress = { keyId: "all", op: allOp, cells: allTargets };
  // 「全部」与某颗 agent 键做同一件事时隐藏（DESIGN「选择操作条」）
  const selectionAll: SelectionKey | undefined =
    allTargets.length === 0 || duplicatesAKey(allPress, [...pressOf.values()])
      ? undefined
      : {
          id: "all",
          verb: allOp === "link" ? "全部开启" : "全部关闭",
          count: countIf(allTargets.length, chosen.length * page.targets.length),
          tip: allOp === "link" ? "在所有 agent 下开启没开的" : "在所有 agent 下关掉已选的",
          onPress: () => props.onBatch(allPress),
        };

  // ---- 空态：一句现状 + 一个动作（DESIGN「空态与忙碌态」） ----
  const noAgentDirs = page.targets.length === 0 || page.targets.every((t) => !t.exists);
  const query = props.filterText.trim();
  const addAction = { label: "skill", onClick: props.onImport, icon: <PlusGlyph /> };
  const empty =
    query !== "" ? (
      <Empty
        text={`没有名字里带「${query}」的 skill`}
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
      rows={matrixRows}
      originLabel="原件位置"
      sources={{
        total: page.rows.length - props.hiddenRows.size,
        selected: props.originFilter,
        onSelect: props.onOriginFilter,
        items: [...counts].map(([id, count]) => ({
          id,
          label: originOf(id),
          full: `${originOf(id)} · ${displayPath(sourceOf(id)?.path ?? id)}`,
          count,
        })),
      }}
      nameLabel="名称"
      nameTip="列表里只出现两种 skill：原件就在这个位置下的，和在某个 agent 下有链接的"
      nameCount={matrixRows.length}
      filterText={props.filterText}
      onFilterText={props.onFilterText}
      addButton={<AddButton noun="skill" onClick={props.onImport} />}
      selected={props.selected}
      onSelectionChange={props.onSelectionChange}
      selectionKeys={keys}
      selectionAll={selectionAll}
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

/// 同名行悬停时出现的「只留这份」。出现那一刻去取两份的读数（取过的不再取），给 ×2 的提示框用
function DupExtra({
  onShow,
  onKeep,
  label,
}: {
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
    <Tooltip content="另一份进废纸篓，可撤销">
      <Button variant="link" onClick={onKeep} ariaLabel={label}>
        只留这份
      </Button>
    </Tooltip>
  );
}

/// 行内展开的详情：描述（ink-mute 13，不截断；读不到不写）、路径（等宽 ink-faint）+ 打开 ↗、
/// 改于 … · N 个文件。出现那一刻去取读数
function SkillDetail({
  description,
  path,
  readout,
  onShow,
  onReveal,
}: {
  description?: string;
  path: string;
  readout?: string;
  onShow: () => void;
  onReveal: () => void;
}) {
  useEffect(() => {
    onShow();
    // 只在展开时取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      {description ? <div className="mx-detail__desc">{description}</div> : null}
      <div className="mx-detail__path">
        <span className="mx-mono">{displayPath(path)}</span>
        <RevealLink path={path} onReveal={onReveal} />
      </div>
      {readout ? <div>{readout}</div> : null}
    </>
  );
}
