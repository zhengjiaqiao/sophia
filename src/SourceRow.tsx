/// 来源行（DESIGN「位置页 › 来源行」「来源：订阅、来源行、添加来源」，裁决 D3）：取代来源管理页。
/// 恰好选中一个来源片时，片下出这一来源的一行：
///
///   ~/Library/…/WeiboAP/skills  打开 ↗            以后新出现的自动加到 [✳ ⎔ ▾]  •[开关]   ×
///
/// - 左：短路径（mono 12 `ink-faint`，`~` 开头，放不下中段省略，截断才出完整路径的提示框）+ `打开 ↗`
/// - 右：规则 `以后新出现的自动加到`（MCP：`自动写进`）+ 目标框 + 紧凑开关；打开开关当场展开选目标的浮层；
///   开 / 关都不确认（只管以后新出现的，不补链现有的）
/// - 最右：`×` 移除这个来源（锚定确认列出会撤掉的）；原件在这个位置里的来源 × 禁用、按下即说原因
///
/// 规则状态（片首橙点与这一行的开关同一帧变）与移除流程由 `useSources` 持有：来源片的右键菜单
/// 「移除来源…」走同一个确认，所以移除不能跟着这一行挂载。skill 与 MCP 只差数据源（`SourcesModel`）。
///
/// 来源片那一行末尾的 `管理来源`（裁决 15）：开关式安静键，按下片下展开「全部来源」——订阅的每个来源
/// 一行，每行就是这里的来源行、行首多一列来源名。开合也由 `useSources` 持有（片、右键菜单、Esc 都要收它）。
import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import {
  AgentIcon,
  BusySlot,
  Button,
  Confirm,
  FloatingToast,
  IconButton,
  IconClose,
  Switch,
  Toast,
  Tooltip,
  TruncTip,
} from "./ui/index.ts";
import type { ConfirmAnchor } from "./ui/index.ts";
import { FloatingLayer } from "./ui/FloatingLayer.tsx";
import { RevealLink } from "./Matrix.tsx";
import { CheckMark } from "./pages/CheckMark.tsx";
import { defaultTargets, loadImportMemory, saveImportMemory } from "./pages/importDefaults.ts";
import {
  ALL_SOURCES,
  manageSourcesLabel,
  removeConfirmTitle,
  removeTitle,
  type DomainRef,
} from "./pages/sourcesView.ts";
import type {
  SourceRow as SourceRowData,
  SourcesData,
  SourcesModel,
  ToastText,
} from "./pages/sourcesModel.ts";
import type { AnchorRect, ToastAlign } from "./layerPlace.ts";
import { displayPath } from "./pathText.ts";
import "./SourceRow.css";

/// 短路径拆成两段：前段放不下以 … 截断，末两级完整保留（中段省略：`~/Library/…/WeiboAP/skills`）
export function splitPath(path: string): { head: string; tail: string } {
  const shown = displayPath(path);
  const sep = shown.includes("\\") && !shown.includes("/") ? "\\" : "/";
  const parts = shown.split(sep);
  if (parts.length <= 3) return { head: "", tail: shown };
  const tail = parts.slice(-2).join(sep);
  return { head: shown.slice(0, shown.length - tail.length), tail };
}

interface PendingRemove {
  row: SourceRowData;
  body: string;
  commit: () => Promise<ToastText>;
  anchor: ConfirmAnchor;
  /// 按下那一刻触发控件的位置：结果锚在这里（行被移除之后也还在原处）
  at: AnchorRect;
  align: ToastAlign;
}

export interface SourcesState {
  data: SourcesData | null;
  /// 这一行此刻的目标（点过开关、还没重读回来时按点下去的样子）；空＝规则关着
  targetsOf: (row: SourceRowData) => string[];
  /// 这个来源的规则开着没有（片首橙点）
  ruleOn: (id: string) => boolean;
  rowOf: (id: string) => SourceRowData | undefined;
  /// 改规则：打开 / 关掉 / 加减一个目标都当场生效；没成回到原样，在 `at` 下说一声
  setRule: (row: SourceRowData, next: string[], failVerb: string, at: AnchorRect | null) => void;
  /// 点 × 或右键「移除来源…」：先取清单（触发控件原位忙碌），再出锚定确认
  askRemove: (
    row: SourceRowData,
    trigger: Element,
    anchor: Element,
    align?: ToastAlign,
  ) => Promise<void>;
  /// 正在为哪一个来源查看影响 / 移除
  removeBusy: { id: string; kind: "planning" | "removing" } | null;
  /// 确认框与结果提示小窗：由页面挂在表格旁边（不跟着来源行挂载）
  host: ReactNode;
  /// 在 `at` 下浮起一窗（规则没改成）
  say: (text: ToastText, at: AnchorRect | null, align: ToastAlign) => void;
  /// 「全部来源」列表展开着没有（没订阅任何来源时恒为 false）；不记忆，换位置、重新进来都收着
  listOpen: boolean;
  setListOpen: (open: boolean) => void;
  /// `管理来源` 键外的包层与列表：Esc 收起时焦点在列表里就还给键
  keyRef: RefObject<HTMLSpanElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  listId: string;
}

/// 这个位置已订阅的来源与它们的规则、移除。`version` 变了就重读（位置页每次重扫都给一个新值）；
/// `onChange`：改了规则 / 移除之后让位置页重扫；`onRemoved`：移除确认后（筛选回到 `全部`）
export function useSources({
  model,
  domain,
  version,
  onChange,
  onRemoved,
  keys = true,
}: {
  model: SourcesModel;
  domain: DomainRef;
  version: unknown;
  onChange: () => Promise<void>;
  onRemoved: (id: string) => void;
  /// 页面此刻接不接 Esc（添加来源页、确认框、浮层开着时由它们接）
  keys?: boolean;
}): SourcesState {
  const [data, setData] = useState<SourcesData | null>(null);
  const [optimistic, setOptimistic] = useState<Map<string, string[]>>(new Map());
  const [removeBusy, setRemoveBusy] = useState<SourcesState["removeBusy"]>(null);
  const [pending, setPending] = useState<PendingRemove | null>(null);
  const [toast, setToast] = useState<{
    key: number;
    text: ToastText;
    at: AnchorRect;
    align: ToastAlign;
  } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await model.load();
      if (alive.current) setData(next);
    } catch {
      // 读不到来源时来源片照常（按表格的行成片），只是没有规则状态与来源行；下次重扫再读
      if (alive.current) setData(null);
    }
    if (alive.current) setOptimistic(new Map());
  }, [model]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const say = useCallback((text: ToastText, at: AnchorRect | null, align: ToastAlign) => {
    if (at) setToast({ key: Date.now(), text, at, align });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const [listWanted, setListOpen] = useState(false);
  const keyRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  // 换了位置：收起（展开状态不记忆）
  useEffect(() => setListOpen(false), [domain.key]);
  const listOpen = listWanted && (data?.rows.length ?? 0) > 0;
  // Esc 收起：浮层（捕获阶段）、表格（展开的行、选中的行）先接走的不再算；输入框里的归输入框；
  // 移除确认开着时 Esc 只取消确认
  const confirming = pending !== null;
  useEffect(() => {
    if (!listOpen || !keys || confirming) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      event.preventDefault();
      if (listRef.current?.contains(document.activeElement)) {
        keyRef.current?.querySelector("button")?.focus();
      }
      setListOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [listOpen, keys, confirming]);

  const targetsOf = (row: SourceRowData) => optimistic.get(row.id) ?? row.targets;
  const rowOf = (id: string) => data?.rows.find((r) => r.id === id);

  const setRule = (row: SourceRowData, next: string[], failVerb: string, at: AnchorRect | null) => {
    const prev = targetsOf(row);
    setOptimistic((m) => new Map(m).set(row.id, next));
    void (async () => {
      try {
        await model.setTargets(row, next, prev);
        if (next.length > 0) saveImportMemory(model.memoryKey(row.id), { last: next, streak: 1 });
        await Promise.all([onChange(), load()]);
      } catch (e) {
        say(
          { tier: "notice", kind: "cannot", verb: failVerb, names: [row.name], reason: String(e) },
          at,
          "start",
        );
        await load();
      }
    })();
  };

  const askRemove = async (
    row: SourceRowData,
    trigger: Element,
    anchorEl: Element,
    align: ToastAlign = "end",
  ) => {
    if (removeBusy?.id === row.id) return;
    const c = trigger.getBoundingClientRect();
    const at = { top: c.top, bottom: c.bottom, left: c.left, right: c.right };
    setRemoveBusy({ id: row.id, kind: "planning" });
    try {
      const { body, commit } = await model.planRemove(row);
      const r = anchorEl.getBoundingClientRect();
      if (!alive.current) return;
      setPending({
        row,
        body,
        commit,
        anchor: { top: r.top, left: r.left, right: r.right, bottom: r.bottom },
        at,
        align,
      });
    } catch (e) {
      say(
        { tier: "notice", kind: "cannot", verb: "没移除", names: [row.name], reason: String(e) },
        at,
        align,
      );
    } finally {
      setRemoveBusy((prev) => (prev?.id === row.id && prev.kind === "planning" ? null : prev));
    }
  };

  /// 确认之后移除：只有触发它的那颗 × 忙碌，不把整页变暗；结果浮在 × 原来的位置下（不给撤销：
  /// 撤掉的软链一条条链回去不等于原样，⑭ 撤不了就不假装）
  const remove = async ({ row, commit, at, align }: PendingRemove) => {
    setPending(null);
    setRemoveBusy({ id: row.id, kind: "removing" });
    try {
      const text = await commit();
      onRemoved(row.id);
      await Promise.all([onChange(), load()]);
      say({ ...text, names: [row.name] }, at, align);
    } catch (e) {
      say(
        { tier: "notice", kind: "cannot", verb: "没移除", names: [row.name], reason: String(e) },
        at,
        align,
      );
    } finally {
      setRemoveBusy((prev) => (prev?.id === row.id ? null : prev));
    }
  };

  const host = (
    <>
      {toast ? (
        <FloatingToast key={toast.key} align={toast.align} anchor={() => toast.at}>
          <Toast
            {...toast.text}
            onDismiss={dismissToast}
            onClose={toast.text.tier === "notice" ? dismissToast : undefined}
          />
        </FloatingToast>
      ) : null}
      {pending ? (
        <Confirm
          title={removeConfirmTitle(domain, pending.row.name)}
          confirmLabel="移除"
          anchor={pending.anchor}
          // × 在来源行的右端：确认框右对齐到行尾、出在它下面，不盖来源行
          align={pending.align === "end" ? "end" : "start"}
          onConfirm={() => void remove(pending)}
          onCancel={() => setPending(null)}
        >
          {pending.body}
        </Confirm>
      ) : null}
    </>
  );

  return {
    data,
    targetsOf,
    ruleOn: (id) => {
      const row = rowOf(id);
      return row !== undefined && targetsOf(row).length > 0;
    },
    rowOf,
    setRule,
    askRemove,
    removeBusy,
    host,
    say,
    listOpen,
    setListOpen,
    keyRef,
    listRef,
    listId,
  };
}

/// 来源片那一行末尾的 `管理来源` / `收起`（安静键，左距 8）。一个来源都没订阅时不出（空态已有 `+ 来源`）
export function ManageSourcesKey({ state }: { state: SourcesState }) {
  if ((state.data?.rows.length ?? 0) === 0) return null;
  return (
    <span className="srcmanage" ref={state.keyRef}>
      <Button
        variant="quiet"
        size="compact"
        ariaExpanded={state.listOpen}
        ariaControls={state.listOpen ? state.listId : undefined}
        onClick={() => state.setListOpen(!state.listOpen)}
      >
        {manageSourcesLabel(state.listOpen)}
      </Button>
    </span>
  );
}

/// 「全部来源」：这个位置订阅的每个来源一行＝来源名（13 `ink`，最宽 160，截断才提示）+ 来源行。
/// 名字列按最长的名字定宽（至多 160），各行的路径对齐；行间 1px `row-line`（来源行自己的底线）
export function SourceListView({
  state,
  model,
  domain,
  onReveal,
}: {
  state: SourcesState;
  model: SourcesModel;
  domain: DomainRef;
  onReveal: (path: string) => void;
}) {
  const rows = state.data?.rows ?? [];
  return (
    <div
      className="srclist"
      id={state.listId}
      ref={state.listRef}
      role="group"
      aria-label={ALL_SOURCES}
    >
      {rows.map((row) => (
        <Fragment key={row.id}>
          <div className="srclist__name">
            <TruncTip content={row.name}>
              <span className="srclist__label">{row.name}</span>
            </TruncTip>
          </div>
          <SourceRowView
            state={state}
            row={row}
            model={model}
            domain={domain}
            onReveal={onReveal}
          />
        </Fragment>
      ))}
    </div>
  );
}

/// 来源行的规则句：skill `以后新出现的自动加到`，MCP `以后新出现的自动写进`
const ruleText = (model: SourcesModel) => `以后新出现的${model.ruleOn}`;

export function SourceRowView({
  state,
  row,
  model,
  domain,
  onReveal,
}: {
  state: SourcesState;
  row: SourceRowData;
  model: SourcesModel;
  domain: DomainRef;
  onReveal: (path: string) => void;
}) {
  const lineRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLSpanElement>(null);
  const [layerOpen, setLayerOpen] = useState(false);
  const closeLayer = useCallback(() => setLayerOpen(false), []);
  /// 打开开关后当场把选目标的浮层开在目标框上（默认目标只是起点，要让人看见、能改）
  const [openAfterOn, setOpenAfterOn] = useState(false);
  useEffect(() => {
    if (!openAfterOn) return;
    setOpenAfterOn(false);
    setLayerOpen(true);
  }, [openAfterOn]);
  // 换了来源：收起浮层
  useEffect(() => setLayerOpen(false), [row.id]);
  /// 规则关着时改的目标只记在本机（打开时用），记完重画一次让浮层里的勾跟上
  const [, setTick] = useState(0);
  const forceRender = () => setTick((n) => n + 1);

  const targets = state.targetsOf(row);
  const on = targets.length > 0;
  const options = model.targetsFor(row);
  const memory = loadImportMemory(model.memoryKey(row.id))?.last;
  /// 规则关着时浮层里勾着的：打开开关时会用的那一组（上次用的，没有则可选的前两个）
  const planned = defaultTargets(model.pickable(row), memory);
  const checkedIds = on ? targets : planned;
  const shown = options.filter((t) => targets.includes(t.id));
  const switchReason = on
    ? undefined
    : (row.switchReason ?? (model.pickable(row).length === 0 ? model.noTargetsReason : undefined));
  const ruleLabel = `${row.name} ${ruleText(model)}指定的 agent`;

  /// 按下那一刻控件的位置：左右取控件，上下取这一行（不盖住这一行）
  const pressedAt = (el: Element | null | undefined): AnchorRect | null => {
    if (!el) return null;
    const c = el.getBoundingClientRect();
    const line = lineRef.current?.getBoundingClientRect();
    return {
      top: line?.top ?? c.top,
      bottom: line?.bottom ?? c.bottom,
      left: c.left,
      right: c.right,
    };
  };

  const toggleRule = (next: boolean) => {
    const at = pressedAt(lineRef.current?.querySelector('[role="switch"]'));
    if (next) {
      state.setRule(row, planned, "没打开", at);
      setOpenAfterOn(true);
    } else {
      setLayerOpen(false);
      state.setRule(row, [], "没关掉", at);
    }
  };

  const toggleTarget = (id: string, el: Element) => {
    const next = checkedIds.includes(id) ? checkedIds.filter((t) => t !== id) : [...checkedIds, id];
    if (!on) {
      // 规则关着：只记下打开时用哪几个，不替用户打开规则
      saveImportMemory(model.memoryKey(row.id), { last: next, streak: 1 });
      forceRender();
      return;
    }
    state.setRule(row, next, "没改", pressedAt(el));
  };
  const path = splitPath(row.path);
  const busy = state.removeBusy?.id === row.id ? state.removeBusy.kind : null;

  return (
    <div className="srcrow" ref={lineRef}>
      <div className="srcrow__where">
        <TruncTip content={<span className="mx-mono">{displayPath(row.path)}</span>}>
          <span className="srcrow__path ss-selectable">
            {path.head ? <span className="srcrow__head">{path.head}</span> : null}
            <span className="srcrow__tail">{path.tail}</span>
          </span>
        </TruncTip>
        <RevealLink path={row.path} onReveal={() => onReveal(row.path)} />
      </div>
      <div className="srcrow__rule">
        <span className={`srcrow__label${switchReason ? " is-disabled" : ""}`}>
          {ruleText(model)}
        </span>
        <Tooltip
          content={
            layerOpen
              ? undefined
              : on
                ? `${model.ruleOn} ${shown.map((t) => t.label).join("、")}`
                : undefined
          }
        >
          <button
            type="button"
            ref={boxRef}
            className={`srcrow__targets${layerOpen ? " is-open" : ""}${on ? "" : " is-off"}`}
            aria-haspopup="menu"
            aria-expanded={layerOpen}
            aria-label={model.targetsTitle}
            onClick={() => setLayerOpen((v) => !v)}
          >
            {on ? (
              shown.length > 0 ? (
                shown.map((t) => (
                  <AgentIcon key={t.id} id={t.iconId} name={t.label} size={13} labelled />
                ))
              ) : (
                `${targets.length} ${model.targetUnit}`
              )
            ) : (
              <span className="srcrow__pick">选目标</span>
            )}
            {/* 下拉记号：看得出这组图标能点开改（⑧ 外观说明如何操作） */}
            <svg
              className="srcrow__chevron"
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
        </Tooltip>
        {switchReason ? (
          <Switch
            size="compact"
            checked={on}
            onChange={() => undefined}
            label={ruleLabel}
            disabledReason={switchReason}
          />
        ) : (
          <Switch
            size="compact"
            checked={on}
            onChange={toggleRule}
            label={ruleLabel}
            title={row.switchTitle}
          />
        )}
      </div>
      <span className="srcrow__remove" ref={removeRef}>
        {row.own ? (
          <IconButton
            icon={<IconClose />}
            title={removeTitle(domain, row.name)}
            disabledReason={model.ownRemoveReason}
            tipPlacement="bottom"
          />
        ) : (
          <BusySlot busy={busy !== null} label={busy === "removing" ? "正在移除" : "正在查看影响"}>
            <IconButton
              icon={<IconClose />}
              title={removeTitle(domain, row.name)}
              onClick={() => {
                const x = removeRef.current?.querySelector("button");
                if (x && lineRef.current) void state.askRemove(row, x, lineRef.current);
              }}
            />
          </BusySlot>
        )}
      </span>
      {layerOpen && boxRef.current ? (
        <FloatingLayer
          trigger={boxRef.current}
          onClose={closeLayer}
          className="srcrow-targets"
          label={model.targetsLabel}
        >
          {options.map((t) => {
            const checked = checkedIds.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                className={`srcrow-target${checked ? " is-on" : ""}`}
                aria-describedby={t.disabledReason ? `${row.id}-${t.id}-why` : undefined}
                disabled={t.disabledReason !== undefined}
                onClick={(e) => toggleTarget(t.id, e.currentTarget)}
              >
                <CheckMark on={checked} />
                <AgentIcon id={t.iconId} name={t.label} size={14} />
                <span className="srcrow-target__text">
                  <span className="srcrow-target__name">{t.label}</span>
                  {/* 点不了的那一项：原因就写在这一行里（浮层会滚动裁切，悬停提示框放不进去） */}
                  {t.disabledReason ? (
                    <span className="srcrow-target__why" id={`${row.id}-${t.id}-why`}>
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
}
