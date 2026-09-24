import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  MODEL_FILTER_THRESHOLD,
  edgeFades,
  frozenGroups,
  modelEntryKey,
  modelFilterPlaceholder,
  modelRowId,
  modelRowLabel,
  snapshotOrder,
} from "./modelsView.ts";
import type { ModelEntry } from "./modelsView.ts";
import type { GatewayProvider } from "./types.ts";
import { Button, CheckboxGlyph } from "./ui/index.ts";
import "./ModelList.css";

/// 模型勾选列表：Codex 页网关行抽屉里的那一框（DESIGN「模型列表的写法」）。每个列表只列一家网关

export interface ModelListProps {
  /// 要列的模型：这一家网关的全部模型
  entries: ModelEntry[];
  onToggle: (provider: GatewayProvider, modelId: string) => void;
  /// 列表为空时的一句
  empty?: ReactNode;
}

export const entryKey = modelEntryKey;

/**
 * 默认一列名称，行上没有提示框；友好名与 id 明显不同时行尾才写 id（`modelRowId`）。
 * 按服务商分小组头 `azure · 12`，一家一个也有；行内去掉重复前缀；行尾不写网关短名（只列一家）。
 * 已选不在列表里另列一组：已选由列表上方这一家的 `已选` 模型片（与节头 `在用` 同一种片）表达。
 * 打开（挂载）时排一次序（组内已选在前），之后勾选 / 取消不挪位置，下次打开再重排。
 * 勾选当场写盘；超过约 8 行时框顶出筛选框（`筛选 40 个模型`），列表在框内滚动、底边渐隐。
 */
export function ModelList({ entries, onToggle, empty }: ModelListProps) {
  const [query, setQuery] = useState("");
  /// 打开那一刻的排序：之后勾选只改状态、不挪位置
  const [snap] = useState(() => snapshotOrder(entries));
  /// 滚动边缘渐隐：上面 / 下面还有被裁掉的行时，那一边出 16px 渐隐（DESIGN「渐变只用于功能」）
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const next = edgeFades(el.scrollTop, el.clientHeight, el.scrollHeight);
      setFade((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  });
  const withFilter = entries.length > MODEL_FILTER_THRESHOLD;
  const term = withFilter ? query : "";
  const groups = frozenGroups(entries, snap, term);

  /// 一行：整行是命中区；组头已给出服务商，行内去掉重复前缀
  const row = (entry: ModelEntry) => {
    const { provider, model } = entry;
    const key = entryKey(entry);
    const id = modelRowId(model);
    const name = modelRowLabel(model);
    const toggle = () => onToggle(provider, model.id);
    // 行上不放提示框也不设 title：挑模型时完整 id 没有意义，还会盖住正在看的那一行（真机反馈）
    return (
      <div
        key={key}
        className="models-option"
        // 行悬停时方框进「手靠近」态（ui 的统一钩子）
        data-checkrow=""
        aria-label={name}
        role="option"
        aria-selected={model.selected}
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
      >
        {/* 16px 勾选框只画状态（勾上＝墨底白勾，全应用同一个记号）；命中区是整行，读屏走 aria-selected */}
        <span
          className={`ss-checkbox models-option__check${model.selected ? " is-on" : ""}`}
          aria-hidden="true"
        >
          <CheckboxGlyph checked={model.selected} />
        </span>
        <span className="models-option__name">{name}</span>
        {id !== null ? <span className="models-option__id ss-selectable">{id}</span> : null}
      </div>
    );
  };

  return (
    <div className="model-list">
      {withFilter ? (
        <div className="model-list__search">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="7" cy="7" r="4.6" />
            <path d="M10.4 10.4L14 14" />
          </svg>
          {/* 不用 type="search"：WebKit 的搜索框会自己吃掉 Esc */}
          <input
            type="text"
            className="model-list__input"
            placeholder={modelFilterPlaceholder(entries.length)}
            aria-label="筛选模型"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}
      {entries.length === 0 ? (
        empty ? (
          <p className="model-list__empty">{empty}</p>
        ) : null
      ) : (
        <div
          className="model-list__viewport"
          data-fade-top={fade.start || undefined}
          data-fade-bottom={fade.end || undefined}
        >
          <div
            ref={scrollRef}
            className="model-list__scroll"
            role="listbox"
            aria-multiselectable="true"
          >
            {groups.length === 0 ? (
              <p className="model-list__empty">
                没有匹配的模型
                <Button size="compact" onClick={() => setQuery("")}>
                  清除筛选
                </Button>
              </p>
            ) : (
              <>
                {groups.map((group) => (
                  <div key={group.vendor} className="model-list__group">
                    <div className="model-list__group-head">
                      <span className="model-list__vendor">{group.vendor}</span>
                      <span className="model-list__dot">·</span>
                      <span className="model-list__count">{group.entries.length}</span>
                    </div>
                    {group.entries.map((entry) => row(entry))}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
