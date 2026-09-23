import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api";
import { Disclosure } from "../Matrix";
import type { SourceList, SubscribedSource, Target } from "../types";
import {
  AddButton,
  AgentIcon,
  Busy,
  Confirm,
  Empty,
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
import type { ConfirmAnchor, ToastProps } from "../ui";
import { CheckMark } from "./CheckMark.tsx";
import { defaultTargets, loadImportMemory, saveImportMemory } from "./importDefaults.ts";
import {
  candidateGroups,
  columnRows,
  duplicateNames,
  noSourcesText,
  ownRemoveReason,
  removeConfirmBody,
  removeConfirmTitle,
  removeTitle,
  sourceLines,
  sourceSubtitle,
  sourcesTitle,
} from "./sourcesView.ts";
import "./SourcesPage.css";

/// skill 的来源管理页（DESIGN「来源管理页」，画板 Import / Sources / ImportEmpty）：二级页，
/// 列出这个位置（全局或某个项目）订阅的来源，一行一个来源、后面跟它的设置——与模型页同一种面板
/// （表头 `来源` ｜ `以后新出现的`，2px 结构线，行间 hairline，左列定宽 324）。
///
/// - **展开 ▸**：行下就地两列列出这个来源的全部 skill 名（只读），在两个以上来源里都有的挂 `同名`
/// - **开关**＝这个来源以后新出现的 skill 自动加到指定 agent：开着写 `自动加到` + 目标图标
///   （点图标出小浮层，复选框改目标），关着只写 `自动添加`。只管以后、不补历史，所以开关都不确认；
///   打开时的目标沿用添加页的默认：这个来源上次用的，没有上次就可选的前两个
/// - **×**＝从这个位置移除（不动原件）：先取清单，再出锚定确认写明会撤掉的软链；原件就在这里的
///   来源不能移除，× 禁用并说原因
/// - 列表底部 `+ 来源`：小浮层三组——选择文件夹…、其他项目在用的、检测到的；点一项就加进来
/// - 反馈（DESIGN「反馈」）：二级页自己渲染提示条，贴在 `+ 来源` 那一行；成功是例行一行，做不成走黑窗

export interface SourcesPageProps {
  /// 这个位置：key（`global` / `project:<路径>`）、显示名、表格的列（开关的目标从这里选）
  domain: { key: string; label: string; targets: Target[] };
  onClose: () => void;
  /// 改动之后让主视图重扫（订阅与移除都会改主列表的行）
  onChange: () => Promise<void>;
}

/// 提示条的内容；到点消失与关闭由这一页补上
type ToastText = Pick<ToastProps, "tier" | "kind" | "verb" | "names" | "reason" | "tally">;

/// 打开着的小浮层：`+ 来源`，或某一行的目标
type Layer =
  { kind: "add"; trigger: HTMLElement } | { kind: "targets"; id: string; trigger: HTMLElement };

interface PendingRemove {
  source: SubscribedSource;
  name: string;
  body: string;
  anchor: ConfirmAnchor;
}

const memoryKey = (domainKey: string, sourceId: string) => `skill|${domainKey}|${sourceId}`;

/// 文件夹名：选完文件夹后提示条里写它
const folderName = (path: string) =>
  path
    .split(/[/\\]+/)
    .filter(Boolean)
    .pop() ?? path;

export default function SourcesPage({ domain, onClose, onChange }: SourcesPageProps) {
  const [list, setList] = useState<SourceList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [layer, setLayer] = useState<Layer | null>(null);
  const [pending, setPending] = useState<PendingRemove | null>(null);
  const [toast, setToast] = useState<{ key: number; text: ToastText } | null>(null);
  /// 刚拨过的开关 / 刚改过的目标：重读回来之前先按点下去的样子画（开关不回弹）。值是目标 id，空＝关
  const [optimistic, setOptimistic] = useState<Map<string, string[]>>(new Map());
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  /// 目标键：打开开关后当场把选目标的浮层开在它上面（产品负责人：看不出能选自动加到哪个 agent）
  const targetEls = useRef(new Map<string, HTMLButtonElement>());
  const [openTargetsOf, setOpenTargetsOf] = useState<string | null>(null);
  useEffect(() => {
    if (openTargetsOf === null) return;
    const trigger = targetEls.current.get(openTargetsOf);
    if (trigger) setLayer({ kind: "targets", id: openTargetsOf, trigger });
    setOpenTargetsOf(null);
  }, [openTargetsOf]);
  const addWrap = useRef<HTMLSpanElement>(null);
  const emptyWrap = useRef<HTMLDivElement>(null);

  /// 函数身份不变：提示条的计时器不会被重渲染重置
  const dismissToast = useCallback(() => setToast(null), []);
  const closeLayer = useCallback(() => setLayer(null), []);
  const say = (text: ToastText) => setToast({ key: Date.now(), text });
  const cannot = (verb: string, error: unknown, names?: string[]) =>
    say({ tier: "notice", kind: "cannot", verb, names, reason: String(error) });

  const load = useCallback(async () => {
    try {
      setList(await api.listSources(domain.key));
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    }
    setOptimistic(new Map());
  }, [domain.key]);

  useEffect(() => {
    void load();
  }, [load]);

  /// 改完之后：主视图重扫，这一页重读
  const settle = () => Promise.all([onChange(), load()]);

  const openTargets = domain.targets.filter((t) => t.linkedWholeTo === null);
  const targetsOf = (source: SubscribedSource) =>
    optimistic.get(source.id) ?? (source.autoLink ? source.autoTargets : []);

  const subscribe = async (path: string, name: string) => {
    setLayer(null);
    setBusy(true);
    try {
      await api.subscribeSource(domain.key, path);
      await settle();
      say({ tier: "routine", kind: "success", verb: "添加", names: [name] });
    } catch (e) {
      cannot("没添加", e, [name]);
    }
    setBusy(false);
  };

  const pickFolder = async () => {
    setLayer(null);
    const path = await api.pickDirectory("选择放着 skill 的文件夹");
    if (path) await subscribe(path, folderName(path));
  };

  /// 改规则：打开 / 关掉 / 加减一个目标都当场生效，不确认；失败时开关回到原样并说一声
  const changeRule = async (
    source: SubscribedSource,
    next: string[],
    act: () => Promise<void>,
    failVerb: string,
  ) => {
    setOptimistic((prev) => new Map(prev).set(source.id, next));
    try {
      await act();
      if (next.length > 0)
        saveImportMemory(memoryKey(domain.key, source.id), { last: next, streak: 1 });
      await settle();
    } catch (e) {
      cannot(failVerb, e, [sourceLines(source, domain).name]);
      await load();
    }
  };

  const toggleRule = (source: SubscribedSource, on: boolean) => {
    if (on) {
      const targets = defaultTargets(
        openTargets.map((t) => t.id),
        loadImportMemory(memoryKey(domain.key, source.id))?.last,
      );
      // 打开后当场展开选目标的浮层：默认目标只是起点，要让人看见、能改
      void changeRule(source, targets, () => api.setAutoLink(source.path, targets), "没打开").then(
        () => setOpenTargetsOf(source.id),
      );
    } else {
      const all = domain.targets.map((t) => t.id);
      void changeRule(source, [], () => api.removeAutoLinkTargets(source.path, all), "没关掉");
    }
  };

  const toggleTarget = (source: SubscribedSource, id: string) => {
    const current = targetsOf(source);
    const on = current.includes(id);
    const next = on ? current.filter((t) => t !== id) : [...current, id];
    void changeRule(
      source,
      next,
      () =>
        on ? api.removeAutoLinkTargets(source.path, [id]) : api.setAutoLink(source.path, [id]),
      "没改",
    );
  };

  /// 点 ×：先取会撤掉的软链清单，再出锚定确认（锚在这一行下方）
  const askRemove = async (source: SubscribedSource) => {
    const name = sourceLines(source, domain).name;
    const row = rowEls.current.get(source.id);
    try {
      const removal = await api.planRemoveSource(domain.key, source.id);
      const r = row?.getBoundingClientRect();
      if (!r) return;
      setPending({
        source,
        name,
        body: removeConfirmBody(removal.links),
        anchor: { top: r.top, left: r.left, right: r.right, bottom: r.bottom },
      });
    } catch (e) {
      cannot("没移除", e, [name]);
    }
  };

  const remove = async ({ source, name }: PendingRemove) => {
    setPending(null);
    setBusy(true);
    try {
      const report = await api.removeSource(domain.key, source.id);
      await settle();
      const failed = report.entries.flatMap((e) =>
        e.outcome.status === "failed" ? [e.outcome.reason] : [],
      );
      say(
        failed.length === 0
          ? { tier: "routine", kind: "success", verb: "移除", names: [name] }
          : {
              tier: "notice",
              kind: "partial",
              verb: "移除",
              names: [name],
              tally: { done: report.entries.length - failed.length, failed: failed.length },
              reason: `有 ${failed.length} 条软链没撤掉：${failed[0]}`,
            },
      );
    } catch (e) {
      cannot("没移除", e, [name]);
    }
    setBusy(false);
  };

  /// 浮层开着时 Esc 由浮层接走；确认框开着时 Esc 只取消确认，不退出这一页
  const back = pending ? () => undefined : onClose;
  const title = sourcesTitle(domain);

  const toastNode = toast ? (
    <Toast
      key={toast.key}
      {...toast.text}
      onDismiss={dismissToast}
      onClose={toast.text.tier === "notice" ? dismissToast : undefined}
    />
  ) : null;

  const openAdd = (trigger: HTMLElement | null | undefined) => {
    if (!trigger) return;
    setLayer((prev) => (prev?.kind === "add" ? null : { kind: "add", trigger }));
  };

  const addLayer =
    layer?.kind === "add" && list ? (
      <FloatingLayer
        trigger={layer.trigger}
        onClose={closeLayer}
        className="src-menu"
        label="添加来源"
      >
        <button
          type="button"
          role="menuitem"
          className="src-menu__item"
          onClick={() => void pickFolder()}
        >
          <span className="src-menu__name">选择文件夹…</span>
        </button>
        {candidateGroups(list).map((group) => (
          <Fragment key={group.title}>
            <div className="src-menu__sep" role="separator" />
            <div className="src-menu__head">{group.title}</div>
            {group.items.map((item) => (
              <button
                key={item.path}
                type="button"
                role="menuitem"
                className="src-menu__item"
                title={item.path}
                onClick={() => void subscribe(item.path, item.name)}
              >
                <span className="src-menu__name">{item.name}</span>
                <span className="src-menu__sub">{item.sub}</span>
              </button>
            ))}
          </Fragment>
        ))}
      </FloatingLayer>
    ) : null;

  let body: ReactNode;
  if (list === null) {
    body = loadError ? (
      <div className="src-page__error">
        <NoticePanel message="读不到来源" reason={loadError} />
      </div>
    ) : (
      <Empty kind="scanning" description="正在读来源" />
    );
  } else if (list.subscribed.length === 0) {
    // 空态：一句现状 + `+ 来源`（点开同一个小浮层）
    body = (
      <div className="src-page__empty" ref={emptyWrap}>
        <Empty
          kind="noSkills"
          description={noSourcesText(domain)}
          art="folders"
          primary={{
            label: "来源",
            icon: <IconPlus size={12} />,
            onClick: () => openAdd(emptyWrap.current?.querySelector("button")),
          }}
        />
        {toastNode}
      </div>
    );
  } else {
    const dups = duplicateNames(list.subscribed);
    body = (
      <div className="src-page">
        <Busy busy={busy} className="src-panel">
          <div className="src-panel__head">
            <span>来源</span>
            <span>以后新出现的</span>
          </div>
          {list.subscribed.map((source) => {
            const open = expanded.has(source.id);
            const { name } = sourceLines(source, domain);
            const targets = targetsOf(source);
            const on = targets.length > 0;
            const shown = domain.targets.filter((t) => targets.includes(t.id));
            const switchReason = !source.canAutoLink
              ? "外部来源看不到以后新出现的 skill"
              : !on && openTargets.length === 0
                ? "这里还没有能加到的 agent"
                : undefined;
            return (
              <div className={`src-row${open ? " is-open" : ""}`} key={source.id}>
                <div
                  className="src-row__main"
                  ref={(el) => {
                    if (el) rowEls.current.set(source.id, el);
                    else rowEls.current.delete(source.id);
                  }}
                >
                  <button
                    type="button"
                    className="src-row__name"
                    aria-expanded={open}
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (!next.delete(source.id)) next.add(source.id);
                        return next;
                      })
                    }
                  >
                    <span className="src-row__caret">
                      <Disclosure open={open} shown />
                    </span>
                    <span className="src-row__text">
                      <span className="src-row__label">{name}</span>
                      <Tooltip content={source.path}>
                        <span className="src-row__sub">{sourceSubtitle(source, domain)}</span>
                      </Tooltip>
                    </span>
                  </button>

                  <div className="src-row__rule">
                    {switchReason ? (
                      // 禁用的开关接不到悬停：提示框挂在包层上（css 让禁用开关不吃指针）
                      <Tooltip content={switchReason} focusable>
                        <span className="src-row__switch">
                          <Switch
                            checked={on}
                            onChange={() => undefined}
                            label={`${name} 以后新出现的 skill 自动添加`}
                            disabledReason={switchReason}
                          />
                        </span>
                      </Tooltip>
                    ) : (
                      <Switch
                        checked={on}
                        onChange={(next) => toggleRule(source, next)}
                        label={`${name} 以后新出现的 skill 自动添加`}
                        title="只管以后新出现的，现有的不变"
                      />
                    )}
                    <span className={`src-row__rulelabel${switchReason ? " is-disabled" : ""}`}>
                      {on ? "自动加到" : "自动添加"}
                    </span>
                    {on ? (
                      <button
                        type="button"
                        ref={(el) => {
                          if (el) targetEls.current.set(source.id, el);
                          else targetEls.current.delete(source.id);
                        }}
                        className={`src-row__targets${layer?.kind === "targets" && layer.id === source.id ? " is-open" : ""}`}
                        aria-haspopup="menu"
                        aria-expanded={layer?.kind === "targets" && layer.id === source.id}
                        title="改自动加到的 agent"
                        onClick={(e) => {
                          const trigger = e.currentTarget;
                          setLayer((prev) =>
                            prev?.kind === "targets" && prev.id === source.id
                              ? null
                              : { kind: "targets", id: source.id, trigger },
                          );
                        }}
                      >
                        {shown.length > 0
                          ? shown.map((t) => (
                              <AgentIcon
                                key={t.id}
                                id={t.scope.harnessId}
                                name={t.label}
                                size={14}
                                labelled
                              />
                            ))
                          : `${targets.length} 个 agent`}
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
                      {source.own ? (
                        <Tooltip content={ownRemoveReason(domain)} placement="bottom" focusable>
                          <IconButton
                            icon={<IconClose />}
                            title={removeTitle(domain, name)}
                            disabledReason={ownRemoveReason(domain)}
                          />
                        </Tooltip>
                      ) : (
                        <IconButton
                          icon={<IconClose />}
                          title={removeTitle(domain, name)}
                          onClick={() => void askRemove(source)}
                        />
                      )}
                    </span>
                  </div>
                </div>

                {open ? (
                  source.skills.length === 0 ? (
                    <div className="src-row__none">文件夹里现在没有 skill</div>
                  ) : (
                    <div
                      className="src-row__skills"
                      style={{
                        gridTemplateRows: `repeat(${columnRows(source.skills.length)}, auto)`,
                      }}
                    >
                      {source.skills.map((skill) => (
                        <div className="src-skill" key={skill}>
                          <span className="src-skill__name">{skill}</span>
                          {dups.has(skill) ? (
                            <Tag tip="两份都在列表里，到行上只留一份">同名</Tag>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )
                ) : null}

                {layer?.kind === "targets" && layer.id === source.id ? (
                  <FloatingLayer
                    trigger={layer.trigger}
                    onClose={closeLayer}
                    className="src-targetmenu"
                    label="自动加到的 agent"
                  >
                    {domain.targets.map((t) => {
                      const checked = targets.includes(t.id);
                      const reason =
                        t.linkedWholeTo === null
                          ? undefined
                          : `${t.label} 的 skills 文件夹整个是链接，拆开后才能逐个开关`;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={checked}
                          className={`src-target${checked ? " is-on" : ""}`}
                          title={reason}
                          disabled={reason !== undefined}
                          onClick={() => toggleTarget(source, t.id)}
                        >
                          <CheckMark on={checked} />
                          <AgentIcon id={t.scope.harnessId} name={t.label} size={14} />
                          <span className="src-target__name">{t.label}</span>
                        </button>
                      );
                    })}
                  </FloatingLayer>
                ) : null}
              </div>
            );
          })}
        </Busy>
        <div className="src-foot">
          <span ref={addWrap}>
            <Busy busy={busy}>
              <AddButton
                noun="来源"
                onClick={() => openAdd(addWrap.current?.querySelector("button"))}
              />
            </Busy>
          </span>
          {toastNode}
        </div>
      </div>
    );
  }

  return (
    <SubPage title={title} onBack={back}>
      {body}
      {addLayer}
      {pending ? (
        <Confirm
          title={removeConfirmTitle(domain, pending.name)}
          confirmLabel="移除"
          anchor={pending.anchor}
          onConfirm={() => void remove(pending)}
          onCancel={() => setPending(null)}
        >
          {pending.body}
        </Confirm>
      ) : null}
    </SubPage>
  );
}

/// 小浮层（与侧栏排序下拉、模型选择器同一写法：layer 圆角 + 浮层阴影，无黑框）：
/// 锚在触发它的控件下方 6、左对齐；下方放不下就翻到上方。点外面、Esc、滚动都关，不铺透明罩。
/// 用 fixed 定位：空态里的 `+ 来源` 在 Empty 里面，没法给它包一个定位容器
function FloatingLayer({
  trigger,
  onClose,
  className,
  label,
  children,
}: {
  trigger: HTMLElement;
  onClose: () => void;
  className: string;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = trigger.getBoundingClientRect();
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    const below = a.bottom + 6;
    const top = below + h > window.innerHeight - 16 && a.top - 6 - h >= 16 ? a.top - 6 - h : below;
    setPos({ top, left: Math.max(16, Math.min(a.left, window.innerWidth - w - 16)) });
  }, [trigger]);

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
      className={`src-layer ${className}`}
      role="menu"
      aria-label={label}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}
    >
      {children}
    </div>
  );
}
