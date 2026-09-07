import { useEffect, useState } from "react";
import { api } from "./api";
import SourceView from "./SourceView";
import DomainView, { domainSourceIds, targetDomainKey } from "./DomainView";
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
  const source = overview.sources.find((s) => s.id === selectedSourceId) ?? null;
  // 工具条跟着侧栏走：本体位置视图按本体位置路径过滤，域视图按本域目标目录过滤
  const domainTargets =
    view === "domain"
      ? overview.targets.filter((t) => targetDomainKey(t) === selectedDomainKey)
      : [];
  const inScope = (path: string): boolean =>
    view === "source"
      ? source !== null && isUnder(path, source.path)
      : domainTargets.some((t) => isUnder(path, t.path));
  const scopedCreates = creates.filter((a) =>
    inScope(view === "source" ? a.sourcePath : a.targetPath),
  );
  const scopedBroken = view === "domain" ? broken.filter((a) => inScope(a.targetPath)) : [];

  // 域视图里列出的本体位置对本域合法：它们在本域目标下的缺口都算本域待同步，
  // 哪怕本域目标还不在它们的同步集里（"同步本域"会先补上）
  const domainSources = view === "domain" ? domainSourceIds(overview, selectedDomainKey) : [];
  const domainSourceIdSet = new Set(domainSources);
  const domainTargetIdSet = new Set(domainTargets.map((t) => t.id));
  const domainPending = overview.cells.filter(
    (c) =>
      c.state === "missing" &&
      domainSourceIdSet.has(c.sourceId) &&
      domainTargetIdSet.has(c.targetId) &&
      !(overview.syncSet.sources[c.sourceId]?.disabledSkills ?? []).includes(c.skill),
  ).length;

  // 先把本域目标并进这些本体位置的同步集，再链接落在本域目标下的缺口；
  // 这样同步集与刚同步出来的链接一致，按本体位置视图里那些目标就是勾上的
  const syncDomain = async () => {
    try {
      for (const id of domainSources) {
        const picked = overview.syncSet.sources[id]?.targets ?? [];
        if (domainTargets.every((t) => picked.includes(t.id))) continue;
        await api.setSourceTargets(id, [
          ...new Set([...picked, ...domainTargets.map((t) => t.id)]),
        ]);
      }
      const acts = await api.proposeAll();
      await run(
        acts.filter((a) => a.kind === "create" && inScope(a.targetPath)),
        false,
      );
    } catch (e) {
      onError(String(e));
    }
  };

  return (
    <section>
      <div className="toolbar">
        {view === "source" ? (
          <>
            <span>此本体位置待同步 {scopedCreates.length} 处</span>
            <button
              onClick={() => void run(scopedCreates, false)}
              disabled={busy || scopedCreates.length === 0}
            >
              同步此本体位置（{scopedCreates.length}）
            </button>
          </>
        ) : (
          <>
            <span>
              本域待同步 {domainPending} 处，坏链 {scopedBroken.length} 处
            </span>
            <button onClick={() => void syncDomain()} disabled={busy || domainPending === 0}>
              同步本域（{domainPending}）
            </button>
            {scopedBroken.length > 0 &&
              (confirmClean ? (
                <span className="confirm">
                  只删除链接本身，不删除任何真实文件。
                  <button onClick={() => void run(scopedBroken, true)} disabled={busy}>
                    确认删除
                  </button>
                  <button onClick={() => setConfirmClean(false)}>取消</button>
                </span>
              ) : (
                <button onClick={() => setConfirmClean(true)} disabled={busy}>
                  清理本域坏链（{scopedBroken.length}）
                </button>
              ))}
          </>
        )}
        <span className="muted">全部 {creates.length} 处待同步</span>
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
          actions={actions}
          busy={busy}
          onChange={onRefresh}
          onError={onError}
        />
      )}
    </section>
  );
}
