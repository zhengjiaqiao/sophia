import { useEffect, useState } from "react";
import { api } from "./api";
import { actionId, type CellState, type Domain, type Matrix, type Outcome, type PlannedAction, type SyncReport } from "./types";

const SYMBOL: Record<CellState, string> = {
  home: "●", linked: "✓", missing: "○", broken: "✗", foreign: "→", duplicateHome: "⚠", inaccessible: "–",
};
const LABEL: Record<CellState, string> = {
  home: "本体", linked: "已链接", missing: "缺失", broken: "坏链", foreign: "指向他处", duplicateHome: "多本体", inaccessible: "不可访问",
};

function outcomeText(o: Outcome): string {
  switch (o.status) {
    case "created": return "已创建";
    case "removed": return "已删除";
    case "skipped": return "跳过";
    case "failed": return `失败：${o.reason}`;
  }
}

export default function SkillsTab({ domain, onError }: { domain: Domain; onError: (message: string) => void }) {
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [actions, setActions] = useState<PlannedAction[]>([]);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClean, setConfirmClean] = useState(false);

  // 扫描是纯读操作；每次动作后重新扫描而不是在前端修改状态
  const refresh = async () => {
    setBusy(true);
    try {
      setMatrix(await api.scanDomain(domain));
      setActions(await api.propose(domain));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void refresh();
    // domain 变化时 App 通过 key 重建本组件，这里只需首次加载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const creates = actions.filter((a) => a.kind === "create");
  const broken = actions.filter((a) => a.kind === "brokenLink");

  const run = async (subset: PlannedAction[], cleanBroken: boolean) => {
    setBusy(true);
    setConfirmClean(false);
    try {
      setReport(await api.apply(subset, cleanBroken, domain));
      setMatrix(await api.scanDomain(domain));
      setActions(await api.propose(domain));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!matrix) return <p>扫描中…</p>;
  const { summary } = matrix;

  return (
    <section>
      <div className="toolbar">
        <span>
          {summary.skills} 个 skill，{summary.missing} 处缺失，{summary.broken} 处坏链，{summary.ambiguous} 行多本体
        </span>
        <button onClick={() => void refresh()} disabled={busy}>刷新</button>
        <button onClick={() => void run(creates, false)} disabled={busy || creates.length === 0}>
          同步缺失链接（{creates.length}）
        </button>
        {broken.length > 0 && !confirmClean && (
          <button onClick={() => setConfirmClean(true)} disabled={busy}>清理坏链（{broken.length}）</button>
        )}
        {confirmClean && (
          <span className="confirm">
            只删除链接本身，不删除任何真实文件。
            <button onClick={() => void run(broken, true)} disabled={busy}>确认删除</button>
            <button onClick={() => setConfirmClean(false)}>取消</button>
          </span>
        )}
      </div>
      {report && (
        <ul className="report">
          {report.entries.map((e) => (
            <li key={actionId(e.action)}>{outcomeText(e.outcome)} · {e.action.targetPath}</li>
          ))}
        </ul>
      )}
      {matrix.rows.length === 0 ? (
        <p>这个域里没有发现 skill。</p>
      ) : (
        <table className="matrix">
          <thead>
            <tr>
              <th>skill</th>
              <th>本体</th>
              {matrix.columns.map((c) => (
                <th key={c.id} title={c.path}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((r) => (
              <tr key={r.name} className={r.ambiguous ? "ambiguous" : ""}>
                <td>
                  {r.name}
                  {r.ambiguous && <span className="tag">多本体</span>}
                  {r.externalHome && <span className="tag">外部本体</span>}
                </td>
                <td className="path" title={r.home ?? ""}>{r.home ?? "—"}</td>
                {r.cells.map((c) => (
                  <td key={c.columnId} className={`cell ${c.state}`} title={`${LABEL[c.state]}：${c.path}`}>
                    {SYMBOL[c.state]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
