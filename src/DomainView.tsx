/// Skills 的位置集合（用户级、某项目，或 `全部` 下的几个位置）→ 共享表格 `Matrix` 的视图
/// （DESIGN「位置页：skills ｜ mcp」；spec 2026-09-26-object-first-navigation R6 R7）。
///
/// 只做折算：把合并后的行 × agent 列（`skillsView.mergeSkillPages`）折成「行 + 来源 + 格 + 选择行的点」，
/// 每一格落在这一行自己位置的目标上。不止一个位置时名称后多一列 `位置`。点了什么
/// 原样交回 SkillsTab（写操作、乐观更新、提示条都在那里）。格的语义取自 `cellState.viewOf`，
/// 不在这里另写一份。
///
/// 位置页上没有来源行，来源的路径、规则、移除都在来源管理页（页面头 `管理来源`，SkillsTab 挂）。
/// R9 去掉了按来源筛选：筛选框（⌘F）同时匹配名字与来源名，见 `rowFilter.matchesFilter`。
/// 说明横幅、「清除失效的」总按钮不回来（失效画在那一格上，点那一格就是重新链接；
/// 原件已不在的孤链照样成一行，点那一格就是清除）。
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import Matrix, {
  cellKey,
  RevealLink,
  SourceKeys,
  type MatrixCellView,
  type MatrixRowView,
  type ColumnCheck,
} from "./Matrix";
import { originNames, originText } from "./originName";
import { matchesFilter } from "./rowFilter";
import { viewOf } from "./cellState";
import { blockedTipOf } from "./cellTip";
import { ORPHAN_ORIGIN, ORPHAN_SELECT_REASON, ORPHAN_TIP } from "./orphanRows";
import {
  columnOfTarget,
  columnPress,
  refAt,
  refRowKey,
  skillRowKey,
  type PlacedOrphan,
  type SkillRow,
  type SkillsView,
} from "./skillsView";
import { BusySlot, Button, Empty, Mono, Note, Tag, Tooltip, type EmptyArt } from "./ui";
import type { AnchorRect } from "./layerPlace.ts";
import type { CellRef, CellState, Overview } from "./types";

/// 一格的键（乐观更新、闪烁、就地提示都按它认格）：这一行（带位置）+ agent 列
export const skillCellKey = (ref: CellRef) => cellKey(refRowKey(ref), columnOfTarget(ref.targetId));

/// 批量操作：已选的 × 一个 agent（或全部）。`撤销` 键按条件给（DESIGN「提示条的位置」，2026-09-25
/// 评审第二轮）：再按一次同一个点就恰好撤回时不给；`⌘Z` 始终可用
export interface BatchPress {
  keyId: string;
  op: "link" | "unlink";
  cells: CellRef[];
  /// 做完之后再按一次同一个点，恰好把这一次撤回：移除（打勾＝选中的全有，全移除再按就全加回）、
  /// 或加上时选中的原本一个都没有。这时提示条不给 `撤销`（同单格：再点一下就恢复了）；
  /// 选中的里原本就有一部分时，再按会连原有的一起移除、回不到原来有有无无的样子，只有 `撤销` 是准确的退路
  reversible: boolean;
}

export interface DomainViewProps {
  overview: Overview;
  /// 范围里各位置并成的一张表（列、全部行、位置名）
  view: SkillsView;
  /// 经过筛选、要显示的行
  rows: SkillRow[];
  /// 一个位置都还没有 agent 目录时空态里说的地方：`用户级` / 项目名 / `这几个位置`
  placeLabel: string;
  /// 格此刻该画成什么（乐观更新之后的状态）
  stateOf: (ref: CellRef, actual: CellState) => CellState;
  /// 只留这份确认之后、删除完成之前先藏起来的那一份
  hiddenRows: Set<string>;
  /// 同名行悬停读数（`3 个文件`）；没取到时为 undefined
  dupReadout: Map<string, string>;
  onDupHover: (row: SkillRow) => void;
  /// 点「只留这份」（抽屉里的键，或右键菜单）：确认框锚在 `anchor` 下面
  /// `at`：按下那一刻触发控件的位置——结果的提示小窗锚在这里，抽屉收起、行重排之后也还在原处
  onKeepThis: (row: SkillRow, other: SkillRow, at: AnchorRect) => void;
  /// 正在为哪一行体检（点了「只留这份」、确认框还没出来）：那一行的键原位忙碌、不随悬停收起
  keepBusy?: string | null;
  /// 孤链行（原件已不在的失效链接，见 orphanRows.ts）。本页全部，筛选在这里做
  orphans: PlacedOrphan[];
  /// 点孤链格：清除这条链接
  onClearOrphan: (orphan: PlacedOrphan, targetId: string) => void;

  filterText: string;
  onFilterText: (text: string) => void;
  onClearFilter: () => void;
  /// 行悬停「打开 ↗」、空态 `在访达中显示 ↗`：在访达中显示
  onReveal: (path: string) => void;
  /// 右键「拷贝路径」
  onCopyPath: (path: string) => void;
  /// 页面头的 `+ 来源`：进添加来源页（多个位置时先选位置，`at` 是被按的键）
  onAddSource: (at: HTMLElement | null) => void;
  /// 页面头的 `管理来源`：进来源管理页；这个位置一个来源都没订阅时不给（键不出）
  onManageSources?: (at: HTMLElement | null) => void;
  /// bar 插槽（R4 的项目筛选片，见 Matrix）：原样传给 Matrix 的 `bar`
  bar?: ReactNode;
  /// 新手提示条的插槽：bar 插槽下、表头上（放 `<HintStrip flush>`，见 Matrix）
  hint?: ReactNode;
  /// 新手提示条的插槽：空态上方
  emptyHint?: ReactNode;

  selected: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  onCell: (ref: CellRef) => void;
  onBatch: (press: BatchPress) => void;
  onUndo: () => void;
  /// 此刻有没有可撤销的操作（菜单「撤销」亮不亮）
  canUndo: boolean;
  shortcuts: boolean;

  flash?: { keys: string[]; nonce: number };
  /// 批量写入进行中：按下的那一项（过了 0.3 秒门槛旁边出忙碌指示 + 一句）
  keyBusy?: { keyId: string; label: string } | null;
  /// 点格之后真要等的（拆开）：过了 0.3 秒门槛被点那一格下方出忙碌指示 + 一句
  cellBusy?: { rowKey: string; columnId: string; label: string } | null;
  cellNotice?: { rowKey: string; columnId: string; text: string } | null;
  onDismissCellNotice?: () => void;
  rowToast?: { rowKey: string; at?: AnchorRect; node: ReactNode } | null;
  keyToast?: { keyId: string; node: ReactNode } | null;
  /// 单格成功：浮在被点那一格正下方
  cellToast?: { id: number; rowKey: string; columnId: string; node: ReactNode } | null;
  /// 加完来源：浮在新来源那几片正下方
  barToast?: { id: number; node: ReactNode; origins: string[] } | null;
}

/// 提示框里的动词：格子只写「动词 · 快捷键」，动词带方向（`加到 Claude Code` / `从 Claude Code 移除`）——
/// 「开启 Claude Code」会读成操作应用本身（DESIGN 冲突表）。原件格 `删除原件…`：`…` 表示还要确认一步
const verbOf = (state: CellState, agent: string): string | undefined =>
  state === "own"
    ? "删除原件…"
    : state === "linked"
      ? `从 ${agent} 移除`
      : state === "missing"
        ? `加到 ${agent}`
        : state === "broken"
          ? "链接失效，原件还在 · 点一下重新链接"
          : state === "readOnly"
            ? `无法写入 ${agent} 的 skills 目录 · 点一下再试一次`
            : state === "wholeLinked"
              ? `${agent} 的 skills 文件夹整个是链接 · 点一下拆开`
              : undefined;

/// 按 agent 那一项的提示框：动词 + 数量 + 受影响的名字（前 5 个 +「等 N 个」）；原件、无法写入的注明不受影响
export function affectedTip(
  head: string,
  names: string[],
  notes: { names: string[]; why: string }[] = [],
  /// 「所有 agent」那一项：同一个名字可能改好几处，写总处数
  places?: number,
): ReactNode {
  // 名字列出前 5 个；只有被截掉时才补数量（数量与名字并排是重复）
  const list = (xs: string[]) =>
    `${xs.slice(0, 5).join("、")}${xs.length > 5 ? ` 等 ${xs.length} 个` : ""}`;
  return (
    <>
      <div>{`${head}：${list(names)}${places !== undefined ? `（共 ${places} 处）` : ""}`}</div>
      {/* 不会被改的：一类一行，写清楚为什么跳过（原因说清是哪个 agent） */}
      {notes
        .filter((n) => n.names.length > 0)
        .map((n) => (
          <div key={n.why}>{`跳过 ${list(n.names)}：${n.why}`}</div>
        ))}
    </>
  );
}

export default function DomainView(props: DomainViewProps) {
  const { overview, view, rows: visible, stateOf } = props;
  const multi = view.places.size > 0;

  const sourceOf = (id: string) => overview.sources.find((s) => s.id === id);
  const labelOf = (id: string) => sourceOf(id)?.label ?? id;
  /// 原件完整路径：skill 自带；查不到时回退到「来源目录 + 名字」
  const pathOf = (row: SkillRow) => {
    const source = sourceOf(row.sourceId);
    return (
      source?.skills.find((k) => k.name === row.skill)?.path ??
      `${source?.path ?? row.sourceId}/${row.skill}`
    );
  };

  // 同名：同一个位置里同一个 skill 名出现在不止一个来源下＝有几份原件（两个位置各装一份不算同名）
  const dupKey = (row: SkillRow) => `${row.domainKey}|${row.skill}`;
  const copies = new Map<string, SkillRow[]>();
  for (const row of view.rows) {
    if (props.hiddenRows.has(skillRowKey(row))) continue;
    const list = copies.get(dupKey(row));
    if (list) list.push(row);
    else copies.set(dupKey(row), [row]);
  }

  /// 这一行在这一列的格此刻的状态；这一行的位置里没有这个 agent、或没有这一格时为 null
  const stateAt = (row: SkillRow, column: SkillsView["columns"][number]): CellState | null => {
    const ref = refAt(row, column);
    if (ref === null) return null;
    const cell = row.cells.find((c) => c.targetId === ref.targetId)!;
    return stateOf(ref, cell.state);
  };

  // ---- 列：通道条表头，第三层是这个 agent 下已加上的格数（● 与 ⦿ 都算），与 `名称 N` 同一范围
  // （随当前筛选，DESIGN「计数口径」） ----
  // 目录还不存在（虚线图标）：这一列在范围里的每个位置都还没有目录
  const columns = view.columns.map((target) => {
    const n = visible.filter((row) => {
      if (props.hiddenRows.has(skillRowKey(row))) return false;
      const s = stateAt(row, target);
      return s === "linked" || s === "own";
    }).length;
    return {
      id: target.id,
      agentId: target.agentId,
      name: target.label,
      count: n,
      tip: `${target.label} · ${n} 个已加上`,
      missing: [...target.targets.values()].every((t) => !t.exists),
    };
  });

  // ---- 来源名：同名来源用路径里能区分它们的那一级（与确认框同一个起名函数） ----
  const namedIds = [...new Set(view.rows.map((row) => row.sourceId))];
  const names = originNames(namedIds, overview.sources);
  const nameOf = (id: string) => names.get(id) ?? { name: labelOf(id), seg: "" };
  const originOf = (id: string) => originText(nameOf(id));

  /// 同名占位（⊘）的那一格被表格里哪一行的来源占着：同名的另一份在这一列是加上的那一份
  const occupantAt = (row: SkillRow, column: SkillsView["columns"][number]): string | undefined => {
    const holder = (copies.get(dupKey(row)) ?? []).find(
      (r) =>
        r.sourceId !== row.sourceId &&
        (stateAt(r, column) === "linked" || stateAt(r, column) === "own"),
    );
    return holder ? originOf(holder.sourceId) : undefined;
  };

  // ---- 行 ----
  const matrixRows: MatrixRowView[] = visible
    .filter((row) => !props.hiddenRows.has(skillRowKey(row)))
    .map((row) => {
      const key = skillRowKey(row);
      const cells: Record<string, MatrixCellView | null> = {};
      for (const column of view.columns) {
        const ref = refAt(row, column);
        if (ref === null) {
          cells[column.id] = null;
          continue;
        }
        const target = column.targets.get(row.domainKey)!;
        const cell = row.cells.find((c) => c.targetId === ref.targetId)!;
        const state = stateOf(ref, cell.state);
        const shown = viewOf({ ...cell, state }, target, target.label, row.skill);
        const verb = verbOf(state, target.label);
        cells[column.id] = {
          dot: shown.dot,
          clickable: verb !== undefined,
          tip:
            verb ??
            blockedTipOf(
              state,
              target.label,
              row.skill,
              shown.reason ?? "",
              occupantAt(row, column),
            ),
        };
      }
      const dup = copies.get(dupKey(row)) ?? [];
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
        place: view.places.get(row.domainKey),
        origin: {
          id: row.sourceId,
          label: originOf(row.sourceId),
          split: nameOf(row.sourceId).seg ? nameOf(row.sourceId) : undefined,
          path,
          onReveal: () => props.onReveal(path),
        },
        cells,
        // 判断用的读数不越过面板右沿：进 ×2 的提示框，两份同时列出（DESIGN「表格 = 面板」）。
        // ×2 是名字后的纯文字记号，排在拉手之前；点它拉开抽屉，`只留这份` 在抽屉里
        mark:
          dup.length > 1 ? (
            <span onMouseEnter={() => props.onDupHover(row)} onFocus={() => props.onDupHover(row)}>
              <Tag
                tone="count"
                label={`同名：有 ${dup.length} 份`}
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
              >
                ×{dup.length}
              </Tag>
            </span>
          ) : undefined,
        dupGroup: dup.length > 1 ? dupKey(row) : undefined,
        // 点名字 / ×2 / 拉手拉开抽屉：描述、路径 + 打开 ↗、改于 … · N 个文件（读不到描述不写那一行）；
        // 同名行末尾一颗 `只留这份`（名称格里不放键，名字不被挤成省略号）
        detail: (
          <SkillDetail
            description={description}
            path={path}
            readout={readout}
            onShow={() => props.onDupHover(row)}
            onReveal={() => props.onReveal(path)}
            keep={
              other === undefined ? undefined : (
                <KeepKey
                  onKeep={(at) => props.onKeepThis(row, other, at)}
                  label={`只留 ${originOf(row.sourceId)} 的 ${row.skill}`}
                  busy={props.keepBusy === key}
                />
              )
            }
          />
        ),
        // 右键菜单：在访达中显示原件（＝`打开 ↗`）、拷贝路径（＝展开区里可选中的路径）、
        // 只留这份…（只在同名行，走同一个锚定确认）
        menu: (el) => [
          { label: "在访达中显示原件", run: () => props.onReveal(path) },
          { label: "拷贝路径", run: () => props.onCopyPath(path) },
          "separator",
          ...(other !== undefined && props.keepBusy !== key
            ? [
                {
                  label: "只留这份…",
                  run: () => {
                    const r = el.getBoundingClientRect();
                    const n = el.querySelector(".mx-row__name")?.getBoundingClientRect() ?? r;
                    props.onKeepThis(row, other, {
                      top: r.top,
                      left: n.left,
                      right: n.right,
                      bottom: r.bottom,
                    });
                  },
                },
              ]
            : []),
        ],
      };
    });

  // ---- 孤链行：名字 + 原件位置「不在了」，有孤链的格虚线环、点一下清除；勾不动 ----
  // 没有真实来源可比对（伪来源 ORPHAN_ORIGIN 不是搜得到的来源名），筛选只按名字命中
  const orphans = props.orphans.filter((o) => matchesFilter(props.filterText, o.skill, null));
  for (const orphan of orphans) {
    const cells: Record<string, MatrixCellView | null> = {};
    for (const column of view.columns) {
      const link = orphan.links.find((l) => columnOfTarget(l.targetId) === column.id);
      cells[column.id] = link ? { dot: "broken", clickable: true, tip: ORPHAN_TIP } : null;
    }
    matrixRows.push({
      key: orphan.key,
      name: orphan.skill,
      place: view.places.get(orphan.domainKey),
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

  // ---- 选择行（D4）：已选的 × 每个 agent 一点 ----
  const chosen = visible.filter(
    (row) => props.selected.has(skillRowKey(row)) && !props.hiddenRows.has(skillRowKey(row)),
  );
  // 每个 agent 列正下方一点：● ＝选中的在这里（按能改的格算）全都有，否则 ○；
  // 点 ○ 补齐缺的，点 ● 全部移除。原件、受阻（无法写入、同名占位）的格不计入（DESIGN「选择行」）
  const columnChecks: Record<string, ColumnCheck> = {};
  const enabledPresses: { add: CellRef[]; remove: CellRef[]; checked: boolean }[] = [];
  for (const target of view.columns) {
    // 各行按自己位置的格算（`全部` 下选中的行可以分属几个位置）
    const { linked, missing, own, blocked, targets } = columnPress(chosen, target, stateOf);
    const checked = missing.length === 0 && linked.length > 0;
    const notes = [
      { names: own, why: `原件就在 ${target.label} 里` },
      { names: blocked, why: `无法加到 ${target.label}` },
    ];
    const disabledReason =
      targets.length > 0 && targets.every((t) => t.linkedWholeTo !== null)
        ? `${target.label} 的 skills 整个文件夹是链接`
        : linked.length + missing.length > 0
          ? undefined
          : own.length > 0 && blocked.length === 0
            ? "这几个都是原件，不能在这里加上或移除"
            : `这几个都无法加到 ${target.label}`;
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
            ? { keyId: target.id, op: "unlink", cells: linked, reversible: true }
            : { keyId: target.id, op: "link", cells: missing, reversible: linked.length === 0 },
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
      ? affectedTip("从所有 agent 移除", uniqNames(allRemove), [], allRemove.length)
      : affectedTip("加到所有 agent", uniqNames(allAdd), [], allAdd.length),
    disabledReason: enabledPresses.length === 0 ? "没有能加上或移除的" : undefined,
    onToggle: () =>
      props.onBatch(
        allChecked
          ? { keyId: "all", op: "unlink", cells: allRemove, reversible: true }
          : { keyId: "all", op: "link", cells: allAdd, reversible: allRemove.length === 0 },
      ),
  };

  // ---- 空态（DESIGN「位置页 › 空态」）：动作已在页面头的（`+ 来源`）不重复，只说现状 ----
  const noAgentDirs =
    view.columns.length === 0 ||
    view.columns.every((c) => [...c.targets.values()].every((t) => !t.exists));
  const query = props.filterText.trim();
  const empty =
    query !== "" ? (
      <TableEmpty
        text={`没有名字或来源里带「${query}」的 skill`}
        action={{ label: "清除筛选", onClick: props.onClearFilter }}
      />
    ) : noAgentDirs ? (
      <TableEmpty
        text={`${props.placeLabel} 下还没有 agent 的 skill 目录`}
        hint="加上第一个 skill 时会自动创建"
        art="noDirs"
      />
    ) : (
      <TableEmpty text="还没有 skill" art="emptyFolder" />
    );

  return (
    <Matrix
      columns={columns}
      rows={matrixRows}
      originLabel="来源"
      placeLabel={multi ? "位置" : undefined}
      bar={props.bar}
      hint={props.hint}
      emptyHint={props.emptyHint}
      nameLabel="名称"
      nameTip={
        multi
          ? "列出这几个位置各个来源里的全部 skill，同一个 skill 装在两个位置就是两行。agent 自带的和插件带的不在这里，在「管理来源」里增删"
          : "列出这个位置各个来源里的全部 skill，agent 自带的和插件带的不在这里。已经链接到这里的来源会自动加进来，在「管理来源」里增删"
      }
      nameCount={matrixRows.length}
      dotWords="skill"
      filterText={props.filterText}
      onFilterText={props.onFilterText}
      headActions={<SourceKeys onManage={props.onManageSources} onAdd={props.onAddSource} />}
      selected={props.selected}
      onSelectionChange={props.onSelectionChange}
      allAgents={allAgents}
      columnChecks={columnChecks}
      onCell={(rowKey, columnId) => {
        // 列 id 是 agent；落到这一行自己位置里那个 agent 的目标上
        const row = view.rows.find((r) => skillRowKey(r) === rowKey);
        const column = view.columns.find((c) => c.id === columnId);
        if (row && column) {
          const ref = refAt(row, column);
          if (ref) props.onCell(ref);
          return;
        }
        const orphan = props.orphans.find((o) => o.key === rowKey);
        const link = orphan?.links.find((l) => columnOfTarget(l.targetId) === columnId);
        if (orphan && link) props.onClearOrphan(orphan, link.targetId);
      }}
      onUndo={props.onUndo}
      canUndo={props.canUndo}
      shortcuts={props.shortcuts}
      empty={empty}
      flash={props.flash}
      cellNotice={props.cellNotice}
      onDismissCellNotice={props.onDismissCellNotice}
      rowToast={props.rowToast}
      keyToast={props.keyToast}
      cellToast={props.cellToast}
      keyBusy={props.keyBusy}
      cellBusy={props.cellBusy}
      barToast={props.barToast}
    />
  );
}

/// 表格里的空态（表头照常在上面）：
/// - 筛选无结果不放图：表头下一句灰字（`Note`），句后 `清除筛选`（默认键紧凑，次要入口——筛选框内的 ✕ 是主入口）
/// - 其余是图 + 一句现状（`Empty`）；来源里还没有 skill 时 `在访达中显示 ↗`（浅键，`leave`）。
///   图按 DESIGN「图像」：没有 agent 目录 noDirs、一个都没有 emptyFolder；图的上沿按空态表落在表头下——
///   上面已占页面头 + 表头 145，有来源筛选（emptyFolder 时一定有）再加一行到 171（`Empty above`）
/// `+ 来源` 在页面头，不在这里重复
/// 表头下的空态上面已被占掉的高度：页面头 + 表头 145；有来源筛选时再加一行到 171
const ABOVE_TABLE = 145;
const ABOVE_TABLE_WITH_SOURCES = 171;

export function TableEmpty({
  text,
  hint,
  action,
  art,
}: {
  text: string;
  hint?: string;
  action?: { label: string; onClick: () => void; leave?: boolean };
  art?: EmptyArt;
}) {
  if (!art) {
    return (
      <div className="mx-note">
        <Note action={action}>{text}</Note>
      </div>
    );
  }
  return (
    <Empty
      description={text}
      hint={hint}
      secondary={action}
      art={art}
      above={art === "noDirs" ? ABOVE_TABLE : ABOVE_TABLE_WITH_SOURCES}
    />
  );
}

/// 同名行抽屉里的「只留这份」（两份的读数由抽屉拉开时去取，见 SkillDetail）
function KeepKey({
  onKeep,
  label,
  busy,
}: {
  onKeep: (at: AnchorRect) => void;
  label: string;
  /// 点过、正在体检：键锁住，过了 0.3 秒门槛原位换成忙碌指示 + 一句
  busy: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <Tooltip content="另一份移到废纸篓，先确认">
      <span ref={ref}>
        <BusySlot busy={busy} label="正在核对两份">
          <Button
            size="compact"
            onClick={() => {
              if (busy) return;
              // 结果的提示小窗锚在被按下的这颗键上（确认框在窗口正中）
              const k = ref.current?.getBoundingClientRect();
              if (k) onKeep({ top: k.top, left: k.left, right: k.right, bottom: k.bottom });
            }}
            ariaLabel={label}
          >
            只留这份
          </Button>
        </BusySlot>
      </span>
    </Tooltip>
  );
}

/// 抽屉里的行详情：描述（ink-mute 13，不截断；读不到不写）、路径（等宽 ink-faint）+ 打开 ↗、
/// 改于 … · N 个文件；同名行末尾 `只留这份`。拉开那一刻去取读数（同名时两份一起取，给 ×2 的提示框用）
function SkillDetail({
  description,
  path,
  readout,
  onShow,
  onReveal,
  keep,
}: {
  description?: string;
  path: string;
  readout?: string;
  onShow: () => void;
  onReveal: () => void;
  /// 同名行的 `只留这份`
  keep?: ReactNode;
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
        <Mono path>{path}</Mono>
        <RevealLink path={path} onReveal={onReveal} />
      </div>
      {readout ? <div>{readout}</div> : null}
      {keep ? <div className="mx-detail__keep">{keep}</div> : null}
    </>
  );
}
