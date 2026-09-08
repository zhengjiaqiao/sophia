import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type {
  AutoLink,
  CellRef,
  DomainPage,
  Overview,
  Source,
  SourceKind,
  SyncReport,
} from "./types";

export interface ImportDialogProps {
  overview: Overview;
  page: DomainPage;
  /// 全部自动同步规则；决定复选框与目标栏的默认值、哪些 skill 已被排除
  autoLinks: AutoLink[];
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
    case "external":
      return "外部";
  }
};

/// 只做尾部分隔符与大小写无关的宽松比较，够用于「刚添加的目录是否已出现」
const samePath = (a: string, b: string) => a.replace(/[/\\]+$/, "") === b.replace(/[/\\]+$/, "");

/// 引入弹层：左栏选本体位置，中栏勾 skill，右栏勾 harness，点「引入」当场建链
export default function ImportDialog({
  overview,
  page,
  autoLinks,
  onClose,
  onChange,
  onReport,
  onError,
  onNotice,
}: ImportDialogProps) {
  const [selected, setSelected] = useState(overview.sources[0]?.id ?? "");
  const [names, setNames] = useState<string[]>([]);
  // 目标默认全勾；整目录链接的目标不能逐项建链，不在其中
  const [targetIds, setTargetIds] = useState<string[]>(
    page.targets.filter((t) => t.linkedWholeTo === null).map((t) => t.id),
  );
  const [busy, setBusy] = useState(false);
  // 当前本体位置在本域有没有自动同步规则；切换位置时随之变化
  const [auto, setAuto] = useState(false);
  // 待确认的"开启自动同步"
  const [confirmAuto, setConfirmAuto] = useState(false);
  // 刚通过「选择文件夹…」加入、等待在新一轮 overview 中出现的路径
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  const source: Source | undefined = overview.sources.find((s) => s.id === selected);
  /// 外部本体位置不参与自动同步（规则也不该指向它）
  const autoable = source !== undefined && source.kind.type !== "external";

  /// 该本体位置的 skill 在本域尚无行 = 还没引入
  const notImported = (sourceId: string, skill: string) =>
    !page.rows.some((r) => r.sourceId === sourceId && r.skill === skill);

  const fresh = (source?.skills ?? []).filter((sk) => notImported(selected, sk.name));
  const present = (source?.skills ?? []).filter((sk) => !notImported(selected, sk.name));

  // 「全部」是纯粹的全选开关，只作用于还没引入的那些
  const allSelected = fresh.length > 0 && fresh.every((s) => names.includes(s.name));
  const someSelected = names.length > 0 && !allSelected;
  const allRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = someSelected;
  }, [someSelected]);

  /// 该本体位置的规则；source 是归一化路径，与 Source.id 同形
  const rule = autoLinks.find((r) => r.source === selected);
  /// 规则里落在本域的目标；非空 = 本域已开启自动同步
  const ruleTargets = page.targets
    .filter((t) => (rule?.targets ?? []).includes(t.id))
    .map((t) => t.id);
  const ruleOn = ruleTargets.length > 0;
  /// 本域可逐项建链的目标（整目录链接的不能）
  const openTargets = page.targets.filter((t) => t.linkedWholeTo === null).map((t) => t.id);
  /// 撤规则时要撤掉的本域目标：本域全部
  const domainTargets = page.targets.map((t) => t.id);

  /// 该本体位置里被排除、不再自动链接的 skill
  const excluded = rule?.excluded ?? [];

  // 切换本体位置时清空勾选（引入是一次性动作，不预填）
  useEffect(() => setNames([]), [selected]);

  // 开关与右栏初值跟着当前本体位置的规则走；用字符串做依赖，
  // 内容没变的重扫不会覆盖用户当场的勾选
  const initKey = `${selected}|${ruleTargets.join(",")}|${openTargets.join(",")}`;
  useEffect(() => {
    setAuto(ruleOn);
    setTargetIds(ruleOn ? ruleTargets : openTargets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initKey]);

  // 选中项消失（如手动本体位置被移除）时回落到第一项
  useEffect(() => {
    if (overview.sources.some((s) => s.id === selected)) return;
    setSelected(overview.sources[0]?.id ?? "");
  }, [overview.sources, selected]);

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

  // 写操作后统一重扫（重扫会自动补齐并弹浮层）；失败只报错，不改本地状态
  const run = async (act: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await act();
      await onChange();
    } catch (e) {
      onError(String(e));
    }
    setBusy(false);
  };

  /// 切换开关即保存：勾上按右栏当前勾选建规则，取消则撤掉本域全部目标
  const toggleAuto = (checked: boolean) => {
    if (source === undefined) return;
    // 勾上会把这个位置下所有未引入的 skill 一次链过去，影响面大，先确认
    if (checked) {
      setConfirmAuto(true);
      return;
    }
    const path = source.path;
    void run(async () => {
      await api.removeAutoLinkTargets(path, domainTargets);
      setAuto(false);
    });
  };

  const enableAuto = () => {
    if (source === undefined) return;
    const path = source.path;
    setConfirmAuto(false);
    void run(async () => {
      await api.setAutoLink(path, targetIds);
      setAuto(true);
    });
  };

  // 开启自动同步时会立刻建链的 skill 数：未引入且未被排除的
  const autoCount = fresh.filter((sk) => !excluded.includes(sk.name)).length;
  const targetLabels = page.targets
    .filter((t) => targetIds.includes(t.id))
    .map((t) => t.label)
    .join("、");

  /// 右栏勾选；规则已开启时同时改写规则（全取消 = 取消规则）
  const toggleTarget = (id: string, checked: boolean) => {
    const next = checked ? [...targetIds, id] : targetIds.filter((t) => t !== id);
    if (!auto || source === undefined) {
      setTargetIds(next);
      return;
    }
    const path = source.path;
    void run(async () => {
      await api.removeAutoLinkTargets(path, domainTargets);
      if (next.length > 0) await api.setAutoLink(path, next);
      setTargetIds(next);
      setAuto(next.length > 0);
    });
  };

  const chosen = names.length;

  const doImport = async () => {
    if (source === undefined) return;
    setBusy(true);
    try {
      // 这次又勾上的 skill 重新纳入自动同步
      const reincluded = names.filter((n) => excluded.includes(n));
      for (const skill of reincluded) {
        await api.includeAutoLink(source.path, skill);
      }
      const cells: CellRef[] = names.flatMap((skill) =>
        targetIds.map((targetId) => ({ sourceId: selected, skill, targetId })),
      );
      const acts = await api.proposeLinks(cells);
      if (acts.length === 0) {
        onNotice("所选 skill 在所选 harness 下都已链接");
        if (reincluded.length > 0) await onChange();
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

  const removeSource = async (path: string) => {
    setBusy(true);
    try {
      await api.removeManualSource(path);
      await onChange();
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
                  未引入 {s.skills.filter((sk) => notImported(s.id, sk.name)).length} 个
                </span>
                {s.kind.type === "manual" && (
                  <button
                    className="link"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeSource(s.path);
                    }}
                  >
                    移除
                  </button>
                )}
              </li>
            ))}
          </ul>

          <div className="import-skills">
            {source === undefined ? (
              <p>没有可用的本体位置。</p>
            ) : (
              <>
                {autoable && (
                  <label className="auto-toggle">
                    <input
                      type="checkbox"
                      checked={auto}
                      disabled={busy || targetIds.length === 0}
                      onChange={(e) => toggleAuto(e.target.checked)}
                    />
                    自动同步「{source.label}」：新增的 skill 自动链接到右侧勾选的 harness
                  </label>
                )}
                <label>
                  <input
                    ref={allRef}
                    type="checkbox"
                    checked={allSelected}
                    disabled={busy || fresh.length === 0}
                    onChange={() => setNames(allSelected ? [] : fresh.map((sk) => sk.name))}
                  />
                  全部
                </label>
                {fresh.map((skill) => (
                  <label key={skill.name}>
                    <input
                      type="checkbox"
                      checked={names.includes(skill.name)}
                      disabled={busy}
                      onChange={(e) => toggleName(skill.name, e.target.checked)}
                    />
                    {skill.name}
                    {excluded.includes(skill.name) && <span className="muted">已排除自动同步</span>}
                  </label>
                ))}
                {fresh.length === 0 && (
                  <p className="muted">
                    {auto && autoable
                      ? "已自动同步，新增的 skill 会自动链接。"
                      : "该本体位置没有可引入的 skill。"}
                  </p>
                )}
                {present.length > 0 && (
                  <div className="import-present">
                    {present.map((skill) => (
                      <div className="muted" key={skill.name}>
                        {skill.name} · 已引入
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
      {confirmAuto && source !== undefined && (
        <div className="modal-backdrop" onClick={() => setConfirmAuto(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="toolbar">
              <h2>开启自动同步</h2>
            </div>
            <p>
              将立即把「{source.label}」下 {autoCount} 个未引入的 skill 链接到
              {targetLabels || "（未选 harness）"}，以后该位置新增的 skill
              也会自动链接。只建软链接，不复制、不删除任何文件。
            </p>
            <div className="toolbar">
              <span style={{ flex: 1 }} />
              <button disabled={busy || targetIds.length === 0} onClick={enableAuto}>
                确认开启
              </button>
              <button disabled={busy} onClick={() => setConfirmAuto(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
