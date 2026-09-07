import { useEffect, useState } from "react";
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
  // 「全部」开关；开启时逐项复选框全勾且禁用
  const [all, setAll] = useState(false);
  const [names, setNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // 刚通过「选择文件夹…」加入、等待在新一轮 overview 中出现的路径
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  const source: Source | undefined = overview.sources.find((s) => s.id === selected);
  const skills = source?.skills ?? [];

  // 切换本体位置时按当前已引入名单预填
  useEffect(() => {
    const current = page.imported.find((im) => im.sourceId === selected);
    const src = overview.sources.find((s) => s.id === selected);
    if (!current) {
      setAll(false);
      setNames([]);
    } else if (current.pick === "all") {
      setAll(true);
      setNames(src?.skills ?? []);
    } else {
      setAll(false);
      setNames(current.pick.only);
    }
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

  const chosen = all ? skills.length : names.length;

  const doImport = async () => {
    setBusy(true);
    try {
      await api.importSource(
        page.targets.map((t) => t.id),
        selected,
        all ? null : names,
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
                    type="checkbox"
                    checked={all}
                    disabled={busy}
                    onChange={(e) => {
                      setAll(e.target.checked);
                      if (e.target.checked) setNames(skills);
                    }}
                  />
                  全部
                </label>
                {skills.map((skill) => (
                  <label key={skill}>
                    <input
                      type="checkbox"
                      checked={all || names.includes(skill)}
                      disabled={all || busy}
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
