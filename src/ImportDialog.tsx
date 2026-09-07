import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { DomainPage, Overview, Source, SourceKind } from "./types";

export interface ImportDialogProps {
  overview: Overview;
  page: DomainPage;
  /// 从「编辑」进来时预选的本体位置 id
  initialSourceId?: string;
  onClose: () => void;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
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

/// 引入来源弹层：左栏选本体位置，右栏选 skill
export default function ImportDialog({
  overview,
  page,
  initialSourceId,
  onClose,
  onChange,
  onError,
}: ImportDialogProps) {
  const [selected, setSelected] = useState(initialSourceId ?? overview.sources[0]?.id ?? "");
  const [names, setNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // 刚通过「选择文件夹…」加入、等待在新一轮 overview 中出现的路径
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  const source: Source | undefined = overview.sources.find((s) => s.id === selected);
  const skills = source?.skills ?? [];

  // 「全部」是纯粹的全选开关：全勾时勾选，全空时不勾，部分勾选时半选
  const allSelected = skills.length > 0 && skills.every((s) => names.includes(s));
  const someSelected = names.length > 0 && !allSelected;
  const allRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = someSelected;
  }, [someSelected]);

  // 切换本体位置时按当前已引入名单预填
  useEffect(() => {
    const current = page.imported.find((im) => im.sourceId === selected);
    const src = overview.sources.find((s) => s.id === selected);
    if (!current) setNames([]);
    else if (current.pick === "all") setNames(src?.skills ?? []);
    else setNames(current.pick.only);
  }, [selected, page, overview]);

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

  const chosen = names.length;

  const doImport = async () => {
    setBusy(true);
    try {
      await api.importSource(
        page.targets.map((t) => t.id),
        selected,
        // 全选等价于「以后新增的 skill 也算」，存为 all
        allSelected ? null : names,
      );
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
          <h2>引入来源到「{page.label}」</h2>
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
                  {page.imported.some((im) => im.sourceId === s.id) ? "✓ " : ""}
                  {s.label}
                  <span className="whole-link">{kindText(s.kind)}</span>
                </span>
                <span className="muted">{s.skills.length}</span>
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
                    disabled={busy}
                    onChange={() => setNames(allSelected ? [] : skills)}
                  />
                  全部
                </label>
                {skills.map((skill) => (
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
                {skills.length === 0 && <p className="muted">该本体位置下没有 skill。</p>}
              </>
            )}
          </div>
        </div>

        <div className="toolbar">
          <button disabled={busy} onClick={() => void addFolder()}>
            选择文件夹…
          </button>
          <span className="muted">
            已选 {chosen} / {skills.length}
          </span>
          <span style={{ flex: 1 }} />
          <button disabled={busy || chosen === 0} onClick={() => void doImport()}>
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
