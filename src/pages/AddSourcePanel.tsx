import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode, RefObject } from "react";
import { Disclosure } from "../Matrix";
import { Button, NoticePanel, Spinner, Tag, Toast, Tooltip } from "../ui";
import { edgeFades } from "../modelsView";
import { displayPath } from "../pathText";
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
import { columnRows, type DomainRef } from "./sourcesView.ts";
import type { SourcesData, SourcesModel } from "./sourcesModel.ts";
import "./SourcesPage.css";
import "./AddSourcePanel.css";

/// 添加来源的**内容**（DESIGN「来源管理页 › 添加」）：单栏，自上而下——顶部 `选择文件夹…`，
/// 下面一列来源行（选的文件夹在最前，再是 `建议的来源` 两组），贴底 `添加 N 个来源`。
/// skill 与 MCP 只差数据源（`SourcesModel`）：MCP 没有 `选择文件夹…`，行里外露的是服务名。
///
/// 不管容器：标题、返回、转场、页边都归外面那层（现在是二级页 `AddSourcePage`；换成弹窗时
/// 只换那一层）。Panel 自己铺满容器给它的高度，只有列表区滚动。
///
/// - 来源行＝一个复选框项，可多选，长相与来源管理页的行相同：第一行 方框 + `▸ / ▾` + 名字；
///   第二行与管理页第二行一字不差（`~/.claude/skills · 2 个 skill`），尾部接外露的 skill 名，一行放不下截断。
///   点 `▸` 就地展开管理页同一个展开区（两列只读名字，`同名` / `搬不过去` 照标），只管看、不改勾选；
///   点行的其余部分＝勾 / 取消，勾上不改底色，悬停铺 surface
/// - 默认一个都不勾；选的文件夹读好后自动勾上。它没有 skill、读不到、已经订阅过时方框禁用，
///   第二行与提示框写原因
/// - 逐个加：全成＝交给容器收尾（滑回）；有没成的就留在这一页，底部说哪几个没加上，
///   已加上的从列表里消失，没加上的保持勾着

export interface AddSourcePanelProps {
  model: SourcesModel;
  domain: DomainRef;
  /// 加上了至少一个之后：主视图重扫 / 来源管理页重读。Panel 等它做完再往下走
  onChanged: () => Promise<void>;
  /// 勾的全加上了：容器收尾（滑回）。Panel 等它做完才收起忙碌指示
  onDone: () => Promise<void>;
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

/// 带渐隐的滚动区：外层定位渐隐，里层滚
function FadeScroll({ children, label }: { children: ReactNode; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const fade = useEdgeFades(ref);
  return (
    <div
      className="src-layer__viewport add-src__fade"
      data-fade-top={fade.start || undefined}
      data-fade-bottom={fade.end || undefined}
    >
      <div ref={ref} className="src-layer__scroll add-src__scroll" role="group" aria-label={label}>
        <div>{children}</div>
      </div>
    </div>
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
    const base = { ref: path, name: folderName(path), sub: displayPath(path) };
    setPicked({ status: "loading", ...base });
    setReveal({ ref: path, top: true });
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
      setPicked(next);
      if (pickedBlocked(next, domain) === null) setCheck(entry.ref, true);
    } catch (e) {
      if (alive.current) setPicked({ status: "failed", ...base, reason: String(e) });
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
      await onDone();
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

  /// 一个来源行。items：展开区列的名字；blocked：方框为什么不能勾（选的文件夹没 skill 等），此时也不给 ▸
  const row = (
    entry: { ref: string; name: string; title?: string; items?: CandidateEntry["items"] },
    line: SourceLine,
    blocked: string | null,
  ) => {
    const on = !blocked && checked.has(entry.ref);
    const open = !blocked && expanded.has(entry.ref);
    const items = entry.items ?? [];
    // 点行的任何地方都是勾 / 取消，除了 `▸`（只管看）与不能勾的行
    const onRowClick = (event: MouseEvent) => {
      if (blocked || (event.target as HTMLElement).closest(".add-src__caret")) return;
      setCheck(entry.ref, !on);
      setFailure(null);
    };
    let second: ReactNode;
    if (line.kind === "loading") {
      second = (
        <span className="add-src__meta">
          <Spinner label="正在读文件夹" />
        </span>
      );
    } else if (line.kind === "message") {
      second = <span className="add-src__meta">{line.text}</span>;
    } else {
      second = (
        <Tooltip content={entry.title ?? line.text}>
          <span className="add-src__meta">{line.text}</span>
        </Tooltip>
      );
    }
    return (
      <div
        key={entry.ref}
        ref={(el) => {
          if (el) rowEls.current.set(entry.ref, el);
          else rowEls.current.delete(entry.ref);
        }}
        className={`add-src__row${blocked ? " is-blocked" : ""}${open ? " is-open" : ""}`}
        onClick={onRowClick}
      >
        <div className="add-src__head-line">
          {blocked ? (
            // 不能勾：方框退到 hairline，悬停说原因（与第二行同一句）
            <Tooltip content={blocked} focusable>
              <CheckMark on={false} />
            </Tooltip>
          ) : (
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={entry.name}
              className="add-src__check"
            >
              <CheckMark on={on} />
            </button>
          )}
          {/* ▸ 与来源管理页同一个记号、同一个位置；不能勾的行占位不显示，名字不跳 */}
          <button
            type="button"
            className="src-row__caret add-src__caret"
            aria-expanded={open}
            aria-label={`${entry.name} 里的 ${model.noun}`}
            disabled={blocked !== null}
            onClick={() => toggleExpand(entry.ref)}
          >
            <Disclosure open={open} shown={!blocked} />
          </button>
          <span className="add-src__name">{entry.name}</span>
        </div>
        <div className="add-src__second">{second}</div>
        {open ? (
          // 展开区：与来源管理页同一个（两列只读名字，13 ink-mute）
          items.length === 0 ? (
            <div className="src-row__none add-src__skills">{model.emptyItems}</div>
          ) : (
            <div
              className="src-row__skills add-src__skills"
              style={{ gridTemplateRows: `repeat(${columnRows(items.length)}, auto)` }}
            >
              {items.map((item) => (
                <div className="src-skill" key={item.name}>
                  <span className={`src-skill__name${item.dim ? " is-dim" : ""}`}>{item.name}</span>
                  {item.tag ? <Tag tip={item.tag.tip}>{item.tag.text}</Tag> : null}
                </div>
              ))}
            </div>
          )
        ) : null}
      </div>
    );
  };

  let pickedRow: ReactNode = null;
  if (picked !== null) {
    const entry = picked.status === "ready" ? picked.entry : picked;
    pickedRow = (
      <>
        <div className="add-src__head">{PICKED_HEAD}</div>
        {row(entry, pickedLine(picked, domain, model.noun), pickedBlocked(picked, domain))}
      </>
    );
  }

  let list: ReactNode;
  if (loadError && data === null) {
    list = (
      <div className="add-src__notice">
        <NoticePanel message="读不到来源" reason={loadError} />
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
              <div className="add-src__head">{group.title}</div>
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
          <Button size="row" onClick={() => void pickFolder()}>
            选择文件夹…
          </Button>
          <span className="add-src__hint">{PICK_HINT}</span>
        </div>
      ) : null}
      {list}
      <div className="add-src__foot">
        {failure ? (
          <Toast
            key={failure.key}
            tier="notice"
            {...failure.toast}
            onDismiss={dismissFailure}
            onClose={dismissFailure}
          />
        ) : null}
        {adding ? (
          <span className="add-src__busy">
            <Spinner label="正在添加" />
            正在添加
          </span>
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
