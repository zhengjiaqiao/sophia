import { useEffect, useState } from "react";
import { api } from "./api";
import DomainView from "./DomainView";
import {
  actionId,
  type DomainPage,
  type DomainRow,
  type Outcome,
  type Overview,
  type PlannedAction,
  type RowRef,
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
  const [confirmClean, setConfirmClean] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  // 被取消勾选的行；不在集合里即选中，所以默认全选、新出现的行也默认选中
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  // 结果框是暂态的：6 秒后自行消失
  useEffect(() => {
    if (!report) return;
    const timer = setTimeout(() => setReport(null), 6000);
    return () => clearTimeout(timer);
  }, [report]);

  // 结果与选择都只属于当次选择：切换侧栏选中项就作废
  useEffect(() => {
    setReport(null);
    setConfirmClean(false);
    setConfirmUnlink(false);
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
    setConfirmUnlink(false);
    try {
      setReport(await api.applyAll(subset, cleanBroken));
    } catch (e) {
      onError(String(e));
    } finally {
      onBusy(false);
    }
    await onRefresh();
  };

  if (!overview) return <p>扫描中…</p>;

  const pages =
    selectedKey === "all"
      ? overview.domains
      : overview.domains.filter((d) => d.key === selectedKey);
  const broken = pages.flatMap((p) => p.broken);

  // 勾选的行；建链与删链都只作用于它们
  const selectedRows: RowRef[] = pages.flatMap((page) =>
    page.rows
      .filter((row) => isSelected(page, row))
      .map((row) => ({ domain: page.key, sourceId: row.sourceId, skill: row.skill })),
  );

  // 计数按格算：一行在多个目标上缺失就算多处
  let missing = 0;
  let unlinkable = 0;
  for (const page of pages) {
    for (const row of page.rows) {
      if (!isSelected(page, row)) continue;
      for (const cell of row.cells) {
        if (cell.state === "missing") missing += 1;
        if (cell.state === "linked") {
          const target = page.targets.find((t) => t.id === cell.targetId);
          if (target && target.linkedWholeTo === null) unlinkable += 1;
        }
      }
    }
  }

  const linkNow = async () => {
    try {
      const acts = await api.proposeLinks(selectedRows);
      if (acts.length === 0) {
        onError("没有需要处理的链接");
        return;
      }
      await run(acts, false);
    } catch (e) {
      onError(String(e));
    }
  };

  const unlinkNow = async () => {
    try {
      const acts = await api.proposeUnlinks(selectedRows);
      if (acts.length === 0) {
        setConfirmUnlink(false);
        onError("没有需要处理的链接");
        return;
      }
      await run(acts, false);
    } catch (e) {
      onError(String(e));
    }
  };

  return (
    <section>
      <div className="toolbar">
        <span>坏链 {broken.length} 处</span>
        <button onClick={() => void linkNow()} disabled={busy || missing === 0}>
          补齐缺失（{missing}）
        </button>
        {confirmUnlink ? (
          <span className="confirm">
            只删除软链接本身，不删除任何真实文件。
            <button onClick={() => void unlinkNow()} disabled={busy}>
              确认删除
            </button>
            <button onClick={() => setConfirmUnlink(false)}>取消</button>
          </span>
        ) : (
          <button
            onClick={() => {
              setConfirmClean(false);
              setConfirmUnlink(true);
            }}
            disabled={busy || unlinkable === 0}
          >
            取消链接（{unlinkable}）
          </button>
        )}
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
                setConfirmUnlink(false);
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
          />
        ))
      )}
    </section>
  );
}
