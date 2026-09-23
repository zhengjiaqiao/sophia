import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  MODEL_FILTER_THRESHOLD,
  edgeFades,
  frozenGroups,
  gatewayShortName,
  modelEntryKey,
  modelRowId,
  modelRowLabel,
  showGatewayNames,
  snapshotOrder,
} from "./modelsView.ts";
import type { ModelEntry } from "./modelsView.ts";
import type { GatewayProvider } from "./types.ts";
import { Button } from "./ui/index.ts";
import "./ModelList.css";

/// 模型列表：模型下拉与网关页同一组件（DESIGN「模型列表的写法」）

export interface ModelListProps {
  /// 要列的模型：下拉是全部网关的全部模型，网关页只是本网关的
  entries: ModelEntry[];
  onToggle: (provider: GatewayProvider, modelId: string) => void;
  /// 筛选框与列表之间的一段（下拉里的「第三方」组头）
  header?: ReactNode;
  /// 这几个各闪一次（`网关id|模型id`）：新拉到的模型
  flashKeys?: string[];
  /// 列表为空时的一句
  empty?: ReactNode;
}

export const entryKey = modelEntryKey;

/**
 * 默认一列名称，行上没有提示框；友好名与 id 明显不同时行尾才写 id（`modelRowId`）。
 * 按服务商分小组头 `azure · 12`，一家一个也有；行内去掉重复前缀。
 * 列表跨 ≥2 个网关时（模型页下拉），每行行尾右对齐写来源网关短名；网关页只列本网关，不写。
 * 已选不在列表里另列一组：两处都由列表上方的模型片表达（DESIGN「已选用模型片表达」）。
 * 打开（挂载）时排一次序（组内已选在前），之后勾选 / 取消不挪位置，下次打开再重排。
 * 勾选当场写盘；超过约 8 行时出筛选框，列表在自身范围内滚动。
 */
export function ModelList({ entries, onToggle, header, flashKeys, empty }: ModelListProps) {
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
  const flash = new Set(flashKeys ?? []);
  const gatewayNames = showGatewayNames(entries);
  let order = 0;

  /// 一行：整行是命中区；组头已给出服务商，行内去掉重复前缀
  const row = (entry: ModelEntry) => {
    const { provider, model } = entry;
    const key = entryKey(entry);
    const flashing = flash.has(key);
    const id = modelRowId(model);
    const name = modelRowLabel(model);
    const gateway = gatewayNames ? gatewayShortName(provider) : null;
    const i = order++;
    const toggle = () => onToggle(provider, model.id);
    // 行上不放提示框也不设 title：挑模型时完整 id 没有意义，还会盖住正在看的那一行（真机反馈）；
    // 读屏名只写名称，跨网关时补上来源网关（同名模型可能来自两家）
    return (
      <div
        key={key}
        className={`models-option${flashing ? " is-flash" : ""}`}
        aria-label={gateway === null ? name : `${name}，${gateway}`}
        style={flashing ? { animationDelay: `${Math.min(i, 12) * 60}ms` } : undefined}
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
        {/* 12px 方框只画状态（方＝我选的）；命中区是整行，读屏走 aria-selected */}
        <span
          className={`ss-checkbox models-option__check${model.selected ? " is-on" : ""}`}
          aria-hidden="true"
        >
          {model.selected ? (
            <svg
              width="8"
              height="8"
              viewBox="0 0 8 8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            >
              <path d="M1.2 4.2l1.9 1.9L6.8 1.9" />
            </svg>
          ) : null}
        </span>
        <span className="models-option__name">{name}</span>
        {id !== null ? <span className="models-option__id">{id}</span> : null}
        {gateway !== null ? <span className="models-option__gateway">{gateway}</span> : null}
      </div>
    );
  };

  return (
    <div className="model-list">
      {withFilter ? (
        <div className="model-list__search">
          <svg
            width="12"
            height="12"
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
            placeholder="筛选"
            aria-label="筛选模型"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}
      {header}
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
                <Button variant="link" onClick={() => setQuery("")}>
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
