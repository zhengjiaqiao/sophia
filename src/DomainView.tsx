/// Skills 的一个位置（全局或某项目）→ 共享表格 `Matrix` 的视图（DESIGN「位置页：skills ｜ mcp」）。
///
/// 只做折算：把 DomainPage 的行 × 目标折成「行 + 来源 + 格 + 选择行的点」，点了什么
/// 原样交回 SkillsTab（写操作、乐观更新、提示条都在那里）。格的语义取自 `cellState.viewOf`，
/// 不在这里另写一份。
///
/// 来源片是这个位置订阅的来源（D3：管理一个来源＝选中它的片，来源行由 SkillsTab 给）；
/// 一个 skill 都没有的已订阅来源也有片（计数 0），选中它才找得到它的来源行。
/// 说明横幅、「清除失效的」总按钮不回来（失效画在那一格上，点那一格就是重新链接；
/// 原件已不在的孤链照样成一行，点那一格就是清除）。
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import Matrix, {
  cellKey,
  RevealLink,
  type MatrixCellView,
  type MatrixRowView,
  type ColumnCheck,
  type SourceChipItem,
} from "./Matrix";
import type { ContextMenuItem } from "./contextMenu";
import { originNames, originText } from "./originName";
import { viewOf } from "./cellState";
import { blockedTipOf } from "./cellTip";
import { displayPath } from "./pathText";
import { ORPHAN_ORIGIN, ORPHAN_SELECT_REASON, ORPHAN_TIP, type OrphanRow } from "./orphanRows";
import {
  AddButton,
  BusySlot,
  Button,
  DupMark,
  Empty as UiEmpty,
  Tooltip,
  type EmptyArt,
} from "./ui";
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
  /// 做完之后再按一次同一个键，恰好把这一次撤回：移除（打勾＝选中的全有，全移除再按就全加回）、
  /// 或加上时选中的原本一个都没有。这时提示条不给 `撤销`（同单格：再点一下就恢复了）；
  /// 选中的里原本就有一部分时，再按会连原有的一起移除，只有 `撤销` 是准确的退路
  reversible: boolean;
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
  /// `at`：按下那一刻「只留这份」的位置（左右取这个文字链、上下取整行）——结果的提示小窗锚在这里，
  /// 行被删掉、文字链随悬停收起之后也还在原处
  onKeepThis: (row: DomainRow, other: DomainRow, anchor: ConfirmAnchor, at: ConfirmAnchor) => void;
  /// 正在为哪一行体检（点了「只留这份」、确认框还没出来）：那一行的键原位忙碌、不随悬停收起
  keepBusy?: string | null;
  /// 孤链行（原件已不在的失效链接，见 orphanRows.ts）。本页全部，筛选在这里做
  orphans: OrphanRow[];
  /// 点孤链格：清除这条链接
  onClearOrphan: (orphan: OrphanRow, targetId: string) => void;

  filterText: string;
  onFilterText: (text: string) => void;
  onClearFilter: () => void;
  /// 按来源筛选中的来源（来源片）；空＝全部。加完来源时可能一次选中几片
  originFilter: readonly string[];
  onOriginFilter: (next: string[]) => void;
  /// 这个位置已订阅、但表格里一行都没有的来源（id 与名字）：照样成片（计数 0）
  emptySources: { id: string; name: string }[];
  /// 这个来源开着「以后新出现的自动加到」（片首橙点）
  ruleOn: (id: string) => boolean;
  /// 来源片的右键菜单（在访达中显示 · 移除来源…）
  chipMenu: (id: string, chip: HTMLElement) => ContextMenuItem[];
  /// 恰好选中一个来源片时的来源行
  sourceRow?: ReactNode;
  /// 行悬停「打开 ↗」：在访达中显示原件
  onReveal: (path: string) => void;
  /// 右键「拷贝路径」
  onCopyPath: (path: string) => void;
  /// 页面头的 `+ 来源`：进添加来源页
  onAddSource: () => void;

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
  rowToast?: { rowKey: string; at?: ConfirmAnchor; node: ReactNode } | null;
  keyToast?: { keyId: string; node: ReactNode } | null;
  /// 单格成功：浮在被点那一格正下方
  cellToast?: { id: number; rowKey: string; columnId: string; node: ReactNode } | null;
  /// 加完来源：浮在新来源那几片正下方
  barToast?: { id: number; node: ReactNode; origins: string[] } | null;
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

  // ---- 列：通道条表头，第三层是这个 agent 下已加上的格数（● 与 ⦿ 都算），与 `名称 N` 同一范围
  // （随当前筛选，DESIGN「计数口径」） ----
  const columns = page.targets.map((target) => {
    const n = visible.filter((row) => {
      if (props.hiddenRows.has(skillRowKey(row))) return false;
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

  // 已订阅、但一行都没有的来源：照样成片（计数 0），排在后面
  const emptySources = props.emptySources.filter((s) => !counts.has(s.id));

  // ---- 来源名：同名来源用路径里能区分它们的那一级（与片、确认框同一个起名函数） ----
  const names = originNames(
    [...counts.keys(), ...emptySources.map((s) => s.id).filter((id) => sourceOf(id))],
    overview.sources,
  );
  const nameOf = (id: string) =>
    names.get(id) ?? {
      name: props.emptySources.find((s) => s.id === id)?.name ?? labelOf(id),
      seg: "",
    };
  const originOf = (id: string) => originText(nameOf(id));

  /// 同名占位（⊘）的那一格被表格里哪一行的来源占着：同名的另一份在这一列是加上的那一份
  const occupantAt = (row: DomainRow, targetId: string): string | undefined => {
    const holder = (copies.get(row.skill) ?? []).find(
      (r) =>
        r.sourceId !== row.sourceId &&
        (stateAt(r, targetId) === "linked" || stateAt(r, targetId) === "own"),
    );
    return holder ? originOf(holder.sourceId) : undefined;
  };

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
          tip:
            verb ??
            blockedTipOf(
              state,
              target.label,
              row.skill,
              view.reason ?? "",
              occupantAt(row, target.id),
            ),
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
              onKeep={(anchor, at) => props.onKeepThis(row, other, anchor, at)}
              label={`只留 ${originOf(row.sourceId)} 的 ${row.skill}`}
              busy={props.keepBusy === key}
            />
          ),
        extraPinned: props.keepBusy === key,
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
                    props.onKeepThis(
                      row,
                      other,
                      { top: r.top, left: r.left, right: r.right, bottom: r.bottom },
                      { top: r.top, left: n.left, right: n.right, bottom: r.bottom },
                    );
                  },
                },
              ]
            : []),
        ],
      };
    });

  // ---- 孤链行：名字 + 原件位置「不在了」，有孤链的格虚线环、点一下清除；勾不动 ----
  const orphanQuery = props.filterText.trim().toLowerCase();
  const orphans = props.orphans.filter(
    (o) =>
      props.originFilter.length === 0 &&
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

  // ---- 选择行（D4）：已选的 × 每个 agent 一点 ----
  const chosen = visible.filter(
    (row) => props.selected.has(skillRowKey(row)) && !props.hiddenRows.has(skillRowKey(row)),
  );
  // 每个 agent 列正下方一点：● ＝选中的在这里（按能改的格算）全都有，否则 ○；
  // 点 ○ 补齐缺的，点 ● 全部移除。原件、受阻（无法写入、同名占位）的格不计入（DESIGN「选择行」）
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
      { names: own, why: `原件就在 ${target.label} 里` },
      { names: blocked, why: `无法加到 ${target.label}` },
    ];
    const disabledReason =
      target.linkedWholeTo !== null
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
  const noAgentDirs = page.targets.length === 0 || page.targets.every((t) => !t.exists);
  const query = props.filterText.trim();
  const onlySource = props.originFilter.length === 1 ? props.originFilter[0] : null;
  const empty =
    query !== "" ? (
      <Empty
        text={`没有名字里带「${query}」的 skill`}
        action={{ label: "清除筛选", onClick: props.onClearFilter }}
      />
    ) : onlySource !== null && !counts.has(onlySource) ? (
      // 选中的来源里一个 skill 都没有：来源行照常在上面（`打开 ↗` 就在那里，这里不放第二个）
      <Empty text={`${originOf(onlySource)} 里还没有 skill`} art="emptyFolder" />
    ) : noAgentDirs ? (
      <Empty
        text={`${page.label} 下还没有 agent 的 skill 目录`}
        hint="加上第一个 skill 时会自动创建"
        art="noDirs"
      />
    ) : (
      <Empty text={`${page.label} 里还没有 skill`} art="emptyFolder" />
    );

  const chip = (id: string, count: number): SourceChipItem => ({
    id,
    label: originOf(id),
    full: originOf(id),
    path: sourceOf(id) ? displayPath(sourceOf(id)?.path ?? "") : undefined,
    count,
    rule: props.ruleOn(id),
    menu: (el) => props.chipMenu(id, el),
  });

  return (
    <Matrix
      columns={columns}
      rows={matrixRows}
      originLabel="来源"
      sources={{
        selected: props.originFilter,
        onSelect: props.onOriginFilter,
        items: [
          ...[...counts].map(([id, count]) => chip(id, count)),
          ...emptySources.map((s) => chip(s.id, 0)),
        ],
      }}
      sourceRow={props.sourceRow}
      nameLabel="名称"
      nameTip="列表里只出现两种 skill：原件就在这个位置下的，和在某个 agent 下有链接的"
      nameCount={matrixRows.length}
      dotWords="skill"
      filterText={props.filterText}
      onFilterText={props.onFilterText}
      headActions={<AddButton noun="来源" onClick={props.onAddSource} />}
      selected={props.selected}
      onSelectionChange={props.onSelectionChange}
      allAgents={allAgents}
      columnChecks={columnChecks}
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
      focus={props.focus}
    />
  );
}

/// 表格里的空态：一句现状（表头照常在上面）；筛选无结果时句后 `清除筛选`（安静键，次要入口——
/// 筛选框内的 ✕ 是主入口）。`+ 来源` 在页面头，不在这里重复。
/// 图按 DESIGN「图像」：没有 agent 目录 noDirs、一个都没有 emptyFolder；筛选无结果不放图
export function Empty({
  text,
  hint,
  action,
  art,
}: {
  text: string;
  hint?: string;
  action?: { label: string; onClick: () => void; icon?: ReactNode };
  art?: EmptyArt;
}) {
  return (
    <UiEmpty
      kind={art === "noDirs" ? "noAgentDirs" : art === "emptyFolder" ? "noSkills" : "noMatch"}
      description={text}
      hint={hint}
      secondary={action}
      art={art}
    />
  );
}

/// 同名行悬停时出现的「只留这份」。出现那一刻去取两份的读数（取过的不再取），给 ×2 的提示框用
function DupExtra({
  onShow,
  onKeep,
  label,
  busy,
}: {
  onShow: () => void;
  onKeep: (anchor: ConfirmAnchor, at: ConfirmAnchor) => void;
  label: string;
  /// 点过、正在体检：键锁住，过了 0.3 秒门槛原位换成忙碌指示 + 一句
  busy: boolean;
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
        <BusySlot busy={busy} label="正在核对两份">
          <Button
            variant="quiet"
            onClick={() => {
              if (busy) return;
              // 确认框锚在这一行：出在行下方，遮罩挖出整行（用户看得见自己在决定哪一行）；
              // 结果的提示小窗锚在被按下的这个文字链上（上下取整行，不盖住这一行）
              const el = ref.current?.closest(".mx-row") ?? ref.current;
              const r = el?.getBoundingClientRect();
              const k = ref.current?.getBoundingClientRect();
              if (r && k)
                onKeep(
                  { top: r.top, left: r.left, right: r.right, bottom: r.bottom },
                  { top: r.top, left: k.left, right: k.right, bottom: r.bottom },
                );
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
        <span className="mx-mono ss-selectable">{displayPath(path)}</span>
        <RevealLink path={path} onReveal={onReveal} />
      </div>
      {readout ? <div>{readout}</div> : null}
    </>
  );
}
