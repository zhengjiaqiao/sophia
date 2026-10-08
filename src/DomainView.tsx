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
/// 失效画在那一格上，点那一格就是重新链接；原件已不在的孤链照样成一行，点那一格就是清除。
/// 孤链的批量入口是表格上方那一句（`OrphanNotice`，SkillsTab 放进 `hint` 插槽），不在这张表里。
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import Matrix, {
  cellKey,
  RevealLink,
  SourceKeys,
  type MatrixCellView,
  type MatrixRowView,
  type CellNotice,
  type ColumnCheck,
} from "./Matrix.tsx";
import { originNames, originText } from "./originName.ts";
import { matchesFilter } from "./rowFilter.ts";
import { viewOf } from "./cellState.ts";
import { blockedTipOf } from "./cellTip.ts";
import { orphanOrigin, orphanSelectReason, orphanTip } from "./orphanRows.ts";
import { listText, t, tn } from "./i18n.ts";
import { displayPath } from "./pathText.ts";
import {
  agentCopiesOf,
  columnOfTarget,
  columnPress,
  columnReadersNote,
  keepSideKey,
  refAt,
  refRowKey,
  skillRowKey,
  type KeepSide,
  type PlacedOrphan,
  type SkillRow,
  type SkillsView,
} from "./skillsView.ts";
import {
  BusySlot,
  Button,
  DiffTable,
  Empty,
  Mono,
  Note,
  Tag,
  Tooltip,
  type EmptyArt,
} from "./ui/index.ts";
import type { AnchorRect } from "./layerPlace.ts";
import type { CellRef, CellState, Overview } from "./types.ts";
import { keepBlockedReason } from "./dupNotice.ts";
import { agentCopyRow, skillDiffTable, type SkillDiffTable } from "./skillDiffTable.ts";

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
  /// 一个位置都还没有 agent 目录时空态的一句（`noSkillsText`）：`本机还没有 skill`、`CardBox 还没有 skill`……
  noDirsText: string;
  /// 空态的 `前往发现`：切到「发现」页签；不给就不出这颗键
  onDiscover?: () => void;
  /// 格此刻该画成什么（乐观更新之后的状态）
  stateOf: (ref: CellRef, actual: CellState) => CellState;
  /// 只留这份确认之后、删除完成之前先藏起来的那一份
  hiddenRows: Set<string>;
  /// 同名行悬停读数（`3 个文件`）；没取到时为 undefined
  dupReadout: Map<string, string>;
  /// 同名几份推荐留哪份（行键 → 推荐那一行的行键 + 理由）：推荐的那一行名字后挂 `推荐保留`（提示框写理由），
  /// 悬停它就出 `只留这份`（2026-09-30 产品负责人：「有个推荐的标签，降低用户决策成本」）
  dupAdvice?: Map<string, { keep: string; reason: string }>;
  onDupHover: (row: SkillRow) => void;
  /// 点「只留这份」（抽屉里的键，或右键菜单）：留 `kept`、挪走 `other`。一方可以是 agent 自己目录里
  /// 不在任何原件位置里的那一份（抽屉差异表里的那一行，issue #153）
  /// `at`：按下那一刻触发控件的位置——结果的提示小窗锚在这里，抽屉收起、行重排之后也还在原处
  onKeepThis: (kept: KeepSide, other: KeepSide, at: AnchorRect) => void;
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
  /// 页面头的 `管理原件位置`：进原件位置管理页（添加在那一页的 `+ 原件位置`；2026-09-30 产品负责人：
  /// 「添加原件位置会变成一个不常用的……放在管理原件位置的下一级页面就行」）
  onManageSources: (at: HTMLElement | null) => void;
  /// bar 插槽（R4 的项目筛选片，见 Matrix）：原样传给 Matrix 的 `bar`
  bar?: ReactNode;
  /// 产品 id → 界面上的名字（合成列的列头点名读它的产品）；没给就用 id
  productName?: (id: string) => string;
  /// 新手提示条的插槽：bar 插槽下、表头上（放 `<NoticePanel mark={false} open flush>`，见 Matrix）
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
  cellNotice?: CellNotice | null;
  onDismissCellNotice?: () => void;
  rowToast?: { rowKey: string; at?: AnchorRect; node: ReactNode } | null;
  keyToast?: { keyId: string; node: ReactNode } | null;
  /// 单格成功：浮在被点那一格正下方
  cellToast?: { id: number; rowKey: string; columnId: string; node: ReactNode } | null;
  /// 拉开这一行的抽屉并滚到它（装完提示的「去处理」，issue #111）：`nonce` 变了才再拉一次
  reveal?: { key: string; nonce: number } | null;
  onRevealed?: () => void;
  /// 名字后、`×2` 之后再挂的记号（有更新：灰字 `有更新`）；没有就 undefined
  rowMark?: (row: SkillRow, path: string) => ReactNode;
  /// 抽屉的末行（有更新：`来自 anthropics/skills · 有新版本` + `更新` + `看改动 ↗`）
  rowDrawerEnd?: (row: SkillRow, path: string) => ReactNode;
}

/// 提示框里的动词：格子只写「动词 · 快捷键」，动词带方向（`加到 Claude Code` / `从 Claude Code 移除`）——
/// 「开启 Claude Code」会读成操作应用本身（DESIGN 冲突表）。原件格先说原件在这里、再给删除
/// （`原件在 Claude Code 中 · 删除…`，#274：只写「删除原件…」时和旁边 ● 的「从 Claude Code 移除」分不开）；
/// `…` 表示还要确认一步
const verbOf = (state: CellState, agent: string): string | undefined =>
  state === "own"
    ? t("skills.verb.removeOriginal", { agent })
    : state === "linked"
      ? t("skills.verb.removeFrom", { agent })
      : state === "missing"
        ? t("skills.verb.addTo", { agent })
        : state === "broken"
          ? t("skills.verb.broken")
          : state === "readOnly"
            ? t("skills.verb.readOnly", { agent })
            : state === "wholeLinked"
              ? t("skills.verb.wholeLinked", { agent })
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
  const list = (xs: string[]) => {
    const shown = listText(xs.slice(0, 5));
    return xs.length > 5 ? tn("skills.affected.more", xs.length, { names: shown }) : shown;
  };
  return (
    <>
      <div>
        {places !== undefined
          ? t("skills.affected.linePlaces", { head, list: list(names), places })
          : t("skills.affected.line", { head, list: list(names) })}
      </div>
      {/* 不会被改的：一类一行，写清楚为什么跳过（原因说清是哪个 agent） */}
      {notes
        .filter((n) => n.names.length > 0)
        .map((n) => (
          <div key={n.why}>{t("skills.affected.skip", { list: list(n.names), why: n.why })}</div>
        ))}
    </>
  );
}

export default function DomainView(props: DomainViewProps) {
  const { overview, view, rows: visible, stateOf } = props;
  // 位置列一直在（R7，2026-09-30）；`multi` 只管「不止一个位置」时才有的说法与 ⊘ 空格
  const multi = view.places.size > 1;

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
      tip: tn("skills.column.added", n, { agent: target.label }),
      note: columnReadersNote(target, props.productName ?? ((id) => id)),
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

  /// 多位置时这一行的位置里没有这一列的 agent：画 ⊘、悬停与按下说原因（与写不进去的格子同一个样子，2026-09-27）；
  /// 位置里有这个 agent、只是这一行没有格的，照旧短横
  const placeGap = (
    domainKey: string,
    column: SkillsView["columns"][number],
  ): MatrixCellView | null =>
    multi && !column.targets.has(domainKey)
      ? {
          dot: "blocked",
          clickable: false,
          tip: t("skills.placeGap.tip", {
            place: view.places.get(domainKey) ?? "",
            agent: column.label,
          }),
        }
      : null;

  // ---- 行 ----
  const matrixRows: MatrixRowView[] = visible
    .filter((row) => !props.hiddenRows.has(skillRowKey(row)))
    .map((row) => {
      const key = skillRowKey(row);
      const cells: Record<string, MatrixCellView | null> = {};
      for (const column of view.columns) {
        const ref = refAt(row, column);
        if (ref === null) {
          cells[column.id] = placeGap(row.domainKey, column);
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
      const advice = dup.length > 1 ? props.dupAdvice?.get(key) : undefined;
      // 抽屉里「N 份不一样」那张表（issue #111）：同名的几份一行一份，与表格同序；两份时行尾 `只留这份`。
      // agent 自己目录里不在任何原件位置里的同名那一份（某一格「那里已有同名的」，issue #153）也接在后面
      const sides: KeepSide[] = [
        ...dup.map((r) => ({ row: r })),
        ...agentCopiesOf(view, row, props.hiddenRows).map((c) => ({ copy: c })),
      ];
      const table =
        sides.length > 1
          ? skillDiffTable(
              sides.map((side) =>
                "row" in side
                  ? {
                      id: skillRowKey(side.row),
                      place: originOf(side.row.sourceId),
                      path: pathOf(side.row),
                    }
                  : agentCopyRow(side.copy),
              ),
            )
          : null;
      const otherReadout = other
        ? props.dupReadout.get(skillRowKey(other)) || undefined
        : undefined;
      const path = pathOf(row);
      // 要删的那一份在应用包里：`只留这份` 按不了，提前说（不等删了再失败）
      const keepBlocked = other === undefined ? null : keepBlockedReason(pathOf(other));
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
        // 记号的先后：名字、×2、有更新
        mark: joinMarks(
          dup.length > 1 ? (
            <span onMouseEnter={() => props.onDupHover(row)} onFocus={() => props.onDupHover(row)}>
              <Tag
                tone="count"
                label={tn("skills.dup.label", dup.length)}
                tip={
                  other === undefined ? undefined : (
                    <>
                      <div>{t("skills.dup.thisReadout", { readout: readout ?? "…" })}</div>
                      <div>
                        {t("skills.dup.otherReadout", {
                          origin: originOf(other.sourceId),
                          readout: otherReadout ?? "…",
                        })}
                      </div>
                    </>
                  )
                }
              >
                ×{dup.length}
              </Tag>
            </span>
          ) : undefined,
          advice?.keep === key ? (
            <Tag tone="weak" tip={advice.reason}>
              {t("skills.dup.recommended")}
            </Tag>
          ) : undefined,
          props.rowMark?.(row, path),
        ),
        dupGroup: dup.length > 1 ? dupKey(row) : undefined,
        // 推荐保留的那一行：悬停就出 `只留这份`，不用先拉开抽屉（点下去照旧先确认、写出两份路径）
        hoverAction:
          advice?.keep === key && other !== undefined ? (
            <KeepKey
              onKeep={(at) => props.onKeepThis({ row }, { row: other }, at)}
              label={t("skills.dup.keepLabel", {
                origin: originOf(row.sourceId),
                skill: row.skill,
              })}
              busy={props.keepBusy === key}
              disabledReason={keepBlocked ?? undefined}
            />
          ) : undefined,
        // 点名字 / ×2 / 拉手拉开抽屉：描述、路径 + 打开 ↗、改于 … · N 个文件（读不到描述不写那一行）；
        // 同名行末尾一段「N 份不一样」的差异表（各份的路径在表里，不再单列路径），行尾 `只留这份`
        // （名称格里不放键，名字不被挤成省略号）
        detail: (
          <SkillDetail
            description={description}
            path={path}
            readout={readout}
            onShow={() => props.onDupHover(row)}
            onReveal={() => props.onReveal(path)}
            copies={
              table === null ? undefined : (
                <SkillCopies
                  skill={row.skill}
                  table={table}
                  keepBusy={props.keepBusy ?? null}
                  onReveal={props.onReveal}
                  onKeep={(id, at) => {
                    const kept = sides.find((side) => keepSideKey(side) === id);
                    const otherId = table.rows.find((r) => r.id === id)?.otherId;
                    const theOther = sides.find((side) => keepSideKey(side) === otherId);
                    if (kept && theOther) props.onKeepThis(kept, theOther, at);
                  }}
                />
              )
            }
            end={props.rowDrawerEnd?.(row, path)}
          />
        ),
        // 右键菜单：在访达中显示原件（＝`打开 ↗`）、拷贝路径（＝展开区里可选中的路径）、
        // 只留这份…（只在同名行，走同一个锚定确认）
        menu: (el) => [
          { label: t("skills.menu.reveal"), run: () => props.onReveal(path) },
          { label: t("skills.menu.copyPath"), run: () => props.onCopyPath(path) },
          "separator",
          ...(other !== undefined && props.keepBusy !== key && keepBlocked === null
            ? [
                {
                  label: t("skills.menu.keepThis"),
                  run: () => {
                    const r = el.getBoundingClientRect();
                    const n = el.querySelector(".mx-row__name")?.getBoundingClientRect() ?? r;
                    props.onKeepThis(
                      { row },
                      { row: other },
                      {
                        top: r.top,
                        left: n.left,
                        right: n.right,
                        bottom: r.bottom,
                      },
                    );
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
      cells[column.id] = link
        ? { dot: "broken", clickable: true, tip: orphanTip() }
        : placeGap(orphan.domainKey, column);
    }
    matrixRows.push({
      key: orphan.key,
      name: orphan.skill,
      place: view.places.get(orphan.domainKey),
      origin: {
        id: orphan.key,
        label: orphanOrigin(),
        path: orphan.pointedTo,
        onReveal: () => undefined,
        gone: true,
      },
      cells,
      selectDisabledReason: orphanSelectReason(),
    });
  }

  // ---- 选择行（D4）：已选的 × 每个 agent 一点 ----
  const chosen = visible.filter(
    (row) => props.selected.has(skillRowKey(row)) && !props.hiddenRows.has(skillRowKey(row)),
  );
  // 每个 agent 列正下方一点：● ＝选中的在这里（按能改的格算）全都有，否则 ○；
  // 点 ○ 补齐缺的，点 ● 全部移除。原件、受阻（无法写入、同名占位）的格不计入（DESIGN「选择行」）
  const columnChecks: Record<string, ColumnCheck> = {};
  const enabledPresses: {
    add: CellRef[];
    remove: CellRef[];
    checked: boolean;
    agent: { id: string; name: string };
  }[] = [];
  for (const target of view.columns) {
    // 各行按自己位置的格算（`全部` 下选中的行可以分属几个位置）
    const { linked, missing, own, blocked, targets } = columnPress(chosen, target, stateOf);
    const checked = missing.length === 0 && linked.length > 0;
    const notes = [
      { names: own, why: t("skills.batch.own", { agent: target.label }) },
      { names: blocked, why: t("skills.batch.blocked", { agent: target.label }) },
    ];
    const disabledReason =
      targets.length > 0 && targets.every((t) => t.linkedWholeTo !== null)
        ? t("skills.batch.wholeLinked", { agent: target.label })
        : linked.length + missing.length > 0
          ? undefined
          : own.length > 0 && blocked.length === 0
            ? t("skills.batch.allOriginals")
            : t("skills.batch.noneAddable", { agent: target.label });
    if (disabledReason === undefined)
      enabledPresses.push({
        add: missing,
        remove: linked,
        checked,
        agent: { id: target.agentId, name: target.label },
      });
    columnChecks[target.id] = {
      checked,
      label: checked
        ? t("skills.batch.removeChosen", { agent: target.label })
        : t("skills.batch.addChosen", { agent: target.label }),
      tip: checked
        ? affectedTip(
            t("skills.verb.removeFrom", { agent: target.label }),
            linked.map((c) => c.skill),
            notes,
          )
        : affectedTip(
            t("skills.verb.addTo", { agent: target.label }),
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
  // 键上只画这一下真会改到的 agent（都写不进去的那家不画，它的原因在那一列的点上）；没有能改的时画全部列
  const keyAgents = (
    enabledPresses.length > 0
      ? enabledPresses.map((p) => p.agent)
      : view.columns.map((c) => ({ id: c.agentId, name: c.label }))
  ).filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i);
  const agentNames = listText(keyAgents.map((a) => a.name));
  const allAgents: ColumnCheck = {
    checked: allChecked,
    label: allChecked
      ? t("skills.verb.removeFrom", { agent: agentNames })
      : t("skills.verb.addTo", { agent: agentNames }),
    keyFace: {
      line: allChecked ? "skills.batch.faceRemove" : "skills.batch.faceAddTo",
      agents: keyAgents,
    },
    tip: allChecked
      ? affectedTip(
          t("skills.verb.removeFrom", { agent: agentNames }),
          uniqNames(allRemove),
          [],
          allRemove.length,
        )
      : affectedTip(
          t("skills.verb.addTo", { agent: agentNames }),
          uniqNames(allAdd),
          [],
          allAdd.length,
        ),
    disabledReason: enabledPresses.length === 0 ? t("skills.batch.noneToChange") : undefined,
    onToggle: () =>
      props.onBatch(
        allChecked
          ? { keyId: "all", op: "unlink", cells: allRemove, reversible: true }
          : { keyId: "all", op: "link", cells: allAdd, reversible: allRemove.length === 0 },
      ),
  };

  // ---- 空态（DESIGN「位置页 › 空态」）：动作已在页面头的（`管理原件位置`）不重复，只说现状 ----
  const noAgentDirs =
    view.columns.length === 0 ||
    view.columns.every((c) => [...c.targets.values()].every((t) => !t.exists));
  const query = props.filterText.trim();
  // 还没有 agent 的 skill 文件夹：说结果 + `前往发现`；装第一个时会自动创建的文件夹放悬停（#274）
  const toCreate = foldersOf(view.columns.flatMap((c) => [...c.targets.values()]));
  const empty =
    query !== "" ? (
      <TableEmpty
        text={t("skills.empty.filtered", { query })}
        action={{ label: t("skills.empty.clearFilter"), onClick: props.onClearFilter }}
      />
    ) : noAgentDirs ? (
      <TableEmpty
        text={props.noDirsText}
        tip={
          toCreate.length > 0 ? (
            <FolderTip title={t("skills.empty.noDirsHint")} folders={toCreate} />
          ) : undefined
        }
        action={
          props.onDiscover
            ? { label: t("skills.empty.goDiscover"), onClick: props.onDiscover }
            : undefined
        }
        art="noDirs"
      />
    ) : (
      <TableEmpty text={t("skills.empty.none")} art="emptyFolder" />
    );

  return (
    <Matrix
      columns={columns}
      rows={matrixRows}
      originLabel={t("skills.table.origin")}
      originTip={t("skills.table.originTip")}
      placeLabel={view.places.size > 0 ? t("skills.table.place") : undefined}
      bar={props.bar}
      hint={props.hint}
      emptyHint={props.emptyHint}
      nameLabel={t("skills.table.name")}
      nameTip={multi ? t("skills.table.nameTipMulti") : t("skills.table.nameTipSingle")}
      nameCount={matrixRows.length}
      dotWords="skill"
      filterText={props.filterText}
      onFilterText={props.onFilterText}
      reveal={props.reveal}
      onRevealed={props.onRevealed}
      headActions={<SourceKeys onManage={props.onManageSources} />}
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
    />
  );
}

/// 表格里的空态（表头照常在上面）：
/// - 筛选无结果不放图：表头下一句灰字（`Note`），句后 `清除筛选`（默认键紧凑，次要入口——筛选框内的 ✕ 是主入口）
/// - 其余是图 + 一句现状（`Empty`）；来源里还没有 skill 时 `在访达中显示 ↗`（浅键，`leave`）。
///   图按 DESIGN「图像」：没有 agent 目录 noDirs、一个都没有 emptyFolder；图的上沿按空态表落在表头下——
///   上面已占页面头 + 表头 145，有来源筛选（emptyFolder 时一定有）再加一行到 171（`Empty above`）
/// `管理原件位置` 在页面头，不在这里重复
/// 表头下的空态上面已被占掉的高度：页面头 + 表头 145；有来源筛选时再加一行到 171
const ABOVE_TABLE = 145;
const ABOVE_TABLE_WITH_SOURCES = 171;

export function TableEmpty({
  text,
  hint,
  tip,
  action,
  art,
}: {
  text: string;
  hint?: string;
  /// 停在那句话上的提示框（第二层：完整路径）
  tip?: ReactNode;
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
      description={
        tip ? (
          <Tooltip content={tip} fit="inline" focusable>
            <span>{text}</span>
          </Tooltip>
        ) : (
          text
        )
      }
      hint={hint}
      secondary={action}
      art={art}
      above={art === "noDirs" ? ABOVE_TABLE : ABOVE_TABLE_WITH_SOURCES}
    />
  );
}

/// 一组目标文件夹的完整路径（主目录写 `~`，去重、保序）：提示框里列出查找过的 / 会自动创建的文件夹
export const foldersOf = (targets: ReadonlyArray<{ path: string }>): string[] => [
  ...new Set(targets.map((x) => displayPath(x.path))),
];

/// 列文件夹的提示框（第二层，DESIGN「文案表达 › 说给谁」）：一行小标 + 完整路径（等宽，` · ` 隔开、可选中），
/// 新手提示条（`已查找的文件夹`）与没有 agent 文件夹的空态（`加上第一个 skill 时会自动创建`）共用
export function FolderTip({ title, folders }: { title: string; folders: readonly string[] }) {
  return (
    <>
      {title}
      <br />
      <Mono inherit>{folders.join(" · ")}</Mono>
    </>
  );
}

/// 同名行抽屉里的「只留这份」（两份的读数由抽屉拉开时去取，见 SkillDetail）
function KeepKey({
  onKeep,
  label,
  busy,
  disabledReason,
}: {
  onKeep: (at: AnchorRect) => void;
  label: string;
  /// 点过、正在体检：键锁住，过了 0.3 秒门槛原位换成忙碌指示 + 一句
  busy: boolean;
  /// 按不了的原因（另一份在应用包里）：键灰着，悬停与按下说原因
  disabledReason?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  if (disabledReason !== undefined)
    return (
      <Button size="compact" disabled disabledReason={disabledReason} ariaLabel={label}>
        {t("skills.dup.keepThis")}
      </Button>
    );
  return (
    <Tooltip content={t("skills.keep.tip")}>
      <span ref={ref}>
        <BusySlot busy={busy} label={t("skills.keep.busy")}>
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
            {t("skills.keep.label")}
          </Button>
        </BusySlot>
      </span>
    </Tooltip>
  );
}

/// 抽屉里的行详情：描述（ink-mute 13，不截断；读不到不写）、路径（等宽 ink-faint）+ 打开 ↗、
/// 改于 … · N 个文件；同名行末尾一段「N 份不一样」（各份的路径在那张表里，路径一行不再单列，同 MCP）。
/// 拉开那一刻去取读数（同名时两份一起取，给 ×2 的提示框用）
function SkillDetail({
  description,
  path,
  readout,
  onShow,
  onReveal,
  copies,
  end,
}: {
  description?: string;
  path: string;
  readout?: string;
  onShow: () => void;
  onReveal: () => void;
  /// 同名行的「N 份不一样」那一段（`SkillCopies`）
  copies?: ReactNode;
  /// 末行（有更新）
  end?: ReactNode;
}) {
  useEffect(() => {
    onShow();
    // 只在展开时取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      {description ? <div className="mx-detail__desc">{description}</div> : null}
      {copies ? null : (
        <div className="mx-detail__path">
          <Mono path>{path}</Mono>
          <RevealLink path={path} onReveal={onReveal} />
        </div>
      )}
      {readout ? <div>{readout}</div> : null}
      {copies ?? null}
      {end ?? null}
    </>
  );
}

/// 同名行抽屉里「N 份不一样」那一段（issue #111，画板 #105 第七稿第 2、3 节）：段首小标 + 差异表 `DiffTable`，
/// 与 MCP 同一个骨架——一行一份，行首位置名，只有「原件」一列（路径，等宽、长了折行），行尾 `只留这份`
/// （两份都能选；另一份在应用包里的那一行禁用并说原因）。按下照旧：先体检（键原位忙碌）、再确认、结果带撤销
function SkillCopies({
  skill,
  table,
  keepBusy,
  onKeep,
  onReveal,
}: {
  skill: string;
  table: SkillDiffTable;
  /// 正在为哪一行体检（行键）
  keepBusy: string | null;
  onKeep: (rowId: string, at: AnchorRect) => void;
  /// 原件格里的 `打开 ↗`：在访达中显示这一份（抽屉里不再单列路径一行，入口跟着路径进表）
  onReveal: (path: string) => void;
}) {
  const title = tn("skills.dup.differ", table.rows.length);
  return (
    <div className="mx-copies">
      <div className="mx-copies__title">{title}</div>
      <DiffTable
        label={title}
        fields={[t("skills.dup.origin")]}
        rows={table.rows.map((row) => ({
          id: row.id,
          place: row.place,
          values: [
            <span className="mx-detail__path">
              <Mono path>{row.path}</Mono>
              <RevealLink path={row.path} onReveal={() => onReveal(row.path)} />
            </span>,
          ],
          actionDisabledReason: row.keepBlocked ?? undefined,
          actionAriaLabel: t("skills.dup.keepLabel", { origin: row.place, skill }),
          actionBusy: keepBusy === row.id ? t("skills.keep.busy") : undefined,
        }))}
        actionLabel={table.keep ? t("skills.keep.label") : undefined}
        onAction={(id, key) => {
          // 结果的提示小窗锚在被按下的这颗键上（确认框在窗口正中）
          const k = key?.getBoundingClientRect();
          if (k) onKeep(id, { top: k.top, left: k.left, right: k.right, bottom: k.bottom });
        }}
      />
    </div>
  );
}

/// 名字后的几个记号并排（`×2` `有更新`）；一个都没有时是 undefined（不占位）
function joinMarks(...marks: ReactNode[]): ReactNode {
  const present = marks.filter((m) => m !== undefined && m !== null && m !== false);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return (
    <>
      {present.map((m, i) => (
        <span key={i}>{m}</span>
      ))}
    </>
  );
}
