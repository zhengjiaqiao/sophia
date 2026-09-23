/// Skills 的一个域（全局或某项目）→ 共享表格 `Matrix` 的视图（DESIGN「主视图」「表格 = 面板」）。
///
/// 只做折算：把 DomainPage 的行 × 目标折成「行 + 原件位置 + 格 + 选择键」，点了什么
/// 原样交回 SkillsTab（写操作、乐观更新、提示条都在那里）。格的语义取自 `cellState.viewOf`，
/// 不在这里另写一份。
///
/// 「原件位置」列恢复、按来源分组撤销（DESIGN「产品裁决」冲突表）：位置信息常驻视线；
/// 点这一列列头文字按位置排序。自动添加规则只在来源管理页管理，主视图不放规则入口。
/// 说明横幅、「清除失效的」总按钮仍不回来（失效画在那一格上，点那一格就是重新链接；
/// 原件已不在的孤链照样成一行，点那一格就是清除）。
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import Matrix, {
  cellKey,
  RevealLink,
  type MatrixCellView,
  type MatrixRowView,
  type ColumnCheck,
} from "./Matrix";
import { originNames, originText } from "./originName";
import { viewOf } from "./cellState";
import { blockedTipOf } from "./cellTip";
import { displayPath } from "./pathText";
import { ORPHAN_ORIGIN, ORPHAN_SELECT_REASON, ORPHAN_TIP, type OrphanRow } from "./orphanRows";
import { Button, DupMark, Empty as UiEmpty, Tooltip, type EmptyArt } from "./ui";
import type { ConfirmAnchor } from "./ui";
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
  /// 只留这份确认之后、删除完成之前先藏起来的那一份
  hiddenRows: Set<string>;
  /// 同名行悬停读数（`3 个文件`）；没取到时为 undefined
  dupReadout: Map<string, string>;
  onDupHover: (row: DomainRow) => void;
  /// 点「只留这份」：anchor 是按钮此刻的矩形，确认框锚在它上面
  onKeepThis: (row: DomainRow, other: DomainRow, anchor: ConfirmAnchor) => void;
  /// 孤链行（原件已不在的失效链接，见 orphanRows.ts）。本页全部，筛选在这里做
  orphans: OrphanRow[];
  /// 点孤链格：清除这条链接
  onClearOrphan: (orphan: OrphanRow, targetId: string) => void;

  busy: boolean;
  filterText: string;
  onFilterText: (text: string) => void;
  onClearFilter: () => void;
  /// 按来源筛选中的来源（工具行第二行的片）；null＝全部
  originFilter: string | null;
  onOriginFilter: (sourceId: string | null) => void;
  /// 行悬停「打开 ↗」：在访达中显示原件
  onReveal: (path: string) => void;
  /// 工具行右端 `来源`：进来源管理页
  onSources: () => void;

  selected: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  onCell: (ref: CellRef) => void;
  onBatch: (press: BatchPress) => void;
  onUndo: () => void;
  shortcuts: boolean;

  flash?: { keys: string[]; nonce: number };
  /// 批量写入真的慢时，触发项旁的忙碌指示 + 一句
  keyBusy?: { keyId: string; label: string } | null;
  cellNotice?: { rowKey: string; columnId: string; text: string } | null;
  rowToast?: { rowKey: string; node: ReactNode } | null;
  keyToast?: { keyId: string; node: ReactNode } | null;
  /// 单格成功的例行一行（在被点的那一行里，紧跟名字）
  cellToast?: { id: number; rowKey: string; node: ReactNode } | null;
  globalToast?: ReactNode;
  focus?: { rowKeys: string[]; columnId?: string; nonce: number } | null;
}

/// 提示框里的动词：格子只写「动词 · 快捷键」，动词带方向（`加到 Claude Code` / `从 Claude Code 移除`）——
/// 「开启 Claude Code」会读成操作应用本身（DESIGN 冲突表）
const verbOf = (state: CellState, agent: string): string | undefined =>
  state === "linked"
    ? `从 ${agent} 移除`
    : state === "missing"
      ? `加到 ${agent}`
      : state === "broken"
        ? "点一下重新链接"
        : state === "readOnly"
          ? `${agent} 的 skills 目录写不进去 · 点一下再试一次`
          : state === "wholeLinked"
            ? `${agent} 的 skills 文件夹整个是链接 · 点一下拆开`
            : undefined;

/// 按 agent 那一项的提示框：动词 + 数量 + 受影响的名字（前 5 个 +「等 N 个」）；原件、写不进的注明不受影响
export function affectedTip(
  head: string,
  names: string[],
  notes: { names: string[]; why: string }[] = [],
): ReactNode {
  const list = (xs: string[]) =>
    `${xs.slice(0, 5).join("、")}${xs.length > 5 ? ` 等 ${xs.length} 个` : ""}`;
  return (
    <>
      <div>{`${head} · ${names.length} 个：${list(names)}`}</div>
      {notes
        .filter((n) => n.names.length > 0)
        .map((n) => (
          <div key={n.why}>{`${list(n.names)} ${n.why}，不受影响`}</div>
        ))}
    </>
  );
}

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

  // 来源顺序 = 行里第一次出现的先后；来源筛选片与原件位置列共用，计数按本域全部行（筛选不改计数）
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
      tip: `${target.label} · ${n} 个已加上`,
      missing: !target.exists,
    };
  });

  // ---- 原件位置：来源名；同名来源用路径里能区分它们的那一级 ----
  const names = originNames(counts.keys(), overview.sources);
  const nameOf = (id: string) => names.get(id) ?? { name: labelOf(id), seg: "" };
  const originOf = (id: string) => originText(nameOf(id));

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
        const verb = verbOf(state, target.label);
        cells[target.id] = {
          dot: view.dot,
          clickable: verb !== undefined,
          tip: verb ?? blockedTipOf(state, target.label, row.skill, view.reason ?? ""),
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
          split: nameOf(row.sourceId).seg ? nameOf(row.sourceId) : undefined,
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
                        {originOf(other.sourceId)} 那份 {otherReadout ?? "…"}
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
              onKeep={(anchor) => props.onKeepThis(row, other, anchor)}
              label={`只留 ${originOf(row.sourceId)} 的 ${row.skill}`}
            />
          ),
      };
    });

  // ---- 孤链行：名字 + 原件位置「不在了」，有孤链的格虚线环、点一下清除；勾不动 ----
  const orphanQuery = props.filterText.trim().toLowerCase();
  const orphans = props.orphans.filter(
    (o) =>
      props.originFilter === null &&
      (orphanQuery === "" || o.skill.toLowerCase().includes(orphanQuery)),
  );
  for (const orphan of orphans) {
    const cells: Record<string, MatrixCellView | null> = {};
    for (const target of page.targets) {
      const link = orphan.links.find((l) => l.targetId === target.id);
      cells[target.id] = link ? { dot: "broken", clickable: true, tip: ORPHAN_TIP } : null;
    }
    matrixRows.push({
      key: orphan.key,
      name: orphan.skill,
      origin: {
        id: orphan.key,
        label: ORPHAN_ORIGIN,
        path: orphan.pointedTo,
        onReveal: () => undefined,
        gone: true,
      },
      cells,
      selectDisabledReason: ORPHAN_SELECT_REASON,
    });
  }

  // ---- 选择操作条：已选的 × 每个 agent，写出按下会产生的增量 ----
  const chosen = visible.filter(
    (row) => props.selected.has(skillRowKey(row)) && !props.hiddenRows.has(skillRowKey(row)),
  );
  // 选择态：工具行里每个 agent 一项「● / ○ 名字」——● ＝选中的在这里（按能改的格算）全都有，否则 ○；
  // 点 ○ 补齐缺的，点 ● 全部移除。原件、写不进、同名被挡的格不计入（DESIGN「选择操作条」）
  const columnChecks: Record<string, ColumnCheck> = {};
  const enabledPresses: { add: CellRef[]; remove: CellRef[]; checked: boolean }[] = [];
  for (const target of page.targets) {
    const linked: CellRef[] = [];
    const missing: CellRef[] = [];
    const own: string[] = [];
    const blocked: string[] = [];
    for (const row of chosen) {
      const s = stateAt(row, target.id);
      const ref = { sourceId: row.sourceId, skill: row.skill, targetId: target.id };
      if (s === "linked") linked.push(ref);
      else if (s === "missing") missing.push(ref);
      else if (s === "own") own.push(row.skill);
      else if (s !== null) blocked.push(row.skill);
    }
    const checked = missing.length === 0 && linked.length > 0;
    const notes = [
      { names: own, why: "是原件" },
      { names: blocked, why: "写不进" },
    ];
    const disabledReason =
      target.linkedWholeTo !== null
        ? `${target.label} 的 skills 整个文件夹是链接`
        : linked.length + missing.length > 0
          ? undefined
          : own.length > 0 && blocked.length === 0
            ? "这几个都是原件，改不了"
            : "这几个都写不进";
    if (disabledReason === undefined)
      enabledPresses.push({ add: missing, remove: linked, checked });
    columnChecks[target.id] = {
      checked,
      label: checked ? `选中的都从 ${target.label} 移除` : `选中的都加到 ${target.label}`,
      tip: checked
        ? affectedTip(
            `从 ${target.label} 移除`,
            linked.map((c) => c.skill),
            notes,
          )
        : affectedTip(
            `加到 ${target.label}`,
            missing.map((c) => c.skill),
            notes,
          ),
      disabledReason,
      onToggle: () =>
        props.onBatch(
          checked
            ? { keyId: target.id, op: "unlink", cells: linked }
            : { keyId: target.id, op: "link", cells: missing },
        ),
    };
  }
  // 「所有 agent」：每个能改的 agent 都全有才打勾；点空框全部加上，点打勾全部移除
  const allChecked = enabledPresses.length > 0 && enabledPresses.every((p) => p.checked);
  const allAdd = enabledPresses.flatMap((p) => p.add);
  const allRemove = enabledPresses.flatMap((p) => p.remove);
  const uniqNames = (cells: CellRef[]) => [...new Set(cells.map((c) => c.skill))];
  const allAgents: ColumnCheck = {
    checked: allChecked,
    label: allChecked ? "选中的都从所有 agent 移除" : "选中的都加到所有 agent",
    tip: allChecked
      ? affectedTip(`从所有 agent 移除 · ${allRemove.length} 处`, uniqNames(allRemove))
      : affectedTip(`加到所有 agent · ${allAdd.length} 处`, uniqNames(allAdd)),
    disabledReason: enabledPresses.length === 0 ? "没有能加上或移除的" : undefined,
    onToggle: () =>
      props.onBatch(
        allChecked
          ? { keyId: "all", op: "unlink", cells: allRemove }
          : { keyId: "all", op: "link", cells: allAdd },
      ),
  };

  // ---- 空态：一句现状 + 一个动作（DESIGN「空态与忙碌态」） ----
  const noAgentDirs = page.targets.length === 0 || page.targets.every((t) => !t.exists);
  const query = props.filterText.trim();
  // 空态里的动作同工具行：进来源管理页（管理入口，不带 `+`）
  const addAction = { label: "来源", onClick: props.onSources };
  const empty =
    query !== "" ? (
      <Empty
        text={`没有名字里带「${query}」的 skill`}
        action={{ label: "清除筛选", onClick: props.onClearFilter }}
      />
    ) : noAgentDirs ? (
      <Empty text={`${page.label} 下还没有 agent 的 skill 目录`} action={addAction} art="folders" />
    ) : (
      <Empty text={`${page.label} 里还没有 skill`} action={addAction} art="links" />
    );

  return (
    <Matrix
      columns={columns}
      rows={matrixRows}
      originLabel="原件位置"
      sources={{
        total: page.rows.length - props.hiddenRows.size + props.orphans.length,
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
      addButton={<Button onClick={props.onSources}>来源</Button>}
      selected={props.selected}
      onSelectionChange={props.onSelectionChange}
      allAgents={allAgents}
      columnChecks={columnChecks}
      busy={props.busy}
      onCell={(rowKey, columnId) => {
        const row = page.rows.find((r) => skillRowKey(r) === rowKey);
        if (row) {
          props.onCell({ sourceId: row.sourceId, skill: row.skill, targetId: columnId });
          return;
        }
        const orphan = props.orphans.find((o) => o.key === rowKey);
        if (orphan) props.onClearOrphan(orphan, columnId);
      }}
      onUndo={props.onUndo}
      shortcuts={props.shortcuts}
      empty={empty}
      flash={props.flash}
      cellNotice={props.cellNotice}
      rowToast={props.rowToast}
      keyToast={props.keyToast}
      cellToast={props.cellToast}
      keyBusy={props.keyBusy}
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

/// 表格里的空态：一句现状 + 一个按钮（表头照常在上面——列在，用户才有入口把目录建出来）。
/// 图按 DESIGN「图像」：没有 agent 目录 folders、一个都没有 links；筛选无结果不放图
export function Empty({
  text,
  action,
  art,
}: {
  text: string;
  action: { label: string; onClick: () => void; icon?: ReactNode };
  art?: EmptyArt;
}) {
  return (
    <UiEmpty
      kind={art === "folders" ? "noAgentDirs" : art === "links" ? "noSkills" : "noMatch"}
      description={text}
      primary={action}
      art={art}
    />
  );
}

/// 同名行悬停时出现的「只留这份」。出现那一刻去取两份的读数（取过的不再取），给 ×2 的提示框用
function DupExtra({
  onShow,
  onKeep,
  label,
}: {
  onShow: () => void;
  onKeep: (anchor: ConfirmAnchor) => void;
  label: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    onShow();
    // 只在出现时取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Tooltip content="另一份移到废纸篓，先确认">
      <span ref={ref}>
        <Button
          variant="link"
          onClick={() => {
            // 锚在这一行：确认框出在行下方，遮罩挖出整行（用户看得见自己在决定哪一行）
            const el = ref.current?.closest(".mx-row") ?? ref.current;
            const r = el?.getBoundingClientRect();
            if (r) onKeep({ top: r.top, left: r.left, right: r.right, bottom: r.bottom });
          }}
          ariaLabel={label}
        >
          只留这份
        </Button>
      </span>
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
