import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode, RefObject } from "react";
import {
  BusySlot,
  Button,
  Drawer,
  DrawerHandle,
  FloatingToast,
  NoticePanel,
  Spinner,
  Tag,
  Toast,
  Tooltip,
  TruncTip,
  useBusyShown,
} from "../ui";
import { edgeFades } from "../modelsView";
import { FadeViewport } from "../ui/FloatingLayer.tsx";
import { CheckMark } from "./CheckMark.tsx";
import {
  NOTHING_CHECKED,
  PICKED_HEAD,
  PICK_HINT,
  SUGGESTED_LABEL,
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
import type { DomainRef } from "./sourcesView.ts";
import type { SourcesData, SourcesModel } from "./sourcesModel.ts";
import "./AddSourcePanel.css";

/// 添加来源的**内容**（DESIGN「来源：订阅、来源行、添加来源 › 添加来源」，画板 V4Layouts add-source）：
/// 单栏，自上而下——第一步 `选择文件夹…`（D13：留在列表最上方）+ 灰字，下面一列候选来源
/// （选的文件夹在最前，再是 `建议的来源` 两组），贴底 `添加 N 个来源`。
/// skill 与 MCP 只差数据源（`SourcesModel`）：MCP 没有 `选择文件夹…`，行里外露的是服务名。
///
/// 不管容器：标题、返回、转场、页边都归外面那层（`AddSourcePage`）。Panel 自己铺满容器给它的高度，
/// 只有列表区滚动（边缘渐隐）。
///
/// - 来源行＝一个勾选框项，可多选，两行高：勾选框 24 ｜ 内容（名字后跟抽屉拉手，悬停这一行才出）。
///   第一行名字，第二行 `出处 · 39 个 skill · ` + 外露的前几个名字，一行放不下截断
/// - **点整行＝拉开 / 收起抽屉**（拉手只是记号，也是键盘入口）：行下一格凹槽就地列出全部名字（只读、四列
///   各 160、左沿对齐名字），`同名` / `不支持` 是纯弱标识 + 提示框（D21）；Esc 收起。
///   **勾选只归行首方框**（命中区 28，手靠近这 28 方框才抬起）；行不设悬停底色，勾上不改底色
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
}

/// 滚动边缘渐隐：上面 / 下面还有被裁掉的内容时，那一边出 16px 渐隐（与模型列表、小浮层同一写法）
function useEdgeFades(ref: RefObject<HTMLElement | null>) {
  const [fade, setFade] = useState({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const next = edgeFades(el.scrollTop, el.clientHeight, el.scrollHeight);
      setFade((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [ref]);
  return fade;
}

/// 带渐隐的滚动区：外层定位渐隐（机面上从 face 渐隐），里层滚
function FadeScroll({ children, label }: { children: ReactNode; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const fade = useEdgeFades(ref);
  return (
    <FadeViewport fade={fade} tone="face" className="add-src__fade">
      <div ref={ref} className="ss-layer__scroll add-src__scroll" role="group" aria-label={label}>
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

export function AddSourcePanel({ model, domain, onChanged, onDone }: AddSourcePanelProps) {
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
  /// 选的文件夹加不进来（没有 skill、已经在来源里、读不到）：不进列表，浮在 `选择文件夹…` 下方说原因
  /// （DESIGN「反馈的两种形态」：做不成＝浮起黑窗，锚在按下的控件上；列表里只放能加的来源）
  const [pickNotice, setPickNotice] = useState<{
    key: number;
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
      el.querySelector<HTMLElement>(".add-src__check")?.focus({ preventScroll: true });
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
    const cannot = (reason: string) => setPickNotice({ key: Date.now(), name, reason });
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
      if (alive.current) cannot(`无法读取这个文件夹：${String(e)}`);
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
        failed.push({ ref: entry.ref, name: entry.name, reason: String(e) });
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

  /// 一个来源行。items：抽屉里列的名字；blocked：方框为什么不能勾（选的文件夹没 skill 等），此时也不展开
  const row = (
    entry: { ref: string; name: string; title?: string; items?: CandidateEntry["items"] },
    line: SourceLine,
    blocked: string | null,
  ) => {
    const on = !blocked && checked.has(entry.ref);
    const open = !blocked && expanded.has(entry.ref);
    const items = entry.items ?? [];
    // 点整行 = 拉开 / 收起抽屉（拉手只是记号，键盘经它操作）；勾选只归方框
    const onRowClick = (event: MouseEvent) => {
      if (blocked || (event.target as HTMLElement).closest(".add-src__check")) return;
      toggleExpand(entry.ref);
    };
    let second: ReactNode;
    if (line.kind === "loading") {
      second = <ReadingFolder />;
    } else if (line.kind === "message") {
      second = <span className="add-src__meta">{line.text}</span>;
    } else {
      second =
        entry.title !== undefined ? (
          // 第二行只写短路径：提示框补完整路径（屏幕上没有的）
          <Tooltip content={entry.title}>
            <span className="add-src__meta">{line.text}</span>
          </Tooltip>
        ) : (
          // 没有别的可补：只在这一行放不下被截断时给全文
          <TruncTip content={line.text}>
            <span className="add-src__meta">{line.text}</span>
          </TruncTip>
        );
    }
    const drawerId = `add-src-drawer-${encodeURIComponent(entry.ref)}`;
    return (
      <div key={entry.ref} className="add-src__entry">
        <div
          ref={(el) => {
            if (el) rowEls.current.set(entry.ref, el);
            else rowEls.current.delete(entry.ref);
          }}
          className={`add-src__row${blocked ? " is-blocked" : ""}${open ? " is-open" : ""}`}
          data-drawer-row={blocked ? undefined : true}
          onClick={onRowClick}
        >
          <span className="add-src__checkcell">
            {blocked ? (
              // 不能勾：方框退到 hairline，悬停说原因（与第二行同一句）
              <Tooltip content={blocked} focusable explain>
                <CheckMark on={false} />
              </Tooltip>
            ) : (
              // 手靠近这 28 方的命中区，方框就抬起（data-checkrow）；行的其余地方归抽屉
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                aria-label={entry.name}
                className="add-src__check"
                data-checkrow
                onClick={() => {
                  setCheck(entry.ref, !on);
                  setFailure(null);
                }}
              >
                <CheckMark on={on} />
              </button>
            )}
          </span>
          {/* 拉手在名字前自成一列（18 + 6）：悬停这一行（或键盘焦点在这一行上）才出，拉开的常显；
              不能勾的行没有抽屉，这一格留空，各行名字照样对齐 */}
          <span className="add-src__handlecell">
            {blocked ? null : (
              <DrawerHandle
                open={open}
                onToggle={() => toggleExpand(entry.ref)}
                label={`${entry.name} 里的 ${model.noun}`}
                controls={drawerId}
              />
            )}
          </span>
          <span className="add-src__content">
            <span className="add-src__title">
              <span className="add-src__name">{entry.name}</span>
            </span>
            <span className="add-src__second">{second}</span>
          </span>
        </div>
        {blocked ? null : (
          // 抽屉：全部名字，只读，四列各 160；`同名` / `不支持` 是纯弱标识 + 提示框（D21）
          <Drawer open={open} id={drawerId} className="add-src__drawer">
            {items.length === 0 ? (
              <span className="add-src__none">{model.emptyItems}</span>
            ) : (
              <span className="add-src__items">
                {items.map((item) => (
                  <span className="add-src__item" key={item.name}>
                    <span className={`add-src__itemname${item.dim ? " is-dim" : ""}`}>
                      {item.name}
                    </span>
                    {item.tag ? (
                      <Tag tone="weak" tip={item.tag.tip}>
                        {item.tag.text}
                      </Tag>
                    ) : null}
                  </span>
                ))}
              </span>
            )}
          </Drawer>
        )}
      </div>
    );
  };

  let pickedRow: ReactNode = null;
  if (picked !== null) {
    const entry = picked.status === "ready" ? picked.entry : picked;
    pickedRow = (
      <>
        <div className="add-src__group">{PICKED_HEAD}</div>
        {row(entry, pickedLine(picked, domain, model.noun), pickedBlocked(picked, domain))}
      </>
    );
  }

  let list: ReactNode;
  if (loadError && data === null) {
    list = (
      <div className="add-src__notice">
        <NoticePanel message="无法读取来源" reason={loadError} />
      </div>
    );
  } else if (data === null) {
    list = (
      <div className="add-src__loading">
        <Spinner label="正在读来源" />
      </div>
    );
  } else {
    list = (
      <FadeScroll label="来源">
        {pickedRow}
        <div className="add-src__label">{SUGGESTED_LABEL}</div>
        {groups.length === 0 ? (
          <div className="add-src__none">{model.noCandidates}</div>
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

  return (
    <div className="add-src">
      {model.canPickFolder ? (
        <div className="add-src__pick">
          <span className="add-src__pickbtn">
            {reading ? (
              // 读文件夹时忙碌在 `选择文件夹…` 原位（0.3 秒门槛）
              <BusySlot busy label="正在读文件夹">
                <Button size="row">选择文件夹…</Button>
              </BusySlot>
            ) : (
              <Button size="row" onClick={() => void pickFolder()}>
                选择文件夹…
              </Button>
            )}
            {pickNotice ? (
              <FloatingToast key={pickNotice.key} align="start">
                <Toast
                  tier="notice"
                  kind="cannot"
                  verb="没加进来"
                  names={[pickNotice.name]}
                  reason={pickNotice.reason}
                  onDismiss={() => setPickNotice(null)}
                  onClose={() => setPickNotice(null)}
                />
              </FloatingToast>
            ) : null}
          </span>
          <span className="add-src__hint">{PICK_HINT}</span>
        </div>
      ) : null}
      {list}
      <div className="add-src__foot">
        {failure ? (
          // 没加上：浮在触发它的主动作那里（右对齐这一行、放不下就翻到上方），8 秒，悬停停表
          <FloatingToast key={failure.key} align="end">
            <Toast
              tier="notice"
              {...failure.toast}
              onDismiss={dismissFailure}
              onClose={dismissFailure}
            />
          </FloatingToast>
        ) : null}
        {adding ? (
          // 键锁住，过了 0.3 秒门槛原位换成忙碌指示 + 一句
          <BusySlot busy label="正在添加" className="add-src__busy">
            <Button variant="primary" size="row">
              {addLabel(entries.length)}
            </Button>
          </BusySlot>
        ) : entries.length === 0 ? (
          <Button variant="primary" size="row" disabled disabledReason={NOTHING_CHECKED}>
            {addLabel(0)}
          </Button>
        ) : (
          <Button variant="primary" size="row" onClick={() => void add()}>
            {addLabel(entries.length)}
          </Button>
        )}
      </div>
    </div>
  );
}

/// 选了文件夹、正在读：第二行过了 0.3 秒门槛才出忙碌指示 + 一句（更快读完的什么都不闪）
function ReadingFolder() {
  const shown = useBusyShown(true);
  return (
    <span className="add-src__meta" role="status">
      {/* 门槛之前留一个空格占住第二行的高度，出现时不跳 */}
      {shown ? (
        <span className="add-src__reading">
          <Spinner label="正在读文件夹" />
          正在读文件夹
        </span>
      ) : (
        "\u00a0"
      )}
    </span>
  );
}
