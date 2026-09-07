import { useEffect, useState } from "react";
import { api } from "./api";
import DomainView from "./DomainView";
import {
  actionId,
  type CellRef,
  type DomainPage,
  type DomainRow,
  type Outcome,
  type Overview,
  type PlannedAction,
  type SyncReport,
} from "./types";

function outcomeText(o: Outcome): string {
  switch (o.status) {
    case "created":
      return "已创建";
    case "removed":
      return "已删除";
    case "skipped":
      return "跳过";
    case "failed":
      return `失败：${o.reason}`;
  }
}

/// 选择状态的键：域 + 本体位置 + skill
const rowKey = (page: DomainPage, row: DomainRow) => `${page.key}|${row.sourceId}|${row.skill}`;

/// 一行展开成它在本域各目标上的格
const cellsOf = (row: DomainRow): CellRef[] =>
  row.cells.map((c) => ({ sourceId: row.sourceId, skill: row.skill, targetId: c.targetId }));

export interface SkillsTabProps {
  overview: Overview | null;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  /// 侧栏选中：`"all"` 或某个 DomainPage.key
  selectedKey: string;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}

/// 域页容器：按侧栏选中渲染一个或全部域，工具栏按渲染出的域聚合
export default function SkillsTab({
  overview,
  busy,
  onBusy,
  selectedKey,
  onRefresh,
  onError,
}: SkillsTabProps) {
  const [report, setReport] = useState<SyncReport | null>(null);
  // 暂态提示：说明为什么没动作、某个格为什么不能点
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClean, setConfirmClean] = useState(false);
  // 待确认的删链动作；行、格、批量三条路径都汇到这里
  const [pendingUnlink, setPendingUnlink] = useState<PlannedAction[] | null>(null);
  // 被取消勾选的行；不在集合里即选中，所以默认全选、新出现的行也默认选中
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  // 结果框是暂态的：6 秒后自行消失
  useEffect(() => {
    if (!report) return;
    const timer = setTimeout(() => setReport(null), 6000);
    return () => clearTimeout(timer);
  }, [report]);

  // 提示同样是暂态的
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  // 结果、提示与选择都只属于当次选择：切换侧栏选中项就作废
  useEffect(() => {
    setReport(null);
    setNotice(null);
    setConfirmClean(false);
    setPendingUnlink(null);
    setExcluded(new Set());
  }, [selectedKey]);

  const isSelected = (page: DomainPage, row: DomainRow) => !excluded.has(rowKey(page, row));

  const toggleRow = (page: DomainPage, row: DomainRow) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      const key = rowKey(page, row);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const setPageAll = (page: DomainPage, selected: boolean) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      for (const row of page.rows) {
        if (selected) next.delete(rowKey(page, row));
        else next.add(rowKey(page, row));
      }
      return next;
    });

  const run = async (subset: PlannedAction[], cleanBroken: boolean) => {
    onBusy(true);
    setConfirmClean(false);
    setPendingUnlink(null);
    try {
      setReport(await api.applyAll(subset, cleanBroken));
    } catch (e) {
      onError(String(e));
    } finally {
      onBusy(false);
    }
    await onRefresh();
  };

  // 建链不需要确认
  const link = async (cells: CellRef[]) => {
    try {
      const acts = await api.proposeLinks(cells);
      if (acts.length === 0) {
        setNotice("没有需要建立的链接");
        return;
      }
      await run(acts, false);
    } catch (e) {
      onError(String(e));
    }
  };

  // 删链先算动作再进确认条
  const askUnlink = async (cells: CellRef[]) => {
    try {
      const acts = await api.proposeUnlinks(cells);
      if (acts.length === 0) {
        setNotice("没有可删除的链接");
        return;
      }
      setConfirmClean(false);
      setPendingUnlink(acts);
    } catch (e) {
      onError(String(e));
    }
  };

  if (!overview) return <p>扫描中…</p>;

  const pages =
    selectedKey === "all"
      ? overview.domains
      : overview.domains.filter((d) => d.key === selectedKey);
  const broken = pages.flatMap((p) => p.broken);

  /// 该行在本域是否有可取消的链接（已链接且目标不是整目录链接）
  const hasUnlinkable = (page: DomainPage, row: DomainRow) =>
    row.cells.some(
      (c) =>
        c.state === "linked" &&
        page.targets.find((t) => t.id === c.targetId)?.linkedWholeTo === null,
    );

  // 勾选行的全部格；建链按它算
  const selectedCells: CellRef[] = pages.flatMap((page) =>
    page.rows.filter((row) => isSelected(page, row)).flatMap(cellsOf),
  );
  // 可删除的 skill 行：勾选、本体不在本域、且有可取消的链接
  const deletableRows = pages.flatMap((page) =>
    page.rows.filter((row) => isSelected(page, row) && !row.own && hasUnlinkable(page, row)),
  );

  // 缺失按格算：一行在多个目标上缺失就算多处
  let missing = 0;
  for (const page of pages) {
    for (const row of page.rows) {
      if (!isSelected(page, row)) continue;
      for (const cell of row.cells) if (cell.state === "missing") missing += 1;
    }
  }

  return (
    <section>
      <div className="toolbar">
        <span>坏链 {broken.length} 处</span>
        <button
          onClick={() => void link(selectedCells)}
          disabled={busy || missing === 0}
          title={missing === 0 ? "勾选的行里没有缺失的链接" : "给勾选行缺失的 harness 建链"}
        >
          补齐缺失（{missing} 处）
        </button>
        <button
          onClick={() => void askUnlink(deletableRows.flatMap(cellsOf))}
          disabled={busy || deletableRows.length === 0}
          title="本体在本域的 skill 不会被删除"
        >
          删除 skill（{deletableRows.length} 个）
        </button>
        {broken.length > 0 &&
          (confirmClean ? (
            <span className="confirm">
              只删除链接本身，不删除任何真实文件。
              <button onClick={() => void run(broken, true)} disabled={busy}>
                确认删除
              </button>
              <button onClick={() => setConfirmClean(false)}>取消</button>
            </span>
          ) : (
            <button
              onClick={() => {
                setPendingUnlink(null);
                setConfirmClean(true);
              }}
              disabled={busy}
            >
              清理坏链（{broken.length}）
            </button>
          ))}
        <button onClick={() => void onRefresh()} disabled={busy}>
          刷新
        </button>
      </div>
      {pendingUnlink !== null && (
        <div className="toolbar">
          <span className="confirm">
            将删除 {pendingUnlink.length} 条软链接，只删链接本身，不删任何真实文件。
            <button onClick={() => void run(pendingUnlink, false)} disabled={busy}>
              确认删除
            </button>
            <button onClick={() => setPendingUnlink(null)}>取消</button>
          </span>
        </div>
      )}
      {notice && (
        <div className="report">
          <div className="report-head">
            <span>{notice}</span>
            <button className="link" onClick={() => setNotice(null)}>
              关闭
            </button>
          </div>
        </div>
      )}
      {report && (
        <div className="report">
          <div className="report-head">
            <span>本次结果（{report.entries.length} 条）</span>
            <button className="link" onClick={() => setReport(null)}>
              关闭
            </button>
          </div>
          <ul>
            {report.entries.map((e) => (
              <li key={actionId(e.action)}>
                {outcomeText(e.outcome)} · {e.action.targetPath}
              </li>
            ))}
          </ul>
        </div>
      )}
      {pages.length === 0 ? (
        <p>没有可用的目标目录。</p>
      ) : (
        pages.map((page) => (
          <DomainView
            key={page.key}
            overview={overview}
            page={page}
            busy={busy}
            isSelected={(row) => isSelected(page, row)}
            onToggle={(row) => toggleRow(page, row)}
            onSelectAll={(selected) => setPageAll(page, selected)}
            onChange={onRefresh}
            onReport={setReport}
            onError={onError}
            onLink={link}
            onUnlink={askUnlink}
            onNotice={setNotice}
          />
        ))
      )}
    </section>
  );
}
