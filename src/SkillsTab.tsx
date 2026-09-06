import { useEffect, useState } from "react";
import { api } from "./api";
import SourceView from "./SourceView";
import DomainView from "./DomainView";
import {
  actionId,
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

export default function SkillsTab({ onError }: { onError: (message: string) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [actions, setActions] = useState<PlannedAction[]>([]);
  const [view, setView] = useState<"source" | "domain">("source");
  const [report, setReport] = useState<SyncReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClean, setConfirmClean] = useState(false);

  // 扫描是纯读操作；任何勾选或动作之后重新扫描，而不是在前端改状态
  const refresh = async () => {
    setBusy(true);
    try {
      setOverview(await api.scanAll());
      setActions(await api.proposeAll());
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void refresh();
    // App 通过 key 重建本组件，这里只需首次加载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const creates = actions.filter((a) => a.kind === "create");
  const broken = actions.filter((a) => a.kind === "brokenLink");

  const run = async (subset: PlannedAction[], cleanBroken: boolean) => {
    setBusy(true);
    setConfirmClean(false);
    try {
      setReport(await api.applyAll(subset, cleanBroken));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
    await refresh();
  };

  if (!overview) return <p>扫描中…</p>;
  const { summary } = overview;
  const View = view === "source" ? SourceView : DomainView;

  return (
    <section>
      <div className="toolbar">
        <button className={view === "source" ? "active" : ""} onClick={() => setView("source")}>
          按本体位置
        </button>
        <button className={view === "domain" ? "active" : ""} onClick={() => setView("domain")}>
          按域
        </button>
        <span>
          {summary.sources} 个本体位置，{summary.pendingMissing} 处待同步，{summary.broken} 处坏链
        </span>
        <button onClick={() => void run(creates, false)} disabled={busy || creates.length === 0}>
          同步（{creates.length}）
        </button>
        {broken.length > 0 && !confirmClean && (
          <button onClick={() => setConfirmClean(true)} disabled={busy}>
            清理坏链（{broken.length}）
          </button>
        )}
        {confirmClean && (
          <span className="confirm">
            只删除链接本身，不删除任何真实文件。
            <button onClick={() => void run(broken, true)} disabled={busy}>
              确认删除
            </button>
            <button onClick={() => setConfirmClean(false)}>取消</button>
          </span>
        )}
        <button onClick={() => void refresh()} disabled={busy}>
          刷新
        </button>
      </div>
      {report && (
        <ul className="report">
          {report.entries.map((e) => (
            <li key={actionId(e.action)}>
              {outcomeText(e.outcome)} · {e.action.targetPath}
            </li>
          ))}
        </ul>
      )}
      <View overview={overview} busy={busy} onChange={refresh} onError={onError} />
    </section>
  );
}
