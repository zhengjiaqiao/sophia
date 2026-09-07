import { useEffect, useState } from "react";
import { api } from "./api";
import DomainView from "./DomainView";
import { isUnder } from "./paths";
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

  // 结果框是暂态的：6 秒后自行消失
  useEffect(() => {
    if (!report) return;
    const timer = setTimeout(() => setReport(null), 6000);
    return () => clearTimeout(timer);
  }, [report]);

  // 结果只属于当次选择：切换侧栏选中项就作废
  useEffect(() => {
    setReport(null);
    setConfirmClean(false);
  }, [selectedKey]);

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

  const pages =
    selectedKey === "all"
      ? overview.domains
      : overview.domains.filter((d) => d.key === selectedKey);
  const pending = pages.reduce((n, p) => n + p.pendingMissing, 0);
  const broken = pages.flatMap((p) => p.broken);

  // 待同步的缺口由后端按域算好，同步时从最新提案里取落在这些域目标下的 Create
  const targetPaths = pages.flatMap((p) => p.targets.map((t) => t.path));
  const syncNow = async () => {
    try {
      const acts = await api.proposeAll();
      await run(
        acts.filter(
          (a) => a.kind === "create" && targetPaths.some((p) => isUnder(a.targetPath, p)),
        ),
        false,
      );
    } catch (e) {
      onError(String(e));
    }
  };

  return (
    <section>
      <div className="toolbar">
        <span>
          待同步 {pending} 处，坏链 {broken.length} 处
        </span>
        <button onClick={() => void syncNow()} disabled={busy || pending === 0}>
          同步（{pending}）
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
            <button onClick={() => setConfirmClean(true)} disabled={busy}>
              清理坏链（{broken.length}）
            </button>
          ))}
        <span className="muted">
          全部 {actions.filter((a) => a.kind === "create").length} 处待同步
        </span>
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
            onChange={onRefresh}
            onError={onError}
          />
        ))
      )}
    </section>
  );
}
