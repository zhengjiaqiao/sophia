import { useEffect, useState } from "react";
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
import { AgentIcon, Busy, Button, Chip, Confirm, Empty, SubPage, Plain } from "../ui";
import "./ImportPage.css";

/// 导入页（组件规范 §4.6）：占满整窗的二级页面，不是弹层。
///
/// 左边挑来源，右边把这个来源里的 skill **全部列出**——铺开的意义就在这儿：
/// 弹层里 720px 塞三栏，26 个本体只能列 15 个再加一行「…还有 11 个」；
/// 整窗两竖列一屏看全，不截断。agent 选择挪到右区底部横排，腾出的宽度全给列表。

export interface ImportPageProps {
  overview: Overview;
  page: DomainPage;
  /// 全部自动同步规则；决定复选框与 agent 选择的默认值、哪些 skill 已被排除
  autoLinks: AutoLink[];
  onClose: () => void;
  onChange: () => Promise<void>;
  onReport: (report: SyncReport) => void;
  onError: (message: string) => void;
  onNotice: (text: string) => void;
}

/// 来源行右侧的小方标签：只在名字本身说不清来路时才给。
/// 通用仓库与 agent 全局目录的名字已经把来路说尽了，再挂个标签就是噪音
const kindTag = (kind: SourceKind): string | null => {
  switch (kind.type) {
    case "universal":
    case "harnessGlobal":
      return null;
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

/// 切成若干竖排的列，按列读（字母序竖着看比横着跳舒服）。
/// 列数随数量涨：本机最大的来源有 39 个 skill，两列要 20 行、一屏放不下，三列 13 行正好
function columnsOf<T>(list: T[], count: number): T[][] {
  const per = Math.ceil(list.length / count);
  return Array.from({ length: count }, (_, i) => list.slice(i * per, (i + 1) * per)).filter(
    (col) => col.length > 0,
  );
}

const CHECK_GLYPH = (
  <svg
    width="8"
    height="8"
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    aria-hidden="true"
  >
    <path d="M2 5.2l2 2 4-4.4" />
  </svg>
);

/// 12px 复选方块。整行是按钮，方块本身只是画出来的记号
function CheckBox({ on, dim }: { on: boolean; dim?: boolean }) {
  const classes = ["ss-check"];
  if (on) classes.push("is-on");
  if (dim) classes.push("is-dim");
  return (
    <span className={classes.join(" ")} aria-hidden="true">
      {on ? CHECK_GLYPH : null}
    </span>
  );
}

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
  const [selected, setSelected] = useState(overview.sources[0]?.id ?? "");
  const [names, setNames] = useState<string[]>([]);
  // 目标默认全勾；整目录链接的目标不能逐项建链，不在其中
  const [targetIds, setTargetIds] = useState<string[]>(
    page.targets.filter((t) => t.linkedWholeTo === null).map((t) => t.id),
  );
  const [busy, setBusy] = useState(false);
  // 当前来源在本域有没有自动同步规则；切换来源时随之变化
  const [auto, setAuto] = useState(false);
  // 待确认的「开启自动同步」
  const [confirmAuto, setConfirmAuto] = useState(false);
  // 刚通过「添加来源…」加入、等待在新一轮 overview 中出现的路径
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  const source: Source | undefined = overview.sources.find((s) => s.id === selected);
  /// 外部来源不参与自动同步（规则也不该指向它）
  const autoable = source !== undefined && source.kind.type !== "external";

  /// 该来源的 skill 在本域尚无行 = 还没导入
  const notImported = (sourceId: string, skill: string) =>
    !page.rows.some((r) => r.sourceId === sourceId && r.skill === skill);

  const fresh = (source?.skills ?? []).filter((sk) => notImported(selected, sk.name));

  /// 本域别的来源已经占着的名字：导入后会撞名，进待处理
  const taken = new Set(page.rows.filter((r) => r.sourceId !== selected).map((r) => r.skill));
  const clashes = fresh.filter((sk) => taken.has(sk.name)).length;

  /// 该来源的规则；source 是归一化路径，与 Source.id 同形
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

  /// 该来源里被排除、不再自动开启的 skill
  const excluded = rule?.excluded ?? [];

  // 切换来源时清空勾选（导入是一次性动作，不预填）
  useEffect(() => setNames([]), [selected]);

  // 开关与 agent 选择的初值跟着当前来源的规则走；用字符串做依赖，
  // 内容没变的重扫不会覆盖用户当场的勾选
  const initKey = `${selected}|${ruleTargets.join(",")}|${openTargets.join(",")}`;
  useEffect(() => {
    setAuto(ruleOn);
    setTargetIds(ruleOn ? ruleTargets : openTargets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initKey]);

  // 选中项消失（如手动来源被移除）时回落到第一项
  useEffect(() => {
    if (overview.sources.some((s) => s.id === selected)) return;
    setSelected(overview.sources[0]?.id ?? "");
  }, [overview.sources, selected]);

  // 新来源出现后选中它；没出现就保持原样
  useEffect(() => {
    if (pendingPath === null) return;
    const found = overview.sources.find(
      (s) => samePath(s.path, pendingPath) || samePath(s.id, pendingPath),
    );
    if (found) setSelected(found.id);
    setPendingPath(null);
  }, [overview, pendingPath]);

  const allSelected = fresh.length > 0 && fresh.every((sk) => names.includes(sk.name));
  const toggleName = (skill: string) =>
    setNames((prev) => (prev.includes(skill) ? prev.filter((n) => n !== skill) : [...prev, skill]));

  // 写操作后统一重扫（重扫会自动补齐并弹提示条）；做不成只报原因，不改本地状态
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

  /// 切换开关即保存：勾上按当前选中的 agent 建规则，取消则撤掉本域全部目标
  const toggleAuto = () => {
    if (source === undefined) return;
    // 勾上会把这个来源下所有还没导入的 skill 一次开过去，影响面大，先确认
    if (!auto) {
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

  // 开启自动同步时会立刻开启的 skill 数：还没导入且未被排除的
  const autoCount = fresh.filter((sk) => !excluded.includes(sk.name)).length;
  const targetLabels = page.targets
    .filter((t) => targetIds.includes(t.id))
    .map((t) => t.label)
    .join("、");

  /// agent 选择；规则已开启时同时改写规则（全取消 = 取消规则）
  const toggleTarget = (id: string) => {
    const next = targetIds.includes(id) ? targetIds.filter((t) => t !== id) : [...targetIds, id];
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
        // 动作为空不等于「都已经开着了」：同名被占、链接失效、整目录链到别处
        // 也都产出空动作（§8 约束 1）。所以这里说的是位置被占，不是没事可做
        onNotice("一个都没开成：选中的 skill 在这些 agent 下的位置已经被占着了");
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

  // 一行一个 skill，已导入的也列出来（灰着、点不动）——26 个全在眼前，不用猜漏了谁
  const entries = (source?.skills ?? []).map((sk) => ({
    name: sk.name,
    imported: !notImported(selected, sk.name),
    clash: taken.has(sk.name),
    excluded: excluded.includes(sk.name),
  }));
  const columns = columnsOf(entries, entries.length > 28 ? 3 : 2);

  /// 列表头右侧那句：先说这个来源现在的状况，再说撞名
  const note =
    fresh.length === 0
      ? auto && autoable
        ? "这里以后新增的 skill 会自动出现，不用再来挑"
        : "这里的 skill 都已经在列表里了"
      : clashes > 0
        ? `${clashes} 个与已有同名，导入后进待处理`
        : null;

  const blocked = busy
    ? "正在处理，等这一下"
    : chosen === 0
      ? "先在列表里勾上要导入的 skill"
      : targetIds.length === 0
        ? "先选至少一个 agent"
        : null;

  return (
    <SubPage
      // 导入到哪，在标题里就要看得见，不放右边的副标题里。目的地名是内容，
      // 标题是大写档，得用 Plain 包住，否则项目名 CardBox 会变 CARDBOX
      title={
        <>
          导入 skill 到「<Plain>{page.label}</Plain>」
        </>
      }
      onBack={onClose}
    >
      <div className="ss-import">
        <div className="ss-import__cols">
          <Busy busy={busy} className="ss-import__sources">
            <div className="ss-import__caption">
              来源
              <span>未导入</span>
            </div>
            <div className="ss-import__srclist">
              {overview.sources.map((s) => {
                const tag = kindTag(s.kind);
                const count = s.skills.filter((sk) => notImported(s.id, sk.name)).length;
                return (
                  <div
                    key={s.id}
                    className={
                      s.id === selected ? "ss-import__source is-active" : "ss-import__source"
                    }
                  >
                    <button
                      type="button"
                      className="ss-import__pick"
                      title={s.path}
                      aria-current={s.id === selected}
                      onClick={() => setSelected(s.id)}
                    >
                      <span
                        className={
                          s.kind.type === "external"
                            ? "ss-import__srcname is-path"
                            : "ss-import__srcname"
                        }
                      >
                        {s.label}
                      </span>
                      {tag ? <span className="ss-import__tag is-quiet">{tag}</span> : null}
                      <span className="ss-import__count" title="还没出现在这个域里的 skill 数">
                        {count}
                      </span>
                    </button>
                    {s.kind.type === "manual" ? (
                      <Button variant="link" size="compact" onClick={() => removeSource(s.path)}>
                        移除
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {/* 一个来源都没有时这个按钮不出现：那种情况下右边的空态已经把它摆在正中间了 */}
            {overview.sources.length > 0 ? (
              <div className="ss-import__add">
                <Button onClick={() => void addFolder()}>添加来源…</Button>
              </div>
            ) : null}
          </Busy>

          <div className="ss-import__main">
            {source === undefined ? (
              <Empty
                kind="noSkills"
                description="还没有找到放着 skill 的目录。"
                hint="常见的位置是 ~/.agents/skills，也可以自己指一个。"
                primary={{ label: "添加来源…", onClick: () => void addFolder() }}
              />
            ) : (
              <>
                {autoable ? (
                  <Busy busy={busy} className="ss-import__fixed">
                    <button
                      type="button"
                      className="ss-import__auto"
                      role="checkbox"
                      aria-checked={auto}
                      disabled={targetIds.length === 0}
                      title={targetIds.length === 0 ? "先选至少一个 agent" : `来源：${source.path}`}
                      onClick={toggleAuto}
                    >
                      <CheckBox on={auto} dim={targetIds.length === 0} />
                      此来源新增 skill 自动导入
                    </button>
                  </Busy>
                ) : null}

                <div className="ss-import__listhead">
                  <span className="ss-import__headline">
                    {source.label} · {source.skills.length} 个本体
                  </span>
                  {fresh.length > 0 ? (
                    <Button
                      variant="link"
                      size="compact"
                      onClick={() => setNames(allSelected ? [] : fresh.map((sk) => sk.name))}
                    >
                      {allSelected ? "取消全选" : "全选"}
                    </Button>
                  ) : null}
                  {note ? <span className="ss-import__note">{note}</span> : null}
                </div>

                <Busy busy={busy} className="ss-import__grid">
                  {columns.map((col) => (
                    <div className="ss-import__col" key={col[0].name}>
                      {col.map((entry) => {
                        const on = names.includes(entry.name);
                        return (
                          <button
                            key={entry.name}
                            type="button"
                            className="ss-import__row"
                            role="checkbox"
                            aria-checked={on}
                            disabled={entry.imported}
                            title={
                              entry.imported
                                ? `${entry.name} 已经在这个域的列表里了`
                                : `${source.path}/${entry.name}`
                            }
                            onClick={() => toggleName(entry.name)}
                          >
                            <CheckBox on={on} dim={entry.imported} />
                            <span className="ss-import__name">{entry.name}</span>
                            {entry.imported ? (
                              <span className="ss-import__tag is-quiet">已导入</span>
                            ) : null}
                            {!entry.imported && entry.clash ? (
                              <span className="ss-import__tag">同名</span>
                            ) : null}
                            {entry.excluded ? (
                              <span
                                className="ss-import__tag is-quiet"
                                title="之前被排除在自动同步外，这次选上就重新纳入"
                              >
                                已排除
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </Busy>

                <Busy busy={busy} className="ss-import__agents">
                  <div className="ss-import__label">新导入的 skill 自动在以下 agent 开启</div>
                  <div className="ss-import__chips">
                    {page.targets.length === 0 ? (
                      <span className="ss-import__hint">
                        还没有启用任何 agent，先去设置里开一个
                      </span>
                    ) : (
                      page.targets.map((target) =>
                        target.linkedWholeTo === null ? (
                          <Chip
                            key={target.id}
                            icon={<AgentIcon id={target.scope.harnessId} name={target.label} />}
                            selected={targetIds.includes(target.id)}
                            title={target.path}
                            onClick={() => toggleTarget(target.id)}
                          >
                            {target.label}
                          </Chip>
                        ) : (
                          <Chip
                            key={target.id}
                            icon={<AgentIcon id={target.scope.harnessId} name={target.label} />}
                            disabled
                            disabledReason={`${target.label} 的目录整个链到了别处，要逐条开关得先拆开`}
                          >
                            {target.label}
                          </Chip>
                        ),
                      )
                    )}
                    <span className="ss-import__hint">
                      至少选一个：有软链或本体，才会出现在列表里
                    </span>
                  </div>
                </Busy>
              </>
            )}
          </div>
        </div>

        <div className="ss-import__foot">
          <span className="ss-import__hint">
            只建链接，不动源文件
            {source ? (
              <>
                {" · 源文件在 "}
                <span className="ss-import__path">{source.path}</span>
              </>
            ) : null}
          </span>
          <div className="ss-import__actions">
            <Button variant="link" onClick={onClose}>
              取消
            </Button>
            {blocked ? (
              <Button disabled disabledReason={blocked}>
                导入
              </Button>
            ) : (
              <Button onClick={() => void doImport()}>导入 {chosen} 个</Button>
            )}
          </div>
        </div>
      </div>

      {confirmAuto && source !== undefined ? (
        <Confirm
          title="开启自动同步"
          body={`「${source.label}」里还没开启的 ${autoCount} 个 skill 会立刻在 ${targetLabels} 下出现。`}
          warning="以后这个来源里新增的 skill，也会自动在这些 agent 中开启。"
          confirmLabel="开启自动同步"
          onConfirm={enableAuto}
          onCancel={() => setConfirmAuto(false)}
        />
      ) : null}
    </SubPage>
  );
}
