import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import type {
  AutoLink,
  CellRef,
  DomainPage,
  Overview,
  Source,
  SourceKind,
  SyncReport,
} from "../types";
import { AddButton, AgentKey, Busy, Button, SubPage, Switch, Tag, Toast, Tooltip } from "../ui";
import { defer } from "../deferredCommit.ts";
import { AddedFold } from "./AddedFold.tsx";
import { CheckMark } from "./CheckMark.tsx";
import { joinWords } from "./pendingIssues.ts";
import {
  columnsOf,
  defaultTargets,
  loadImportMemory,
  saveImportMemory,
  distinguishingSegments,
  sameSet,
  undoSlot,
} from "./importDefaults.ts";
import "./ImportPage.css";

/// 添加 skill 页（DESIGN「产品裁决 › 添加页」，画板 Import / ImportEmpty）：占满整窗的二级页面。
///
/// **两列 + 底部一行**：左栏挑来源（`+ 来源` 固定在栏底，列表在其上独立滚动，可滚时出 hairline）；
/// 右栏把这个来源里的 skill 全部列出（两竖列，已添加的整行灰 + 弱标签，同名强标签）。
/// 底部一行 = **一组目标**：agent 图标键一排 + 16 + 行内开关「以后新出现的也加」+ 安全小字 +
/// `添加 N 个`（row 32 主动作；一个目标都没点亮时禁用带原因）。规则目标 = 本次目标，不另画一排。
///
/// - **同名在添加时就地解决**（⑩）：同名的行勾上时就地展开 `替换现有的 · 说明 · 跳过`；
///   不点替换就是跳过（core 不覆盖已有的同名）。能在源头消掉的冲突不留到待处理
/// - **规则只管以后新出现的**（core 建规则时拍 baseline），所以开关不确认；开着时点亮 / 熄灭
///   目标键就是给规则加 / 减目标（加目标不重拍 baseline）
/// - 默认目标（③）：这个来源上次用的目标；没有上次则已安装的前两个
/// - 0 个来源时不分栏：内容区居中三行「还没有来源 / 先添加一个放 skill 的文件夹 / + 来源」

export interface ImportPageProps {
  overview: Overview;
  page: DomainPage;
  /// 全部自动同步规则；决定开关状态、哪些 skill 被排除过
  autoLinks: AutoLink[];
  onClose: () => void;
  onChange: () => Promise<void>;
  onReport: (report: SyncReport) => void;
  onError: (message: string) => void;
  onNotice: (text: string) => void;
}

/// 来源行第二行的灰字：范围（在挑来源时分类有用）
const scopeOf = (kind: SourceKind): string => {
  switch (kind.type) {
    case "universal":
    case "harnessGlobal":
      return "全局";
    case "projectStore":
      return "项目";
    case "manual":
    case "external":
      return "外部";
  }
};

/// 只做尾部分隔符无关的宽松比较，够用于「刚添加的目录是否已出现」
const samePath = (a: string, b: string) => a.replace(/[/\\]+$/, "") === b.replace(/[/\\]+$/, "");

export default function ImportPage({
  overview,
  page,
  autoLinks,
  onClose,
  onChange,
  onReport,
  onError,
  onNotice,
}: ImportPageProps) {
  /// 这个来源在本域还有几个没添加（左栏右端的数）
  const freshCount = (src: Source) =>
    src.skills.filter((sk) => !page.rows.some((r) => r.sourceId === src.id && r.skill === sk.name))
      .length;
  /// 左栏顺序：还有没添加的排前面，全添加过的排后面；**进页时定一次**，添加完不跳位，
  /// 之后新加的来源接在末尾
  const [order] = useState(() =>
    [...overview.sources]
      .sort((a, b) => Number(freshCount(b) > 0) - Number(freshCount(a) > 0))
      .map((x) => x.id),
  );
  const sortedSources = [
    ...order.flatMap((id) => overview.sources.filter((x) => x.id === id)),
    ...overview.sources.filter((x) => !order.includes(x.id)),
  ];
  /// 同名的来源（真机里三个「WeiboAP · 外部」）第二行带上路径里能区分它们的那一级
  const distinct = new Map<string, string>();
  for (const label of new Set(overview.sources.map((x) => x.label))) {
    const same = overview.sources.filter((x) => x.label === label);
    if (same.length < 2) continue;
    distinguishingSegments(same.map((x) => x.path)).forEach((seg, i) =>
      distinct.set(same[i].id, seg),
    );
  }
  // 默认选中第一个还有没添加的来源
  const [selected, setSelected] = useState(
    () => sortedSources.find((x) => freshCount(x) > 0)?.id ?? sortedSources[0]?.id ?? "",
  );
  const [names, setNames] = useState<string[]>([]);
  /// 同名的行里选了「替换现有的」的那些
  const [replace, setReplace] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // 刚通过「+ 来源」加入、等待在新一轮 overview 中出现的路径
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  const source: Source | undefined = overview.sources.find((s) => s.id === selected);
  /// 外部来源不参与自动规则（规则不该指向随时可能消失的目录）
  const autoable = source !== undefined && source.kind.type !== "external";

  /// 本域可逐项建链的目标（整个文件夹是链接的不能）
  const openTargets = page.targets.filter((t) => t.linkedWholeTo === null);
  const memoryKey = `skill|${page.key}|${selected}`;

  /// 该来源的规则；source 是归一化路径，与 Source.id 同形
  const rule = autoLinks.find((r) => r.source === selected);
  const ruleTargets = openTargets
    .filter((t) => (rule?.targets ?? []).includes(t.id))
    .map((t) => t.id);
  const ruleOn = ruleTargets.length > 0;
  const excluded = rule?.excluded ?? [];

  const [targetIds, setTargetIds] = useState<string[]>([]);
  // 目标键的初值：规则开着就是规则的目标；否则这个来源上次用的；再没有就已安装的前两个。
  // 用字符串做依赖，内容没变的重扫不会覆盖用户当场的点选
  const initKey = `${selected}|${ruleTargets.join(",")}|${openTargets.map((t) => t.id).join(",")}`;
  useEffect(() => {
    setTargetIds(
      ruleOn
        ? ruleTargets
        : defaultTargets(
            openTargets.map((t) => t.id),
            loadImportMemory(memoryKey)?.last,
          ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initKey]);

  /// 已添加那一行展开没有；换来源时收起
  const [showAdded, setShowAdded] = useState(false);

  // 切换来源时清空勾选（添加是一次性动作，不预填）
  useEffect(() => {
    setNames([]);
    setReplace([]);
    setShowAdded(false);
  }, [selected]);

  // 选中项消失（如手动来源被移除）时回落到第一项
  useEffect(() => {
    if (overview.sources.some((s) => s.id === selected)) return;
    setSelected(overview.sources[0]?.id ?? "");
  }, [overview.sources, selected]);

  // 新来源出现后选中它
  useEffect(() => {
    if (pendingPath === null) return;
    const found = overview.sources.find(
      (s) => samePath(s.path, pendingPath) || samePath(s.id, pendingPath),
    );
    if (found) setSelected(found.id);
    setPendingPath(null);
  }, [overview, pendingPath]);

  // 来源列表可滚时，列表与 `+ 来源` 之间出 1px hairline；不滚时不显示
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setScrollable(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [overview.sources.length]);

  /// 该来源的 skill 在本域尚无行 = 还没添加
  const notAdded = (sourceId: string, skill: string) =>
    !page.rows.some((r) => r.sourceId === sourceId && r.skill === skill);

  /// 本域里别的来源已经有的同名 skill：名字 → 那一份在哪
  const holders = new Map<string, { sourceId: string; label: string }>();
  for (const row of page.rows) {
    if (row.sourceId === selected || holders.has(row.skill)) continue;
    const label = overview.sources.find((s) => s.id === row.sourceId)?.label ?? row.sourceId;
    holders.set(row.skill, { sourceId: row.sourceId, label });
  }

  const entries = (source?.skills ?? []).map((sk) => ({
    name: sk.name,
    added: !notAdded(selected, sk.name),
    holder: holders.get(sk.name) ?? null,
  }));
  const fresh = entries.filter((e) => !e.added);
  /// 列表只列未添加的；多到一列放不下才分两列
  const columns = columnsOf(fresh, fresh.length > 16 ? 2 : 1);
  const added = entries.filter((e) => e.added);
  const allSelected = fresh.length > 0 && fresh.every((e) => names.includes(e.name));
  const someSelected = fresh.some((e) => names.includes(e.name));

  const toggleName = (skill: string) => {
    setNames((prev) => (prev.includes(skill) ? prev.filter((n) => n !== skill) : [...prev, skill]));
    setReplace((prev) => prev.filter((n) => n !== skill));
  };

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

  /// 行内开关：拨开 = 以本次目标建规则（core 拍 baseline，只管以后新出现的）；拨关 = 撤掉本域目标
  const toggleRule = (next: boolean) => {
    if (source === undefined) return;
    const path = source.path;
    void run(() =>
      next
        ? api.setAutoLink(path, targetIds)
        : api.removeAutoLinkTargets(
            path,
            page.targets.map((t) => t.id),
          ),
    );
  };

  /// 目标键；规则开着时同时给规则加 / 减这一个目标（加目标是合并，不重拍 baseline）
  const toggleTarget = (id: string) => {
    const on = targetIds.includes(id);
    const next = on ? targetIds.filter((t) => t !== id) : [...targetIds, id];
    setTargetIds(next);
    if (!ruleOn || source === undefined) return;
    const path = source.path;
    void run(() => (on ? api.removeAutoLinkTargets(path, [id]) : api.setAutoLink(path, [id])));
  };

  /// 挂起的替换：提示条还在时可撤销；到期、关掉、离开页面时提交
  const [replacing, setReplacing] = useState<{
    /// 提示条的 key：每挂一笔换一个，新提示条重新计时
    key: string;
    names: string[];
    commit: () => void;
    undo: () => void;
  } | null>(null);
  /// 一次只挂一笔替换：再挂之前先把上一笔提交掉
  const pendingReplace = useRef(undoSlot());
  const replaceSeq = useRef(0);
  // 离开页面：挂着的替换就此提交（窗口关闭另有 App 的 flushAll 兜底）
  useEffect(
    () => () => {
      void pendingReplace.current.flush().then(onChange, (e) => onError(String(e)));
    },
    // 只在卸载时跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /// 建链：这些 skill × 点亮的目标里缺的
  const link = async (skills: string[]): Promise<SyncReport | null> => {
    const cells: CellRef[] = skills.flatMap((skill) =>
      targetIds.map((targetId) => ({ sourceId: selected, skill, targetId })),
    );
    const acts = await api.proposeLinks(cells);
    return acts.length === 0 ? null : api.applyAll(acts, false);
  };

  const doAdd = async () => {
    if (source === undefined) return;
    setBusy(true);
    // 上一笔替换还挂着（比如换了来源又替换）：先提交它，失败交给壳，这一次照常做
    if (pendingReplace.current.current()?.isPending()) {
      setReplacing(null);
      try {
        await pendingReplace.current.flush();
      } catch (e) {
        onError(String(e));
      }
    }
    try {
      // 这次又勾上的、之前被排除在规则外的 skill 重新纳入
      for (const skill of names.filter((n) => excluded.includes(n))) {
        await api.includeAutoLink(source.path, skill);
      }
      // 同名选了替换的：先体检一次，在 git 仓库里的不代删、这一行照常跳过
      const replaced: { skill: string; holder: { sourceId: string; label: string } }[] = [];
      for (const skill of replace.filter((n) => names.includes(n))) {
        const holder = holders.get(skill);
        if (!holder) continue;
        const planned = await api.planDeleteSource(holder.sourceId, skill);
        if (planned.plan.inGit !== null) {
          onNotice(`没替换 ${skill}：${holder.label} 那份在 git 仓库里，交给 git 处理更稳妥`);
          continue;
        }
        replaced.push({ skill, holder });
      }
      const direct = names.filter((n) => !replaced.some((r) => r.skill === n));
      const memory = loadImportMemory(memoryKey);
      saveImportMemory(memoryKey, {
        last: targetIds,
        streak: memory && sameSet(memory.last, targetIds) ? memory.streak + 1 : 1,
      });

      if (direct.length > 0) {
        const report = await link(direct);
        if (report === null && replaced.length === 0) {
          // 动作为空不等于「都已经开着了」：同名被占、链接失效、整个文件夹是链接都产出空动作
          onNotice("一个都没添加：选中的 skill 在这些 agent 下的位置已经被占着了");
          await onChange();
          setBusy(false);
          return;
        }
        if (report !== null) onReport(report);
      }

      if (replaced.length === 0) {
        await onChange();
        onClose();
        return;
      }

      // 替换整体挂起：现有那份进废纸篓 + 这一份建链，一起在提交时做；撤销就相当于这几行没做。
      // 提交时再体检一次（后端只存一份删除计划，挂起期间可能被顶掉，也可能磁盘变了）
      const deferKey = `replace:${page.key}:${selected}`;
      const d = defer(deferKey, async () => {
        for (const { skill, holder } of replaced) {
          const planned = await api.planDeleteSource(holder.sourceId, skill);
          if (planned.plan.inGit !== null)
            throw new Error(`没替换 ${skill}：${holder.label} 那份在 git 仓库里`);
          const failed = (await api.deleteSource(planned.planId)).entries.find(
            (e) => e.outcome.status === "failed",
          );
          if (failed && failed.outcome.status === "failed") throw new Error(failed.outcome.reason);
        }
        const report = await link(replaced.map((r) => r.skill));
        if (report !== null) onReport(report);
      });
      pendingReplace.current.hold(d);
      replaceSeq.current += 1;
      // 直接添加的那些已经做完，勾选里只留挂着的替换
      setNames(replaced.map((r) => r.skill));
      const done = () => {
        setReplacing(null);
        setNames([]);
        setReplace([]);
      };
      setReplacing({
        key: `${deferKey}#${replaceSeq.current}`,
        names: replaced.map((r) => r.skill),
        commit: () => {
          done();
          void d.commit().then(onChange, (e) => {
            onError(String(e));
            void onChange();
          });
        },
        undo: () => {
          d.undo();
          done();
          void onChange();
        },
      });
      await onChange();
      setBusy(false);
    } catch (e) {
      onError(String(e));
      setBusy(false);
    }
  };

  const addFolder = async () => {
    const path = await api.pickDirectory("选择放着 skill 的文件夹");
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

  const removeSource = (path: string) => void run(() => api.removeManualSource(path));

  const title = <>添加 skill 到「{page.label}」</>;

  // 0 个来源：不分栏，居中三行
  if (overview.sources.length === 0) {
    return (
      <SubPage title={title} onBack={onClose}>
        <div className="ss-import__nothing">
          <div className="ss-import__nothing-title">还没有来源</div>
          <div className="ss-import__nothing-hint">先添加一个放 skill 的文件夹</div>
          <Button variant="primary" icon={<PlusGlyph />} onClick={() => void addFolder()}>
            来源
          </Button>
        </div>
      </SubPage>
    );
  }

  const chosen = names.length;
  const blocked = busy
    ? "正在处理，等这一下"
    : targetIds.length === 0
      ? "先点亮至少一个 agent"
      : chosen === 0
        ? "先在列表里勾上要添加的 skill"
        : null;

  const memory = loadImportMemory(memoryKey);
  const suggestRule =
    autoable &&
    !ruleOn &&
    memory !== null &&
    memory.streak >= 2 &&
    targetIds.length > 0 &&
    sameSet(memory.last, targetIds);

  const ruleReason = !autoable
    ? "外部来源随时可能不在，不给它建规则"
    : targetIds.length === 0
      ? "先点亮至少一个 agent"
      : undefined;

  return (
    <SubPage title={title} onBack={onClose}>
      <div className="ss-import">
        <div className="ss-import__cols">
          <Busy busy={busy} className="ss-import__sources">
            <div className="ss-import__caption">
              <span>来源</span>
              <span>未添加</span>
            </div>
            <div className="ss-import__srclist" ref={listRef}>
              {sortedSources.map((s) => {
                const count = s.skills.filter((sk) => notAdded(s.id, sk.name)).length;
                const seg = distinct.get(s.id);
                return (
                  <div
                    key={s.id}
                    className={
                      s.id === selected ? "ss-import__source is-active" : "ss-import__source"
                    }
                  >
                    {/* 完整路径进提示框（不用原生 title） */}
                    <Tooltip content={<span className="ss-import__path">{s.path}</span>}>
                      <button
                        type="button"
                        className="ss-import__pick"
                        aria-current={s.id === selected}
                        onClick={() => setSelected(s.id)}
                      >
                        <span className="ss-import__srctext">
                          <span className="ss-import__srcname">{s.label}</span>
                          <span className="ss-import__srcscope">
                            {seg ? `${scopeOf(s.kind)} · ${seg}` : scopeOf(s.kind)}
                          </span>
                        </span>
                        <span
                          className={`ss-import__count${count === 0 ? " is-zero" : ""}`}
                          title="还没出现在这个位置的 skill 数"
                        >
                          {count}
                        </span>
                      </button>
                    </Tooltip>
                    {s.kind.type === "manual" ? (
                      <span className="ss-import__remove">
                        <Button variant="link" onClick={() => removeSource(s.path)}>
                          移除
                        </Button>
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className={`ss-import__add${scrollable ? " is-scrollable" : ""}`}>
              <AddButton noun="来源" onClick={() => void addFolder()} />
            </div>
          </Busy>

          <div className="ss-import__main">
            {source !== undefined && fresh.length === 0 ? (
              // 都已添加：右栏只写一句 + 已添加那一行，不显示底部块
              <div className="ss-import__alldone">
                <div className="ss-import__alldone-text">{source.label}里的都已添加</div>
                <AddedFold
                  count={added.length}
                  open={showAdded}
                  onToggle={() => setShowAdded(!showAdded)}
                >
                  {added.map((e) => (
                    <span key={e.name} className="ss-import__addedname">
                      {e.name}
                    </span>
                  ))}
                </AddedFold>
              </div>
            ) : source !== undefined ? (
              <>
                <div className="ss-import__listhead">
                  <span className="ss-import__headline">
                    {source.label} · <span className="ss-import__num">{source.skills.length}</span>
                  </span>
                  {fresh.length > 0 ? (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={allSelected ? true : someSelected ? "mixed" : false}
                      className="ss-import__all"
                      onClick={() => setNames(allSelected ? [] : fresh.map((e) => e.name))}
                    >
                      <CheckMark on={allSelected} />
                      全选
                    </button>
                  ) : null}
                </div>

                <Busy busy={busy} className="ss-import__grid">
                  {columns.map((col) => (
                    <div className="ss-import__col" key={col[0].name}>
                      {col.map((entry) => {
                        const on = names.includes(entry.name);
                        const chosen = replace.includes(entry.name);
                        const pendingHere = replacing?.names.includes(entry.name) ?? false;
                        return (
                          <div key={entry.name}>
                            <button
                              type="button"
                              className="ss-import__row"
                              role="checkbox"
                              aria-checked={on}
                              onClick={() => toggleName(entry.name)}
                            >
                              <CheckMark on={on} />
                              <span className="ss-import__name">{entry.name}</span>
                              {entry.holder !== null ? (
                                <span className="ss-import__tag">
                                  <Tag
                                    tip={
                                      <>
                                        <b>同名</b>：{entry.holder.label} 里已有一份
                                      </>
                                    }
                                  >
                                    同名
                                  </Tag>
                                </span>
                              ) : null}
                            </button>
                            {replacing !== null && replacing.names[0] === entry.name ? (
                              // 挂起的替换：提示条贴在被替换的那一行下方（锚在触发它的控件上）
                              <div className="ss-import__rowtoast">
                                <Toast
                                  key={replacing.key}
                                  kind="success"
                                  verb="替换"
                                  names={replacing.names}
                                  action={{ label: "撤销", onClick: replacing.undo }}
                                  onDismiss={replacing.commit}
                                  onClose={replacing.commit}
                                />
                              </div>
                            ) : on && entry.holder !== null && !pendingHere ? (
                              <div className="ss-import__clash">
                                {chosen ? (
                                  <Button
                                    size="compact"
                                    variant="primary"
                                    title="不替换了，添加时跳过它"
                                    onClick={() =>
                                      setReplace((prev) => prev.filter((n) => n !== entry.name))
                                    }
                                  >
                                    替换现有的
                                  </Button>
                                ) : (
                                  <Button
                                    size="compact"
                                    onClick={() => setReplace((prev) => [...prev, entry.name])}
                                  >
                                    替换现有的
                                  </Button>
                                )}
                                {/* 后果说明不截断，放不下就折行 */}
                                <span className="ss-import__clashnote">
                                  {joinWords(
                                    "替换后",
                                    entry.holder.label,
                                    "那份进废纸篓、链到它的改指到这一份，可撤销",
                                  )}
                                </span>
                                <Button variant="link" onClick={() => toggleName(entry.name)}>
                                  跳过
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  <AddedFold
                    count={added.length}
                    open={showAdded}
                    onToggle={() => setShowAdded(!showAdded)}
                  >
                    {added.map((e) => (
                      <span key={e.name} className="ss-import__addedname">
                        {e.name}
                      </span>
                    ))}
                  </AddedFold>
                </Busy>
              </>
            ) : null}
          </div>
        </div>

        {source !== undefined && fresh.length === 0 ? null : (
          <Busy busy={busy} className="ss-import__foot">
            <div className="ss-import__keys">
              {page.targets.length === 0 ? (
                <span className="ss-import__hint">还没有启用任何 agent，先去设置里开一个</span>
              ) : (
                page.targets.map((target) => (
                  <AgentKey
                    key={target.id}
                    id={target.scope.harnessId}
                    name={target.label}
                    pressed={targetIds.includes(target.id)}
                    onToggle={() => toggleTarget(target.id)}
                    disabledReason={
                      target.linkedWholeTo === null
                        ? undefined
                        : `${target.label} 的 skills 文件夹整个是链接，拆开后才能逐个开关`
                    }
                  />
                ))
              )}
            </div>
            <span className="ss-import__rule" title="只管以后新出现的，现有的不变">
              <Switch
                size="inline"
                checked={ruleOn}
                onChange={toggleRule}
                label={`${source?.label ?? "这个来源"} 以后新出现的也加`}
                title={
                  source ? `${source.label} 以后新出现的 skill 也自动添加到点亮的 agent` : undefined
                }
                disabledReason={ruleOn ? undefined : ruleReason}
              />
              <span className="ss-import__rulelabel">以后新出现的也加</span>
              {suggestRule ? (
                <span className="ss-import__suggest">每次都选这几个？可以打开</span>
              ) : null}
            </span>
            <span className="ss-import__safety">只建链接，不动源文件</span>
            {blocked ? (
              <Button size="row" variant="primary" disabled disabledReason={blocked}>
                {`添加 ${chosen} 个`}
              </Button>
            ) : (
              <Button size="row" variant="primary" onClick={() => void doAdd()}>
                {`添加 ${chosen} 个`}
              </Button>
            )}
          </Busy>
        )}
      </div>
    </SubPage>
  );
}

/// 反色 `+ 来源` 里的 12px 加号（与 AddButton 同一个图形）
function PlusGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 1.5v9M1.5 6h9" />
    </svg>
  );
}
