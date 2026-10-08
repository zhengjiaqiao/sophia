import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { coachStore } from "./coach.ts";
import { t } from "./i18n.ts";
import { contextLabel } from "./modelsView.ts";
import {
  blockedText,
  dropIndex,
  filterGroups,
  groupName,
  isOfficial,
  moveBy,
  moveTo,
  noProviders,
  pickEmptyText,
  pickedFootnote,
  pickedTabCount,
  positionText,
  sameRef,
} from "./pickView.ts";
import type { PickTab } from "./pickView.ts";
import type { AgentModels, GatewayAgent, ModelRef, PickGroup } from "./types.ts";
import {
  Button,
  CheckRow,
  Coach,
  FloatingLayer,
  IconButton,
  IconClose,
  IconGrip,
  Mono,
  Tabs,
  TextField,
  motionMs,
  playJoin,
} from "./ui/index.ts";
import "./PickModels.css";

/// 选模型浮层（#259 / #265，画板第 1、1′、2 屏；DESIGN-components「模型浮层」）：模型页一行行尾 `已选 N 个模型 ▾` 打开。
///
/// - 顶上：标题 `X 的模型`、搜索框（常显）、紧凑页签 `全部 / 已选 N`
/// - 「全部」：按提供商分组，官方一组在前；组头只写名字，改不了的组照样逐个列出、置灰，原因写在组头后面一次。
///   勾一个＝追加到「已选」末尾，名字飞进 `已选` 页签（「加入」动效），落地时数字加一；一家提供商都没有时官方组下说一句、
///   给 `添加模型提供商`。整个应用第一次有模型落进「已选」时，从页签下弹一次引导气泡
/// - 「已选」：按顺序编号、拉手常显；拖动或 ⌥↑ / ⌥↓ 排序（读屏报「第 2 个，共 5 个」），× 拿掉；
///   底部 `恢复默认顺序`（官方的在前按它自己的顺序、第三方按启用先后）
/// - 底部：「全部」只有 `管理模型提供商`（启用与选是两步，2026-10-08）；「已选」写顺序的说法
///
/// 写入由调用方做（`onPick` / `onReorder` / `onRestoreOrder`）：先画成做成之后的样子，做不成调用方退回并在行下说。
/// 「已选」里只有这个 agent 能排的项（官方模型只读、不进排序的 agent，官方模型本来就不在「已选」里，见 core 的
/// `MODEL_AGENTS`），所以每一项都有编号与拉手
export interface PickModelsProps {
  agent: GatewayAgent;
  /// 模型页里这一行的显示名
  name: string;
  models: AgentModels;
  trigger: HTMLElement;
  onPick: (
    ref: ModelRef,
    on: boolean,
    shown: { displayName: string; providerName: string },
  ) => void;
  /// 排序：「已选」里这些项的新顺序（就是此刻列出的全部，换了位置）
  onReorder: (order: ModelRef[]) => void;
  /// `恢复默认顺序`
  onRestoreOrder: () => void;
  /// 推入模型提供商页（浮层先收起）
  onManage: () => void;
  onClose: () => void;
}

const refKey = (ref: ModelRef) => `${ref.provider}|${ref.model}`;

/// 正在拖的那一行：从第几个拖起、此刻排到第几个、拖动开始时各行的中线与它自己的中线、指针起点
interface Drag {
  from: number;
  to: number;
  mids: number[];
  startY: number;
  /// 指针挪过 4px 才算开始拖（之前只是按下）
  moving: boolean;
}

/// 按下之后挪多远才算拖（以免点一下就被当成拖了 0 格）
const DRAG_SLOP = 4;

export function PickModels({
  agent,
  name,
  models,
  trigger,
  onPick,
  onReorder,
  onRestoreOrder,
  onManage,
  onClose,
}: PickModelsProps) {
  const [tab, setTab] = useState<PickTab>("all");
  const [query, setQuery] = useState("");
  /// 还在飞的几枚：它们落地之前页签上的数先不加（`pickedTabCount`）
  const [flying, setFlying] = useState<ModelRef[]>([]);
  const [coachOpen, setCoachOpen] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  /// 读屏要报的一句（换一个 key 重挂，同一句也会再报）
  const [said, setSaid] = useState<{ text: string; n: number }>({ text: "", n: 0 });
  const mounted = useRef(true);
  const tabsRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const checkRows = useRef(new Map<string, HTMLDivElement>());
  /// 键盘挪完之后焦点要回到的那一项
  const refocus = useRef<string | null>(null);
  const hintId = useId();

  const title = t("models.pick.title", { agent: name });
  const empty = pickEmptyText(models, tab, query);
  const groups = filterGroups(models.groups, query);
  const official = groups.filter((g) => isOfficial({ provider: g.provider, model: "" }));
  const others = groups.filter((g) => !isOfficial({ provider: g.provider, model: "" }));
  const picked = drag?.moving ? moveTo(models.picked, drag.from, drag.to) : models.picked;
  const total = models.picked.length;

  useEffect(() => {
    mounted.current = true;
    void coachStore.load();
    return () => {
      mounted.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const key = refocus.current;
    if (key === null) return;
    refocus.current = null;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-pick-key="${CSS.escape(key)}"]`)
      ?.focus({ preventScroll: false });
  });

  const say = (text: string) => setSaid((prev) => ({ text, n: prev.n + 1 }));
  const pickedTab = () => tabsRef.current?.querySelectorAll("button")[1] ?? null;

  /// 一枚落进「已选」：整个应用第一次时弹引导气泡（只出一次，记在设置里；读屏由气泡自己的 status 区读）
  const landed = () => {
    if (mounted.current && coachStore.show("pick-order")) setCoachOpen(true);
  };

  /// 勾上：先画（调用方），再让名字从勾选处飞进 `已选` 页签；减少动态效果时不飞、直接落地
  const pickOn = (
    key: string,
    ref: ModelRef,
    shown: { displayName: string; providerName: string },
  ) => {
    onPick(ref, true, shown);
    const from = checkRows.current.get(key);
    const to = pickedTab();
    if (!from || !to || motionMs("--dur-join") <= 0) {
      landed();
      return;
    }
    setFlying((list) => [...list, ref]);
    void playJoin(from.getBoundingClientRect(), to.getBoundingClientRect(), shown.displayName).then(
      () => {
        if (!mounted.current) return;
        setFlying((list) => {
          const at = list.findIndex((item) => sameRef(item, ref));
          return at < 0 ? list : [...list.slice(0, at), ...list.slice(at + 1)];
        });
        landed();
      },
    );
  };

  const switchTab = (next: PickTab) => {
    setTab(next);
    if (next === "picked") setCoachOpen(false);
  };

  // ----- 排序 -----

  const reorder = (list: typeof models.picked, at: number) => {
    onReorder(list.map((item) => item.ref));
    say(positionText(at, list.length));
  };

  const onRowKey = (event: KeyboardEvent<HTMLLIElement>, index: number) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const delta = event.key === "ArrowUp" ? -1 : 1;
    event.preventDefault();
    if (!event.altKey) {
      // 不带 ⌥：焦点在行间上下走
      const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-pick-key]");
      rows?.[index + delta]?.focus();
      return;
    }
    const moved = moveBy(models.picked, index, delta);
    if (moved === null) return;
    refocus.current = refKey(models.picked[index].ref);
    reorder(moved.list, moved.index);
  };

  // 拖动：按下记住各行此刻的中线，之后的移动与松手在 window 上接（行在拖动中会被挪位置，挪过的节点接不住指针捕获）
  const dragRef = useRef<Drag | null>(null);
  const putDrag = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };
  const dragging = drag !== null;
  const dropRef = useRef<(d: Drag) => void>(() => {});
  dropRef.current = (d) => {
    if (d.moving && d.to !== d.from) reorder(moveTo(models.picked, d.from, d.to), d.to);
  };
  useEffect(() => {
    if (!dragging) return;
    const move = (event: globalThis.PointerEvent) => {
      const d = dragRef.current;
      if (d === null) return;
      const dy = event.clientY - d.startY;
      if (!d.moving && Math.abs(dy) < DRAG_SLOP) return;
      const to = dropIndex(d.mids, d.from, d.mids[d.from] + dy);
      if (d.moving && to === d.to) return;
      putDrag({ ...d, to, moving: true });
    };
    const up = () => {
      const d = dragRef.current;
      putDrag(null);
      if (d !== null) dropRef.current(d);
    };
    const cancel = () => putDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [dragging]);

  const onRowDown = (event: PointerEvent<HTMLLIElement>, index: number) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-pick-key]");
    if (!rows) return;
    const mids = Array.from(rows, (row) => {
      const box = row.getBoundingClientRect();
      return box.top + box.height / 2;
    });
    putDrag({ from: index, to: index, mids, startY: event.clientY, moving: false });
  };

  const group = (g: PickGroup) => {
    const reason = g.blocked === null ? null : blockedText(g.blocked, name);
    return (
      <div key={g.provider} className="pick-layer__group" role="group" aria-label={groupName(g)}>
        <div className="pick-layer__group-head">
          <span className="pick-layer__group-name">{groupName(g)}</span>
          {reason !== null ? <span className="pick-layer__group-why">{reason}</span> : null}
        </div>
        {g.models.map((m) => {
          const context = contextLabel(m.contextWindow);
          const key = `${m.ref.provider}|${m.ref.model}|${m.displayName}`;
          const shown = {
            displayName: m.displayName,
            providerName: isOfficial(m.ref) ? "" : g.name,
          };
          return (
            <div
              key={key}
              className="pick-layer__check"
              ref={(el) => {
                if (el) checkRows.current.set(key, el);
                else checkRows.current.delete(key);
              }}
            >
              <CheckRow
                checked={m.picked}
                label={m.displayName}
                disabledReason={reason ?? undefined}
                trailing={context ? <Mono>{context}</Mono> : undefined}
                onChange={(next) =>
                  next ? pickOn(key, m.ref, shown) : onPick(m.ref, false, shown)
                }
              >
                {m.displayName}
              </CheckRow>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <FloatingLayer
      trigger={trigger}
      onClose={onClose}
      role="dialog"
      align="end"
      list
      label={title}
      className="pick-layer"
    >
      <div className="pick-layer__head">
        <div className="pick-layer__title">{title}</div>
        <div className="pick-layer__bar">
          <TextField
            search
            label={t("models.pick.search")}
            value={query}
            autoFocus
            spellCheck={false}
            placeholder={t("models.pick.search")}
            onChange={setQuery}
          />
          <div className="pick-layer__tabs" data-pick-tab={tab} ref={tabsRef}>
            <Tabs
              compact
              plain
              label={t("models.pick.tabs")}
              value={tab}
              onChange={switchTab}
              items={[
                { id: "all", label: t("models.pick.tabAll") },
                {
                  id: "picked",
                  label: t("models.pick.tabPicked"),
                  count: pickedTabCount(models.picked, flying),
                },
              ]}
            />
          </div>
        </div>
        <Coach
          anchor={coachOpen ? pickedTab() : null}
          open={coachOpen}
          onDismiss={() => setCoachOpen(false)}
        >
          {t("models.pick.coach", { agent: name })}
        </Coach>
      </div>
      {tab === "all" ? (
        <div className="pick-layer__rows">
          {official.map(group)}
          {noProviders(models) && query.trim() === "" ? (
            <div className="pick-layer__none">
              <p className="pick-layer__empty">{t("models.pick.noProviders")}</p>
              <Button size="compact" onClick={onManage}>
                {t("models.pick.addProvider")}
              </Button>
            </div>
          ) : null}
          {others.map(group)}
          {empty !== null ? <p className="pick-layer__empty">{empty}</p> : null}
        </div>
      ) : (
        <div className="pick-layer__rows">
          {empty !== null ? (
            <p className="pick-layer__empty">{empty}</p>
          ) : (
            <ol
              ref={listRef}
              className="pick-layer__picked"
              aria-label={t("models.pick.listLabel", { agent: name })}
            >
              {picked.map((item, index) => {
                const key = refKey(item.ref);
                const provider = isOfficial(item.ref)
                  ? t("models.pick.official")
                  : item.providerName;
                const held = drag?.moving === true && index === drag.to;
                return (
                  <li
                    key={key}
                    data-pick-key={key}
                    className={held ? "pick-layer__item is-dragging" : "pick-layer__item"}
                    data-rowband={held ? "lit" : ""}
                    tabIndex={0}
                    aria-label={t("models.pick.itemLabel", {
                      model: item.displayName,
                      provider,
                      position: positionText(index, total),
                    })}
                    aria-describedby={hintId}
                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                    onKeyDown={(event) => onRowKey(event, index)}
                    onPointerDown={(event) => onRowDown(event, index)}
                  >
                    <span className="pick-layer__grip" aria-hidden="true">
                      <IconGrip />
                    </span>
                    <span className="pick-layer__order" data-slot="order" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="pick-layer__name">{item.displayName}</span>
                    <span className="pick-layer__provider">{provider}</span>
                    <IconButton
                      icon={<IconClose />}
                      title={t("models.pick.remove", { model: item.displayName })}
                      onClick={() =>
                        onPick(item.ref, false, {
                          displayName: item.displayName,
                          providerName: item.providerName,
                        })
                      }
                    />
                  </li>
                );
              })}
            </ol>
          )}
          <span id={hintId} hidden>
            {t("models.pick.moveHint")}
          </span>
        </div>
      )}
      <div className="pick-layer__foot">
        {tab === "all" ? (
          // 启用与选是两步（2026-10-08）：这里不再说「新启用的默认选上」，只留去提供商页启用的那颗键
          <Button size="compact" onClick={onManage}>
            {t("models.pick.manage")}
          </Button>
        ) : (
          <>
            <span className="pick-layer__note">{pickedFootnote(agent)}</span>
            <Button size="compact" onClick={onRestoreOrder}>
              {t("models.pick.restoreOrder")}
            </Button>
          </>
        )}
      </div>
      <span className="pick-layer__said" aria-live="polite">
        <span key={said.n}>{said.text}</span>
      </span>
    </FloatingLayer>
  );
}
