import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  BusySlot,
  Button,
  Checkbox,
  Empty,
  FadeViewport,
  FloatingToast,
  IconCannot,
  ListRow,
  Note,
  NoticePanel,
  SectionLabel,
  Tag,
  Toast,
  Tooltip,
  TruncTip,
  useBusyShown,
  useEdgeFades,
} from "../ui";
import {
  loadFailedText,
  nothingChecked,
  readingText,
  pickedHead,
  pickHint,
  suggestedLabel,
  addFailureToast,
  addLabel,
  checkedEntries,
  pickedBlocked,
  pickedLine,
  pickedRef,
  rowMeta,
  type CandidateEntry,
  type PickedState,
  type SourceLine,
} from "./addSourceView.ts";
import { t, tRich } from "../i18n.ts";
import { errorSentence, parseBackendError } from "../backendError.ts";
import { copyDetails } from "../diagnostics.ts";
import type { DomainRef } from "./sourcesView.ts";
import type { SourcesData, SourcesModel } from "./sourcesModel.ts";
import "./AddSourcePanel.css";

/// 添加来源的**内容**（DESIGN「来源：订阅、来源行、添加来源 › 添加来源」，画板 V4Layouts add-source）：
/// 单栏，自上而下——第一步 `选择文件夹…`（D13：留在列表最上方）+ 灰字，下面一列候选来源
/// （选的文件夹在最前，再是 `建议的来源` 两组），贴底 `添加 N 个来源`。
/// skill 与 MCP 只差数据源（`SourcesModel`）：MCP 没有 `选择文件夹…`，行里外露的是服务名。
///
/// 不管容器：标题、返回、转场、页边都归外面那层（`AddSourcePage`）——内容与贴底一行经 `frame` 交给它。
/// Panel 自己铺满容器给它的高度，只有列表区滚动（边缘渐隐）。
///
/// - 候选行＝列表行 `ListRow`（带勾选格），可多选，两行高：勾选框 24 ｜ 拉手 18 + 6（悬停这一行才出）｜ 内容。
///   第一行名字，第二行 `出处 · 39 个 skill · ` + 外露的前几个名字，一行放不下截断
/// - **点整行＝拉开 / 收起抽屉**（拉手只是记号，也是键盘入口）：行下就地列出全部名字（只读、四列
///   各 160、左沿对齐名字），`同名` / `不支持` 是纯弱标识 + 提示框（D21）；Esc 收起。
///   **勾选只归行首方框**（手靠近方框自己才抬起）；整行悬停出 `surface` 带（裁决 4），勾上不改底色
/// - 默认一个都不勾；选的文件夹读好后自动勾上。加不进来的（没有 skill、已经在来源里、读不到）不进列表，
///   浮窗说原因
/// - 逐个加：全成＝交给容器收尾（滑回）；有没成的就留在这一页，底部说哪几个没加上，
///   已加上的从列表里消失，没加上的保持勾着

export interface AddSourcePanelProps {
  model: SourcesModel;
  domain: DomainRef;
  /// 加上了至少一个之后：主视图重扫 / 来源管理页重读。Panel 等它做完再往下走
  onChanged: () => Promise<void>;
  /// 勾的全加上了（added：加上的那几个，按列表先后）：容器收尾（滑回）。Panel 等它做完才收起忙碌指示
  onDone: (added: CandidateEntry[]) => Promise<void>;
  /// 容器：把内容（第一步 + 候选列表）与贴底一行（主动作）放进自己的外框（推入页的内容区与贴底行）
  frame: (content: ReactNode, footer: ReactNode) => ReactNode;
}

/// 带渐隐的滚动区：外层画渐隐（机面上从 face 渐隐），里层滚
function FadeScroll({ children, label }: { children: ReactNode; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const fade = useEdgeFades(ref);
  return (
    <FadeViewport fade={fade} tone="face" className="add-src__fade">
      <div ref={ref} className="add-src__scroll" role="group" aria-label={label}>
        <div>{children}</div>
      </div>
    </FadeViewport>
  );
}

/// 文件夹名：预览回来之前那一行先写它
const folderName = (path: string) =>
  path
    .split(/[/\\]+/)
    .filter(Boolean)
    .pop() ?? path;

export function AddSourcePanel({ model, domain, onChanged, onDone, frame }: AddSourcePanelProps) {
  const [data, setData] = useState<SourcesData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickedState | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  /// 展开了全部名字的行；与勾选无关
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<{
    key: number;
    toast: NonNullable<ReturnType<typeof addFailureToast>>;
  } | null>(null);
  /// 选的文件夹加不进来（没有 skill、已经在来源里、读不到）：不进列表，就地写在 `选择文件夹…` 右边、换掉那句灰字规则
  /// （2026-09-29 产品负责人真机：浮在键下方会盖住 `建议的来源` 小标题；灰字是规则、这一句是按规则判的结果，
  /// 同一格只说一次）。再选一次文件夹时换回灰字
  const [pickNotice, setPickNotice] = useState<{
    name: string;
    reason: string;
  } | null>(null);
  /// 正在读选好的文件夹：忙碌在 `选择文件夹…` 原位（0.3 秒门槛），不在列表里先插一行占位
  const [reading, setReading] = useState(false);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const alive = useRef(true);
  useEffect(() => {
    // 开发模式下 effect 会先卸再装一次：装回来时重新记成活着
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // 打开时读一次；部分没加上时再读一次（已加上的不再是候选）
  const modelRef = useRef(model);
  const load = useCallback(async () => {
    try {
      const d = await modelRef.current.load();
      if (alive.current) {
        setData(d);
        setLoadError(null);
      }
    } catch (e) {
      if (alive.current) setLoadError(String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // 添加来源页里换了位置（换了模型）：候选按新位置重读，勾选、选的文件夹、展开都清空（R8，2026-09-30）
  useEffect(() => {
    if (modelRef.current === model) return;
    modelRef.current = model;
    setData(null);
    setLoadError(null);
    setPicked(null);
    setChecked(new Set());
    setExpanded(new Set());
    setFailure(null);
    setPickNotice(null);
    void load();
  }, [model, load]);

  const groups = data?.groups ?? [];
  const candidates = groups.flatMap((g) => g.items);
  const entries = checkedEntries(checked, picked, candidates, domain);

  /// 渲染完再把焦点与滚动带到这一行（它可能这一轮才画出来）；
  /// top：滚到列表顶（选的文件夹在最前，连同它的小标题一起露出来）
  const [reveal, setReveal] = useState<{ ref: string; top: boolean } | null>(null);
  useLayoutEffect(() => {
    if (reveal === null) return;
    const el = rowEls.current.get(reveal.ref);
    if (el) {
      el.querySelector<HTMLElement>('[role="checkbox"]')?.focus({ preventScroll: true });
      if (reveal.top) el.closest(".add-src__scroll")?.scrollTo({ top: 0 });
      else el.scrollIntoView({ block: "nearest" });
    }
    setReveal(null);
  }, [reveal]);

  const setCheck = (ref: string, on: boolean) =>
    setChecked((prev) => {
      if (prev.has(ref) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(ref);
      else next.delete(ref);
      return next;
    });

  const toggleExpand = (ref: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });

  // Esc 先收起拉开的抽屉（捕获阶段接走，页面不把它当返回）；输入框里的 Esc 归输入框
  const anyOpen = expanded.size > 0;
  useEffect(() => {
    if (!anyOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      event.preventDefault();
      setExpanded(new Set());
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [anyOpen]);

  const pickFolder = async () => {
    const path = await model.pickFolder();
    if (!path || !alive.current) return;
    setFailure(null);
    // 换掉之前选的文件夹：它的勾一并拿掉
    const dropPicked = () => {
      if (picked !== null) setCheck(pickedRef(picked), false);
      setPicked(null);
    };
    // 选的正是下面某个建议的来源：勾上它
    const known = candidates.find((c) => c.ref === path);
    if (known) {
      dropPicked();
      setCheck(known.ref, true);
      setReveal({ ref: known.ref, top: false });
      return;
    }
    dropPicked();
    setPickNotice(null);
    const name = folderName(path);
    const cannot = (reason: string) => setPickNotice({ name, reason });
    setReading(true);
    try {
      const entry = await model.previewFolder(path, data?.rows ?? []);
      if (!alive.current) return;
      const candidate = candidates.find((c) => c.ref === entry.title);
      if (candidate) {
        // core 认出它就是某个建议的来源（路径写法不同）：丢掉这一项，勾上那个来源
        setPicked(null);
        setCheck(candidate.ref, true);
        setReveal({ ref: candidate.ref, top: false });
        return;
      }
      const already = (data?.rows ?? []).some((r) => r.id === entry.id);
      const next: PickedState = { status: "ready", entry, already };
      const blocked = pickedBlocked(next, domain);
      if (blocked !== null) {
        cannot(blocked);
        return;
      }
      setPicked(next);
      setCheck(entry.ref, true);
      setReveal({ ref: entry.ref, top: true });
    } catch (e) {
      if (alive.current) cannot(t("sources.add.readFailed", { reason: errorSentence(e) }));
    } finally {
      if (alive.current) setReading(false);
    }
  };

  /// 逐个加（订阅是轻量的单条写入，没有批量接口）；全成交给容器收尾，有没成的留在这一页说清楚
  const add = async () => {
    if (entries.length === 0) return;
    setAdding(true);
    setFailure(null);
    const done: string[] = [];
    const failed: { ref: string; name: string; reason: string }[] = [];
    for (const entry of entries) {
      try {
        await model.subscribe(entry.ref);
        done.push(entry.ref);
      } catch (e) {
        failed.push({ ref: entry.ref, name: entry.name, reason: errorSentence(e) });
      }
    }
    if (done.length > 0) await onChanged();
    if (failed.length === 0) {
      await onDone(entries);
      if (alive.current) setAdding(false);
      return;
    }
    if (!alive.current) return;
    // 留在这一页：加上了的不再是候选（重读），没加上的保持勾着
    if (picked !== null && done.includes(pickedRef(picked))) setPicked(null);
    setChecked(new Set(failed.map((f) => f.ref)));
    if (done.length > 0) await load();
    const toast = addFailureToast(done, failed);
    if (toast && alive.current) setFailure({ key: Date.now(), toast });
    if (alive.current) setAdding(false);
  };

  const dismissFailure = useCallback(() => setFailure(null), []);

  /// 一个候选行。items：抽屉里列的名字；blocked：方框为什么不能勾（选的文件夹没 skill 等），此时也不展开
  const row = (
    entry: { ref: string; name: string; title?: string; items?: CandidateEntry["items"] },
    line: SourceLine,
    blocked: string | null,
  ) => {
    const on = !blocked && checked.has(entry.ref);
    const open = !blocked && expanded.has(entry.ref);
    const items = entry.items ?? [];
    let second: ReactNode;
    if (line.kind === "loading") {
      second = <ReadingFolder />;
    } else if (line.kind === "message") {
      second = <span className="add-src__meta">{line.text}</span>;
    } else {
      second =
        entry.title !== undefined ? (
          // 第二行只写短路径：提示框补完整路径（屏幕上没有的）
          <Tooltip content={entry.title} fit="grow">
            <span className="add-src__meta">{line.text}</span>
          </Tooltip>
        ) : (
          // 没有别的可补：只在这一行放不下被截断时给全文
          <TruncTip content={line.text} fit="grow">
            <span className="add-src__meta">{line.text}</span>
          </TruncTip>
        );
    }
    const drawerId = `add-src-drawer-${encodeURIComponent(entry.ref)}`;
    return (
      <ListRow
        key={entry.ref}
        rowRef={(el) => {
          if (el) rowEls.current.set(entry.ref, el);
          else rowEls.current.delete(entry.ref);
        }}
        title={entry.name}
        // 第二行一行放不下以 … 截断（提示框 fit="grow" 撑满这一行、随它收窄）
        sub={second}
        check={
          blocked ? (
            // 不能勾：方框平贴，悬停 / 按下说原因（与第二行同一句）
            <Checkbox checked={false} label={entry.name} disabledReason={blocked} />
          ) : (
            <Checkbox
              checked={on}
              label={entry.name}
              onChange={(next) => {
                setCheck(entry.ref, next);
                setFailure(null);
              }}
            />
          )
        }
        // 不能勾的行没有抽屉：拉手格留空，各行名字照样对齐
        drawer={
          blocked ? undefined : items.length === 0 ? (
            <Note>{model.emptyItems}</Note>
          ) : (
            // 抽屉：全部名字，只读，四列各 160；`同名` / `不支持` 是纯弱标识 + 提示框（D21）
            <span className="add-src__items">
              {items.map((item) => (
                <span className="add-src__item" key={item.name}>
                  <span className={`add-src__itemname${item.dim ? " is-dim" : ""}`}>
                    {item.name}
                  </span>
                  {item.tag ? (
                    <span className="add-src__tag">
                      <Tag tone="weak" tip={item.tag.tip}>
                        {item.tag.text}
                      </Tag>
                    </span>
                  ) : null}
                </span>
              ))}
            </span>
          )
        }
        open={open}
        onToggle={blocked ? undefined : () => toggleExpand(entry.ref)}
        drawerLabel={
          model.noun === "MCP"
            ? t("sources.add.drawerMcp", { name: entry.name })
            : t("sources.add.drawerSkill", { name: entry.name })
        }
        drawerId={drawerId}
      />
    );
  };

  let pickedRow: ReactNode = null;
  if (picked !== null) {
    const entry = picked.status === "ready" ? picked.entry : picked;
    pickedRow = (
      <>
        <div className="add-src__group">{pickedHead()}</div>
        {row(entry, pickedLine(picked, domain, model.noun), pickedBlocked(picked, domain))}
      </>
    );
  }

  // 读取中：过了 0.3 秒门槛才出刻度 + 一句（更快读完的什么都不闪；没有文字的转动不允许）
  const loadingShown = useBusyShown(data === null && !loadError);
  let list: ReactNode;
  if (loadError && data === null) {
    // 后端给的一句作原因接在主句后，系统原文进前面的「!」（#302）。出错的灰面板要给一条往前走的路（#320）：
    // `再试一次` 重读；给人看的一句（`invalid`，如设置文件来自更新版本）再读一次结果一样，不给
    const { code, message, detail } = parseBackendError(loadError);
    list = (
      <div className="add-src__notice">
        <NoticePanel
          message={loadFailedText(model.noun)}
          reason={message}
          technical={detail}
          onCopy={(text) => copyDetails(text)}
          action={
            code === "invalid"
              ? undefined
              : {
                  label: t("sources.add.retry"),
                  onClick: () => {
                    setLoadError(null);
                    void load();
                  },
                }
          }
        />
      </div>
    );
  } else if (data === null) {
    list = (
      <div className="add-src__loading">
        {loadingShown ? <Empty busy description={readingText(model.noun)} /> : null}
      </div>
    );
  } else {
    list = (
      <FadeScroll label={model.word}>
        {pickedRow}
        <div className="add-src__label">
          <SectionLabel>{suggestedLabel(model.noun)}</SectionLabel>
        </div>
        {groups.length === 0 ? (
          <div className="add-src__none">
            <Note>{model.noCandidates}</Note>
          </div>
        ) : (
          groups.map((group) => (
            <Fragment key={group.title}>
              <div className="add-src__group">{group.title}</div>
              {group.items.map((item) =>
                row(
                  item,
                  { kind: "meta", text: rowMeta(item.sub, item.count, model.noun, item.items) },
                  null,
                ),
              )}
            </Fragment>
          ))
        )}
      </FadeScroll>
    );
  }

  const content = (
    <div className="add-src">
      {model.canPickFolder ? (
        <div className="add-src__pick">
          <span className="add-src__pickbtn">
            {reading ? (
              // 读文件夹时忙碌在 `选择文件夹…` 原位（0.3 秒门槛）
              <BusySlot busy label={t("sources.add.readingFolder")}>
                <Button size="row">{t("sources.add.pickFolder")}</Button>
              </BusySlot>
            ) : (
              <Button size="row" onClick={() => void pickFolder()}>
                {t("sources.add.pickFolder")}
              </Button>
            )}
          </span>
          {pickNotice ? (
            <span className="add-src__hint add-src__hint--cannot" role="status">
              <IconCannot size={12} className="add-src__hint-mark" />
              {tRich("sources.add.pickFailed", {
                name: pickNotice.name,
                failed: <b>{t("sources.add.failedWord")}</b>,
                reason: pickNotice.reason,
              })}
            </span>
          ) : (
            <span className="add-src__hint">{pickHint()}</span>
          )}
        </div>
      ) : null}
      {list}
    </div>
  );

  // 贴底一行（推入页的贴底行）：右端主动作
  const footer = (
    <>
      {failure ? (
        // 没加上：浮在触发它的主动作那一行（右对齐、放不下就翻到上方），8 秒，悬停停表
        <FloatingToast key={failure.key} align="end">
          <Toast {...failure.toast} onDismiss={dismissFailure} onClose={dismissFailure} />
        </FloatingToast>
      ) : null}
      {adding ? (
        // 键锁住，过了 0.3 秒门槛原位换成忙碌指示 + 一句
        <BusySlot busy label={t("sources.add.adding")} className="add-src__busy">
          <Button variant="primary" size="row">
            {addLabel(entries.length, model.noun)}
          </Button>
        </BusySlot>
      ) : entries.length === 0 ? (
        <Button variant="primary" size="row" disabled disabledReason={nothingChecked(model.noun)}>
          {addLabel(0, model.noun)}
        </Button>
      ) : (
        <Button variant="primary" size="row" onClick={() => void add()}>
          {addLabel(entries.length, model.noun)}
        </Button>
      )}
    </>
  );

  return <>{frame(content, footer)}</>;
}

/// 选了文件夹、正在读：第二行过了 0.3 秒门槛才出忙碌指示 + 一句（更快读完的什么都不闪）；
/// 门槛之前留一个空格占住第二行的高度，出现时不跳
function ReadingFolder() {
  return (
    <span className="add-src__meta">
      <BusySlot busy label={t("sources.add.readingFolder")} className="add-src__reading">
        {"\u00a0"}
      </BusySlot>
    </span>
  );
}
