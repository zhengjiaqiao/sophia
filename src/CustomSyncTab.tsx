import { useEffect, useState } from "react";
import { api } from "./api";
import { actionId, type ActionKind, type Outcome, type PlannedAction, type SyncRule } from "./types";

const newRule = (): SyncRule => ({
  id: crypto.randomUUID(), name: "新同步", source: "", selection: "all", targets: [], lastRunAt: null,
});

export default function CustomSyncTab({ onError }: { onError: (message: string) => void }) {
  const [rules, setRules] = useState<SyncRule[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    api.listRules().then(setRules).catch((e) => onError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 整个数组一次保存
  const persist = async (next: SyncRule[]) => {
    setRules(next);
    try {
      await api.saveRules(next);
    } catch (e) {
      onError(String(e));
    }
  };
  const selected = rules.find((r) => r.id === selectedId) ?? null;
  const update = (rule: SyncRule) => void persist(rules.map((r) => (r.id === rule.id ? rule : r)));
  const add = () => {
    const r = newRule();
    void persist([...rules, r]);
    setSelectedId(r.id);
  };
  const remove = (id: string) => {
    void persist(rules.filter((r) => r.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  return (
    <section className="custom">
      <aside className="rules">
        <ul>
          {rules.map((r) => (
            <li key={r.id} className={r.id === selectedId ? "active" : ""} onClick={() => setSelectedId(r.id)}>
              <span>{r.name}</span>
              <button className="link" onClick={(e) => { e.stopPropagation(); remove(r.id); }}>删除</button>
            </li>
          ))}
        </ul>
        <button onClick={add}>新建</button>
      </aside>
      {selected ? (
        <RuleEditor key={selected.id} rule={selected} onChange={update} onError={onError} />
      ) : (
        <p>选择或新建一条同步记录</p>
      )}
    </section>
  );
}

type Row = { action: PlannedAction; outcome: Outcome | null };

const KIND_LABEL: Record<ActionKind, string> = {
  create: "将创建", alreadyLinked: "已链接", conflict: "冲突", sourceMissing: "源缺失", brokenLink: "坏链",
};
function rowText(r: Row): string {
  if (!r.outcome) return KIND_LABEL[r.action.kind];
  switch (r.outcome.status) {
    case "created": return "已创建";
    case "removed": return "已删除";
    case "skipped": return KIND_LABEL[r.action.kind];
    case "failed": return `失败：${r.outcome.reason}`;
  }
}

function RuleEditor({ rule, onChange, onError }: { rule: SyncRule; onChange: (r: SyncRule) => void; onError: (m: string) => void }) {
  const [items, setItems] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [confirmClean, setConfirmClean] = useState(false);
  const [busy, setBusy] = useState(false);

  const configKey = `${rule.source}|${rule.targets.join("|")}|${JSON.stringify(rule.selection)}`;
  // 配置变了，旧预览作废；lastRunAt 与名称不影响
  useEffect(() => {
    setRows([]);
  }, [configKey]);

  useEffect(() => {
    if (!rule.source || rule.selection === "all") {
      setItems([]);
      return;
    }
    api.listSourceItems(rule.source).then(setItems).catch(() => setItems([]));
  }, [rule.source, rule.selection === "all"]);

  const selectedItems = rule.selection === "all" ? new Set<string>() : new Set(rule.selection.items);
  const toggleItem = (name: string, on: boolean) => {
    const next = new Set(selectedItems);
    if (on) next.add(name); else next.delete(name);
    onChange({ ...rule, selection: { items: [...next].sort() } });
  };

  const pickSource = async () => {
    const p = await api.pickDirectory("选择源目录");
    if (p) onChange({ ...rule, source: p });
  };
  const pickTarget = async (index: number) => {
    const p = await api.pickDirectory("选择目标目录");
    if (p) onChange({ ...rule, targets: rule.targets.map((t, i) => (i === index ? p : t)) });
  };

  const pendingCreates = rows.filter((r) => r.action.kind === "create" && r.outcome === null).map((r) => r.action);
  const pendingBroken = rows.filter((r) => r.action.kind === "brokenLink" && r.outcome?.status !== "removed").map((r) => r.action);
  const configured = rule.source !== "" && rule.targets.length > 0 && rule.targets.every((t) => t !== "");

  const preview = async () => {
    setBusy(true);
    try {
      setRows((await api.planRule(rule)).map((action) => ({ action, outcome: null })));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 只把选中的动作交给 Executor，结果按 action id 合并回表格
  const run = async (actions: PlannedAction[], cleanBroken: boolean) => {
    setBusy(true);
    setConfirmClean(false);
    try {
      const report = await api.applyRule(actions, cleanBroken);
      const outcomes = new Map(report.entries.map((e) => [actionId(e.action), e.outcome]));
      setRows((prev) => prev.map((r) => ({ ...r, outcome: outcomes.get(actionId(r.action)) ?? r.outcome })));
      onChange({ ...rule, lastRunAt: new Date().toISOString() });
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor">
      <fieldset>
        <legend>名称</legend>
        <input type="text" value={rule.name} onChange={(e) => onChange({ ...rule, name: e.target.value })} />
      </fieldset>
      <fieldset>
        <legend>源目录</legend>
        <div className="row">
          <input type="text" value={rule.source} placeholder="输入路径或点选择…" onChange={(e) => onChange({ ...rule, source: e.target.value })} />
          <button onClick={() => void pickSource()}>选择…</button>
        </div>
        <label className="row">
          <input type="checkbox" checked={rule.selection === "all"} onChange={(e) => onChange({ ...rule, selection: e.target.checked ? "all" : { items: [] } })} />
          同步整个目录
        </label>
        {rule.selection !== "all" && (
          <div>
            {items.length === 0 && <p>源目录为空或未设置</p>}
            {items.map((name) => (
              <label key={name} className="row">
                <input type="checkbox" checked={selectedItems.has(name)} onChange={(e) => toggleItem(name, e.target.checked)} />
                {name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <fieldset>
        <legend>目标目录</legend>
        {rule.targets.map((t, i) => (
          <div className="row" key={i}>
            <input type="text" value={t} placeholder="输入路径或点选择…" onChange={(e) => onChange({ ...rule, targets: rule.targets.map((x, j) => (j === i ? e.target.value : x)) })} />
            <button onClick={() => void pickTarget(i)}>选择…</button>
            <button onClick={() => onChange({ ...rule, targets: rule.targets.filter((_, j) => j !== i) })}>移除</button>
          </div>
        ))}
        <button onClick={() => onChange({ ...rule, targets: [...rule.targets, ""] })}>添加目标</button>
      </fieldset>
      <fieldset>
        <legend>预览与执行</legend>
        <div className="toolbar">
          <button onClick={() => void preview()} disabled={busy || !configured}>预览</button>
          <button onClick={() => void run(pendingCreates, false)} disabled={busy || pendingCreates.length === 0}>执行（{pendingCreates.length}）</button>
          {pendingBroken.length > 0 && !confirmClean && (
            <button onClick={() => setConfirmClean(true)} disabled={busy}>清理坏链（{pendingBroken.length}）</button>
          )}
          {confirmClean && (
            <span className="confirm">
              只删除指向本源目录且源已不存在的软链接，不会删除任何真实文件。
              <button onClick={() => void run(pendingBroken, true)} disabled={busy}>确认删除</button>
              <button onClick={() => setConfirmClean(false)}>取消</button>
            </span>
          )}
          {rule.lastRunAt && <span>上次执行：{new Date(rule.lastRunAt).toLocaleString()}</span>}
        </div>
        {rows.length > 0 && (
          <table className="preview">
            <thead><tr><th>状态</th><th>子项</th><th>目标目录</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={actionId(r.action)}>
                  <td>{rowText(r)}</td>
                  <td>{r.action.itemName}</td>
                  <td>{r.action.target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </fieldset>
    </div>
  );
}
