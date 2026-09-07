import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { CellRef, DomainPage, Overview, Source, SourceKind, SyncReport } from "./types";

export interface ImportDialogProps {
  overview: Overview;
  page: DomainPage;
  /// 从「编辑」进来时预选的本体位置 id
  initialSourceId?: string;
  onClose: () => void;
  onChange: () => Promise<void>;
  onReport: (report: SyncReport) => void;
  onError: (message: string) => void;
  onNotice: (text: string) => void;
}

/// 左栏标签：本体位置的来源类别
const kindText = (kind: SourceKind): string => {
  switch (kind.type) {
    case "universal":
      return "通用仓库";
    case "harnessGlobal":
      return kind.harnessId;
    case "projectStore":
      return "项目";
    case "manual":
      return "手动";
  }
};

/// 只做尾部分隔符与大小写无关的宽松比较，够用于「刚添加的目录是否已出现」
const samePath = (a: string, b: string) => a.replace(/[/\\]+$/, "") === b.replace(/[/\\]+$/, "");

/// 引入弹层：左栏选本体位置，中栏勾 skill，右栏勾 harness，点「引入」当场建链
export default function ImportDialog({
  overview,
  page,
  initialSourceId,
  onClose,
  onChange,
  onReport,
  onError,
  onNotice,
}: ImportDialogProps) {
  const [selected, setSelected] = useState(initialSourceId ?? overview.sources[0]?.id ?? "");
  const [names, setNames] = useState<string[]>([]);
  // 目标默认全勾；整目录链接的目标不能逐项建链，不在其中
  const [targetIds, setTargetIds] = useState<string[]>(
    page.targets.filter((t) => t.linkedWholeTo === null).map((t) => t.id),
  );
  const [busy, setBusy] = useState(false);
  // 刚通过「选择文件夹…」加入、等待在新一轮 overview 中出现的路径
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  const source: Source | undefined = overview.sources.find((s) => s.id === selected);

  /// 该本体位置的 skill 在本域尚无行 = 还没引入
  const notImported = (sourceId: string, skill: string) =>
    !page.rows.some((r) => r.sourceId === sourceId && r.skill === skill);

  const fresh = (source?.skills ?? []).filter((sk) => notImported(selected, sk));
  const present = (source?.skills ?? []).filter((sk) => !notImported(selected, sk));

  // 「全部」是纯粹的全选开关，只作用于还没引入的那些
  const allSelected = fresh.length > 0 && fresh.every((s) => names.includes(s));
  const someSelected = names.length > 0 && !allSelected;
  const allRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = someSelected;
  }, [someSelected]);

  // 切换本体位置时清空勾选：引入是一次性动作，不预填
  useEffect(() => {
    setNames([]);
  }, [selected]);

  // 新来源出现后选中它；没出现就保持弹层原样
  useEffect(() => {
    if (pendingPath === null) return;
    const found = overview.sources.find(
      (s) => samePath(s.path, pendingPath) || samePath(s.id, pendingPath),
    );
    if (found) setSelected(found.id);
    setPendingPath(null);
  }, [overview, pendingPath]);

  const toggleName = (skill: string, checked: boolean) =>
    setNames((prev) => (checked ? [...prev, skill] : prev.filter((n) => n !== skill)));

  const toggleTarget = (id: string, checked: boolean) =>
    setTargetIds((prev) => (checked ? [...prev, id] : prev.filter((t) => t !== id)));

  const chosen = names.length;

  const doImport = async () => {
    setBusy(true);
    try {
      const cells: CellRef[] = names.flatMap((skill) =>
        targetIds.map((targetId) => ({ sourceId: selected, skill, targetId })),
      );
      const acts = await api.proposeLinks(cells);
      if (acts.length === 0) {
        onNotice("所选 skill 在所选 harness 下都已链接");
        setBusy(false);
        return;
      }
      onReport(await api.applyAll(acts, false));
      await onChange();
      onClose();
    } catch (e) {
      onError(String(e));
      setBusy(false);
    }
  };

  const addFolder = async () => {
    const path = await api.pickDirectory("选择本体位置文件夹");
    if (!path) return;
    setBusy(true);
    try {
      await api.addManualSource(path);
      await onChange();
      setPendingPath(path);
    } catch (e) {
      onError(String(e));
    }
    setBusy(false);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="toolbar">
          <h2>引入 skill 到「{page.label}」</h2>
          <button onClick={onClose}>关闭</button>
        </div>

        <div className="import-dialog">
          <ul className="pick-list import-sources">
            {overview.sources.map((s) => (
              <li
                key={s.id}
                className={s.id === selected ? "active" : undefined}
                title={s.path}
                onClick={() => setSelected(s.id)}
              >
                <span>
                  {s.label}
                  <span className="whole-link">{kindText(s.kind)}</span>
                </span>
                <span className="muted">
                  未引入 {s.skills.filter((sk) => notImported(s.id, sk)).length} 个
                </span>
              </li>
            ))}
          </ul>

          <div className="import-skills">
            {source === undefined ? (
              <p>没有可用的本体位置。</p>
            ) : (
              <>
                <label>
                  <input
                    ref={allRef}
                    type="checkbox"
                    checked={allSelected}
                    disabled={busy || fresh.length === 0}
                    onChange={() => setNames(allSelected ? [] : fresh)}
                  />
                  全部
                </label>
                {fresh.map((skill) => (
                  <label key={skill}>
                    <input
                      type="checkbox"
                      checked={names.includes(skill)}
                      disabled={busy}
                      onChange={(e) => toggleName(skill, e.target.checked)}
                    />
                    {skill}
                  </label>
                ))}
                {fresh.length === 0 && <p className="muted">该本体位置没有可引入的 skill。</p>}
                {present.length > 0 && (
                  <div className="import-present">
                    {present.map((skill) => (
                      <div className="muted" key={skill}>
                        {skill} · 已引入
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="import-targets">
            {page.targets.length === 0 ? (
              <p className="muted">该域下没有可用的目标目录。</p>
            ) : (
              page.targets.map((target) => (
                <label
                  key={target.id}
                  title={target.linkedWholeTo !== null ? "整目录链接，先拆成逐项链接" : target.path}
                >
                  <input
                    type="checkbox"
                    checked={targetIds.includes(target.id)}
                    disabled={busy || target.linkedWholeTo !== null}
                    onChange={(e) => toggleTarget(target.id, e.target.checked)}
                  />
                  {target.label}
                </label>
              ))
            )}
          </div>
        </div>

        <div className="toolbar">
          <button disabled={busy} onClick={() => void addFolder()}>
            选择文件夹…
          </button>
          <span className="muted">
            已选 {chosen} / {fresh.length}
          </span>
          <span style={{ flex: 1 }} />
          <button
            disabled={busy || chosen === 0 || targetIds.length === 0}
            onClick={() => void doImport()}
          >
            引入
          </button>
          <button disabled={busy} onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
