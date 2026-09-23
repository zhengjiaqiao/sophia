import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Disclosure } from "../Matrix";
import type { McpLocation, Target } from "../types";
import {
  AddButton,
  AgentIcon,
  BusySlot,
  Confirm,
  Empty,
  FloatingToast,
  IconButton,
  IconClose,
  IconPlus,
  NoticePanel,
  SubPage,
  Switch,
  Tag,
  Toast,
  Tooltip,
} from "../ui";
import type { ConfirmAnchor } from "../ui";
import { edgeFades } from "../modelsView";
import { placeLayer, type AnchorRect, type LayerPlacement, type ToastAlign } from "../layerPlace";
import { AddedToast, AddSourcePage } from "./AddSourcePage.tsx";
import { addedParts, type CandidateEntry } from "./addSourceView.ts";
import { CheckMark } from "./CheckMark.tsx";
import { defaultTargets, loadImportMemory, saveImportMemory } from "./importDefaults.ts";
import { columnRows, removeConfirmTitle, removeTitle, type DomainRef } from "./sourcesView.ts";
import {
  mcpSourcesModel,
  skillSourcesModel,
  type SourceRow,
  type SourcesData,
  type ToastText,
} from "./sourcesModel.ts";
import "./SourcesPage.css";

/// 来源管理页（DESIGN「来源管理页（skill 与 MCP 各一页，同一套骨架）」，画板 Import / Sources /
/// ImportEmpty / McpImport）：二级页，列出这个位置（全局或某个项目）订阅的来源，一行一个来源、
/// 后面跟它的设置——与模型页同一种面板（表头 `来源` ｜ `以后新出现的`，2px 结构线，行间 hairline，
/// 左列定宽 324）。skill 与 MCP 只差数据源（`sourcesModel.ts`）：
/// skill 的来源是放着 skill 的文件夹，MCP 的来源是一处配置（`Claude Code · User`）。
///
/// - **展开 ▸**：行下就地两列列出这个来源的全部 skill / 服务名（只读）；skill 在两个以上来源里都有的
///   挂 `同名`，MCP 搬不过去的挂 `搬不过去`
/// - **开关**＝这个来源以后新出现的自动加到（MCP：自动写进）指定目标：开着写 `自动加到` + 目标图标小框
///   （点开出小浮层，复选框改目标），关着只写 `自动添加`；打开时当场展开选目标的浮层。只管以后、
///   不补历史，所以开关都不确认；打开时的目标：这个来源上次用的，没有上次就可选的前两个
/// - **×**＝从这个位置移除：先取清单，再出锚定确认写明会撤掉的（skill 的软链、MCP 写进来的那几份）；
///   这个位置自己的来源不能移除，× 禁用并说原因
/// - 页头右端 `+ 来源`（跟随列表的话列表长了就找不到）：推入添加来源页（`AddSourcePage`，
///   与主视图工具行的 `+ 来源` 同一页）；加好后滑回这一页，新加的行 `surface` 行带闪两下
///   （同跳转定位），不筛选、不另出提示
/// - 反馈（DESIGN「反馈」）：二级页自己渲染提示条，接在列表下方；成功是例行一行，做不成走黑窗

export type SourcesPageProps = {
  /// 这个位置：key（`global` / `project:<路径>`）与显示名（`全局` / `CardBox`）
  domain: DomainRef;
  onClose: () => void;
  /// 改动之后让主视图重扫（订阅与移除都会改主列表的行）
  onChange: () => Promise<void>;
} & (
  | {
      kind: "skill";
      /// 表格的列：开关的目标从这里选
      targets: Target[];
    }
  | {
      kind: "mcp";
      /// 这个位置的全部配置位置（包含主视图藏起来的）：开关的目标从这里选
      locations: McpLocation[];
    }
);

/// 打开着的小浮层：某一行的目标
type Layer = { kind: "targets"; id: string; trigger: HTMLElement };

interface PendingRemove {
  row: SourceRow;
  body: string;
  commit: () => Promise<ToastText>;
  anchor: ConfirmAnchor;
  /// 按下那一刻 × 的位置（结果锚在这里）
  at: AnchorRect | null;
}

export default function SourcesPage(props: SourcesPageProps) {
  const { domain, onClose, onChange } = props;
  const targetList: (Target | McpLocation)[] =
    props.kind === "skill" ? props.targets : props.locations;
  const targetsKey = targetList.map((t) => t.id).join("|");
  const model = useMemo(
    () =>
      props.kind === "skill"
        ? skillSourcesModel(domain, props.targets)
        : mcpSourcesModel(domain, props.locations),
    // 目标按 id 比：重扫回来内容没变时不换模型，不重读
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.kind, domain.key, domain.label, targetsKey],
  );

  const [data, setData] = useState<SourcesData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /// 点了 × 的那一行：先算影响（planning），确认后移除（removing）。只锁这一行的 ×，
  /// 过了 0.3 秒门槛原位换成忙碌指示 + 一句；别的行、开关、`+ 来源` 照常
  const [rowBusy, setRowBusy] = useState<{ id: string; kind: "planning" | "removing" } | null>(
    null,
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [layer, setLayer] = useState<Layer | null>(null);
  /// 添加来源页（页头 / 空态的 `+ 来源`）开着没有
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<PendingRemove | null>(null);
  /// 提示小窗：锚在被按下的那个控件上（DESIGN「浮起小窗的位置 · 一行」）——行尾 × 按下的出在 ×
  /// 正下方、右对齐 ×；开关、目标项按下的出在它下方。`at` 是按下那一刻控件的位置（左右取控件，
  /// 上下取这一行），行被移除之后也还在原处
  const [toast, setToast] = useState<{
    key: number;
    text: ToastText;
    at: AnchorRect;
    align: ToastAlign;
  } | null>(null);
  /// 刚拨过的开关 / 刚改过的目标：重读回来之前先按点下去的样子画（开关不回弹）。值是目标 id，空＝关
  const [optimistic, setOptimistic] = useState<Map<string, string[]>>(new Map());
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  /// 目标小框：打开开关后当场把选目标的浮层开在它上面（产品负责人：看不出能选自动加到哪个 agent）
  const targetEls = useRef(new Map<string, HTMLButtonElement>());
  const [openTargetsOf, setOpenTargetsOf] = useState<string | null>(null);
  useEffect(() => {
    if (openTargetsOf === null) return;
    const trigger = targetEls.current.get(openTargetsOf);
    if (trigger) setLayer({ kind: "targets", id: openTargetsOf, trigger });
    setOpenTargetsOf(null);
  }, [openTargetsOf]);

  /// 函数身份不变：提示条的计时器不会被重渲染重置
  const dismissToast = useCallback(() => setToast(null), []);
  const closeLayer = useCallback(() => setLayer(null), []);
  /// 按下那一刻控件的位置：左右取控件；在行里的，上下取这一行（不盖住这一行）
  const pressedAt = (el: Element | null | undefined, row?: SourceRow): AnchorRect | null => {
    if (!el) return null;
    const c = el.getBoundingClientRect();
    const line = row ? rowEls.current.get(row.id)?.getBoundingClientRect() : undefined;
    return {
      top: line?.top ?? c.top,
      bottom: line?.bottom ?? c.bottom,
      left: c.left,
      right: c.right,
    };
  };
  const say = (text: ToastText, at: AnchorRect | null, align: ToastAlign) => {
    if (at) setToast({ key: Date.now(), text, at, align });
  };
  const cannot = (
    verb: string,
    error: unknown,
    row: SourceRow,
    at: AnchorRect | null,
    align: ToastAlign,
  ) =>
    say(
      { tier: "notice", kind: "cannot", verb, names: [row.name], reason: String(error) },
      at,
      align,
    );

  const load = useCallback(async () => {
    try {
      setData(await model.load());
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    }
    setOptimistic(new Map());
  }, [model]);

  useEffect(() => {
    void load();
  }, [load]);

  /// 改完之后：主视图重扫，这一页重读
  const settle = () => Promise.all([onChange(), load()]);

  const targetsOf = (row: SourceRow) => optimistic.get(row.id) ?? row.targets;

  /// 改规则：打开 / 关掉 / 加减一个目标都当场生效，不确认；失败时开关回到原样并说一声
  const changeRule = async (
    row: SourceRow,
    next: string[],
    failVerb: string,
    at: AnchorRect | null,
  ) => {
    const prev = targetsOf(row);
    setOptimistic((m) => new Map(m).set(row.id, next));
    try {
      await model.setTargets(row, next, prev);
      if (next.length > 0) saveImportMemory(model.memoryKey(row.id), { last: next, streak: 1 });
      await settle();
    } catch (e) {
      cannot(failVerb, e, row, at, "start");
      await load();
    }
  };

  const toggleRule = (row: SourceRow, on: boolean) => {
    // 按下的是这一行的开关：没成的话说在它下方
    const at = pressedAt(rowEls.current.get(row.id)?.querySelector('[role="switch"]'), row);
    if (on) {
      const targets = defaultTargets(
        model.pickable(row),
        loadImportMemory(model.memoryKey(row.id))?.last,
      );
      // 打开后当场展开选目标的浮层：默认目标只是起点，要让人看见、能改
      void changeRule(row, targets, "没打开", at).then(() => setOpenTargetsOf(row.id));
    } else {
      void changeRule(row, [], "没关掉", at);
    }
  };

  /// `el`：按下的那一项（目标浮层里）：没成的话说在它下方
  const toggleTarget = (row: SourceRow, id: string, el: Element) => {
    const current = targetsOf(row);
    const next = current.includes(id) ? current.filter((t) => t !== id) : [...current, id];
    void changeRule(row, next, "没改", pressedAt(el));
  };

  /// 点 ×：先取会撤掉的清单（× 原位忙碌），再出锚定确认（锚在这一行下方）。
  /// 按下那一刻记下 × 的位置：结果出在它正下方、右对齐它，行被移除之后也还在原处
  const askRemove = async (row: SourceRow, trigger: Element) => {
    if (rowBusy?.id === row.id) return;
    const el = rowEls.current.get(row.id);
    const at = pressedAt(trigger, row);
    setRowBusy({ id: row.id, kind: "planning" });
    try {
      const { body, commit } = await model.planRemove(row);
      const r = el?.getBoundingClientRect();
      if (!r) return;
      setPending({
        row,
        body,
        commit,
        anchor: { top: r.top, left: r.left, right: r.right, bottom: r.bottom },
        at,
      });
    } catch (e) {
      cannot("没移除", e, row, at, "end");
    } finally {
      setRowBusy((prev) => (prev?.id === row.id && prev.kind === "planning" ? null : prev));
    }
  };

  /// 确认之后移除：只有这一行的 × 忙碌，不把整页变暗、不锁别的行
  const remove = async ({ row, commit, at }: PendingRemove) => {
    setPending(null);
    setRowBusy({ id: row.id, kind: "removing" });
    try {
      const text = await commit();
      await settle();
      say({ ...text, names: [row.name] }, at, "end");
    } catch (e) {
      cannot("没移除", e, row, at, "end");
    } finally {
      setRowBusy((prev) => (prev?.id === row.id ? null : prev));
    }
  };

  /// 浮层开着时 Esc 由浮层接走；确认框开着时 Esc 只取消确认，不退出这一页
  /// （叠在上面的添加来源页开着时，Esc 由 SubPage 只交给最上面那一页）
  const back = pending ? () => undefined : onClose;
  /// 加完滑回：新加的行 surface 行带闪两下（同跳转定位）。等添加页滑走、卸掉之后再闪，
  /// 不然前一两拍闪在滑走的页底下
  const addedEntries = useRef<CandidateEntry[]>([]);
  const [jumpIds, setJumpIds] = useState<Set<string>>(new Set());
  /// 滑回这一页之后在第一条新行下浮起 `✓ 已添加 WeiboAP · 39 个 skill`（添加页那颗键已经不在了，
  /// 锚在它带来的结果上）；新行照旧闪两下
  const [addedNote, setAddedNote] = useState<{
    key: number;
    firstId: string;
    parts: string[];
  } | null>(null);
  const closeAdd = useCallback(() => {
    setAdding(false);
    const added = addedEntries.current;
    addedEntries.current = [];
    if (added.length === 0) return;
    setJumpIds(new Set(added.map((e) => e.id)));
    setAddedNote({
      key: Date.now(),
      firstId: added[0].id,
      parts: addedParts(
        added.map((e) => e.name),
        added.reduce((sum, e) => sum + e.count, 0),
        model.noun,
        false,
      ),
    });
  }, [model.noun]);
  useEffect(() => {
    if (jumpIds.size === 0) return;
    const first = data?.rows.find((r) => jumpIds.has(r.id));
    if (first) rowEls.current.get(first.id)?.scrollIntoView({ block: "nearest" });
    // 只在要闪的这一批换了时滚
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpIds]);
  const endJump = (id: string) =>
    setJumpIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  const toastNode = toast ? (
    <FloatingToast key={toast.key} align={toast.align} anchor={() => toast.at}>
      <Toast
        {...toast.text}
        onDismiss={dismissToast}
        onClose={toast.text.tier === "notice" ? dismissToast : undefined}
      />
    </FloatingToast>
  ) : null;

  let body: ReactNode;
  if (data === null) {
    body = loadError ? (
      <div className="src-page__error">
        <NoticePanel message="读不到来源" reason={loadError} />
      </div>
    ) : (
      <Empty kind="scanning" description="正在读来源" />
    );
  } else if (data.rows.length === 0) {
    // 空态：一句现状 + `+ 来源`（进同一个添加来源页）
    body = (
      <div className="src-page__empty">
        <Empty
          kind="noSkills"
          description={model.emptyText}
          art="emptyFolder"
          primary={{
            label: "来源",
            icon: <IconPlus size={12} />,
            onClick: () => setAdding(true),
          }}
        />
      </div>
    );
  } else {
    body = (
      <div className="src-page">
        <div className="src-panel">
          <div className="src-panel__head">
            <span>来源</span>
            <span>以后新出现的</span>
          </div>
          {data.rows.map((row) => {
            const open = expanded.has(row.id);
            const busyHere = rowBusy?.id === row.id ? rowBusy.kind : null;
            const targets = targetsOf(row);
            const on = targets.length > 0;
            const options = model.targetsFor(row);
            const shown = options.filter((t) => targets.includes(t.id));
            const switchReason = on
              ? undefined
              : (row.switchReason ??
                (model.pickable(row).length === 0 ? model.noTargetsReason : undefined));
            const ruleLabel = `${row.name} 以后新出现的 ${model.noun} 自动添加`;
            return (
              <div
                className={`src-row${open ? " is-open" : ""}${jumpIds.has(row.id) ? " is-jump" : ""}`}
                key={row.id}
                onAnimationEnd={(e) => {
                  if (e.target === e.currentTarget) endJump(row.id);
                }}
              >
                <div
                  className="src-row__main"
                  ref={(el) => {
                    if (el) rowEls.current.set(row.id, el);
                    else rowEls.current.delete(row.id);
                  }}
                >
                  <button
                    type="button"
                    className="src-row__name"
                    aria-expanded={open}
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (!next.delete(row.id)) next.add(row.id);
                        return next;
                      })
                    }
                  >
                    <span className="src-row__caret">
                      <Disclosure open={open} shown />
                    </span>
                    <span className="src-row__text">
                      <span className="src-row__label">{row.name}</span>
                      <Tooltip content={row.path}>
                        <span className="src-row__sub">
                          <span className="src-row__where">{row.sub.where}</span>
                          <span className="src-row__count">{`\u00a0·\u00a0${row.sub.count}`}</span>
                        </span>
                      </Tooltip>
                    </span>
                  </button>

                  <div className="src-row__rule">
                    {switchReason ? (
                      // 禁用的开关自带原因提示框：悬停出、按下当即出
                      <Switch
                        checked={on}
                        onChange={() => undefined}
                        label={ruleLabel}
                        disabledReason={switchReason}
                      />
                    ) : (
                      <Switch
                        checked={on}
                        onChange={(next) => toggleRule(row, next)}
                        label={ruleLabel}
                        title={row.switchTitle}
                      />
                    )}
                    <span className={`src-row__rulelabel${switchReason ? " is-disabled" : ""}`}>
                      {on ? model.ruleOn : "自动添加"}
                    </span>
                    {on ? (
                      <button
                        type="button"
                        ref={(el) => {
                          if (el) targetEls.current.set(row.id, el);
                          else targetEls.current.delete(row.id);
                        }}
                        className={`src-row__targets${layer?.kind === "targets" && layer.id === row.id ? " is-open" : ""}`}
                        aria-haspopup="menu"
                        aria-expanded={layer?.kind === "targets" && layer.id === row.id}
                        title={model.targetsTitle}
                        onClick={(e) => {
                          const trigger = e.currentTarget;
                          setLayer((prev) =>
                            prev?.kind === "targets" && prev.id === row.id
                              ? null
                              : { kind: "targets", id: row.id, trigger },
                          );
                        }}
                      >
                        {shown.length > 0
                          ? shown.map((t) => (
                              <AgentIcon
                                key={t.id}
                                id={t.iconId}
                                name={t.label}
                                size={14}
                                labelled
                              />
                            ))
                          : `${targets.length} ${model.targetUnit}`}
                        {/* 下拉记号：看得出这组图标能点开改（⑥ 外观说明如何操作） */}
                        <svg
                          className="src-row__chevron"
                          width="10"
                          height="10"
                          viewBox="0 0 10 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M2.5 4 5 6.5 7.5 4" />
                        </svg>
                      </button>
                    ) : null}
                    <span className="src-row__remove">
                      {row.own ? (
                        <IconButton
                          icon={<IconClose />}
                          title={removeTitle(domain, row.name)}
                          disabledReason={model.ownRemoveReason}
                          tipPlacement="bottom"
                          tipNowrap
                        />
                      ) : (
                        <BusySlot
                          busy={busyHere !== null}
                          label={busyHere === "removing" ? "正在移除" : "正在查看影响"}
                        >
                          <IconButton
                            icon={<IconClose />}
                            title={removeTitle(domain, row.name)}
                            onClick={() => {
                              const x = rowEls.current
                                .get(row.id)
                                ?.querySelector(".src-row__remove button");
                              if (x) void askRemove(row, x);
                            }}
                          />
                        </BusySlot>
                      )}
                    </span>
                  </div>
                </div>

                {open ? (
                  row.items.length === 0 ? (
                    <div className="src-row__none">{model.emptyItems}</div>
                  ) : (
                    <div
                      className="src-row__skills"
                      style={{
                        gridTemplateRows: `repeat(${columnRows(row.items.length)}, auto)`,
                      }}
                    >
                      {row.items.map((item) => (
                        <div className="src-skill" key={item.name}>
                          <span className={`src-skill__name${item.dim ? " is-dim" : ""}`}>
                            {item.name}
                          </span>
                          {item.tag ? <Tag tip={item.tag.tip}>{item.tag.text}</Tag> : null}
                        </div>
                      ))}
                    </div>
                  )
                ) : null}

                {layer?.kind === "targets" && layer.id === row.id ? (
                  <FloatingLayer
                    trigger={layer.trigger}
                    onClose={closeLayer}
                    className="src-targetmenu"
                    label={model.targetsLabel}
                  >
                    {options.map((t) => {
                      const checked = targets.includes(t.id);
                      return (
                        <button
                          key={t.id}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={checked}
                          className={`src-target${checked ? " is-on" : ""}`}
                          aria-describedby={t.disabledReason ? `${row.id}-${t.id}-why` : undefined}
                          disabled={t.disabledReason !== undefined}
                          onClick={(e) => toggleTarget(row, t.id, e.currentTarget)}
                        >
                          <CheckMark on={checked} />
                          <AgentIcon id={t.iconId} name={t.label} size={14} />
                          <span className="src-target__text">
                            <span className="src-target__name">{t.label}</span>
                            {/* 点不了的那一项：原因就写在这一行里（DESIGN「提示框」列表行的说明在同一行；
                                浮层会滚动裁切，悬停提示框放不进去，也不该要用户去点才知道） */}
                            {t.disabledReason ? (
                              <span className="src-target__why" id={`${row.id}-${t.id}-why`}>
                                {t.disabledReason}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      );
                    })}
                  </FloatingLayer>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <SubPage
      title={model.title}
      onBack={back}
      aside={
        // 页头右端固定（DESIGN：跟随列表的话列表长了就找不到）；空态里已有同一个动作，不重复
        data !== null && data.rows.length > 0 ? (
          <AddButton noun="来源" onClick={() => setAdding(true)} />
        ) : null
      }
    >
      {body}
      {/* 提示小窗锚在按下那一刻记下的控件位置上（不挂进行里：行可能已被移除） */}
      {toastNode}
      {addedNote ? (
        <FloatingToast
          key={addedNote.key}
          align="start"
          anchor={() => rowEls.current.get(addedNote.firstId)}
        >
          <AddedToast parts={addedNote.parts} onDismiss={() => setAddedNote(null)} />
        </FloatingToast>
      ) : null}
      {adding ? (
        // 加好后主视图重扫、这一页重读，再滑回这一页
        <AddSourcePage
          model={model}
          domain={domain}
          onClose={closeAdd}
          onAdded={async () => {
            await settle();
          }}
          onAllAdded={(added) => {
            addedEntries.current = added;
          }}
        />
      ) : null}
      {pending ? (
        <Confirm
          title={removeConfirmTitle(domain, pending.row.name)}
          confirmLabel="移除"
          anchor={pending.anchor}
          // × 在行的右端：确认框右对齐到行尾，出在它下面（同删网关）
          align="end"
          onConfirm={() => void remove(pending)}
          onCancel={() => setPending(null)}
        >
          {pending.body}
        </Confirm>
      ) : null}
    </SubPage>
  );
}

/// 小浮层（与侧栏排序下拉、模型选择器同一写法：layer 圆角 + 浮层阴影，无黑框）。
/// 目标浮层、MCP 同名挑选浮层共用。定位规则见 `placeLayer`：默认在触发控件下方 6 展开，
/// 下方放不下、上方放得下才往上翻；最大高度取朝向那一侧的剩余空间与 360 中较小的，
/// 超出在浮层内部滚动，滚动边缘渐隐（DESIGN「渐变只用于功能」）。
/// 点外面、Esc、页面滚动都关，不铺透明罩。
/// 用 fixed 定位：触发控件在滚动的列表里，没法给它包一个定位容器
export function FloatingLayer({
  trigger,
  onClose,
  className,
  label,
  children,
}: {
  trigger: HTMLElement;
  onClose: () => void;
  /// 挂在滚动区上：宽度、内边距、纵向排列由它定
  className: string;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<LayerPlacement | null>(null);
  const [fade, setFade] = useState({ start: false, end: false });

  // 每次渲染后重量一次：内容变了（MCP 差异取回来、勾选改了行）也按新尺寸放。
  // 自然高度＝外框高 − 滚动区可见高 + 滚动区内容高，不受当前最大高度影响；位置没变就不 setState
  useLayoutEffect(() => {
    const el = ref.current;
    const scroll = scrollRef.current;
    if (!el || !scroll) return;
    const a = trigger.getBoundingClientRect();
    const next = placeLayer(
      { top: a.top, bottom: a.bottom, left: a.left, right: a.right },
      {
        width: el.offsetWidth,
        height: el.offsetHeight - scroll.clientHeight + scroll.scrollHeight,
      },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPos((prev) =>
      prev &&
      prev.top === next.top &&
      prev.left === next.left &&
      prev.maxHeight === next.maxHeight &&
      prev.side === next.side
        ? prev
        : next,
    );
  });

  /// 滚动边缘渐隐：上面 / 下面还有被裁掉的行时，那一边出 16px 渐隐（与模型列表同一写法）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const next = edgeFades(el.scrollTop, el.clientHeight, el.scrollHeight);
      setFade((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  });

  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (ref.current?.contains(target) || trigger.contains(target));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 捕获阶段接走：不让二级页把 Esc 当成返回
      event.stopPropagation();
      event.preventDefault();
      onClose();
      trigger.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) onClose();
    };
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node && ref.current?.contains(event.target))) onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [trigger, onClose]);

  return (
    <div
      ref={ref}
      className="src-layer"
      role="menu"
      aria-label={label}
      style={
        pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight } : { visibility: "hidden" }
      }
    >
      <div
        className="src-layer__viewport"
        data-fade-top={fade.start || undefined}
        data-fade-bottom={fade.end || undefined}
      >
        <div ref={scrollRef} className={`src-layer__scroll ${className}`}>
          {children}
        </div>
      </div>
    </div>
  );
}
