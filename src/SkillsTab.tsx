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

export interface SkillsTabProps {
  overview: Overview | null;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  view: "source" | "domain";
  selectedSourceId: string | null;
  selectedDomainKey: string;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}

export default function SkillsTab({
  overview,
  busy,
  onBusy,
  view,
  selectedSourceId,
  selectedDomainKey,
  onRefresh,
  onError,
}: SkillsTabProps) {
  const [actions, setActions] = useState<PlannedAction[]>([]);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [confirmClean, setConfirmClean] = useState(false);

  // 待办动作跟着 overview 走：App 每次重扫后重新提案
  useEffect(() => {
    if (!overview) return;
    api
      .proposeAll()
      .then(setActions)
      .catch((e) => onError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview]);

  const creates = actions.filter((a) => a.kind === "create");
  const broken = actions.filter((a) => a.kind === "brokenLink");

  const run = async (subset: PlannedAction[], cleanBroken: boolean) => {
    onBusy(true);
    setConfirmClean(false);
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
  const { summary } = overview;
  const source = overview.sources.find((s) => s.id === selectedSourceId) ?? null;

  return (
    <section>
      <div className="toolbar">
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
        <button onClick={() => void onRefresh()} disabled={busy}>
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
      {view === "source" ? (
        source ? (
          <SourceView
            overview={overview}
            source={source}
            busy={busy}
            onChange={onRefresh}
            onError={onError}
          />
        ) : (
          <p>没有可用的本体位置。</p>
        )
      ) : (
        <DomainView
          overview={overview}
          domainKey={selectedDomainKey}
          busy={busy}
          onChange={onRefresh}
          onError={onError}
        />
      )}
    </section>
  );
}
